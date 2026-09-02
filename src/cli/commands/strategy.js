import { register } from '../router.js';
import * as core from '../../core/strategy.js';
import * as trading from '../../core/strategy-trading.js';
import { prepareContext } from '../../core/pane.js';
import { CoreOperationError } from '../../core/errors.js';
import {
  PANE_CONTEXT_OPTIONS,
  paneContextArgs,
  withPaneContext,
} from '../pane-context.js';

function requireTradingReportArgs(entityId, symbol, timeout) {
  if (!entityId) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase: 'request_validation',
    });
  }
  if (!symbol) {
    throw new CoreOperationError('--symbol is required for strategy trading-report.', {
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

register('strategy', {
  description: 'Strategy Tester tools for explicit Strategy Instances',
  subcommands: new Map([
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
        requireTradingReportArgs(entityId, opts.symbol, opts.timeout);
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
