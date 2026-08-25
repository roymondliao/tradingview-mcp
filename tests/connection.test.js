import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpOperationError,
  selectActiveChartTarget,
  withTimeout,
} from '../src/connection.js';

const chart = (id) => ({
  id,
  type: 'page',
  title: `Chart ${id}`,
  url: `https://www.tradingview.com/chart/${id}/`,
});

const shell = {
  id: 'shell',
  type: 'page',
  title: 'TradingView shell',
  url: 'file:///Applications/TradingView.app/Contents/Resources/app.asar/app/window/index.html',
};

describe('CDP operation timeout', () => {
  it('rejects with structured timeout metadata', async () => {
    await assert.rejects(
      withTimeout(new Promise(() => {}), 5, { stage: 'runtime_evaluate', target_id: 'chart-1' }),
      (err) => {
        assert.ok(err instanceof CdpOperationError);
        assert.equal(err.code, 'CDP_TIMEOUT');
        assert.equal(err.stage, 'runtime_evaluate');
        assert.equal(err.timeout_ms, 5);
        assert.equal(err.target_id, 'chart-1');
        return true;
      },
    );
  });

  it('returns a completed operation before the deadline', async () => {
    assert.equal(await withTimeout(Promise.resolve('ready'), 50), 'ready');
  });
});

describe('active TradingView chart target selection', () => {
  it('uses the only chart without probing', async () => {
    const target = chart('only');
    assert.equal(await selectActiveChartTarget([shell, target]), target);
  });

  it('prefers the uniquely visible target over mismatched shell/CDP ordering', async () => {
    const first = chart('first');
    const active = chart('active');
    const selected = await selectActiveChartTarget([first, shell, active], {
      getActiveTabIndex: async () => 0,
      probeTarget: async (target) => ({ visibility: target.id === 'active' ? 'visible' : 'hidden', focused: false }),
    });
    assert.equal(selected, active);
  });

  it('rejects when the Desktop active tab is the New tab landing page', async () => {
    const landing = { id: 'landing', type: 'page', title: 'New tab', url: 'about:blank' };
    await assert.rejects(
      selectActiveChartTarget([chart('first'), landing, chart('second')], {
        getActiveTabIndex: async () => 1,
        probeTarget: async () => null,
      }),
      (err) => err.code === 'CDP_ACTIVE_TAB_NOT_CHART' && err.target_id === 'landing',
    );
  });

  it('falls back to the uniquely focused chart when shell state is unavailable', async () => {
    const first = chart('first');
    const focused = chart('focused');
    const selected = await selectActiveChartTarget([first, focused], {
      getActiveTabIndex: async () => null,
      probeTarget: async (target) => ({ visibility: 'visible', focused: target.id === 'focused' }),
    });
    assert.equal(selected, focused);
  });

  it('does not silently fall back to the first chart when none can be resolved', async () => {
    await assert.rejects(
      selectActiveChartTarget([chart('first'), chart('second')], {
        getActiveTabIndex: async () => null,
        probeTarget: async () => null,
        timeoutMs: 25,
      }),
      (err) => err.code === 'CDP_ACTIVE_TARGET_UNRESOLVED'
        && err.stage === 'active_target'
        && err.timeout_ms === 25,
    );
  });
});
