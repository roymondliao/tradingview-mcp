import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadStrategyResume,
  resolveStrategyResumeIdentity,
  resolveStrategyResumeSetup,
} from '../src/core/strategy-resume.js';
import { effectiveInputsFingerprint } from '../src/core/strategy-parameter-sets.js';
import {
  baseInputs,
  createResumeFixture,
} from './helpers/strategy_resume_fixture.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-strategy-resume-identity-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function identityDependencies(fixture, overrides = {}) {
  const calls = {
    layout: 0,
    account: 0,
    pane: 0,
    watchlist: 0,
  };
  const currentInputs = overrides.inputs || baseInputs();
  const deps = {
    checkPine: async () => ({
      compiled: true,
      input_schema: {
        available: true,
        source_sha256: fixture.sourceSha256,
        input_schema_fingerprint: 'candidate-schema',
      },
    }),
    resolveLayoutTarget: async () => {
      calls.layout += 1;
      return {
        tab_index: 9,
        target_id: 'new-target',
        url_chart_id: 'new-url',
        layout_name: 'dev',
        layout_id: 'new-layout-id',
        saved_layout_id: 101,
        pane_layout: 's',
        pane_index: 0,
        pane_id: 'pane-1',
        symbol: 'TPEX:5483',
        timeframe: '60',
        ...overrides.target,
      };
    },
    attachTarget: async () => {},
    resolveSavedStrategy: async () => {
      calls.account += 1;
      return {
        saved_name: 'resume-strategy',
        exists: true,
        match_count: 1,
        script: {
          script_id: 'USER;strategy-1',
          id: 'USER;strategy-1',
          name: 'resume-strategy',
          type: 'strategy',
          version: '3.0',
          ...overrides.accountScript,
        },
      };
    },
    readResolvedSavedStrategy: async ({ resolved_account: account }) => ({
      ...account.script,
      source_sha256: overrides.accountSource || fixture.sourceSha256,
      pine_source: fixture.pineSource,
    }),
    readTargetPaneStudies: async () => {
      calls.pane += 1;
      return {
        target_id: 'new-target',
        pane_index: 0,
        symbol: 'TPEX:5483',
        timeframe: '60',
        studies: overrides.studies || [{
          entity_id: 'new-entity',
          type: 'strategy',
          script_id: 'USER;strategy-1',
          version: '3.0',
          inputs: currentInputs,
          inputs_fingerprint: effectiveInputsFingerprint(currentInputs),
        }],
      };
    },
    captureNamedWatchlistSnapshot: async () => {
      calls.watchlist += 1;
      throw new Error('Resume must not recapture Watchlist state.');
    },
    ...overrides.deps,
  };
  return { deps, calls };
}

