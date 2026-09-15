/** Format-neutral Strategy Trading canonical models and deterministic identities. */
import { unixMillisecondsToIso } from './time.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { stableJsonStringify, sha256Hex } from './stable-json.js';

export const TRADING_MODEL_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;

const SNAPSHOT_NORMALIZATION = 'strategy-trading-snapshot-v1';
const METRIC_MAP = Object.freeze({
  net_profit: { source: 'netProfit' },
  net_profit_percent: { source: 'netProfitPercent', ratio: true },
  gross_profit: { source: 'grossProfit' },
  gross_loss: { source: 'grossLoss' },
  profit_factor: { source: 'profitFactor' },
  total_trades: { source: 'totalTrades' },
  open_trades: { source: 'totalOpenTrades' },
  winning_trades: { source: 'numberOfWiningTrades' },
  losing_trades: { source: 'numberOfLosingTrades' },
  percent_profitable: { source: 'percentProfitable', ratio: true },
  average_trade: { source: 'avgTrade' },
  largest_win: { source: 'largestWinTrade' },
  largest_loss: { source: 'largestLosTrade' },
  commission_paid: { source: 'commissionPaid' },
});

function own(value, key) {
  return !!value && Object.prototype.hasOwnProperty.call(value, key);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined) ?? null;
}

function finiteOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function integerOrNull(value) {
  const number = finiteOrNull(value);
  return Number.isInteger(number) ? number : null;
}

function rawTradeVariant(trade) {
  if (trade?.e && own(trade, 'q') && own(trade, 'tp')) return 'compact';
  if (trade?.entry && own(trade, 'quantity') && own(trade, 'profit')) return 'verbose';
  return 'unsupported';
}

function metricPair(compact, verbose, variant) {
  const raw = compact !== undefined ? compact : verbose;
  if (raw && typeof raw === 'object') {
    const value = finiteOrNull(firstDefined(raw.v, raw.value));
    const rawPercent = finiteOrNull(firstDefined(raw.p, raw.percentValue, raw.percent));
    return {
      value,
      percent: rawPercent == null ? null : (variant === 'compact' ? rawPercent * 100 : rawPercent),
    };
  }
  return { value: finiteOrNull(raw), percent: null };
}

function legDirection(type) {
  if (typeof type !== 'string') return null;
  if (type === 'le' || type === 'lx') return 'long';
  if (type === 'se' || type === 'sx') return 'short';
  return null;
}

function normalizeTradeLeg(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = firstDefined(raw.tp, raw.type);
  const time = finiteOrNull(firstDefined(raw.tm, raw.time));
  return {
    id: firstDefined(raw.id),
    label: firstDefined(raw.c, raw.label),
    direction: legDirection(type),
    price: finiteOrNull(firstDefined(raw.p, raw.price)),
    time,
    time_iso: unixMillisecondsToIso(time),
    bar_index: integerOrNull(firstDefined(raw.b, raw.barIndex)),
    type,
  };
}

function normalizeMark(raw) {
  const leg = normalizeTradeLeg(raw);
  if (!leg) return null;
  return {
    direction: leg.direction,
    price: leg.price,
    time: leg.time,
    time_iso: leg.time_iso,
    bar_index: leg.bar_index,
    type: leg.type,
  };
}

function legAvailability(leg, { reason } = {}) {
  if (!leg) return { available: false, ...(reason && { reason }) };
  return {
    available: true,
    id: leg.id != null,
    label: leg.label != null,
    direction: leg.direction != null,
    price: leg.price != null,
    time: leg.time != null,
    bar_index: leg.bar_index != null,
    type: leg.type != null,
  };
}

function resolveTradeStatus({ raw, report_index, closed_count, open_count }) {
  if (raw?.status === 'closed' || raw?.status === 'open') return raw.status;
  if (Number.isInteger(closed_count) && report_index < closed_count) return 'closed';
  if (
    Number.isInteger(closed_count)
    && Number.isInteger(open_count)
    && report_index >= closed_count
    && report_index < closed_count + open_count
  ) return 'open';
  throw new CoreOperationError('Trade status cannot be classified without Report closed/open counts.', {
    code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'trade_normalization',
  });
}

