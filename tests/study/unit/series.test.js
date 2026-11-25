import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readStudySeriesPage } from '../../../src/core/study-series-runtime.js';
import { getStudySeries, selectDatasets } from '../../../src/core/study-series.js';

const context = { target_id: 'target', pane_index: 0, symbol: 'EX:S', resolution: '1D' };
const captured = 1795503600;

function installChart(t, { plots = [], rows = [], graphics = {}, definitions = {}, items = [] } = {}) {
  const source = {
    id: () => 'id', metaInfo: () => ({ description: 'Study', plots, graphics: definitions,
      styles: Object.fromEntries(plots.map(p => [p.id, { title: 'Plot' }])) }),
    data: () => ({ each: fn => rows.forEach(([i, raw]) => fn(i, raw)) }),
    _graphics: { _indexes: [150, 151, 300], _primitivesCollection: graphics },
    dataWindowView: () => ({ items: () => items }),
  };
  const bars = { firstIndex: () => 0, lastIndex: () => 299, valueAt: () => [captured] };
  const model = { mainSeries: () => ({ bars: () => bars }), model: () => ({ dataSources: () => [source] }),
    timeScale: () => ({ indexToTimePoint: index => 1776668400 + (index - 150) * 86400 }) };
  const widget = { model: () => model };
  const chart = { _chartWidget: widget, symbol: () => context.symbol, resolution: () => context.resolution,
    getStudyById: () => ({ getInputsInfo: () => [], getInputValues: () => [] }) };
  const original = globalThis.TradingViewApi;
  globalThis.TradingViewApi = { _activeChartWidgetWV: { value: () => chart }, _chartWidgetCollection: { getAll: () => [widget] } };
  t.after(() => { if (original) globalThis.TradingViewApi = original; else delete globalThis.TradingViewApi; });
}

function capture(range = null, deps = {}) {
  return getStudySeries({ entity_id: 'id', context, range, _deps: {
    activatePaneContext: async () => ({ ...context, active: true }),
    callPageFunction: (fn, args) => fn(...args), ...deps,
  } });
}

function group(key, records, direct = false) {
  const container = { _primitivesDataById: new Map(records) };
  return new Map([[key, direct ? container : new Map([[false, container]])]]);
}

test('plots preserve ID, original slot, zero, null and same-time order within inclusive range', async t => {
  const plots = ['line','colorer','line','line'].map((type, i) => ({ type, id: 'plot_' + i }));
  installChart(t, { plots, rows: [[3,[12,0,1,null,-8.25]],[2,[11,1,1,2,3]],[4,[12,0,2,0,5]],[5,[13,0,0,0,0]]] });
  const result = await capture({ from: 12, to: 12 });
  const [table] = result.datasets;
  assert.deepEqual(table.rows.map(r => [r.source_index,r.plot_0,r.plot_2,r.plot_3]), [[3,0,null,-8.25],[4,0,0,5]]);
  assert.equal(table.rows[0].time_iso, '1970-01-01T00:00:12.000Z');
  assert.equal(table.period.from, 12);
  assert.equal(table.columns.filter(c => c.title === 'Plot').length, 4);
  assert.equal(table.columns.find(c => c.key === 'plot_1').role, 'color_index');
});

test('graphics-only profile preserves identical boxes, raw anchors, range and future labels', async t => {
  installChart(t, { graphics: {
    dwgboxes: group('boxes', Array.from({ length: 48 }, (_, i) => [i,{ x1:0, x2:1, y1:5.12345678, y2:4 }])),
    dwglines: group('lines', [[1,{ x1:0,x2:1 }]]),
    dwglabels: group('labels', [[1,{ x:2, y:5, t:'POC' }]]),
  } });
  const result = await capture();
  const [boxes, lines, labels] = result.datasets;
  assert.deepEqual([boxes.row_count, lines.row_count, labels.row_count], [48,1,1]);
  assert.equal(boxes.rows[0].start_index, 150);
  assert.equal(boxes.rows[0].start_time, 1776668400);
  assert.equal(boxes.rows[0].end_time, 1776754800);
  assert.equal(labels.rows[0].time, null);
  assert.equal(result.status, 'partial');
  assert.throws(() => selectDatasets(result, { format:'csv' }), /Select one dataset/);
  const outOfRange = { ...result, requested_range: {from:0,to:captured-1} };
  assert.throws(() => selectDatasets(outOfRange, {}), /No snapshot/);
  assert.equal(selectDatasets({ ...result, requested_range: {from:captured,to:captured} }, {}).datasets.length, 3);
});

test('mixed outputs, direct table collections, empty declared collections and unreadable types', async t => {
  installChart(t, { plots:[{ id:'time', type:'line' }], rows:[[0,[5,4]]], graphics:{
    dwgtablecells: group('tableCells', [[1,{tid:0,row:0,col:0,t:''}]],true),
    dwgboxes: new Map(), unfamiliar: group('custom', [[3,{ density:12 }]]),
  }, definitions:{dwgboxes:{boxes:{}}} });
  const result = await capture();
  assert.deepEqual(result.available_datasets,['plots','boxes','table_cells','graphics_unfamiliar']);
  assert.equal(result.datasets[0].rows[0].slot_0,4);
  assert.equal(result.datasets[2].rows[0].t,'');
  assert.equal(result.datasets[1].row_count,0);
  assert.equal(result.datasets[3].rows[0].attributes.density,12);
  assert.equal(result.status,'partial');
  assert.throws(() => selectDatasets(result,{ dataset:'missing' }), /Available datasets/);
});

test('display-only fallback and pane identity validation', async t => {
  installChart(t,{items:[{ _title:'A',_value:'130 K' }]});
  const result = await capture();
  assert.equal(result.datasets[0].rows[0].display_text,'130 K');
  assert.equal(result.status,'partial');
  assert.equal(readStudySeriesPage({...context,pane_index:1},'id').failure.code,'PANE_CONTEXT_CHANGED');
  assert.equal(readStudySeriesPage(context,'another').failure.code,'STUDY_INSTANCE_NOT_FOUND');
  let checks=0;
  await assert.rejects(capture(null,{ activatePaneContext: async () => ({...context, active:++checks===1}) }),
    {code:'PANE_CONTEXT_CHANGED'});
});
