/**
 * Core data access logic.
 */
import { evaluate, evaluateAsync, KNOWN_PATHS, safeString } from '../connection.js';
import { waitForChartReady } from '../wait.js';
import {
  getStrategyEquity,
  getStrategyReport,
  getStrategyTrades,
} from './strategy.js';
import { unixSecondsToIso, withUnixSecondsIso } from './time.js';

const MAX_OHLCV_BARS = 500;
const DEFAULT_HISTORY_BARS_PER_REQUEST = 1000;
const DEFAULT_HISTORY_MAX_REQUESTS = 100;
const DEFAULT_HISTORY_MAX_BARS = 50000;
const MAX_HISTORY_BARS_PER_REQUEST = 5000;
const MAX_HISTORY_REQUESTS = 500;
const MAX_HISTORY_BARS = 200000;

// Round to 8 dp — enough to kill float noise (29899.999999997 → 29900) without
// destroying precision on forex/crypto prices. The old 2-dp rounding flattened
// sub-cent levels to 0.00 (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);
const CHART_API = KNOWN_PATHS.chartApi;
const BARS_PATH = KNOWN_PATHS.mainSeriesBars;

// Serialize data calls that may temporarily mutate the shared chart. Without
// one shared lock, quote_get(symbol) and data_get_history(symbol) could race
// and read or restore each other's symbol/timeframe.
let _chartDataLock = Promise.resolve();

function withChartDataLock(task) {
  const run = _chartDataLock.then(task);
  _chartDataLock = run.then(() => {}, () => {});
  return run;
}

