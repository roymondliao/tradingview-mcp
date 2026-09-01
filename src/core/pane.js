/**
 * Core pane/layout management logic.
 * Controls multi-chart layouts (split panes) in TradingView.
 */
import { evaluate, evaluateAsync, getTargetInfo, reconnectTo, safeString } from '../connection.js';
import { attachTab, identifyTab } from './tab.js';
import { CoreOperationError } from './errors.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';

const LAYOUT_NAMES = {
  's': '1 chart',
  '2h': '2 horizontal',
  '2v': '2 vertical',
  '2-1': '2 top, 1 bottom',
  '1-2': '1 top, 2 bottom',
  '3h': '3 horizontal',
  '3v': '3 vertical',
  '3s': '3 custom',
  '4': '2x2 grid',
  '4h': '4 horizontal',
  '4v': '4 vertical',
  '4s': '4 custom',
  '6': '6 charts',
  '8': '8 charts',
  '10': '10 charts',
  '12': '12 charts',
  '14': '14 charts',
  '16': '16 charts',
};

/**
 * List all panes in the current layout with their symbols and index.
 */
export async function list() {
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var layoutType = cwc._layoutType;
      if (typeof layoutType === 'object' && layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();

      var all = cwc.getAll();
      var saver = window.TradingViewApi._saveChartService && window.TradingViewApi._saveChartService._chartSaver;
      var saved = saver && saver._prevChartState ? saver._prevChartState : null;
      var savedContent = null;
      try { savedContent = saved && saved.content ? JSON.parse(saved.content) : null; } catch (e) {}
      var savedCharts = savedContent && Array.isArray(savedContent.charts) ? savedContent.charts : [];
      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var mainSeries = model ? model.mainSeries() : null;
          var sym = mainSeries ? mainSeries.symbol() : 'unknown';
          var res = mainSeries ? mainSeries.interval() : null;
          panes.push({
            index: i,
            pane_index: i,
            pane_id: savedCharts[i] && savedCharts[i].chartId != null ? String(savedCharts[i].chartId) : null,
            symbol: sym,
            resolution: res || null
          });
        } catch(e) { panes.push({ index: i, pane_index: i, pane_id: null, error: e.message }); }
      }

      // Check which pane is active
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeIndex = null;
      for (var j = 0; j < all.length; j++) {
        try {
          if (all[j].model && activeChart._chartWidget && all[j] === activeChart._chartWidget) { activeIndex = j; break; }
        } catch(e) {}
      }

      for (var k = 0; k < panes.length; k++) panes[k].active = panes[k].pane_index === activeIndex;
      return {
        layout: layoutType,
        layout_id: saved && saved.id != null ? saved.id : null,
        layout_name: saved ? (saved.name || saved.description || null) : null,
        chart_count: count,
        active_index: activeIndex,
        panes: panes
      };
    })()
  `);

  const target = await getTargetInfo();

  return {
    success: true,
    target_id: target?.id || null,
    url_chart_id: target?.url?.match(/\/chart\/([^/?]+)/)?.[1] || null,
    layout_id: result.layout_id,
    layout_name: result.layout_name,
    pane_layout: result.layout,
    pane_layout_name: LAYOUT_NAMES[result.layout] || result.layout,
    chart_count: result.chart_count,
    active_index: result.active_index,
    panes: result.panes,
  };
}

/**
 * Set the chart layout grid.
 * @param {string} layout - Layout code: s, 2h, 2v, 2-1, 1-2, 3h, 3v, 4, 6, 8, etc.
 */
export async function setLayout({ layout }) {
  const code = layout.toLowerCase().replace(/\s+/g, '');

  // Map friendly names to codes
  const aliases = {
    'single': 's', '1': 's', '1x1': 's',
    '2x1': '2h', '1x2': '2v',
    '2x2': '4', 'grid': '4', 'quad': '4',
    '3x1': '3h', '1x3': '3v',
  };
  const resolved = aliases[code] || code;

  if (!LAYOUT_NAMES[resolved]) {
    const available = Object.entries(LAYOUT_NAMES).map(([k, v]) => `  ${k} — ${v}`).join('\n');
    throw new Error(`Unknown layout "${layout}". Available layouts:\n${available}`);
  }

  await evaluateAsync(`${CWC}.setLayout(${safeString(resolved)})`);
  await new Promise(r => setTimeout(r, 500));

  const state = await list();
  return {
    success: true,
    pane_layout: resolved,
    pane_layout_name: LAYOUT_NAMES[resolved],
    chart_count: state.chart_count,
    panes: state.panes,
  };
}

/**
 * Focus a specific pane by index.
 */
export async function focus({ index }) {
  const idx = Number(index);
  if (!Number.isInteger(idx) || idx < 0) throw new Error('Pane index must be a non-negative integer');
  const result = await evaluate(`
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      if (${idx} >= all.length) return { error: 'Pane index ' + ${idx} + ' out of range (have ' + all.length + ' panes)' };
      var chart = all[${idx}];
      try {
        if (window.TradingViewApi && typeof window.TradingViewApi._activateChart === 'function') {
          window.TradingViewApi._activateChart(chart);
        }
      } catch (e) {}
      if (chart._mainDiv) {
        try { chart._mainDiv.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); } catch (e) {}
        chart._mainDiv.click();
      }
      return { focused: ${idx}, total: all.length };
    })()
  `);

  if (result?.error) throw new Error(result.error);
  for (let attempt = 0; attempt < 10; attempt++) {
    const state = await list();
    if (state.active_index === idx) {
      const pane = state.panes.find((item) => item.pane_index === idx);
      return {
        success: true,
        focused_index: idx,
        pane_id: pane?.pane_id || null,
        total_panes: result.total,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Pane focus readback failed for index ${idx}`);
}

