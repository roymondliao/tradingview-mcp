import { register } from '../router.js';
import * as core from '../../core/data.js';
import * as strategyCore from '../../core/strategy.js';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PANE_CONTEXT_OPTIONS, withPaneContext } from '../pane-context.js';

export function writeHistoryOutput(result, output, {
  force = false,
  writeFile = writeFileSync,
  resolvePath = resolve,
} = {}) {
  const outputPath = resolvePath(String(output));
  writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, {
    encoding: 'utf8',
    flag: force ? 'w' : 'wx',
  });
  const { bars, ...summary } = result;
  return {
    ...summary,
    output: outputPath,
    output_includes_bars: Array.isArray(bars),
  };
}

register('quote', {
  description: 'Get real-time price quote',
  handler: (opts, positionals) => core.getQuote({ symbol: positionals[0] }),
});

register('ohlcv', {
  description: 'Get OHLCV bar data',
  options: {
    ...PANE_CONTEXT_OPTIONS,
    count: { type: 'string', short: 'n', description: 'Number of bars (default 100, max 500)' },
    summary: { type: 'boolean', short: 's', description: 'Return summary stats instead of all bars' },
  },
  handler: (opts) => withPaneContext(opts, () => core.getOhlcv({
    count: opts.count ? Number(opts.count) : undefined,
    summary: opts.summary,
  })),
});

register('history', {
  description: 'Fetch all OHLCV history available from the TradingView chart',
  options: {
    ...PANE_CONTEXT_OPTIONS,
    symbol: { type: 'string', description: 'Symbol to load (default: current chart)' },
    timeframe: { type: 'string', short: 't', description: 'Resolution such as D, W, 60, or 15' },
    from: { type: 'string', short: 'f', description: 'Earliest ISO date or Unix timestamp' },
    'bars-per-request': { type: 'string', description: 'Older bars requested per load (default 1000, max 5000)' },
    'max-requests': { type: 'string', description: 'Maximum backward data requests (default 100, max 500)' },
    'max-bars': { type: 'string', description: 'Maximum returned bars (default 50000, max 200000)' },
    'include-bars': { type: 'boolean', short: 'b', description: 'Include the full OHLCV bars array' },
    output: { type: 'string', short: 'o', description: 'Write the JSON result to a file' },
    force: { type: 'boolean', description: 'Overwrite an existing output file' },
    'no-restore': { type: 'boolean', description: 'Leave the requested symbol/timeframe on the chart' },
  },
  handler: async (opts) => {
    if (Object.prototype.hasOwnProperty.call(opts, 'page-size')) {
      throw new Error('--page-size was renamed to --bars-per-request');
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'max-pages')) {
      throw new Error('--max-pages was renamed to --max-requests');
    }
    if (Object.prototype.hasOwnProperty.call(opts, 'bars')) {
      throw new Error('--bars was renamed to --include-bars');
    }
    const result = await withPaneContext(opts, () => core.getHistory({
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      from: opts.from,
      bars_per_request: opts['bars-per-request'] ? Number(opts['bars-per-request']) : undefined,
      max_requests: opts['max-requests'] ? Number(opts['max-requests']) : undefined,
      max_bars: opts['max-bars'] ? Number(opts['max-bars']) : undefined,
      include_bars: opts['include-bars'],
      restore_chart: !opts['no-restore'],
    }));
    return opts.output ? writeHistoryOutput(result, opts.output, { force: opts.force }) : result;
  },
});

register('values', {
  description: 'Get current indicator values from data window',
  handler: () => core.getStudyValues(),
});

register('data', {
  description: 'Advanced data tools (lines, labels, tables, boxes, strategy, trades, equity, depth)',
  subcommands: new Map([
    ['lines', {
      description: 'Get Pine Script line.new() price levels',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw line data' },
      },
      handler: (opts) => core.getPineLines({ study_filter: opts.filter, verbose: opts.verbose }),
    }],
    ['labels', {
      description: 'Get Pine Script label.new() annotations',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        max: { type: 'string', short: 'n', description: 'Max labels per study (default 50)' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw label data' },
      },
      handler: (opts) => core.getPineLabels({ study_filter: opts.filter, max_labels: opts.max ? Number(opts.max) : undefined, verbose: opts.verbose }),
    }],
    ['tables', {
      description: 'Get Pine Script table.new() data',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
      },
      handler: (opts) => core.getPineTables({ study_filter: opts.filter }),
    }],
    ['boxes', {
      description: 'Get Pine Script box.new() price zones',
      options: {
        filter: { type: 'string', short: 'f', description: 'Filter by study name substring' },
        verbose: { type: 'boolean', short: 'v', description: 'Include raw box data' },
      },
      handler: (opts) => core.getPineBoxes({ study_filter: opts.filter, verbose: opts.verbose }),
    }],
    ['strategy', {
      description: 'Deprecated alias: get strategy metrics by explicit entity ID',
      handler: (opts, positionals) => strategyCore.getStrategyReport({ entity_id: positionals[0] }),
    }],
    ['trades', {
      description: 'Deprecated alias: get paired strategy trades by explicit entity ID',
      options: {
        max: { type: 'string', short: 'n', description: 'Max trades to return' },
      },
      handler: (opts, positionals) => strategyCore.getStrategyTrades({
        entity_id: positionals[0], limit: opts.max ? Number(opts.max) : undefined,
      }),
    }],
    ['equity', {
      description: 'Deprecated alias: get strategy equity by explicit entity ID',
      handler: (opts, positionals) => strategyCore.getStrategyEquity({ entity_id: positionals[0] }),
    }],
    ['depth', {
      description: 'Get order book / DOM data',
      handler: () => core.getDepth(),
    }],
    ['indicator', {
      description: 'Get indicator info and inputs by entity ID',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Entity ID required. Usage: tv data indicator eFu1Ot');
        return core.getIndicator({ entity_id: positionals[0] });
      },
    }],
  ]),
});
