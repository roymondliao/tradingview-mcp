import { randomUUID } from 'node:crypto';
import { compatibilityRoot, acquireEndpointLease, withStateTransaction, reconcileObservation, updateGeneration } from './store.js';
import { configuredEndpoint, normalizeEndpoint, implementationIdentity, compatibilityError } from './identity.js';
import { parseDesktopVersionResponse } from './version.js';
export async function beginLaunchObservation({ endpoint = configuredEndpoint(), root = compatibilityRoot() } = {}) {
  endpoint = normalizeEndpoint(endpoint);
  const lease = await acquireEndpointLease({ root, endpoint });
  const generation = randomUUID(); let previous;
  try {
    await withStateTransaction({ root }, state => {
      previous = state.endpoints[endpoint.key];
      state.endpoints[endpoint.key] = { ...previous, observation_generation: generation, status: 'blocked', reason: 'launch_pending', active_check: null };
    });
  } catch (err) { await lease.release(); throw err; }
  return { endpoint, root, lease, generation, previous };
}
export async function recordLaunchObservation(session, version_response) {
  let observed;
  try { observed = { ...parseDesktopVersionResponse(version_response), ...implementationIdentity(), observed_at: new Date().toISOString() }; }
  catch (err) { return recordLaunchFailure(session, err.code || 'version_unavailable'); }
  return updateGeneration(session, entry => {
    Object.assign(entry, reconcileObservation(session.previous, observed, session.generation), { last_launch_checked_at: observed.observed_at });
  });
}
export async function recordLaunchFailure(session, reason = 'launch_failed') {
  return updateGeneration(session, entry => { entry.status = 'blocked'; entry.reason = reason; entry.active_check = null; });
}
/** Launch owner outlives every platform child, including shell launchers. */
export async function withLaunchObservation(options, operation) {
  const session = await beginLaunchObservation(options);
  try {
    const result = await operation();
    const metadata = result.version_response;
    const update = metadata ? await recordLaunchObservation(session, metadata) : await recordLaunchFailure(session, 'cdp_unavailable');
    const { version_response: _private, ...publicResult } = result;
    return { ...publicResult, compatibility: { ...update, next_command: update.effective_status === 'passed' ? null : 'tv compatibility check' } };
  } catch (err) {
    try { await recordLaunchFailure(session); }
    catch (writeError) { throw compatibilityError('COMPATIBILITY_STATE_WRITE_FAILED', 'Launch failed and compatibility state could not be saved; Desktop may be running.', 'filesystem', writeError); }
    throw err;
  } finally { await session.lease.release(); }
}
