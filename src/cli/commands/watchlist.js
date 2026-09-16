import { register } from '../router.js';
import * as core from '../../core/watchlist.js';

register('watchlist', {
  description: 'Watchlist tools (list, get, snapshot, add, add-bulk, remove)',
  subcommands: new Map([
    ['list', {
      description: 'List available watchlists',
      options: {
        func: { type: 'boolean', description: 'Use CDP Runtime.callFunctionOn instead of Runtime.evaluate' },
      },
      handler: (opts) => core.listWatchlists({ use_function: opts.func }),
    }],
    ['get', {
      description: 'Get the incomplete virtualized DOM view of the active Watchlist',
      handler: () => core.getWatchlist(),
    }],
    ['snapshot', {
      description: 'Capture one complete, stable Account Watchlist by exact name',
      options: {
        name: { type: 'string', short: 'n', description: 'Exact, case-sensitive Account Watchlist name' },
        output: { type: 'string', short: 'o', description: 'Atomically write the complete canonical JSON Snapshot' },
        force: { type: 'boolean', description: 'Replace an existing output file atomically' },
      },
      handler: async (opts) => {
        if (!opts.name) throw new Error('--name is required for watchlist snapshot');
        if (opts.force && !opts.output) throw new Error('--force requires --output');
        const result = await core.captureNamedWatchlistSnapshot({ name: opts.name });
        return opts.output
          ? core.writeNamedWatchlistSnapshot({ result, output: opts.output, force: opts.force })
          : result;
      },
    }],
    ['add', {
      description: 'Add a symbol to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Symbol required. Usage: tv watchlist add AAPL');
        return core.add({ symbol: positionals[0] });
      },
    }],
    ['add-bulk', {
      description: 'Add multiple symbols to the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist add-bulk AAPL MSFT');
        return core.addBulk({ symbols: positionals });
      },
    }],
    ['remove', {
      description: 'Remove one or more symbols from the watchlist',
      handler: (opts, positionals) => {
        if (!positionals.length) throw new Error('Symbols required. Usage: tv watchlist remove AAPL MSFT');
        return core.remove({ symbols: positionals });
      },
    }],
  ]),
});
