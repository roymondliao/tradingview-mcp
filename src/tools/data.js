import { z } from 'zod';
import { coreErrorResult, jsonResult } from './_format.js';
import * as core from '../core/data.js';
import * as strategyCore from '../core/strategy.js';
import { paneContextSchema, withPaneContext } from './pane-context.js';

export function registerDataTools(server) {
  server.tool('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    ...paneContextSchema,
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getOhlcv({ count: args.count, summary: args.summary }))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_history', 'Load older OHLCV batches until the requested start time or the available TradingView history is reached. TradingView plan/data limits still apply. Returns metadata by default; set include_bars=true for the full dataset.', {
    ...paneContextSchema,
    symbol: z.string().optional().describe('Symbol to load (for example NASDAQ:AAPL). Blank uses the current chart.'),
    timeframe: z.string().optional().describe('Chart resolution (for example D, W, 60, or 15). Blank uses the current chart.'),
    from: z.union([z.string(), z.coerce.number()]).optional().describe('Optional earliest date or Unix timestamp. Blank requests the first available bar.'),
    bars_per_request: z.coerce.number().optional().describe('Older bars requested per TradingView data load (default 1000, range 100-5000).'),
    max_requests: z.coerce.number().optional().describe('Safety limit for backward data requests (default 100, max 500).'),
    max_bars: z.coerce.number().optional().describe('Safety limit for returned bars (default 50000, max 200000).'),
    include_bars: z.coerce.boolean().optional().describe('Include the complete OHLCV bars array (default false).'),
    restore_chart: z.coerce.boolean().optional().describe('Restore the original chart symbol/timeframe after loading (default true).'),
  }, async (args) => {
    try { return jsonResult(await withPaneContext(args, () => core.getHistory(args))); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  }, async ({ entity_id }) => {
    try { return jsonResult(await core.getIndicator({ entity_id })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_strategy_results', 'Deprecated alias: get strategy performance metrics by explicit entity ID.', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
  }, async (args) => {
    try {
      const result = await withPaneContext(args, () => strategyCore.getStrategyReport({ entity_id: args.entity_id }));
      return jsonResult({ ...result, deprecated: true, snapshot_complete: false });
    } catch (err) { return coreErrorResult(err, { deprecated: true, snapshot_complete: false }); }
  });

  server.tool('data_get_trades', 'Deprecated alias: get paired Strategy trades by explicit entity ID.', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
  }, async (args) => {
    try {
      const result = await withPaneContext(args, () => strategyCore.getStrategyTrades({
        entity_id: args.entity_id, limit: args.max_trades,
      }));
      return jsonResult({ ...result, deprecated: true, snapshot_complete: false });
    } catch (err) { return coreErrorResult(err, { deprecated: true, snapshot_complete: false }); }
  });

  server.tool('data_get_equity', 'Deprecated alias: get Strategy equity by explicit entity ID.', {
    ...paneContextSchema,
    entity_id: z.string().describe('Strategy Instance entity ID'),
  }, async (args) => {
    try {
      const result = await withPaneContext(args, () => strategyCore.getStrategyEquity({ entity_id: args.entity_id }));
      return jsonResult({ ...result, deprecated: true });
    } catch (err) { return coreErrorResult(err, { deprecated: true }); }
  });

  server.tool('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume). If symbol is provided and differs from the current chart, the chart is briefly switched to fetch the quote and then restored — adds ~1-2s and serializes parallel calls.', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol). Non-blank values cause a chart switch + restore.'),
  }, async ({ symbol }) => {
    try { return jsonResult(await core.getQuote({ symbol })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {}, async () => {
    try { return jsonResult(await core.getDepth()); }
    catch (err) { return jsonResult({ success: false, error: err.message, hint: 'Open the DOM panel in TradingView before using this tool.' }, true); }
  });

  server.tool('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  }, async ({ study_filter, max_labels, verbose }) => {
    try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  }, async ({ study_filter }) => {
    try { return jsonResult(await core.getPineTables({ study_filter })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  }, async ({ study_filter, verbose }) => {
    try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {}, async () => {
    try { return jsonResult(await core.getStudyValues()); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}
