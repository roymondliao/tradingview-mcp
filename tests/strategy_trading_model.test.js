import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  compareSnapshotIdentity,
  createSnapshotIdentity,
  createTradeIdentity,
  normalizeStrategyTrade,
  normalizeStrategyTradeBatch,
  normalizeTradingReport,
  validateTradeSequence,
} from '../src/core/strategy-trading-model.js';

const fixtureRoot = new URL('./fixtures/strategy-trading/', import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8'));
}

function compactTrade(index, overrides = {}) {
  const raw = fixture('compact-report.json').report.trades[index];
  return normalizeStrategyTrade({ ...raw, ...overrides }, index, {
    first_trade_index: 0,
    closed_count: 2,
    open_count: 1,
    currency: 'USD',
  });
}

function snapshotCandidate(overrides = {}) {
  return {
    schema_version: 1,
    normalization: 'strategy-runtime-candidate-v1',
    context: { target_id: 'target-1', layout_id: 101, pane_id: '2' },
    entity_id: 'strategy-1',
    requested_symbol: 'TWSE:2344',
    resolved_symbol: 'TWSE_DLY:2344',
    timeframe: '1D',
    inputs_fingerprint: { available: true, algorithm: 'sha256', value: 'inputs-hash', count: 3 },
    calculation_mode: { available: false, value: 'unknown' },
    date_range: {
      backtest: { from: 1609459200000, to: 1706745600000 },
      trade: { from: 1704067200000, to: 1706745600000 },
    },
    currency: 'USD',
    first_trade_index: 0,
    trade_count: 3,
    closed_trades: 2,
    open_trades: 1,
    metrics: {
      total_net_profit: 8.5,
      win_rate_percent: 50,
      total_trades: 2,
      winning_trades: 1,
      losing_trades: 1,
    },
    first_trade_identity: createTradeIdentity(compactTrade(0)),
    last_trade_identity: createTradeIdentity(compactTrade(2)),
    ...overrides,
  };
}

describe('canonical Strategy Trade normalization', () => {
  it('normalizes compact Closed Trades with Unix millisecond ISO companions', () => {
    const trade = compactTrade(0);
    assert.equal(trade.report_index, 0);
    assert.equal(trade.trade_number, 1);
    assert.equal(trade.status, 'closed');
    assert.equal(trade.entry.direction, 'long');
    assert.equal(trade.entry.time, 1704067200000);
    assert.equal(trade.entry.time_iso, '2024-01-01T00:00:00.000Z');
    assert.equal(trade.exit.price, 110);
    assert.equal(trade.mark, null);
    assert.deepEqual(trade.profit, { value: 19, percent: 9.5 });
    assert.equal(trade.duration_bars, 5);
    assert.equal(trade.currency, 'USD');
    assert.equal(trade.availability.entry.label, true);
  });

  it('classifies trailing Open Trades from Report counts and converts synthetic x to mark', () => {
    const trade = compactTrade(2);
    assert.equal(trade.status, 'open');
    assert.equal(trade.exit, null);
    assert.equal(trade.mark.price, 92);
    assert.equal(trade.mark.type, 'lx');
    assert.equal(trade.mark.time_iso, '2024-02-02T00:00:00.000Z');
    assert.equal(trade.availability.exit.reason, 'open_trade');
    assert.equal(trade.availability.mark.available, true);
  });

  it('supports verbose compatibility without treating percentages as compact ratios', () => {
    const { report } = fixture('verbose-report.json');
    const trade = normalizeStrategyTrade(report.trades[0], 0, {
      closed_count: 1, open_count: 0, currency: report.currency,
    });
    assert.equal(trade.status, 'closed');
    assert.equal(trade.position_value, 100);
    assert.deepEqual(trade.profit, { value: 15, percent: 15 });
    assert.equal(trade.entry.time_iso, '2024-03-01T00:00:00.000Z');
  });

  it('uses null plus availability metadata for missing optional raw fields', () => {
    const raw = structuredClone(fixture('compact-report.json').report.trades[0]);
    delete raw.v;
    delete raw.cm;
    delete raw.e.c;
    const trade = normalizeStrategyTrade(raw, 0, { closed_count: 2, open_count: 1, currency: null });
    assert.equal(trade.position_value, null);
    assert.equal(trade.commission, null);
    assert.equal(trade.entry.label, null);
    assert.equal(trade.availability.position_value, false);
    assert.equal(trade.availability.entry.label, false);
    assert.equal(trade.availability.currency, false);
  });

  it('rejects unsupported shapes and status classification without Report counts', () => {
    const unsupported = fixture('unsupported-report.json').report.trades[0];
    assert.throws(
      () => normalizeStrategyTrade(unsupported, 0, { closed_count: 1, open_count: 0 }),
      (error) => error.code === 'TRADING_DATA_SCHEMA_UNSUPPORTED',
    );
    const compact = fixture('compact-report.json').report.trades[0];
    assert.throws(
      () => normalizeStrategyTrade(compact, 0),
      (error) => error.code === 'TRADING_DATA_SCHEMA_UNSUPPORTED',
    );
  });
});

