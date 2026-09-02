import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AsyncMutex,
  assertSymbolSession,
  prepareSymbolSession,
  restoreSymbolSession,
  withChartSession,
} from '../src/core/chart-session.js';
import { setSymbol, setTimeframe } from '../src/core/chart.js';
import {
  activatePaneContext,
  assertPaneContext,
  normalizeSymbolIdentity,
  symbolIdentitiesMatch,
} from '../src/core/pane.js';
import { CoreOperationError } from '../src/core/errors.js';

const context = Object.freeze({
  tab_index: 0,
  target_id: 'target-dev',
  url_chart_id: 'short-dev',
  layout_id: 101,
  layout_name: 'dev',
  pane_layout: '2h',
  pane_index: 1,
  pane_id: '2',
  symbol: 'NASDAQ:MSFT',
  resolution: '60',
});

function paneHarness() {
  const state = {
    activeIndex: 0,
    targetId: 'target-dev',
    urlChartId: 'short-dev',
    layoutId: 101,
    paneLayout: '2h',
    paneId: '2',
    symbol: 'NASDAQ:MSFT',
    resolution: '60',
    targetOpen: true,
    reconnects: [],
    focuses: [],
  };
  const inventory = () => ({
    target_id: state.targetId,
    url_chart_id: state.urlChartId,
    layout_id: state.layoutId,
    pane_layout: state.paneLayout,
    active_index: state.activeIndex,
    panes: [
      { pane_index: 0, pane_id: '1', symbol: 'NASDAQ:AAPL', resolution: '1D' },
      { pane_index: 1, pane_id: state.paneId, symbol: state.symbol, resolution: state.resolution },
    ],
  });
  const deps = {
    identifyTab: async (targetId) => state.targetOpen
      ? { target_id: targetId, url_chart_id: state.urlChartId }
      : null,
    reconnectTo: async (targetId) => { state.reconnects.push(targetId); },
    list: async () => inventory(),
    focus: async ({ index }) => {
      state.focuses.push(index);
      state.activeIndex = index;
      return { success: true };
    },
  };
  return { state, deps };
}

describe('resolved Symbol identity', () => {
  it('accepts the verified TWSE_DLY alias without allowing ticker-only fallback', () => {
    assert.equal(normalizeSymbolIdentity('twse_dly:2344'), 'TWSE:2344');
    assert.equal(symbolIdentitiesMatch('TWSE:2344', 'TWSE_DLY:2344'), true);
    assert.equal(symbolIdentitiesMatch('NASDAQ:2344', 'TWSE_DLY:2344'), false);
    assert.equal(symbolIdentitiesMatch('2344', 'TWSE_DLY:2344'), false);
  });

  it('keeps structured error context bounded to approved fields', () => {
    const error = new CoreOperationError('changed', {
      code: 'PANE_CONTEXT_CHANGED',
      phase: 'report_read',
      context: { ...context, cookie: 'must-not-leak', nested: { private: true } },
    });
    assert.equal(error.context.target_id, 'target-dev');
    assert.equal('cookie' in error.context, false);
    assert.equal('nested' in error.context, false);
  });
});