/** Resolve an explicit Tab/Layout/Pane selector and return the chosen context. */
export async function prepareContext({ tab_index, url_chart_id, layout_id, pane_index, _deps } = {}) {
  const attach = _deps?.attachTab || attachTab;
  const identify = _deps?.identifyTab || identifyTab;
  const listPanes = _deps?.list || list;
  const focusPane = _deps?.focus || focus;
  const attached = await attach({ tab_index, url_chart_id, layout_id });
  let inventory = await listPanes();
  if (layout_id != null && String(inventory.layout_id) !== String(layout_id)) {
    throw new Error(`Attached Layout ${inventory.layout_id} does not match requested layout_id ${layout_id}`);
  }
  let selectedIndex;
  if (pane_index != null) {
    selectedIndex = Number(pane_index);
    await focusPane({ index: selectedIndex });
    inventory = await listPanes();
  } else {
    selectedIndex = inventory.active_index;
    if (selectedIndex == null && inventory.panes.length === 1) selectedIndex = 0;
    if (selectedIndex == null) {
      throw new Error('Active Pane is unresolved; provide pane_index explicitly.');
    }
  }
  const selectedPane = inventory.panes.find((pane) => pane.pane_index === selectedIndex);
  if (!selectedPane) throw new Error(`Pane index ${selectedIndex} not found in selected Layout.`);
  const tabIdentity = attached || await identify(inventory.target_id);
  return {
    tab_index: tabIdentity?.tab_index ?? tab_index ?? null,
    target_id: inventory.target_id,
    url_chart_id: inventory.url_chart_id,
    layout_id: inventory.layout_id,
    layout_name: inventory.layout_name,
    pane_layout: inventory.pane_layout,
    pane_index: selectedPane.pane_index,
    pane_id: selectedPane.pane_id,
    symbol: selectedPane.symbol,
    resolution: selectedPane.resolution,
  };
}

/** Normalize only runtime aliases verified by live Strategy Trading discovery. */
export function normalizeSymbolIdentity(symbol) {
  if (symbol == null) return null;
  const normalized = String(symbol).trim().toUpperCase();
  const separator = normalized.indexOf(':');
  if (separator < 1 || separator === normalized.length - 1) return normalized;
  const exchange = normalized.slice(0, separator).replace(/_DLY$/, '');
  return `${exchange}:${normalized.slice(separator + 1)}`;
}

export function symbolIdentitiesMatch(expected, actual) {
  if (expected == null || actual == null) return false;
  return normalizeSymbolIdentity(expected) === normalizeSymbolIdentity(actual);
}

function contextChanged(message, { context, phase, symbol, cause } = {}) {
  return new CoreOperationError(message, {
    code: 'PANE_CONTEXT_CHANGED',
    phase,
    symbol,
    retryable: false,
    context,
    cause,
  });
}

function assertInventoryOwnership(context, inventory, phase) {
  if (inventory.target_id !== context.target_id) {
    throw contextChanged(`Chart target changed from ${context.target_id} to ${inventory.target_id || 'unresolved'}.`, {
      context, phase,
    });
  }
  if (context.url_chart_id != null && String(inventory.url_chart_id) !== String(context.url_chart_id)) {
    throw contextChanged(`Chart URL identity changed for target ${context.target_id}.`, { context, phase });
  }
  if (context.layout_id != null && String(inventory.layout_id) !== String(context.layout_id)) {
    throw contextChanged(`Chart Layout changed from ${context.layout_id} to ${inventory.layout_id || 'unresolved'}.`, {
      context, phase,
    });
  }
  if (context.pane_layout != null && String(inventory.pane_layout) !== String(context.pane_layout)) {
    throw contextChanged(`Pane Layout changed from ${context.pane_layout} to ${inventory.pane_layout || 'unresolved'}.`, {
      context, phase,
    });
  }
  const pane = (inventory.panes || []).find((item) => item.pane_index === context.pane_index);
  if (!pane) {
    throw contextChanged(`Pane index ${context.pane_index} no longer exists in the resolved Layout.`, { context, phase });
  }
  if (context.pane_id != null && String(pane.pane_id) !== String(context.pane_id)) {
    throw contextChanged(`Pane ownership changed at index ${context.pane_index}.`, { context, phase });
  }
  return pane;
}