export function classifyTradeStatus(trade, options = {}) {
  return resolveTradeStatus({ raw: trade, ...options });
}

/** Normalize one compact or verbose paired Trade without choosing an output format. */
export function normalizeStrategyTrade(raw, localIndex, options = {}) {
  const variant = rawTradeVariant(raw);
  if (variant === 'unsupported') {
    throw new CoreOperationError('Unsupported Strategy Trade payload shape.', {
      code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'trade_normalization',
    });
  }
  const firstTradeIndex = integerOrNull(options.first_trade_index) ?? 0;
  const reportIndex = options.report_index ?? firstTradeIndex + Number(localIndex);
  if (!Number.isInteger(reportIndex) || reportIndex < 0) {
    throw new CoreOperationError('report_index must resolve to a non-negative integer.', {
      code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'trade_normalization',
    });
  }
  const status = resolveTradeStatus({
    raw,
    report_index: reportIndex,
    closed_count: integerOrNull(options.closed_count),
    open_count: integerOrNull(options.open_count),
  });
  const rawEntry = raw.e || raw.entry;
  const rawExitOrMark = raw.x || raw.exit;
  const entry = normalizeTradeLeg(rawEntry);
  if (!entry) {
    throw new CoreOperationError('Strategy Trade Entry leg is unavailable.', {
      code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'trade_normalization',
    });
  }
  const exit = status === 'closed' ? normalizeTradeLeg(rawExitOrMark) : null;
  const mark = status === 'open' ? normalizeMark(rawExitOrMark) : null;
  const profit = metricPair(raw.tp, raw.profit, variant);
  const cumulativeProfit = metricPair(raw.cp, raw.cumulativeProfit, variant);
  const runUp = metricPair(raw.rn, raw.runup ?? raw.runUp, variant);
  const drawdown = metricPair(raw.dd, raw.drawdown, variant);
  const endBarIndex = status === 'closed' ? exit?.bar_index : mark?.bar_index;
  const durationBars = Number.isInteger(entry.bar_index) && Number.isInteger(endBarIndex)
    ? endBarIndex - entry.bar_index
    : null;
  const currency = options.currency ?? raw.currency ?? null;
  const positionValue = finiteOrNull(firstDefined(raw.v, raw.positionValue));
  const commission = finiteOrNull(firstDefined(raw.cm, raw.commission));

  return {
    schema_version: TRADING_MODEL_SCHEMA_VERSION,
    report_index: reportIndex,
    trade_number: integerOrNull(raw.tradeNumber) ?? reportIndex + 1,
    status,
    entry,
    exit,
    mark,
    quantity: finiteOrNull(firstDefined(raw.q, raw.quantity)),
    position_value: positionValue,
    profit,
    cumulative_profit: cumulativeProfit,
    run_up: runUp,
    drawdown,
    commission,
    duration_bars: durationBars != null && durationBars >= 0 ? durationBars : null,
    currency,
    availability: {
      source_variant: variant,
      trade_number: true,
      status: true,
      entry: legAvailability(entry),
      exit: status === 'closed'
        ? legAvailability(exit)
        : legAvailability(null, { reason: 'open_trade' }),
      mark: status === 'open'
        ? legAvailability(mark)
        : legAvailability(null, { reason: 'closed_trade' }),
      currency: currency != null,
      quantity: finiteOrNull(firstDefined(raw.q, raw.quantity)) != null,
      position_value: positionValue != null,
      profit_value: profit.value != null,
      profit_percent: profit.percent != null,
      cumulative_profit: cumulativeProfit.value != null,
      run_up: runUp.value != null,
      drawdown: drawdown.value != null,
      commission: commission != null,
      duration_bars: durationBars != null && durationBars >= 0,
    },
  };
}

export function createTradeIdentity(trade) {
  if (!trade || typeof trade !== 'object') return null;
  const end = trade.status === 'open' ? trade.mark : trade.exit;
  return {
    report_index: trade.report_index ?? null,
    trade_number: trade.trade_number ?? null,
    status: trade.status ?? null,
    entry: trade.entry ? {
      time: trade.entry.time ?? null,
      bar_index: trade.entry.bar_index ?? null,
      type: trade.entry.type ?? null,
      price: trade.entry.price ?? null,
    } : null,
    exit_or_mark: end ? {
      time: end.time ?? null,
      bar_index: end.bar_index ?? null,
      type: end.type ?? null,
      price: end.price ?? null,
    } : null,
    quantity: trade.quantity ?? null,
  };
}

