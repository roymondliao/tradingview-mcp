import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getHistory } from '../src/core/data.js';
import { writeHistoryOutput } from '../src/cli/commands/data.js';

const bar = (time) => ({ time, open: time, high: time + 2, low: time - 1, close: time + 1, volume: time * 10 });

function historyDeps(states, { original = { symbol: 'NASDAQ:AAPL', timeframe: 'D' }, pollAttempts = 2 } = {}) {
  let index = 0;
  const setChartCalls = [];
  return {
    setChartCalls,
    deps: {
      pollAttempts,
      sleep: async () => {},
      getChartState: async () => original,
      setChart: async (change) => { setChartCalls.push(change); },
      readSnapshot: async () => states[index],
      requestMore: async () => { if (index < states.length - 1) index += 1; },
    },
  };
}

describe('getHistory() — batched TradingView history', () => {
  it('loads to the first available bar, deduplicates, and sorts OHLCV', async () => {
    const { deps } = historyDeps([
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 300, more: true, bars: [bar(300), bar(400)] },
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 100, more: false, bars: [bar(100), bar(200), bar(300)] },
    ]);

    const result = await getHistory({ include_bars: true, _deps: deps });

    assert.equal(result.complete, true);
    assert.equal(result.stop_reason, 'no_more_data');
    assert.equal(result.requests_made, 1);
    assert.equal(result.bar_count, 4);
    assert.deepEqual(result.bars.map(item => item.time), [100, 200, 300, 400]);
    assert.equal(result.bars[0].time_iso, '1970-01-01T00:01:40.000Z');
    assert.deepEqual(result.period, {
      from: 100,
      to: 400,
      from_iso: '1970-01-01T00:01:40.000Z',
      to_iso: '1970-01-01T00:06:40.000Z',
    });
  });

  it('stops once the requested start time is covered and filters older bars', async () => {
    const { deps } = historyDeps([
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 500, more: true, bars: [bar(500), bar(600)] },
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 200, more: true, bars: [bar(200), bar(300), bar(400)] },
    ]);

    const result = await getHistory({ from: 250, include_bars: true, _deps: deps });

    assert.equal(result.complete, true);
    assert.equal(result.stop_reason, 'from_reached');
    assert.equal(result.requested_from, 250);
    assert.equal(result.requested_from_iso, '1970-01-01T00:04:10.000Z');
    assert.deepEqual(result.bars.map(item => item.time), [300, 400, 500, 600]);
  });

  it('reports an incomplete result when the request safety limit is reached', async () => {
    const { deps } = historyDeps([
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 500, more: true, bars: [bar(500), bar(600)] },
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 300, more: true, bars: [bar(300), bar(400)] },
    ]);

    const result = await getHistory({ max_requests: 1, _deps: deps });

    assert.equal(result.complete, false);
    assert.equal(result.stop_reason, 'max_requests');
    assert.equal(result.requests_made, 1);
    assert.equal(result.bars, undefined);
  });

  it('does not claim completeness when the bar safety limit truncates data', async () => {
    const { deps } = historyDeps([
      { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 100, more: false, bars: [bar(100), bar(200)] },
    ]);

    const result = await getHistory({ max_bars: 1, include_bars: true, _deps: deps });

    assert.equal(result.complete, false);
    assert.equal(result.stop_reason, 'max_bars');
    assert.equal(result.bar_count, 1);
    assert.deepEqual(result.bars.map(item => item.time), [200]);
  });

  it('stops when a backward data request makes no progress', async () => {
    let reads = 0;
    const initial = { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 500, more: true, bars: [bar(500)] };
    const stalled = { symbol: 'NASDAQ:AAPL', resolution: 'D', first_time: 500, more: true, bars: [] };
    const deps = {
      pollAttempts: 2,
      sleep: async () => {},
      getChartState: async () => ({ symbol: 'NASDAQ:AAPL', timeframe: 'D' }),
      setChart: async () => {},
      readSnapshot: async () => reads++ === 0 ? initial : stalled,
      requestMore: async () => {},
    };

    const result = await getHistory({ _deps: deps });

    assert.equal(result.complete, false);
    assert.equal(result.stop_reason, 'no_progress');
    assert.equal(result.requests_made, 1);
  });

  it('temporarily switches symbol/timeframe and restores the original chart', async () => {
    const { deps, setChartCalls } = historyDeps([
      { symbol: 'NYSE:IBM', resolution: 'W', first_time: 100, more: false, bars: [bar(100)] },
    ]);

    const result = await getHistory({ symbol: 'NYSE:IBM', timeframe: 'W', _deps: deps });

    assert.equal(result.symbol, 'NYSE:IBM');
    assert.deepEqual(setChartCalls, [
      { symbol: 'NYSE:IBM', timeframe: 'W' },
      { symbol: 'NASDAQ:AAPL', timeframe: 'D' },
    ]);
  });

  it('rejects unsafe paging limits before touching the chart', async () => {
    await assert.rejects(
      getHistory({ bars_per_request: 99999, _deps: {} }),
      /bars_per_request must be an integer between 100 and 5000/,
    );
  });
});

describe('history CLI file output', () => {
  it('writes the complete JSON result and keeps bars out of the stdout summary', () => {
    let written = null;
    const result = {
      success: true,
      complete: true,
      bar_count: 1,
      bars: [bar(100)],
    };

    const summary = writeHistoryOutput(result, 'history.json', {
      resolvePath: (path) => `/work/${path}`,
      writeFile: (path, content, options) => { written = { path, content, options }; },
    });

    assert.equal(written.path, '/work/history.json');
    assert.deepEqual(written.options, { encoding: 'utf8', flag: 'wx' });
    assert.deepEqual(JSON.parse(written.content), result);
    assert.equal(summary.output, '/work/history.json');
    assert.equal(summary.output_includes_bars, true);
    assert.equal('bars' in summary, false);
  });

  it('only enables overwrite when force is explicit', () => {
    let writeOptions = null;
    writeHistoryOutput({ success: true }, 'history.json', {
      force: true,
      resolvePath: (path) => path,
      writeFile: (_path, _content, options) => { writeOptions = options; },
    });
    assert.equal(writeOptions.flag, 'w');
  });
});
