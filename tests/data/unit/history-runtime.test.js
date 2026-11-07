import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopFixture } from '../support/history-runtime.js';

async function open(f) { return f.runtime.openObserver({ symbol: 'TEST:A', timeframe: 'D' }, 1000); }
const read = (f, token) => f.runtime.readSnapshot(token, { includeBars: true, deadline: 1000 });
const request = (f, token) => f.runtime.requestMore(token, { count: 100, expectedFirst: 500, deadline: 1000 });

test('subscribes before synchronous completion and captures pre-request event baseline', async () => {
  const f = desktopFixture(); f.state.request = () => { assert.equal(f.listeners(), 4); f.finish([100, 500, 600]); };
  const { token } = await open(f);
  const sent = await request(f, token);
  assert.equal(sent.issued, true); assert.equal(sent.baselineEvents.completed, 0);
  const snapshot = await read(f, token);
  assert.equal(snapshot.events.completed, 1); assert.equal(snapshot.first_time, 100);
  await f.runtime.closeObserver(token, 1000); await f.runtime.closeObserver(token, 1000);
  assert.equal(f.listeners(), 0); assert.equal(f.timers.size, 0);
});

test('Promise resolution does not establish completion; rejection records an error', async () => {
  for (const rejects of [false, true]) {
    const f = desktopFixture();
    f.state.request = () => { f.state.loading = true; return rejects ? Promise.reject(new Error('source')) : Promise.resolve(); };
    const { token } = await open(f); await request(f, token); await new Promise(resolve => setImmediate(resolve));
    const snapshot = await read(f, token);
    assert.equal(snapshot.loading, true); assert.equal(snapshot.events.completed, 0);
    assert.equal(snapshot.events.error, rejects ? 1 : 0);
    await f.runtime.closeObserver(token, 1000);
  }
});

test('atomic send rechecks loading, availability, end, first time and source identity', async () => {
  for (const update of [f => { f.state.loading = true; }, f => { f.state.more = false; },
    f => { f.state.end = true; }, f => { f.state.bars[0].time = 400; }]) {
    const f = desktopFixture(); const { token } = await open(f); update(f);
    assert.equal((await request(f, token)).issued, false); assert.equal(f.state.requests, 0);
    await f.runtime.closeObserver(token, 1000);
  }
  const f = desktopFixture(); const { token } = await open(f); f.state.symbol = 'TEST:B';
  await assert.rejects(request(f, token), { code: 'HISTORY_CONTEXT_CHANGED' });
  await f.runtime.closeObserver(token, 1000); assert.equal(f.listeners(), 0);
});

test('checks series object identity even when symbol and resolution are unchanged', async () => {
  const f = desktopFixture(); const { token } = await open(f);
  f.chart._chartWidget.model = () => ({ mainSeries: () => ({ ...f.series }) });
  await assert.rejects(read(f, token), { code: 'HISTORY_CONTEXT_CHANGED' });
  await f.runtime.closeObserver(token, 1000);
});

test('required missing, throwing and invalid status methods fail closed', async () => {
  for (const change of [f => { delete f.series.isLoading; }, f => { f.state.loading = null; },
    f => { f.series.endOfData = () => { throw Error('unsupported'); }; }, f => { f.state.endType = 42; }]) {
    const f = desktopFixture(); change(f);
    await assert.rejects(open(f), { code: 'HISTORY_RUNTIME_UNSUPPORTED' }); assert.equal(f.listeners(), 0);
  }
  const f = desktopFixture(); const { token } = await open(f); f.state.more = undefined;
  await assert.rejects(read(f, token), { code: 'HISTORY_RUNTIME_UNSUPPORTED' });
  await f.runtime.closeObserver(token, 1000);
});

test('missing optional events falls back to status polling', async () => {
  const f = desktopFixture({ events: false }); const observer = await open(f);
  assert.equal(observer.capabilities.events, false);
  assert.equal((await read(f, observer.token)).loading, false);
  await f.runtime.closeObserver(observer.token, 1000);
});

test('partial subscription failure cleans already registered callbacks', async () => {
  const f = desktopFixture();
  const original = f.emitters.completed.subscribe;
  f.emitters.completed.subscribe = function (...args) { original.apply(this, args); throw Error('subscribe failed'); };
  await assert.rejects(open(f), { code: 'HISTORY_RUNTIME_UNSUPPORTED' }); assert.equal(f.listeners(), 0);
});

test('lease expiry cleans listeners and prevents reuse of the token', async () => {
  const f = desktopFixture(); const { token } = await open(f); f.advance(30000);
  assert.equal(f.listeners(), 0); assert.equal(f.timers.size, 0);
  await assert.rejects(f.runtime.readSnapshot(token, { deadline: 31000 }), { code: 'HISTORY_OBSERVER_EXPIRED' });
});

test('symbol/resolution readback normalizes D and checks timeout', async () => {
  const f = desktopFixture(); await f.runtime.setChart({ timeframe: 'D' }, 1000);
  assert.equal(f.state.timeframe, '1D');
  f.chart.setSymbol = () => {};
  await assert.rejects(f.runtime.setChart({ symbol: 'TEST:B' }, 1000), { code: 'HISTORY_LOAD_TIMEOUT' });
});

test('symbol aliases and normalized resolution do not require unnecessary chart mutation', async () => {
  const f = desktopFixture(); f.state.symbol = 'TWSE_DLY:6902';
  const observer = await f.runtime.openObserver({ symbol: 'TWSE:6902', timeframe: 'D' }, 1000);
  assert.equal(observer.symbol, 'TWSE_DLY:6902');
  await f.runtime.closeObserver(observer.token, 1000);
});

test('CDP timeout budget never exceeds the remaining operation deadline', async () => {
  const { createHistoryRuntime } = await import('../../../src/core/history-runtime.js');
  const budgets = [];
  const runtime = createHistoryRuntime({ now: () => 80, evaluate: async (_code, options) => { budgets.push(options.timeout_ms); return {}; } });
  await runtime.getChartState(100); assert.deepEqual(budgets, [20]);
  await assert.rejects(runtime.getChartState(80), { code: 'HISTORY_TIMEOUT' });
  assert.deepEqual(budgets, [20]);
});

test('cleanup attempts every unsubscribe even when one listener removal fails', async () => {
  const f = desktopFixture(); const { token } = await open(f);
  const original = f.emitters.loading.unsubscribe;
  f.emitters.loading.unsubscribe = function (...args) { original.apply(this, args); throw Error('remove failed'); };
  await assert.rejects(f.runtime.closeObserver(token, 1000), { code: 'HISTORY_CLEANUP_FAILED' });
  assert.equal(f.listeners(), 0); assert.equal(f.timers.size, 0);
});
