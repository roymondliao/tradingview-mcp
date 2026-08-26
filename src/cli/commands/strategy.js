import { register } from '../router.js';
import * as core from '../../core/strategy.js';
import { PANE_CONTEXT_OPTIONS, withPaneContext } from '../pane-context.js';

register('strategy', {
  description: 'Strategy Tester tools for explicit Strategy Instances',
  subcommands: new Map([
    ['active', {
      description: 'Get the currently report-ready Strategy Instance',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts) => withPaneContext(opts, () => core.getActiveStrategy()),
    }],
    ['select', {
      description: 'Select a Strategy Instance and wait for its report',
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
      description: 'Get performance metrics for an explicit Strategy Instance',
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
      description: 'Get paired entry/exit trades for an explicit Strategy Instance',
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
