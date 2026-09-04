/**
 * Core watchlist logic.
 * Reads via DOM rows (panel auto-opened when needed). Removal uses
 * TradingView's symbols_list REST API from the page context (cookie auth),
 * mirroring the proven alerts REST pattern. Add drives the Add-symbol
 * search UI so bare tickers resolve the same way they do for a human.
 */
import {
  evaluate as _evaluate,
  evaluateAsync as _evaluateAsync,
  callPageFunction as _callPageFunction,
  getClient as _getClient,
} from '../connection.js';
import { openPanel as _openPanel } from './ui.js';
import { CoreOperationError } from './errors.js';
import { unixMillisecondsToIso } from './time.js';

const _sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    evaluateAsync: deps?.evaluateAsync || _evaluateAsync,
    callPageFunction: deps?.callPageFunction || _callPageFunction,
    getClient: deps?.getClient || _getClient,
    openPanel: deps?.openPanel || _openPanel,
    sleep: deps?.sleep || _sleep,
  };
}

async function fetchWatchlistsInPage(path) {
  try {
    const response = await fetch(path, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    });
    const body = await response.text();
    let data = null;
    try { data = JSON.parse(body); } catch {}
    return { status: response.status, ok: response.ok, data, body: body.substring(0, 300) };
  } catch (error) {
    return { status: 0, ok: false, data: null, body: String(error) };
  }
}

const WATCHLIST_READY_JS = `
  (function() {
    var panel = document.querySelector('[class*="layout__area--right"]');
    if (!panel) return false;
    return !!(panel.querySelector('[data-name="add-symbol-button"]')
      || panel.querySelector('[data-symbol-full]'));
  })()
`;

// The watchlist widget lazy-loads after the panel opens; a fixed 500ms wait
// raced it (issue #164). Poll until its Add-symbol button or rows exist.
async function ensureWatchlistOpen({ evaluate, openPanel, sleep, maxWaitMs = 5000 }) {
  // State first: if the widget is already usable, toolbar selector changes
  // must not prevent read/write operations.
  if (await evaluate(WATCHLIST_READY_JS)) return { opened: false };

  const panelState = await openPanel({
    panel: 'watchlist', action: 'open', _deps: { evaluate },
  });

  for (let waited = 0; waited < maxWaitMs; waited += 250) {
    await sleep(250);
    const ready = await evaluate(WATCHLIST_READY_JS);
    if (ready) return { opened: panelState?.performed === 'opened' };
  }
  throw new Error('Watchlist panel did not become ready. Is a watchlist widget configured in the right panel?');
}

// Active watchlist metadata (id, name, symbols) read from the React fiber
// tree — needed for the REST endpoints. Approach from PR #65.
async function getActiveListInfo(evaluate) {
  return evaluate(`
    (function() {
      var panel = document.querySelector('[class*="layout__area--right"]');
      if (!panel) return null;
      var rows = panel.querySelectorAll('[data-symbol-full]');
      if (!rows.length) return null;
      var row = rows[0];
      var reactKey = Object.keys(row).find(function(k) { return k.indexOf('__reactFiber') === 0; });
      if (!reactKey) return null;
      var fiber = row[reactKey];
      var count = 0;
      while (fiber && count < 45) {
        if (fiber.memoizedProps && fiber.memoizedProps.current && fiber.memoizedProps.current.id) {
          var cur = fiber.memoizedProps.current;
          return { id: cur.id, name: cur.name, symbols: cur.symbols || [] };
        }
        fiber = fiber.return;
        count++;
      }
      return null;
    })()
  `);
}

