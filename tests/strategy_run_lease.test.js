import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  rename as renameAsync,
  writeFile as writeFileAsync,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  STRATEGY_RUN_LEASE_HEARTBEAT_MS,
  acquireStrategyLease,
  acquireStrategyRunPaneLeases,
  checkProcessLiveness,
  createStrategyPaneLeaseIdentity,
  createStrategyRunLeaseIdentity,
  resolveCanonicalRunDirectory,
  summarizeStrategyLease,
} from '../src/core/strategy-run-lease.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-strategy-lease-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function pane(overrides = {}) {
  return {
    saved_layout_id: 100,
    layout_id: 'layout-url',
    url_chart_id: 'url-chart',
    pane_id: 'pane-1',
    pane_index: 0,
    target_id: 'volatile-target',
    tab_index: 3,
    symbol: 'TWSE:2330',
    entity_id: 'volatile-entity',
    ...overrides,
  };
}

function controlledDeps(root, {
  pid = process.pid,
  start = 1800000000000,
  checkProcess,
  uuidSource,
  rename,
  writeFile,
} = {}) {
  let clock = start;
  let sequence = 0;
  const timers = [];
  const cleared = [];
  const deps = {
    tmpdir: () => root,
    pid,
    now: () => clock,
    processUptime: () => 10,
    uuid: () => (uuidSource ? uuidSource() : `token-${String(++sequence).padStart(8, '0')}`),
    setInterval: (callback, milliseconds) => {
      const timer = {
        callback,
        milliseconds,
        unrefCalled: false,
        unref() { this.unrefCalled = true; },
      };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => { cleared.push(timer); },
    ...(checkProcess && { checkProcessLiveness: checkProcess }),
    ...(rename && { rename }),
    ...(writeFile && { writeFile }),
  };
  return {
    deps,
    timers,
    cleared,
    advance(milliseconds) { clock += milliseconds; },
  };
}

describe('Stable Strategy lease identities', () => {
  it('canonicalizes a future Run path through the nearest real ancestor', async () => {
    const root = temporaryDirectory();
    const real = join(root, 'real-output');
    const alias = join(root, 'alias-output');
    mkdirSync(real);
    symlinkSync(real, alias, 'dir');
    const throughAlias = join(alias, 'future', 'run-1');
    const throughReal = join(realpathSync(real), 'future', 'run-1');

    assert.equal(
      await resolveCanonicalRunDirectory({ run_directory: throughAlias }),
      throughReal,
    );
    const aliasIdentity = await createStrategyRunLeaseIdentity({ run_directory: throughAlias });
    const realIdentity = await createStrategyRunLeaseIdentity({ run_directory: throughReal });
    assert.equal(aliasIdentity.canonical_path, throughReal);
    assert.equal(aliasIdentity.stable_key, realIdentity.stable_key);
  });

  it('ignores volatile target, tab, Symbol, and entity fields in the Pane key', () => {
    const first = createStrategyPaneLeaseIdentity({ pane: pane() });
    const rebound = createStrategyPaneLeaseIdentity({
      pane: pane({
        target_id: 'new-target',
        tab_index: 9,
        symbol: 'TPEX:5483',
        entity_id: 'new-entity',
      }),
    });
    assert.equal(first.stable_key, rebound.stable_key);
    assert.deepEqual(first.identity, {
      schema_version: 1,
      layout: { kind: 'saved_layout_id', value: '100' },
      pane: { kind: 'pane_id', value: 'pane-1' },
    });
  });

  it('falls back to Layout ID and Pane index when persistent IDs are unavailable', () => {
    const identity = createStrategyPaneLeaseIdentity({
      pane: pane({ saved_layout_id: null, pane_id: null, pane_index: 2 }),
    });
    assert.deepEqual(identity.identity, {
      schema_version: 1,
      layout: { kind: 'layout_id', value: 'layout-url' },
      pane: { kind: 'pane_index', value: '2' },
    });
  });
});

describe('Process liveness', () => {
  it('treats success and EPERM as live, ESRCH as dead, and other failures as unknown', async () => {
    assert.equal(await checkProcessLiveness(10, { _deps: { kill: () => {} } }), 'live');
    assert.equal(await checkProcessLiveness(10, {
      _deps: { kill: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } },
    }), 'live');
    assert.equal(await checkProcessLiveness(10, {
      _deps: { kill: () => { throw Object.assign(new Error('missing'), { code: 'ESRCH' }); } },
    }), 'dead');
    assert.equal(await checkProcessLiveness(10, {
      _deps: { kill: () => { throw Object.assign(new Error('unknown'), { code: 'EIO' }); } },
    }), 'unknown');
  });
});

