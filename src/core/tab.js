/**
 * Core tab management logic.
 *
 * TradingView Desktop's tab bar lives in a separate Electron shell window
 * (app/window/index.html), not in the chart pages themselves. CDP-level
 * activation (/json/activate) and synthesized Ctrl+T/Ctrl+W key events do
 * not drive it (Electron accelerators don't fire from CDP input), so tab
 * switching/creation/closing click the shell window's DOM directly:
 * `.tabs-container .tab`, its close button, and `create-new-tab-button`.
 * (Approach from issue #155 and PR #163, verified on Desktop 3.1.0.)
 */
import CDP from 'chrome-remote-interface';
import { getClient, reconnectTo, CDP_HOST, CDP_PORT } from '../connection.js';

async function readTargetMetadata(targetId) {
  return withTarget(targetId, (evalIn) => evalIn(`
    (function() {
      var api = window.TradingViewApi || {};
      var cwc = api._chartWidgetCollection;
      var saver = api._saveChartService && api._saveChartService._chartSaver;
      var saved = saver && saver._prevChartState ? saver._prevChartState : null;
      var savedContent = null;
      try { savedContent = saved && saved.content ? JSON.parse(saved.content) : null; } catch (e) {}
      var savedCharts = savedContent && Array.isArray(savedContent.charts) ? savedContent.charts : [];
      var all = cwc && typeof cwc.getAll === 'function' ? cwc.getAll() : [];
      var active = api._activeChartWidgetWV && typeof api._activeChartWidgetWV.value === 'function'
        ? api._activeChartWidgetWV.value() : null;
      var activeWidget = active && active._chartWidget ? active._chartWidget : null;
      var panes = [];
      for (var i = 0; i < all.length; i++) {
        try {
          var model = all[i].model();
          var main = model.mainSeries();
          panes.push({
            pane_index: i,
            pane_id: savedCharts[i] && savedCharts[i].chartId != null ? String(savedCharts[i].chartId) : null,
            symbol: main.symbol(),
            resolution: main.interval() || null,
            active: all[i] === activeWidget
          });
        } catch (e) {
          panes.push({ pane_index: i, pane_id: null, error: e.message, active: false });
        }
      }
      var layoutType = cwc && cwc._layoutType;
      if (layoutType && typeof layoutType.value === 'function') layoutType = layoutType.value();
      return {
        visibility: document.visibilityState,
        focused: document.hasFocus(),
        layout: {
          layout_id: saved && saved.id != null ? saved.id : null,
          layout_name: saved ? (saved.name || saved.description || null) : null,
          pane_layout: layoutType || (savedContent && savedContent.layout) || null
        },
        panes: panes
      };
    })()
  `));
}

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  // Chart tabs plus new-tab landing pages (layout picker), so every tab in the
  // top bar is listable and switchable.
  const rawTabs = targets.filter(t => t.type === 'page' && (/tradingview\.com\/chart/i.test(t.url) || t.title === 'New tab'));
  const tabs = await Promise.all(rawTabs.map(async (target, tabIndex) => {
    const isChart = /tradingview\.com\/chart/i.test(target.url);
    let metadata = null;
    if (isChart) {
      try { metadata = await readTargetMetadata(target.id); } catch { /* stale target */ }
    }
    return {
      tab_index: tabIndex,
      target_id: target.id,
      title: target.title.replace(/^Live stock.*charts on /, ''),
      url: target.url,
      url_chart_id: target.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
      is_chart: isChart,
      active: metadata ? metadata.focused === true || metadata.visibility === 'visible' : false,
      visibility: metadata?.visibility || null,
      focused: metadata?.focused ?? null,
      layout: metadata?.layout || null,
      panes: metadata?.panes || [],
    };
  }));

  return { success: true, tab_count: tabs.length, tabs };
}

