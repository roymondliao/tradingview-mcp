import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compatibilityStatus, emitCompatibilityAdvisory } from '../src/core/compatibility/advisory.js';
import { commandInventory } from '../src/cli/router.js';
import { pathToFileURL } from 'node:url';
test('all CLI leaves classified, offline commands exempt, dry-run-capable Strategy required', async () => {
  for (const file of await readdir('src/cli/commands')) if (file.endsWith('.js')) await import(pathToFileURL(join(process.cwd(),'src/cli/commands',file)));
  const inventory = commandInventory();
  assert.ok(inventory.length > 70);
  assert.ok(inventory.every(x => ['none','required','launch','compatibility'].includes(x.desktop_dependency)));
  for (const name of ['pine analyze','pine check','search','update']) assert.equal(inventory.find(x=>x.name===name).desktop_dependency, 'none');
  assert.equal(inventory.find(x=>x.name==='strategy run').desktop_dependency, 'required');
});
test('advisory is bounded, reads only local state; missing state produces warning without writes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-advisory-')); t.after(() => rm(root, { recursive: true, force: true }));
  const writes=[];
  await emitCompatibilityAdvisory({ root, dependency:'required', write: s => writes.push(s) });
  assert.equal(writes.length,1); assert.equal(JSON.parse(writes[0]).status,'unchecked'); assert.ok(writes[0].length<2048);
  assert.deepEqual(await readdir(root), []);
  assert.equal((await compatibilityStatus({root})).last_observed_version,null);
  await emitCompatibilityAdvisory({ dependency:'none', _deps:{ readState: () => { throw new Error('should not read'); } }, write: () => assert.fail() });
});

test('real CLI warning preserves connection error payload and exit code', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['src/cli/index.js', 'status'], { encoding: 'utf8', env: { ...process.env, TV_CDP_PORT: '9', TV_CDP_TOTAL_TIMEOUT_MS: '80', TV_CDP_DISCOVERY_TIMEOUT_MS: '20' } });
  const [first, ...rest] = result.stderr.trim().split('\n');
  assert.equal(JSON.parse(first).code, 'COMPATIBILITY_CHECK_RECOMMENDED');
  assert.match(JSON.parse(rest.join('\n')).code, /^CDP_/);
  assert.equal(result.status, 2); assert.equal(result.stdout, '');
});
