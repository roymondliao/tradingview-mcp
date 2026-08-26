import { register } from '../router.js';
import * as core from '../../core/studies.js';
import { PANE_CONTEXT_OPTIONS, withPaneContext } from '../pane-context.js';

register('study', {
  description: 'Study tools — search and inspect indicators/strategies on the active pane',
  subcommands: new Map([
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
      },
      handler: (opts, positionals) => {
        const action = positionals[0];
        const entityId = positionals[1];
        if (!['get', 'set'].includes(action) || !entityId) {
          throw new Error('Usage: tv study inputs get <entity_id> | tv study inputs set <entity_id> --inputs \'{"in_0":20}\'');
        }
        if (action === 'get') return withPaneContext(opts, () => core.getStudyInputs({ entity_id: entityId }));
        if (!opts.inputs) throw new Error('--inputs is required for study inputs set');
        return withPaneContext(opts, () => core.setStudyInputs({ entity_id: entityId, inputs: opts.inputs }));
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