export function validateTradeSequence(trades, { expected_start_index } = {}) {
  const errors = [];
  const seenIndexes = new Set();
  const seenIdentities = new Set();
  let openSeen = false;
  for (let index = 0; index < (trades || []).length; index += 1) {
    const trade = trades[index];
    const expectedIndex = index === 0
      ? (expected_start_index ?? trade?.report_index)
      : trades[index - 1].report_index + 1;
    if (!Number.isInteger(trade?.report_index)) {
      errors.push({ code: 'REPORT_INDEX_INVALID', position: index, actual: trade?.report_index ?? null });
    } else {
      if (seenIndexes.has(trade.report_index)) {
        errors.push({ code: 'REPORT_INDEX_DUPLICATE', position: index, actual: trade.report_index });
      }
      if (trade.report_index !== expectedIndex) {
        errors.push({ code: 'REPORT_INDEX_GAP', position: index, expected: expectedIndex, actual: trade.report_index });
      }
      seenIndexes.add(trade.report_index);
    }
    const identity = stableJsonStringify(createTradeIdentity(trade));
    if (seenIdentities.has(identity)) errors.push({ code: 'TRADE_IDENTITY_DUPLICATE', position: index });
    seenIdentities.add(identity);
    const entryTime = trade?.entry?.time;
    const previousTime = index > 0 ? trades[index - 1]?.entry?.time : null;
    if (Number.isFinite(entryTime) && Number.isFinite(previousTime) && entryTime < previousTime) {
      errors.push({ code: 'ENTRY_TIME_ORDER', position: index, previous: previousTime, actual: entryTime });
    }
    if (trade?.status === 'open') openSeen = true;
    else if (openSeen && trade?.status === 'closed') errors.push({ code: 'CLOSED_AFTER_OPEN', position: index });
  }
  return { valid: errors.length === 0, count: trades?.length || 0, errors };
}

/** Normalize one runtime batch; Offset/report_index, never bar_index, drives traversal. */
export function normalizeStrategyTradeBatch(rawBatch, options = {}) {
  const items = rawBatch?.items || rawBatch?.trades;
  if (!Array.isArray(items)) {
    throw new CoreOperationError('Raw Strategy Trade batch items are required.', {
      code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'trade_batch_normalization',
    });
  }
  const offset = integerOrNull(rawBatch.offset) ?? 0;
  const snapshot = rawBatch.snapshot_before || options.snapshot_candidate || {};
  const firstTradeIndex = integerOrNull(options.first_trade_index ?? snapshot.first_trade_index) ?? 0;
  const closedCount = integerOrNull(options.closed_count ?? snapshot.closed_trades);
  const openCount = integerOrNull(options.open_count ?? snapshot.open_trades);
  const currency = options.currency ?? snapshot.currency ?? null;
  const trades = items.map((item, index) => normalizeStrategyTrade(item, offset + index, {
    first_trade_index: firstTradeIndex,
    closed_count: closedCount,
    open_count: openCount,
    currency,
  }));
  const sequence = validateTradeSequence(trades, { expected_start_index: firstTradeIndex + offset });
  if (!sequence.valid) {
    throw new CoreOperationError('Strategy Trade batch ordering or identity is invalid.', {
      code: 'TRADING_DATA_INCOMPLETE', phase: 'trade_batch_normalization',
    });
  }
  return {
    schema_version: TRADING_MODEL_SCHEMA_VERSION,
    total: integerOrNull(rawBatch.total) ?? items.length,
    offset,
    returned: trades.length,
    next_offset: rawBatch.next_offset ?? null,
    has_more: rawBatch.has_more === true,
    snapshot_id: rawBatch.snapshot_id ?? null,
    sequence,
    trades,
  };
}

