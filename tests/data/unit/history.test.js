import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHistory, normalizeHistoryRange } from '../../../src/core/data.js';
import { runHistoryCommand, writeHistoryOutput } from '../../../src/cli/commands/data.js';

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

describe('history date range validation', () => {
  it('shares the existing date, timezone, and Unix timestamp rules for both endpoints', () => {
    for (const [value, expected] of [
      ['2026-06-30', 1782777600],
      ['2026-06-30T23:59:59+08:00', 1782835199],
      ['1782863999', 1782863999],
      [1782863999000, 1782863999],
      ['1782863999000', 1782863999],
      [0, 0],
    ]) {
      assert.deepEqual(normalizeHistoryRange({ from: value, to: value }), {
        fromTime: expected, toTime: expected,
      });
    }
    assert.deepEqual(normalizeHistoryRange(), { fromTime: null, toTime: null });
    assert.deepEqual(normalizeHistoryRange({ from: 250 }), { fromTime: 250, toTime: null });
  });

  it('rejects invalid ranges before core chart reads or CLI context preparation', async () => {
    let calls = 0;
    const unexpectedOperation = () => { calls += 1; throw new Error('Unexpected chart operation'); };
    for (const [options, message] of [
      [{ to: 400 }, /--to requires --from/],
      [{ from: '', to: 400 }, /--to requires --from/],
      [{ from: '  ', to: 400 }, /--to requires --from/],
      [{ from: 200, to: '' }, /Invalid to date/],
      [{ from: 200, to: 'invalid' }, /Invalid to date/],
      [{ from: 200, to: '   ' }, /Invalid to date/],
      [{ from: 200, to: Infinity }, /Invalid to value/],
      [{ from: 'invalid', to: 400 }, /Invalid from date/],
      [{ from: NaN, to: 400 }, /Invalid from value/],
      [{ from: 400, to: 200 }, /from must be less than or equal to to/],
    ]) {
      await assert.rejects(getHistory({
        ...options, _deps: { getChartState: unexpectedOperation },
      }), message);
      await assert.rejects(runHistoryCommand(options, {
        withContext: unexpectedOperation,
        getHistory: unexpectedOperation,
        writeOutput: unexpectedOperation,
      }), message);
    }
    assert.equal(calls, 0);
  });
});

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
    assert.equal(result.requested_to, null);
    assert.equal(result.requested_to_iso, null);
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

  it('pages past newer batches without counting them toward the returned bar limit', async () => {
    const { deps } = historyDeps([
      { first_time: 700, more: true, bars: [bar(700), bar(800)] },
      { first_time: 500, more: true, bars: [bar(500), bar(600)] },
      { first_time: 200, more: true, bars: [bar(400), bar(300), bar(200), bar(300)] },
    ]);
    const result = await getHistory({ from: 250, to: 400, max_bars: 2, include_bars: true, _deps: deps });
    assert.deepEqual(result.bars.map(item => item.time), [300, 400]);
    assert.equal(result.requests_made, 2);
    assert.equal(result.stop_reason, 'from_reached');
    assert.equal(result.complete, true);
    assert.equal(result.bar_count, 2);
    assert.equal(result.requested_to, 400);
    assert.equal(result.requested_to_iso, '1970-01-01T00:06:40.000Z');
    assert.equal(result.period.from, 300);
    assert.equal(result.period.to, 400);
  });

  it('includes both endpoints and keeps the latest matching bars when over the limit', async () => {
    for (const maxBars of [2, 3]) {
      const { deps } = historyDeps([
        { first_time: 100, more: false, bars: [100, 200, 300, 400, 500].map(bar) },
      ]);
      const result = await getHistory({ from: 200, to: 400, max_bars: maxBars, include_bars: true, _deps: deps });
      assert.deepEqual(result.bars.map(item => item.time), maxBars === 2 ? [300, 400] : [200, 300, 400]);
      assert.equal(result.stop_reason, maxBars === 2 ? 'max_bars' : 'from_reached');
      assert.equal(result.complete, maxBars === 3);
      assert.equal(result.bar_count, maxBars);
    }
  });

  it('accepts an equal range at Unix zero', async () => {
    const { deps } = historyDeps([{ first_time: 0, more: false, bars: [bar(0), bar(1)] }]);
    const result = await getHistory({ from: 0, to: 0, include_bars: true, _deps: deps });
    assert.deepEqual(result.bars.map(item => item.time), [0]);
    assert.equal(result.requested_to, 0);
    assert.equal(result.complete, true);
  });

  it('keeps the actual last bar when the requested end has no trading data', async () => {
    const { deps } = historyDeps([{ first_time: 100, more: false, bars: [bar(100), bar(200)] }]);
    const result = await getHistory({ from: 100, to: 250, _deps: deps });
    assert.equal(result.period.to, 200);
    assert.equal(result.requested_to, 250);
    assert.equal(result.bar_count, 2);
    assert.equal(result.bars, undefined);
    assert.equal(result.complete, true);
  });

  it('uses the range error only when an upper bound was requested', async () => {
    for (const [options, message] of [
      [{ from: 200, to: 250 }, /No historical bars matched the requested date range/],
      [{ from: 600 }, /No historical bars matched the requested start time/],
    ]) {
      const { deps, setChartCalls } = historyDeps([{ first_time: 300, more: false, bars: [bar(300), bar(400)] }]);
      await assert.rejects(getHistory({ ...options, symbol: 'NYSE:IBM', _deps: deps }), message);
      assert.deepEqual(setChartCalls, [
        { symbol: 'NYSE:IBM', timeframe: null },
        { symbol: 'NASDAQ:AAPL', timeframe: null },
      ]);
    }
  });

  it('treats a date-only upper bound as UTC midnight rather than the whole day', async () => {
    const times = ['2026-06-29T12:00:00Z', '2026-06-30T00:00:00Z', '2026-06-30T12:00:00Z']
      .map(value => Date.parse(value) / 1000);
    const { deps } = historyDeps([{ first_time: times[0], more: false, bars: times.map(bar) }]);
    const result = await getHistory({ from: '2026-06-29', to: '2026-06-30', include_bars: true, _deps: deps });
    assert.deepEqual(result.bars.map(item => item.time), times.slice(0, 2));
    assert.equal(result.period.to_iso, '2026-06-30T00:00:00.000Z');
  });

  it('reports source exhaustion even when available history does not reach from', async () => {
    const { deps } = historyDeps([
      { first_time: 500, more: true, bars: [bar(500), bar(600)] },
      { first_time: 300, more: false, bars: [bar(300), bar(400)] },
    ]);
    const result = await getHistory({ from: 100, to: 400, include_bars: true, _deps: deps });
    assert.deepEqual(result.bars.map(item => item.time), [300, 400]);
    assert.equal(result.period.from, 300);
    assert.equal(result.requested_from, 100);
    assert.equal(result.stop_reason, 'no_more_data');
    assert.equal(result.complete, true);
  });

  it('enforces the request limit both before and after finding matching bars', async () => {
    for (const nextTime of [300, 500]) {
      const { deps } = historyDeps([
        { first_time: 700, more: true, bars: [bar(700), bar(800)] },
        { first_time: nextTime, more: true, bars: [bar(nextTime), bar(nextTime + 100)] },
        { first_time: 100, more: false, bars: [bar(100), bar(200)] },
      ]);
      let requests = 0;
      const pending = getHistory({ from: 100, to: 400, max_requests: 1, include_bars: true, _deps: {
        ...deps, requestMore: async count => { requests += 1; await deps.requestMore(count); },
      } });
      if (nextTime === 300) {
        const result = await pending;
        assert.equal(result.stop_reason, 'max_requests');
        assert.equal(result.complete, false);
        assert.equal(result.requests_made, 1);
        assert.deepEqual(result.bars.map(item => item.time), [300, 400]);
      } else {
        await assert.rejects(pending, /No historical bars matched the requested date range/);
      }
      assert.equal(requests, 1);
    }
  });

  it('stops at the exact matching bar limit when from has not been reached', async () => {
    const { deps } = historyDeps([{ first_time: 300, more: true, bars: [300, 400, 500, 600].map(bar) }]);
    const result = await getHistory({ from: 100, to: 400, max_bars: 2, include_bars: true, _deps: {
      ...deps, requestMore: async () => assert.fail('Bar limit must stop before another request'),
    } });
    assert.equal(result.stop_reason, 'max_bars');
    assert.equal(result.complete, false);
    assert.equal(result.requests_made, 0);
    assert.deepEqual(result.bars.map(item => item.time), [300, 400]);
  });

  it('returns only matching partial bars when a later snapshot is unreadable', async () => {
    for (const unreadable of [null, { more: true, bars: [] }]) {
      const { deps, setChartCalls } = historyDeps([
        { first_time: 300, more: true, bars: [bar(300), bar(400), bar(500)] },
        unreadable,
      ]);
      const result = await getHistory({ symbol: 'NYSE:IBM', from: 100, to: 400, include_bars: true, _deps: deps });
      assert.equal(result.stop_reason, 'read_failed');
      assert.equal(result.complete, false);
      assert.equal(result.requests_made, 1);
      assert.deepEqual(result.bars.map(item => item.time), [300, 400]);
      assert.equal(setChartCalls.at(-1).symbol, 'NASDAQ:AAPL');
    }
  });

  it('reports no progress for a stalled source even if all its bars are filtered out', async () => {
    for (const hasMatches of [true, false]) {
      const initialTime = hasMatches ? 300 : 500;
      const { deps } = historyDeps([
        { first_time: initialTime, more: true, bars: [bar(initialTime), bar(600)] },
        { first_time: initialTime, more: true, bars: [] },
      ]);
      let requests = 0;
      const pending = getHistory({ from: 100, to: 400, max_requests: 3, include_bars: true, _deps: {
        ...deps, requestMore: async count => { requests += 1; await deps.requestMore(count); },
      } });
      if (hasMatches) {
        const result = await pending;
        assert.equal(result.stop_reason, 'no_progress');
        assert.equal(result.complete, false);
        assert.deepEqual(result.bars.map(item => item.time), [300]);
      } else {
        await assert.rejects(pending, /No historical bars matched the requested date range/);
      }
      assert.equal(requests, 1);
    }
  });

  it('rejects an unreadable initial source and restores the chart for a bounded request', async () => {
    for (const initial of [null, { first_time: null, more: false, bars: [] }]) {
      const { deps, setChartCalls } = historyDeps([initial]);
      await assert.rejects(getHistory({ symbol: 'NYSE:IBM', from: 100, to: 400, _deps: deps }),
        /Could not read historical bars/);
      assert.equal(setChartCalls.at(-1).symbol, 'NASDAQ:AAPL');
    }
  });

  it('propagates runtime exceptions and restores the chart without writing output', async () => {
    for (const failureStage of ['initial_read', 'request', 'poll_read']) {
      const failure = new Error(`Runtime failed during ${failureStage}`);
      const { deps, setChartCalls } = historyDeps([
        { first_time: 300, more: true, bars: [bar(300), bar(400), bar(500)] },
      ]);
      let reads = 0;
      let writes = 0;
      await assert.rejects(runHistoryCommand({
        symbol: 'NYSE:IBM', timeframe: 'W', from: '100', to: '400', output: 'unused.json',
      }, {
        withContext: async (_opts, operation) => operation(),
        getHistory: options => getHistory({ ...options, _deps: {
          ...deps,
          readSnapshot: async () => {
            reads += 1;
            if (failureStage === 'initial_read' || (failureStage === 'poll_read' && reads > 1)) throw failure;
            return deps.readSnapshot();
          },
          requestMore: async () => { if (failureStage === 'request') throw failure; },
        } }),
        writeOutput: () => { writes += 1; },
      }), error => error === failure);
      assert.equal(writes, 0);
      assert.deepEqual(setChartCalls, [
        { symbol: 'NYSE:IBM', timeframe: 'W' },
        { symbol: 'NASDAQ:AAPL', timeframe: 'D' },
      ]);
    }
  });

  it('leaves the requested chart in place with no-restore on success and failure', async () => {
    for (const fails of [false, true]) {
      const { deps, setChartCalls } = historyDeps([
        { first_time: 100, more: false, bars: [bar(100), bar(200), bar(500)] },
      ]);
      const failure = new Error('Snapshot failed');
      const pending = runHistoryCommand({
        symbol: 'NYSE:IBM', timeframe: 'W', from: '100', to: '400', 'no-restore': true,
      }, {
        withContext: async (_opts, operation) => operation(),
        getHistory: options => getHistory({ ...options, _deps: {
          ...deps, readSnapshot: async () => { if (fails) throw failure; return deps.readSnapshot(); },
        } }),
      });
      if (fails) await assert.rejects(pending, error => error === failure);
      else assert.equal((await pending).period.to, 200);
      assert.deepEqual(setChartCalls, [{ symbol: 'NYSE:IBM', timeframe: 'W' }]);
    }
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
  it('writes actual bounded JSON and requires force to replace an existing file', async t => {
    const directory = mkdtempSync(join(tmpdir(), 'tv-history-range-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const output = join(directory, 'history.json');
    const { deps, setChartCalls } = historyDeps([
      { first_time: 100, more: false, bars: [100, 200, 300, 400, 500].map(bar) },
    ]);
    const options = { symbol: 'NYSE:IBM', from: '200', to: '400', 'include-bars': true, output };
    const dependencies = {
      withContext: async (_opts, operation) => ({ ...await operation(), context: { pane_id: 'file-pane' } }),
      getHistory: args => getHistory({ ...args, _deps: deps }),
    };
    const summary = await runHistoryCommand(options, dependencies);
    const original = readFileSync(output, 'utf8');
    const saved = JSON.parse(original);
    assert.deepEqual(saved.bars.map(item => item.time), [200, 300, 400]);
    const { bars, ...metadata } = saved;
    assert.deepEqual(summary, { ...metadata, output, output_includes_bars: true });
    assert.equal(bars.length, saved.bar_count);
    assert.equal(saved.period.to, saved.requested_to);
    assert.equal(saved.context.pane_id, 'file-pane');

    await assert.rejects(runHistoryCommand(options, dependencies), { code: 'EEXIST' });
    assert.equal(readFileSync(output, 'utf8'), original);
    const replacement = await runHistoryCommand({ ...options, to: '300', force: true }, dependencies);
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')).bars.map(item => item.time), [200, 300]);
    assert.equal(replacement.bar_count, 2);
    assert.equal(replacement.requested_to, 300);
    assert.equal(setChartCalls.length, 6);
    assert.equal(setChartCalls.at(-1).symbol, 'NASDAQ:AAPL');
  });

  it('validates before preparing context and writes the bounded result after chart restoration', async () => {
    const events = [];
    const options = {
      symbol: 'NYSE:IBM', timeframe: 'W', from: '200', to: '400',
      'bars-per-request': '100', 'max-requests': '3', 'max-bars': '2',
      'include-bars': true, output: 'history.json', force: true,
    };
    const { deps } = historyDeps([{ first_time: 100, more: false, bars: [100, 200, 300, 400, 500].map(bar) }]);
    const result = await runHistoryCommand(options, {
      normalizeRange: range => {
        events.push('validate');
        assert.deepEqual(range, { from: '200', to: '400' });
        return normalizeHistoryRange(range);
      },
      withContext: async (opts, operation) => {
        events.push('context');
        assert.equal(opts, options);
        return { ...await operation(), context: { pane_id: 'test-pane' } };
      },
      getHistory: async opts => {
        events.push('history');
        assert.deepEqual(opts, {
          symbol: 'NYSE:IBM', timeframe: 'W', from: '200', to: '400',
          bars_per_request: 100, max_requests: 3, max_bars: 2,
          include_bars: true, restore_chart: true,
        });
        return getHistory({ ...opts, _deps: {
          ...deps,
          setChart: async change => { events.push(change.symbol === 'NASDAQ:AAPL' ? 'restore' : 'switch'); },
        } });
      },
      writeOutput: (data, output, settings) => {
        events.push('output');
        assert.equal(output, 'history.json');
        assert.deepEqual(settings, { force: true });
        return writeHistoryOutput(data, output, {
          ...settings, resolvePath: path => path,
          writeFile: (_path, content) => {
            const saved = JSON.parse(content);
            assert.deepEqual(saved.bars.map(item => item.time), [300, 400]);
            assert.equal(saved.period.to, 400);
            assert.equal(saved.requested_to, 400);
            assert.equal(saved.bar_count, 2);
            assert.equal(saved.context.pane_id, 'test-pane');
          },
        });
      },
    });
    assert.deepEqual(events, ['validate', 'context', 'history', 'switch', 'restore', 'output']);
    assert.equal(result.requested_to, 400);
    assert.equal(result.bar_count, 2);
    assert.equal(result.output_includes_bars, true);
    assert.equal('bars' in result, false);
  });

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
