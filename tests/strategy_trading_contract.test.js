import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixtureRoot = new URL('./fixtures/strategy-trading/', import.meta.url);

function fixture(name) {
  return JSON.parse(readFileSync(new URL(name, fixtureRoot), 'utf8'));
}

function rawVariant(trade) {
  if (trade?.e && trade?.tp && Object.hasOwn(trade, 'q')) return 'compact';
  if (trade?.entry && trade?.profit && Object.hasOwn(trade, 'quantity')) return 'verbose';
  return 'unsupported';
}

function entryTime(trade) {
  return trade?.e?.tm ?? trade?.entry?.time ?? null;
}

function inspectCompleteness(report) {
  const firstTradeIndex = report?.firstTradeIndex;
  const all = report?.performance?.all;
  const trades = report?.trades;
  if (!Array.isArray(trades) || !all || !Number.isInteger(firstTradeIndex)) {
    return { complete: false, reason: 'unsupported_schema' };
  }
  if (trades.some((trade) => rawVariant(trade) === 'unsupported')) {
    return { complete: false, reason: 'unsupported_trade_shape' };
  }
  if (firstTradeIndex !== 0) return { complete: false, reason: 'retained_tail_only' };
  const expected = all.totalTrades + all.totalOpenTrades;
  if (trades.length !== expected) return { complete: false, reason: 'count_mismatch' };
  const times = trades.map(entryTime);
  if (times.some((time) => !Number.isFinite(time))) return { complete: false, reason: 'missing_entry_time' };
  if (times.some((time, index) => index > 0 && time < times[index - 1])) {
    return { complete: false, reason: 'ordering_mismatch' };
  }
  return {
    complete: true,
    closed_count: all.totalTrades,
    open_count: all.totalOpenTrades,
    open_indexes: trades.slice(all.totalTrades).map((unused, index) => all.totalTrades + index),
  };
}

const desktopSemantics = [
  'trade_number',
  'leg_type',
  'date_time',
  'signal',
  'price',
  'quantity',
  'position_value',
  'net_profit',
  'return_percent',
  'commission',
  'run_up_value',
  'run_up_percent',
  'drawdown_value',
  'drawdown_percent',
  'cumulative_profit',
  'cumulative_profit_percent',
  'duration_bars',
];

function projectCompactSemantics(report, index) {
  const trade = report.trades[index];
  return {
    trade_number: report.firstTradeIndex + index + 1,
    leg_type: { entry: trade.e.tp, exit: trade.x.tp },
    date_time: { entry: trade.e.tm, exit: trade.x.tm },
    signal: { entry: trade.e.c, exit: trade.x.c },
    price: { entry: trade.e.p, exit: trade.x.p },
    quantity: trade.q,
    position_value: trade.v,
    net_profit: trade.tp.v,
    return_percent: trade.tp.p * 100,
    commission: trade.cm,
    run_up_value: trade.rn.v,
    run_up_percent: trade.rn.p * 100,
    drawdown_value: trade.dd.v,
    drawdown_percent: trade.dd.p * 100,
    cumulative_profit: trade.cp.v,
    cumulative_profit_percent: trade.cp.p * 100,
    duration_bars: trade.x.b - trade.e.b,
  };
}

describe('Strategy Trading runtime discovery contract', () => {
  it('maps all 17 Desktop CSV semantics to compact raw keys or derived rules', () => {
    const compact = fixture('compact-report.json');
    const trade = compact.report.trades[0];
    const projection = projectCompactSemantics(compact.report, 0);
    assert.equal(desktopSemantics.length, 17);
    assert.deepEqual(Object.keys(projection), desktopSemantics);
    assert.ok(Object.values(projection).every((value) => value !== null && value !== undefined));
    assert.equal(rawVariant(trade), 'compact');
    assert.equal(projection.trade_number, 1);
    assert.deepEqual(projection.leg_type, { entry: 'le', exit: 'lx' });
    assert.equal(projection.return_percent, 9.5);
    assert.equal(projection.duration_bars, 5);
  });

  it('treats compact timestamps as Unix milliseconds and preserves oldest-first order', () => {
    const { report } = fixture('compact-report.json');
    const times = report.trades.map(entryTime);
    assert.ok(times.every((time) => time >= 1_000_000_000_000));
    assert.equal(new Date(times[0]).toISOString(), '2024-01-01T00:00:00.000Z');
    assert.deepEqual([...times].sort((left, right) => left - right), times);
  });

  it('uses report counts to classify trailing Open Trades with synthetic exit legs', () => {
    const result = inspectCompleteness(fixture('compact-report.json').report);
    assert.deepEqual(result, {
      complete: true,
      closed_count: 2,
      open_count: 1,
      open_indexes: [2],
    });
  });

  it('rejects retained tails, count gaps, ordering changes, and unsupported shapes', () => {
    const report = fixture('compact-report.json').report;
    assert.equal(inspectCompleteness({ ...report, firstTradeIndex: 4 }).reason, 'retained_tail_only');
    assert.equal(inspectCompleteness({ ...report, trades: report.trades.slice(1) }).reason, 'count_mismatch');
    assert.equal(inspectCompleteness({ ...report, trades: [...report.trades].reverse() }).reason, 'ordering_mismatch');
    assert.equal(inspectCompleteness(fixture('unsupported-report.json').report).reason, 'unsupported_trade_shape');
  });

  it('keeps verbose raw compatibility explicit', () => {
    const report = fixture('verbose-report.json').report;
    assert.equal(rawVariant(report.trades[0]), 'verbose');
    assert.equal(inspectCompleteness(report).complete, true);
  });

  it('records Regular, Deep, and unavailable calculation-mode variants', () => {
    const variants = fixture('calculation-mode-variants.json').cases;
    for (const testCase of variants) {
      const actual = testCase.input.available ? testCase.input.value : 'unknown';
      assert.equal(actual, testCase.expected, testCase.name);
    }
  });

  it('keeps committed fixtures free of private runtime material', () => {
    for (const name of ['compact-report.json', 'verbose-report.json', 'unsupported-report.json', 'calculation-mode-variants.json']) {
      const text = readFileSync(new URL(name, fixtureRoot), 'utf8');
      assert.doesNotMatch(text, /pine_source|auth_token|sessionid|cookie|credential/i);
    }
  });
});
