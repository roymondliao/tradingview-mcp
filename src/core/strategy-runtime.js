/** Bounded TradingView Strategy runtime adapter and freshness lifecycle. */
import { callPageFunction as _callPageFunction } from '../connection.js';
import {
  getActivePaneState as _getActivePaneState,
  toggleStudyVisibility as _toggleStudyVisibility,
} from './studies.js';
import { assertSymbolSession as _assertSymbolSession } from './chart-session.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { stableJsonStringify, sha256Hex } from './stable-json.js';

const DEFAULT_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 200;
const STABLE_READS = 3;
const DEFAULT_BATCH_LIMIT = 500;
const MAX_BATCH_LIMIT = 5000;
const SNAPSHOT_CANDIDATE_VERSION = 1;

export function stableRuntimeJson(value) {
  return stableJsonStringify(value);
}

export function createRuntimeSignature(candidate) {
  return sha256Hex(candidate);
}

function timeoutValue(timeout_ms) {
  const value = timeout_ms == null ? DEFAULT_TIMEOUT_MS : Number(timeout_ms);
  if (!Number.isInteger(value) || value < 100 || value > 60000) {
    throw new CoreOperationError('timeout_ms must be an integer from 100 to 60000.', {
      code: 'STRATEGY_RUNTIME_INVALID', phase: 'runtime_validation',
    });
  }
  return value;
}

function batchValues(offset, limit) {
  const parsedOffset = offset == null ? 0 : Number(offset);
  const parsedLimit = limit == null ? DEFAULT_BATCH_LIMIT : Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
    throw new CoreOperationError('offset must be a non-negative integer.', {
      code: 'STRATEGY_RUNTIME_INVALID', phase: 'batch_validation',
    });
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > MAX_BATCH_LIMIT) {
    throw new CoreOperationError(`limit must be an integer from 1 to ${MAX_BATCH_LIMIT}.`, {
      code: 'STRATEGY_RUNTIME_INVALID', phase: 'batch_validation',
    });
  }
  return { offset: parsedOffset, limit: parsedLimit };
}

function entityRequired(entity_id, phase) {
  if (!entity_id) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase,
    });
  }
}

function entityError(message, { code, entity_id, context, phase, retryable = false } = {}) {
  return new CoreOperationError(message, {
    code,
    phase,
    entity_id,
    retryable,
    context,
  });
}

function pageFailure(result, { entity_id, context, phase } = {}) {
  if (!result?.error) return;
  const code = result.error_code || 'STRATEGY_REPORT_UNAVAILABLE';
  throw entityError(result.error, {
    code, entity_id, context, phase, retryable: code === 'STRATEGY_REPORT_UNAVAILABLE',
  });
}

async function inspectSourcePage(entityId) {
  function valueOf(candidate) {
    try { return candidate && typeof candidate.value === 'function' ? candidate.value() : candidate; } catch { return null; }
  }
  function idOf(source) {
    try { return String(typeof source.id === 'function' ? source.id() : source.id); } catch { return null; }
  }
  const chart = globalThis.TradingViewApi._activeChartWidgetWV.value();
  const chartModel = chart._chartWidget.model();
  const internalModel = chartModel.model();
  const source = (internalModel.dataSources() || []).find((item) => idOf(item) === String(entityId));
  if (!source) return { error: 'Strategy source not found in active pane model', error_code: 'STRATEGY_NOT_FOUND_IN_PANE' };
  let holder = null;
  if (typeof internalModel.activeStrategySource === 'function') holder = internalModel.activeStrategySource();
  else if (typeof chartModel.activeStrategySource === 'function') holder = chartModel.activeStrategySource();
  const active = valueOf(holder);
  return {
    source_found: true,
    active_source: active === source || idOf(active) === String(entityId),
    capabilities: {
      report_data: typeof source.reportData === 'function',
      status: typeof source.status === 'function',
      report_changed: typeof source.reportChanged === 'function',
      status_changed: typeof source.onStatusChanged === 'function',
    },
  };
}

