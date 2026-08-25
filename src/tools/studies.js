import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/studies.js';
import { paneContextSchema, withPaneContext } from './pane-context.js';

export function registerStudyTools(server) {
  server.tool('study_search', 'Search TradingView indicators and strategies without adding them to the active pane', {
    query: z.string().describe('Search query'),
    source: z.enum(['built-in', 'account']).optional().describe('Optional source filter'),
    type: z.enum(['strategy', 'indicator', 'unknown']).optional().describe('Optional Study type filter'),
    limit: z.coerce.number().optional().describe('Maximum results (default 25, max 100)'),
  }, async ({ query, source, type, limit }) => {
    try { return jsonResult(await core.searchCatalog({ query, source, type, limit })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_list', 'List indicators and strategies attached to the active pane', {
    ...paneContextSchema,
    type: z.enum(['strategy', 'indicator', 'unknown']).optional().describe('Optional Study type filter'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.listActivePaneStudies({ type: args.type }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_get', 'Get one active-pane Study Instance and its safe input values', {
    ...paneContextSchema,
    entity_id: z.string().describe('Study Instance entity ID from study_list or chart_get_state'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getActivePaneStudy({ entity_id: args.entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_add', 'Add one Saved Pine or built-in Study to the active pane and return its new entity_id', {
    ...paneContextSchema,
    script_id: z.string().optional().describe('Account Saved Pine Script ID (USER;...)'),
    study_id: z.string().optional().describe('Stable TradingView Study definition ID'),
    query: z.string().optional().describe('Unique Study title/query'),
    source: z.enum(['built-in', 'account']).optional().describe('Query source filter'),
    type: z.enum(['strategy', 'indicator', 'unknown']).optional().describe('Query type filter'),
    inputs: z.string().optional().describe('Optional JSON input overrides'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.addActivePaneStudy({
      script_id: args.script_id, study_id: args.study_id, query: args.query,
      source: args.source, type: args.type, inputs: args.inputs,
    }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_get_inputs', 'Get safe input values for one active-pane Study Instance', {
    ...paneContextSchema,
    entity_id: z.string().describe('Study Instance entity ID'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getStudyInputs({ entity_id: args.entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_set_inputs', 'Change active-pane Study inputs without modifying Pine source', {
    ...paneContextSchema,
    entity_id: z.string().describe('Study Instance entity ID'),
    inputs: z.string().describe('JSON input overrides keyed by TradingView input ID'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.setStudyInputs({ entity_id: args.entity_id, inputs: args.inputs }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_toggle_visibility', 'Show or hide an active-pane Study Instance', {
    ...paneContextSchema,
    entity_id: z.string().describe('Study Instance entity ID'),
    visible: z.coerce.boolean().describe('true to show, false to hide'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.toggleStudyVisibility({ entity_id: args.entity_id, visible: args.visible }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('study_remove', 'Remove one Study Instance from the active pane without deleting its Account script', {
    ...paneContextSchema,
    entity_id: z.string().describe('Study Instance entity ID'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.removeActivePaneStudy({ entity_id: args.entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
