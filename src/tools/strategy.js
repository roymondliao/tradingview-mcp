import { z } from 'zod';
import { coreErrorResult, jsonResult } from './_format.js';
import * as legacyStrategyCore from '../core/strategy.js';
import * as strategyTradingCore from '../core/strategy-trading.js';
import { prepareContext as preparePaneContext } from '../core/pane.js';
import { paneContextArgs, paneContextSchema } from './pane-context.js';

const symbolSchema = z.string().regex(/^[^:\s]+:[^:\s]+$/)
  .describe('Required exchange:symbol identity');
const timeoutSchema = z.coerce.number().int().min(100).max(60000).optional()
  .describe('Per-phase timeout in milliseconds (default 20000)');
const formatSchema = z.enum(['json', 'jsonl', 'csv']).optional()
  .describe('Canonical Trading Data format (default json)');

function toolHandler(operation) {
  return async (args) => {
    try {
      const result = await operation(args);
      return jsonResult(result, result?.success === false);
    } catch (error) {
      return coreErrorResult(error);
    }
  };
}

export function registerStrategyTools(server, dependencies = {}) {
  const legacyCore = dependencies.legacyCore || legacyStrategyCore;
  const tradingCore = dependencies.tradingCore || strategyTradingCore;
  const resolveContext = dependencies.prepareContext
    || ((args) => preparePaneContext(paneContextArgs(args)));

  server.tool('strategy_get_active', 'Get the active Strategy, Report state, and safe snapshot metadata from one resolved pane', {
    ...paneContextSchema,
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    const result = await legacyCore.getActiveStrategy({ context });
    return { ...result, context };
  }));

  server.tool('strategy_get_trading_report', 'Get a fresh canonical Trading Report for an explicit Strategy and Symbol', {
    ...paneContextSchema,
    entity_id: z.string().min(1).describe('Strategy Instance entity ID from study_list'),
    symbol: symbolSchema,
    timeframe: z.string().optional().describe('Chart resolution; blank uses the resolved Pane timeframe'),
    timeout_ms: timeoutSchema,
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    return tradingCore.getStrategyTradingReport({
      entity_id: args.entity_id,
      symbol: args.symbol,
      timeframe: args.timeframe,
      timeout_ms: args.timeout_ms,
      context,
    });
  }));

  server.tool('strategy_get_trading_data', 'Get one canonical oldest-first Strategy Trade batch, or atomically write that batch to JSON, JSONL, or CSV', {
    ...paneContextSchema,
    entity_id: z.string().min(1).describe('Strategy Instance entity ID from study_list'),
    symbol: symbolSchema,
    timeframe: z.string().optional().describe('Chart resolution; blank uses the resolved Pane timeframe'),
    offset: z.coerce.number().int().min(0).optional().describe('Oldest-first Trade offset (default 0)'),
    limit: z.coerce.number().int().min(1).max(5000).optional().describe('Maximum paired Trades (default 500)'),
    snapshot_id: z.string().optional().describe('Required previous snapshot ID when offset is greater than 0'),
    format: formatSchema,
    output: z.string().min(1).optional().describe('Optional local artifact file; response becomes a bounded summary'),
    force: z.coerce.boolean().optional().describe('Atomically replace an existing output file; requires output'),
    timeout_ms: timeoutSchema,
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    return tradingCore.getStrategyTradingData({
      entity_id: args.entity_id,
      symbol: args.symbol,
      timeframe: args.timeframe,
      offset: args.offset,
      limit: args.limit,
      snapshot_id: args.snapshot_id,
      format: args.format,
      output: args.output,
      force: args.force,
      timeout_ms: args.timeout_ms,
      context,
    });
  }));

  server.tool('strategy_export_trading', 'Export verified Report, complete Trading Data, reconciliation, and manifest artifacts for one Symbol or the Active Watchlist', {
    ...paneContextSchema,
    entity_id: z.string().min(1).describe('Strategy Instance entity ID from study_list'),
    symbol: symbolSchema.optional().describe('One Symbol; mutually exclusive with watchlist'),
    watchlist: z.literal('active').optional().describe('Export the immutable Active Watchlist snapshot'),
    timeframe: z.string().optional().describe('Chart resolution; blank uses the resolved Pane timeframe'),
    output_directory: z.string().min(1).describe('Required parent directory for the atomic run output'),
    format: formatSchema,
    force: z.coerce.boolean().optional().describe('Atomically replace an existing run ID directory'),
    fail_fast: z.coerce.boolean().optional().describe('Stop after the first failed Watchlist Symbol'),
    timeout_ms: timeoutSchema,
  }, toolHandler(async (args) => {
    tradingCore.validateStrategyTradingExportScope(args);
    const context = await resolveContext(args);
    return tradingCore.exportStrategyTrading({
      entity_id: args.entity_id,
      symbol: args.symbol,
      watchlist: args.watchlist,
      timeframe: args.timeframe,
      output_directory: args.output_directory,
      format: args.format,
      force: args.force,
      fail_fast: args.fail_fast,
      timeout_ms: args.timeout_ms,
      context,
    });
  }));

  server.tool('strategy_select', 'Deprecated compatibility: select a Strategy Instance; not required by snapshot-complete tools', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID from study_list'),
    timeout_ms: z.coerce.number().optional().describe('Readback timeout in milliseconds (default 20000, max 60000)'),
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    const result = await legacyCore.selectStrategy({
      entity_id: args.entity_id, timeout_ms: args.timeout_ms,
    });
    return { ...result, context, deprecated: true };
  }));

  server.tool('strategy_get_report', 'Deprecated compatibility: get legacy performance metrics; not snapshot-complete', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    const result = await legacyCore.getStrategyReport({ entity_id: args.entity_id });
    return { ...result, context, deprecated: true, snapshot_complete: false };
  }));

  server.tool('strategy_get_orders', 'Get raw Strategy order events; Orders are not paired Trades', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
    limit: z.coerce.number().optional().describe('Most recent orders (default 200, max 5000)'),
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    const result = await legacyCore.getStrategyOrders({ entity_id: args.entity_id, limit: args.limit });
    return { ...result, context };
  }));

  server.tool('strategy_get_trades', 'Deprecated compatibility: get a tail of paired Trades; not snapshot-complete', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
    limit: z.coerce.number().optional().describe('Most recent trades (default 200, max 5000)'),
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    const result = await legacyCore.getStrategyTrades({ entity_id: args.entity_id, limit: args.limit });
    return { ...result, context, deprecated: true, snapshot_complete: false };
  }));

  server.tool('strategy_get_equity', 'Get the Strategy equity curve when TradingView exposes one', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
  }, toolHandler(async (args) => {
    const context = await resolveContext(args);
    const result = await legacyCore.getStrategyEquity({ entity_id: args.entity_id });
    return { ...result, context };
  }));
}
