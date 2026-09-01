import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRuntimeSignature,
  createSnapshotCandidate,
  ensureStrategyActive,
  inspectStrategySource,
  readRawReportState,
  readRawTradingDataBatch,
  readRawTradingReport,
  stableRuntimeJson,
  strategyRuntimeLimits,
  waitForFreshTradingReport,
} from '../src/core/strategy-runtime.js';
import { CoreOperationError } from '../src/core/errors.js';

const context = Object.freeze({
  target_id: 'target-1',
  url_chart_id: 'chart-1',
  layout_id: 101,
  pane_layout: '2h',
  pane_index: 1,
  pane_id: '2',
  symbol: 'NASDAQ:OLD',
  resolution: '1D',
});

const session = Object.freeze({
  context,
  entity_id: 'strategy-1',
  requested_symbol: 'TWSE:2344',
  resolved_symbol: 'TWSE_DLY:2344',
  symbol: 'TWSE:2344',
  timeframe: '1D',
  symbol_changed: true,
  timeframe_changed: false,
});

function reportProjection(overrides = {}) {
  return {
    currency: 'USD',
    firstTradeIndex: 0,
    trade_count: 3,
    settings: {
      dateRange: {
        backtest: { from: 1609459200000, to: 1706745600000 },
        trade: { from: 1704067200000, to: 1706745600000 },
      },
    },
    performance: {
      all: {
        netProfit: 25,
        percentProfitable: 50,
        totalTrades: 2,
        totalOpenTrades: 1,
        numberOfWiningTrades: 1,
        numberOfLosingTrades: 1,
      },
    },
    calculation_mode: { available: false, value: 'unknown' },
    first_trade_identity: {
      report_index: 0,
      entry: { time: 1704067200000, bar_index: 10, type: 'le', price: 100 },
      exit_or_mark: { time: 1704499200000, bar_index: 15, type: 'lx', price: 110 },
      quantity: 2,
    },
    last_trade_identity: {
      report_index: 2,
      entry: { time: 1706745600000, bar_index: 30, type: 'le', price: 90 },
      exit_or_mark: { time: 1706832000000, bar_index: 31, type: 'lx', price: 92 },
      quantity: 2,
    },
    ...overrides,
  };
}

function rawState(overrides = {}) {
  return {
    source_found: true,
    active_source: true,
    symbol: 'TWSE_DLY:2344',
    resolution: '1D',
    status: { type: 2 },
    status_type: 2,
    status_error: null,
    report_available: true,
    report_error: null,
    inputs_fingerprint: { available: true, algorithm: 'sha256', value: 'inputs-a', count: 3 },
    report: reportProjection(),
    ...overrides,
  };
}

describe('Strategy runtime entity ownership and activation', () => {
  const studies = [
    { entity_id: 'strategy-1', name: 'One', type: 'strategy', visible: true, report_ready: false },
    { entity_id: 'strategy-2', name: 'Two', type: 'strategy', visible: true, report_ready: true },
    { entity_id: 'indicator-1', name: 'Indicator', type: 'indicator', visible: true },
  ];

  it('always inspects the caller-provided entity_id among multiple Strategies', async () => {
    let passedEntity = null;
    const result = await inspectStrategySource({
      entity_id: 'strategy-2', context,
      _deps: {
        getActivePaneState: async () => ({ symbol: 'NASDAQ:AAPL', resolution: '1D', studies }),
        callPageFunction: async (fn, args) => {
          passedEntity = args[0];
          return {
            source_found: true,
            active_source: true,
            capabilities: { report_data: true, status: true },
          };
        },
      },
    });
    assert.equal(passedEntity, 'strategy-2');
    assert.equal(result.strategy.entity_id, 'strategy-2');
    assert.equal(result.active_source, true);
  });

  it('rejects missing entities and non-Strategy entities before runtime reads', async () => {
    let pageCalls = 0;
    const deps = {
      getActivePaneState: async () => ({ studies }),
      callPageFunction: async () => { pageCalls += 1; },
    };
    await assert.rejects(
      inspectStrategySource({ entity_id: 'missing', context, _deps: deps }),
      (error) => error instanceof CoreOperationError && error.code === 'STRATEGY_NOT_FOUND_IN_PANE',
    );
    await assert.rejects(
      inspectStrategySource({ entity_id: 'indicator-1', context, _deps: deps }),
      (error) => error.code === 'ENTITY_NOT_STRATEGY',
    );
    assert.equal(pageCalls, 0);
  });

  it('makes a hidden Strategy visible, activates it, and verifies active-source readback', async () => {
    let visible = false;
    let active = false;
    let activationMethod = null;
    const result = await ensureStrategyActive({
      entity_id: 'strategy-1', context, timeout_ms: 1000,
      _deps: {
        getActivePaneState: async () => ({
          symbol: 'NASDAQ:AAPL', resolution: '1D',
          studies: [{ ...studies[0], visible, is_active_strategy: active }],
        }),
        toggleStudyVisibility: async () => { visible = true; },
        callPageFunction: async (fn) => {
          if (fn.name === 'activateSourcePage') {
            active = true;
            activationMethod = 'internalModel.setActiveStrategySource';
            return { method: activationMethod };
          }
          return {
            source_found: true,
            active_source: active,
            capabilities: { report_data: true, status: true },
          };
        },
        delay: async () => {},
      },
    });
    assert.equal(result.visibility_changed, true);
    assert.equal(result.selection_method, activationMethod);
    assert.equal(result.active_strategy.entity_id, 'strategy-1');
  });
});

