import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  calculateTradingDataMetrics,
  createTradingDataMetricsAccumulator,
  reconcileTradingReport,
} from '../src/core/strategy-reconciliation.js';
import { normalizeStrategyTrade } from '../src/core/strategy-trading-model.js';

const fixtureRoot = new URL('./fixtures/strategy-trading/', import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8'));
}

function canonicalCompactTrades() {
  const report = fixture('compact-report.json').report;
  return report.trades.map((trade, index) => normalizeStrategyTrade(trade, index, {
    first_trade_index: report.firstTradeIndex,
    closed_count: report.performance.all.totalTrades,
    open_count: report.performance.all.totalOpenTrades,
    currency: report.currency,
  }));
}

describe('five-metric Trading Data calculation', () => {
  it('excludes Open mark-to-market P&L but subtracts its charged commission', () => {
    const metrics = calculateTradingDataMetrics(canonicalCompactTrades());
    assert.deepEqual(metrics, {
      total_net_profit: 7.5,
      win_rate_percent: 50,
      total_trades: 2,
      winning_trades: 1,
      losing_trades: 1,
      breakeven_trades: 0,
      closed_trade_net_profit: 8.5,
      open_commission_charged: 1,
      open_commission_available: true,
      open_trades_excluded: 1,
      currency: 'USD',
    });
  });

  it('counts Breakeven in total only and defines zero-trade win rate as zero', () => {
    const base = canonicalCompactTrades()[0];
    const metrics = calculateTradingDataMetrics([
      { ...base, report_index: 0, profit: { value: 10, percent: null } },
      { ...base, report_index: 1, profit: { value: 0, percent: null } },
      { ...base, report_index: 2, profit: { value: -2, percent: null } },
    ]);
    assert.equal(metrics.total_trades, 3);
    assert.equal(metrics.winning_trades, 1);
    assert.equal(metrics.losing_trades, 1);
    assert.equal(metrics.breakeven_trades, 1);
    assert.equal(metrics.win_rate_percent, 100 / 3);
    assert.equal(calculateTradingDataMetrics([]).win_rate_percent, 0);
  });

  it('marks Report-comparable Net Profit unavailable when Open commission is unavailable', () => {
    const [closedTrade, , openTrade] = canonicalCompactTrades();
    const metrics = calculateTradingDataMetrics([
      closedTrade,
      { ...openTrade, commission: null },
    ]);
    assert.equal(metrics.closed_trade_net_profit, 19);
    assert.equal(metrics.open_commission_charged, null);
    assert.equal(metrics.open_commission_available, false);
    assert.equal(metrics.total_net_profit, null);
  });

  it('keeps streaming batch aggregates identical to the pure array calculation', () => {
    const trades = canonicalCompactTrades();
    const accumulator = createTradingDataMetricsAccumulator();
    accumulator.addBatch(trades.slice(0, 1));
    accumulator.addBatch(trades.slice(1));
    assert.deepEqual(accumulator.finish(), calculateTradingDataMetrics(trades));
  });

  it('rejects unknown statuses, missing Closed P&L, and mixed currencies', () => {
    const trade = canonicalCompactTrades()[0];
    assert.throws(
      () => calculateTradingDataMetrics([{ ...trade, status: 'unknown' }]),
      (error) => error.code === 'TRADING_DATA_SCHEMA_UNSUPPORTED',
    );
    assert.throws(
      () => calculateTradingDataMetrics([{ ...trade, profit: { value: null } }]),
      (error) => error.code === 'TRADING_DATA_SCHEMA_UNSUPPORTED',
    );
    assert.throws(
      () => calculateTradingDataMetrics([trade, { ...trade, currency: 'TWD' }]),
      (error) => error.code === 'RECONCILIATION_MISMATCH',
    );
  });
});

describe('Trading Report reconciliation evidence', () => {
  const actual = {
    total_net_profit: 100,
    win_rate_percent: 60,
    total_trades: 5,
    winning_trades: 3,
    losing_trades: 2,
  };

  it('matches numeric differences at tolerance boundaries without pre-rounding', () => {
    const result = reconcileTradingReport({
      reportMetrics: { ...actual, total_net_profit: 100.01, win_rate_percent: 60.01 },
      tradingDataMetrics: actual,
    });
    assert.equal(result.success, true);
    assert.equal(result.metrics.total_net_profit.matched, true);
    assert.equal(result.metrics.win_rate_percent.matched, true);
  });

  it('fails outside tolerance and provides per-metric expected/actual evidence', () => {
    const result = reconcileTradingReport({
      reportMetrics: { ...actual, total_net_profit: 100.011, winning_trades: 4 },
      tradingDataMetrics: actual,
    });
    assert.equal(result.success, false);
    assert.deepEqual(result.mismatched_metrics, ['total_net_profit', 'winning_trades']);
    assert.deepEqual(result.metrics.winning_trades, {
      expected: 4,
      actual: 3,
      difference: -1,
      absolute_difference: 1,
      tolerance: 0,
      matched: false,
    });
  });

  it('requires exact count matches and marks unavailable Report metrics', () => {
    const countMismatch = reconcileTradingReport({
      reportMetrics: { ...actual, total_trades: 6 }, tradingDataMetrics: actual,
    });
    assert.equal(countMismatch.metrics.total_trades.matched, false);
    const unavailable = reconcileTradingReport({
      reportMetrics: { ...actual, losing_trades: null }, tradingDataMetrics: actual,
    });
    assert.equal(unavailable.metrics.losing_trades.reason, 'metric_unavailable');
    assert.throws(
      () => reconcileTradingReport({ reportMetrics: actual, tradingDataMetrics: actual, tolerance: { total_trades: 1 } }),
      (error) => error.code === 'RECONCILIATION_MISMATCH',
    );
  });
});

describe('paired Desktop Trading Report and Trading Data fixture', () => {
  it('reconciles the same TWSE:2344 pane snapshot within CSV display precision', () => {
    const paired = fixture('desktop-paired-report-trades.json');
    const trades = paired.trading_data.trades;
    const metrics = calculateTradingDataMetrics(trades);
    assert.equal(metrics.closed_trade_net_profit, 869.12);
    assert.equal(metrics.open_commission_charged, 3.52);
    assert.equal(metrics.total_net_profit, 865.6);
    assert.equal(metrics.win_rate_percent, 400 / 11);
    const result = reconcileTradingReport({
      reportMetrics: paired.trading_report.metrics,
      tradingDataMetrics: metrics,
    });
    assert.equal(result.success, true);
    assert.ok(result.metrics.total_net_profit.absolute_difference < 0.01);
  });
});