async function activateSourcePage(entityId) {
  function valueOf(candidate) {
    try { return candidate && typeof candidate.value === 'function' ? candidate.value() : candidate; } catch { return null; }
  }
  function idOf(source) {
    try { return String(typeof source.id === 'function' ? source.id() : source.id); } catch { return null; }
  }
  const chart = globalThis.TradingViewApi._activeChartWidgetWV.value();
  const chartModel = chart._chartWidget.model();
  const internalModel = chartModel.model();
  const source = (internalModel.dataSources() || []).find((item) => idOf(item) === String(entityId));
  if (!source) return { error: 'Strategy source not found in active pane model', error_code: 'STRATEGY_NOT_FOUND_IN_PANE' };
  try {
    const bottomBar = globalThis.TradingView && globalThis.TradingView.bottomWidgetBar;
    if (bottomBar && typeof bottomBar.showWidget === 'function') bottomBar.showWidget('backtesting');
  } catch {}
  let holder = null;
  if (typeof internalModel.activeStrategySource === 'function') holder = internalModel.activeStrategySource();
  else if (typeof chartModel.activeStrategySource === 'function') holder = chartModel.activeStrategySource();
  const active = valueOf(holder);
  if (active === source || idOf(active) === String(entityId)) return { method: 'already_active' };
  if (typeof internalModel.setActiveStrategySource === 'function') {
    internalModel.setActiveStrategySource(source);
    return { method: 'internalModel.setActiveStrategySource' };
  }
  if (typeof chartModel.setActiveStrategySource === 'function') {
    chartModel.setActiveStrategySource(source);
    return { method: 'chartModel.setActiveStrategySource' };
  }
  if (holder && typeof holder.setValue === 'function') {
    holder.setValue(source);
    return { method: 'activeStrategySource.setValue' };
  }
  return {
    error: 'TradingView build does not expose a Strategy activation adapter',
    error_code: 'STRATEGY_ACTIVATION_FAILED',
  };
}

