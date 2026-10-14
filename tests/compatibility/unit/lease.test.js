import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLease } from '../../../src/core/compatibility/lease.js';
test('same endpoint excludes another owner, different endpoints do not conflict', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-lease-')); t.after(() => rm(root, { recursive: true, force: true }));
  const a = await acquireLease({ root, key: 'endpoint:a' });
  const b = await acquireLease({ root, key: 'endpoint:b' });
  await assert.rejects(acquireLease({ root, key: 'endpoint:a', timeout_ms: 25 }), { code: 'COMPATIBILITY_LOCK_CONFLICT' });
  await a.release(); await b.release();
  const next = await acquireLease({ root, key: 'endpoint:a' }); await next.release();
});
test('only proven-dead owners are reclaimed; old tokens cannot remove successor', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-lease-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = await acquireLease({ root, key: 'a' });
  await assert.rejects(acquireLease({ root, key: 'a', timeout_ms: 25, _deps: { processLiveness: () => 'unknown' } }), { code: 'COMPATIBILITY_LOCK_CONFLICT' });
  const next = await acquireLease({ root, key: 'a', _deps: { processLiveness: () => 'dead' } });
  await assert.rejects(first.assertOwned(), { code: 'COMPATIBILITY_LEASE_LOST' });
  await assert.rejects(first.release(), { code: 'COMPATIBILITY_LEASE_LOST' });
  await next.assertOwned(); await next.release();
});
test('unverifiable owners fail closed, never timeout-steal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-lease-')); t.after(() => rm(root, { recursive: true, force: true }));
  const first = await acquireLease({ root, key: 'a' });
  await writeFile(first.path, '{}');
  await assert.rejects(acquireLease({ root, key: 'a', timeout_ms: 25 }), { code: 'COMPATIBILITY_LOCK_CONFLICT' });
  await assert.rejects(first.release());
});