describe('immutable Pane context reacquire and ownership', () => {
  it('reattaches the target and refocuses the expected Pane after the user changes active Pane', async () => {
    const { state, deps } = paneHarness();
    const first = await activatePaneContext({ context, _deps: deps });
    assert.equal(first.active, true);
    assert.deepEqual(state.reconnects, ['target-dev']);
    assert.deepEqual(state.focuses, [1]);

    state.activeIndex = 0;
    const second = await assertPaneContext({ context, phase: 'report_read', _deps: deps });
    assert.equal(second.pane_id, '2');
    assert.equal(second.active, true);
    assert.deepEqual(state.focuses, [1, 1]);
  });

  it('reports a closed target with stable context code and phase', async () => {
    const { state, deps } = paneHarness();
    state.targetOpen = false;
    await assert.rejects(
      activatePaneContext({ context, phase: 'trade_batch', _deps: deps }),
      (error) => error instanceof CoreOperationError
        && error.code === 'PANE_CONTEXT_CHANGED'
        && error.phase === 'trade_batch'
        && error.context.target_id === 'target-dev',
    );
  });

  it('rejects Layout and Pane ownership changes', async () => {
    const layout = paneHarness();
    layout.state.layoutId = 999;
    await assert.rejects(
      activatePaneContext({ context, phase: 'report_read', _deps: layout.deps }),
      (error) => error.code === 'PANE_CONTEXT_CHANGED' && /Layout changed/.test(error.message),
    );

    const pane = paneHarness();
    pane.state.paneId = 'replaced';
    await assert.rejects(
      activatePaneContext({ context, phase: 'trade_batch', _deps: pane.deps }),
      (error) => error.code === 'PANE_CONTEXT_CHANGED' && /ownership changed/.test(error.message),
    );
  });

  it('rejects Symbol or Timeframe interference in the expected Pane', async () => {
    const { state, deps } = paneHarness();
    state.activeIndex = 1;
    state.symbol = 'NASDAQ:NVDA';
    await assert.rejects(
      assertPaneContext({ context, phase: 'report_b', _deps: deps }),
      (error) => error.code === 'PANE_CONTEXT_CHANGED'
        && error.phase === 'report_b'
        && error.symbol === 'NASDAQ:MSFT',
    );
  });
});

describe('strict Symbol Session readback', () => {
  it('mutates Symbol/Timeframe and accepts a stable resolved Symbol alias', async () => {
    const state = { symbol: 'NASDAQ:MSFT', resolution: '60' };
    let activateCalls = 0;
    const result = await prepareSymbolSession({
      context,
      symbol: 'TWSE:2344',
      timeframe: '1D',
      entity_id: 'strategy-1',
      timeout_ms: 1000,
      _deps: {
        assertPaneContext: async () => ({ symbol: 'NASDAQ:MSFT', resolution: '60' }),
        setSymbol: async ({ symbol }) => { state.symbol = symbol.replace('TWSE:', 'TWSE_DLY:'); },
        setTimeframe: async ({ timeframe }) => { state.resolution = timeframe; },
        activatePaneContext: async () => {
          activateCalls += 1;
          return { ...state };
        },
        delay: async () => {},
        now: () => 1704067200000,
      },
    });
    assert.equal(activateCalls, 2);
    assert.equal(result.requested_symbol, 'TWSE:2344');
    assert.equal(result.resolved_symbol, 'TWSE_DLY:2344');
    assert.equal(result.timeframe, '1D');
    assert.equal(result.entity_id, 'strategy-1');
    assert.equal(result.started_at_iso, '2024-01-01T00:00:00.000Z');
    assert.equal(Object.isFrozen(result.context), true);
  });

  it('throws SYMBOL_SWITCH_FAILED instead of returning success on wrong readback', async () => {
    let now = 0;
    const mutations = [];
    await assert.rejects(
      prepareSymbolSession({
        context,
        symbol: 'NASDAQ:NVDA',
        timeout_ms: 400,
        _deps: {
          assertPaneContext: async () => ({ symbol: 'NASDAQ:MSFT', resolution: '60' }),
          setSymbol: async ({ symbol }) => { mutations.push(symbol); },
          activatePaneContext: async () => ({ symbol: 'NASDAQ:MSFT', resolution: '60' }),
          delay: async (milliseconds) => { now += milliseconds; },
          now: () => now,
        },
      }),
      (error) => error.code === 'SYMBOL_SWITCH_FAILED'
        && error.phase === 'symbol_timeframe_readback'
        && error.retryable === true,
    );
    assert.deepEqual(mutations, ['NASDAQ:NVDA', 'NASDAQ:MSFT']);
  });

  it('throws TIMEFRAME_SWITCH_FAILED on persistent wrong Timeframe', async () => {
    let now = 0;
    await assert.rejects(
      prepareSymbolSession({
        context,
        timeframe: '1D',
        timeout_ms: 400,
        _deps: {
          assertPaneContext: async () => ({ symbol: 'NASDAQ:MSFT', resolution: '60' }),
          setTimeframe: async () => ({ success: true }),
          activatePaneContext: async () => ({ symbol: 'NASDAQ:MSFT', resolution: '60' }),
          delay: async (milliseconds) => { now += milliseconds; },
          now: () => now,
        },
      }),
      (error) => error.code === 'TIMEFRAME_SWITCH_FAILED'
        && error.phase === 'symbol_timeframe_readback',
    );
  });

  it('revalidates the prepared Symbol Session at each named phase', async () => {
    let received = null;
    const session = {
      context,
      symbol: 'TWSE:2344',
      resolved_symbol: 'TWSE_DLY:2344',
      timeframe: '1D',
    };
    await assertSymbolSession(session, {
      phase: 'report_b',
      _deps: {
        assertPaneContext: async (args) => {
          received = args;
          return { symbol: 'TWSE_DLY:2344', resolution: '1D' };
        },
      },
    });
    assert.equal(received.phase, 'report_b');
    assert.equal(received.symbol, 'TWSE_DLY:2344');
    assert.equal(received.timeframe, '1D');
  });

  it('makes existing Chart mutations fail when readiness times out', async () => {
    const deps = { evaluateAsync: async () => {}, waitForChartReady: async () => false };
    await assert.rejects(
      setSymbol({ symbol: 'NASDAQ:NVDA', _deps: deps }),
      (error) => error.code === 'SYMBOL_SWITCH_FAILED' && error.phase === 'chart_ready',
    );
    await assert.rejects(
      setTimeframe({ timeframe: '1D', _deps: { ...deps, evaluate: async () => {} } }),
      (error) => error.code === 'TIMEFRAME_SWITCH_FAILED' && error.phase === 'chart_ready',
    );
  });
});