describe('Atomic Strategy lease acquisition', () => {
  it('rejects a second live owner and releases idempotently', async () => {
    const root = temporaryDirectory();
    const control = controlledDeps(root, {
      checkProcess: () => 'live',
    });
    const stableKey = 'run:live-owner';
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: stableKey, run_id: 'run-1', _deps: control.deps,
    });
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: stableKey, run_id: 'run-1', _deps: control.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE' && error.scope === 'run',
    );
    assert.equal(summarizeStrategyLease(lease).state, 'held');
    assert.deepEqual(await lease.release(), { released: true });
    assert.deepEqual(await lease.release(), { released: false, reason: 'already_released' });
    assert.equal(existsSync(lease.lock_path), false);
  });

  it('reclaims only after positive dead-PID evidence and protects the new owner token', async () => {
    const root = temporaryDirectory();
    const firstControl = controlledDeps(root, { pid: 9911 });
    const stableKey = 'run:dead-owner';
    const first = await acquireStrategyLease({
      scope: 'run', stable_key: stableKey, run_id: 'run-1', _deps: firstControl.deps,
    });

    const secondControl = controlledDeps(root, {
      pid: 9922,
      checkProcess: (pid) => (pid === 9911 ? 'dead' : 'live'),
    });
    const second = await acquireStrategyLease({
      scope: 'run', stable_key: stableKey, run_id: 'run-1', _deps: secondControl.deps,
    });
    assert.notEqual(first.owner().owner_token, second.owner().owner_token);
    assert.deepEqual(await first.release(), { released: false, reason: 'owner_changed' });
    assert.equal(existsSync(second.lock_path), true);
    assert.deepEqual(await second.release(), { released: true });
  });

  it('allows only one winner when two processes race to reclaim a dead owner', async () => {
    const root = temporaryDirectory();
    let sequence = 0;
    const uuidSource = () => `shared-${String(++sequence).padStart(8, '0')}`;
    const originalControl = controlledDeps(root, { pid: 9911, uuidSource });
    const stableKey = 'pane:reclaim-race';
    const original = await acquireStrategyLease({
      scope: 'pane', stable_key: stableKey, run_id: 'run-1', _deps: originalControl.deps,
    });
    const contenderOptions = {
      pid: process.pid,
      uuidSource,
      checkProcess: (pid) => (pid === 9911 ? 'dead' : 'live'),
    };
    const firstControl = controlledDeps(root, contenderOptions);
    const secondControl = controlledDeps(root, contenderOptions);
    const results = await Promise.allSettled([
      acquireStrategyLease({
        scope: 'pane', stable_key: stableKey, run_id: 'run-2', _deps: firstControl.deps,
      }),
      acquireStrategyLease({
        scope: 'pane', stable_key: stableKey, run_id: 'run-3', _deps: secondControl.deps,
      }),
    ]);
    const winners = results.filter((result) => result.status === 'fulfilled');
    const blocked = results.filter((result) => result.status === 'rejected');
    assert.equal(winners.length, 1);
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].reason.code, 'RUN_ALREADY_ACTIVE');
    await original.release();
    await winners[0].value.release();
  });

  it('never reclaims a live owner when liveness is EPERM', async () => {
    const root = temporaryDirectory();
    const firstControl = controlledDeps(root, { pid: 9911 });
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:eperm', run_id: 'run-1', _deps: firstControl.deps,
    });
    const secondControl = controlledDeps(root, { pid: 9922 });
    secondControl.deps.kill = () => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' });
    };
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: 'run:eperm', run_id: 'run-2', _deps: secondControl.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE',
    );
    await lease.release();
  });

  it('blocks corrupt owner metadata instead of using age or mtime', async () => {
    const root = temporaryDirectory();
    const control = controlledDeps(root, { checkProcess: () => 'dead' });
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:corrupt', run_id: 'run-1', _deps: control.deps,
    });
    writeFileSync(join(lease.lock_path, 'owner.json'), '{}\n');
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: 'run:corrupt', run_id: 'run-2', _deps: control.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE' && /owner_unverifiable/.test(error.message),
    );
    await assert.rejects(lease.release(), (error) => error.code === 'RUN_ALREADY_ACTIVE');
  });

  it('blocks a lease with missing owner metadata instead of reclaiming by age', async () => {
    const root = temporaryDirectory();
    const control = controlledDeps(root, { checkProcess: () => 'dead' });
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:missing-owner', run_id: 'run-1', _deps: control.deps,
    });
    unlinkSync(join(lease.lock_path, 'owner.json'));
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: 'run:missing-owner', run_id: 'run-2', _deps: control.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE' && /owner_unverifiable/.test(error.message),
    );
    await assert.rejects(lease.release(), (error) => error.code === 'RUN_ALREADY_ACTIVE');
  });

  it('updates heartbeat metadata and clears the injected timer on release', async () => {
    const root = temporaryDirectory();
    const control = controlledDeps(root);
    const lease = await acquireStrategyLease({
      scope: 'pane', stable_key: 'pane:heartbeat', run_id: 'run-1', _deps: control.deps,
    });
    assert.equal(control.timers.length, 1);
    assert.equal(control.timers[0].milliseconds, STRATEGY_RUN_LEASE_HEARTBEAT_MS);
    assert.equal(control.timers[0].unrefCalled, true);
    const before = lease.owner().heartbeat_at;
    control.advance(STRATEGY_RUN_LEASE_HEARTBEAT_MS);
    assert.equal(await lease.heartbeat(), true);
    const persisted = JSON.parse(readFileSync(join(lease.lock_path, 'owner.json'), 'utf8'));
    assert.ok(persisted.heartbeat_at > before);
    await lease.release();
    assert.equal(control.cleared.length, 1);
  });

  it('waits for an in-flight heartbeat before releasing the lock directory', async () => {
    const root = temporaryDirectory();
    let writeCount = 0;
    let heartbeatEntered;
    let allowHeartbeat;
    const entered = new Promise((resolveEntered) => { heartbeatEntered = resolveEntered; });
    const gate = new Promise((resolveGate) => { allowHeartbeat = resolveGate; });
    const control = controlledDeps(root, {
      writeFile: async (...args) => {
        writeCount += 1;
        if (writeCount === 2) {
          heartbeatEntered();
          await gate;
        }
        return writeFileAsync(...args);
      },
    });
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:heartbeat-release', run_id: 'run-1', _deps: control.deps,
    });
    control.advance(STRATEGY_RUN_LEASE_HEARTBEAT_MS);
    const heartbeat = lease.heartbeat();
    await entered;
    const release = lease.release();
    assert.equal(existsSync(lease.lock_path), true);
    allowHeartbeat();
    assert.equal(await heartbeat, true);
    assert.deepEqual(await release, { released: true });
    assert.equal(existsSync(lease.lock_path), false);
  });
});

