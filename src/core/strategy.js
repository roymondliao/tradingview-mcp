/**
 * Strategy Tester operations that act on explicit Active Pane Strategy Instances.
 */
import { getActivePaneState as _getActivePaneState } from './studies.js';
import { evaluate as _evaluate, safeString } from '../connection.js';
import { unixSecondsToIso } from './time.js';
import { ensureStrategyActive as _ensureStrategyActive } from './strategy-runtime.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';

export async function getActiveStrategy({ _deps } = {}) {
  const getState = _deps?.getActivePaneState || _getActivePaneState;
  const state = await getState({ _deps });
  const strategies = (state.studies || []).filter((study) => study.type === 'strategy');
  const active = strategies.filter((study) => study.is_active_strategy === true);

  if (active.length > 1) {
    throw new Error(`Strategy Tester active Strategy readback is ambiguous (${active.length} report-ready Strategies).`);
  }

  return {
    success: true,
    symbol: state.symbol,
    resolution: state.resolution,
    strategy_count: strategies.length,
    status: active.length === 1 ? 'ready' : (strategies.length ? 'not_ready' : 'no_strategy'),
    active_strategy: active[0] || null,
  };
}

export async function selectStrategy({ entity_id, timeout_ms = 20000, _deps } = {}) {
  const ensureStrategyActive = _deps?.ensureStrategyActive || _ensureStrategyActive;
  const activation = await ensureStrategyActive({ entity_id, timeout_ms, _deps });
  if (activation.active_strategy?.report_ready === true) return activation;

  const getState = _deps?.getActivePaneState || _getActivePaneState;
  const delay = _deps?.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = _deps?.now || Date.now;
  const deadline = now() + timeout_ms;
  while (now() <= deadline) {
    const state = await getState({ _deps });
    const readback = (state.studies || []).find((study) => study.entity_id === entity_id);
    if (readback?.is_active_strategy === true && readback?.report_ready === true) {
      return {
        ...activation,
        status: 'ready',
        symbol: state.symbol,
        resolution: state.resolution,
        active_strategy: readback,
      };
    }
    await delay(400);
  }
  throw new Error(`Strategy selection timed out after ${timeout_ms}ms for ${entity_id}; visibility_changed=${activation.visibility_changed}`);
}

function validateLimit(limit, defaultValue = 200) {
  const value = limit == null ? defaultValue : Number(limit);
  if (!Number.isInteger(value) || value < 1 || value > 5000) {
    throw new Error('limit must be an integer from 1 to 5000');
  }
  return value;
}

async function selectForRead({ entity_id, _deps }) {
  const select = _deps?.selectStrategy || selectStrategy;
  return select({ entity_id, _deps });
}

function strategyReadExpression(entityId, readBody) {
  return `
    (function() {
      var chart = ${CHART_API};
      var chartModel = chart._chartWidget.model();
      var internalModel = chartModel.model();
      var sources = internalModel.dataSources() || [];
      var strategy = null;
      for (var i = 0; i < sources.length; i++) {
        var id = null;
        try { id = typeof sources[i].id === 'function' ? sources[i].id() : sources[i].id; } catch (e) {}
        if (String(id) === ${safeString(entityId)}) { strategy = sources[i]; break; }
      }
      if (!strategy) return { error: 'Strategy source not found in active pane model' };
      var holder = null;
      if (typeof internalModel.activeStrategySource === 'function') holder = internalModel.activeStrategySource();
      else if (typeof chartModel.activeStrategySource === 'function') holder = chartModel.activeStrategySource();
      var active = holder && typeof holder.value === 'function' ? holder.value() : holder;
      if (active !== strategy) return { error: 'Requested Strategy is not the active Strategy Tester source' };
      ${readBody}
    })()
  `;
}

export function normalizeStrategyOrder(order) {
  if (!order || typeof order !== 'object') return null;
  const time = order.time ?? null;
  return {
    id: order.id ?? null,
    order_type: order.tp ?? order.type ?? null,
    side: order.b === true ? 'buy' : order.b === false ? 'sell' : (order.side ?? null),
    is_entry: order.e ?? order.isEntry ?? null,
    price: order.p ?? order.price ?? null,
    quantity: order.q ?? order.quantity ?? null,
    time_index: order.tm ?? order.timeIndex ?? null,
    time,
    time_iso: unixSecondsToIso(time),
  };
}

function normalizeTradeLeg(leg) {
  if (!leg || typeof leg !== 'object') return null;
  const time = leg.tm ?? leg.time ?? null;
  return {
    id: leg.id ?? null,
    label: leg.c ?? leg.label ?? null,
    price: leg.p ?? leg.price ?? null,
    time,
    time_iso: unixSecondsToIso(time),
    bar_index: leg.b ?? leg.barIndex ?? null,
    type: leg.tp ?? leg.type ?? null,
  };
}

export function normalizeStrategyTrade(trade, reportIndex = null) {
  if (!trade || typeof trade !== 'object') return null;
  function metric(raw, explicitPercent = null) {
    if (raw && typeof raw === 'object') {
      return {
        value: raw.v ?? raw.value ?? null,
        percent: raw.p ?? raw.percentValue ?? raw.percent ?? explicitPercent,
      };
    }
    return { value: raw ?? null, percent: explicitPercent };
  }
  const profit = metric(trade.profit ?? trade.tp, trade.profitPercent ?? null);
  return {
    report_index: reportIndex,
    trade_number: trade.tradeNumber ?? null,
    entry: normalizeTradeLeg(trade.entry || trade.e),
    exit: normalizeTradeLeg(trade.exit || trade.x),
    quantity: trade.quantity ?? trade.q ?? null,
    profit,
    cumulative_profit: metric(trade.cumulativeProfit ?? trade.cp),
    run_up: metric(trade.runup ?? trade.rn),
    drawdown: metric(trade.drawdown ?? trade.dd),
    commission: trade.commission ?? trade.cm ?? null,
  };
}

