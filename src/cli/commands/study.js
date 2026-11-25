import { extname } from 'node:path';
import { normalizeHistoryRange } from '../../core/data.js';
import { selectDatasets } from '../../core/study-series.js';
import { previewStudySeries, writeStudySeriesArtifact } from '../../core/study-series-format.js';
import { register } from '../router.js';
import * as core from '../../core/studies.js';
import { PANE_CONTEXT_OPTIONS, withPaneContext } from '../pane-context.js';

const seriesOptions = {
  ...PANE_CONTEXT_OPTIONS,
  dataset: { type: 'string', description: 'Select an output such as plots, boxes, lines, or labels' },
  format: { type: 'string', description: 'json (default) or csv (one dataset; --output required when writing CSV)' },
  output: { type: 'string', short: 'o', description: 'Write to a file and print a JSON summary' },
  force: { type: 'boolean', description: 'Replace an existing output file' },
  'dry-run': { type: 'boolean', description: 'Preview selected datasets, columns and recommended format as JSON without writing an output file' },
  from: { type: 'string', description: 'Filter loaded rows from an inclusive ISO date/time or Unix timestamp' },
  to: { type: 'string', description: 'Inclusive cutoff (requires --from); use an explicit time for end of day' },
};

export async function runSeries(opts, positionals, { withContext = withPaneContext, getSeries = core.getStudySeries } = {}) {
  for (const [key, value] of Object.entries(opts)) {
    if (!Object.hasOwn(seriesOptions, key)) throw new Error('Unknown option: --' + key);
    if (seriesOptions[key].type === 'string' && (typeof value !== 'string' || !value.trim() || value.startsWith('--'))) {
      throw new Error('Missing value for --' + key);
    }
  }
  if (positionals.length !== 1 || !positionals[0].trim()) throw new Error('Usage: tv study series <entity_id> [options]');
  const { dataset, output, force, format = 'json' } = opts;
  const dryRun = opts['dry-run'] === true;
  if (opts['dry-run'] !== undefined && typeof opts['dry-run'] !== 'boolean') throw new Error('--dry-run takes no value');
  if (!['json','csv'].includes(format)) throw new Error('--format must be json or csv');
  const writingCsv = format === 'csv' && !dryRun;
  if ((writingCsv || force) && !output) throw new Error('CSV exports and --force require --output');
  const ext = extname(output || '').toLowerCase();
  if (['.json','.csv'].includes(ext) && ext !== '.' + format) throw new Error('--format conflicts with output extension');
  const { fromTime, toTime } = normalizeHistoryRange(opts);
  const range = fromTime == null ? null : { from: fromTime, to: toTime };
  const snapshot = await withContext(opts, context => getSeries({ entity_id: positionals[0], context, range }));
  const result = selectDatasets(snapshot, { dataset, format });
  if (dryRun) return previewStudySeries(result, format);
  return output ? writeStudySeriesArtifact(result, { format, output, force }) : result;
}

register('study', {
  desktop_dependency: 'required',
  description: 'Study tools — search and inspect indicators/strategies on the active pane',
  subcommands: new Map([
    ['series', {
      usage: '<entity_id>',
      description: 'Export loaded study plots and graphics by entity ID (JSON or CSV)',
      options: seriesOptions, handler: runSeries,
    }],
    ['search', {
      description: 'Search TradingView study catalog without adding to the pane',
      options: {
        source: { type: 'string', short: 's', description: 'Filter: built-in or account' },
        type: { type: 'string', short: 't', description: 'Filter: strategy, indicator, unknown' },
        limit: { type: 'string', short: 'n', description: 'Maximum results (default 25, max 100)' },
      },
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Query required. Usage: tv study search "Supertrend"');
        return core.searchCatalog({
          query: positionals.join(' '), source: opts.source, type: opts.type,
          limit: opts.limit ? Number(opts.limit) : undefined,
        });
      },
    }],
    ['list', {
      description: 'List Study Instances on the active pane',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        type: { type: 'string', short: 't', description: 'Filter: strategy, indicator, unknown' },
      },
      handler: (opts) => withPaneContext(opts, () => core.listActivePaneStudies({ type: opts.type })),
    }],
    ['get', {
      description: 'Get one active-pane Study Instance by entity ID',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv study get eFu1Ot');
        return withPaneContext(opts, () => core.getActivePaneStudy({ entity_id: positionals[0] }));
      },
    }],
    ['add', {
      description: 'Add a Saved Pine or built-in Study to the active pane',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        'script-id': { type: 'string', description: 'Account Saved Pine Script ID (USER;...)' },
        'study-id': { type: 'string', description: 'Stable TradingView Study definition ID' },
        query: { type: 'string', short: 'q', description: 'Unique Study title/query' },
        source: { type: 'string', short: 's', description: 'Query source filter: built-in or account' },
        type: { type: 'string', short: 't', description: 'Query type filter' },
        inputs: { type: 'string', short: 'i', description: 'Optional JSON input overrides' },
      },
      handler: (opts) => withPaneContext(opts, () => core.addActivePaneStudy({
        script_id: opts['script-id'], study_id: opts['study-id'], query: opts.query,
        source: opts.source, type: opts.type, inputs: opts.inputs,
      })),
    }],
    ['inputs', {
      description: 'Get or set active-pane Study inputs',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        inputs: { type: 'string', short: 'i', description: 'JSON input overrides for set' },
        'inputs-by-name': { type: 'string', description: 'JSON input overrides keyed by exact Input name' },
      },
      handler: (opts, positionals) => {
        const action = positionals[0];
        const entityId = positionals[1];
        if (!['get', 'set'].includes(action) || !entityId) {
          throw new Error('Usage: tv study inputs get <entity_id> | tv study inputs set <entity_id> --inputs \'{"in_0":20}\'');
        }
        if (action === 'get') return withPaneContext(opts, () => core.getStudyInputs({ entity_id: entityId }));
        core.validateStudyInputSelectors({
          entity_id: entityId,
          inputs: opts.inputs,
          inputs_by_name: opts['inputs-by-name'],
        });
        return withPaneContext(opts, () => core.setStudyInputs({
          entity_id: entityId,
          inputs: opts.inputs,
          inputs_by_name: opts['inputs-by-name'],
        }));
      },
    }],
    ['toggle', {
      description: 'Show or hide an active-pane Study Instance',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        visible: { type: 'boolean', description: 'Show the Study' },
        hidden: { type: 'boolean', description: 'Hide the Study' },
      },
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv study toggle eFu1Ot --visible');
        return withPaneContext(opts, () => core.toggleStudyVisibility({
          entity_id: positionals[0],
          visible: opts.hidden ? false : (opts.visible !== undefined ? opts.visible : true),
        }));
      },
    }],
    ['remove', {
      description: 'Remove a Study Instance from the active pane',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv study remove eFu1Ot');
        return withPaneContext(opts, () => core.removeActivePaneStudy({ entity_id: positionals[0] }));
      },
    }],
  ]),
});