describe('bounded Report state and snapshot candidates', () => {
  it('returns the bounded raw Report projection with deterministic candidate identity', async () => {
    const result = await readRawReportState({
      entity_id: 'strategy-1', session,
      _deps: {
        assertSymbolSession: async () => ({ symbol: session.resolved_symbol, resolution: '1D' }),
        inspectStrategySource: async () => ({ success: true, active_source: true }),
        callPageFunction: async (fn, args) => {
          assert.equal(fn.name, 'readRuntimePage');
          assert.deepEqual(args, ['strategy-1', 'state', 0, 0]);
          return rawState();
        },
      },
    });
    assert.equal(result.report.trade_count, 3);
    assert.equal(result.snapshot_candidate.context.pane_id, '2');
    assert.equal(result.snapshot_candidate.requested_symbol, 'TWSE:2344');
    assert.equal(result.snapshot_candidate.resolved_symbol, 'TWSE_DLY:2344');
    assert.equal(result.snapshot_candidate.metrics.winning_trades, 1);
    assert.match(result.runtime_signature, /^[a-f0-9]{64}$/);
  });

  it('uses stable key ordering for runtime signatures', () => {
    assert.equal(stableRuntimeJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
    assert.equal(createRuntimeSignature({ b: 2, a: 1 }), createRuntimeSignature({ a: 1, b: 2 }));
    const candidate = createSnapshotCandidate({ entity_id: 'strategy-1', session, raw: rawState() });
    assert.equal(candidate.inputs_fingerprint.value, 'inputs-a');
    assert.equal(candidate.trade_count, 3);
  });

  it('rejects an unavailable Report explicitly', async () => {
    await assert.rejects(
      readRawTradingReport({
        entity_id: 'strategy-1', context,
        _deps: {
          inspectStrategySource: async () => ({ success: true, active_source: true }),
          callPageFunction: async () => rawState({ report_available: false, report: null }),
        },
      }),
      (error) => error.code === 'STRATEGY_REPORT_UNAVAILABLE' && error.retryable === true,
    );
  });
});

describe('fresh and stable Strategy Report lifecycle', () => {
  function observation(signature, { status_type = 2, report_available = true, status_error = null } = {}) {
    return { runtime_signature: signature, status_type, report_available, status_error };
  }

  it('requires transition or signature change after mutation, then three stable ready reads', async () => {
    const sequence = [
      observation('old'),
      observation('calculating', { status_type: 1, report_available: false }),
      observation('new'),
      observation('new'),
      observation('new'),
    ];
    let now = 0;
    const phases = [];
    const result = await waitForFreshTradingReport({
      entity_id: 'strategy-1', session, before: observation('old'), mutated: true, timeout_ms: 2000,
      _deps: {
        assertSymbolSession: async (value, options) => { phases.push(options.phase); },
        ensureStrategyActive: async () => ({ success: true }),
        readRawReportState: async () => sequence.shift(),
        delay: async (milliseconds) => { now += milliseconds; },
        now: () => now,
      },
    });
    assert.equal(result.runtime_signature, 'new');
    assert.equal(result.transition_observed, true);
    assert.equal(result.stable_reads, 3);
    assert.equal(result.fresh, true);
    assert.deepEqual(phases, ['strategy_calculation_start', 'strategy_calculation_complete']);
  });

  it('accepts a same-context Report only after three stable observations', async () => {
    const sequence = [observation('same'), observation('same'), observation('same')];
    let now = 0;
    const result = await waitForFreshTradingReport({
      entity_id: 'strategy-1', context, mutated: false, timeout_ms: 1000,
      _deps: {
        ensureStrategyActive: async () => ({ success: true }),
        readRawReportState: async () => sequence.shift(),
        delay: async (milliseconds) => { now += milliseconds; },
        now: () => now,
      },
    });
    assert.equal(result.runtime_signature, 'same');
    assert.equal(result.stable_reads, strategyRuntimeLimits.stable_reads);
    assert.equal(result.fresh, false);
  });

  it('does not accept an old ready Report after mutation and times out with a stable code', async () => {
    let now = 0;
    await assert.rejects(
      waitForFreshTradingReport({
        entity_id: 'strategy-1', session, before: observation('old'), mutated: true, timeout_ms: 400,
        _deps: {
          assertSymbolSession: async () => ({ symbol: session.resolved_symbol, resolution: '1D' }),
          ensureStrategyActive: async () => ({ success: true }),
          readRawReportState: async () => observation('old'),
          delay: async (milliseconds) => { now += milliseconds; },
          now: () => now,
        },
      }),
      (error) => error.code === 'STRATEGY_CALCULATION_TIMEOUT'
        && error.phase === 'strategy_calculation'
        && error.retryable === true,
    );
  });

  it('surfaces an explicit runtime error instead of waiting for timeout', async () => {
    await assert.rejects(
      waitForFreshTradingReport({
        entity_id: 'strategy-1', context, timeout_ms: 400,
        _deps: {
          ensureStrategyActive: async () => ({ success: true }),
          readRawReportState: async () => observation('failed', { status_type: 3, status_error: 'runtime failed' }),
        },
      }),
      (error) => error.code === 'STRATEGY_REPORT_UNAVAILABLE'
        && error.phase === 'strategy_calculation'
        && /runtime failed/.test(error.message),
    );
  });
});

describe('page-context Trade batching', () => {
  it('slices inside the page and returns bounded items with before/after identity', async () => {
    let pageSource = '';
    let pageArgs = null;
    const before = reportProjection();
    const after = reportProjection({ trade_count: 4 });
    const result = await readRawTradingDataBatch({
      entity_id: 'strategy-1', session, offset: 100, limit: 2,
      _deps: {
        assertSymbolSession: async () => ({ symbol: session.resolved_symbol, resolution: '1D' }),
        inspectStrategySource: async () => ({ success: true, active_source: true }),
        callPageFunction: async (fn, args) => {
          pageSource = fn.toString();
          pageArgs = args;
          return {
            ...rawState(),
            report: undefined,
            before,
            after,
            total: 1000000,
            offset: 100,
            limit: 2,
            items: [{ e: { tm: 1 } }, { e: { tm: 2 } }],
          };
        },
      },
    });
    assert.match(pageSource, /report\.trades\.slice\(offset, offset \+ limit\)/);
    assert.deepEqual(pageArgs, ['strategy-1', 'batch', 100, 2]);
    assert.equal(result.total, 1000000);
    assert.equal(result.returned, 2);
    assert.equal(result.items.length, 2);
    assert.equal(result.next_offset, 102);
    assert.equal(result.snapshot_changed, true);
  });

  it('validates offset/limit before touching the page', async () => {
    let called = false;
    await assert.rejects(
      readRawTradingDataBatch({
        entity_id: 'strategy-1', offset: -1, limit: 5001,
        _deps: { callPageFunction: async () => { called = true; } },
      }),
      (error) => error.code === 'STRATEGY_RUNTIME_INVALID' && error.phase === 'batch_validation',
    );
    assert.equal(called, false);
  });
});
