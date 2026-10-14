import { homedir } from 'node:os';
import { join } from 'node:path';
import { rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readJson, atomicJson } from './io.js';
import { acquireLease } from './lease.js';
import { SCHEMA_VERSION, STATUSES, compatibilityError, effectiveStatus, sameIdentity } from './identity.js';
export const compatibilityRoot = (home = homedir()) => join(home, '.tradingview-mcp', 'compatibility');
const blank = () => ({ schema_version: SCHEMA_VERSION, revision: 0, endpoints: {} });
function validState(state) {
  return state?.schema_version === SCHEMA_VERSION && Number.isInteger(state.revision) && state.revision >= 0
    && state.endpoints && typeof state.endpoints === 'object' && !Array.isArray(state.endpoints)
    && Object.values(state.endpoints).every(e => e && STATUSES.includes(e.status) && typeof e.observation_generation === 'string');
}
export async function readState({ root = compatibilityRoot() } = {}) {
  try {
    const state = await readJson(join(root, 'state.json'));
    if (!validState(state)) throw new Error('Invalid state schema');
    return { state, status: 'ok' };
  } catch (err) {
    return { state: blank(), status: err.code === 'ENOENT' ? 'missing' : 'invalid', reason: err.code === 'ENOENT' ? 'no_observation' : 'state_unreadable' };
  }
}
export async function withStateTransaction({ root = compatibilityRoot(), _deps = {} } = {}, update) {
  const lease = await acquireLease({ root, key: 'state-transaction', _deps });
  try {
    const loaded = await readState({ root });
    if (loaded.status === 'invalid') {
      try { await rename(join(root, 'state.json'), join(root, `state.invalid-${randomUUID()}.json`)); }
      catch (err) { throw compatibilityError('COMPATIBILITY_STATE_WRITE_FAILED', 'Cannot preserve invalid compatibility state.', 'filesystem', err); }
    }
    const state = loaded.state;
    const result = await update(state);
    state.revision += 1;
    if (!validState(state)) throw compatibilityError('COMPATIBILITY_STATE_INVALID', 'Refusing invalid compatibility state.');
    await lease.assertOwned();
    await (_deps.atomicJson || atomicJson)(join(root, 'state.json'), state);
    return result;
  } catch (err) {
    if (err?.code?.startsWith('COMPATIBILITY_')) throw err;
    throw compatibilityError('COMPATIBILITY_STATE_WRITE_FAILED', 'Cannot persist compatibility state.', 'filesystem', err);
  } finally { await lease.release(); }
}
export const acquireEndpointLease = ({ endpoint, root = compatibilityRoot(), ...options }) => acquireLease({ root, key: `endpoint:${endpoint.key}`, ...options });
export async function updateGeneration({ root, endpoint, generation, lease }, update) {
  await lease.assertOwned();
  return withStateTransaction({ root }, state => {
    const entry = state.endpoints[endpoint.key];
    if (entry?.observation_generation !== generation) return { status: 'superseded' };
    update(entry);
    return { status: 'updated', effective_status: effectiveStatus(entry).status };
  });
}
export function reconcileObservation(previous, observed, generation = randomUUID()) {
  const same = sameIdentity(previous?.observed, observed);
  const prior = same ? effectiveStatus(previous) : { status: 'unchecked', reason: 'desktop_version_changed' };
  return {
    observation_generation: generation, observed,
    status: prior.status === 'checking' ? 'blocked' : prior.status,
    reason: prior.status === 'checking' ? 'interrupted' : prior.reason,
    verification: same ? previous?.verification || null : null,
    last_check: same ? previous?.last_check || null : null,
    active_check: null,
    last_launch_checked_at: previous?.last_launch_checked_at || null,
  };
}
