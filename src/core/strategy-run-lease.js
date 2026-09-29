/** Cross-process Run and Pane leases for durable Strategy automation. */
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  realpath as nodeRealpath,
  rename as nodeRename,
  rm as nodeRm,
} from 'node:fs/promises';
import { tmpdir as nodeTmpdir } from 'node:os';
import {
  basename,
  dirname,
  join,
  resolve,
} from 'node:path';
import { CoreOperationError } from './errors.js';
import { atomicReplaceJson, readBoundedJson } from './strategy-run-artifacts.js';
import { sha256Hex, stableJsonStringify } from './stable-json.js';
import { unixMillisecondsToIso } from './time.js';

export const STRATEGY_RUN_LEASE_VERSION = 1;
export const STRATEGY_RUN_LEASE_HEARTBEAT_MS = 5000;

const OWNER_JSON_MAX_BYTES = 16 * 1024;
const ACQUIRE_ATTEMPTS = 8;
const OWNER_FIELDS = Object.freeze([
  'schema_version',
  'owner_token',
  'pid',
  'process_started_at',
  'process_started_at_iso',
  'scope',
  'run_id',
  'stable_key',
  'acquired_at',
  'acquired_at_iso',
  'heartbeat_at',
  'heartbeat_at_iso',
]);
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function leaseError(message, {
  code = 'RUN_LEASE_FAILED',
  phase = 'run_lease',
  scope,
  cause,
} = {}) {
  const error = new CoreOperationError(message, { code, phase, cause });
  if (scope) error.scope = scope;
  return error;
}

function activeError({ scope, stableKey, owner = null, reason = 'active' }) {
  const error = leaseError(
    `Strategy ${scope} lease is unavailable (${reason}): ${stableKey}`,
    { code: 'RUN_ALREADY_ACTIVE', phase: `${scope}_lease`, scope },
  );
  if (owner) {
    error.owner = Object.freeze({
      pid: owner.pid,
      run_id: owner.run_id,
      acquired_at: owner.acquired_at,
      heartbeat_at: owner.heartbeat_at,
    });
  }
  return error;
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function isAlreadyExists(error) {
  return error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY';
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function normalizeRunId(value) {
  const runId = String(value ?? '').trim();
  if (
    !runId
    || runId.length > 200
    || runId === '.'
    || runId === '..'
    || !RUN_ID_PATTERN.test(runId)
  ) {
    throw leaseError('run_id must be one safe path segment.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'run_lease',
      scope: 'run',
    });
  }
  return runId;
}

function dependencies(_deps = {}) {
  return {
    lstat: nodeLstat,
    mkdir: nodeMkdir,
    realpath: nodeRealpath,
    rename: nodeRename,
    rm: nodeRm,
    tmpdir: nodeTmpdir,
    uuid: nodeRandomUUID,
    now: Date.now,
    processUptime: process.uptime,
    pid: process.pid,
    kill: process.kill.bind(process),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    ..._deps,
  };
}

async function lstatOptional(path, deps) {
  try {
    return await deps.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertDirectory(info, label, { code = 'RUN_LEASE_FAILED', scope } = {}) {
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw leaseError(`${label} must be a non-symlink directory.`, {
      code,
      phase: `${scope || 'run'}_lease`,
      scope,
    });
  }
}

function validateMissingSegment(segment) {
  if (!segment || segment === '.' || segment === '..' || segment.includes('\0')) {
    throw leaseError('Run Directory contains an unsafe unresolved path segment.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'run_lease',
      scope: 'run',
    });
  }
  return segment;
}

/** Resolve existing paths and future Run paths through their nearest real ancestor. */
export async function resolveCanonicalRunDirectory({ run_directory, _deps = {} } = {}) {
  if (typeof run_directory !== 'string' || !run_directory.trim()) {
    throw leaseError('Run Directory is required for Run lease identity.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'run_lease',
      scope: 'run',
    });
  }
  const deps = dependencies(_deps);
  const absolute = resolve(run_directory);
  const missing = [];
  let current = absolute;
  while (true) {
    let info;
    try {
      info = await deps.lstat(current);
    } catch (error) {
      if (!isMissing(error)) {
        throw leaseError(`Unable to inspect Run Directory path: ${current}`, {
          phase: 'run_lease', scope: 'run', cause: error,
        });
      }
      const parent = dirname(current);
      if (parent === current) {
        throw leaseError(`No existing ancestor could be resolved for: ${absolute}`, {
          phase: 'run_lease', scope: 'run', cause: error,
        });
      }
      missing.unshift(validateMissingSegment(basename(current)));
      current = parent;
      continue;
    }
    if (!info.isDirectory() && !info.isSymbolicLink() && missing.length > 0) {
      throw leaseError(`Run Directory ancestor is not a directory: ${current}`, {
        code: 'RUN_RESUME_ARTIFACT_INVALID',
        phase: 'run_lease',
        scope: 'run',
      });
    }
    if (missing.length === 0 && !info.isDirectory() && !info.isSymbolicLink()) {
      throw leaseError(`Run Directory is not a directory: ${current}`, {
        code: 'RUN_RESUME_ARTIFACT_INVALID',
        phase: 'run_lease',
        scope: 'run',
      });
    }
    let realAncestor;
    try {
      realAncestor = await deps.realpath(current);
      assertDirectory(await deps.lstat(realAncestor), `Canonical Run ancestor ${realAncestor}`, {
        code: 'RUN_RESUME_ARTIFACT_INVALID',
        scope: 'run',
      });
    } catch (error) {
      if (error instanceof CoreOperationError) throw error;
      throw leaseError(`Unable to canonicalize Run Directory: ${absolute}`, {
        code: 'RUN_RESUME_ARTIFACT_INVALID',
        phase: 'run_lease',
        scope: 'run',
        cause: error,
      });
    }
    return resolve(realAncestor, ...missing);
  }
}

