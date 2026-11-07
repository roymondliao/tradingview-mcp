import vm from 'node:vm';
import { createHistoryRuntime } from '../../../src/core/history-runtime.js';

export const bar = time => ({ time, open: 1, high: 2, low: 1, close: 2, volume: 10 });
export function desktopFixture({ events = true, policy = {} } = {}) {
  let clock = 0;
  const timers = new Map(), callbacks = [];
  const state = { symbol: 'TEST:A', timeframe: '1D', loading: false, more: true, end: false, endType: null,
    bars: [bar(500), bar(600)], requests: 0, disposed: 0, request: () => undefined };
  const emitters = {};
  for (const name of ['loading', 'completed', 'error', 'dataLoaded']) {
    const listeners = new Set();
    emitters[name] = {
      listeners,
      subscribe(_owner, callback) { listeners.add(callback); },
      unsubscribe(_owner, callback) { listeners.delete(callback); state.disposed++; },
      fire() { for (const callback of listeners) callback(); },
    };
  }
  const series = {
    bars: () => ({ firstIndex: () => 0, lastIndex: () => state.bars.length - 1,
      size: () => state.bars.length,
      valueAt: i => { const b = state.bars[i]; return b ? [b.time, b.open, b.high, b.low, b.close, b.volume] : null; } }),
    isLoading: () => state.loading,
    endOfData: () => state.end,
    endOfDataType: () => state.endType,
    requestMoreDataAvailable: () => state.more,
    requestMoreData: count => { state.requests++; return state.request(count); },
    ...(events ? { dataEvents: () => Object.fromEntries(['loading', 'completed', 'error'].map(n => [n, () => emitters[n]])) } : {}),
  };
  const chart = { symbol: () => state.symbol, resolution: () => state.timeframe,
    setSymbol: symbol => { state.symbol = symbol; }, setResolution: tf => { state.timeframe = tf; },
    _chartWidget: { model: () => ({ mainSeries: () => series }) },
    ...(events ? { onDataLoaded: () => emitters.dataLoaded } : {}),
  };
  const context = vm.createContext({ window: { TradingViewApi: { _activeChartWidgetWV: { value: () => chart } } },
    Date: { now: () => clock },
    setInterval: fn => { const id = Symbol(); timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
  });
  const advance = ms => {
    clock += ms;
    for (const item of callbacks.splice(0)) {
      if (item.at <= clock) item.callback(); else callbacks.push(item);
    }
    for (const fn of timers.values()) fn();
  };
  const schedule = (ms, callback) => callbacks.push({ at: clock + ms, callback });
  const finish = (times, end = false) => {
    state.bars = times.map(bar); state.loading = false; state.more = true; state.end = end; state.endType = end ? 'end' : null;
    emitters.completed.fire(); emitters.dataLoaded.fire();
  };
  const runtime = createHistoryRuntime({ now: () => clock, sleep: async ms => advance(ms),
    policy: { pollIntervalMs: 10, loadTimeoutMs: 100, historyTimeoutMs: 1000, cleanupTimeoutMs: 100, ...policy },
    evaluate: async (code, opts) => {
      if (!(opts.timeout_ms > 0 && opts.timeout_ms <= 10000)) throw new Error('Unbounded CDP command');
      const value = vm.runInContext(code, context);
      return value == null ? value : JSON.parse(JSON.stringify(value));
    },
  });
  return { state, series, chart, context, emitters, runtime, advance, schedule, finish, timers,
    listeners: () => Object.values(emitters).reduce((n, e) => n + e.listeners.size, 0) };
}
