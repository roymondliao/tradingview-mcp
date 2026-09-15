/** Pure five-metric reconciliation for canonical Strategy Trading data. */
import { CoreOperationError } from './errors.js';

export const DEFAULT_RECONCILIATION_TOLERANCE = Object.freeze({
  total_net_profit: 0.01,
  win_rate_percent: 0.01,
  total_trades: 0,
  winning_trades: 0,
  losing_trades: 0,
});

const REQUIRED_METRICS = Object.freeze([
  'total_net_profit',
  'win_rate_percent',
  'total_trades',
  'winning_trades',
  'losing_trades',
]);

function decimalParts(value) {
  const [mantissa, exponentText = '0'] = value.toString().toLowerCase().split('e');
  const exponent = Number(exponentText);
  const negative = mantissa.startsWith('-');
  const unsigned = negative || mantissa.startsWith('+') ? mantissa.slice(1) : mantissa;
  const [integer, fraction = ''] = unsigned.split('.');
  let coefficient = BigInt(`${integer || '0'}${fraction}` || '0');
  if (negative) coefficient = -coefficient;
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function exactDecimalSum(values) {
  const parts = values.map(decimalParts);
  const scale = Math.max(0, ...parts.map((part) => part.scale));
  const coefficient = parts.reduce(
    (sum, part) => sum + part.coefficient * (10n ** BigInt(scale - part.scale)),
    0n,
  );
  return Number(coefficient) / (10 ** scale);
}

function addDecimal(total, value) {
  const part = decimalParts(value);
  const scale = Math.max(total.scale, part.scale);
  return {
    coefficient: total.coefficient * (10n ** BigInt(scale - total.scale))
      + part.coefficient * (10n ** BigInt(scale - part.scale)),
    scale,
  };
}

function decimalValue(total) {
  return Number(total.coefficient) / (10 ** total.scale);
}

/** Incrementally calculate the same five metrics without retaining all Trades. */
export function createTradingDataMetricsAccumulator() {
  let closedTrades = 0;
  let openTrades = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let closedProfit = { coefficient: 0n, scale: 0 };
  let openCommission = { coefficient: 0n, scale: 0 };
  let openCommissionAvailable = true;
  const currencies = new Set();
  let api;

  function addBatch(trades) {
    if (!Array.isArray(trades)) {
      throw new CoreOperationError('Canonical Strategy Trades must be an array.', {
        code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'reconciliation_calculation',
      });
    }
    for (const trade of trades) {
      if (!['closed', 'open'].includes(trade?.status)) {
        throw new CoreOperationError('Every canonical Strategy Trade must be classified as closed or open.', {
          code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'reconciliation_calculation',
        });
      }
      if (trade.status === 'closed') {
        const profit = trade?.profit?.value;
        if (typeof profit !== 'number' || !Number.isFinite(profit)) {
          throw new CoreOperationError('Every Closed Trade requires a finite profit.value for reconciliation.', {
            code: 'TRADING_DATA_SCHEMA_UNSUPPORTED', phase: 'reconciliation_calculation',
          });
        }
        if (trade.currency != null) currencies.add(trade.currency);
        if (currencies.size > 1) {
          throw new CoreOperationError('Closed Strategy Trades contain multiple currencies.', {
            code: 'RECONCILIATION_MISMATCH', phase: 'reconciliation_calculation',
          });
        }
        closedTrades += 1;
        if (profit > 0) winningTrades += 1;
        else if (profit < 0) losingTrades += 1;
        closedProfit = addDecimal(closedProfit, profit);
      } else {
        openTrades += 1;
        const commission = trade?.commission;
        if (typeof commission === 'number' && Number.isFinite(commission)) {
          openCommission = addDecimal(openCommission, commission);
        } else {
          openCommissionAvailable = false;
        }
      }
    }
    return api;
  }

  function finish() {
    const closedTradeNetProfit = decimalValue(closedProfit);
    const openCommissionCharged = openCommissionAvailable ? decimalValue(openCommission) : null;
    return {
      // TradingView excludes Open Trade mark-to-market P&L from Report Net Profit,
      // but includes commission already charged for the still-open position.
      total_net_profit: openCommissionCharged == null
        ? null
        : exactDecimalSum([closedTradeNetProfit, -openCommissionCharged]),
      win_rate_percent: closedTrades === 0 ? 0 : (winningTrades * 100) / closedTrades,
      total_trades: closedTrades,
      winning_trades: winningTrades,
      losing_trades: losingTrades,
      breakeven_trades: closedTrades - winningTrades - losingTrades,
      closed_trade_net_profit: closedTradeNetProfit,
      open_commission_charged: openCommissionCharged,
      open_commission_available: openCommissionAvailable,
      open_trades_excluded: openTrades,
      currency: currencies.values().next().value ?? null,
    };
  }

  api = { addBatch, finish };
  return api;
}

export function calculateTradingDataMetrics(trades) {
  return createTradingDataMetricsAccumulator().addBatch(trades).finish();
}

function toleranceValues(overrides = {}) {
  const result = { ...DEFAULT_RECONCILIATION_TOLERANCE };
  for (const metric of REQUIRED_METRICS) {
    if (overrides[metric] == null) continue;
    const value = Number(overrides[metric]);
    if (!Number.isFinite(value) || value < 0) {
      throw new CoreOperationError(`Tolerance for ${metric} must be a non-negative finite number.`, {
        code: 'RECONCILIATION_MISMATCH', phase: 'reconciliation_validation',
      });
    }
    if (metric.endsWith('_trades') && value !== 0) {
      throw new CoreOperationError(`Count metric ${metric} requires exact matching and tolerance 0.`, {
        code: 'RECONCILIATION_MISMATCH', phase: 'reconciliation_validation',
      });
    }
    result[metric] = value;
  }
  return result;
}

export function reconcileTradingReport({ reportMetrics, tradingDataMetrics, tolerance } = {}) {
  const tolerances = toleranceValues(tolerance);
  const evidence = {};
  for (const metric of REQUIRED_METRICS) {
    const expected = reportMetrics?.[metric] ?? null;
    const actual = tradingDataMetrics?.[metric] ?? null;
    const available = typeof expected === 'number' && Number.isFinite(expected)
      && typeof actual === 'number' && Number.isFinite(actual);
    const difference = available ? actual - expected : null;
    const absoluteDifference = difference == null ? null : Math.abs(difference);
    const exact = metric.endsWith('_trades');
    const numericEpsilon = available && !exact
      ? Number.EPSILON * Math.max(1, Math.abs(expected), Math.abs(actual)) * 4
      : 0;
    evidence[metric] = {
      expected,
      actual,
      difference,
      absolute_difference: absoluteDifference,
      tolerance: tolerances[metric],
      ...(!exact && { numeric_epsilon: numericEpsilon }),
      matched: available && (exact
        ? actual === expected
        : absoluteDifference <= tolerances[metric] + numericEpsilon),
      ...(!available && { reason: 'metric_unavailable' }),
    };
  }
  const mismatchedMetrics = REQUIRED_METRICS.filter((metric) => !evidence[metric].matched);
  return {
    success: mismatchedMetrics.length === 0,
    required_metrics: [...REQUIRED_METRICS],
    mismatched_metrics: mismatchedMetrics,
    metrics: evidence,
  };
}