export async function getWatchlist({ _deps } = {}) {
  const deps = _resolve(_deps);
  const { evaluate } = deps;
  await ensureWatchlistOpen(deps);

  // Positional cell mapping (name, last, change, change%, volume) with
  // Unicode-minus normalization. The old regex classifier dropped every
  // negative value (TV renders U+2212, not ASCII '-') and all tick-notation
  // prices like 106'28'7 — issue #111.
  const data = await evaluate(`
    (function() {
      function norm(t) { return t.replace(/\\u2212/g, '-').trim(); }
      var container = document.querySelector('[class*="layout__area--right"]');
      if (!container) return { symbols: [], source: 'no_container' };
      var results = [];
      var seen = {};
      var symbolEls = container.querySelectorAll('[data-symbol-full]');
      for (var i = 0; i < symbolEls.length; i++) {
        var sym = symbolEls[i].getAttribute('data-symbol-full');
        if (!sym || seen[sym]) continue;
        seen[sym] = true;
        var row = symbolEls[i].closest('[class*="row"]') || symbolEls[i].parentElement;
        var cells = row ? row.querySelectorAll('[class*="cell"], [class*="column"]') : [];
        var texts = [];
        for (var j = 0; j < cells.length; j++) texts.push(norm(cells[j].textContent));
        results.push({
          symbol: sym,
          last: texts[1] || null,
          change: texts[2] || null,
          change_percent: texts[3] || null,
          volume: texts[4] || null,
        });
      }
      return { symbols: results, source: results.length ? 'dom_rows' : 'empty' };
    })()
  `);

  const listInfo = await getActiveListInfo(evaluate);
  return {
    success: true,
    count: data?.symbols?.length || 0,
    source: data?.source || 'unknown',
    ...(listInfo && { list_id: listInfo.id, list_name: listInfo.name }),
    symbols: data?.symbols || [],
  };
}

/** Capture one immutable, ordered Active Watchlist snapshot for long workflows. */
export async function captureActiveWatchlistSnapshot({ _deps } = {}) {
  const getCurrentWatchlist = _deps?.getWatchlist || getWatchlist;
  const now = _deps?.now || Date.now;
  const current = await getCurrentWatchlist({ _deps });
  if (!current?.success || !Array.isArray(current.symbols)) {
    throw new CoreOperationError('Active Watchlist could not be captured.', {
      code: 'WATCHLIST_SNAPSHOT_UNAVAILABLE', phase: 'watchlist_snapshot',
    });
  }
  const capturedAt = now();
  const symbols = current.symbols.map((entry, index) => {
    const symbol = String(entry?.symbol ?? '').trim();
    if (!symbol) {
      throw new CoreOperationError(`Active Watchlist item ${index + 1} has no Symbol identity.`, {
        code: 'WATCHLIST_SYMBOL_INVALID', phase: 'watchlist_snapshot',
      });
    }
    return Object.freeze({ symbol });
  });
  return Object.freeze({
    list_id: current.list_id ?? null,
    list_name: current.list_name ?? null,
    symbols: Object.freeze(symbols),
    captured_at: capturedAt,
    captured_at_iso: unixMillisecondsToIso(capturedAt),
  });
}

export async function listWatchlists({ use_function = false, _deps } = {}) {
  const { evaluateAsync, callPageFunction } = _resolve(_deps);
  const path = '/api/v1/symbols_list/custom/';
  const resp = use_function
    ? await callPageFunction(fetchWatchlistsInPage, [path])
    : await evaluateAsync(`
      fetch(${JSON.stringify(path)}, {
        method: 'GET',
        credentials: 'include',
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      })
        .then(function(r) {
          return r.text().then(function(t) {
            var data = null;
            try { data = JSON.parse(t); } catch (e) {}
            return { status: r.status, ok: r.ok, data: data, body: t.substring(0, 300) };
          });
        })
        .catch(function(e) { return { status: 0, ok: false, data: null, body: String(e) }; })
    `);

  if (!resp?.ok) {
    throw new Error(`Watchlist list REST call failed (HTTP ${resp?.status}): ${resp?.body}`);
  }

  const data = resp.data;
  const rawLists = Array.isArray(data)
    ? data
    : Array.isArray(data?.results)
      ? data.results
      : Array.isArray(data?.data)
        ? data.data
        : null;
  if (!rawLists) {
    throw new Error('Unexpected watchlist list response: expected an array');
  }

  const lists = rawLists.map(list => ({
    id: list.id,
    name: list.name || list.title || null,
    symbol_count: Array.isArray(list.symbols)
      ? list.symbols.length
      : (list.symbol_count ?? list.symbols_count ?? null),
  }));

  return {
    success: true, count: lists.length, lists, api: 'rest',
    transport: use_function ? 'callFunctionOn' : 'evaluateAsync',
  };
}

