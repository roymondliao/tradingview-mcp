import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreOperationError } from '../src/core/errors.js';
import { safeSymbolPathSegment } from '../src/core/artifacts.js';
import { exportStrategyWatchlist } from '../src/core/strategy-trading.js';

const temporaryDirectories = [];
const context = Object.freeze({
  tab_index: 0,
  target_id: 'target-1',
  url_chart_id: 'chart-1',
  layout_id: 101,
  pane_layout: 's',
  pane_index: 0,
  pane_id: '1',
  symbol: 'NASDAQ:AAPL',
  resolution: '1D',
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-strategy-watchlist-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runtime({ symbols, fail = new Map(), mutateSource, fingerprintFor } = {}) {
  const calls = { capture: 0, exports: [], sessions: 0, restores: 0 };
  const source = {
    success: true,
    list_id: 'watchlist-1',
    list_name: 'Active',
    symbols: symbols.map((symbol) => ({ symbol })),
  };
  let clock = 1760000000000;
  const deps = {
    now: () => clock++,
    getWatchlist: async () => { calls.capture += 1; return source; },
    withChartSession: async (_options, operation) => {
      calls.sessions += 1;
      return operation({
        context,
        original_symbol: context.symbol,
        original_timeframe: context.resolution,
      });
    },
    restoreSymbolSession: async (session) => {
      calls.restores += 1;
      assert.equal(session.original_symbol, context.symbol);
      return {
        success: true, restored: true,
        symbol: context.symbol, timeframe: context.resolution,
      };
    },
    exportStrategySymbol: async (options) => {
      const { symbol, _run: { transaction } } = options;
      calls.exports.push(symbol);
      const session = Object.freeze({
        context: options.context,
        entity_id: options.entity_id,
        original_symbol: options.context.symbol,
        original_timeframe: options.context.resolution,
        requested_symbol: symbol,
        resolved_symbol: symbol,
        symbol,
        timeframe: options.timeframe || '1D',
        symbol_changed: true,
        timeframe_changed: false,
      });
      await options._deps.onSymbolSession(session);
      const directory = `symbols/${safeSymbolPathSegment(symbol)}`;
      if (fail.has(symbol)) {
        await transaction.writeJson(`${directory}/partial.json`, { symbol });
        throw fail.get(symbol);
      }
      await transaction.writeJson(`${directory}/report.json`, { success: true, symbol });
      await transaction.writeJson(`${directory}/trades.json`, { success: true, trades: [] });
      await transaction.writeJson(`${directory}/reconciliation.json`, { success: true });
      const [report, trades, reconciliation] = await Promise.all([
        transaction.artifactInfo(`${directory}/report.json`),
        transaction.artifactInfo(`${directory}/trades.json`),
        transaction.artifactInfo(`${directory}/reconciliation.json`),
      ]);
      if (calls.exports.length === 1 && mutateSource) mutateSource(source);
      return {
        success: true,
        symbol_session: session,
        context: options.context,
        strategy: { entity_id: options.entity_id, name: 'Strategy', type: 'strategy' },
        requested_symbol: symbol,
        resolved_symbol: symbol,
        symbol,
        timeframe: session.timeframe,
        inputs_fingerprint: {
          available: true,
          algorithm: 'sha256',
          value: fingerprintFor ? fingerprintFor(symbol) : 'inputs-1',
        },
        snapshot_id: `snapshot-${symbol}`,
        snapshot_schema_version: 1,
        report_schema_version: 1,
        trading_data_schema_version: 1,
        total_trades: 0,
        batch_count: 1,
        artifacts: { report, trades, reconciliation },
      };
    },
  };
  return { calls, deps, source };
}

async function runExport(directory, currentRuntime, options = {}) {
  return exportStrategyWatchlist({
    entity_id: 'strategy-2',
    watchlist: 'active',
    context,
    output_directory: directory,
    run_id: options.run_id || 'watchlist-run',
    fail_fast: options.fail_fast,
    _deps: currentRuntime.deps,
  });
}

describe('Active Watchlist Strategy Trading export', () => {
  it('captures once, keeps order, ignores later UI mutation, and skips duplicate entries', async () => {
    const directory = temporaryDirectory();
    const currentRuntime = runtime({
      symbols: ['TWSE:2330', 'NASDAQ:AAPL', 'TWSE:2330'],
      mutateSource: (source) => { source.symbols.push({ symbol: 'TPEX:6488' }); },
    });
    const result = await runExport(directory, currentRuntime);
    assert.equal(currentRuntime.calls.capture, 1);
    assert.equal(currentRuntime.calls.sessions, 1);
    assert.equal(currentRuntime.calls.restores, 1);
    assert.deepEqual(currentRuntime.calls.exports, ['TWSE:2330', 'NASDAQ:AAPL']);
    assert.deepEqual(result.summary, { requested: 3, succeeded: 2, failed: 0, skipped: 1 });
    assert.equal(result.success, true);
    assert.equal(result.symbols[2].reason, 'duplicate_symbol');
    assert.deepEqual(result.watchlist.symbols.map((entry) => entry.symbol), [
      'TWSE:2330', 'NASDAQ:AAPL', 'TWSE:2330',
    ]);
  });

  it('continues after a Symbol failure, removes partial files, and publishes a partial manifest', async () => {
    const directory = temporaryDirectory();
    const failure = new CoreOperationError('Pane changed', {
      code: 'PANE_CONTEXT_CHANGED', phase: 'trading_export_report_b',
    });
    const currentRuntime = runtime({
      symbols: ['TWSE:2330', 'TWSE:2344', 'TPEX:6488'],
      fail: new Map([['TWSE:2344', failure]]),
    });
    const result = await runExport(directory, currentRuntime);
    assert.equal(result.success, false);
    assert.equal(result.status, 'partial');
    assert.deepEqual(currentRuntime.calls.exports, ['TWSE:2330', 'TWSE:2344', 'TPEX:6488']);
    assert.deepEqual(result.summary, { requested: 3, succeeded: 2, failed: 1, skipped: 0 });
    assert.equal(result.symbols[1].error.code, 'PANE_CONTEXT_CHANGED');
    assert.equal(existsSync(join(
      result.output.path, 'symbols', safeSymbolPathSegment('TWSE:2344'),
    )), false);
    const manifest = JSON.parse(readFileSync(join(result.output.path, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.summary, result.summary);
    assert.equal(manifest.status, 'partial');
  });

  it('supports fail-fast and gives every remaining Symbol a skipped terminal state', async () => {
    const directory = temporaryDirectory();
    const currentRuntime = runtime({
      symbols: ['TWSE:2330', 'TWSE:2344', 'TPEX:6488'],
      fail: new Map([['TWSE:2344', new Error('calculation failed')]]),
    });
    const result = await runExport(directory, currentRuntime, { fail_fast: true });
    assert.deepEqual(currentRuntime.calls.exports, ['TWSE:2330', 'TWSE:2344']);
    assert.deepEqual(result.summary, { requested: 3, succeeded: 1, failed: 1, skipped: 1 });
    assert.equal(result.symbols[2].status, 'skipped');
    assert.equal(result.symbols[2].reason, 'fail_fast');
  });

  it('does not mix Strategy input configurations in one Watchlist run', async () => {
    const directory = temporaryDirectory();
    const currentRuntime = runtime({
      symbols: ['TWSE:2330', 'TWSE:2344'],
      fingerprintFor: (symbol) => (symbol === 'TWSE:2330' ? 'inputs-1' : 'inputs-2'),
    });
    const result = await runExport(directory, currentRuntime);
    assert.equal(result.success, false);
    assert.equal(result.symbols[1].status, 'failed');
    assert.equal(result.symbols[1].error.code, 'STRATEGY_INPUTS_CHANGED');
    assert.equal(existsSync(join(
      result.output.path, 'symbols', safeSymbolPathSegment('TWSE:2344'),
    )), false);
  });

  it('rejects an empty snapshot before opening a Chart or creating a final run', async () => {
    const directory = temporaryDirectory();
    const currentRuntime = runtime({ symbols: [] });
    await assert.rejects(
      runExport(directory, currentRuntime),
      (error) => error.code === 'WATCHLIST_EMPTY',
    );
    assert.equal(currentRuntime.calls.sessions, 0);
    assert.deepEqual(readdirSync(directory), []);
  });

  it('marks a partial CDP failure for CLI exit code 2', async () => {
    const directory = temporaryDirectory();
    const currentRuntime = runtime({
      symbols: ['TWSE:2330'],
      fail: new Map([['TWSE:2330', new CoreOperationError('CDP closed', {
        code: 'CDP_CONNECTION_CLOSED', phase: 'target_attach',
      })]]),
    });
    const result = await runExport(directory, currentRuntime);
    assert.equal(result.success, false);
    assert.equal(result.failure_kind, 'cdp_connection');
  });

  it('does not publish the run when final Chart restoration fails', async () => {
    const directory = temporaryDirectory();
    const currentRuntime = runtime({ symbols: ['TWSE:2330'] });
    currentRuntime.deps.restoreSymbolSession = async () => {
      throw new CoreOperationError('restore failed', {
        code: 'CHART_RESTORE_FAILED', phase: 'chart_restore',
      });
    };
    await assert.rejects(
      runExport(directory, currentRuntime),
      (error) => error.code === 'CHART_RESTORE_FAILED',
    );
    assert.deepEqual(readdirSync(directory), []);
  });
});
