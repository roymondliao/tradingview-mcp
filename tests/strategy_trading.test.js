import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getStrategyTradingReport } from '../src/core/strategy-trading.js';
import { CoreOperationError } from '../src/core/errors.js';

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

const identity = Object.freeze({
  report_index: 0,
  entry: { time: 1704067200000, bar_index: 10, type: 'le', price: 100 },
  exit_or_mark: { time: 1704499200000, bar_index: 15, type: 'lx', price: 110 },
  quantity: 1,
});

function reportProjection() {
  return {
    currency: 'TWD',
    firstTradeIndex: 0,
    trade_count: 2,
    settings: {
      dateRange: {
        backtest: { from: 1609459200000, to: 1706745600000 },
        trade: { from: 1704067200000, to: 1706745600000 },
      },
    },
    performance: {
      all: {
        netProfit: 10,
        percentProfitable: 0.5,
        totalTrades: 2,
        totalOpenTrades: 0,
        numberOfWiningTrades: 1,
        numberOfLosingTrades: 1,
      },
    },
    calculation_mode: { available: false, value: 'unknown' },
    first_trade_identity: identity,
    last_trade_identity: { ...identity, report_index: 1 },
  };
}

function snapshotCandidate() {
  const report = reportProjection();
  return {
    schema_version: 1,
    context: { target_id: 'target-1', layout_id: 101, pane_id: '1' },
    entity_id: 'strategy-2',
    requested_symbol: 'TWSE:2344',
    resolved_symbol: 'TWSE_DLY:2344',
    timeframe: '1D',
    inputs_fingerprint: { available: true, algorithm: 'sha256', value: 'inputs-hash' },
    calculation_mode: report.calculation_mode,
    date_range: report.settings.dateRange,
    currency: 'TWD',
    first_trade_index: 0,
    trade_count: 2,
    closed_trades: 2,
    open_trades: 0,
    metrics: {
      total_net_profit: 10,
      win_rate_percent: 50,
      total_trades: 2,
      winning_trades: 1,
      losing_trades: 1,
    },
    first_trade_identity: identity,
    last_trade_identity: { ...identity, report_index: 1 },
  };
}

function harness(overrides = {}) {
  const calls = { inspected: [], prepared: [], waited: [], restored: [] };
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
  const observation = {
    success: true,
    fresh: true,
    transition_observed: true,
    stable_reads: 3,
    symbol: 'TWSE_DLY:2344',
    timeframe: '1D',
    report_available: true,
    report: reportProjection(),
    snapshot_candidate: snapshotCandidate(),
    runtime_signature: 'after',
  };
  const deps = {
    withChartSession: async (args, operation) => operation({ context: args.context }),
    inspectStrategySource: async (args) => {
      calls.inspected.push(args.entity_id);
      return {
        success: true,
        strategy: { entity_id: args.entity_id, name: 'Requested', type: 'strategy' },
      };
    },
    ensureStrategyActive: async () => ({ success: true }),
    readRawReportState: async () => ({ runtime_signature: 'before' }),
    prepareSymbolSession: async (args) => { calls.prepared.push(args); return session; },
    waitForFreshTradingReport: async (args) => { calls.waited.push(args); return observation; },
    restoreSymbolSession: async (value) => {
      calls.restored.push(value);
      return { success: true, restored: true, symbol: 'NASDAQ:AAPL', timeframe: '1D' };
    },
    ...overrides,
  };
  return { calls, deps, session, observation };
}

