#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { discoverTests, selectTests } from './test-discovery.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const usage = `Usage: node scripts/test.js [module ...] [options]
  --suite local|unit|integration|e2e   Default: local (unit + integration)
  --module <name>                     Module or subtree, repeatable
  --list                             List selected files without running tests
  --reporter <name>                   Forward to node:test
  --pattern <regex>                   Forward to --test-name-pattern
  --replay                           Enable Replay E2E
  --replay-trading                    Also requires --replay
  --help                             Show this help

Examples:
  npm run test:module -- compatibility
  npm run test:unit -- --module strategy/run
  npm run test:e2e -- --list
`;

export async function runTests(argv, { root = repository, spawn = spawnSync, out = text => process.stdout.write(text), err = text => process.stderr.write(text), env = process.env } = {}) {
  try {
    const { values, positionals } = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
      suite: { type: 'string', default: 'local' },
      module: { type: 'string', multiple: true },
      list: { type: 'boolean' },
      reporter: { type: 'string' },
      pattern: { type: 'string' },
      replay: { type: 'boolean' },
      'replay-trading': { type: 'boolean' },
      help: { type: 'boolean' },
    } });
    if (values.help) { out(usage); return 0; }
    if ((values.replay || values['replay-trading']) && values.suite !== 'e2e') throw new Error('Replay options require --suite e2e.');
    if (values['replay-trading'] && !values.replay) throw new Error('--replay-trading requires --replay.');
    const modules = [...(values.module || []), ...positionals];
    const selected = selectTests(await discoverTests(root), { suite: values.suite, modules });
    if (values.list) { out(selected.map(test => test.file).join('\n') + '\n'); return 0; }
    const args = ['--test'];
    if (values.reporter) args.push(`--test-reporter=${values.reporter}`);
    if (values.pattern) args.push(`--test-name-pattern=${values.pattern}`);
    args.push(...selected.map(test => test.file));
    const childEnv = { ...env };
    // A runner invoked by node:test must create a fresh test process, not inherit
    // the enclosing test-worker context (which can hide child failures).
    delete childEnv.NODE_TEST_CONTEXT;
    if (values.replay) childEnv.TV_E2E_REPLAY = '1';
    if (values['replay-trading']) childEnv.TV_E2E_REPLAY_TRADING = '1';
    err(`Running ${selected.length} test files (suite=${values.suite}, module=${modules.join(',') || 'all'}).\n`);
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: childEnv });
    if (child.error) throw child.error;
    return child.status ?? ({ SIGINT: 130, SIGTERM: 143, SIGKILL: 137 }[child.signal] || 1);
  } catch (error) {
    err(`Test runner: ${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runTests(process.argv.slice(2));
}