describe('process-local Chart mutation mutex', () => {
  it('serializes complete withChartSession operations', async () => {
    const mutex = new AsyncMutex();
    const events = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const deps = {
      mutex,
      now: () => 1704067200000,
      assertPaneContext: async () => ({ symbol: context.symbol, resolution: context.resolution }),
    };
    const first = withChartSession({ context, _deps: deps }, async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = withChartSession({ context, _deps: deps }, async () => {
      events.push('second:start');
      events.push('second:end');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(events, ['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
  });
});

describe('Chart Session restore', () => {
  it('restores the original Symbol/Timeframe and requires stable readback', async () => {
    const state = { symbol: 'TWSE_DLY:2344', resolution: '1D' };
    let reads = 0;
    const result = await restoreSymbolSession({
      context,
      original_symbol: 'NASDAQ:MSFT',
      original_timeframe: '60',
      symbol: 'TWSE:2344',
      resolved_symbol: 'TWSE_DLY:2344',
      timeframe: '1D',
      symbol_changed: true,
      timeframe_changed: true,
    }, {
      timeout_ms: 1000,
      _deps: {
        assertPaneContext: async () => ({ symbol: state.symbol, resolution: state.resolution }),
        setSymbol: async ({ symbol }) => { state.symbol = symbol; },
        setTimeframe: async ({ timeframe }) => { state.resolution = timeframe; },
        activatePaneContext: async () => { reads += 1; return { ...state }; },
        delay: async () => {},
      },
    });
    assert.equal(result.restored, true);
    assert.equal(result.symbol, 'NASDAQ:MSFT');
    assert.equal(result.timeframe, '60');
    assert.equal(reads, 2);
  });

  it('does not overwrite external Chart interference during restore', async () => {
    let mutations = 0;
    await assert.rejects(
      restoreSymbolSession({
        context,
        original_symbol: 'NASDAQ:MSFT',
        original_timeframe: '60',
        symbol: 'TWSE:2344',
        resolved_symbol: 'TWSE_DLY:2344',
        timeframe: '1D',
        symbol_changed: true,
        timeframe_changed: true,
      }, {
        _deps: {
          assertPaneContext: async () => { throw new CoreOperationError('changed', { code: 'PANE_CONTEXT_CHANGED' }); },
          setSymbol: async () => { mutations += 1; },
          setTimeframe: async () => { mutations += 1; },
        },
      }),
      (error) => error.code === 'CHART_RESTORE_FAILED' && error.phase === 'chart_restore',
    );
    assert.equal(mutations, 0);
  });
});
