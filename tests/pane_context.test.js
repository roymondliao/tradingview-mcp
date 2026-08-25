import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { attachTab } from '../src/core/tab.js';
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
      layout: { layout_id: 101, layout_name: 'dev', pane_layout: '2h' },
    },
    {
      tab_index: 1,
      target_id: 'target-basic',
      url_chart_id: 'short-basic',
      is_chart: true,
      layout: { layout_id: 202, layout_name: 'basic', pane_layout: 's' },
    },
  ],
};

describe('Tab selector', () => {
  it('attaches by stable Saved Layout ID', async () => {
    let attachedTarget = null;
    const selected = await attachTab({
      layout_id: 101,
      _deps: {
        list: async () => tabs,
        reconnectTo: async (targetId) => { attachedTarget = targetId; },
      },
    });
    assert.equal(selected.layout.layout_name, 'dev');
    assert.equal(attachedTarget, 'target-dev');
  });

  it('rejects selectors that do not resolve exactly one Tab', async () => {
    await assert.rejects(
      attachTab({ url_chart_id: 'missing', _deps: { list: async () => tabs } }),
      /resolved 0 matches/,
    );
  });
});

describe('Pane context selector', () => {
  it('focuses an explicit pane and returns IDs without a derived label', async () => {
    let activeIndex = 0;
    const inventory = () => ({
      target_id: 'target-dev',
      url_chart_id: 'short-dev',
      layout_id: 101,
      layout_name: 'dev',
      pane_layout: '2h',
      active_index: activeIndex,
      panes: [
        { pane_index: 0, pane_id: '1', symbol: 'NASDAQ:AAPL', resolution: '1D' },
        { pane_index: 1, pane_id: '2', symbol: 'NASDAQ:MSFT', resolution: '60' },
      ],
    });
    const context = await prepareContext({
      layout_id: 101,
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
      layout_id: 101,
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
