import { jsonResult } from './_format.js';
import { z } from 'zod';
import * as core from '../core/strategy.js';
import { paneContextSchema, withPaneContext } from './pane-context.js';

export function registerStrategyTools(server) {
  server.tool('strategy_get_active', 'Get the currently report-ready Strategy Instance from the active pane', {
    ...paneContextSchema,
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getActiveStrategy())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_select', 'Select an explicit active-pane Strategy Instance and wait for its report', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID from study_list'),
    timeout_ms: z.coerce.number().optional().describe('Readback timeout in milliseconds (default 20000, max 60000)'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.selectStrategy({ entity_id: args.entity_id, timeout_ms: args.timeout_ms }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_get_report', 'Get performance metrics for an explicit Strategy Instance', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getStrategyReport({ entity_id: args.entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_get_orders', 'Get raw Strategy order events; Orders are not paired Trades', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
    limit: z.coerce.number().optional().describe('Most recent orders (default 200, max 5000)'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getStrategyOrders({ entity_id: args.entity_id, limit: args.limit }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_get_trades', 'Get paired entry/exit Trades for an explicit Strategy Instance', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
    limit: z.coerce.number().optional().describe('Most recent trades (default 200, max 5000)'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getStrategyTrades({ entity_id: args.entity_id, limit: args.limit }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('strategy_get_equity', 'Get the Strategy equity curve when TradingView exposes one', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getStrategyEquity({ entity_id: args.entity_id }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
