import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compareCandidateRuntimeInputSchema,
  executeStrategySync,
  planStrategyInputMigration,
  planStrategySync,
  StrategySyncError,
} from '../src/core/strategy-sync.js';
import { normalizedPineSourceSha256 } from '../src/core/pine-input-schema.js';

const SOURCE = '//@version=6\nstrategy("Sync test")\nlength = input.int(10, title="Length", minval=1, maxval=20)\n';
const OLD_SOURCE = SOURCE.replace('10, title', '9, title');

function candidateSchema(defaultValue = 10) {
  return {
    available: true,
    input_schema_fingerprint: `schema-${defaultValue}`,
    inputs: [{
      name: 'Length',
      pine_input_type: 'int',
      runtime_value_type: 'int',
      default_value: defaultValue,
      constraints: { min: 1, max: 20 },
    }],
  };
}

function runtimeInput({ id = 'in_0', value = 10, defaultValue = 10, type = 'integer' } = {}) {
  return {
    id, name: 'Length', type, value, default_value: defaultValue,
    constraints: { min: 1, max: 20 },
  };
}

function accountScript({ source = SOURCE, version = '2.0' } = {}) {
  return {
    success: true,
    owned: true,
    script_id: 'USER;sync-test',
    name: 'sync-test',
    title: 'sync-test',
    type: 'strategy',
    version,
    pine_source: source,
  };
}

function paneInstance({ entityId = 'pane-old', version = '2.0', value = 10, id = 'in_0' } = {}) {
  return {
    entity_id: entityId,
    name: 'sync-test',
    type: 'strategy',
    script_id: 'USER;sync-test',
    version,
    inputs: [runtimeInput({ id, value })],
  };
}

function syncFixture({ account = accountScript(), panes = [paneInstance()], hooks = {} } = {}) {
  const state = {
    account: account ? { ...account } : null,
    panes: panes.map((pane) => ({
      ...pane,
      inputs: pane.inputs.map((input) => ({ ...input, constraints: { ...input.constraints } })),
    })),
    events: [],
    nextEntity: 1,
  };
  const schema = candidateSchema();
  const deps = {
    analyzePine: async () => ({ diagnostics: [] }),
    checkPine: async () => ({ compiled: true, input_schema: schema, warnings: [] }),
    withChartSession: async (_options, operation) => operation(),
    resolveSavedStrategy: async () => state.account
      ? { exists: true, script: state.account }
      : { exists: false, script: null },
    readResolvedSavedStrategy: async () => state.account && ({
      ...state.account,
      source_sha256: normalizedPineSourceSha256(state.account.pine_source),
    }),
    getSavedScript: async () => ({ ...state.account }),
    createSavedScript: async ({ source }) => {
      state.events.push('account:create');
      state.account = accountScript({ source, version: '1.0' });
      return { success: true, compile_ok: true, script_id: state.account.script_id };
    },
    updateSavedScript: async ({ source }) => {
      state.events.push('account:update');
      const version = `${Number.parseInt(state.account.version, 10) + 1}.0`;
      state.account = { ...state.account, pine_source: source, version };
      return { success: true, compile_ok: true, script_id: state.account.script_id };
    },
    readTargetPaneStudies: async () => ({ studies: state.panes }),
    addActivePaneStudy: async () => {
      state.events.push('pane:add');
      if (hooks.addError) throw hooks.addError;
      const created = paneInstance({
        entityId: `pane-new-${state.nextEntity++}`,
        version: state.account.version,
        value: 10,
        id: 'new_0',
      });
      if (hooks.badNewSchema) created.inputs[0].type = 'boolean';
      state.panes.push(created);
      return { success: true, entity_id: created.entity_id };
    },
    setStudyInputs: async ({ entity_id, inputs }) => {
      state.events.push(`inputs:set:${entity_id}`);
      if (hooks.inputsError) throw hooks.inputsError;
      const pane = state.panes.find((item) => item.entity_id === entity_id);
      for (const input of pane.inputs) {
        if (Object.hasOwn(inputs, input.id)) input.value = inputs[input.id];
      }
      return { success: true };
    },
    ensureStrategyActive: async ({ entity_id }) => {
      state.events.push(`activate:${entity_id}`);
      if (hooks.activationError) throw hooks.activationError;
      return { success: true };
    },
    waitForFreshTradingReport: async ({ entity_id }) => {
      state.events.push(`report:${entity_id}`);
      if (hooks.reportError) throw hooks.reportError;
      if (hooks.afterReport) hooks.afterReport(state, entity_id);
      return { stable_reads: 2, status_type: 'ready' };
    },
    removeActivePaneStudy: async ({ entity_id }) => {
      state.events.push(`pane:remove:${entity_id}`);
      if (hooks.removeError?.(entity_id)) throw new Error(`remove failed: ${entity_id}`);
      state.panes = state.panes.filter((item) => item.entity_id !== entity_id);
      return { success: true };
    },
  };
  return { state, schema, deps };
}

