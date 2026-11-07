import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHistory } from '../../../src/core/data.js';
import { desktopFixture, bar } from '../support/history-runtime.js';

const history = (f, options = {}) => getHistory({ ...options, _deps: { runtime: f.runtime } });
const delayed = (f, times = [100, 200, 500, 600], ms = 30, end = false) => {
  f.state.request = () => {
    f.state.loading = true; f.state.more = false; f.emitters.loading.fire();
    f.schedule(ms, () => f.finish(times, end));
  };
};

test('waits through temporary more=false and returns older bounded bars in one operation', async () => {
  for (const events of [true, false]) {
    const f = desktopFixture({ events }); delayed(f);
    const result = await history(f, { from: 100, to: 200, include_bars: true });
    assert.deepEqual(result.bars.map(b => b.time), [100, 200]);
    assert.equal(result.stop_reason, 'from_reached'); assert.equal(result.requests_made, 1);
    assert.equal(f.state.requests, 1); assert.equal(f.listeners(), 0);
  }
});

test('confirmed exhaustion succeeds even if more remains true; loading overrides stale end', async () => {
  const f = desktopFixture(); f.state.end = true; f.state.endType = 'end'; f.state.loading = true;
  f.schedule(20, () => { f.state.loading = false; });
  const result = await history(f, { from: 100 });
  assert.equal(result.complete, true); assert.equal(result.stop_reason, 'no_more_data');
  assert.equal(f.state.requests, 0); assert.equal(f.runtime.now(), 20);
});

test('initial empty loading series waits until actual data arrives', async () => {
  const f = desktopFixture(); f.state.bars = []; f.state.loading = true;
  f.schedule(20, () => f.finish([100, 200], true));
  const result = await history(f); assert.equal(result.bar_count, 2); assert.equal(result.complete, true);
});

test('completed event without backward progress is incomplete, including latest-bar growth', async () => {
  for (const times of [[500, 600], [500, 600, 700]]) {
    const f = desktopFixture(); delayed(f, times);
    const result = await history(f); assert.equal(result.stop_reason, 'no_progress'); assert.equal(result.complete, false);
    assert.equal(f.state.requests, 1);
  }
});

test('ambiguous availability and unconfirmed requests expire without resubmission', async () => {
  for (const mode of ['unavailable', 'pending']) {
    const f = desktopFixture();
    if (mode === 'unavailable') f.state.more = false;
    const result = await history(f);
    assert.equal(result.stop_reason, 'load_timeout'); assert.equal(result.complete, false);
    assert.equal(f.state.requests, mode === 'unavailable' ? 0 : 1);
  }
});

test('late completion cannot turn a deadline into success; completion before deadline can', async () => {
  for (const ms of [90, 100, 110]) {
    const f = desktopFixture(); delayed(f, [100, 500, 600], ms);
    const result = await history(f, { from: 100 });
    assert.equal(result.complete, ms < 100);
    assert.equal(result.stop_reason, ms < 100 ? 'from_reached' : 'load_timeout');
    assert.equal(f.listeners(), 0);
  }
});

test('progress does not reset the overall deadline', async () => {
  const f = desktopFixture({ policy: { historyTimeoutMs: 65 } });
  f.state.request = () => {
    f.state.loading = true;
    f.schedule(30, () => f.finish([f.state.bars[0].time - 100, ...f.state.bars.map(b => b.time)]));
  };
  const result = await history(f); assert.equal(result.stop_reason, 'history_timeout'); assert.equal(result.complete, false);
});

test('unknown end types remain incomplete and never trigger another request', async () => {
  const f = desktopFixture(); f.state.end = true; f.state.endType = 'plan_limit';
  const result = await history(f); assert.equal(result.stop_reason, 'unsupported_end_state');
  assert.equal(result.complete, false); assert.equal(f.state.requests, 0);
});

test('empty results distinguish exhaustion, pending load, limits and unsupported end type', async () => {
  for (const [mode, code, retryable] of [
    ['empty', 'HISTORY_RANGE_EMPTY', false], ['timeout', 'HISTORY_LOAD_TIMEOUT', true],
    ['limit', 'HISTORY_LIMIT_REACHED', false], ['unknown', 'HISTORY_END_STATE_UNSUPPORTED', false],
  ]) {
    const f = desktopFixture();
    if (mode === 'empty' || mode === 'unknown') { f.state.end = true; f.state.endType = mode === 'empty' ? 'end' : 'other'; }
    if (mode === 'limit') delayed(f, [300, 500, 600]);
    await assert.rejects(history(f, { from: 100, to: 200, max_requests: 1 }), error => error.code === code && error.retryable === retryable);
    assert.equal(f.listeners(), 0);
  }
});

test('error events take priority over target coverage', async () => {
  const f = desktopFixture();
  f.state.request = () => { f.emitters.error.fire(); f.finish([100, 500, 600]); };
  await assert.rejects(history(f, { from: 100 }), { code: 'HISTORY_SOURCE_ERROR' }); assert.equal(f.listeners(), 0);
});

