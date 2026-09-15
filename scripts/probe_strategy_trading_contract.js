#!/usr/bin/env node

import { disconnect, callPageFunction } from '../src/connection.js';
import { prepareContext } from '../src/core/pane.js';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2).replaceAll('-', '_');
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
    options[name] = value;
    index += 1;
  }
  return options;
}

function asIndex(value, name) {
  if (value == null) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

const options = parseArgs(process.argv.slice(2));
if (!options.entity_id) {
  throw new Error('Usage: probe_strategy_trading_contract.js --entity-id <id> [--tab-index <n>] [--pane-index <n>] [--switch-symbol <symbol>]');
}

try {
  const context = await prepareContext({
    tab_index: asIndex(options.tab_index, 'tab-index'),
    pane_index: asIndex(options.pane_index, 'pane-index'),
    url_chart_id: options.url_chart_id,
    layout_id: options.layout_id,
  });

  const probe = await callPageFunction(function probeStrategyTradingContract(entityId) {
    function valueOf(candidate) {
      try {
        return candidate && typeof candidate.value === 'function' ? candidate.value() : candidate;
      } catch (error) {
        return { __probe_error: error && error.message ? error.message : String(error) };
      }
    }

    function idOf(source) {
      try { return String(typeof source.id === 'function' ? source.id() : source.id); } catch { return null; }
    }

    function typeOf(value) {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      return typeof value;
    }

    function keyTypes(value) {
      if (!value || typeof value !== 'object') return {};
      const result = {};
      for (const key of Object.keys(value).sort()) result[key] = typeOf(value[key]);
      return result;
    }

    function boundedShape(value, depth) {
      if (value === null || value === undefined) return value === null ? null : '<undefined>';
      if (typeof value === 'string') return '<redacted-string>';
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (typeof value === 'function') return '<function>';
      if (Array.isArray(value)) return { type: 'array', length: value.length };
      if (typeof value !== 'object') return `<${typeof value}>`;
      if (depth <= 0) return { type: 'object', keys: Object.keys(value).sort().slice(0, 80) };
      const result = {};
      for (const key of Object.keys(value).sort().slice(0, 80)) {
        result[key] = boundedShape(value[key], depth - 1);
      }
      return result;
    }

    function methodNames(value) {
      const names = new Set();
      let cursor = value;
      for (let depth = 0; cursor && depth < 4; depth += 1) {
        for (const name of Object.getOwnPropertyNames(cursor)) {
          if (/(report|performance|trade|order|active|status|state|calculat|update|deep|backtest|interval|symbol|currency)/i.test(name)) {
            names.add(name);
          }
        }
        cursor = Object.getPrototypeOf(cursor);
      }
      return [...names].sort().slice(0, 120);
    }

    function legTime(trade, legNames) {
      for (const name of legNames) {
        const leg = trade && trade[name];
        if (!leg || typeof leg !== 'object') continue;
        const time = leg.tm ?? leg.time;
        if (Number.isFinite(time)) return time;
      }
      return null;
    }

    function isOpenTrade(trade) {
      if (!trade || typeof trade !== 'object') return false;
      const exit = trade.exit ?? trade.x;
      if (exit == null) return true;
      const time = exit.tm ?? exit.time;
      const markers = [exit.c, exit.label, exit.tp, exit.type]
        .filter((value) => typeof value === 'string')
        .map((value) => value.toLowerCase());
      return time == null || !Number.isFinite(time) || markers.some((value) => value === 'open' || value === '開啟');
    }

    function legSummary(leg) {
      if (!leg || typeof leg !== 'object') return null;
      const label = leg.c ?? leg.label;
      const legType = leg.tp ?? leg.type;
      return {
        keys: Object.keys(leg).sort(),
        time: leg.tm ?? leg.time ?? null,
        bar_index: leg.b ?? leg.barIndex ?? null,
        price: leg.p ?? leg.price ?? null,
        type: typeof legType === 'string' ? legType : null,
        label_present: typeof label === 'string' && label.length > 0,
        label_is_open_marker: typeof label === 'string' && (label.toLowerCase() === 'open' || label === '開啟'),
      };
    }

    function tradeSummary(trade, index) {
      if (!trade || typeof trade !== 'object') return null;
      return {
        index,
        keys: Object.keys(trade).sort(),
        entry: legSummary(trade.entry ?? trade.e),
        exit: legSummary(trade.exit ?? trade.x),
        is_open_candidate: isOpenTrade(trade),
      };
    }

    function readObservable(candidate) {
      try {
        const raw = typeof candidate === 'function' ? candidate.call(strategy) : candidate;
        const value = valueOf(raw);
        if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.length <= 80 ? value : '<redacted-string>';
        return boundedShape(value, 1);
      } catch (error) {
        return { error: error && error.message ? error.message : String(error) };
      }
    }

    function candidateScalars(value, prefix, depth, output) {
      if (!value || typeof value !== 'object' || depth < 0) return;
      for (const key of Object.keys(value).sort()) {
        const path = prefix ? `${prefix}.${key}` : key;
        const child = value[key];
        if (/(generation|version|mode|deep|backtest|range|from|to|start|end|update|calculat|symbol|interval|resolution|currency|id|time|timestamp)/i.test(key)) {
          if (typeof child === 'number' || typeof child === 'boolean' || child === null) output[path] = child;
          else if (typeof child === 'string') output[path] = '<redacted-string>';
        }
        if (child && typeof child === 'object' && !Array.isArray(child)) {
          candidateScalars(child, path, depth - 1, output);
        }
      }
    }

    const chart = globalThis.TradingViewApi._activeChartWidgetWV.value();
    const chartModel = chart._chartWidget.model();
    const internalModel = chartModel.model();
    const sources = internalModel.dataSources() || [];
    const strategy = sources.find((source) => idOf(source) === String(entityId));
    if (!strategy) return { error: 'Strategy source not found in active pane model' };

    let holder = null;
    if (typeof internalModel.activeStrategySource === 'function') holder = internalModel.activeStrategySource();
    else if (typeof chartModel.activeStrategySource === 'function') holder = chartModel.activeStrategySource();
    const active = valueOf(holder);

    let reportContainer = null;
    try { reportContainer = typeof strategy.reportData === 'function' ? strategy.reportData() : null; } catch (error) {
      return { error: `reportData() failed: ${error && error.message ? error.message : String(error)}` };
    }
    const report = valueOf(reportContainer);
    let performanceContainer = null;
    try { performanceContainer = typeof strategy.performance === 'function' ? strategy.performance() : null; } catch {}
    const sourcePerformance = valueOf(performanceContainer);
    const reportPerformance = report && report.performance ? valueOf(report.performance) : null;
    const performance = reportPerformance || sourcePerformance;
    const all = performance && performance.all ? valueOf(performance.all) : null;
    const settings = report && report.settings && typeof report.settings === 'object' ? report.settings : null;
    const trades = report && Array.isArray(report.trades) ? report.trades : [];
    const ordersContainer = typeof strategy.ordersData === 'function' ? strategy.ordersData() : null;
    const orders = valueOf(ordersContainer);
    const firstTrade = trades.length ? trades[0] : null;
    const lastTrade = trades.length ? trades[trades.length - 1] : null;
    const openIndex = trades.findIndex(isOpenTrade);
    const closedCount = all && Number.isInteger(all.totalTrades) ? all.totalTrades : null;
    const trailingOpenIndexes = closedCount != null && trades.length > closedCount
      ? trades.slice(closedCount).map((unused, index) => closedCount + index)
      : [];
    const entryTimes = trades.map((trade) => legTime(trade, ['entry', 'e'])).filter(Number.isFinite);
    let ascending = true;
    let descending = true;
    for (let index = 1; index < entryTimes.length; index += 1) {
      if (entryTimes[index] < entryTimes[index - 1]) ascending = false;
      if (entryTimes[index] > entryTimes[index - 1]) descending = false;
    }
    const candidates = {};
    candidateScalars(report, 'report', 2, candidates);
    candidateScalars(performance, 'performance', 2, candidates);
    const settingsCandidates = {};
    const settingsCandidateShapes = {};
    if (settings) {
      for (const key of Object.keys(settings).sort()) {
        if (/(deep|backtest|range|date|from|to|mode)/i.test(key)) {
          settingsCandidates[key] = typeOf(settings[key]);
          settingsCandidateShapes[key] = boundedShape(settings[key], 2);
        }
      }
    }

    return {
      active_source_matches: active === strategy,
      source_method_names: methodNames(strategy),
      source_observables: {
        status: typeof strategy.status === 'function' ? readObservable(strategy.status) : '<unavailable>',
        calculation_time: typeof strategy.calculationTime === 'function' ? readObservable(strategy.calculationTime) : '<unavailable>',
        active_state: typeof strategy.activeState === 'function' ? readObservable(strategy.activeState) : '<unavailable>',
        report_changed: strategy.reportChanged ? {
          type: typeOf(strategy.reportChanged()),
          subscribable: !!(strategy.reportChanged() && typeof strategy.reportChanged().subscribe === 'function'),
        } : '<unavailable>',
      },
      report_container: {
        type: typeOf(reportContainer),
        has_value_method: !!(reportContainer && typeof reportContainer.value === 'function'),
      },
      report: {
        available: !!report,
        first_trade_index: report ? report.firstTradeIndex ?? null : null,
        key_types: keyTypes(report),
        performance_key_types: keyTypes(performance),
        all_performance_key_types: keyTypes(all),
        settings_candidate_key_types: settingsCandidates,
        settings_candidate_shapes: settingsCandidateShapes,
        currency_available: !!(report && report.currency != null),
        candidate_scalars: candidates,
      },
      trades: {
        available: !!(report && Array.isArray(report.trades)),
        count: trades.length,
        report_total_trades: all && (all.totalTrades ?? null),
        winning_trades: all && (all.numberOfWiningTrades ?? null),
        losing_trades: all && (all.numberOfLosingTrades ?? null),
        ordering: {
          entry_time_count: entryTimes.length,
          ascending,
          descending,
          first_entry_time: entryTimes.length ? entryTimes[0] : null,
          last_entry_time: entryTimes.length ? entryTimes[entryTimes.length - 1] : null,
        },
        first: boundedShape(firstTrade, 3),
        last: boundedShape(lastTrade, 3),
        first_summary: tradeSummary(firstTrade, 0),
        last_summary: tradeSummary(lastTrade, trades.length - 1),
        open_trade_index: openIndex >= 0 ? openIndex : null,
        open: openIndex >= 0 ? boundedShape(trades[openIndex], 3) : null,
        open_summary: openIndex >= 0 ? tradeSummary(trades[openIndex], openIndex) : null,
        trailing_open_indexes: trailingOpenIndexes,
      },
      orders: {
        available: Array.isArray(orders),
        count: Array.isArray(orders) ? orders.length : null,
        first_key_types: Array.isArray(orders) && orders.length ? keyTypes(orders[0]) : {},
      },
    };
  }, [options.entity_id]);

  if (probe?.error) throw new Error(probe.error);
  let freshness = null;
  if (options.switch_symbol) {
    freshness = await callPageFunction(async function probeStrategyFreshness(entityId, requestedSymbol) {
      function wait(milliseconds) {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
      }

      function valueOf(candidate) {
        try { return candidate && typeof candidate.value === 'function' ? candidate.value() : candidate; } catch { return null; }
      }

      function idOf(source) {
        try { return String(typeof source.id === 'function' ? source.id() : source.id); } catch { return null; }
      }

      function hash(text) {
        let result = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
          result ^= text.charCodeAt(index);
          result = Math.imul(result, 16777619);
        }
        return (result >>> 0).toString(16).padStart(8, '0');
      }

      function canonicalSymbol(symbol) {
        return String(symbol).replace(/^([^:]+)_DLY:/, '$1:');
      }

      const chart = globalThis.TradingViewApi._activeChartWidgetWV.value();
      const chartModel = chart._chartWidget.model();
      const internalModel = chartModel.model();
      const strategy = (internalModel.dataSources() || []).find((source) => idOf(source) === String(entityId));
      if (!strategy) return { error: 'Strategy source not found in active pane model' };
      const originalSymbol = chart.symbol();
      if (String(originalSymbol) === String(requestedSymbol)) return { error: 'switch-symbol must differ from the current symbol' };

      let reportChangedEvents = 0;
      let statusChangedEvents = 0;
      let reportDelegate = null;
      let statusDelegate = null;
      const onReportChanged = () => { reportChangedEvents += 1; };
      const onStatusChanged = () => { statusChangedEvents += 1; };
      try {
        reportDelegate = typeof strategy.reportChanged === 'function' ? strategy.reportChanged() : null;
        if (reportDelegate && typeof reportDelegate.subscribe === 'function') reportDelegate.subscribe(null, onReportChanged);
      } catch {}
      try {
        statusDelegate = typeof strategy.onStatusChanged === 'function' ? strategy.onStatusChanged() : null;
        if (statusDelegate && typeof statusDelegate.subscribe === 'function') statusDelegate.subscribe(null, onStatusChanged);
      } catch {}

      function sample(expectedSymbol) {
        let report = null;
        try { report = valueOf(strategy.reportData()); } catch {}
        const performance = report && report.performance ? valueOf(report.performance) : null;
        const all = performance && performance.all ? valueOf(performance.all) : null;
        const trades = report && Array.isArray(report.trades) ? report.trades : [];
        const first = trades[0] || {};
        const last = trades[trades.length - 1] || {};
        const signatureComponents = {
          currency: report ? report.currency ?? null : null,
          first_trade_index: report ? report.firstTradeIndex ?? null : null,
          trade_count: trades.length,
          total_trades: all ? all.totalTrades ?? null : null,
          open_trades: all ? all.totalOpenTrades ?? null : null,
          net_profit: all ? all.netProfit ?? null : null,
          winning_trades: all ? all.numberOfWiningTrades ?? null : null,
          losing_trades: all ? all.numberOfLosingTrades ?? null : null,
          first_entry_time: first.e ? first.e.tm ?? null : null,
          last_entry_time: last.e ? last.e.tm ?? null : null,
          last_exit_time: last.x ? last.x.tm ?? null : null,
          last_cumulative_profit: last.cp ? last.cp.v ?? null : null,
        };
        let status = null;
        try { status = valueOf(strategy.status()); } catch {}
        let calculationTime = null;
        try { calculationTime = valueOf(strategy.calculationTime()); } catch {}
        return {
          symbol_exact_match: String(chart.symbol()) === String(expectedSymbol),
          symbol_matches_expected: canonicalSymbol(chart.symbol()) === canonicalSymbol(expectedSymbol),
          report_available: !!(report && performance),
          status_type: status && typeof status === 'object' ? status.type ?? null : status,
          calculation_time: typeof calculationTime === 'number' ? calculationTime : null,
          signature_hash: hash(JSON.stringify(signatureComponents)),
        };
      }

      async function observe(expectedSymbol, previousHash) {
        const timeline = [];
        let lastKey = null;
        let stableCount = 0;
        let lastSignature = null;
        for (let attempt = 0; attempt < 45; attempt += 1) {
          const current = sample(expectedSymbol);
          const key = JSON.stringify(current);
          if (key !== lastKey) {
            timeline.push({ elapsed_ms: attempt * 100, ...current });
            lastKey = key;
          }
          if (current.symbol_matches_expected && current.report_available && current.signature_hash !== previousHash) {
            stableCount = current.signature_hash === lastSignature ? stableCount + 1 : 1;
            lastSignature = current.signature_hash;
            if (stableCount >= 3) return { ready: true, timeline, final: current };
          } else {
            stableCount = 0;
            lastSignature = current.signature_hash;
          }
          await wait(100);
        }
        const final = sample(expectedSymbol);
        return { ready: false, timeline, final };
      }

      const before = sample(originalSymbol);
      let switched = null;
      let restored = null;
      try {
        chart.setSymbol(requestedSymbol, {});
        switched = await observe(requestedSymbol, before.signature_hash);
        chart.setSymbol(originalSymbol, {});
        restored = await observe(originalSymbol, switched.final.signature_hash);
      } finally {
        if (String(chart.symbol()) !== String(originalSymbol)) {
          chart.setSymbol(originalSymbol, {});
          await wait(700);
        }
        try {
          if (reportDelegate && typeof reportDelegate.unsubscribe === 'function') reportDelegate.unsubscribe(null, onReportChanged);
        } catch {}
        try {
          if (statusDelegate && typeof statusDelegate.unsubscribe === 'function') statusDelegate.unsubscribe(null, onStatusChanged);
        } catch {}
      }

      return {
        before,
        switched,
        restored,
        events: {
          report_changed: reportChangedEvents,
          status_changed: statusChangedEvents,
        },
        original_symbol_restored: canonicalSymbol(chart.symbol()) === canonicalSymbol(originalSymbol),
      };
    }, [options.entity_id, options.switch_symbol]);
    if (freshness?.error) throw new Error(freshness.error);
  }

  console.log(JSON.stringify({
    schema_version: 1,
    context: {
      tab_index: context.tab_index,
      pane_index: context.pane_index,
      entity_id: '<strategy-entity>',
      symbol: '<symbol>',
      resolution: context.resolution,
    },
    probe,
    ...(freshness && { freshness }),
  }, null, 2));
} finally {
  await disconnect();
}