function execute(fixture, overrides = {}) {
  return executeStrategySync({
    saved_name: 'sync-test',
    source: SOURCE,
    candidate_schema: fixture.schema,
    current_schema: candidateSchema(9),
    context: { target_id: 'target-1', layout_name: 'dev', pane_index: 0 },
    _deps: fixture.deps,
    ...overrides,
  });
}

async function captureSyncError(operation) {
  try {
    await operation();
  } catch (error) {
    assert.ok(error instanceof StrategySyncError);
    return error;
  }
  assert.fail('Expected StrategySyncError');
}

describe('Strategy sync planning', () => {
  it('keeps sync blocked when Account resolution or source readback is unavailable', () => {
    assert.equal(planStrategySync({ local_source_sha256: 'local' }).account_action, 'blocked');
    assert.equal(planStrategySync({
      local_source_sha256: 'local', account: { exists: true },
    }).account_action, 'blocked');
  });

  it('plans Account create and Pane add when the Saved Strategy is absent', () => {
    const result = planStrategySync({
      local_source_sha256: 'local', account: { exists: false }, pane_instances: { matches: [] },
    });
    assert.equal(result.account_action, 'create');
    assert.equal(result.pane_action, 'add_latest');
  });

  it('reuses matching source and Pane version', () => {
    const result = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: '3.0' } },
      pane_instances: { matches: [{ version: '3.0' }] },
    });
    assert.equal(result.account_action, 'reuse');
    assert.equal(result.pane_action, 'reuse');
    assert.equal(result.pane_version_matches, true);
  });

  it('refreshes a stale Pane even when Account source is already current', () => {
    const result = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: '3.0' } },
      pane_instances: { matches: [{ version: '2.0' }] },
    });
    assert.equal(result.account_action, 'reuse');
    assert.equal(result.pane_action, 'refresh');
    assert.equal(result.pane_version_matches, false);
  });

  it('blocks when Account or Pane version cannot be read', () => {
    const accountUnknown = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: null } },
      pane_instances: { matches: [] },
    });
    assert.equal(accountUnknown.valid, false);
    assert.equal(accountUnknown.errors[0].code, 'ACCOUNT_STRATEGY_VERSION_UNAVAILABLE');

    const paneUnknown = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: '3.0' } },
      pane_instances: { matches: [{ version: null }] },
    });
    assert.equal(paneUnknown.valid, false);
    assert.equal(paneUnknown.pane_action, 'blocked');
    assert.equal(paneUnknown.errors[0].code, 'PANE_STRATEGY_VERSION_UNAVAILABLE');
  });

  it('plans Account update and Pane refresh for changed local source', () => {
    const result = planStrategySync({
      local_source_sha256: 'new',
      account: { exists: true, source_sha256: 'old', script: { version: '2.0' } },
      pane_instances: { matches: [{ version: '2.0' }] },
    });
    assert.equal(result.account_action, 'update');
    assert.equal(result.pane_action, 'refresh');
  });
});

