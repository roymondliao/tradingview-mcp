import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, atomicJson } from './io.js';
import { compatibilityError } from './identity.js';
const delay = ms => new Promise(r => setTimeout(r, ms));
export function processLiveness(pid) {
  if (!Number.isInteger(pid) || pid < 1) return 'unknown';
  try { process.kill(pid, 0); return 'live'; } catch (err) { return err.code === 'ESRCH' ? 'dead' : err.code === 'EPERM' ? 'live' : 'unknown'; }
}
/** A short guard serializes acquisition, stale reclamation, heartbeat and release.
 * An unverifiable guard is never stolen; fail bounded and require operator recovery.
 */
async function guarded(path, operation, timeout) {
  const until = Date.now() + timeout;
  while (true) {
    try { await fs.mkdir(`${path}.guard`, { mode: 0o700 }); break; }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() >= until) throw compatibilityError('COMPATIBILITY_LOCK_CONFLICT', 'Compatibility lock guard is busy or requires recovery.', 'conflict');
      await delay(20);
    }
  }
  try { return await operation(); } finally { await fs.rmdir(`${path}.guard`); }
}
export async function acquireLease({ root, key, timeout_ms = 2000, _deps = {} }) {
  const dir = join(root, 'locks');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  const owner = { owner_token: randomUUID(), pid: process.pid, process_started_at: Math.floor(Date.now() - process.uptime() * 1000), acquired_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() };
  const until = Date.now() + timeout_ms;
  while (true) {
    const acquired = await guarded(path, async () => {
      let old;
      try { old = await readJson(path, 4096); } catch (err) { if (err.code !== 'ENOENT') throw compatibilityError('COMPATIBILITY_LOCK_CONFLICT', 'Unverifiable compatibility lock owner.', 'conflict'); }
      if (old && (_deps.processLiveness || processLiveness)(old.pid) !== 'dead') return false;
      await atomicJson(path, owner);
      return true;
    }, Math.max(1, until - Date.now()));
    if (acquired) break;
    if (Date.now() >= until) throw compatibilityError('COMPATIBILITY_LOCK_CONFLICT', 'Another launch/check owns this compatibility lease.', 'conflict');
    await delay(20);
  }
  let released = false, heartbeatError = null, pending = Promise.resolve();
  const assertOwned = async () => {
    const current = await readJson(path, 4096);
    if (released || current.owner_token !== owner.owner_token) throw compatibilityError('COMPATIBILITY_LEASE_LOST', 'Compatibility lease ownership changed.', 'conflict');
  };
  const heartbeat = () => {
    pending = pending.then(() => guarded(path, async () => {
      await assertOwned(); owner.heartbeat_at = new Date().toISOString(); await atomicJson(path, owner);
    }, timeout_ms)).catch(err => { heartbeatError = err; });
    return pending;
  };
  const timer = setInterval(heartbeat, 5000); timer.unref();
  return {
    owner, path, heartbeat,
    async assertOwned() { if (heartbeatError) throw heartbeatError; await assertOwned(); },
    async release() {
      if (released) return;
      clearInterval(timer); await pending;
      await guarded(path, async () => { await assertOwned(); await fs.unlink(path); released = true; }, timeout_ms);
    },
  };
}
