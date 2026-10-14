import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discoverTests, selectTests } from '../../../scripts/test-discovery.js';

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'test-discovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), '');
  }
  return root;
}

test('module/type discovery recurses, excludes support and automatically includes new features', async t => {
  const root = await fixture(t, [
    'tests/strategy/run/unit/state.test.js',
    'tests/strategy/run/integration/run.test.js',
    'tests/strategy/trading/unit/model.test.js',
    'tests/desktop/e2e/tools.test.js',
    'tests/strategy/run/support/fixture.test.js',
    'tests/strategy/run/support/nested/unit/not-a-real-test.test.js',
  ]);
  let tests = await discoverTests(root);
  assert.equal(tests.length, 4);
  assert.equal(selectTests(tests).length, 3);
  assert.deepEqual(selectTests(tests, { suite: 'e2e' }).map(x => x.module), ['desktop']);
  await mkdir(join(root, 'tests/new-feature/unit'), { recursive: true });
  await writeFile(join(root, 'tests/new-feature/unit/behavior.test.js'), '');
  tests = await discoverTests(root);
  assert.equal(selectTests(tests, { modules: ['new-feature'] }).length, 1);
});

test('module prefixes respect boundaries; overlapping selectors never duplicate a file', async t => {
  const root = await fixture(t, [
    'tests/strategy/run/unit/state.test.js',
    'tests/strategy/run/integration/run.test.js',
    'tests/strategy/trading/unit/model.test.js',
    'tests/strategy-extra/unit/other.test.js',
  ]);
  const tests = await discoverTests(root);
  assert.equal(selectTests(tests, { modules: ['strategy'] }).length, 3);
  assert.equal(selectTests(tests, { modules: ['strategy/run'], suite: 'unit' }).length, 1);
  assert.equal(selectTests(tests, { modules: ['strategy', 'strategy/run'] }).length, 3);
  assert.equal(selectTests(tests, { modules: ['strategy/run'], suite: 'integration' }).length, 1);
});

test('unknown modules/types, empty selections and unclassified files fail explicitly', async t => {
  const root = await fixture(t, ['tests/chart/unit/state.test.js']);
  const tests = await discoverTests(root);
  for (const module of ['charts', '../chart', '/chart', 'chart/*']) assert.throws(() => selectTests(tests, { modules: [module] }), /Unknown test module/);
  assert.throws(() => selectTests(tests, { suite: 'all' }), /Unknown test suite/);
  assert.throws(() => selectTests(tests, { suite: 'e2e' }), /No tests selected/);
  await writeFile(join(root, 'tests/orphan.test.js'), '');
  await assert.rejects(discoverTests(root), /Unclassified test/);
});
