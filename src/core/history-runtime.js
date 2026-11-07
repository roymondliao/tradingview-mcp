/* global window */
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { evaluate, CDP_TIMEOUTS } from '../connection.js';
import { historyError } from './history-errors.js';
import { symbolIdentitiesMatch } from './pane.js';

export const HISTORY_POLICY = Object.freeze({
  pollIntervalMs: 250, loadTimeoutMs: 10000, historyTimeoutMs: 120000, cleanupTimeoutMs: 15000,
});
export const normalizeHistoryResolution = value => /^[DWM]$/.test(String(value)) ? `1${value}` : String(value);

// Self-contained page operation, also executed in a VM by the adapter tests.
export function historyPageOperation(action, token, args) {
  const key = '__tradingviewMcpHistoryObserversV1';
  const fail = (code, message) => ({ failure: { code, message } });
  const chart = () => window.TradingViewApi._activeChartWidgetWV.value();
  const registry = window[key] || (window[key] = Object.create(null));
  const dispose = entry => {
    clearInterval(entry.timer);
    entry.disposed = true;
    let failure;
    for (const unsubscribe of entry.unsubscribe) {
      try { unsubscribe(); } catch (error) { failure ||= error; }
    }
    delete registry[token];
    if (failure) throw failure;
  };
  if (action === 'close') {
    try { if (registry[token]) dispose(registry[token]); return true; }
    catch { return fail('HISTORY_CLEANUP_FAILED', 'Could not remove all history event subscriptions.'); }
  }
  if (action === 'state') {
    const c = chart();
    return { symbol: c.symbol(), timeframe: c.resolution() };
  }
  if (action === 'set') {
    const c = chart();
    if (args.symbol) c.setSymbol(args.symbol, {});
    if (args.timeframe) c.setResolution(args.timeframe, {});
    return true;
  }
  if (action === 'open') {
    const c = chart(), series = c._chartWidget.model().mainSeries();
    const required = ['bars', 'requestMoreData', 'requestMoreDataAvailable', 'isLoading', 'endOfData', 'endOfDataType'];
    if (required.some(name => typeof series[name] !== 'function')) {
      return fail('HISTORY_RUNTIME_UNSUPPORTED', 'Desktop is missing required history status methods.');
    }
    const entry = { chart: c, series, symbol: c.symbol(), resolution: c.resolution(),
      events: { loading: 0, completed: 0, dataLoaded: 0, error: 0 }, unsubscribe: [],
      touched: Date.now(), disposed: false, timer: null };
    registry[token] = entry;
    try {
      // Verify state values before any subscriptions or requests.
      if ([series.isLoading(), series.endOfData(), series.requestMoreDataAvailable()].some(v => typeof v !== 'boolean')) {
        throw new Error('Invalid history status type');
      }
      const endType = series.endOfDataType();
      if (endType != null && typeof endType !== 'string') throw new Error('Invalid endOfDataType');
      const subscribe = (emitter, event) => {
        if (typeof emitter?.subscribe !== 'function' || typeof emitter?.unsubscribe !== 'function') return;
        const callback = () => { if (!entry.disposed) entry.events[event]++; };
        // Record cleanup first: a provider may register and then throw.
        entry.unsubscribe.push(() => emitter.unsubscribe(null, callback));
        emitter.subscribe(null, callback);
      };
      const events = typeof series.dataEvents === 'function' ? series.dataEvents() : null;
      for (const name of ['loading', 'completed', 'error']) {
        if (typeof events?.[name] === 'function') subscribe(events[name](), name);
      }
      if (typeof c.onDataLoaded === 'function') subscribe(c.onDataLoaded(), 'dataLoaded');
      entry.timer = setInterval(() => {
        if (Date.now() - entry.touched >= 30000) {
          try { dispose(entry); } catch { /* All removals were attempted; never throw into Desktop. */ }
        }
      }, 5000);
      return { token, capabilities: { events: entry.unsubscribe.length > 0 },
        symbol: entry.symbol, resolution: entry.resolution };
    } catch {
      try { dispose(entry); } catch { /* Initialization still fails closed. */ }
      return fail('HISTORY_RUNTIME_UNSUPPORTED', 'Could not initialize Desktop history status observation.');
    }
  }
  const entry = registry[token];
  if (!entry || entry.disposed) return fail('HISTORY_OBSERVER_EXPIRED', 'History observer expired.');
  entry.touched = Date.now();
  const c = chart();
  if (c !== entry.chart || c._chartWidget.model().mainSeries() !== entry.series
    || c.symbol() !== entry.symbol || c.resolution() !== entry.resolution) {
    return fail('HISTORY_CONTEXT_CHANGED', 'The chart changed during historical data loading.');
  }
  const s = entry.series;
  let loading, more, end, endType;
  try {
    loading = s.isLoading(); more = s.requestMoreDataAvailable(); end = s.endOfData(); endType = s.endOfDataType();
    if ([loading, more, end].some(v => typeof v !== 'boolean') || (endType != null && typeof endType !== 'string')) {
      throw new Error('Invalid status type');
    }
  } catch { return fail('HISTORY_RUNTIME_UNSUPPORTED', 'Could not read Desktop history status.'); }
  const bars = s.bars();
  if (!bars || typeof bars.firstIndex !== 'function') return null;
  const first = bars.valueAt(bars.firstIndex()), last = bars.valueAt(bars.lastIndex());
  const firstTime = first?.[0] ?? null;
  if (action === 'request') {
    if (entry.events.error) return fail('HISTORY_SOURCE_ERROR', 'Desktop reported a history source error.');
    if (loading || !more || end || firstTime !== args.expectedFirst) return { issued: false };
    const baselineEvents = { ...entry.events };
    try {
      const pending = s.requestMoreData(args.count);
      if (pending && typeof pending.then === 'function') {
        Promise.resolve(pending).catch(() => { if (!entry.disposed) entry.events.error++; });
      }
    } catch { return fail('HISTORY_SOURCE_ERROR', 'Desktop rejected a history data request.'); }
    return { issued: true, baselineEvents };
  }
  const result = { identity: { symbol: entry.symbol, resolution: entry.resolution, sourceMatches: true },
    symbol: entry.symbol, resolution: entry.resolution, first_time: firstTime, last_time: last?.[0] ?? null,
    total_loaded: bars.size(), loading, more, end_of_data: end, end_of_data_type: endType ?? null,
    events: { ...entry.events } };
  if (args.includeBars) {
    result.bars = [];
    for (let i = bars.firstIndex(); i <= bars.lastIndex(); i++) {
      const v = bars.valueAt(i);
      if (v && (args.beforeTime == null || v[0] < args.beforeTime)) {
        result.bars.push({ time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0 });
      }
    }
  }
  return result;
}

