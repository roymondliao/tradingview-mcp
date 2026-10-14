import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState, withStateTransaction, reconcileObservation } from '../../../src/core/compatibility/store.js';
import { implementationIdentity, effectiveStatus } from '../../../src/core/compatibility/identity.js';
export const observed = { desktop_version: '3.4.1', electron_version: null, chromium_version: '146', protocol_version: '1.3', ...implementationIdentity() };
export const entry = () => reconcileObservation(null, observed);
test('local reader is non-mutating; concurrent transactions preserve endpoints', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-store-')); t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal((await readState({ root })).status, 'missing'); assert.deepEqual(await readdir(root), []);
  await Promise.all(Array.from({ length: 8 }, (_, i) => withStateTransaction({ root }, s => { s.endpoints[`host:${9222+i}`] = entry(); })));
  const s = (await readState({ root })).state; assert.equal(s.revision, 8); assert.equal(Object.keys(s.endpoints).length, 8);
});
test('corrupt state is backed up by writers; failed write preserves prior complete JSON', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-store-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'state.json'), '{bad'); assert.equal((await readState({ root })).status, 'invalid');
  await withStateTransaction({ root }, s => { s.endpoints['host:9222'] = entry(); });
  assert.ok((await readdir(root)).some(n => n.startsWith('state.invalid-')));
  const before = await readFile(join(root, 'state.json'), 'utf8');
  await assert.rejects(withStateTransaction({ root, _deps: { atomicJson: async () => { throw new Error('disk full'); } } }, s => { s.endpoints.x = entry(); }), { code: 'COMPATIBILITY_STATE_WRITE_FAILED' });
  assert.equal(await readFile(join(root, 'state.json'), 'utf8'), before);
});
test('reconcile never manufactures verification or clears same-version failure', () => {
  const previous = { ...entry(), status: 'failed', reason: 'runtime_contract' };
  assert.equal(reconcileObservation(previous, observed).status, 'failed');
  const newer = reconcileObservation(previous, { ...observed, desktop_version: '3.5.0' });
  assert.equal(newer.status, 'unchecked'); assert.equal(newer.verification, null);
  assert.equal(effectiveStatus({ ...entry(), status: 'passed' }).status, 'unchecked');
  assert.equal(reconcileObservation({ ...entry(), status: 'checking' }, observed).status, 'blocked');
});
test('oversized and future-schema state cannot silently retain passed', async t => {
 const root=await mkdtemp(join(tmpdir(),'compat-store-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await writeFile(join(root,'state.json'),' '.repeat(262145));assert.equal((await readState({root})).status,'invalid');
 await writeFile(join(root,'state.json'),JSON.stringify({schema_version:99,revision:1,endpoints:{}}));assert.equal((await readState({root})).status,'invalid');
});
