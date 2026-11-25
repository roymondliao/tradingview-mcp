// Serialized into the Desktop page. Keep this function independent of Node imports.
export function readStudySeriesPage(expected, entityId) {
  const api = globalThis.TradingViewApi;
  const chart = api._activeChartWidgetWV.value();
  const widget = api._chartWidgetCollection.getAll()[expected.pane_index];
  const failure = (code, message) => ({ failure: { code, message } });
  if (!widget || chart._chartWidget !== widget || chart.symbol() !== expected.symbol
      || chart.resolution() !== expected.resolution) {
    return failure('PANE_CONTEXT_CHANGED', 'The selected pane changed before capture.');
  }
  const model = widget.model();
  const sources = model.model().dataSources().filter(source => {
    const id = typeof source.id === 'function' ? source.id() : source.id;
    return id != null && String(id) === entityId;
  });
  const wrapper = chart.getStudyById(entityId);
  if (sources.length !== 1 || !wrapper) {
    return failure('STUDY_INSTANCE_NOT_FOUND', 'Study instance unavailable in the selected pane.');
  }
  const source = sources[0];
  if (typeof source.isLoading === 'function' && source.isLoading()) {
    return failure('STUDY_SERIES_NOT_READY', 'Study is loading.');
  }
  const issues = [];
  const datasets = [];
  const meta = source.metaInfo?.() || {};
  const bars = model.mainSeries().bars();
  const snapshot = {
    captured_at_iso: new Date().toISOString(),
    chart_bar_time: bars.valueAt(bars.lastIndex())?.[0] ?? null,
    meta: { id: meta.fullId || meta.id, description: meta.description,
      isTVScriptStrategy: meta.isTVScriptStrategy, is_strategy: meta.is_strategy },
    name: meta.description || meta.shortDescription || entityId,
    values: [], info: [], datasets, issues,
  };
  const groupedIssues = new Map();
  function issue(code, dataset, message, field, object_id) {
    const key = JSON.stringify([code, dataset, field]);
    if (groupedIssues.has(key)) {
      groupedIssues.get(key).count++;
      return;
    }
    const value = { code, dataset, message, field, object_id, count: 1 };
    groupedIssues.set(key, value);
    issues.push(value);
  }
  function read(key, fn) {
    try {
      fn();
    } catch (error) {
      issue('SOURCE_READ_FAILED', key, String(error.message || error));
    }
  }
  const column = (key, type, role, title = key) => ({ key, title, type, role });
  const timeColumns = key => [column(key, 'number', 'unix_seconds'), column(key + '_iso', 'string', 'utc')];
  read('inputs', () => {
    const info = wrapper.getInputsInfo?.() || [];
    const internal = new Set(['text', 'pineId', 'pineVersion', 'pineFeatures', '__profile']);
    const exposed = info.filter(i => !i.isHidden && !internal.has(i.id));
    const ids = new Set(exposed.map(i => i.id));
    snapshot.info = exposed.map(({ id, name, type }) => ({ id, name, type }));
    snapshot.values = (wrapper.getInputValues?.() || []).filter(i => !internal.has(i.id) && (!info.length || ids.has(i.id)))
      .map(({ id, value }) => ({ id, value }));
  });

  read('plots', () => {
    if (!meta.plots?.length) return;
    const data = source.data();
    const columns = [...timeColumns('time'), column('source_index', 'number', 'logical_index')];
    const used = new Set(columns.map(c => c.key));
    const componentTitles = {
      ohlc_open: 'Open', ohlc_high: 'High', ohlc_low: 'Low', ohlc_close: 'Close',
      colorer: 'Color index', ohlc_colorer: 'Body color index',
      wick_colorer: 'Wick color index', border_colorer: 'Border color index',
    };
    const plots = meta.plots.map((p, i) => {
      let key = p.id;
      if (!key || used.has(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        key = 'slot_' + i;
        while (used.has(key)) key += '_';
        issue('PLOT_KEY_REPLACED', 'plots', 'Missing or conflicting plot ID.', key);
      }
      used.add(key);
      const role = /colorer/.test(p.type) ? 'color_index' : p.type || 'unknown';
      const targetTitle = meta.ohlcPlots?.[p.target]?.title || meta.styles?.[p.target]?.title || p.target;
      const component = Object.hasOwn(componentTitles, p.type) ? componentTitles[p.type] : p.type;
      const title = meta.styles?.[p.id]?.title || [targetTitle, component].filter(Boolean).join(' ') || 'Untitled plot';
      columns.push({ ...column(key, 'number', role, title),
        source_id: p.id ?? null, source_slot: i + 1 });
      return key;
    });
    const rows = [];
    data.each((index, raw) => {
      const row = { time: Number.isFinite(raw[0]) ? raw[0] : null, source_index: index };
      if (row.time == null) issue('TIME_UNAVAILABLE', 'plots', 'Missing bar timestamp.', 'time', index);
      plots.forEach((key, i) => {
        row[key] = raw[i + 1] ?? null;
        if (i + 1 >= raw.length) issue('SLOT_UNAVAILABLE', 'plots', 'Missing source slot.', key, index);
      });
      rows.push(row);
    });
    datasets.push({ key: 'plots', basis: 'bar_time', columns, rows });
  });

  const graphics = source._graphics;
  const collections = graphics?._primitivesCollection;
  const interval = [['x1', 'start_time', 'start_index'], ['x2', 'end_time', 'end_index']];
  const layouts = {
    dwgboxes: ['boxes', ['x1', 'x2', 'y1', 'y2'], interval],
    dwglines: ['lines', ['x1', 'x2', 'y1', 'y2'], interval],
    dwglabels: ['labels', ['x', 'y', 't'], [['x', 'time', 'chart_index']]],
    dwgtablecells: ['table_cells', ['tid', 'row', 'col', 't'], []],
  };
  function resolveAnchor(row, raw, [x, time, index], key) {
    const logical = Number.isInteger(raw[x]) ? graphics._indexes?.[raw[x]] : null;
    row[index] = Number.isInteger(logical) ? logical : null;
    // A projected drawing can extend past the last observed bar in Replay.
    const loaded = row[index] != null && logical >= bars.firstIndex() && logical <= bars.lastIndex();
    const timestamp = loaded ? model.timeScale()?.indexToTimePoint?.(logical) : null;
    row[time] = Number.isFinite(timestamp) ? timestamp : null;
    if (row[time] == null) issue('ANCHOR_UNRESOLVED', key, 'No verified timestamp for this anchor.', x, row.id);
  }
  const kinds = new Set(Object.keys(meta.graphics || {}));
  for (const [kind, groups] of Object.entries(collections || {})) {
    if (groups?.size && kind !== 'performance') kinds.add(kind);
  }
  for (const kind of kinds) {
    const layout = Object.hasOwn(layouts, kind) && layouts[kind];
    const [key, fields, anchors] = layout || ['graphics_' + kind, [], []];
    read(key, () => {
      const groups = collections?.[kind];
      if (!groups || typeof groups.entries !== 'function') throw new Error('Graphics collection unavailable: ' + kind);
      const columns = [
        column('id', 'scalar', 'object_id'), column('group', 'string', 'source_group'),
        column('variant', 'scalar', 'source_group'),
        ...fields.map(f => column(f, f === 't' ? 'string' : 'scalar', 'source_field')),
        column('attributes', 'object', 'source_attributes'),
      ];
      for (const [, time, index] of anchors) columns.push(column(index, 'number', 'logical_index'), ...timeColumns(time));
      const rows = [];
      const seen = new Set();
      let unreadable = false;
      for (const [group, collection] of groups) {
        const variants = collection?._primitivesDataById ? [[null, collection]] : collection;
        if (typeof variants?.[Symbol.iterator] !== 'function') {
          issue('UNKNOWN_COLLECTION', key, 'Unrecognized graphics group.', String(group));
          unreadable = true;
          continue;
        }
        for (const [variant, container] of variants) {
          const primitives = container?._primitivesDataById;
          if (!primitives || typeof primitives.entries !== 'function') {
            issue('UNKNOWN_COLLECTION', key, 'Unrecognized primitive container.', String(group));
            unreadable = true;
            continue;
          }
          if (seen.has(primitives)) continue;
          seen.add(primitives);
          for (const [id, raw] of primitives) {
            const row = { id, group, variant, attributes: Object.create(null) };
            for (const f of fields) row[f] = raw[f] ?? null;
            for (const [f, v] of Object.entries(raw)) {
              if (f !== 'id' && !fields.includes(f)) row.attributes[f] = v;
            }
            for (const anchor of anchors) resolveAnchor(row, raw, anchor, key);
            rows.push(row);
          }
        }
      }
      if (unreadable && seen.size === 0) return;
      if (!layout) issue('UNKNOWN_GRAPHICS_TYPE', key, 'Source attributes retained without coordinate interpretation.');
      datasets.push({ key, basis: 'chart_snapshot', columns, rows });
    });
  }
  read('display_values', () => {
    const items = source.dataWindowView?.()?.items?.() || [];
    const rows = Array.from(items, (item, ordinal) => ({ ordinal, title: item._title, display_text: item._value }))
      .filter(item => item.title && item.display_text != null && item.display_text !== '∅');
    if (rows.length) datasets.push({ key: 'display_values', basis: 'capture_time', rows, columns: [
      column('ordinal','number','item_index'), column('title','string','title'), column('display_text','string','formatted'),
    ] });
  });
  if (datasets.length === 1 && datasets[0].key === 'display_values') {
    issue('DISPLAY_ONLY', 'display_values', 'Only formatted values are available.');
  }
  if (!datasets.length) return failure('STUDY_SERIES_UNAVAILABLE', issues[0]?.message || 'No readable study outputs.');
  return snapshot;
}
