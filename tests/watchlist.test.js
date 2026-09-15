/**
 * Unit tests for watchlist readiness, panel locator compatibility, and DI.
 * No TradingView Desktop instance is required.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  captureActiveWatchlistSnapshot, getWatchlist, listWatchlists, addBulk, remove,
} from '../src/core/watchlist.js';
import { openPanel } from '../src/core/ui.js';

function getEvaluate({ ready = [true], symbols = [], listInfo = null } = {}) {
  let readyIndex = 0;
  const calls = [];
  const evaluate = async (expr) => {
    calls.push(expr);
    if (expr.includes('if (!panel) return false')) {
      return ready[Math.min(readyIndex++, ready.length - 1)];
    }
    if (expr.includes('function norm')) return { symbols, source: symbols.length ? 'dom_rows' : 'empty' };
    if (expr.includes('__reactFiber')) return listInfo;
    return undefined;
  };
  evaluate.calls = calls;
  return evaluate;
}

function fakeButton({ dataName, ariaLabel, pressed = 'false', left = 950 } = {}) {
  const attrs = {
    'data-name': dataName ?? null,
    'aria-label': ariaLabel ?? null,
    'aria-pressed': pressed,
  };
  return {
    tagName: 'BUTTON', offsetWidth: 32, offsetHeight: 32, clicked: false,
    classList: { contains: () => false, toString: () => '' },
    getAttribute: (name) => attrs[name] ?? null,
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left, width: 32, height: 32 }),
    click() { this.clicked = true; },
  };
}

function domEvaluate(buttons = []) {
  return async (expr) => vm.runInNewContext(expr, {
    window: { innerWidth: 1000 },
    document: {
      querySelector(selector) {
        if (selector === '[class*="layout__area--right"]') return { offsetWidth: 320 };
        return null;
      },
      querySelectorAll(selector) {
        if (selector === 'button, [role="button"]') return buttons;
        const dataMatch = selector.match(/^\[data-name="(.+)"\]$/);
        if (dataMatch) return buttons.filter(b => b.getAttribute('data-name') === dataMatch[1]);
        const ariaMatch = selector.match(/^\[aria-label="(.+)"\]$/);
        if (ariaMatch) return buttons.filter(b => b.getAttribute('aria-label') === ariaMatch[1]);
        return [];
      },
    },
  });
}

describe('getWatchlist() readiness', () => {
  it('reads an already-ready widget without looking up or opening the toolbar button', async () => {
    const symbols = [{ symbol: 'TWSE:2330', last: '1000' }];
    const evaluate = getEvaluate({ ready: [true], symbols });
    let openCalls = 0;

    const result = await getWatchlist({ _deps: {
      evaluate,
      openPanel: async () => { openCalls++; },
      sleep: async () => {},
    } });

    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.deepEqual(result.symbols, symbols);
    assert.equal(openCalls, 0);
  });

  it('opens the watchlist once and polls until the widget becomes ready', async () => {
    const evaluate = getEvaluate({ ready: [false, false, true] });
    const openCalls = [];

    const result = await getWatchlist({ _deps: {
      evaluate,
      openPanel: async (args) => {
        openCalls.push(args);
        return { success: true, performed: 'opened' };
      },
      sleep: async () => {},
    } });

    assert.equal(result.success, true);
    assert.equal(openCalls.length, 1);
    assert.equal(openCalls[0].panel, 'watchlist');
    assert.equal(openCalls[0].action, 'open');
  });

  it('throws a readiness error when the widget never loads', async () => {
    const evaluate = getEvaluate({ ready: [false] });

    await assert.rejects(
      () => getWatchlist({ _deps: {
        evaluate,
        openPanel: async () => ({ success: true, performed: 'opened' }),
        sleep: async () => {},
      } }),
      /Watchlist panel did not become ready/,
    );
  });
});

describe('right-panel watchlist locators', () => {
  it('prefers the current data-name="base" locator regardless of localized aria-label', async () => {
    const button = fakeButton({ dataName: 'base', ariaLabel: '觀察清單、詳情和新聞' });
    const result = await openPanel({ panel: 'watchlist', action: 'open', _deps: { evaluate: domEvaluate([button]) } });

    assert.equal(result.matched_by, 'data-name=base');
    assert.equal(result.performed, 'opened');
    assert.equal(button.clicked, true);
  });

  it('falls back to the legacy data-name locator', async () => {
    const button = fakeButton({ dataName: 'base-watchlist-widget-button', ariaLabel: 'Watchlist' });
    const result = await openPanel({ panel: 'watchlist', action: 'open', _deps: { evaluate: domEvaluate([button]) } });

    assert.equal(result.matched_by, 'data-name=base-watchlist-widget-button');
    assert.equal(button.clicked, true);
  });

  it('reports attempted locators and observed right-rail buttons on failure', async () => {
    const alerts = fakeButton({ dataName: 'alerts', ariaLabel: '快訊' });

    await assert.rejects(
      () => openPanel({ panel: 'watchlist', action: 'open', _deps: { evaluate: domEvaluate([alerts]) } }),
      (err) => {
        assert.match(err.message, /Button not found for panel: watchlist/);
        assert.match(err.message, /base-watchlist-widget-button/);
        assert.match(err.message, /alerts/);
        return true;
      },
    );
  });
});

describe('Active Watchlist snapshot', () => {
  it('copies ordered Symbol identities once with Unix and ISO capture time', async () => {
    const source = {
      success: true,
      list_id: 'list-1',
      list_name: 'Momentum',
      symbols: [{ symbol: 'TWSE:2330', last: '1' }, { symbol: 'NASDAQ:AAPL' }],
    };
    let reads = 0;
    const snapshot = await captureActiveWatchlistSnapshot({
      _deps: {
        now: () => 1704067200000,
        getWatchlist: async () => { reads += 1; return source; },
      },
    });
    source.symbols[0].symbol = 'TPEX:6488';
    assert.equal(reads, 1);
    assert.deepEqual(snapshot, {
      list_id: 'list-1',
      list_name: 'Momentum',
      symbols: [{ symbol: 'TWSE:2330' }, { symbol: 'NASDAQ:AAPL' }],
      captured_at: 1704067200000,
      captured_at_iso: '2024-01-01T00:00:00.000Z',
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.symbols), true);
  });
});

describe('watchlist addBulk() dependency forwarding', () => {
  it('uses injected dependencies for every symbol and aggregates failures', async () => {
    let clientCalls = 0;
    const client = {
      Input: {
        insertText: async () => {},
        dispatchKeyEvent: async () => {},
      },
    };
    const evaluate = async (expr) => {
      if (expr.includes('if (!panel) return false')) return true;
      if (expr.includes('var btn = document.querySelector')) return { found: true };
      if (expr.includes('var rows = document.querySelectorAll')) return 'NASDAQ:AAPL';
      return undefined;
    };
    const getClient = async () => {
      clientCalls++;
      if (clientCalls === 2) throw new Error('mock client failure');
      return client;
    };

    const result = await addBulk({
      symbols: ['AAPL', 'MSFT'],
      _deps: { evaluate, getClient, sleep: async () => {} },
    });

    assert.equal(result.added, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.results[0].added_as, 'NASDAQ:AAPL');
    assert.match(result.results[1].error, /mock client failure/);
  });
});

describe('watchlist remove() request origin', () => {
  it('uses a same-origin relative URL so localized TradingView domains work', async () => {
    const evaluate = getEvaluate({
      ready: [true],
      listInfo: { id: 'list-123', name: 'Main', symbols: ['NASDAQ:AAPL'] },
    });
    let requestExpression = '';

    const result = await remove({
      symbols: ['NASDAQ:AAPL'],
      _deps: {
        evaluate,
        evaluateAsync: async (expr) => {
          requestExpression = expr;
          return { status: 200, ok: true, body: '' };
        },
        openPanel: async () => ({ success: true }),
        sleep: async () => {},
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.verified, true);
    assert.match(requestExpression, /fetch\('\/api\/v1\/symbols_list\/custom\/'/);
    assert.doesNotMatch(requestExpression, /https:\/\/www\.tradingview\.com/);
  });
});

describe('listWatchlists()', () => {
  it('lists watchlists through the same-origin custom-list endpoint', async () => {
    let requestExpression = '';
    const result = await listWatchlists({ _deps: {
      evaluateAsync: async (expr) => {
        requestExpression = expr;
        return {
          status: 200,
          ok: true,
          data: [
            { id: 1, name: 'Main', symbols: ['NASDAQ:AAPL', 'NASDAQ:MSFT'] },
            { id: 2, name: 'Taiwan', symbol_count: 3 },
          ],
        };
      },
    } });

    assert.equal(result.success, true);
    assert.equal(result.count, 2);
    assert.deepEqual(result.lists, [
      { id: 1, name: 'Main', symbol_count: 2 },
      { id: 2, name: 'Taiwan', symbol_count: 3 },
    ]);
    assert.match(requestExpression, /fetch\(["']\/api\/v1\/symbols_list\/custom\/["']/);
    assert.doesNotMatch(requestExpression, /https:\/\/www\.tradingview\.com/);
    assert.equal(result.transport, 'evaluateAsync');
  });

  it('accepts a paginated results response', async () => {
    const result = await listWatchlists({ _deps: {
      evaluateAsync: async () => ({
        status: 200, ok: true,
        data: { results: [{ id: 3, title: 'Swing', symbols_count: 4 }] },
      }),
    } });

    assert.deepEqual(result.lists, [{ id: 3, name: 'Swing', symbol_count: 4 }]);
  });

  it('reports HTTP failures without treating HTTP 0 as a real response', async () => {
    await assert.rejects(
      () => listWatchlists({ _deps: {
        evaluateAsync: async () => ({ status: 403, ok: false, body: 'Forbidden' }),
      } }),
      /HTTP 403.*Forbidden/,
    );
  });

  it('uses callFunctionOn when requested and passes the path as an argument', async () => {
    let calledFunction;
    let calledArgs;
    const result = await listWatchlists({
      use_function: true,
      _deps: {
        evaluateAsync: async () => {
          throw new Error('evaluateAsync should not be used');
        },
        callPageFunction: async (fn, args) => {
          calledFunction = fn;
          calledArgs = args;
          return { status: 200, ok: true, data: [{ id: 4, name: 'Function path', symbols: [] }] };
        },
      },
    });

    assert.equal(typeof calledFunction, 'function');
    assert.deepEqual(calledArgs, ['/api/v1/symbols_list/custom/']);
    assert.equal(result.transport, 'callFunctionOn');
    assert.equal(result.lists[0].name, 'Function path');
  });
});
