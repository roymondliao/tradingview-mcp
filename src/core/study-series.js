import { callPageFunction } from '../connection.js';
import { activatePaneContext } from './pane.js';
import { CoreOperationError } from './errors.js';
import { buildStudyInputCatalog, classifyStudyMetadata, classifyStudySource } from './studies.js';
import { unixSecondsToIso, withUnixSecondsIso } from './time.js';
import { readStudySeriesPage } from './study-series-runtime.js';

function seriesError(code, message, kind = 'validation') {
  return new CoreOperationError(message, { code, kind, phase: 'study_series', retryable: code === 'STUDY_SERIES_NOT_READY' });
}

function finalizeDataset(dataset, range) {
  const timeKeys = dataset.columns.filter(c => c.role === 'unix_seconds').map(c => c.key);
  let rows = dataset.rows;
  if (dataset.basis === 'bar_time') {
    rows = rows.filter(row => !range || withinRange(row.time, range))
      .sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity));
  }
  let from = Infinity;
  let to = -Infinity;
  for (const row of rows) {
    for (const key of timeKeys) {
      row[key + '_iso'] = unixSecondsToIso(row[key]);
      if (Number.isFinite(row[key])) {
        from = Math.min(from, row[key]);
        to = Math.max(to, row[key]);
      }
    }
  }
  return { ...dataset, rows, row_count: rows.length,
    period: Number.isFinite(from) ? withUnixSecondsIso({ from, to }, ['from','to']) : null };
}

function withinRange(time, range) {
  return Number.isFinite(time) && time >= range.from && (range.to == null || time <= range.to);
}

export async function getStudySeries({ entity_id, context, range = null, _deps = {} }) {
  const check = _deps.activatePaneContext || activatePaneContext;
  async function assertPane() {
    const actual = await check({ context, activate: false, reacquire: false, phase: 'study_series' });
    if (!actual.active || actual.symbol !== context.symbol || actual.resolution !== context.resolution) {
      throw seriesError('PANE_CONTEXT_CHANGED', 'Pane changed during study capture.', 'identity');
    }
  }
  await assertPane();
  const raw = await (_deps.callPageFunction || callPageFunction)(readStudySeriesPage, [context, entity_id]);
  if (raw.failure) {
    const { code, message } = raw.failure;
    throw seriesError(code, message, ['PANE_CONTEXT_CHANGED','STUDY_INSTANCE_NOT_FOUND'].includes(code) ? 'identity' : 'internal');
  }
  await assertPane();
  const datasets = raw.datasets.map(d => finalizeDataset(d, range));
  return {
    schema_version: 1, success: true, status: raw.issues.length ? 'partial' : 'ok', scope: 'loaded',
    context, captured_at_iso: raw.captured_at_iso, chart_bar_time: raw.chart_bar_time,
    chart_bar_time_iso: unixSecondsToIso(raw.chart_bar_time),
    requested_range: range && withUnixSecondsIso(range, ['from','to']),
    study: { entity_id, name: raw.name, type: classifyStudyMetadata(raw.meta), source: classifyStudySource(raw.meta),
      inputs: buildStudyInputCatalog({ values: raw.values, info: raw.info }) },
    available_datasets: datasets.map(d => d.key), datasets, issues: raw.issues,
  };
}

export function selectDatasets(snapshot, { dataset, format }) {
  const { available_datasets: keys, requested_range: range } = snapshot;
  let tables = snapshot.datasets;
  if (dataset) {
    if (!keys.includes(dataset)) {
      throw seriesError('STUDY_DATASET_UNAVAILABLE', 'Available datasets: ' + keys.join(', '));
    }
    tables = tables.filter(d => d.key === dataset);
  }
  if (range) {
    tables = tables.filter(d => {
      if (d.basis === 'bar_time') return true;
      const time = d.basis === 'chart_snapshot' ? snapshot.chart_bar_time : Date.parse(snapshot.captured_at_iso) / 1000;
      return withinRange(time, range);
    });
    if (!tables.length) {
      throw seriesError('STUDY_SNAPSHOT_OUTSIDE_RANGE', 'No snapshot within the requested range. For graphics, select the cutoff bar in Replay.');
    }
  }
  if (format === 'csv' && tables.length !== 1) {
    throw seriesError('STUDY_DATASET_REQUIRED', 'Select one dataset for CSV: ' + tables.map(d => d.key).join(', '));
  }
  return { ...snapshot, datasets: tables };
}
