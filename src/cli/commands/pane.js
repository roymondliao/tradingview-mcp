import { register } from '../router.js';
import * as core from '../../core/pane.js';
import { PANE_CONTEXT_OPTIONS, withPaneContext } from '../pane-context.js';

register('pane', {
  description: 'Chart pane/layout tools (list, layout, focus, symbol)',
  subcommands: new Map([
    ['list', {
      description: 'List all panes in the current layout',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts) => withPaneContext(opts, () => core.list()),
    }],
    ['layout', {
      description: 'Set chart grid layout (s, 2h, 2v, 2x2, 4, 6, 8)',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Layout required. Usage: tv pane layout 2x2');
        return core.setLayout({ layout: positionals[0] });
      },
    }],
    ['focus', {
      description: 'Focus a specific pane by index',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts, positionals) => {
        if (positionals[0] === undefined) throw new Error('Index required. Usage: tv pane focus 0');
        return withPaneContext({ ...opts, 'pane-index': positionals[0] }, () => core.list());
      },
    }],
    ['symbol', {
      description: 'Set symbol on a specific pane',
      options: PANE_CONTEXT_OPTIONS,
      handler: (opts, positionals) => {
        if (positionals.length < 2) throw new Error('Usage: tv pane symbol 1 ES1!');
        return withPaneContext({ ...opts, 'pane-index': positionals[0] }, () => core.setSymbol({ index: positionals[0], symbol: positionals[1] }));
      },
    }],
  ]),
});
