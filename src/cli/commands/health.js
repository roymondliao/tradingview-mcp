import { register } from '../router.js';
import * as core from '../../core/health.js';
import { update } from '../../core/update.js';

register('status', {
  desktop_dependency: 'required',
  description: 'Check CDP connection to TradingView',
  handler: () => core.healthCheck(),
});

register('launch', {
  desktop_dependency: 'launch',
  description: 'Launch TradingView with CDP enabled',
  options: {
    port: { type: 'string', short: 'p', description: 'CDP port (default 9222)' },
    'no-kill': { type: 'boolean', description: 'Do not kill existing instances' },
  },
  handler: (opts) => core.launch({
    port: opts.port ? Number(opts.port) : undefined,
    kill_existing: !opts['no-kill'],
  }),
});

register('update', {
  desktop_dependency: 'none',
  description: 'Update to the latest version (git fast-forward + npm ci if deps changed)',
  handler: () => update({}),
});