function normalizeRange(range) {
  if (!range || typeof range !== 'object') return null;
  const from = finiteOrNull(range.from);
  const to = finiteOrNull(range.to);
  return {
    from,
    from_iso: unixMillisecondsToIso(from),
    to,
    to_iso: unixMillisecondsToIso(to),
  };
}

/** Normalize a bounded runtime Report projection or fixture Report. */
export function normalizeTradingReport(raw, context = {}) {
  const report = raw?.report || raw;
  const performance = report?.performance || {};
  const all = performance.all || {};
  const metrics = {};
  const metricAvailability = {};
  for (const [canonical, definition] of Object.entries(METRIC_MAP)) {
    const value = finiteOrNull(all[definition.source]);
    metrics[canonical] = value == null ? null : (definition.ratio ? value * 100 : value);
    metricAvailability[canonical] = value != null;
  }
  const topMetrics = {
    max_drawdown: finiteOrNull(performance.maxStrategyDrawDown),
    max_drawdown_percent: finiteOrNull(performance.maxStrategyDrawDownPercent) == null
      ? null
      : finiteOrNull(performance.maxStrategyDrawDownPercent) * 100,
    sharpe_ratio: finiteOrNull(performance.sharpeRatio),
    sortino_ratio: finiteOrNull(performance.sortinoRatio),
    buy_hold_return: finiteOrNull(performance.buyHoldReturn),
    open_profit_loss: finiteOrNull(performance.openPL),
  };
  Object.assign(metrics, topMetrics);
  for (const [key, value] of Object.entries(topMetrics)) metricAvailability[key] = value != null;
  const dateRange = report?.settings?.dateRange || {};
  const calculationMode = report?.calculation_mode || context.calculation_mode || { available: false, value: 'unknown' };
  const safeContext = sanitizeCoreContext(context.context || context);
  const currency = report?.currency ?? context.currency ?? null;
  const reconciliationMetrics = {
    total_net_profit: metrics.net_profit,
    win_rate_percent: metrics.percent_profitable,
    total_trades: metrics.total_trades,
    winning_trades: metrics.winning_trades,
    losing_trades: metrics.losing_trades,
  };
  return {
    schema_version: TRADING_MODEL_SCHEMA_VERSION,
    context: safeContext,
    strategy: {
      entity_id: context.entity_id ?? raw?.entity_id ?? null,
      name: context.strategy_name ?? null,
    },
    requested_symbol: context.requested_symbol ?? context.symbol ?? raw?.symbol ?? null,
    resolved_symbol: context.resolved_symbol ?? raw?.symbol ?? null,
    timeframe: context.timeframe ?? raw?.timeframe ?? raw?.resolution ?? null,
    currency,
    calculation: {
      mode: calculationMode.value ?? 'unknown',
      mode_available: calculationMode.available === true,
      range: {
        backtest: normalizeRange(dateRange.backtest),
        trade: normalizeRange(dateRange.trade),
      },
    },
    first_trade_index: integerOrNull(report?.firstTradeIndex),
    trade_count: integerOrNull(report?.trade_count) ?? (Array.isArray(report?.trades) ? report.trades.length : null),
    metrics,
    reconciliation_metrics: reconciliationMetrics,
    availability: {
      currency: currency != null,
      calculation_mode: calculationMode.available === true,
      backtest_range: dateRange.backtest != null,
      trade_range: dateRange.trade != null,
      metrics: metricAvailability,
    },
  };
}

function snapshotFields(input) {
  const candidate = input?.snapshot_candidate || input || {};
  return {
    snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
    normalization: SNAPSHOT_NORMALIZATION,
    context: {
      target_id: candidate.context?.target_id ?? null,
      layout_id: candidate.context?.layout_id ?? null,
      saved_layout_id: candidate.context?.saved_layout_id ?? null,
      pane_id: candidate.context?.pane_id ?? null,
    },
    entity_id: candidate.entity_id ?? null,
    requested_symbol: candidate.requested_symbol ?? null,
    resolved_symbol: candidate.resolved_symbol ?? null,
    timeframe: candidate.timeframe ?? null,
    inputs_fingerprint: candidate.inputs_fingerprint ?? null,
    calculation_mode: candidate.calculation_mode ?? { available: false, value: 'unknown' },
    date_range: candidate.date_range ?? null,
    currency: candidate.currency ?? null,
    first_trade_index: candidate.first_trade_index ?? null,
    trade_count: candidate.trade_count ?? null,
    closed_trades: candidate.closed_trades ?? null,
    open_trades: candidate.open_trades ?? null,
    metrics: candidate.metrics ?? null,
    first_trade_identity: candidate.first_trade_identity ?? null,
    last_trade_identity: candidate.last_trade_identity ?? null,
  };
}