async function readRuntimePage(entityId, mode, offset, limit) {
  function valueOf(candidate) {
    try { return candidate && typeof candidate.value === 'function' ? candidate.value() : candidate; } catch { return null; }
  }
  function idOf(source) {
    try { return String(typeof source.id === 'function' ? source.id() : source.id); } catch { return null; }
  }
  function scalarRecord(value, skip) {
    const result = {};
    if (!value || typeof value !== 'object') return result;
    const keys = Object.keys(value).sort().slice(0, 200);
    for (const key of keys) {
      if (skip && skip.includes(key)) continue;
      const child = valueOf(value[key]);
      if (child === null || ['number', 'boolean'].includes(typeof child)) result[key] = child;
      else if (typeof child === 'string' && child.length <= 200) result[key] = child;
    }
    return result;
  }
  function legIdentity(leg) {
    if (!leg || typeof leg !== 'object') return null;
    return {
      time: leg.tm ?? leg.time ?? null,
      bar_index: leg.b ?? leg.barIndex ?? null,
      type: leg.tp ?? leg.type ?? null,
      price: leg.p ?? leg.price ?? null,
    };
  }
  function tradeIdentity(trade, reportIndex) {
    if (!trade || typeof trade !== 'object') return null;
    return {
      report_index: reportIndex,
      entry: legIdentity(trade.e || trade.entry),
      exit_or_mark: legIdentity(trade.x || trade.exit),
      quantity: trade.q ?? trade.quantity ?? null,
    };
  }
  function calculationMode(report) {
    const settings = report && report.settings && typeof report.settings === 'object' ? report.settings : {};
    const candidates = [report && report.calculationMode, report && report.backtestMode, settings.calculationMode, settings.backtestMode];
    for (const candidate of candidates) {
      if (candidate == null) continue;
      const normalized = String(valueOf(candidate)).trim().toLowerCase();
      if (normalized.includes('deep')) return { available: true, value: 'deep' };
      if (normalized.includes('regular') || normalized === 'normal') return { available: true, value: 'regular' };
    }
    if (typeof settings.deepBacktesting === 'boolean') {
      return { available: true, value: settings.deepBacktesting ? 'deep' : 'regular' };
    }
    return { available: false, value: 'unknown' };
  }
  function dateRangeProjection(report) {
    const range = report && report.settings && report.settings.dateRange;
    if (!range || typeof range !== 'object') return null;
    function bounds(value) {
      if (!value || typeof value !== 'object') return null;
      return { from: value.from ?? null, to: value.to ?? null };
    }
    return { backtest: bounds(range.backtest), trade: bounds(range.trade) };
  }
  async function inputsFingerprint(chart, source, requestedId) {
    try {
      function canonicalInput(value, seen = new WeakSet()) {
        if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
        if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
        if (Array.isArray(value)) return value.map((item) => canonicalInput(item, seen));
        if (value && typeof value === 'object') {
          if (seen.has(value)) throw new Error('Strategy input contains a circular value');
          seen.add(value);
          const output = {};
          for (const key of Object.keys(value).sort()) output[key] = canonicalInput(value[key], seen);
          seen.delete(value);
          return output;
        }
        return String(value);
      }
      const wrapper = chart.getStudyById(String(requestedId));
      const inputs = wrapper && typeof wrapper.getInputValues === 'function' ? wrapper.getInputValues() || [] : [];
      const excluded = new Set(['pineId', 'pineVersion', 'pineFeatures', '__profile']);
      const normalized = inputs
        .filter((input) => input && input.id != null && !excluded.has(String(input.id)))
        .map((input) => ({ id: String(input.id), value: canonicalInput(input.value) }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const serialized = JSON.stringify(normalized);
      const bytes = new TextEncoder().encode(serialized);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
      return { available: true, algorithm: 'sha256', value: hash, count: normalized.length };
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      return { available: false, algorithm: 'sha256', value: null, count: null, reason: reason.slice(0, 300) };
    }
  }
  function reportProjection(report) {
    if (!report || typeof report !== 'object') return null;
    const performance = valueOf(report.performance);
    const all = performance && valueOf(performance.all);
    const trades = Array.isArray(report.trades) ? report.trades : [];
    const firstTradeIndex = Number.isInteger(report.firstTradeIndex) ? report.firstTradeIndex : 0;
    return {
      currency: report.currency ?? null,
      firstTradeIndex: report.firstTradeIndex ?? null,
      trade_count: trades.length,
      settings: { dateRange: dateRangeProjection(report) },
      performance: {
        ...scalarRecord(performance, ['all']),
        all: scalarRecord(all),
      },
      calculation_mode: calculationMode(report),
      first_trade_identity: tradeIdentity(trades[0], firstTradeIndex),
      last_trade_identity: tradeIdentity(trades[trades.length - 1], firstTradeIndex + trades.length - 1),
    };
  }

  const chart = globalThis.TradingViewApi._activeChartWidgetWV.value();
  const chartModel = chart._chartWidget.model();
  const internalModel = chartModel.model();
  const source = (internalModel.dataSources() || []).find((item) => idOf(item) === String(entityId));
  if (!source) return { error: 'Strategy source not found in active pane model', error_code: 'STRATEGY_NOT_FOUND_IN_PANE' };
  let holder = null;
  if (typeof internalModel.activeStrategySource === 'function') holder = internalModel.activeStrategySource();
  else if (typeof chartModel.activeStrategySource === 'function') holder = chartModel.activeStrategySource();
  const active = valueOf(holder);
  if (!(active === source || idOf(active) === String(entityId))) {
    return { error: 'Requested Strategy is not the active Strategy Tester source', error_code: 'STRATEGY_ACTIVATION_FAILED' };
  }

  let status = null;
  try { status = typeof source.status === 'function' ? valueOf(source.status()) : null; } catch {}
  const inputs = await inputsFingerprint(chart, source, entityId);
  let report = null;
  let reportError = null;
  try { report = typeof source.reportData === 'function' ? valueOf(source.reportData()) : null; } catch (error) {
    reportError = error && error.message ? error.message : String(error);
  }
  const reportAvailable = !!(report && valueOf(report.performance));
  const common = {
    source_found: true,
    active_source: true,
    symbol: chart.symbol(),
    resolution: chart.resolution(),
    status: scalarRecord(status),
    status_type: status && typeof status === 'object' ? status.type ?? null : status,
    status_error: status && typeof status === 'object' && typeof (status.error ?? status.message) === 'string'
      ? String(status.error ?? status.message).slice(0, 300)
      : null,
    report_available: reportAvailable,
    report_error: reportError,
    inputs_fingerprint: inputs,
  };
  const before = reportProjection(report);
  if (mode !== 'batch') return { ...common, report: before };
  if (!reportAvailable || !Array.isArray(report.trades)) {
    return { ...common, error: reportError || 'Strategy report is not ready', error_code: 'STRATEGY_REPORT_UNAVAILABLE' };
  }

  const total = report.trades.length;
  const items = report.trades.slice(offset, offset + limit);
  let reportAfter = null;
  try { reportAfter = typeof source.reportData === 'function' ? valueOf(source.reportData()) : null; } catch {}
  return {
    ...common,
    before,
    after: reportProjection(reportAfter),
    total,
    offset,
    limit,
    items,
  };
}

function reportMetrics(report) {
  const all = report?.performance?.all || {};
  return {
    total_net_profit: all.netProfit ?? null,
    win_rate_percent: all.percentProfitable == null ? null : all.percentProfitable * 100,
    total_trades: all.totalTrades ?? null,
    winning_trades: all.numberOfWiningTrades ?? null,
    losing_trades: all.numberOfLosingTrades ?? null,
  };
}

export function createSnapshotCandidate({ entity_id, session, context, raw }) {
  const report = raw?.report || null;
  const safeContext = sanitizeCoreContext(session?.context || context) || {};
  const candidate = {
    schema_version: SNAPSHOT_CANDIDATE_VERSION,
    normalization: 'strategy-runtime-candidate-v1',
    context: {
      target_id: safeContext.target_id ?? null,
      layout_id: safeContext.layout_id ?? null,
      pane_id: safeContext.pane_id ?? null,
    },
    entity_id,
    requested_symbol: session?.requested_symbol || session?.symbol || raw?.symbol || null,
    resolved_symbol: session?.resolved_symbol || raw?.symbol || null,
    timeframe: session?.timeframe || raw?.resolution || null,
    inputs_fingerprint: raw?.inputs_fingerprint || { available: false, value: null },
    calculation_mode: report?.calculation_mode || { available: false, value: 'unknown' },
    date_range: report?.settings?.dateRange || null,
    currency: report?.currency ?? null,
    first_trade_index: report?.firstTradeIndex ?? null,
    trade_count: report?.trade_count ?? null,
    closed_trades: report?.performance?.all?.totalTrades ?? null,
    open_trades: report?.performance?.all?.totalOpenTrades ?? null,
    metrics: reportMetrics(report),
    first_trade_identity: report?.first_trade_identity || null,
    last_trade_identity: report?.last_trade_identity || null,
  };
  return Object.freeze(candidate);
}

async function assertSession(session, phase, _deps) {
  if (!session) return null;
  const assertSymbolSession = _deps?.assertSymbolSession || _assertSymbolSession;
  return assertSymbolSession(session, { phase, _deps });
}

/** Validate Active Pane ownership/type and inspect the exact internal source. */
export async function inspectStrategySource({ entity_id, context, _deps } = {}) {
  entityRequired(entity_id, 'strategy_inspection');
  const getState = _deps?.getActivePaneState || _getActivePaneState;
  const state = await getState({ _deps });
  const target = (state.studies || []).find((study) => study.entity_id === entity_id);
  if (!target) {
    throw entityError(`Strategy not found in the active pane: ${entity_id}`, {
      code: 'STRATEGY_NOT_FOUND_IN_PANE', entity_id, context, phase: 'strategy_inspection',
    });
  }
  if (target.type !== 'strategy') {
    throw entityError(`Entity ${entity_id} is ${target.type || 'unknown'}, not a strategy.`, {
      code: 'ENTITY_NOT_STRATEGY', entity_id, context, phase: 'strategy_inspection',
    });
  }
  const callPageFunction = _deps?.callPageFunction || _callPageFunction;
  const source = await callPageFunction(inspectSourcePage, [entity_id]);
  pageFailure(source, { entity_id, context, phase: 'strategy_inspection' });
  if (!source?.capabilities?.report_data || !source?.capabilities?.status) {
    throw entityError(`Entity ${entity_id} does not expose the required Strategy runtime capabilities.`, {
      code: 'ENTITY_NOT_STRATEGY', entity_id, context, phase: 'strategy_inspection',
    });
  }
  return {
    success: true,
    symbol: state.symbol,
    resolution: state.resolution,
    strategy: target,
    active_source: source.active_source === true,
    capabilities: source.capabilities,
  };
}

/** Make a hidden Strategy visible, activate it internally, and verify readback. */
export async function ensureStrategyActive({ entity_id, context, timeout_ms, _deps } = {}) {
  const timeout = timeoutValue(timeout_ms);
  let inspected = await inspectStrategySource({ entity_id, context, _deps });
  let visibilityChanged = false;
  if (inspected.strategy.visible === false) {
    const toggle = _deps?.toggleStudyVisibility || _toggleStudyVisibility;
    await toggle({ entity_id, visible: true, _deps });
    visibilityChanged = true;
    inspected = await inspectStrategySource({ entity_id, context, _deps });
  }
  let method = 'already_active';
  if (!inspected.active_source) {
    const callPageFunction = _deps?.callPageFunction || _callPageFunction;
    const activation = await callPageFunction(activateSourcePage, [entity_id]);
    pageFailure(activation, { entity_id, context, phase: 'strategy_activation' });
    method = activation?.method || 'unknown';
  }

  const now = _deps?.now || Date.now;
  const delay = _deps?.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const deadline = now() + timeout;
  while (now() <= deadline) {
    const readback = await inspectStrategySource({ entity_id, context, _deps });
    if (readback.active_source) {
      return {
        success: true,
        status: readback.strategy.report_ready === true ? 'ready' : 'calculating',
        symbol: readback.symbol,
        resolution: readback.resolution,
        selection_method: method,
        visibility_changed: visibilityChanged,
        active_strategy: readback.strategy,
      };
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw entityError(`Strategy activation timed out after ${timeout}ms for ${entity_id}.`, {
    code: 'STRATEGY_ACTIVATION_FAILED', entity_id, context, phase: 'strategy_activation', retryable: true,
  });
}

function decorateObservation({ entity_id, session, context, raw }) {
  const snapshotCandidate = createSnapshotCandidate({ entity_id, session, context, raw });
  return {
    entity_id,
    context: sanitizeCoreContext(session?.context || context),
    symbol: raw?.symbol || null,
    timeframe: raw?.resolution || null,
    active_source: raw?.active_source === true,
    status_type: raw?.status_type ?? null,
    status: raw?.status || {},
    status_error: raw?.status_error || null,
    report_available: raw?.report_available === true,
    report_error: raw?.report_error || null,
    report: raw?.report || null,
    inputs_fingerprint: raw?.inputs_fingerprint || null,
    snapshot_candidate: snapshotCandidate,
    runtime_signature: createRuntimeSignature(snapshotCandidate),
  };
}

/** Read a bounded state projection; never return the complete Trade array. */
export async function readRawReportState({
  entity_id,
  session,
  context,
  phase = 'report_state',
  _skip_guards = false,
  _deps,
} = {}) {
  entityRequired(entity_id, phase);
  if (!_skip_guards) {
    await assertSession(session, phase, _deps);
    const inspect = _deps?.inspectStrategySource || inspectStrategySource;
    await inspect({ entity_id, context: session?.context || context, _deps });
  }
  const callPageFunction = _deps?.callPageFunction || _callPageFunction;
  const raw = await callPageFunction(readRuntimePage, [entity_id, 'state', 0, 0]);
  pageFailure(raw, { entity_id, context: session?.context || context, phase });
  return decorateObservation({ entity_id, session, context, raw });
}

/** Read the bounded raw Trading Report projection after availability checks. */
export async function readRawTradingReport(args = {}) {
  const observation = await readRawReportState({ ...args, phase: args.phase || 'trading_report_read' });
  if (!observation.report_available || !observation.report) {
    throw entityError(observation.report_error || 'Strategy report is not ready.', {
      code: 'STRATEGY_REPORT_UNAVAILABLE', entity_id: args.entity_id,
      context: args.session?.context || args.context, phase: args.phase || 'trading_report_read', retryable: true,
    });
  }
  return { success: true, ...observation };
}

/** Wait for a stable current Report, or fresh evidence after a chart/input mutation. */
export async function waitForFreshTradingReport({
  entity_id,
  session,
  context,
  before,
  mutated = Boolean(session?.symbol_changed || session?.timeframe_changed),
  timeout_ms,
  _deps,
} = {}) {
  entityRequired(entity_id, 'strategy_calculation');
  const timeout = timeoutValue(timeout_ms);
  const ensureActive = _deps?.ensureStrategyActive || ensureStrategyActive;
  await assertSession(session, 'strategy_calculation_start', _deps);
  await ensureActive({ entity_id, context: session?.context || context, timeout_ms: timeout, _deps });
  const readState = _deps?.readRawReportState || readRawReportState;
  const delay = _deps?.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = _deps?.now || Date.now;
  const deadline = now() + timeout;
  const beforeSignature = before?.runtime_signature || null;
  let transitionObserved = false;
  let stableSignature = null;
  let stableReads = 0;
  let last = null;

  while (now() <= deadline) {
    last = await readState({
      entity_id,
      session,
      context,
      phase: 'strategy_calculation',
      _skip_guards: true,
      _deps,
    });
    if (last.status_type === 1) {
      transitionObserved = true;
      stableSignature = null;
      stableReads = 0;
    } else if (last.status_error) {
      throw entityError(`Strategy calculation failed: ${last.status_error}`, {
        code: 'STRATEGY_REPORT_UNAVAILABLE', entity_id,
        context: session?.context || context, phase: 'strategy_calculation', retryable: false,
      });
    } else if (last.report_available !== true) {
      transitionObserved = true;
      stableSignature = null;
      stableReads = 0;
    } else if (last.status_type === 2) {
      const freshEvidence = !mutated
        || transitionObserved
        || (beforeSignature != null && last.runtime_signature !== beforeSignature);
      if (freshEvidence) {
        stableReads = last.runtime_signature === stableSignature ? stableReads + 1 : 1;
        stableSignature = last.runtime_signature;
        if (stableReads >= STABLE_READS) {
          await assertSession(session, 'strategy_calculation_complete', _deps);
          return {
            success: true,
            fresh: mutated,
            transition_observed: transitionObserved,
            stable_reads: stableReads,
            ...last,
          };
        }
      } else {
        stableReads = 0;
        stableSignature = last.runtime_signature;
      }
    } else {
      stableReads = 0;
      stableSignature = null;
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw entityError(`Strategy calculation timed out after ${timeout}ms for ${entity_id}.`, {
    code: 'STRATEGY_CALCULATION_TIMEOUT', entity_id,
    context: session?.context || context, phase: 'strategy_calculation', retryable: true,
  });
}

/** Slice raw paired Trades inside the page and return before/after candidates. */
export async function readRawTradingDataBatch({ entity_id, session, context, offset, limit, _deps } = {}) {
  entityRequired(entity_id, 'trading_data_batch');
  const values = batchValues(offset, limit);
  await assertSession(session, 'trading_data_batch', _deps);
  const inspect = _deps?.inspectStrategySource || inspectStrategySource;
  await inspect({ entity_id, context: session?.context || context, _deps });
  const callPageFunction = _deps?.callPageFunction || _callPageFunction;
  const raw = await callPageFunction(readRuntimePage, [entity_id, 'batch', values.offset, values.limit]);
  pageFailure(raw, { entity_id, context: session?.context || context, phase: 'trading_data_batch' });

  const common = {
    source_found: raw.source_found,
    active_source: raw.active_source,
    symbol: raw.symbol,
    resolution: raw.resolution,
    status: raw.status,
    status_type: raw.status_type,
    status_error: raw.status_error,
    report_available: raw.report_available,
    report_error: raw.report_error,
    inputs_fingerprint: raw.inputs_fingerprint,
  };
  const before = decorateObservation({ entity_id, session, context, raw: { ...common, report: raw.before } });
  const after = decorateObservation({ entity_id, session, context, raw: { ...common, report: raw.after } });
  const items = Array.isArray(raw.items) ? raw.items : [];
  const total = Number(raw.total) || 0;
  const nextOffset = values.offset + items.length;
  return {
    success: true,
    entity_id,
    context: sanitizeCoreContext(session?.context || context),
    symbol: raw.symbol || null,
    timeframe: raw.resolution || null,
    status_type: raw.status_type ?? null,
    status: raw.status || {},
    status_error: raw.status_error || null,
    calculation_mode: before.snapshot_candidate.calculation_mode,
    inputs_fingerprint: raw.inputs_fingerprint || null,
    total,
    offset: values.offset,
    limit: values.limit,
    returned: items.length,
    next_offset: nextOffset < total ? nextOffset : null,
    has_more: nextOffset < total,
    items,
    snapshot_before: before.snapshot_candidate,
    snapshot_after: after.snapshot_candidate,
    runtime_signature_before: before.runtime_signature,
    runtime_signature_after: after.runtime_signature,
    snapshot_changed: before.runtime_signature !== after.runtime_signature,
  };
}

export const strategyRuntimeLimits = Object.freeze({
  default_timeout_ms: DEFAULT_TIMEOUT_MS,
  poll_interval_ms: POLL_INTERVAL_MS,
  stable_reads: STABLE_READS,
  default_batch_limit: DEFAULT_BATCH_LIMIT,
  max_batch_limit: MAX_BATCH_LIMIT,
  snapshot_candidate_version: SNAPSHOT_CANDIDATE_VERSION,
});