/** Resolve the public Tab index for an already attached CDP target. */
export async function identifyTab(targetId) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const tabs = targets.filter(t => t.type === 'page' && (/tradingview\.com\/chart/i.test(t.url) || t.title === 'New tab'));
  const tabIndex = tabs.findIndex((tab) => tab.id === targetId);
  if (tabIndex < 0) return null;
  const target = tabs[tabIndex];
  return {
    tab_index: tabIndex,
    target_id: target.id,
    url_chart_id: target.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/** Attach the process-local CDP client to an explicit Tab without changing the visible Desktop tab. */
export async function attachTab({ tab_index, url_chart_id, layout_id, _deps } = {}) {
  const selectors = [tab_index != null, url_chart_id != null, layout_id != null].filter(Boolean).length;
  if (selectors === 0) return null;
  const listTabs = _deps?.list || list;
  const reconnect = _deps?.reconnectTo || reconnectTo;
  const inventory = await listTabs();
  let candidates = inventory.tabs.filter((tab) => tab.is_chart);
  if (tab_index != null) {
    const index = Number(tab_index);
    if (!Number.isInteger(index) || index < 0) throw new Error('tab_index must be a non-negative integer');
    candidates = candidates.filter((tab) => tab.tab_index === index);
  }
  if (url_chart_id != null) candidates = candidates.filter((tab) => tab.url_chart_id === String(url_chart_id));
  if (layout_id != null) candidates = candidates.filter((tab) => String(tab.layout?.layout_id) === String(layout_id));
  if (candidates.length !== 1) {
    throw new Error(`Tab selector resolved ${candidates.length} matches; use tab list and provide a unique tab_index, url_chart_id, or layout_id.`);
  }
  const selected = candidates[0];
  await reconnect(selected.target_id);
  return selected;
}

/**
 * Run fn with a CDP client attached to the Electron shell window that owns
 * the tab bar. There can be several app/window/index.html targets; the shell
 * is the one whose DOM actually contains `.tabs-container .tab`.
 */
async function withShell(fn) {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const candidates = targets.filter(t => t.type === 'page' && /\/window\/index\.html/i.test(t.url || ''));

  for (const cand of candidates) {
    let c = null;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: cand.id });
      const probe = await c.Runtime.evaluate({
        expression: `!!document.querySelector('.tabs-container .tab')`,
        returnByValue: true,
      });
      if (probe.result?.value) {
        const out = await fn(async (expression) => {
          const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
          return result?.value;
        });
        await c.close();
        return out;
      }
      await c.close();
    } catch {
      try { if (c) await c.close(); } catch { /* already gone */ }
    }
  }
  throw new Error('TradingView shell window (tab bar) not found. Is this TradingView Desktop with tabs?');
}

/** Check whether a CDP page target is the visible one. */
async function isTargetVisible(targetId) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    const { result } = await c.Runtime.evaluate({ expression: 'document.visibilityState', returnByValue: true });
    return result?.value === 'visible';
  } catch {
    return false;
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/** Find an open new-tab landing page target (shows the layout picker). */
async function findLandingTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return targets.find(t => t.type === 'page' && t.title === 'New tab') || null;
}

/** Run fn with an eval helper attached to a specific target. */
async function withTarget(targetId, fn) {
  let c = null;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    return await fn(async (expression) => {
      const { result } = await c.Runtime.evaluate({ expression, returnByValue: true });
      return result?.value;
    });
  } finally {
    try { if (c) await c.close(); } catch { /* already gone */ }
  }
}

/**
 * Open a new chart tab by clicking the shell window's new-tab button.
 * With `layout`, also picks from the landing page's layout list:
 *   layout: 'new'    -> click "Create new layout" (blank chart, saved as Unnamed)
 *   layout: '<name>' -> open the saved layout whose title contains <name>
 * Reuses an already-open landing tab instead of opening another one.
 */