export async function createStrategyRunLeaseIdentity({ run_directory, _deps = {} } = {}) {
  const canonicalPath = await resolveCanonicalRunDirectory({ run_directory, _deps });
  return Object.freeze({
    scope: 'run',
    canonical_path: canonicalPath,
    stable_key: `run:${sha256Hex({ schema_version: 1, canonical_path: canonicalPath })}`,
  });
}

export function createStrategyPaneLeaseIdentity({ pane } = {}) {
  if (!isObject(pane)) {
    throw leaseError('Resolved Pane identity is required.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'pane_lease',
      scope: 'pane',
    });
  }
  const layoutKind = nonEmpty(pane.saved_layout_id)
    ? 'saved_layout_id'
    : nonEmpty(pane.layout_id)
      ? 'layout_id'
      : nonEmpty(pane.url_chart_id)
        ? 'url_chart_id'
        : null;
  const layoutValue = layoutKind ? String(pane[layoutKind]).trim() : null;
  const paneKind = nonEmpty(pane.pane_id) ? 'pane_id' : 'pane_index';
  const paneValue = paneKind === 'pane_id'
    ? String(pane.pane_id).trim()
    : pane.pane_index;
  if (!layoutKind || !nonEmpty(layoutValue)) {
    throw leaseError('Pane lease requires a stable Layout identity.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'pane_lease',
      scope: 'pane',
    });
  }
  if (
    (paneKind === 'pane_index' && (!Number.isInteger(paneValue) || paneValue < 0))
    || (paneKind === 'pane_id' && !nonEmpty(paneValue))
  ) {
    throw leaseError('Pane lease requires pane_id or a non-negative pane_index.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'pane_lease',
      scope: 'pane',
    });
  }
  const identity = Object.freeze({
    schema_version: 1,
    layout: Object.freeze({ kind: layoutKind, value: layoutValue }),
    pane: Object.freeze({ kind: paneKind, value: String(paneValue) }),
  });
  return Object.freeze({
    scope: 'pane',
    identity,
    stable_key: `pane:${sha256Hex(identity)}`,
  });
}