function requireIntegerInRange(value, fallback, min, max, name) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseHistoryFrom(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw new Error(`Invalid from value: ${value}`);
    return Math.floor(numeric > 1e12 ? numeric / 1000 : numeric);
  }
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid from date: ${value}`);
  return Math.floor(timestamp / 1000);
}

function historyRuntime(deps) {
  const evaluateFn = deps?.evaluate || evaluate;
  const evaluateAsyncFn = deps?.evaluateAsync || evaluateAsync;
  const waitForReady = deps?.waitForChartReady || waitForChartReady;
  return {
    sleep: deps?.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms))),
    pollAttempts: deps?.pollAttempts || 20,
    getChartState: deps?.getChartState || (() => evaluateFn(`(function() {
      var chart = ${CHART_API};
      return { symbol: chart.symbol(), timeframe: chart.resolution() };
    })()`)),
    setChart: deps?.setChart || (async ({ symbol, timeframe }) => {
      if (symbol) {
        await evaluateAsyncFn(`(function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(symbol)}, {});
            setTimeout(resolve, 500);
          });
        })()`);
        await waitForReady(symbol);
      }
      if (timeframe) {
        await evaluateFn(`(function() {
          ${CHART_API}.setResolution(${safeString(timeframe)}, {});
        })()`);
        await waitForReady(null, timeframe);
      }
    }),
    readSnapshot: deps?.readSnapshot || ((beforeTime = null) => evaluateFn(`(function() {
      var chart = ${CHART_API};
      var series = chart._chartWidget.model().mainSeries();
      var bars = series.bars();
      if (!bars || typeof bars.firstIndex !== 'function') return null;
      var firstIndex = bars.firstIndex();
      var lastIndex = bars.lastIndex();
      var first = bars.valueAt(firstIndex);
      var last = bars.valueAt(lastIndex);
      var result = [];
      var before = ${beforeTime == null ? 'null' : Number(beforeTime)};
      for (var i = firstIndex; i <= lastIndex; i++) {
        var v = bars.valueAt(i);
        if (v && (before == null || v[0] < before)) {
          result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
      }
      var more = true;
      try { more = series.requestMoreDataAvailable(); } catch (e) {}
      return {
        symbol: chart.symbol(), resolution: chart.resolution(),
        first_time: first && first[0], last_time: last && last[0],
        total_loaded: bars.size(), more: more, bars: result
      };
    })()`)),
    requestMore: deps?.requestMore || ((barsPerRequest) => evaluateAsyncFn(`(function() {
      var series = ${CHART_API}._chartWidget.model().mainSeries();
      var pending = series.requestMoreData(${barsPerRequest});
      return pending && typeof pending.then === 'function' ? pending : true;
    })()`)),
  };
}

function buildGraphicsJS(collectionName, mapKey, filter) {
  return `
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      var filter = ${safeString(filter || '')};
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          if (filter && name.indexOf(filter) === -1) continue;
          var g = s._graphics;
          if (!g || !g._primitivesCollection) continue;
          var pc = g._primitivesCollection;
          var items = [];
          try {
            var outer = pc.${collectionName};
            if (outer) {
              var inner = outer.get('${mapKey}');
              if (inner) {
                var coll = inner.get(false);
                if (coll && coll._primitivesDataById && coll._primitivesDataById.size > 0) {
                  coll._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            }
          } catch(e) {}
          if (items.length === 0 && '${collectionName}' === 'dwgtablecells') {
            try {
              var tcOuter = pc.dwgtablecells;
              if (tcOuter) {
                var tcColl = tcOuter.get('tableCells');
                if (tcColl && tcColl._primitivesDataById && tcColl._primitivesDataById.size > 0) {
                  tcColl._primitivesDataById.forEach(function(v, id) { items.push({id: id, raw: v}); });
                }
              }
            } catch(e) {}
          }
          if (items.length > 0) results.push({name: name, count: items.length, items: items});
        } catch(e) {}
      }
      return results;
    })()
  `;
}

export async function getOhlcv({ count, summary } = {}) {
  const limit = Math.min(count || 100, MAX_OHLCV_BARS);
  let data;
  try {
    data = await evaluate(`
      (function() {
        var bars = ${BARS_PATH};
        if (!bars || typeof bars.lastIndex !== 'function') return null;
        var result = [];
        var end = bars.lastIndex();
        var start = Math.max(bars.firstIndex(), end - ${limit} + 1);
        for (var i = start; i <= end; i++) {
          var v = bars.valueAt(i);
          if (v) result.push({time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0});
        }
        return {bars: result, total_bars: bars.size(), source: 'direct_bars'};
      })()
    `);
  } catch { data = null; }

  if (!data || !data.bars || data.bars.length === 0) {
    throw new Error('Could not extract OHLCV data. The chart may still be loading.');
  }

  const barsWithIso = data.bars.map(bar => withUnixSecondsIso(bar, ['time']));

  if (summary) {
    const bars = barsWithIso;
    const highs = bars.map(b => b.high);
    const lows = bars.map(b => b.low);
    const volumes = bars.map(b => b.volume);
    const first = bars[0];
    const last = bars[bars.length - 1];
    return {
      success: true, bar_count: bars.length,
      period: withUnixSecondsIso({ from: first.time, to: last.time }, ['from', 'to']),
      open: first.open, close: last.close,
      high: Math.max(...highs), low: Math.min(...lows),
      range: roundPrice(Math.max(...highs) - Math.min(...lows)),
      change: roundPrice(last.close - first.open),
      change_pct: Math.round(((last.close - first.open) / first.open) * 10000) / 100 + '%',
      avg_volume: Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length),
      last_5_bars: bars.slice(-5),
    };
  }

  return { success: true, bar_count: barsWithIso.length, total_available: data.total_bars, source: data.source, bars: barsWithIso };
}

/**
 * Load older OHLCV batches from the active TradingView chart.
 * "Complete" means the requested start time was reached or TradingView
 * reported that no older data is available for the account/symbol/resolution.
 */
export async function getHistory(options = {}) {
  return withChartDataLock(() => _getHistoryInternal(options));
}

async function _getHistoryInternal({
  symbol,
  timeframe,
  from,
  bars_per_request,
  max_requests,
  max_bars,
  include_bars = false,
  restore_chart = true,
  _deps,
} = {}) {
  const barsPerRequest = requireIntegerInRange(bars_per_request, DEFAULT_HISTORY_BARS_PER_REQUEST, 100, MAX_HISTORY_BARS_PER_REQUEST, 'bars_per_request');
  const maxRequests = requireIntegerInRange(max_requests, DEFAULT_HISTORY_MAX_REQUESTS, 1, MAX_HISTORY_REQUESTS, 'max_requests');
  const maxBars = requireIntegerInRange(max_bars, DEFAULT_HISTORY_MAX_BARS, 1, MAX_HISTORY_BARS, 'max_bars');
  const fromTime = parseHistoryFrom(from);
  const runtime = historyRuntime(_deps);
  const original = await runtime.getChartState();
  const requestedSymbol = symbol ? String(symbol).trim() : null;
  const requestedTimeframe = timeframe ? String(timeframe).trim() : null;
  const needsSymbolChange = requestedSymbol && requestedSymbol !== original?.symbol;
  const needsTimeframeChange = requestedTimeframe && requestedTimeframe !== String(original?.timeframe || '');
  const shouldRestore = Boolean(restore_chart && (needsSymbolChange || needsTimeframeChange));
  let chartMutationAttempted = false;

  try {
    if (needsSymbolChange || needsTimeframeChange) {
      chartMutationAttempted = true;
      await runtime.setChart({
        symbol: needsSymbolChange ? requestedSymbol : null,
        timeframe: needsTimeframeChange ? requestedTimeframe : null,
      });
    }

    const barsByTime = new Map();
    let snapshot = await runtime.readSnapshot();
    if (!snapshot || !Array.isArray(snapshot.bars) || snapshot.bars.length === 0) {
      throw new Error('Could not read historical bars. The chart may still be loading.');
    }

    const addBars = (bars) => {
      for (const bar of bars || []) {
        if (bar?.time != null) barsByTime.set(Number(bar.time), bar);
      }
    };
    addBars(snapshot.bars);
    const relevantBarCount = () => {
      if (fromTime == null) return barsByTime.size;
      let count = 0;
      for (const time of barsByTime.keys()) if (time >= fromTime) count += 1;
      return count;
    };

    let requestsMade = 0;
    let stopReason = null;
    while (!stopReason) {
      const relevantCount = relevantBarCount();
      if (relevantCount > maxBars) {
        stopReason = 'max_bars';
        break;
      }
      if (fromTime != null && snapshot.first_time <= fromTime) {
        stopReason = 'from_reached';
        break;
      }
      if (snapshot.more === false) {
        stopReason = 'no_more_data';
        break;
      }
      if (requestsMade >= maxRequests) {
        stopReason = 'max_requests';
        break;
      }
      if (relevantCount === maxBars) {
        stopReason = 'max_bars';
        break;
      }

      const previousFirst = snapshot.first_time;
      await runtime.requestMore(barsPerRequest);
      requestsMade += 1;

      let next = null;
      for (let attempt = 0; attempt < runtime.pollAttempts; attempt++) {
        next = await runtime.readSnapshot(previousFirst);
        const movedBack = next?.first_time != null && next.first_time < previousFirst;
        if (movedBack || next?.more === false) break;
        await runtime.sleep(250);
      }

      if (!next || next.first_time == null) {
        stopReason = 'read_failed';
        break;
      }
      addBars(next.bars);
      if (next.first_time >= previousFirst && next.more !== false) {
        snapshot = next;
        stopReason = 'no_progress';
        break;
      }
      snapshot = next;
    }

    let bars = [...barsByTime.values()].sort((a, b) => a.time - b.time);
    if (fromTime != null) bars = bars.filter(bar => bar.time >= fromTime);
    if (bars.length > maxBars) bars = bars.slice(-maxBars);
    if (bars.length === 0) {
      throw new Error('No historical bars matched the requested start time.');
    }
    bars = bars.map(bar => withUnixSecondsIso(bar, ['time']));

    const complete = stopReason === 'from_reached' || stopReason === 'no_more_data';
    const result = {
      success: true,
      complete,
      stop_reason: stopReason,
      symbol: snapshot.symbol || requestedSymbol || original?.symbol || null,
      timeframe: snapshot.resolution || requestedTimeframe || original?.timeframe || null,
      requested_from: fromTime,
      requested_from_iso: unixSecondsToIso(fromTime),
      period: withUnixSecondsIso({ from: bars[0].time, to: bars[bars.length - 1].time }, ['from', 'to']),
      bar_count: bars.length,
      requests_made: requestsMade,
      bars_per_request: barsPerRequest,
      max_requests: maxRequests,
      max_bars: maxBars,
      source: 'tradingview_chart_history',
    };
    if (include_bars) result.bars = bars;
    return result;
  } finally {
    if (shouldRestore && chartMutationAttempted) {
      await runtime.setChart({
        symbol: needsSymbolChange ? original.symbol : null,
        timeframe: needsTimeframeChange ? original.timeframe : null,
      });
    }
  }
}

export async function getIndicator({ entity_id }) {
  const data = await evaluate(`
    (function() {
      var api = ${CHART_API};
      var study = api.getStudyById(${safeString(entity_id)});
      if (!study) return { error: 'Study not found: ' + ${safeString(entity_id)} };
      var result = { name: null, inputs: null, visible: null };
      try { result.visible = study.isVisible(); } catch(e) {}
      try { result.inputs = study.getInputValues(); } catch(e) { result.inputs_error = e.message; }
      return result;
    })()
  `);

  if (data?.error) throw new Error(data.error);

  let inputs = data?.inputs;
  if (Array.isArray(inputs)) {
    inputs = inputs.filter(inp => {
      if (inp.id === 'text' && typeof inp.value === 'string' && inp.value.length > 200) return false;
      if (typeof inp.value === 'string' && inp.value.length > 500) return false;
      return true;
    });
  }
  return { success: true, entity_id, visible: data?.visible, inputs };
}

export async function getStrategyResults({ entity_id } = {}) {
  if (!entity_id) throw new Error('entity_id is required; implicit Strategy selection is no longer supported.');
  return getStrategyReport({ entity_id });
}

export async function getTrades({ entity_id, max_trades } = {}) {
  if (!entity_id) throw new Error('entity_id is required; implicit Strategy selection is no longer supported.');
  return getStrategyTrades({ entity_id, limit: max_trades });
}

export async function getEquity({ entity_id } = {}) {
  if (!entity_id) throw new Error('entity_id is required; implicit Strategy selection is no longer supported.');
  return getStrategyEquity({ entity_id });
}

export async function getQuote({ symbol } = {}) {
  return withChartDataLock(() => _getQuoteInternal({ symbol }));
}

async function _getQuoteInternal({ symbol } = {}) {
  const requested = (symbol || '').toString().trim();
  let originalSymbol = null;
  let needsRestore = false;

  if (requested) {
    try { originalSymbol = await evaluate(`${CHART_API}.symbol()`); } catch (e) {}
    const bare = (s) => (s || '').toString().split(':').pop().toUpperCase();
    if (bare(originalSymbol) !== bare(requested)) {
      needsRestore = true;
      await evaluateAsync(`
        (function() {
          var chart = ${CHART_API};
          return new Promise(function(resolve) {
            chart.setSymbol(${safeString(requested)}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(requested);
    }
  }

  try {
    const data = await evaluate(`
      (function() {
        var api = ${CHART_API};
        var sym = '';
        try { sym = api.symbol(); } catch(e) {}
        if (!sym) { try { sym = api.symbolExt().symbol; } catch(e) {} }
        var ext = {};
        try { ext = api.symbolExt() || {}; } catch(e) {}
        var bars = ${BARS_PATH};
        var quote = { symbol: sym };
        if (bars && typeof bars.lastIndex === 'function') {
          var last = bars.valueAt(bars.lastIndex());
          if (last) { quote.time = last[0]; quote.open = last[1]; quote.high = last[2]; quote.low = last[3]; quote.close = last[4]; quote.last = last[4]; quote.volume = last[5] || 0; }
        }
        try {
          var bidEl = document.querySelector('[class*="bid"] [class*="price"], [class*="dom-"] [class*="bid"]');
          var askEl = document.querySelector('[class*="ask"] [class*="price"], [class*="dom-"] [class*="ask"]');
          if (bidEl) quote.bid = parseFloat(bidEl.textContent.replace(/[^0-9.\\-]/g, ''));
          if (askEl) quote.ask = parseFloat(askEl.textContent.replace(/[^0-9.\\-]/g, ''));
        } catch(e) {}
        try {
          var hdr = document.querySelector('[class*="headerRow"] [class*="last-"]');
          if (hdr) { var hdrPrice = parseFloat(hdr.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(hdrPrice)) quote.header_price = hdrPrice; }
        } catch(e) {}
        if (ext.description) quote.description = ext.description;
        if (ext.exchange) quote.exchange = ext.exchange;
        if (ext.type) quote.type = ext.type;
        return quote;
      })()
    `);
    if (!data || (!data.last && !data.close)) throw new Error('Could not retrieve quote. The chart may still be loading.');
    return { success: true, ...withUnixSecondsIso(data, ['time']) };
  } finally {
    if (needsRestore && originalSymbol) {
      try {
        await evaluateAsync(`
          (function() {
            var chart = ${CHART_API};
            return new Promise(function(resolve) {
              chart.setSymbol(${safeString(originalSymbol)}, {});
              setTimeout(resolve, 500);
            });
          })()
        `);
        await waitForChartReady(originalSymbol);
      } catch (e) {}
    }
  }
}

export async function getDepth() {
  const data = await evaluate(`
    (function() {
      var domPanel = document.querySelector('[class*="depth"]')
        || document.querySelector('[class*="orderBook"]')
        || document.querySelector('[class*="dom-"]')
        || document.querySelector('[class*="DOM"]')
        || document.querySelector('[data-name="dom"]');
      if (!domPanel) return { found: false, error: 'DOM / Depth of Market panel not found.' };
      var bids = [], asks = [];
      var rows = domPanel.querySelectorAll('[class*="row"], tr');
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var priceEl = row.querySelector('[class*="price"]');
        var sizeEl = row.querySelector('[class*="size"], [class*="volume"], [class*="qty"]');
        if (!priceEl) continue;
        var price = parseFloat(priceEl.textContent.replace(/[^0-9.\\-]/g, ''));
        var size = sizeEl ? parseFloat(sizeEl.textContent.replace(/[^0-9.\\-]/g, '')) : 0;
        if (isNaN(price)) continue;
        var rowClass = row.className || '';
        var rowHTML = row.innerHTML || '';
        if (/bid|buy/i.test(rowClass) || /bid|buy/i.test(rowHTML)) bids.push({ price, size });
        else if (/ask|sell/i.test(rowClass) || /ask|sell/i.test(rowHTML)) asks.push({ price, size });
        else if (i < rows.length / 2) asks.push({ price, size });
        else bids.push({ price, size });
      }
      if (bids.length === 0 && asks.length === 0) {
        var cells = domPanel.querySelectorAll('[class*="cell"], td');
        var prices = [];
        cells.forEach(function(c) { var val = parseFloat(c.textContent.replace(/[^0-9.\\-]/g, '')); if (!isNaN(val) && val > 0) prices.push(val); });
        if (prices.length > 0) return { found: true, raw_values: prices.slice(0, 50), bids: [], asks: [], note: 'Could not classify bid/ask levels.' };
      }
      bids.sort(function(a, b) { return b.price - a.price; });
      asks.sort(function(a, b) { return a.price - b.price; });
      var spread = null;
      if (asks.length > 0 && bids.length > 0) spread = +(asks[0].price - bids[0].price).toFixed(6);
      return { found: true, bids: bids, asks: asks, spread: spread };
    })()
  `);

  if (!data || !data.found) throw new Error(data?.error || 'DOM panel not found.');
  return { success: true, bid_levels: data.bids?.length || 0, ask_levels: data.asks?.length || 0, spread: data.spread, bids: data.bids || [], asks: data.asks || [], raw_values: data.raw_values, note: data.note };
}

export async function getStudyValues() {
  const data = await evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget;
      var model = chart.model();
      var sources = model.model().dataSources();
      var results = [];
      for (var si = 0; si < sources.length; si++) {
        var s = sources[si];
        if (!s.metaInfo) continue;
        try {
          var meta = s.metaInfo();
          var name = meta.description || meta.shortDescription || '';
          if (!name) continue;
          var values = {};
          try {
            var dwv = s.dataWindowView();
            if (dwv) {
              var items = dwv.items();
              if (items) {
                for (var i = 0; i < items.length; i++) {
                  var item = items[i];
                  if (item._value && item._value !== '∅' && item._title) values[item._title] = item._value;
                }
              }
            }
          } catch(e) {}
          // Include id + inputs so multiple instances of the same indicator
          // (e.g. two EMAs with different lengths) are distinguishable (#143).
          var id = null;
          try { id = s.id ? s.id() : null; } catch(e) {}
          var inputs = null;
          try { var ip = s.inputs ? s.inputs() : null; if (ip && Object.keys(ip).length) inputs = ip; } catch(e) {}
          if (Object.keys(values).length > 0) results.push({ id: id, name: name, inputs: inputs, values: values });
        } catch(e) {}
      }
      return results;
    })()
  `);
  return { success: true, study_count: data?.length || 0, studies: data || [] };
}

export async function getPineLines({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglines', 'lines', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const hLevels = [];
    const seen = {};
    const allLines = [];
    for (const item of s.items) {
      const v = item.raw;
      const y1 = roundPrice(v.y1);
      const y2 = roundPrice(v.y2);
      if (verbose) allLines.push({ id: item.id, y1, y2, x1: v.x1, x2: v.x2, horizontal: v.y1 === v.y2, style: v.st, width: v.w, color: v.ci });
      if (y1 != null && v.y1 === v.y2 && !seen[y1]) { hLevels.push(y1); seen[y1] = true; }
    }
    hLevels.sort((a, b) => b - a);
    const result = { name: s.name, total_lines: s.count, horizontal_levels: hLevels };
    if (verbose) result.all_lines = allLines;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineLabels({ study_filter, max_labels, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwglabels', 'labels', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const limit = max_labels || 50;
  const studies = raw.map(s => {
    let labels = s.items.map(item => {
      const v = item.raw;
      const text = v.t || '';
      const price = roundPrice(v.y);
      if (verbose) return { id: item.id, text, price, x: v.x, yloc: v.yl, size: v.sz, textColor: v.tci, color: v.ci };
      return { text, price };
    }).filter(l => l.text || l.price != null);
    if (labels.length > limit) labels = labels.slice(-limit);
    return { name: s.name, total_labels: s.count, showing: labels.length, labels };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineTables({ study_filter } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgtablecells', 'tableCells', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const tables = {};
    for (const item of s.items) {
      const v = item.raw;
      const tid = v.tid || 0;
      if (!tables[tid]) tables[tid] = {};
      if (!tables[tid][v.row]) tables[tid][v.row] = {};
      tables[tid][v.row][v.col] = v.t || '';
    }
    const tableList = Object.entries(tables).map(([tid, rows]) => {
      const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
      const formatted = rowNums.map(rn => {
        const cols = rows[rn];
        const colNums = Object.keys(cols).map(Number).sort((a, b) => a - b);
        return colNums.map(cn => cols[cn]).filter(Boolean).join(' | ');
      }).filter(Boolean);
      return { rows: formatted };
    });
    return { name: s.name, tables: tableList };
  });
  return { success: true, study_count: studies.length, studies };
}

export async function getPineBoxes({ study_filter, verbose } = {}) {
  const filter = study_filter || '';
  const raw = await evaluate(buildGraphicsJS('dwgboxes', 'boxes', filter));
  if (!raw || raw.length === 0) return { success: true, study_count: 0, studies: [] };

  const studies = raw.map(s => {
    const zones = [];
    const seen = {};
    const allBoxes = [];
    for (const item of s.items) {
      const v = item.raw;
      const high = v.y1 != null && v.y2 != null ? roundPrice(Math.max(v.y1, v.y2)) : null;
      const low = v.y1 != null && v.y2 != null ? roundPrice(Math.min(v.y1, v.y2)) : null;
      if (verbose) allBoxes.push({ id: item.id, high, low, x1: v.x1, x2: v.x2, borderColor: v.c, bgColor: v.bc });
      if (high != null && low != null) { const key = high + ':' + low; if (!seen[key]) { zones.push({ high, low }); seen[key] = true; } }
    }
    zones.sort((a, b) => b.high - a.high);
    const result = { name: s.name, total_boxes: s.count, zones };
    if (verbose) result.all_boxes = allBoxes;
    return result;
  });
  return { success: true, study_count: studies.length, studies };
}
