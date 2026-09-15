import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readChartRuntimeMetadataPage } from '../src/core/layout-identity.js';

const original = {
  TradingViewApi: globalThis.TradingViewApi,
  document: globalThis.document,
  location: globalThis.location,
};

afterEach(() => {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete globalThis[key];
    else globalThis[key] = value;
  }
});

function installRuntime({ runtimeLayoutId = 'runtime-layout', catalog = [] } = {}) {
  const mainSeries = { symbol: () => 'TWSE_DLY:2344', interval: () => '1D' };
  const chart = { model: () => ({ mainSeries: () => mainSeries }) };
  globalThis.location = { pathname: '/chart/url-layout/' };
  globalThis.document = { visibilityState: 'visible', hasFocus: () => true };
  globalThis.TradingViewApi = {
    _chartWidgetCollection: {
      getAll: () => [chart],
      _layoutType: { value: () => 's' },
      inlineChartsCount: { value: () => 1 },
    },
    _activeChartWidgetWV: { value: () => ({ _chartWidget: chart }) },
    _saveChartService: {
      layoutId: () => runtimeLayoutId,
      _chartSaver: {
        _prevChartState: {
          id: 999,
          content: JSON.stringify({ charts: [{ chartId: 'pane-1' }] }),
        },
      },
    },
    getSavedCharts: (callback) => callback(catalog),
  };
}

describe('shared Layout identity provider', () => {
  it('maps the 3.4.0 runtime Layout ID to the account Saved Layout ID', async () => {
    installRuntime({
      catalog: [{ id: 101, url: 'runtime-layout', name: 'Strategy Layout' }],
    });
    const result = await readChartRuntimeMetadataPage();
    assert.deepEqual(result.layout, {
      layout_id: 'runtime-layout',
      saved_layout_id: 101,
      layout_name: 'Strategy Layout',
      pane_layout: 's',
    });
    assert.equal(result.active_index, 0);
    assert.equal(result.panes[0].pane_id, 'pane-1');
  });

  it('falls back to the URL identity when the runtime Layout provider is unavailable', async () => {
    installRuntime({ runtimeLayoutId: null });
    const result = await readChartRuntimeMetadataPage();
    assert.equal(result.layout.layout_id, 'url-layout');
    assert.equal(result.layout.saved_layout_id, 999);
  });
});