describe('Combined Run and Pane ownership', () => {
  it('releases the Run lease when Pane acquisition fails', async () => {
    const root = temporaryDirectory();
    const output = join(root, 'output');
    mkdirSync(output);
    const control = controlledDeps(root, { checkProcess: () => 'live' });
    const first = await acquireStrategyRunPaneLeases({
      run_directory: join(output, 'run-1'),
      pane: pane(),
      run_id: 'run-1',
      _deps: control.deps,
    });
    await assert.rejects(
      acquireStrategyRunPaneLeases({
        run_directory: join(output, 'run-2'),
        pane: pane({ target_id: 'other-target' }),
        run_id: 'run-2',
        _deps: control.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE' && error.scope === 'pane',
    );
    const second = await acquireStrategyRunPaneLeases({
      run_directory: join(output, 'run-2'),
      pane: pane({ pane_id: 'pane-2' }),
      run_id: 'run-2',
      _deps: control.deps,
    });
    await second.release();
    await first.release();
  });

  it('allows different Runs to own different Panes and releases Pane before Run', async () => {
    const root = temporaryDirectory();
    const output = join(root, 'output');
    mkdirSync(output);
    const releaseRenames = [];
    const control = controlledDeps(root, {
      rename: async (from, to) => {
        if (to.includes('.release-')) releaseRenames.push({ from, to });
        return renameAsync(from, to);
      },
    });
    const first = await acquireStrategyRunPaneLeases({
      run_directory: join(output, 'run-1'), pane: pane(), run_id: 'run-1', _deps: control.deps,
    });
    const second = await acquireStrategyRunPaneLeases({
      run_directory: join(output, 'run-2'),
      pane: pane({ pane_id: 'pane-2' }),
      run_id: 'run-2',
      _deps: control.deps,
    });
    await first.release();
    assert.match(releaseRenames[0].from, /pane-.*\.lock$/);
    assert.match(releaseRenames[1].from, /run-.*\.lock$/);
    await second.release();
  });
});

describe('Lease path safety', () => {
  it('rejects a symlink lease application root', async () => {
    const root = temporaryDirectory();
    const external = join(root, 'external');
    mkdirSync(external);
    symlinkSync(external, join(root, 'tradingview-mcp'), 'dir');
    const control = controlledDeps(root);
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: 'run:unsafe-root', run_id: 'run-1', _deps: control.deps,
      }),
      (error) => error.code === 'RUN_LEASE_FAILED',
    );
  });

  it('blocks a symlink owner file and never follows it', async () => {
    const root = temporaryDirectory();
    const control = controlledDeps(root, { checkProcess: () => 'dead' });
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:owner-link', run_id: 'run-1', _deps: control.deps,
    });
    const ownerPath = join(lease.lock_path, 'owner.json');
    const externalOwner = join(root, 'external-owner.json');
    writeFileSync(externalOwner, JSON.stringify(lease.owner()));
    unlinkSync(ownerPath);
    symlinkSync(externalOwner, ownerPath);
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: 'run:owner-link', run_id: 'run-2', _deps: control.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE',
    );
    assert.equal(JSON.parse(readFileSync(externalOwner, 'utf8')).run_id, 'run-1');
  });

  it('blocks a symlink lock directory and never follows it', async () => {
    const root = temporaryDirectory();
    const control = controlledDeps(root);
    const lease = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:lock-link', run_id: 'run-1', _deps: control.deps,
    });
    const lockPath = lease.lock_path;
    await lease.release();
    const external = join(root, 'external-lock');
    mkdirSync(external);
    symlinkSync(external, lockPath, 'dir');
    await assert.rejects(
      acquireStrategyLease({
        scope: 'run', stable_key: 'run:lock-link', run_id: 'run-2', _deps: control.deps,
      }),
      (error) => error.code === 'RUN_ALREADY_ACTIVE',
    );
    assert.deepEqual(readdirSync(external), []);
  });

  it('leaves no stale quarantine after normal dead-owner reclaim', async () => {
    const root = temporaryDirectory();
    const firstControl = controlledDeps(root, { pid: 9911 });
    const first = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:no-quarantine', run_id: 'run-1', _deps: firstControl.deps,
    });
    const secondControl = controlledDeps(root, {
      pid: 9922,
      checkProcess: (pid) => (pid === 9911 ? 'dead' : 'live'),
    });
    const second = await acquireStrategyLease({
      scope: 'run', stable_key: 'run:no-quarantine', run_id: 'run-2', _deps: secondControl.deps,
    });
    const leaseRoot = dirname(second.lock_path);
    assert.equal(readdirSync(leaseRoot).some((entry) => entry.includes('.stale-')), false);
    await first.release();
    await second.release();
  });
});
