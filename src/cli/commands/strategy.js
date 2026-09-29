import { register } from '../router.js';
import * as core from '../../core/strategy.js';
import * as trading from '../../core/strategy-trading.js';
import { resolveTradingDataFormat } from '../../core/strategy-trading-format.js';
import { dryRunStrategyAutomation, runStrategyAutomation } from '../../core/strategy-run.js';
import { resumeStrategyAutomation } from '../../core/strategy-resume.js';
import { prepareContext } from '../../core/pane.js';
import { CoreOperationError } from '../../core/errors.js';
import {
  PANE_CONTEXT_OPTIONS,
  paneContextArgs,
  withPaneContext,
} from '../pane-context.js';

function requireStrategySymbolArgs(entityId, symbol, timeout, command) {
  if (!entityId) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase: 'request_validation',
    });
  }
  if (!symbol) {
    throw new CoreOperationError(`--symbol is required for strategy ${command}.`, {
      code: 'SYMBOL_REQUIRED', phase: 'request_validation', entity_id: entityId,
    });
  }
  if (!/^[^:\s]+:[^:\s]+$/.test(String(symbol).trim())) {
    throw new CoreOperationError('--symbol must use exchange:symbol format.', {
      code: 'SYMBOL_INVALID', phase: 'request_validation', entity_id: entityId, symbol,
    });
  }
  if (timeout != null) {
    const value = Number(timeout);
    if (!Number.isInteger(value) || value < 100 || value > 60000) {
      throw new CoreOperationError('--timeout must be an integer from 100 to 60000.', {
        code: 'STRATEGY_RUNTIME_INVALID', phase: 'request_validation', entity_id: entityId, symbol,
      });
    }
  }
}

function requireStrategyExportArgs(entityId, { symbol, watchlist, timeout, failFast }) {
  trading.validateStrategyTradingExportScope({
    entity_id: entityId, symbol, watchlist, fail_fast: failFast,
  });
  if (timeout != null) {
    const value = Number(timeout);
    if (!Number.isInteger(value) || value < 100 || value > 60000) {
      throw new CoreOperationError('--timeout must be an integer from 100 to 60000.', {
        code: 'STRATEGY_RUNTIME_INVALID', phase: 'request_validation', entity_id: entityId, symbol,
      });
    }
  }
}

function requireTradingDataPagination(offset, limit, snapshotId) {
  const parsedOffset = offset == null ? 0 : Number(offset);
  const parsedLimit = limit == null ? 500 : Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
    throw new CoreOperationError('--offset must be a non-negative integer.', {
      code: 'STRATEGY_RUNTIME_INVALID', phase: 'request_validation',
    });
  }
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 5000) {
    throw new CoreOperationError('--limit must be an integer from 1 to 5000.', {
      code: 'STRATEGY_RUNTIME_INVALID', phase: 'request_validation',
    });
  }
  if (parsedOffset > 0 && !snapshotId) {
    throw new CoreOperationError('--snapshot-id is required when --offset is greater than 0.', {
      code: 'STALE_STRATEGY_SNAPSHOT', phase: 'request_validation',
    });
  }
  return { offset: parsedOffset, limit: parsedLimit };
}

const SIGNAL_EXIT_CODES = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

/** Install graceful handlers only for one formal Run/Resume invocation. */
export async function withStrategyAutomationSignals(operation, {
  process_facade = process,
  AbortControllerClass = AbortController,
} = {}) {
  if (typeof operation !== 'function') throw new TypeError('Signal operation callback is required.');
  const controller = new AbortControllerClass();
  let received = 0;
  const handlers = {};
  for (const [signalName, exitCode] of Object.entries(SIGNAL_EXIT_CODES)) {
    handlers[signalName] = () => {
      received += 1;
      if (received === 1) {
        const reason = new CoreOperationError(`Received ${signalName}.`, {
          code: 'RUN_INTERRUPTED', phase: 'signal',
        });
        reason.signal = signalName;
        reason.exit_code = exitCode;
        controller.abort(reason);
        return;
      }
      process_facade.exit(exitCode);
    };
    process_facade.on(signalName, handlers[signalName]);
  }
  try {
    return await operation(controller.signal);
  } finally {
    for (const [signalName, handler] of Object.entries(handlers)) {
      process_facade.off(signalName, handler);
    }
  }
}