/**
 * Reacquire one immutable target/layout/pane identity and optionally focus it.
 * Tab index is deliberately not revalidated after resolution because closing a
 * different Desktop Tab can change ordinals without changing target identity.
 */
export async function activatePaneContext({ context, phase = 'pane_context', activate = true, reacquire = true, _deps } = {}) {
  if (!context?.target_id || !Number.isInteger(context?.pane_index)) {
    throw new CoreOperationError('Resolved context requires target_id and pane_index.', {
      code: 'CHART_SESSION_INVALID', phase, context,
    });
  }
  const identify = _deps?.identifyTab || identifyTab;
  const reconnect = _deps?.reconnectTo || reconnectTo;
  const listPanes = _deps?.list || list;
  const focusPane = _deps?.focus || focus;
  try {
    if (reacquire) {
      const tab = await identify(context.target_id);
      if (!tab) throw contextChanged(`Chart target is closed or unavailable: ${context.target_id}`, { context, phase });
      if (context.url_chart_id != null && String(tab.url_chart_id) !== String(context.url_chart_id)) {
        throw contextChanged(`Chart URL identity changed for target ${context.target_id}.`, { context, phase });
      }
      await reconnect(context.target_id);
    }

    let inventory = await listPanes();
    let pane = assertInventoryOwnership(context, inventory, phase);
    if (activate && inventory.active_index !== context.pane_index) {
      await focusPane({ index: context.pane_index });
      inventory = await listPanes();
      pane = assertInventoryOwnership(context, inventory, phase);
      if (inventory.active_index !== context.pane_index) {
        throw contextChanged(`Pane focus readback failed for index ${context.pane_index}.`, { context, phase });
      }
    }
    return {
      target_id: inventory.target_id,
      url_chart_id: inventory.url_chart_id,
      layout_id: inventory.layout_id,
      pane_layout: inventory.pane_layout,
      pane_index: pane.pane_index,
      pane_id: pane.pane_id,
      symbol: pane.symbol,
      resolution: pane.resolution,
      active: inventory.active_index === pane.pane_index,
    };
  } catch (error) {
    if (error instanceof CoreOperationError) throw error;
    if (error?.code === 'CDP_TARGET_NOT_FOUND') {
      throw contextChanged(`Chart target is closed or unavailable: ${context.target_id}`, {
        context, phase, cause: error,
      });
    }
    if (!String(error?.code || '').startsWith('CDP_')) {
      throw contextChanged(`Unable to reacquire the expected Pane context: ${error?.message || String(error)}`, {
        context, phase, cause: error,
      });
    }
    throw error;
  }
}

/** Reacquire and verify structural ownership plus expected Symbol/Timeframe. */
export async function assertPaneContext({
  context,
  symbol = context?.symbol,
  timeframe = context?.resolution,
  phase = 'pane_context',
  activate = true,
  reacquire = true,
  _deps,
} = {}) {
  const readback = await activatePaneContext({ context, phase, activate, reacquire, _deps });
  if (symbol != null && !symbolIdentitiesMatch(symbol, readback.symbol)) {
    throw contextChanged(`Pane Symbol changed from ${symbol} to ${readback.symbol || 'unresolved'}.`, {
      context, phase, symbol,
    });
  }
  if (timeframe != null && String(readback.resolution) !== String(timeframe)) {
    throw contextChanged(`Pane Timeframe changed from ${timeframe} to ${readback.resolution || 'unresolved'}.`, {
      context, phase, symbol,
    });
  }
  return readback;
}

/**
 * Set the symbol on a specific pane by index.
 * Works by focusing the pane, then using the active chart's setSymbol.
 */
export async function setSymbol({ index, symbol }) {
  const idx = Number(index);

  // Focus the target pane first
  await focus({ index: idx });
  await new Promise(r => setTimeout(r, 300));

  // Now set symbol on the now-active chart
  await evaluateAsync(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      return new Promise(function(resolve) {
        chart.setSymbol(${safeString(symbol)}, {});
        setTimeout(resolve, 500);
      });
    })()
  `);

  return { success: true, index: idx, symbol };
}