describe('Strategy Runtime schema and Input migration', () => {
  it('compares only type, default, min, and max against Runtime metadata', () => {
    const valid = compareCandidateRuntimeInputSchema({
      candidate_schema: candidateSchema(),
      runtime_catalog: [{ ...runtimeInput(), group: 'ignored', constraints: { min: 1, max: 20, step: 5 } }],
    });
    assert.equal(valid.valid, true);

    const invalid = compareCandidateRuntimeInputSchema({
      candidate_schema: candidateSchema(),
      runtime_catalog: [runtimeInput({ type: 'boolean', defaultValue: 11 })],
    });
    assert.equal(invalid.valid, false);
    assert.deepEqual(invalid.errors[0].changed_fields, ['type', 'default']);
  });

  it('rejects an empty Runtime catalog when Candidate Inputs exist', () => {
    const result = compareCandidateRuntimeInputSchema({
      candidate_schema: candidateSchema(), runtime_catalog: [],
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'RUNTIME_INPUT_CATALOG_EMPTY');
  });

  it('migrates reordered exact-name compatible values and records added/removed defaults', () => {
    const candidate = {
      available: true,
      inputs: [
        candidateSchema().inputs[0],
        { name: 'Enabled', pine_input_type: 'bool', runtime_value_type: 'bool', default_value: true, constraints: {} },
      ],
    };
    const result = planStrategyInputMigration({
      old_catalog: [runtimeInput({ id: 'old_9', value: 15 })],
      new_catalog: [
        { id: 'new_0', name: 'Enabled', type: 'boolean', value: true, default_value: true, constraints: {} },
        runtimeInput({ id: 'new_1', value: 10 }),
      ],
      current_schema: {
        available: true,
        inputs: [candidateSchema(9).inputs[0], { name: 'Removed', runtime_value_type: 'bool' }],
      },
      candidate_schema: candidate,
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.overrides, { new_1: 15 });
    assert.deepEqual(result.removed, [{ name: 'Removed', action: 'removed' }]);
    assert.deepEqual(result.migrations.map((item) => item.action), ['use_new_default', 'preserve']);
  });

  it('preserves compatible non-Candidate Runtime properties by exact name', () => {
    const commission = (id, value) => ({
      id, name: 'Commission value', type: 'float', value, default_value: 0,
      constraints: { min: 0, max: 100 },
    });
    const result = planStrategyInputMigration({
      old_catalog: [runtimeInput({ id: 'old_0', value: 15 }), commission('old_1', 0.25)],
      new_catalog: [runtimeInput({ id: 'new_0', value: 10 }), commission('new_1', 0)],
      current_schema: candidateSchema(),
      candidate_schema: candidateSchema(),
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.overrides, { new_0: 15, new_1: 0.25 });
    assert.deepEqual(result.migrations.map((item) => item.name), ['Length', 'Commission value']);
  });

  it('uses the new default when an old value violates the new Runtime constraints', () => {
    const result = planStrategyInputMigration({
      old_catalog: [runtimeInput({ value: 20 })],
      new_catalog: [{ ...runtimeInput(), constraints: { min: 1, max: 10 } }],
      current_schema: candidateSchema(),
      candidate_schema: {
        ...candidateSchema(),
        inputs: [{ ...candidateSchema().inputs[0], constraints: { min: 1, max: 10 } }],
      },
    });
    assert.deepEqual(result.overrides, {});
    assert.equal(result.migrations[0].action, 'use_new_default');
    assert.equal(result.warnings[0].code, 'STRATEGY_INPUT_VALUE_DEFAULTED');
  });
});

describe('Strategy sync execution', () => {
  it('reuses equal normalized Account source and latest Pane without mutations', async () => {
    const fixture = syncFixture({
      account: accountScript({ source: SOURCE.replaceAll('\n', '\r\n') }),
    });
    const result = await execute(fixture);
    assert.equal(result.account.action, 'reuse');
    assert.equal(result.pane.action, 'reuse');
    assert.equal(result.pane.entity_id, 'pane-old');
    assert.deepEqual(fixture.state.events, ['activate:pane-old', 'report:pane-old']);
  });

  it('creates a missing Account Strategy and adds one verified Pane Instance', async () => {
    const fixture = syncFixture({ account: null, panes: [] });
    const result = await execute(fixture);
    assert.equal(result.account.action, 'create');
    assert.equal(result.account.version, '1.0');
    assert.equal(result.pane.action, 'add_latest');
    assert.equal(fixture.state.panes.length, 1);
    assert.deepEqual(fixture.state.events.slice(0, 2), ['account:create', 'pane:add']);
  });

  it('updates once, verifies latest, migrates Inputs, then removes the old Instance', async () => {
    const fixture = syncFixture({
      account: accountScript({ source: OLD_SOURCE, version: '1.0' }),
      panes: [paneInstance({ version: '1.0', value: 15 })],
    });
    const result = await execute(fixture);
    assert.equal(result.account.action, 'update');
    assert.equal(result.account.previous_version, '1.0');
    assert.equal(result.account.version, '2.0');
    assert.equal(result.pane.action, 'refresh');
    assert.equal(result.pane.previous_entity_id, 'pane-old');
    assert.equal(fixture.state.panes.length, 1);
    assert.equal(fixture.state.panes[0].inputs[0].value, 15);
    assert.equal(fixture.state.events.filter((event) => event === 'account:update').length, 1);
    assert.ok(
      fixture.state.events.indexOf('report:pane-new-1')
      < fixture.state.events.indexOf('pane:remove:pane-old'),
    );
  });

  it('does not mutate Account or Pane when the compile gate fails', async () => {
    const fixture = syncFixture();
    fixture.deps.checkPine = async () => ({ compiled: false, input_schema: null });
    const error = await captureSyncError(() => execute(fixture));
    assert.equal(error.code, 'PINE_COMPILE_FAILED');
    assert.deepEqual(fixture.state.events, []);
  });

  it('rejects ambiguous matching Pane Instances before mutation', async () => {
    const fixture = syncFixture({ panes: [paneInstance(), paneInstance({ entityId: 'pane-two' })] });
    const error = await captureSyncError(() => execute(fixture));
    assert.equal(error.code, 'STRATEGY_INSTANCE_AMBIGUOUS');
    assert.deepEqual(fixture.state.events, []);
    assert.equal(error.sync_state.account.action, 'blocked');
  });

  it('rejects a stale dry-run plan before Account or Pane mutation', async () => {
    const fixture = syncFixture();
    const error = await captureSyncError(() => execute(fixture, {
      expected_plan: { account_action: 'update', pane_action: 'refresh' },
    }));
    assert.equal(error.code, 'STRATEGY_SYNC_PLAN_STALE');
    assert.deepEqual(fixture.state.events, []);
  });

  for (const failure of [
    ['add', { addError: new Error('add failed') }, 'not_required'],
    ['schema', { badNewSchema: true }, 'removed'],
    ['inputs', { inputsError: new Error('inputs failed') }, 'removed'],
    ['activation', { activationError: new Error('activation failed') }, 'removed'],
    ['report', { reportError: new Error('report failed') }, 'removed'],
  ]) {
    it(`preserves the old Instance and bounds cleanup after ${failure[0]} failure`, async () => {
      const fixture = syncFixture({
        account: accountScript({ source: OLD_SOURCE, version: '1.0' }),
        panes: [paneInstance({ version: '1.0', value: 15 })],
        hooks: failure[1],
      });
      const error = await captureSyncError(() => execute(fixture));
      assert.equal(error.sync_state.account.version, '2.0');
      assert.equal(error.cleanup.status, failure[2]);
      assert.equal(error.sync_state.recovery.account_action, 'reuse');
      assert.equal(error.sync_state.recovery.pane_action, 'refresh');
      assert.equal(error.sync_state.recovery.safe_to_retry, true);
      assert.ok(fixture.state.panes.some((pane) => pane.entity_id === 'pane-old'));
      if (failure[2] === 'removed') {
        assert.equal(fixture.state.panes.some((pane) => pane.entity_id === 'pane-new-1'), false);
      }
    });
  }

  it('reports cleanup failure without deleting the old Instance', async () => {
    const fixture = syncFixture({
      account: accountScript({ source: OLD_SOURCE, version: '1.0' }),
      panes: [paneInstance({ version: '1.0', value: 15 })],
      hooks: {
        reportError: new Error('report failed'),
        removeError: (entityId) => entityId === 'pane-new-1',
      },
    });
    const error = await captureSyncError(() => execute(fixture));
    assert.equal(error.cleanup.status, 'failed');
    assert.equal(error.sync_state.recovery.safe_to_retry, false);
    assert.ok(fixture.state.panes.some((pane) => pane.entity_id === 'pane-old'));
    assert.ok(fixture.state.panes.some((pane) => pane.entity_id === 'pane-new-1'));
  });

  it('preserves the verified new Instance when removing the old Instance fails', async () => {
    const fixture = syncFixture({
      account: accountScript({ source: OLD_SOURCE, version: '1.0' }),
      panes: [paneInstance({ version: '1.0', value: 15 })],
      hooks: { removeError: (entityId) => entityId === 'pane-old' },
    });
    const error = await captureSyncError(() => execute(fixture));
    assert.equal(error.phase, 'pane_remove_old');
    assert.equal(error.cleanup.status, 'preserve_new_after_old_removal_started');
    assert.equal(error.sync_state.recovery.pane_action, 'inspect');
    assert.equal(error.sync_state.recovery.safe_to_retry, false);
    assert.deepEqual(fixture.state.panes.map((pane) => pane.entity_id), ['pane-old', 'pane-new-1']);
  });

  it('does not remove either owned Instance after concurrent Pane ownership changes', async () => {
    const fixture = syncFixture({
      account: accountScript({ source: OLD_SOURCE, version: '1.0' }),
      panes: [paneInstance({ version: '1.0', value: 15 })],
      hooks: {
        afterReport: (state) => {
          state.panes = state.panes.filter((pane) => pane.entity_id !== 'pane-old');
        },
      },
    });
    const error = await captureSyncError(() => execute(fixture));
    assert.equal(error.code, 'STRATEGY_INSTANCE_OWNERSHIP_CHANGED');
    assert.equal(error.cleanup.status, 'preserve_new_after_ownership_change');
    assert.equal(error.sync_state.recovery.pane_action, 'inspect');
    assert.deepEqual(fixture.state.panes.map((pane) => pane.entity_id), ['pane-new-1']);
    assert.equal(fixture.state.events.some((event) => event.startsWith('pane:remove:')), false);
  });

  it('rejects an Account update that does not create a new version', async () => {
    const fixture = syncFixture({
      account: accountScript({ source: OLD_SOURCE, version: '1.0' }),
      panes: [paneInstance({ version: '1.0' })],
    });
    fixture.deps.updateSavedScript = async ({ source }) => {
      fixture.state.events.push('account:update');
      fixture.state.account = { ...fixture.state.account, pine_source: source };
      return { success: true, compile_ok: true, script_id: fixture.state.account.script_id };
    };
    const error = await captureSyncError(() => execute(fixture));
    assert.equal(error.code, 'STRATEGY_VERSION_READBACK_MISMATCH');
    assert.deepEqual(fixture.state.events, ['account:update']);
    assert.equal(error.sync_state.account.version, '1.0');
    assert.equal(error.sync_state.pane, null);
  });

  it('rejects Account source, type, and version readback mismatches', async (t) => {
    const cases = [
      ['source', (account) => ({ ...account, pine_source: OLD_SOURCE }), 'STRATEGY_SOURCE_READBACK_MISMATCH'],
      ['type', (account) => ({ ...account, type: 'indicator' }), 'STRATEGY_ACCOUNT_READBACK_MISMATCH'],
      ['version', (account) => ({ ...account, version: null }), 'STRATEGY_VERSION_READBACK_MISMATCH'],
    ];
    for (const [name, mutate, code] of cases) {
      await t.test(name, async () => {
        const fixture = syncFixture();
        fixture.deps.getSavedScript = async () => mutate(fixture.state.account);
        const error = await captureSyncError(() => execute(fixture));
        assert.equal(error.code, code);
        assert.equal(error.sync_state.pane, null);
      });
    }
  });
});