function normalizeLiveness(value) {
  if (value === true || value === 'live') return 'live';
  if (value === false || value === 'dead') return 'dead';
  return 'unknown';
}

export async function checkProcessLiveness(pid, { _deps = {} } = {}) {
  if (!Number.isInteger(pid) || pid < 1) return 'unknown';
  const deps = dependencies(_deps);
  if (typeof _deps.checkProcessLiveness === 'function') {
    try {
      return normalizeLiveness(await _deps.checkProcessLiveness(pid));
    } catch {
      return 'unknown';
    }
  }
  try {
    deps.kill(pid, 0);
    return 'live';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'live';
    return 'unknown';
  }
}

function validateOwner(value, { scope, stableKey }) {
  if (!isObject(value)) throw new Error('owner.json must be an object');
  for (const field of Object.keys(value)) {
    if (!OWNER_FIELDS.includes(field)) throw new Error(`owner.json contains unknown field: ${field}`);
  }
  for (const field of OWNER_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`owner.json is missing field: ${field}`);
    }
  }
  if (value.schema_version !== STRATEGY_RUN_LEASE_VERSION) throw new Error('owner schema is unsupported');
  if (!OWNER_TOKEN_PATTERN.test(value.owner_token)) throw new Error('owner token is invalid');
  if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('owner PID is invalid');
  if (value.scope !== scope || value.stable_key !== stableKey) throw new Error('owner identity is inconsistent');
  normalizeRunId(value.run_id);
  for (const field of ['process_started_at', 'acquired_at', 'heartbeat_at']) {
    const timestamp = value[field];
    if (!Number.isInteger(timestamp) || timestamp < 0) throw new Error(`${field} is invalid`);
    if (value[`${field}_iso`] !== unixMillisecondsToIso(timestamp)) {
      throw new Error(`${field}_iso is inconsistent`);
    }
  }
  if (value.heartbeat_at < value.acquired_at) throw new Error('heartbeat precedes acquisition');
  return Object.freeze({ ...value });
}

