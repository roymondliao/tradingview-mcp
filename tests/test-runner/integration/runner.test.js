import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { runTests } from '../../../scripts/test.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'module-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [file, body] of [
    ['tests/example/unit/pass.test.js', "import {test} from 'node:test'; test('passes',()=>{});"],
    ['tests/broken/unit/fail.test.js', "import {test} from 'node:test'; test('fails',()=>{throw new Error('intentional');});"],
    ['tests/desktop/e2e/live.test.js', "throw new Error('Live E2E must not execute during local tests');"],
  ]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), body);
  }
  return root;
}

test('runner launches the current Node with explicit local files and repository cwd', async t => {
  const root = await fixture(t);
  const env = { TASK_TEST_VALUE: 'kept', NODE_TEST_CONTEXT: 'child-v8' };
  let called;
  const status = await runTests(['example', '--reporter', 'spec', '--pattern', 'passes'], {
    root, env, out: () => {}, err: () => {},
    spawn: (command, args, options) => { called = { command, args, options }; return { status: 0 }; },
  });
  assert.equal(status, 0);
  assert.equal(called.command, process.execPath);
  assert.deepEqual(called.args, ['--test', '--test-reporter=spec', '--test-name-pattern=passes', 'tests/example/unit/pass.test.js']);
  assert.equal(called.options.cwd, root);
  assert.equal(called.options.stdio, 'inherit');
  assert.deepEqual(called.options.env, { TASK_TEST_VALUE: 'kept' });
  assert.equal(env.NODE_TEST_CONTEXT, 'child-v8');
  assert.notEqual(called.options.env, env);
});

test('listing is read-only and invalid/empty selection never falls back to node --test', async t => {
  const root = await fixture(t);
  const messages = [];
  const deps = { root, spawn: () => assert.fail('must not spawn'), out: text => messages.push(text), err: text => messages.push(text) };
  assert.equal(await runTests(['--module', 'example', '--list'], deps), 0);
  assert.equal(messages.shift(), 'tests/example/unit/pass.test.js\n');
  for (const args of [['--module', 'missing'], ['--suite', 'integration'], ['--unknown'], ['--replay'], ['--suite', 'e2e', '--replay-trading']]) {
    assert.equal(await runTests(args, deps), 1);
  }
});

test('Replay opt-ins are passed as child environment variables without modifying the parent', async t => {
  const root = await fixture(t);
  const env = {};
  let called;
  assert.equal(await runTests(['--suite', 'e2e', '--replay', '--replay-trading'], {
    root, env, out: () => {}, err: () => {}, spawn: (_command, args, options) => { called = { args, options }; return { status: 0 }; },
  }), 0);
  assert.equal(called.options.env.TV_E2E_REPLAY, '1');
  assert.equal(called.options.env.TV_E2E_REPLAY_TRADING, '1');
  assert.deepEqual(env, {});
  assert.deepEqual(called.args, ['--test', 'tests/desktop/e2e/live.test.js']);
});

test('real child test failures propagate as nonzero exit and successful modules pass', async t => {
  const root = await fixture(t);
  const deps = { root, out: () => {}, err: () => {}, spawn: (command, args, options) => spawnSync(command, args, { ...options, stdio: 'pipe', encoding: 'utf8' }) };
  assert.equal(await runTests(['example'], deps), 0);
  assert.equal(await runTests(['broken'], deps), 1);
  assert.equal(await runTests([], deps), 1);
});

test('spawn errors and termination retain failure status; help does not discover tests', async t => {
  const root = await fixture(t);
  for (const [result, expected] of [[{ status: 7 }, 7], [{ status: null, signal: 'SIGINT' }, 130], [{ error: new Error('spawn failed') }, 1]]) {
    assert.equal(await runTests(['example'], { root, out: () => {}, err: () => {}, spawn: () => result }), expected);
  }
  let help = '';
  assert.equal(await runTests(['--help'], { root: join(root, 'missing'), out: text => { help = text; }, spawn: () => assert.fail('must not spawn') }), 0);
  assert.match(help, /test:module/);
});