export function createHistoryRuntime(deps = {}) {
  const now = deps.now || (() => performance.now());
  const sleep = deps.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const policy = { ...HISTORY_POLICY, ...deps.policy };
  for (const value of Object.values(policy)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error('History timing policy must be positive.');
  }
  const call = async (action, token, args, deadline) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw historyError('HISTORY_TIMEOUT', 'History operation deadline expired.', { retryable: true });
    const result = await (deps.evaluate || evaluate)(
      `(${historyPageOperation.toString()})(${JSON.stringify(action)},${JSON.stringify(token)},${JSON.stringify(args)})`,
      { timeout_ms: Math.max(1, Math.min(CDP_TIMEOUTS.command, remaining)) });
    if (result?.failure) throw historyError(result.failure.code, result.failure.message, {
      kind: result.failure.code === 'HISTORY_CONTEXT_CHANGED' ? 'conflict' : 'internal',
      retryable: result.failure.code === 'HISTORY_OBSERVER_EXPIRED',
    });
    return result;
  };
  return {
    now, sleep, policy,
    getChartState: deadline => call('state', null, {}, deadline),
    setChart: async ({ symbol, timeframe }, deadline) => {
      // Serialize symbol and resolution changes, and check actual API readback rather than UI spinners.
      for (const change of [{ symbol }, { timeframe: timeframe ? normalizeHistoryResolution(timeframe) : null }]) {
        if (!change.symbol && !change.timeframe) continue;
        await call('set', null, change, deadline);
        const readyDeadline = Math.min(deadline, now() + policy.loadTimeoutMs);
        let ready = false;
        while (now() < readyDeadline) {
          const state = await call('state', null, {}, readyDeadline);
          if (now() >= readyDeadline) break;
          if ((!change.symbol || symbolIdentitiesMatch(change.symbol, state.symbol))
            && (!change.timeframe || normalizeHistoryResolution(state.timeframe) === change.timeframe)) { ready = true; break; }
          await sleep(Math.min(policy.pollIntervalMs, Math.max(0, readyDeadline - now())));
        }
        if (!ready) throw historyError('HISTORY_LOAD_TIMEOUT', 'Chart identity readback timed out.', {
          retryable: true, stage: 'chart_ready', timeout_ms: policy.loadTimeoutMs,
        });
      }
    },
    openObserver: async (expected, deadline) => {
      const opened = await call('open', randomUUID(), {}, deadline);
      if (!symbolIdentitiesMatch(expected.symbol, opened.symbol)
        || normalizeHistoryResolution(expected.timeframe) !== normalizeHistoryResolution(opened.resolution)) {
        await call('close', opened.token, {}, deadline);
        throw historyError('HISTORY_CONTEXT_CHANGED', 'Chart identity changed before history observation.', { kind: 'conflict' });
      }
      return opened;
    },
    readSnapshot: (token, options) => call('read', token, options, options.deadline),
    requestMore: (token, options) => call('request', token, options, options.deadline),
    closeObserver: (token, deadline) => call('close', token, {}, deadline),
    ...Object.fromEntries(Object.entries(deps).filter(([key]) => [
      'getChartState', 'setChart', 'openObserver', 'readSnapshot', 'requestMore', 'closeObserver',
    ].includes(key))),
  };
}