async function ensureLeaseRoot(deps) {
  const applicationRoot = join(resolve(deps.tmpdir()), 'tradingview-mcp');
  const leaseRoot = join(applicationRoot, 'strategy-leases');
  try {
    await deps.mkdir(applicationRoot, { recursive: true });
    assertDirectory(await deps.lstat(applicationRoot), `Lease application root ${applicationRoot}`);
    try {
      await deps.mkdir(leaseRoot, { recursive: false });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
    assertDirectory(await deps.lstat(leaseRoot), `Lease root ${leaseRoot}`);
    return leaseRoot;
  } catch (error) {
    if (error instanceof CoreOperationError) throw error;
    throw leaseError(`Unable to prepare Strategy lease root: ${leaseRoot}`, {
      phase: 'run_lease', cause: error,
    });
  }
}

function leasePathFor({ leaseRoot, scope, stableKey }) {
  const digest = sha256Hex({ schema_version: 1, scope, stable_key: stableKey });
  return join(leaseRoot, `${scope}-${digest}.lock`);
}

async function readOwner({ lockPath, scope, stableKey, deps }) {
  const lockInfo = await lstatOptional(lockPath, deps);
  if (!lockInfo) return null;
  assertDirectory(lockInfo, `Strategy ${scope} lease`, {
    code: 'RUN_ALREADY_ACTIVE', scope,
  });
  let raw;
  try {
    raw = await readBoundedJson({
      path: join(lockPath, 'owner.json'),
      label: `Strategy ${scope} lease owner.json`,
      max_bytes: OWNER_JSON_MAX_BYTES,
      _deps: deps,
    });
    return validateOwner(raw, { scope, stableKey });
  } catch {
    throw activeError({ scope, stableKey, reason: 'owner_unverifiable' });
  }
}

function ownerRecord({ deps, scope, stableKey, runId, token }) {
  const acquiredAt = Number(deps.now());
  const uptime = Math.max(0, Number(deps.processUptime()) || 0);
  const processStartedAt = Math.max(0, Math.floor(acquiredAt - (uptime * 1000)));
  const pid = Number(deps.pid);
  if (!Number.isInteger(acquiredAt) || acquiredAt < 0 || !Number.isInteger(pid) || pid < 1) {
    throw leaseError('Lease clock or PID is invalid.', { phase: `${scope}_lease`, scope });
  }
  return Object.freeze({
    schema_version: STRATEGY_RUN_LEASE_VERSION,
    owner_token: token,
    pid,
    process_started_at: processStartedAt,
    process_started_at_iso: unixMillisecondsToIso(processStartedAt),
    scope,
    run_id: runId,
    stable_key: stableKey,
    acquired_at: acquiredAt,
    acquired_at_iso: unixMillisecondsToIso(acquiredAt),
    heartbeat_at: acquiredAt,
    heartbeat_at_iso: unixMillisecondsToIso(acquiredAt),
  });
}

function generateOwnerToken(deps, { different_from = null, scope = 'run' } = {}) {
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    const token = String(deps.uuid()).replace(/[^A-Za-z0-9_-]/g, '');
    if (OWNER_TOKEN_PATTERN.test(token) && token !== different_from) return token;
  }
  throw leaseError('Generated lease owner token is invalid or repeated.', {
    phase: `${scope}_lease`,
    scope,
  });
}

async function writeOwner(path, owner, deps) {
  await atomicReplaceJson({
    path,
    value: owner,
    max_bytes: OWNER_JSON_MAX_BYTES,
    _deps: deps,
  });
}