describe('Strategy Trading Report application service', () => {
  it('reads only the requested Strategy and returns a fresh canonical snapshot', async () => {
    const { calls, deps } = harness();
    const result = await getStrategyTradingReport({
      entity_id: 'strategy-2',
      symbol: 'TWSE:2344',
      context,
      timeout_ms: 1000,
      _deps: deps,
    });
    assert.deepEqual(calls.inspected, ['strategy-2']);
    assert.equal(calls.prepared[0].entity_id, 'strategy-2');
    assert.equal(calls.waited[0].mutated, true);
    assert.equal(result.strategy.entity_id, 'strategy-2');
    assert.equal(result.requested_symbol, 'TWSE:2344');
    assert.equal(result.resolved_symbol, 'TWSE_DLY:2344');
    assert.equal(result.metrics.percent_profitable, 50);
    assert.deepEqual(result.reconciliation_metrics, {
      total_net_profit: 10,
      win_rate_percent: 50,
      total_trades: 2,
      winning_trades: 1,
      losing_trades: 1,
    });
    assert.match(result.snapshot_id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.chart_restore.restored, true);
    assert.equal(calls.restored.length, 1);
  });

  it('uses the current timeframe and stable same-Symbol semantics when no mutation occurs', async () => {
    const sameSession = Object.freeze({
      context,
      entity_id: 'strategy-2',
      original_symbol: 'TWSE_DLY:2344',
      original_timeframe: '1D',
      requested_symbol: 'TWSE:2344',
      resolved_symbol: 'TWSE_DLY:2344',
      symbol: 'TWSE:2344',
      timeframe: '1D',
      symbol_changed: false,
      timeframe_changed: false,
    });
    const { calls, deps } = harness({ prepareSymbolSession: async () => sameSession });
    await getStrategyTradingReport({
      entity_id: 'strategy-2', symbol: 'TWSE:2344', context, _deps: deps,
    });
    assert.equal(calls.waited[0].mutated, false);
  });

  it('rejects wrong entities before Symbol mutation', async () => {
    let prepared = false;
    const { deps } = harness({
      inspectStrategySource: async () => {
        throw new CoreOperationError('missing', { code: 'STRATEGY_NOT_FOUND_IN_PANE' });
      },
      prepareSymbolSession: async () => { prepared = true; },
    });
    await assert.rejects(
      getStrategyTradingReport({
        entity_id: 'missing', symbol: 'TWSE:2344', context, _deps: deps,
      }),
      (error) => error.code === 'STRATEGY_NOT_FOUND_IN_PANE',
    );
    assert.equal(prepared, false);
  });

  it('restores the Chart after calculation failure', async () => {
    const { calls, deps } = harness({
      waitForFreshTradingReport: async () => {
        throw new CoreOperationError('timeout', { code: 'STRATEGY_CALCULATION_TIMEOUT' });
      },
    });
    await assert.rejects(
      getStrategyTradingReport({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, _deps: deps,
      }),
      (error) => error.code === 'STRATEGY_CALCULATION_TIMEOUT',
    );
    assert.equal(calls.restored.length, 1);
  });

  it('requires a complete public snapshot and restores before failing', async () => {
    const { calls, observation, deps } = harness({
      waitForFreshTradingReport: async () => ({
        ...observation,
        snapshot_candidate: { ...snapshotCandidate(), inputs_fingerprint: { available: false, value: null } },
      }),
    });
    await assert.rejects(
      getStrategyTradingReport({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, _deps: deps,
      }),
      (error) => error.code === 'STRATEGY_SNAPSHOT_UNAVAILABLE'
        && error.phase === 'snapshot_validation',
    );
    assert.equal(calls.restored.length, 1);
  });

  it('validates entity, Symbol, and resolved context before opening a Chart Session', async () => {
    let sessions = 0;
    const deps = { withChartSession: async () => { sessions += 1; } };
    await assert.rejects(
      getStrategyTradingReport({ symbol: 'TWSE:2344', context, _deps: deps }),
      (error) => error.code === 'STRATEGY_ENTITY_REQUIRED',
    );
    await assert.rejects(
      getStrategyTradingReport({ entity_id: 'strategy-1', context, _deps: deps }),
      (error) => error.code === 'SYMBOL_REQUIRED',
    );
    await assert.rejects(
      getStrategyTradingReport({ entity_id: 'strategy-1', symbol: '2344', context, _deps: deps }),
      (error) => error.code === 'SYMBOL_INVALID',
    );
    assert.equal(sessions, 0);
  });
});