export async function newTab({ layout, name } = {}) {
  let landing = await findLandingTarget();
  let shellCounts = null;

  if (!landing) {
    shellCounts = await withShell(async (evalIn) => {
      const before = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      const clicked = await evalIn(`
        (function() {
          var btn = document.querySelector('[class*="create-new-tab"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()
      `);
      if (!clicked) throw new Error('New-tab button not found in shell window.');
      await new Promise(r => setTimeout(r, 1500));
      const after = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      return { before, after };
    });
    landing = await findLandingTarget();
  }

  if (!layout) {
    const state = await list();
    return {
      success: shellCounts ? shellCounts.after > shellCounts.before : !!landing,
      action: 'new_tab_opened',
      note: 'Tab is on the layout picker. Call tab_new with layout: "new" or a saved layout name to open a chart in it.',
      ...state,
    };
  }

  if (!landing) throw new Error('New tab opened but its landing page target was not found.');

  // Snapshot existing chart targets so we can spot the one the pick creates.
  const beforeResp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const chartIdsBefore = new Set(
    (await beforeResp.json())
      .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
      .map(t => t.id)
  );

  const wantNew = String(layout).trim().toLowerCase() === 'new';
  const layoutName = name || 'New layout';
  const picked = await withTarget(landing.id, async (evalIn) => {
    if (wantNew) {
      // "Create new layout" opens a naming dialog; the Create button stays
      // disabled until the name input is filled (React controlled input, so
      // the native value setter + input event are required).
      await evalIn(`(function(){ var b = document.querySelector('.create-new-layout-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 700));
      const filled = await evalIn(`
        (function() {
          // The dialog's name field (not the landing page's Search box).
          var inp = document.querySelector('input[placeholder="My layout"]');
          if (!inp) {
            var dlg = document.querySelector('[class*="dialog"], [role="dialog"]');
            if (dlg) inp = dlg.querySelector('input');
          }
          if (!inp) return 'no-dialog-input';
          var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(inp, ${JSON.stringify(name || 'New layout')});
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          return 'filled';
        })()
      `);
      if (filled !== 'filled') throw new Error(`Create-layout dialog did not open as expected (${filled}).`);
      await new Promise(r => setTimeout(r, 400));
      const created = await evalIn(`
        (function() {
          var scope = document.querySelector('[class*="dialog"], [role="dialog"]') || document;
          var btns = scope.querySelectorAll('button');
          for (var i = 0; i < btns.length; i++) {
            var t = (btns[i].textContent || '').trim().toLowerCase();
            if (t === 'create' && !btns[i].disabled) { btns[i].click(); return true; }
          }
          return false;
        })()
      `);
      if (!created) throw new Error('Create button not found or still disabled in the layout dialog.');
      return layoutName;
    }
    const clickByTitle = `
      (function() {
        var q = ${JSON.stringify(String(layout).toLowerCase())};
        var items = document.querySelectorAll('.layout-list-item');
        for (var i = 0; i < items.length; i++) {
          var t = items[i].querySelector('.layout-list-item-title');
          if (t && t.textContent.trim().toLowerCase().indexOf(q) !== -1) {
            items[i].click();
            return t.textContent.trim();
          }
        }
        return null;
      })()
    `;
    let foundTitle = await evalIn(clickByTitle);
    if (!foundTitle) {
      // Not in the recents — expand the full layout list and retry.
      await evalIn(`(function(){ var b = document.querySelector('.layout-list-expand-button'); if (b) b.click(); })()`);
      await new Promise(r => setTimeout(r, 800));
      foundTitle = await evalIn(clickByTitle);
    }
    return foundTitle;
  });

  if (!picked) throw new Error(`Layout matching "${layout}" not found in the layout list.`);

  // The chart loads under a NEW CDP target: the file:// landing -> https://
  // chart navigation swaps renderer processes, so the target id changes.
  // Wait for a chart target that wasn't there before the pick.
  let chartTarget = null;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    const targets = await resp.json();
    chartTarget = targets.find(x =>
      x.type === 'page' && /tradingview\.com\/chart/i.test(x.url) && !chartIdsBefore.has(x.id)
    ) || targets.find(x => x.id === landing.id && /tradingview\.com\/chart/i.test(x.url)) || null;
    if (chartTarget) break;
  }
  if (!chartTarget) throw new Error(`Picked "${picked}" but no new chart target appeared.`);

  // Give the chart a moment to boot, then follow it.
  await new Promise(r => setTimeout(r, 2000));
  await reconnectTo(chartTarget.id);
  return {
    success: true,
    action: wantNew ? 'new_layout_created' : 'layout_opened_in_new_tab',
    layout: picked,
    url_chart_id: chartTarget.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
  };
}

/**
 * Close the currently active tab by clicking its close button in the shell.
 */
export async function closeTab() {
  const before = await withShell((evalIn) => evalIn(`document.querySelectorAll('.tabs-container .tab').length`));
  if (before <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const result = await withShell(async (evalIn) => {
    const clicked = await evalIn(`
      (function() {
        var active = document.querySelector('.tabs-container .tab.active') || document.querySelectorAll('.tabs-container .tab')[0];
        if (!active) return false;
        // The close container div has no handler — the real clickable is the button inside it.
        var close = active.querySelector('[class*="close"] button') || active.querySelector('button[class*="close"]') || active.querySelector('[class*="close"]');
        if (!close) return false;
        close.click();
        return true;
      })()
    `);
    if (!clicked) throw new Error('Close button not found on the active tab.');
    await new Promise(r => setTimeout(r, 1000));
    return evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
  });

  // Our cached CDP client may have been attached to the closed tab — re-resolve.
  try { await getClient(); } catch { /* next tool call will reconnect */ }

  return { success: result < before, action: 'tab_closed', tabs_before: before, tabs_after: result };
}

/**
 * Switch to a chart tab by index (from tab_list). Clicks the corresponding
 * tab in the shell window so the switch is visible, verifies the desired
 * chart target actually became visible, then re-attaches the CDP client so
 * subsequent reads follow it.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs.find((tab) => tab.tab_index === idx);
  if (!target) throw new Error(`Tab index ${idx} not found.`);

  if (!(await isTargetVisible(target.target_id))) {
    const clicked = await withShell(async (evalIn) => {
      const count = await evalIn(`document.querySelectorAll('.tabs-container .tab').length`);
      // Try the same ordinal first (shell order usually matches), then the rest.
      const order = [...new Set([Math.min(idx, count - 1), ...Array.from({ length: count }, (_, k) => k)])];
      for (const k of order) {
        await evalIn(`document.querySelectorAll('.tabs-container .tab')[${k}].click()`);
        await new Promise(r => setTimeout(r, 400));
        if (await isTargetVisible(target.target_id)) return k;
      }
      return null;
    });
    if (clicked === null) {
      throw new Error(`Clicked through all shell tabs but chart ${target.url_chart_id} never became visible.`);
    }
  }

  // Re-attach the cached CDP client so subsequent reads follow the switch.
  try {
    await reconnectTo(target.target_id);
  } catch (e) {
    throw new Error(`Tab is visible but failed to re-attach CDP to it: ${e.message}`);
  }

  return {
    success: true,
    action: 'switched',
    tab_index: idx,
    target_id: target.target_id,
    url_chart_id: target.url_chart_id,
    layout: target.layout,
    visually_switched: true,
  };
}