function createLeaseHandle({ lockPath, leaseRoot, owner, deps }) {
  let state = 'held';
  let currentOwner = owner;
  let heartbeatPromise = null;
  let heartbeatError = null;
  let interval = null;

  function heartbeat() {
    if (state !== 'held') return Promise.resolve(false);
    if (heartbeatPromise) return heartbeatPromise;
    heartbeatPromise = (async () => {
      try {
        const observed = await readOwner({
          lockPath,
          scope: owner.scope,
          stableKey: owner.stable_key,
          deps,
        });
        if (!observed || observed.owner_token !== owner.owner_token) {
          state = 'lost';
          if (interval) deps.clearInterval(interval);
          interval = null;
          return false;
        }
        const heartbeatAt = Math.max(currentOwner.heartbeat_at, Math.floor(Number(deps.now())));
        currentOwner = Object.freeze({
          ...currentOwner,
          heartbeat_at: heartbeatAt,
          heartbeat_at_iso: unixMillisecondsToIso(heartbeatAt),
        });
        await writeOwner(join(lockPath, 'owner.json'), currentOwner, deps);
        heartbeatError = null;
        return true;
      } catch (error) {
        heartbeatError = error;
        return false;
      } finally {
        heartbeatPromise = null;
      }
    })();
    return heartbeatPromise;
  }

  async function release() {
    if (state === 'released') return Object.freeze({ released: false, reason: 'already_released' });
    if (interval) deps.clearInterval(interval);
    interval = null;
    state = 'releasing';
    if (heartbeatPromise) await heartbeatPromise;
    const observed = await readOwner({
      lockPath,
      scope: owner.scope,
      stableKey: owner.stable_key,
      deps,
    });
    if (!observed) {
      state = 'released';
      return Object.freeze({ released: false, reason: 'missing' });
    }
    if (observed.owner_token !== owner.owner_token) {
      state = 'lost';
      return Object.freeze({ released: false, reason: 'owner_changed' });
    }
    const quarantine = join(
      leaseRoot,
      `.${basename(lockPath)}.release-${owner.owner_token}-${deps.uuid()}`,
    );
    try {
      await deps.rename(lockPath, quarantine);
    } catch (error) {
      if (isMissing(error)) {
        state = 'released';
        return Object.freeze({ released: false, reason: 'missing' });
      }
      throw leaseError(`Failed to release Strategy ${owner.scope} lease.`, {
        phase: `${owner.scope}_lease`, scope: owner.scope, cause: error,
      });
    }
    let quarantined;
    try {
      quarantined = await readBoundedJson({
        path: join(quarantine, 'owner.json'),
        label: `Quarantined ${owner.scope} lease owner.json`,
        max_bytes: OWNER_JSON_MAX_BYTES,
        _deps: deps,
      });
      quarantined = validateOwner(quarantined, {
        scope: owner.scope,
        stableKey: owner.stable_key,
      });
    } catch (error) {
      throw leaseError(`Released ${owner.scope} lease could not be verified.`, {
        phase: `${owner.scope}_lease`, scope: owner.scope, cause: error,
      });
    }
    if (quarantined.owner_token !== owner.owner_token) {
      throw leaseError(`Released ${owner.scope} lease token changed unexpectedly.`, {
        phase: `${owner.scope}_lease`, scope: owner.scope,
      });
    }
    try {
      await deps.rm(quarantine, { recursive: true, force: false });
    } catch (error) {
      throw leaseError(`Failed to remove released Strategy ${owner.scope} lease.`, {
        phase: `${owner.scope}_lease`, scope: owner.scope, cause: error,
      });
    }
    state = 'released';
    return Object.freeze({ released: true });
  }

  interval = deps.setInterval(() => { void heartbeat(); }, STRATEGY_RUN_LEASE_HEARTBEAT_MS);
  if (typeof interval?.unref === 'function') interval.unref();

  return Object.freeze({
    scope: owner.scope,
    stable_key: owner.stable_key,
    lock_path: lockPath,
    owner: () => currentOwner,
    state: () => state,
    heartbeat,
    heartbeat_error: () => heartbeatError,
    release,
  });
}

/** Atomically acquire one already-derived Run or Pane lease. */
export async function acquireStrategyLease({
  scope,
  stable_key,
  run_id,
  _deps = {},
} = {}) {
  if (
    !['run', 'pane'].includes(scope)
    || typeof stable_key !== 'string'
    || stable_key.length > 200
    || !stable_key.startsWith(`${scope}:`)
  ) {
    throw leaseError('Lease scope and stable key are invalid.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: `${scope || 'run'}_lease`,
      scope,
    });
  }
  const deps = dependencies(_deps);
  const runId = normalizeRunId(run_id);
  let token = generateOwnerToken(deps, { scope });
  const leaseRoot = await ensureLeaseRoot(deps);
  const lockPath = leasePathFor({ leaseRoot, scope, stableKey: stable_key });

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      await deps.mkdir(lockPath, { recursive: false });
      const owner = ownerRecord({ deps, scope, stableKey: stable_key, runId, token });
      try {
        await writeOwner(join(lockPath, 'owner.json'), owner, deps);
      } catch (error) {
        try {
          await deps.rm(lockPath, { recursive: true, force: true });
        } catch {
          // Preserve the owner-write error.
        }
        throw leaseError(`Failed to initialize Strategy ${scope} lease owner.`, {
          phase: `${scope}_lease`, scope, cause: error,
        });
      }
      return createLeaseHandle({ lockPath, leaseRoot, owner, deps });
    } catch (error) {
      if (error instanceof CoreOperationError && error.code !== 'RUN_ALREADY_ACTIVE') throw error;
      if (!isAlreadyExists(error) && error?.code !== 'RUN_ALREADY_ACTIVE') {
        throw leaseError(`Failed to acquire Strategy ${scope} lease.`, {
          phase: `${scope}_lease`, scope, cause: error,
        });
      }
    }

    const owner = await readOwner({ lockPath, scope, stableKey: stable_key, deps });
    if (!owner) continue;
    const liveness = await checkProcessLiveness(owner.pid, { _deps: deps });
    if (liveness !== 'dead') {
      throw activeError({
        scope,
        stableKey: stable_key,
        owner,
        reason: liveness === 'live' ? 'live_owner' : 'owner_liveness_unknown',
      });
    }
    if (token === owner.owner_token) {
      token = generateOwnerToken(deps, { different_from: owner.owner_token, scope });
    }
    const quarantine = join(
      leaseRoot,
      `.${basename(lockPath)}.stale-${owner.owner_token}-${deps.uuid()}`,
    );
    try {
      await deps.rename(lockPath, quarantine);
    } catch (error) {
      if (isMissing(error)) continue;
      throw activeError({ scope, stableKey: stable_key, owner, reason: 'stale_reclaim_failed' });
    }
    try {
      await deps.rm(quarantine, { recursive: true, force: false });
    } catch (error) {
      throw leaseError(`Failed to remove stale Strategy ${scope} lease.`, {
        phase: `${scope}_lease`, scope, cause: error,
      });
    }
  }
  throw activeError({ scope, stableKey: stable_key, reason: 'acquisition_race' });
}

