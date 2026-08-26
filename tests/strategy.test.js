import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  getActiveStrategy,
  getStrategyEquity,
  getStrategyOrders,
  getStrategyReport,
  getStrategyTrades,
  normalizeStrategyOrder,
  normalizeStrategyTrade,
  selectStrategy,
} from '../src/core/strategy.js';
import {
  getEquity as getLegacyEquity,
  getStrategyResults as getLegacyStrategyResults,
  getTrades as getLegacyTrades,
} from '../src/core/data.js';

describe('Strategy Tester active Strategy read model', () => {
  it('returns the one explicitly report-ready Strategy Instance', async () => {
    const result = await getActiveStrategy({
      _deps: { getActivePaneState: async () => ({
        symbol: 'NASDAQ:AAPL', resolution: '1D', studies: [
          { entity_id: 'one', type: 'strategy', is_active_strategy: false },
          { entity_id: 'two', type: 'strategy', is_active_strategy: true, report_ready: true },
          { entity_id: 'indicator', type: 'indicator' },
        ],
      }) },
    });
    assert.equal(result.status, 'ready');
    assert.equal(result.active_strategy.entity_id, 'two');
    assert.equal(result.strategy_count, 2);
  });

  it('does not guess when Strategies exist but no report is ready', async () => {
    const result = await getActiveStrategy({
      _deps: { getActivePaneState: async () => ({ studies: [
        { entity_id: 'one', type: 'strategy', is_active_strategy: false },
      ] }) },
    });
    assert.equal(result.status, 'not_ready');
    assert.equal(result.active_strategy, null);
  });

  it('reports an empty pane distinctly', async () => {
    const result = await getActiveStrategy({
      _deps: { getActivePaneState: async () => ({ studies: [] }) },
    });
    assert.equal(result.status, 'no_strategy');
    assert.equal(result.strategy_count, 0);
  });

  it('rejects ambiguous active readback instead of selecting the first Strategy', async () => {
    await assert.rejects(() => getActiveStrategy({
      _deps: { getActivePaneState: async () => ({ studies: [
        { entity_id: 'one', type: 'strategy', is_active_strategy: true },
        { entity_id: 'two', type: 'strategy', is_active_strategy: true },
      ] }) },
    }), /ambiguous/);
  });
});

describe('Strategy Instance selection', () => {
  const pending = {
    studies: [
      { entity_id: 'strategy', name: 'Strategy', type: 'strategy', visible: true, report_ready: false, is_active_strategy: false },
      { entity_id: 'indicator', name: 'Indicator', type: 'indicator', visible: true },
    ],
  };
  const ready = {
    studies: [
      { entity_id: 'strategy', name: 'Strategy', type: 'strategy', visible: true, report_ready: true, is_active_strategy: true },
    ],
  };

  it('selects an explicit Strategy and verifies active/report readback', async () => {
    let stateCall = 0;
    let expression = '';
    const result = await selectStrategy({
      entity_id: 'strategy', timeout_ms: 100,
      _deps: {
        getActivePaneState: async () => (++stateCall === 1 ? pending : ready),
        evaluate: async (source) => { expression = source; return { method: 'activeStrategySource.setValue' }; },
        delay: async () => {},
      },
    });
    assert.equal(result.active_strategy.entity_id, 'strategy');
    assert.equal(result.selection_method, 'activeStrategySource.setValue');
    assert.match(expression, /setActiveStrategySource/);
  });

  it('makes a hidden Strategy visible and reports the change', async () => {
    let toggled = false;
    const result = await selectStrategy({
      entity_id: 'strategy', timeout_ms: 100,
      _deps: {
        getActivePaneState: async () => toggled ? ready : {
          studies: [{ ...pending.studies[0], visible: false }],
        },
        toggleStudyVisibility: async () => { toggled = true; return { success: true }; },
        evaluate: async () => ({ method: 'already_active' }),
        delay: async () => {},
      },
    });
    assert.equal(result.visibility_changed, true);
  });

  it('rejects Indicator and unknown Entity IDs before selection', async () => {
    let evaluated = false;
    const deps = {
      getActivePaneState: async () => pending,
      evaluate: async () => { evaluated = true; },
    };
    await assert.rejects(() => selectStrategy({ entity_id: 'indicator', _deps: deps }), /not a strategy/);
    await assert.rejects(() => selectStrategy({ entity_id: 'missing', _deps: deps }), /not found/);
    assert.equal(evaluated, false);
  });

  it('fails when the TradingView build has no selection adapter', async () => {
    await assert.rejects(() => selectStrategy({
      entity_id: 'strategy', timeout_ms: 100,
      _deps: {
        getActivePaneState: async () => pending,
        evaluate: async () => ({ error: 'TradingView build does not expose a Strategy selection adapter' }),
      },
    }), /does not expose/);
  });
});