test('external symbol changes fail without restoring over the user choice', async () => {
  const f = desktopFixture();
  f.state.request = () => { f.state.symbol = 'TEST:USER'; };
  await assert.rejects(history(f, { symbol: 'TEST:B' }), { code: 'HISTORY_CONTEXT_CHANGED' });
  assert.equal(f.state.symbol, 'TEST:USER'); assert.equal(f.listeners(), 0);
});

test('read including bars is checked again for source and loading changes', async () => {
  for (const conflict of [true, false]) {
    const f = desktopFixture(); const realRead = f.runtime.readSnapshot;
    let changed = false;
    f.runtime.readSnapshot = async (token, options) => {
      if (options.includeBars && !changed) {
        changed = true;
        if (conflict) f.state.symbol = 'TEST:USER';
        else { f.state.loading = true; f.schedule(20, () => f.finish([100, 200], true)); }
      }
      return realRead(token, options);
    };
    if (conflict) await assert.rejects(history(f), { code: 'HISTORY_CONTEXT_CHANGED' });
    else { const result = await history(f, { include_bars: true }); assert.deepEqual(result.bars.map(b => b.time), [100, 200]); }
  }
});

test('no-restore still removes observers; restoration errors suppress successful results', async () => {
  const f = desktopFixture(); f.state.end = true; f.state.endType = 'end';
  await history(f, { symbol: 'TEST:B', restore_chart: false });
  assert.equal(f.state.symbol, 'TEST:B'); assert.equal(f.listeners(), 0);
  f.chart.setSymbol = value => { if (value === 'TEST:B') throw Error('restore failed'); f.state.symbol = value; };
  await assert.rejects(history(f, { symbol: 'TEST:C' }), { code: 'HISTORY_RESTORE_FAILED' });
  assert.equal(f.listeners(), 0);
});

test('cleanup failure preserves primary error and still attempts restoration', async () => {
  const f = desktopFixture(); const realClose = f.runtime.closeObserver;
  f.runtime.closeObserver = async (...args) => { await realClose(...args); throw Error('cleanup'); };
  f.state.request = () => { throw Error('request failed'); };
  await assert.rejects(history(f, { symbol: 'TEST:B' }), error =>
    error.code === 'HISTORY_CLEANUP_FAILED' && error.cause.code === 'HISTORY_SOURCE_ERROR');
  assert.equal(f.state.symbol, 'TEST:A'); assert.equal(f.listeners(), 0);
});

test('zero bars with confirmed exhaustion is a real empty result', async () => {
  const f = desktopFixture(); f.state.bars = []; f.state.end = true; f.state.endType = 'end';
  await assert.rejects(history(f), { code: 'HISTORY_RANGE_EMPTY', retryable: false });
});

test('truncation takes precedence over target coverage', async () => {
  const f = desktopFixture(); f.state.bars = [100, 200, 300].map(bar);
  const result = await history(f, { from: 100, max_bars: 2 });
  assert.equal(result.complete, false); assert.equal(result.stop_reason, 'max_bars');
});

test('snapshot loss can recover; persistent loss returns partial read_failed', async () => {
  for (const recover of [false, true]) {
    const f = desktopFixture(); const read = f.runtime.readSnapshot;
    delayed(f);
    f.runtime.readSnapshot = async (token, options) => {
      if (f.state.requests && (!recover || f.runtime.now() < 40)) return null;
      return read(token, options);
    };
    const result = await history(f, { from: 100 });
    assert.equal(result.stop_reason, recover ? 'from_reached' : 'read_failed');
    assert.equal(result.complete, recover);
  }
});

test('synchronous event plus loading=true does not release the pending request', async () => {
  const f = desktopFixture();
  f.state.request = () => {
    f.state.loading = true; f.emitters.completed.fire();
    f.schedule(30, () => f.finish([100, 500, 600]));
  };
  const result = await history(f, { from: 100 });
  assert.equal(result.complete, true); assert.equal(f.state.requests, 1); assert.equal(f.runtime.now(), 30);
});

test('atomic send rejection has bounded polling and does not reset the deadline', async () => {
  const f = desktopFixture(); let attempts = 0;
  f.runtime.requestMore = async () => { attempts++; return { issued: false }; };
  const result = await history(f);
  assert.equal(result.stop_reason, 'load_timeout'); assert.equal(result.requests_made, 0);
  assert.equal(attempts, 10); assert.equal(f.runtime.now(), 100);
});

test('a late CDP read is not accepted as timely completion', async () => {
  const f = desktopFixture(); const read = f.runtime.readSnapshot;
  f.runtime.readSnapshot = async (...args) => {
    const snapshot = await read(...args);
    if (f.state.requests) { f.advance(100); f.finish([100, 500, 600]); }
    return snapshot;
  };
  const result = await history(f, { from: 100 });
  assert.equal(result.stop_reason, 'load_timeout'); assert.equal(result.complete, false);
});

test('deadline expiring between loop and adapter preflight preserves partial results', async () => {
  const f = desktopFixture(); const read = f.runtime.readSnapshot;
  f.runtime.readSnapshot = async (...args) => {
    if (f.state.requests) f.advance(100);
    return read(...args);
  };
  const result = await history(f);
  assert.equal(result.stop_reason, 'load_timeout'); assert.equal(result.bar_count, 2);
});