/** Acquire Run then Pane, and always release in reverse order. */
export async function acquireStrategyRunPaneLeases({
  run_directory,
  pane,
  run_id,
  _deps = {},
} = {}) {
  const runIdentity = await createStrategyRunLeaseIdentity({ run_directory, _deps });
  const paneIdentity = createStrategyPaneLeaseIdentity({ pane });
  const runId = normalizeRunId(run_id || basename(runIdentity.canonical_path));
  const runLease = await acquireStrategyLease({
    scope: 'run',
    stable_key: runIdentity.stable_key,
    run_id: runId,
    _deps,
  });
  let paneLease;
  try {
    paneLease = await acquireStrategyLease({
      scope: 'pane',
      stable_key: paneIdentity.stable_key,
      run_id: runId,
      _deps,
    });
  } catch (error) {
    try {
      await runLease.release();
    } catch (releaseError) {
      throw leaseError('Pane lease failed and the acquired Run lease could not be released.', {
        phase: 'run_lease', scope: 'run', cause: releaseError,
      });
    }
    throw error;
  }
  let released = false;
  return Object.freeze({
    run_identity: runIdentity,
    pane_identity: paneIdentity,
    run: runLease,
    pane: paneLease,
    async release() {
      if (released) return Object.freeze({ released: false, reason: 'already_released' });
      let paneResult = null;
      let runResult = null;
      let paneError = null;
      let runError = null;
      try {
        paneResult = await paneLease.release();
      } catch (error) {
        paneError = error;
      }
      try {
        runResult = await runLease.release();
      } catch (error) {
        runError = error;
      }
      if (paneError || runError) {
        throw leaseError('One or more Strategy leases could not be released.', {
          phase: runError ? 'run_lease' : 'pane_lease',
          scope: runError ? 'run' : 'pane',
          cause: runError || paneError,
        });
      }
      released = true;
      return Object.freeze({ released: true, pane: paneResult, run: runResult });
    },
  });
}

/** Deterministic bounded diagnostic for tests and callers. */
export function summarizeStrategyLease(lease) {
  const owner = lease?.owner?.();
  if (!owner) return null;
  return Object.freeze({
    scope: owner.scope,
    stable_key: owner.stable_key,
    run_id: owner.run_id,
    pid: owner.pid,
    acquired_at: owner.acquired_at,
    heartbeat_at: owner.heartbeat_at,
    state: lease.state(),
    owner_fingerprint: sha256Hex(stableJsonStringify(owner)),
  });
}
