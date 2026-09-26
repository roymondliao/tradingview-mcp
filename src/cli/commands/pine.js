import { register } from '../router.js';
import * as core from '../../core/pine.js';
import { readFileSync } from 'fs';
import { createInterface } from 'node:readline/promises';

async function readStdin() {
  if (process.stdin.isTTY) return null;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function readSource(opts) {
  return opts.file ? readFileSync(opts.file, 'utf-8') : readStdin();
}

async function confirmDelete(scriptId, yes) {
  if (yes) return true;
  if (!process.stdin.isTTY) {
    throw new Error('Refusing non-interactive delete without --yes.');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await prompt.question(`Delete account Saved Pine Script ${scriptId}? Type "yes" to confirm: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    prompt.close();
  }
}

register('pine', {
  description: 'Pine Script tools',
  subcommands: new Map([
    ['get', {
      description: 'Get current editor source or an account Saved Pine Script by ID',
      options: {
        'script-id': { type: 'string', description: 'Account Saved Pine Script ID (USER;...)' },
      },
      handler: (opts) => opts['script-id']
        ? core.getSavedScript({ script_id: opts['script-id'] })
        : core.getSource(),
    }],
    ['set', {
      description: 'Set Pine Script source (reads stdin or --file)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.setSource({ source });
      },
    }],
    ['create', {
      description: 'Create an account Saved Pine Script',
      options: {
        name: { type: 'string', description: 'Saved Script name' },
        type: { type: 'string', short: 't', description: 'strategy, indicator, or library' },
        file: { type: 'string', short: 'f', description: 'Read source from file (otherwise stdin)' },
      },
      handler: async (opts) => {
        const source = await readSource(opts);
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.createSavedScript({ name: opts.name, type: opts.type, source });
      },
    }],
    ['update', {
      description: 'Save a new version of an account Saved Pine Script',
      options: {
        'script-id': { type: 'string', description: 'Account Saved Pine Script ID (USER;...)' },
        name: { type: 'string', description: 'Optional updated Script name' },
        file: { type: 'string', short: 'f', description: 'Read source from file (otherwise stdin)' },
      },
      handler: async (opts) => {
        const source = await readSource(opts);
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.updateSavedScript({ script_id: opts['script-id'], name: opts.name, source });
      },
    }],
    ['delete', {
      description: 'Delete an account Saved Pine Script after explicit confirmation',
      options: {
        'script-id': { type: 'string', description: 'Account Saved Pine Script ID (USER;...)' },
        yes: { type: 'boolean', short: 'y', description: 'Confirm deletion without an interactive prompt' },
      },
      handler: async (opts) => {
        if (!opts['script-id']) throw new Error('--script-id is required');
        const confirmed = await confirmDelete(opts['script-id'], opts.yes);
        if (!confirmed) throw new Error('Delete cancelled; confirmation was not "yes".');
        return core.deleteSavedScript({ script_id: opts['script-id'], confirmed });
      },
    }],
    ['compile', {
      description: 'Smart compile: detect button, compile, check errors',
      handler: () => core.smartCompile(),
    }],
    ['raw-compile', {
      description: 'Click compile/add button without smart detection',
      handler: () => core.compile(),
    }],
    ['analyze', {
      description: 'Offline static analysis (no TradingView needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.analyze({ source });
      },
    }],
    ['check', {
      description: 'Server-side compile check with sanitized Candidate Input Schema (no chart needed)',
      options: {
        file: { type: 'string', short: 'f', description: 'Read source from file' },
      },
      handler: async (opts) => {
        let source;
        if (opts.file) {
          source = readFileSync(opts.file, 'utf-8');
        } else {
          source = await readStdin();
        }
        if (!source) throw new Error('No source provided. Pipe source via stdin or use --file.');
        return core.check({ source });
      },
    }],
    ['save', {
      description: 'Save the current Pine Script (Ctrl+S)',
      handler: () => core.save(),
    }],
    ['new', {
      description: 'Create a new blank Pine Script (indicator, strategy, library)',
      handler: (opts, positionals) => {
        const type = positionals[0] || 'indicator';
        return core.newScript({ type });
      },
    }],
    ['open', {
      description: 'Open a saved Pine Script by name',
      handler: (opts, positionals) => {
        if (!positionals[0]) throw new Error('Script name required. Usage: tv pine open "My Script"');
        return core.openScript({ name: positionals.join(' ') });
      },
    }],
    ['list', {
      description: 'List saved Pine Scripts',
      options: {
        type: { type: 'string', short: 't', description: 'Filter: strategy, indicator, library, unknown' },
      },
      handler: (opts) => core.listScripts({ type: opts.type }),
    }],
    ['errors', {
      description: 'Get Pine Script compilation errors',
      handler: () => core.getErrors(),
    }],
    ['console', {
      description: 'Get Pine Script console/log output',
      handler: () => core.getConsole(),
    }],
  ]),
});
