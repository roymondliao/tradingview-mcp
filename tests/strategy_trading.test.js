import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getStrategyTradingData,
  getStrategyTradingReport,
} from '../src/core/strategy-trading.js';
import { createSnapshotIdentity } from '../src/core/strategy-trading-model.js';
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

function runtimeBatch({ offset, limit }, candidate = snapshotCandidate(), trades = rawTrades()) {
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
    snapshot_before: candidate,
    snapshot_after: candidate,
    snapshot_changed: false,
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

describe('Strategy Trading Data pagination application service', () => {
  it('walks first and last batches oldest-first with one stable snapshot ID', async () => {
    const { deps } = harness({
      readRawTradingDataBatch: async (args) => runtimeBatch(args),
    });
    const first = await getStrategyTradingData({
      entity_id: 'strategy-2', symbol: 'TWSE:2344', context,
      offset: 0, limit: 1, _deps: deps,
    });
    assert.equal(first.ordering, 'oldest_first');
    assert.equal(first.total, 2);
    assert.equal(first.returned, 1);
    assert.equal(first.next_offset, 1);
    assert.equal(first.has_more, true);
    assert.equal(first.complete, false);
    assert.equal(first.trades[0].report_index, 0);

    const last = await getStrategyTradingData({
      entity_id: 'strategy-2', symbol: 'TWSE:2344', context,
      offset: first.next_offset, limit: 1, snapshot_id: first.snapshot_id, _deps: deps,
    });
    assert.equal(last.returned, 1);
    assert.equal(last.next_offset, null);
    assert.equal(last.has_more, false);
    assert.equal(last.complete, false);
    assert.equal(last.trades[0].report_index, 1);
    assert.equal(last.snapshot_id, first.snapshot_id);
  });

  it('marks a one-shot full batch complete and includes its schema version', async () => {
    const { deps } = harness({
      readRawTradingDataBatch: async (args) => runtimeBatch(args),
    });
    const result = await getStrategyTradingData({
      entity_id: 'strategy-2', symbol: 'TWSE:2344', context,
      offset: 0, limit: 10, _deps: deps,
    });
    assert.equal(result.schema_version, 1);
    assert.equal(result.total, 2);
    assert.equal(result.returned, 2);
    assert.equal(result.has_more, false);
    assert.equal(result.complete, true);
  });

  it('returns a complete empty batch for an empty full Report', async () => {
    const emptyCandidate = {
      ...snapshotCandidate(),
      trade_count: 0,
      closed_trades: 0,
      open_trades: 0,
      first_trade_identity: null,
      last_trade_identity: null,
      metrics: {
        total_net_profit: 0, win_rate_percent: 0, total_trades: 0,
        winning_trades: 0, losing_trades: 0,
      },
    };
    const { observation, deps } = harness();
    deps.waitForFreshTradingReport = async () => ({
      ...observation, snapshot_candidate: emptyCandidate,
    });
    deps.readRawTradingDataBatch = async (args) => runtimeBatch(args, emptyCandidate, []);
    const result = await getStrategyTradingData({
      entity_id: 'strategy-2', symbol: 'TWSE:2344', context, _deps: deps,
    });
    assert.equal(result.total, 0);
    assert.equal(result.returned, 0);
    assert.equal(result.complete, true);
    assert.deepEqual(result.trades, []);
  });

  it('requires a snapshot ID before opening a Chart Session for offset > 0', async () => {
    let sessions = 0;
    await assert.rejects(
      getStrategyTradingData({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, offset: 1,
        _deps: { withChartSession: async () => { sessions += 1; } },
      }),
      (error) => error.code === 'STALE_STRATEGY_SNAPSHOT'
        && error.phase === 'request_validation',
    );
    assert.equal(sessions, 0);
  });

  it('rejects a caller snapshot mismatch before reading a batch', async () => {
    let batchReads = 0;
    const { calls, deps } = harness({
      readRawTradingDataBatch: async () => { batchReads += 1; },
    });
    await assert.rejects(
      getStrategyTradingData({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context,
        offset: 1, snapshot_id: 'sha256:stale', _deps: deps,
      }),
      (error) => error.code === 'STALE_STRATEGY_SNAPSHOT'
        && error.phase === 'trading_data_snapshot',
    );
    assert.equal(batchReads, 0);
    assert.equal(calls.restored.length, 1);
  });

  it('rejects a snapshot change during the page-context batch read', async () => {
    const changed = {
      ...snapshotCandidate(),
      metrics: { ...snapshotCandidate().metrics, total_net_profit: 11 },
    };
    const { deps } = harness({
      readRawTradingDataBatch: async (args) => ({
        ...runtimeBatch(args), snapshot_after: changed,
      }),
    });
    await assert.rejects(
      getStrategyTradingData({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, _deps: deps,
      }),
      (error) => error.code === 'STALE_STRATEGY_SNAPSHOT'
        && error.phase === 'trading_data_batch_after',
    );
  });

  it('rejects retained tails and count-inconsistent batches as incomplete', async () => {
    const retained = { ...snapshotCandidate(), first_trade_index: 10 };
    const { observation, deps } = harness();
    deps.waitForFreshTradingReport = async () => ({
      ...observation, snapshot_candidate: retained,
    });
    deps.readRawTradingDataBatch = async (args) => runtimeBatch(args, retained);
    await assert.rejects(
      getStrategyTradingData({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, _deps: deps,
      }),
      (error) => error.code === 'TRADING_DATA_INCOMPLETE'
        && error.phase === 'trading_data_completeness',
    );
  });

  it('validates Offset and Limit boundaries without touching the Chart', async () => {
    let sessions = 0;
    const deps = { withChartSession: async () => { sessions += 1; } };
    await assert.rejects(
      getStrategyTradingData({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, offset: -1, _deps: deps,
      }),
      (error) => error.code === 'STRATEGY_RUNTIME_INVALID',
    );
    await assert.rejects(
      getStrategyTradingData({
        entity_id: 'strategy-2', symbol: 'TWSE:2344', context, limit: 5001, _deps: deps,
      }),
      (error) => error.code === 'STRATEGY_RUNTIME_INVALID',
    );
    assert.equal(sessions, 0);
  });

  it('uses the canonical public snapshot generated from the Report candidate', () => {
    const snapshot = createSnapshotIdentity(snapshotCandidate());
    assert.equal(snapshot.available, true);
    assert.match(snapshot.snapshot_id, /^sha256:[a-f0-9]{64}$/);
  });
});
