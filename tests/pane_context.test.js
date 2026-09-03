import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachTab, list as listTabs, readTargetMetadata } from '../src/core/tab.js';
import { prepareContext } from '../src/core/pane.js';

const tabs = {
  success: true,
  tab_count: 2,
  tabs: [
    {
      tab_index: 0,
      target_id: 'target-dev',
      url_chart_id: 'short-dev',
      is_chart: true,
      layout: {
        layout_id: 'short-dev', saved_layout_id: 101, layout_name: 'dev', pane_layout: '2h',
      },
    },
    {
      tab_index: 1,
      target_id: 'target-basic',
      url_chart_id: 'short-basic',
      is_chart: true,
      layout: {
        layout_id: 'short-basic', saved_layout_id: 202, layout_name: 'basic', pane_layout: 's',
      },
    },
  ],
};

describe('Tab selector', () => {
  it('attaches by the Runtime/URL Layout ID', async () => {
    let attachedTarget = null;
    const selected = await attachTab({
      layout_id: 'short-dev',
      _deps: {
        list: async () => tabs,
        reconnectTo: async (targetId) => { attachedTarget = targetId; },
      },
    });
    assert.equal(selected.layout.layout_name, 'dev');
    assert.equal(attachedTarget, 'target-dev');
  });

  it('attaches by the account Saved Layout storage ID', async () => {
    let attachedTarget = null;
    const selected = await attachTab({
      saved_layout_id: 101,
      _deps: {
        list: async () => tabs,
        reconnectTo: async (targetId) => { attachedTarget = targetId; },
      },
    });
    assert.equal(selected.layout.layout_id, 'short-dev');
    assert.equal(attachedTarget, 'target-dev');
  });

  it('rejects selectors that do not resolve exactly one Tab', async () => {
    await assert.rejects(
      attachTab({ url_chart_id: 'missing', _deps: { list: async () => tabs } }),
      /resolved 0 matches/,
    );
  });

  it('uses the URL identity as a 3.4.0 Layout candidate and verifies after attach', async () => {
    let attachedTarget = null;
    const selected = await attachTab({
      layout_id: 'short-dev',
      _deps: {
        list: async () => ({
          success: true,
          tabs: [{
            tab_index: 0,
            target_id: 'target-dev',
            url_chart_id: 'short-dev',
            is_chart: true,
            layout: null,
            metadata_status: 'unavailable',
          }],
        }),
        reconnectTo: async (targetId) => { attachedTarget = targetId; },
      },
    });
    assert.equal(selected.target_id, 'target-dev');
    assert.equal(attachedTarget, 'target-dev');
  });

  it('explains when Saved Layout resolution is blocked by unavailable metadata', async () => {
    await assert.rejects(
      attachTab({
        saved_layout_id: 101,
        _deps: {
          list: async () => ({
            success: true,
            tabs: [{
              target_id: 'target-dev',
              is_chart: true,
              layout: null,
              metadata_status: 'unavailable',
            }],
          }),
        },
      }),
      /metadata is unavailable.*tab list.*metadata_error/i,
    );
  });
});

describe('Tab metadata discovery', () => {
  it('retries once and requires a runtime Layout ID', async () => {
    let attempts = 0;
    const result = await readTargetMetadata('target-dev', {
      _deps: {
        delay: async () => {},
        withTarget: async (_targetId, operation) => operation(async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('runtime loading');
          return {
            layout: { layout_id: 'short-dev' },
            panes: [{ pane_index: 0, pane_id: '1' }],
          };
        }),
      },
    });
    assert.equal(attempts, 2);
    assert.equal(result.attempts, 2);
    assert.equal(result.metadata.layout.layout_id, 'short-dev');
  });

  it('keeps bounded metadata diagnostics in tab list results', async () => {
    const result = await listTabs({
      _deps: {
        fetch: async () => ({
          json: async () => [{
            id: 'target-dev',
            type: 'page',
            title: 'Chart',
            url: 'https://www.tradingview.com/chart/short-dev/',
          }],
        }),
        readTargetMetadata: async () => { throw new Error(`private failure ${'x'.repeat(400)}`); },
      },
    });
    assert.equal(result.tabs[0].metadata_status, 'unavailable');
    assert.equal(result.tabs[0].metadata_attempts, 2);
    assert.match(result.tabs[0].metadata_error, /^private failure/);
    assert.ok(result.tabs[0].metadata_error.length <= 240);
  });
});

describe('Pane context selector', () => {
  it('focuses an explicit pane and returns IDs without a derived label', async () => {
    let activeIndex = 0;
    const inventory = () => ({
      target_id: 'target-dev',
      url_chart_id: 'short-dev',
      layout_id: 'short-dev',
      saved_layout_id: 101,
      layout_name: 'dev',
      pane_layout: '2h',
      active_index: activeIndex,
      panes: [
        { pane_index: 0, pane_id: '1', symbol: 'NASDAQ:AAPL', resolution: '1D' },
        { pane_index: 1, pane_id: '2', symbol: 'NASDAQ:MSFT', resolution: '60' },
      ],
    });
    const context = await prepareContext({
      layout_id: 'short-dev',
      pane_index: 1,
      _deps: {
        attachTab: async () => tabs.tabs[0],
        identifyTab: async () => { throw new Error('explicit attachment should avoid identity lookup'); },
        list: async () => inventory(),
        focus: async ({ index }) => { activeIndex = index; },
      },
    });
    assert.deepEqual(context, {
      tab_index: 0,
      target_id: 'target-dev',
      url_chart_id: 'short-dev',
      layout_id: 'short-dev',
      saved_layout_id: 101,
      layout_name: 'dev',
      pane_layout: '2h',
      pane_index: 1,
      pane_id: '2',
      symbol: 'NASDAQ:MSFT',
      resolution: '60',
    });
    assert.equal('pane_label' in context, false);
  });
});