export async function add({ symbol, _deps }) {
  const deps = _resolve(_deps);
  const { evaluate, getClient, sleep } = deps;
  const c = await getClient();
  await ensureWatchlistOpen(deps);

  const addClicked = await evaluate(`
    (function() {
      var btn = document.querySelector('[data-name="add-symbol-button"]')
        || document.querySelector('[aria-label="Add symbol"]')
        || document.querySelector('[aria-label*="Add symbol"]');
      if (!btn || btn.offsetParent === null) return { found: false };
      btn.click();
      return { found: true };
    })()
  `);
  if (!addClicked?.found) throw new Error('Add symbol button not found in watchlist panel');
  await sleep(400);

  await c.Input.insertText({ text: symbol });
  await sleep(700);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  await sleep(400);
  await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape' });
  await sleep(400);

  // Verify the row actually appeared instead of reporting blind success.
  const bare = symbol.split(':').pop().toUpperCase();
  const verified = await evaluate(`
    (function() {
      var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
      for (var i = 0; i < rows.length; i++) {
        var s = rows[i].getAttribute('data-symbol-full') || '';
        if (s.toUpperCase() === ${JSON.stringify(symbol.toUpperCase())} || s.split(':').pop().toUpperCase() === ${JSON.stringify(bare)}) return s;
      }
      return null;
    })()
  `);

  return { success: !!verified, symbol, added_as: verified, action: verified ? 'added' : 'not_verified' };
}

export async function addBulk({ symbols, _deps }) {
  const results = [];
  for (const symbol of symbols) {
    try {
      const r = await add({ symbol, _deps });
      results.push({ symbol, success: r.success, added_as: r.added_as });
    } catch (err) {
      results.push({ symbol, success: false, error: err.message });
    }
  }
  const added = results.filter(r => r.success).length;
  return { success: added > 0, added, failed: results.length - added, results };
}

export async function remove({ symbols, _deps }) {
  const deps = _resolve(_deps);
  const { evaluate, evaluateAsync, openPanel, sleep } = deps;
  await ensureWatchlistOpen(deps);
  const listInfo = await getActiveListInfo(evaluate);
  if (!listInfo) throw new Error('Cannot read active watchlist metadata (React fiber probe failed)');

  // Match requested symbols (bare or EXCHANGE:SYMBOL) against the list.
  const toRemove = [];
  const skipped = [];
  for (const sym of symbols) {
    if (sym.includes(':')) {
      if (listInfo.symbols.includes(sym)) toRemove.push(sym);
      else skipped.push(sym);
    } else {
      const match = listInfo.symbols.find(s => s.split(':').pop().toUpperCase() === sym.toUpperCase());
      if (match) toRemove.push(match);
      else skipped.push(sym);
    }
  }
  if (!toRemove.length) {
    return { success: false, removed: [], skipped, error: 'No matching symbols in the active watchlist' };
  }

  // Page-context same-origin fetch — TradingView uses localized chart origins
  // such as tw.tradingview.com, so a hard-coded www host would trigger CORS.
  // A relative URL follows the active page origin and its session cookies.
  const resp = await evaluateAsync(`
    fetch('/api/v1/symbols_list/custom/' + ${JSON.stringify(listInfo.id)} + '/remove/', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify(${JSON.stringify(toRemove)}),
    })
      .then(function(r) { return r.text().then(function(t) { return { status: r.status, ok: r.ok, body: t.substring(0, 300) }; }); })
      .catch(function(e) { return { status: 0, ok: false, body: String(e) }; })
  `);

  if (!resp?.ok) {
    throw new Error(`Watchlist remove REST call failed (HTTP ${resp?.status}): ${resp?.body}`);
  }

  // The desktop widget doesn't live-sync API removals — remount it by
  // toggling the panel, then verify the rows are actually gone.
  await openPanel({ panel: 'watchlist', action: 'close', _deps: { evaluate } });
  await sleep(400);
  await openPanel({ panel: 'watchlist', action: 'open', _deps: { evaluate } });

  let stillPresent = toRemove;
  for (let waited = 0; waited < 5000; waited += 500) {
    await sleep(500);
    stillPresent = await evaluate(`
      (function() {
        var rows = document.querySelectorAll('[class*="layout__area--right"] [data-symbol-full]');
        var present = {};
        for (var i = 0; i < rows.length; i++) present[rows[i].getAttribute('data-symbol-full')] = true;
        return ${JSON.stringify(toRemove)}.filter(function(s) { return present[s]; });
      })()
    `) || [];
    if (stillPresent.length === 0) break;
  }

  return {
    success: true, removed: toRemove, skipped,
    verified: stillPresent.length === 0,
    list_id: listInfo.id, list_name: listInfo.name, api: 'rest',
  };
}
