import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoreOperationError } from '../src/core/errors.js';
import { exportStrategySymbol } from '../src/core/strategy-trading.js';

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
  const directory = mkdtempSync(join(tmpdir(), 'tv-strategy-export-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function rawTrades() {
  return [
    {
      e: { b: 10, c: 'Long', p: 100, tm: 1704067200000, tp: 'le' },
      x: { b: 15, c: 'Exit', p: 110, tm: 1704499200000, tp: 'lx' },
      q: 1, v: 100, tp: { v: 9, p: 0.09 }, cm: 1,
      rn: { v: 12, p: 0.12 }, dd: { v: 2, p: 0.02 }, cp: { v: 9, p: 0.09 },
    },
    {
      e: { b: 20, c: 'Long', p: 120, tm: 1704931200000, tp: 'le' },
      x: { b: 24, c: 'Stop', p: 110, tm: 1705276800000, tp: 'lx' },
      q: 1, v: 120, tp: { v: -11, p: -0.0916666667 }, cm: 1,
      rn: { v: 3, p: 0.025 }, dd: { v: 12, p: 0.1 }, cp: { v: -2, p: -0.0066666667 },
    },
  ];
}

function identity(reportIndex, trade) {
  return {
    report_index: reportIndex,
    entry: {
      time: trade.e.tm, bar_index: trade.e.b, type: trade.e.tp, price: trade.e.p,
    },
    exit_or_mark: {
      time: trade.x.tm, bar_index: trade.x.b, type: trade.x.tp, price: trade.x.p,
    },
    quantity: trade.q,
  };
}

function reportState(trades = rawTrades(), metricOverrides = {}) {
  const total = trades.length;
  const profits = trades.map((trade) => trade.tp.v);
  const winning = profits.filter((value) => value > 0).length;
  const losing = profits.filter((value) => value < 0).length;
  const netProfit = profits.reduce((sum, value) => sum + value, 0);
  const metrics = {
    total_net_profit: netProfit,
    win_rate_percent: total === 0 ? 0 : (winning * 100) / total,
    total_trades: total,
    winning_trades: winning,
    losing_trades: losing,
    ...metricOverrides,
  };
  const calculationMode = { available: false, value: 'unknown' };
  const dateRange = {
    backtest: { from: 1609459200000, to: 1706745600000 },
    trade: { from: 1704067200000, to: 1706745600000 },
  };
  const report = {
    currency: 'TWD',
    firstTradeIndex: 0,
    trade_count: total,
    settings: { dateRange },
    performance: {
      all: {
        netProfit: metrics.total_net_profit,
        percentProfitable: metrics.win_rate_percent / 100,
        totalTrades: metrics.total_trades,
        totalOpenTrades: 0,
        numberOfWiningTrades: metrics.winning_trades,
        numberOfLosingTrades: metrics.losing_trades,
      },
    },
    calculation_mode: calculationMode,
    first_trade_identity: total ? identity(0, trades[0]) : null,
    last_trade_identity: total ? identity(total - 1, trades.at(-1)) : null,
  };
  const candidate = {
    schema_version: 1,
    context: { target_id: 'target-1', layout_id: 101, pane_id: '1' },
    entity_id: 'strategy-2',
    requested_symbol: 'TWSE:2344',
    resolved_symbol: 'TWSE_DLY:2344',
    timeframe: '1D',
    inputs_fingerprint: { available: true, algorithm: 'sha256', value: 'inputs-hash' },
    calculation_mode: calculationMode,
    date_range: dateRange,
    currency: 'TWD',
    first_trade_index: 0,
    trade_count: total,
    closed_trades: total,
    open_trades: 0,
    metrics,
    first_trade_identity: report.first_trade_identity,
    last_trade_identity: report.last_trade_identity,
  };
  return { report, candidate };
}

function observation(state) {
  return {
    success: true,
    fresh: true,
    transition_observed: true,
    stable_reads: 3,
    symbol: 'TWSE_DLY:2344',
    timeframe: '1D',
    status_type: 2,
    report_available: true,
    report: state.report,
    snapshot_candidate: state.candidate,
    runtime_signature: 'stable',
  };
}

function rawBatch({ offset, limit }, state, trades, overrides = {}) {
  const items = trades.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  return {
    success: true,
    status_type: 2,
    total: trades.length,
    offset,
    limit,
    returned: items.length,
    next_offset: nextOffset < trades.length ? nextOffset : null,
    has_more: nextOffset < trades.length,
    items,
    snapshot_before: state.candidate,
    snapshot_after: state.candidate,
    snapshot_changed: false,
    ...overrides,
  };
}

function harness({ trades = rawTrades(), state = reportState(trades), overrides = {} } = {}) {
  const calls = { sessions: 0, batches: [], restored: 0 };
  const session = Object.freeze({
    context,
    entity_id: 'strategy-2',
    original_symbol: 'NASDAQ:AAPL',
    original_timeframe: '1D',
    requested_symbol: 'TWSE:2344',
    resolved_symbol: 'TWSE_DLY:2344',
    symbol: 'TWSE:2344',
    timeframe: '1D',
    symbol_changed: true,
    timeframe_changed: false,
  });
  const currentObservation = observation(state);
  let clock = 1760000000000;
  const deps = {
    now: () => clock++,
    withChartSession: async (_args, operation) => {
      calls.sessions += 1;
      return operation({ context });
    },
    inspectStrategySource: async () => ({
      success: true,
      strategy: { entity_id: 'strategy-2', name: 'Requested', type: 'strategy' },
    }),
    ensureStrategyActive: async () => ({ success: true }),
    readRawReportState: async () => ({ runtime_signature: 'before' }),
    prepareSymbolSession: async () => session,
    waitForFreshTradingReport: async () => currentObservation,
    readRawTradingDataBatch: async (args) => {
      calls.batches.push(args.offset);
      return rawBatch(args, state, trades);
    },
    readRawTradingReport: async () => currentObservation,
    restoreSymbolSession: async () => {
      calls.restored += 1;
      return { success: true, restored: true, symbol: 'NASDAQ:AAPL', timeframe: '1D' };
    },
    ...overrides,
  };
  return { calls, deps, state, trades, observation: currentObservation };
}

async function runExport(directory, harnessResult, options = {}) {
  return exportStrategySymbol({
    entity_id: 'strategy-2',
    symbol: 'TWSE:2344',
    context,
    output_directory: directory,
    run_id: options.run_id || 'test-run',
    format: options.format || 'json',
    batch_limit: options.batch_limit,
    _deps: harnessResult.deps,
  });
}

function assertNoRunArtifacts(directory) {
  assert.deepEqual(readdirSync(directory), []);
}

describe('Single-Symbol Strategy Trading export', () => {
  it('streams multiple batches, restores once, reconciles, and atomically publishes one run', async () => {
    const directory = temporaryDirectory();
    const runtime = harness();
    const result = await runExport(directory, runtime, { batch_limit: 1 });
    assert.equal(runtime.calls.sessions, 1);
    assert.deepEqual(runtime.calls.batches, [0, 1]);
    assert.equal(runtime.calls.restored, 1);
    assert.equal(result.reconciliation.success, true);
    assert.equal(result.total_trades, 2);
    assert.equal(result.batch_count, 2);
    assert.equal('trades' in result, false);

    const runDirectory = join(directory, 'test-run');
    const symbolDirectory = join(runDirectory, 'symbols', 'TWSE_u3A_2344');
    const manifest = JSON.parse(readFileSync(join(runDirectory, 'manifest.json'), 'utf8'));
    const report = JSON.parse(readFileSync(join(symbolDirectory, 'report.json'), 'utf8'));
    const tradingData = JSON.parse(readFileSync(join(symbolDirectory, 'trades.json'), 'utf8'));
    const reconciliation = JSON.parse(readFileSync(
      join(symbolDirectory, 'reconciliation.json'), 'utf8',
    ));
    assert.equal(manifest.status, 'succeeded');
    assert.equal(manifest.chart_restore.restored, true);
    assert.equal(report.snapshot_id, result.snapshot_id);
    assert.equal(tradingData.snapshot_id, result.snapshot_id);
    assert.equal(tradingData.complete, true);
    assert.equal(tradingData.trades.length, 2);
    assert.equal(tradingData.trades[0].report_index, 0);
    assert.equal(reconciliation.snapshot_id, result.snapshot_id);
    assert.equal(reconciliation.reconciliation.success, true);
  });

  it('publishes a complete zero-Trade export', async () => {
    const directory = temporaryDirectory();
    const runtime = harness({ trades: [] });
    const result = await runExport(directory, runtime);
    const tradingData = JSON.parse(readFileSync(result.artifacts.trades.path, 'utf8'));
    assert.equal(result.total_trades, 0);
    assert.equal(result.batch_count, 1);
    assert.deepEqual(tradingData.trades, []);
    assert.equal(tradingData.complete, true);
  });

  it('produces equivalent reconciliation for JSON, JSONL, and CSV', async () => {
    const metrics = [];
    for (const format of ['json', 'jsonl', 'csv']) {
      const directory = temporaryDirectory();
      const runtime = harness();
      const result = await runExport(directory, runtime, { format, run_id: `run-${format}` });
      const reconciliation = JSON.parse(readFileSync(result.artifacts.reconciliation.path, 'utf8'));
      metrics.push(reconciliation.trading_data_metrics);
      assert.ok(readFileSync(result.artifacts.trades.path, 'utf8').length > 0);
    }
    assert.deepEqual(metrics[1], metrics[0]);
    assert.deepEqual(metrics[2], metrics[0]);
  });

  it('aborts publication when Report B has a different snapshot', async () => {
    const directory = temporaryDirectory();
    const stable = reportState();
    const changed = reportState(rawTrades(), { total_net_profit: -1 });
    const runtime = harness({
      state: stable,
      overrides: { readRawTradingReport: async () => observation(changed) },
    });
    await assert.rejects(
      runExport(directory, runtime),
      (error) => error.code === 'STALE_STRATEGY_SNAPSHOT'
        && error.phase === 'trading_export_report_b_snapshot',
    );
    assert.equal(runtime.calls.restored, 1);
    assertNoRunArtifacts(directory);
  });

  it('aborts publication on a mid-batch snapshot change', async () => {
    const directory = temporaryDirectory();
    const stable = reportState();
    const changed = reportState(rawTrades(), { total_net_profit: -1 });
    const runtime = harness({ state: stable });
    runtime.deps.readRawTradingDataBatch = async (args) => {
      runtime.calls.batches.push(args.offset);
      return rawBatch(args, stable, runtime.trades, args.offset === 1
        ? { snapshot_after: changed.candidate }
        : {});
    };
    await assert.rejects(
      runExport(directory, runtime, { batch_limit: 1 }),
      (error) => error.code === 'STALE_STRATEGY_SNAPSHOT',
    );
    assertNoRunArtifacts(directory);
  });

  it('aborts publication when the five metrics do not reconcile', async () => {
    const directory = temporaryDirectory();
    const mismatched = reportState(rawTrades(), { total_net_profit: 10 });
    const runtime = harness({ state: mismatched });
    await assert.rejects(
      runExport(directory, runtime),
      (error) => error.code === 'RECONCILIATION_MISMATCH'
        && error.phase === 'trading_export_reconciliation',
    );
    assertNoRunArtifacts(directory);
  });

  it('cleans staging after encoder or Chart restore failure', async () => {
    const encoderDirectory = temporaryDirectory();
    const encoderRuntime = harness({
      overrides: {
        createTradingDataEncoder: () => ({
          start: async () => {},
          writeBatch: async () => { throw new Error('disk full'); },
          finish: async () => {},
          abort: async () => {},
        }),
      },
    });
    await assert.rejects(
      runExport(encoderDirectory, encoderRuntime),
      (error) => error.code === 'OUTPUT_WRITE_FAILED' && error.phase === 'artifact_write',
    );
    assertNoRunArtifacts(encoderDirectory);

    const restoreDirectory = temporaryDirectory();
    const restoreRuntime = harness({
      overrides: {
        restoreSymbolSession: async () => {
          throw new CoreOperationError('restore failed', {
            code: 'CHART_RESTORE_FAILED', phase: 'chart_restore',
          });
        },
      },
    });
    await assert.rejects(
      runExport(restoreDirectory, restoreRuntime),
      (error) => error.code === 'CHART_RESTORE_FAILED',
    );
    assertNoRunArtifacts(restoreDirectory);
  });
});