export async function getStrategyReport({ entity_id, _deps } = {}) {
  const selection = await selectForRead({ entity_id, _deps });
  const runEvaluate = _deps?.evaluate || _evaluate;
  const result = await runEvaluate(strategyReadExpression(entity_id, `
    var report = strategy.reportData();
    if (report && typeof report.value === 'function') report = report.value();
    if (!report || !report.performance) return { error: 'Strategy report is not ready' };
    var perf = report.performance;
    var all = perf.all || {};
    var values = {
      net_profit: all.netProfit,
      net_profit_percent: all.netProfitPercent,
      gross_profit: all.grossProfit,
      gross_loss: all.grossLoss,
      profit_factor: all.profitFactor,
      max_drawdown: perf.maxStrategyDrawDown,
      max_drawdown_percent: perf.maxStrategyDrawDownPercent,
      total_trades: all.totalTrades != null ? all.totalTrades : (all.numberOfWiningTrades || 0) + (all.numberOfLosingTrades || 0),
      winning_trades: all.numberOfWiningTrades,
      losing_trades: all.numberOfLosingTrades,
      percent_profitable: all.percentProfitable,
      avg_trade: all.avgTrade,
      largest_win: all.largestWinTrade,
      largest_loss: all.largestLosTrade,
      commission_paid: all.commissionPaid,
      sharpe_ratio: perf.sharpeRatio,
      sortino_ratio: perf.sortinoRatio,
      buy_hold_return: perf.buyHoldReturn,
      open_pl: perf.openPL
    };
    var metrics = {};
    for (var key in values) if (values[key] !== null && values[key] !== undefined) metrics[key] = values[key];
    return { metrics: metrics, currency: report.currency || null };
  `));
  if (result?.error) throw new Error(result.error);
  return {
    success: true,
    strategy: selection.active_strategy,
    strategy_entity_id: entity_id,
    symbol: selection.symbol,
    timeframe: selection.resolution,
    currency: result.currency,
    metric_count: Object.keys(result.metrics || {}).length,
    metrics: result.metrics || {},
  };
}

export async function getStrategyOrders({ entity_id, limit, _deps } = {}) {
  const cap = validateLimit(limit);
  const selection = await selectForRead({ entity_id, _deps });
  const runEvaluate = _deps?.evaluate || _evaluate;
  const result = await runEvaluate(strategyReadExpression(entity_id, `
    var orders = strategy.ordersData();
    if (orders && typeof orders.value === 'function') orders = orders.value();
    if (!Array.isArray(orders)) return { error: 'Strategy orders are not available' };
    var start = Math.max(0, orders.length - ${cap});
    return { total: orders.length, start: start, items: orders.slice(start) };
  `));
  if (result?.error) throw new Error(result.error);
  return {
    success: true,
    strategy: selection.active_strategy,
    strategy_entity_id: entity_id,
    symbol: selection.symbol,
    timeframe: selection.resolution,
    total_orders: result.total || 0,
    returned_orders: (result.items || []).length,
    truncated: (result.total || 0) > (result.items || []).length,
    orders: (result.items || []).map(normalizeStrategyOrder).filter(Boolean),
  };
}

export async function getStrategyTrades({ entity_id, limit, _deps } = {}) {
  const cap = validateLimit(limit);
  const selection = await selectForRead({ entity_id, _deps });
  const runEvaluate = _deps?.evaluate || _evaluate;
  const result = await runEvaluate(strategyReadExpression(entity_id, `
    var report = strategy.reportData();
    if (report && typeof report.value === 'function') report = report.value();
    if (!report || !Array.isArray(report.trades)) return { error: 'Paired Strategy trades are not available' };
    var start = Math.max(0, report.trades.length - ${cap});
    return { total: report.trades.length, start: start, items: report.trades.slice(start) };
  `));
  if (result?.error) throw new Error(result.error);
  return {
    success: true,
    strategy: selection.active_strategy,
    strategy_entity_id: entity_id,
    symbol: selection.symbol,
    timeframe: selection.resolution,
    total_trades: result.total || 0,
    returned_trades: (result.items || []).length,
    truncated: (result.total || 0) > (result.items || []).length,
    trades: (result.items || []).map((trade, index) => normalizeStrategyTrade(trade, (result.start || 0) + index)).filter(Boolean),
  };
}

export async function getStrategyEquity({ entity_id, _deps } = {}) {
  const selection = await selectForRead({ entity_id, _deps });
  const runEvaluate = _deps?.evaluate || _evaluate;
  const result = await runEvaluate(strategyReadExpression(entity_id, `
    var report = strategy.reportData();
    if (report && typeof report.value === 'function') report = report.value();
    if (!report) return { error: 'Strategy report is not ready' };
    var curve = Array.isArray(report.equity) ? report.equity : (Array.isArray(report.equityChart) ? report.equityChart : null);
    if (!curve) return {
      available: false,
      buy_hold_points: Array.isArray(report.buyHold) ? report.buyHold.length : 0,
      limitation: 'TradingView does not expose a per-bar Strategy equity curve for this report.'
    };
    return { available: true, points: curve };
  `));
  if (result?.error) throw new Error(result.error);
  return {
    success: result.available === true,
    strategy: selection.active_strategy,
    strategy_entity_id: entity_id,
    symbol: selection.symbol,
    timeframe: selection.resolution,
    available: result.available === true,
    data_points: (result.points || []).length,
    data: result.points || [],
    ...(result.buy_hold_points != null && { buy_hold_points: result.buy_hold_points }),
    ...(result.limitation && { limitation: result.limitation }),
  };
}