describe('Strategy Resume stable identity rebind', () => {
  it('resolves an idempotent Strategy sync plan for an initialization-only Run', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const { strategy: _strategy, ...resolved } = fixture.run.resolved;
    const setupRun = { ...fixture.run, resolved };
    delete setupRun.base_inputs;
    delete setupRun.base_inputs_fingerprint;
    delete setupRun.planned_experiments;
    await fixture.store.replaceRun(setupRun);
    const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
    assert.equal(local.plan.setup_required, true);
    const runtime = identityDependencies(fixture);
    const setup = await resolveStrategyResumeSetup({ local, _deps: runtime.deps });
    assert.equal(setup.strategy_sync.account_action, 'reuse');
    assert.equal(setup.strategy_sync.pane_action, 'reuse');
    assert.equal(setup.target.target_id, 'new-target');
  });

  it('rebinds volatile target, tab, entity, Symbol, and timeframe IDs', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
    const runtime = identityDependencies(fixture);
    const result = await resolveStrategyResumeIdentity({ local, _deps: runtime.deps });
    assert.equal(result.target.target_id, 'new-target');
    assert.equal(result.target.tab_index, 9);
    assert.equal(result.strategy.entity_id, 'new-entity');
    assert.equal(result.target.symbol, 'TPEX:5483');
    assert.equal(result.target.resolution, '60');
    assert.deepEqual(result.chart_restore_baseline, {
      symbol: 'TPEX:5483', resolution: '60',
    });
    assert.equal(runtime.calls.watchlist, 0);
  });

  it('accepts current Inputs at Base or any persisted Effective Inputs plan', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
    for (const inputs of [fixture.run.base_inputs, fixture.run.planned_experiments[1].effective_inputs]) {
      const runtime = identityDependencies(fixture, { inputs });
      const result = await resolveStrategyResumeIdentity({ local, _deps: runtime.deps });
      assert.equal(result.current_inputs_fingerprint.value, effectiveInputsFingerprint(inputs).value);
    }
  });

  it('rejects arbitrary current Inputs while leaving the Pane untouched', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
    const runtime = identityDependencies(fixture, { inputs: baseInputs(7) });
    await assert.rejects(
      resolveStrategyResumeIdentity({ local, _deps: runtime.deps }),
      (error) => error.code === 'RUN_RESUME_IDENTITY_MISMATCH'
        && error.phase === 'resume_identity',
    );
    assert.equal(runtime.calls.layout, 1);
    assert.equal(runtime.calls.pane, 1);
  });

  it('rejects Layout, Pane, script, version, source, catalog, and schema drift', async () => {
    const cases = [
      { name: 'layout', overrides: { target: { saved_layout_id: 202 } } },
      { name: 'pane', overrides: { target: { pane_id: 'other-pane' } } },
      { name: 'script', overrides: { accountScript: { script_id: 'USER;other', id: 'USER;other' } } },
      { name: 'account version', overrides: { accountScript: { version: '4.0' } } },
      { name: 'account source', overrides: { accountSource: 'different-source' } },
      {
        name: 'pane version',
        overrides: {
          studies: [{
            entity_id: 'new-entity', type: 'strategy', script_id: 'USER;strategy-1',
            version: '4.0', inputs: baseInputs(),
            inputs_fingerprint: effectiveInputsFingerprint(baseInputs()),
          }],
        },
      },
      {
        name: 'input catalog',
        overrides: {
          inputs: [{ ...baseInputs()[0], name: 'Other Length' }],
        },
      },
      {
        name: 'candidate schema',
        overrides: {
          deps: {
            checkPine: async () => ({
              compiled: true,
              input_schema: {
                available: true,
                source_sha256: null,
                input_schema_fingerprint: 'different-schema',
              },
            }),
          },
        },
      },
    ];
    for (const testCase of cases) {
      const fixture = await createResumeFixture({ root: temporaryDirectory() });
      const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
      const runtime = identityDependencies(fixture, testCase.overrides);
      await assert.rejects(
        resolveStrategyResumeIdentity({ local, _deps: runtime.deps }),
        (error) => error.code === 'RUN_RESUME_IDENTITY_MISMATCH',
        testCase.name,
      );
    }
  });

  it('rejects local Pine source drift before any Desktop resolver call', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
    writeFileSync(fixture.pinePath, `${fixture.pineSource}\n// changed\n`);
    const runtime = identityDependencies(fixture);
    await assert.rejects(
      resolveStrategyResumeIdentity({ local, _deps: runtime.deps }),
      (error) => error.code === 'RUN_RESUME_IDENTITY_MISMATCH',
    );
    assert.equal(runtime.calls.layout, 0);
    assert.equal(runtime.calls.account, 0);
    assert.equal(runtime.calls.pane, 0);
  });

  it('uses persisted frozen Watchlist even when current Account state would differ', async () => {
    const fixture = await createResumeFixture({ root: temporaryDirectory() });
    const local = await loadStrategyResume({ run_directory: fixture.store.run_path });
    const runtime = identityDependencies(fixture);
    await resolveStrategyResumeIdentity({ local, _deps: runtime.deps });
    assert.deepEqual(local.symbols, fixture.symbols);
    assert.equal(runtime.calls.watchlist, 0);
  });
});