register('strategy', {
  description: 'Strategy Tester tools for explicit Strategy Instances',
  subcommands: new Map([
    ['run', {
      description: 'Execute a Strategy automation Run Config or validate it read-only',
      options: {
        config: { type: 'string', description: 'Required path to a versioned Run Config JSON file' },
        'dry-run': { type: 'boolean', description: 'Read-only validation and resource resolution' },
      },
      handler: async (opts) => {
        if (!opts.config) {
          throw new CoreOperationError('--config is required for strategy run.', {
            code: 'RUN_CONFIG_REQUIRED', phase: 'request_validation', retryable: false,
          });
        }
        if (opts['dry-run']) {
          return dryRunStrategyAutomation({ config_path: opts.config });
        }
        return withStrategyAutomationSignals((signal) => runStrategyAutomation({
          config_path: opts.config,
          signal,
        }));
      },
    }],
    ['resume', {
      description: 'Resume one existing durable Strategy Run in the same directory',
      options: {
        'run-directory': { type: 'string', description: 'Required existing durable Run Directory' },
      },
      handler: async (opts) => {
        if (!opts['run-directory']) {
          throw new CoreOperationError('--run-directory is required for strategy resume.', {
            code: 'RUN_RESUME_NOT_FOUND', phase: 'request_validation', retryable: false,
          });
        }
        const unknown = Object.keys(opts).filter((key) => key !== 'run-directory');
        if (unknown.length) {
          throw new CoreOperationError(`Unsupported strategy resume option: --${unknown[0]}.`, {
            code: 'RUN_RESUME_ARTIFACT_INVALID', phase: 'request_validation', retryable: false,
          });
        }
        return withStrategyAutomationSignals((signal) => resumeStrategyAutomation({
          run_directory: opts['run-directory'],
          signal,
        }));
      },
    }],
    ['active', {
      description: 'Get the active Strategy, Report state, and safe snapshot metadata',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts) => withPaneContext(opts, (context) => core.getActiveStrategy({ context })),
    }],
    ['trading-report', {
      description: 'Get a fresh canonical Trading Report for an explicit Strategy and Symbol',
      usage: '<entity-id>',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        symbol: { type: 'string', description: 'Required exchange:symbol identity' },
        timeframe: { type: 'string', description: 'Chart resolution (default current Pane timeframe)' },
        timeout: { type: 'string', description: 'Per-phase timeout in milliseconds (default 20000)' },
      },
      handler: async (opts, positionals) => {
        const entityId = positionals[0];
        requireStrategySymbolArgs(entityId, opts.symbol, opts.timeout, 'trading-report');
        const context = await prepareContext(paneContextArgs(opts));
        return trading.getStrategyTradingReport({
          entity_id: entityId,
          symbol: opts.symbol,
          timeframe: opts.timeframe,
          timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
          context,
        });
      },
    }],
    ['trading-data', {
      description: 'Get one canonical oldest-first Strategy Trade batch from a stable snapshot',
      usage: '<entity-id>',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        symbol: { type: 'string', description: 'Required exchange:symbol identity' },
        timeframe: { type: 'string', description: 'Chart resolution (default current Pane timeframe)' },
        offset: { type: 'string', description: 'Oldest-first Trade offset (default 0)' },
        limit: { type: 'string', description: 'Maximum paired Trades (default 500, max 5000)' },
        'snapshot-id': { type: 'string', description: 'Required previous snapshot ID when offset > 0' },
        format: { type: 'string', description: 'Output format: json (default), jsonl, or csv' },
        output: { type: 'string', short: 'o', description: 'Atomically write this batch to a file' },
        force: { type: 'boolean', description: 'Atomically replace an existing output file' },
        timeout: { type: 'string', description: 'Per-phase timeout in milliseconds (default 20000)' },
      },
      handler: async (opts, positionals) => {
        const entityId = positionals[0];
        requireStrategySymbolArgs(entityId, opts.symbol, opts.timeout, 'trading-data');
        const pagination = requireTradingDataPagination(opts.offset, opts.limit, opts['snapshot-id']);
        if (opts.force && !opts.output) {
          throw new CoreOperationError('--force requires --output.', {
            code: 'OUTPUT_WRITE_FAILED', phase: 'output_validation',
          });
        }
        const format = resolveTradingDataFormat({ format: opts.format, output: opts.output });
        const context = await prepareContext(paneContextArgs(opts));
        const result = await trading.getStrategyTradingData({
          entity_id: entityId,
          symbol: opts.symbol,
          timeframe: opts.timeframe,
          offset: pagination.offset,
          limit: pagination.limit,
          snapshot_id: opts['snapshot-id'],
          format,
          output: opts.output,
          force: opts.force,
          timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
          context,
        });
        return result;
      },
    }],
    ['trading-export', {
      description: 'Export verified Strategy artifacts for one Symbol or the Active Watchlist',
      usage: '<entity-id>',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        symbol: { type: 'string', description: 'One exchange:symbol identity (exclusive with --watchlist)' },
        watchlist: { type: 'string', description: 'Export the immutable Active Watchlist snapshot: active' },
        timeframe: { type: 'string', description: 'Chart resolution (default current Pane timeframe)' },
        output: { type: 'string', short: 'o', description: 'Required parent directory for the atomic run output' },
        format: { type: 'string', description: 'Trading Data format: json (default), jsonl, or csv' },
        force: { type: 'boolean', description: 'Atomically replace an existing run ID directory' },
        'fail-fast': { type: 'boolean', description: 'Stop after the first failed Watchlist Symbol' },
        timeout: { type: 'string', description: 'Per-phase timeout in milliseconds (default 20000)' },
      },
      handler: async (opts, positionals) => {
        const entityId = positionals[0];
        requireStrategyExportArgs(entityId, {
          symbol: opts.symbol,
          watchlist: opts.watchlist,
          timeout: opts.timeout,
          failFast: opts['fail-fast'],
        });
        if (!opts.output) {
          throw new CoreOperationError('--output directory is required for strategy trading-export.', {
            code: 'OUTPUT_WRITE_FAILED', phase: 'output_validation',
            entity_id: entityId, symbol: opts.symbol,
          });
        }
        const format = resolveTradingDataFormat({ format: opts.format });
        const context = await prepareContext(paneContextArgs(opts));
        return trading.exportStrategyTrading({
          entity_id: entityId,
          symbol: opts.symbol,
          watchlist: opts.watchlist,
          timeframe: opts.timeframe,
          output_directory: opts.output,
          format,
          force: opts.force,
          fail_fast: opts['fail-fast'],
          timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
          context,
        });
      },
    }],
    ['select', {
      description: 'Deprecated compatibility: select a Strategy Instance and wait for its report',
      options: {
        ...PANE_CONTEXT_OPTIONS,
        timeout: { type: 'string', description: 'Readback timeout in milliseconds (default 20000)' },
      },
      handler: (opts, positionals) => withPaneContext(opts, () => core.selectStrategy({
        entity_id: positionals[0],
        timeout_ms: opts.timeout ? Number(opts.timeout) : undefined,
      })),
    }],
    ['report', {
      description: 'Deprecated compatibility: get legacy Strategy performance metrics',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts, positionals) => withPaneContext(opts, () => core.getStrategyReport({ entity_id: positionals[0] })),
    }],
    ['orders', {
      description: 'Get raw order events for an explicit Strategy Instance',
      options: { ...PANE_CONTEXT_OPTIONS, limit: { type: 'string', short: 'n', description: 'Most recent orders (default 200, max 5000)' } },
      handler: (opts, positionals) => withPaneContext(opts, () => core.getStrategyOrders({
        entity_id: positionals[0], limit: opts.limit ? Number(opts.limit) : undefined,
      })),
    }],
    ['trades', {
      description: 'Deprecated compatibility: get a tail of paired Strategy trades',
      options: { ...PANE_CONTEXT_OPTIONS, limit: { type: 'string', short: 'n', description: 'Most recent trades (default 200, max 5000)' } },
      handler: (opts, positionals) => withPaneContext(opts, () => core.getStrategyTrades({
        entity_id: positionals[0], limit: opts.limit ? Number(opts.limit) : undefined,
      })),
    }],
    ['equity', {
      description: 'Get the equity curve when TradingView exposes it',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts, positionals) => withPaneContext(opts, () => core.getStrategyEquity({ entity_id: positionals[0] })),
    }],
  ]),
});