function missingSnapshotFields(fields) {
  const required = [
    ['context.target_id', fields.context.target_id],
    ['context.layout_id', fields.context.layout_id],
    ['context.pane_id', fields.context.pane_id],
    ['entity_id', fields.entity_id],
    ['requested_symbol', fields.requested_symbol],
    ['resolved_symbol', fields.resolved_symbol],
    ['timeframe', fields.timeframe],
    ['inputs_fingerprint.value', fields.inputs_fingerprint?.available === true ? fields.inputs_fingerprint.value : null],
    ['date_range.backtest.from', fields.date_range?.backtest?.from],
    ['date_range.backtest.to', fields.date_range?.backtest?.to],
    ['date_range.trade.from', fields.date_range?.trade?.from],
    ['date_range.trade.to', fields.date_range?.trade?.to],
    ['currency', fields.currency],
    ['first_trade_index', fields.first_trade_index],
    ['trade_count', fields.trade_count],
    ['closed_trades', fields.closed_trades],
    ['open_trades', fields.open_trades],
    ['metrics.total_net_profit', fields.metrics?.total_net_profit],
    ['metrics.win_rate_percent', fields.metrics?.win_rate_percent],
    ['metrics.total_trades', fields.metrics?.total_trades],
    ['metrics.winning_trades', fields.metrics?.winning_trades],
    ['metrics.losing_trades', fields.metrics?.losing_trades],
  ];
  if (fields.trade_count > 0) {
    required.push(['first_trade_identity', fields.first_trade_identity], ['last_trade_identity', fields.last_trade_identity]);
  }
  return required.filter(([, value]) => value == null).map(([path]) => path);
}

export function createSnapshotIdentity(input) {
  const fields = snapshotFields(input);
  const missingFields = missingSnapshotFields(fields);
  if (missingFields.length) {
    return {
      available: false,
      snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
      snapshot_id: null,
      algorithm: 'sha256',
      missing_fields: missingFields,
      fields,
    };
  }
  const digest = sha256Hex(fields);
  return {
    available: true,
    snapshot_schema_version: SNAPSHOT_SCHEMA_VERSION,
    snapshot_id: `sha256:${digest}`,
    algorithm: 'sha256',
    missing_fields: [],
    fields,
  };
}

function differencePaths(expected, actual, prefix = '', output = []) {
  if (stableJsonStringify(expected) === stableJsonStringify(actual)) return output;
  if (
    expected && actual
    && typeof expected === 'object' && typeof actual === 'object'
    && !Array.isArray(expected) && !Array.isArray(actual)
  ) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      differencePaths(expected[key], actual[key], prefix ? `${prefix}.${key}` : key, output);
      if (output.length >= 50) break;
    }
  } else {
    output.push(prefix || '$');
  }
  return output;
}

export function compareSnapshotIdentity(expectedInput, actualInput) {
  const expected = typeof expectedInput === 'string'
    ? { available: true, snapshot_id: expectedInput, fields: null }
    : expectedInput;
  const actual = typeof actualInput === 'string'
    ? { available: true, snapshot_id: actualInput, fields: null }
    : actualInput;
  const matched = expected?.available === true
    && actual?.available === true
    && expected.snapshot_id === actual.snapshot_id;
  return {
    matched,
    expected_snapshot_id: expected?.snapshot_id ?? null,
    actual_snapshot_id: actual?.snapshot_id ?? null,
    expected_available: expected?.available === true,
    actual_available: actual?.available === true,
    difference_paths: matched || !expected?.fields || !actual?.fields
      ? []
      : differencePaths(expected.fields, actual.fields),
  };
}