describe('Strategy data contracts', () => {
  const selection = {
    success: true, symbol: 'NASDAQ:AAPL', resolution: '1D',
    active_strategy: { entity_id: 'strategy', name: 'Strategy', type: 'strategy' },
  };

  it('normalizes Orders independently from paired Trades', () => {
    assert.deepEqual(normalizeStrategyOrder({ id: 'o1', tp: 'limit', b: true, e: true, p: 100, q: 2, tm: 42 }), {
      id: 'o1', order_type: 'limit', side: 'buy', is_entry: true, price: 100,
      quantity: 2, time_index: 42, time: null, time_iso: null,
    });
    const trade = normalizeStrategyTrade({
      e: { id: 'e1', p: 100, tm: 1000, b: 10, tp: 'le' },
      x: { id: 'x1', p: 110, tm: 2000, b: 20, tp: 'lx' },
      q: 2, tp: 20, cp: 35, rn: 25, dd: -3, cm: 1,
    }, 7);
    assert.equal(trade.report_index, 7);
    assert.equal(trade.entry.bar_index, 10);
    assert.equal(trade.entry.time, 1000);
    assert.equal(trade.entry.time_iso, '1970-01-01T00:16:40.000Z');
    assert.equal(trade.exit.price, 110);
    assert.equal(trade.profit.value, 20);
    assert.deepEqual(trade.cumulative_profit, { value: 35, percent: null });
  });

  it('normalizes current compact value/percent metric pairs', () => {
    const trade = normalizeStrategyTrade({
      tp: { v: -104.8, p: -0.071 },
      cp: { v: -5.5, p: -0.033 },
      rn: { v: 149, p: 0.101 },
      dd: { v: 108, p: 0.073 },
    }, 5);
    assert.deepEqual(trade.profit, { value: -104.8, percent: -0.071 });
    assert.deepEqual(trade.cumulative_profit, { value: -5.5, percent: -0.033 });
    assert.deepEqual(trade.run_up, { value: 149, percent: 0.101 });
    assert.deepEqual(trade.drawdown, { value: 108, percent: 0.073 });
  });

  it('tags report metrics with the requested Strategy, symbol, and timeframe', async () => {
    const result = await getStrategyReport({
      entity_id: 'strategy',
      _deps: {
        selectStrategy: async () => selection,
        evaluate: async () => ({ metrics: { net_profit: 123 }, currency: 'USD' }),
      },
    });
    assert.equal(result.strategy_entity_id, 'strategy');
    assert.equal(result.symbol, 'NASDAQ:AAPL');
    assert.equal(result.timeframe, '1D');
    assert.equal(result.metrics.net_profit, 123);
  });

  it('returns raw order events under an orders contract', async () => {
    const result = await getStrategyOrders({
      entity_id: 'strategy', limit: 10,
      _deps: {
        selectStrategy: async () => selection,
        evaluate: async () => ({ total: 12, start: 2, items: [{ id: 'o1', b: false, p: 10 }] }),
      },
    });
    assert.equal(result.total_orders, 12);
    assert.equal(result.truncated, true);
    assert.equal(result.orders[0].side, 'sell');
    assert.equal('trades' in result, false);
  });

  it('returns paired report trades with stable report indexes', async () => {
    const result = await getStrategyTrades({
      entity_id: 'strategy', limit: 10,
      _deps: {
        selectStrategy: async () => selection,
        evaluate: async () => ({
          total: 21, start: 20,
          items: [{ e: { p: 100, b: 4 }, x: { p: 110, b: 8 }, q: 1, tp: 10 }],
        }),
      },
    });
    assert.equal(result.total_trades, 21);
    assert.equal(result.trades[0].report_index, 20);
    assert.equal(result.trades[0].entry.price, 100);
    assert.equal('orders' in result, false);
  });

  it('reports unavailable equity explicitly without fabricating a curve', async () => {
    const result = await getStrategyEquity({
      entity_id: 'strategy',
      _deps: {
        selectStrategy: async () => selection,
        evaluate: async () => ({ available: false, buy_hold_points: 50, limitation: 'not exposed' }),
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.available, false);
    assert.deepEqual(result.data, []);
    assert.equal(result.buy_hold_points, 50);
  });

  it('rejects unsafe result limits before selecting a Strategy', async () => {
    let selected = false;
    await assert.rejects(() => getStrategyTrades({
      entity_id: 'strategy', limit: 5001,
      _deps: { selectStrategy: async () => { selected = true; } },
    }), /limit must be/);
    assert.equal(selected, false);
  });

  it('legacy Data Core aliases reject implicit Strategy selection', async () => {
    await assert.rejects(() => getLegacyStrategyResults(), /entity_id is required/);
    await assert.rejects(() => getLegacyTrades(), /entity_id is required/);
    await assert.rejects(() => getLegacyEquity(), /entity_id is required/);
  });
});