describe('Trade batching, ordering, and identity', () => {
  it('derives traversal identity from Offset/report_index, not bar_index', () => {
    const report = fixture('compact-report.json').report;
    const batch = normalizeStrategyTradeBatch({
      total: 3,
      offset: 1,
      next_offset: null,
      has_more: false,
      items: report.trades.slice(1),
      snapshot_before: {
        first_trade_index: 0,
        closed_trades: 2,
        open_trades: 1,
        currency: report.currency,
      },
    });
    assert.deepEqual(batch.trades.map((trade) => trade.report_index), [1, 2]);
    assert.deepEqual(batch.trades.map((trade) => trade.trade_number), [2, 3]);
    assert.equal(batch.offset, 1);
    assert.equal(batch.sequence.valid, true);
    assert.notEqual(batch.trades[0].entry.bar_index, batch.offset);
  });

  it('detects duplicate indexes, gaps, oldest-first violations, and Closed-after-Open ordering', () => {
    const closedA = compactTrade(0);
    const closedB = compactTrade(1);
    const open = compactTrade(2);
    const duplicate = validateTradeSequence([closedA, { ...closedB, report_index: 0 }], { expected_start_index: 0 });
    assert.ok(duplicate.errors.some((error) => error.code === 'REPORT_INDEX_DUPLICATE'));
    const gap = validateTradeSequence([closedA, { ...closedB, report_index: 2 }], { expected_start_index: 0 });
    assert.ok(gap.errors.some((error) => error.code === 'REPORT_INDEX_GAP'));
    const reversed = validateTradeSequence([closedB, { ...closedA, report_index: 1 }], { expected_start_index: 0 });
    assert.ok(reversed.errors.some((error) => error.code === 'ENTRY_TIME_ORDER'));
    const closedAfterOpen = validateTradeSequence([open, { ...closedA, report_index: 3 }], { expected_start_index: 2 });
    assert.ok(closedAfterOpen.errors.some((error) => error.code === 'CLOSED_AFTER_OPEN'));
  });

  it('creates label-independent stable Trade identities', () => {
    const trade = compactTrade(0);
    const changedLabel = { ...trade, entry: { ...trade.entry, label: 'localized label' } };
    assert.deepEqual(createTradeIdentity(trade), createTradeIdentity(changedLabel));
    assert.equal(createTradeIdentity(trade).entry.bar_index, 10);
  });
});

describe('canonical Trading Report and snapshot identity', () => {
  it('normalizes Report metrics, ranges, and availability', () => {
    const compact = fixture('compact-report.json');
    const report = normalizeTradingReport(compact.report, {
      context: { target_id: 'target-1', layout_id: 101, pane_id: '2' },
      entity_id: 'strategy-1',
      requested_symbol: 'TWSE:2344',
      resolved_symbol: 'TWSE_DLY:2344',
      timeframe: '1D',
      calculation_mode: compact.calculation_mode,
    });
    assert.equal(report.reconciliation_metrics.total_net_profit, 25);
    assert.equal(report.reconciliation_metrics.win_rate_percent, 50);
    assert.equal(report.calculation.range.backtest.from_iso, '2021-01-01T00:00:00.000Z');
    assert.equal(report.calculation.mode, 'unknown');
    assert.equal(report.availability.calculation_mode, false);
    assert.equal(report.availability.metrics.net_profit, true);
  });

  it('creates deterministic versioned snapshots and reports field-level mismatches', () => {
    const first = createSnapshotIdentity(snapshotCandidate());
    const reordered = createSnapshotIdentity({
      ...snapshotCandidate(),
      context: { pane_id: '2', target_id: 'target-1', layout_id: 101 },
    });
    assert.equal(first.available, true);
    assert.equal(first.snapshot_schema_version, 1);
    assert.match(first.snapshot_id, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.snapshot_id, reordered.snapshot_id);

    const changed = createSnapshotIdentity(snapshotCandidate({
      metrics: { ...snapshotCandidate().metrics, total_net_profit: 9 },
    }));
    const comparison = compareSnapshotIdentity(first, changed);
    assert.equal(comparison.matched, false);
    assert.ok(comparison.difference_paths.includes('metrics.total_net_profit'));
    assert.equal(compareSnapshotIdentity(first.snapshot_id, first.snapshot_id).matched, true);
  });

  it('does not claim a snapshot when required identity fields are unavailable', () => {
    const identity = createSnapshotIdentity(snapshotCandidate({
      inputs_fingerprint: { available: false, value: null },
      date_range: null,
    }));
    assert.equal(identity.available, false);
    assert.equal(identity.snapshot_id, null);
    assert.ok(identity.missing_fields.includes('inputs_fingerprint.value'));
    assert.ok(identity.missing_fields.includes('date_range.backtest.from'));
  });
});
