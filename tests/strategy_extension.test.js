import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createParameterSetExecutionPlan,
  persistableParameterSetPlan,
} from '../src/core/strategy-parameter-sets.js';
import {
  strategyParameterSetsFingerprint,
  strategyRunFingerprint,
} from '../src/core/strategy-run-lineage.js';
import {
  dryRunStrategyExtension,
  extendStrategyAutomation,
} from '../src/core/strategy-extend.js';
import { validateRunArtifactV4 } from '../src/core/strategy-run-state.js';
import { openDurableRunStore } from '../src/core/strategy-run-artifacts.js';
import { loadStrategyResume, resumeStrategyAutomation } from '../src/core/strategy-resume.js';
import {
  WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS,
  WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS,
} from '../src/core/watchlist.js';
import {
  baseInputs,
  candidateSchema,
  createResumeFixture,
  strategyIdentity,
} from './helpers/strategy_resume_fixture.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, {
    recursive: true, force: true,
  })));
});

function fixture({ outputRoot = '/tmp/extension-output' } = {}) {
  const sourceSha256 = `sha256:${'a'.repeat(64)}`;
  const identity = strategyIdentity({ source_sha256: sourceSha256 });
  const candidate = { ...candidateSchema(), source_sha256: sourceSha256 };
  const inherited = [{ name: 'baseline', inputs: {} }];
  const execution = createParameterSetExecutionPlan({
    base_catalog: baseInputs(),
    candidate_schema: candidate,
    parameter_sets: inherited,
    identity,
  });
  const parent = {
    artifact_schema_version: 3,
    run_id: 'parent-run',
    status: 'succeeded',
    requested: {
      config_schema_version: 1,
      run: { run_id: 'parent-run', generated: false, description: '' },
      strategy: {
        file: './strategy.pine',
        file_path: '/tmp/strategy.pine',
        saved_name: 'strategy',
        source_sha256: sourceSha256,
      },
      target: {
        layout: { name: 'dev' },
        pane_index: 0,
        watchlist: { name: 'list' },
      },
      backtest: { timeframe: '1D' },
      experiments: { parameter_sets: inherited },
      output: {
        directory: './output',
        directory_path: outputRoot,
        run_path: join(outputRoot, 'parent-run'),
        format: 'csv',
      },
    },
    config: { path: '/tmp/parent.json', sha256: 'parent-config' },
    source_sha256: sourceSha256,
    candidate_schema_fingerprint: candidate.input_schema_fingerprint,
    resolved: {
      target: {
        layout_name: 'dev', saved_layout_id: 1, pane_index: 0, pane_id: 'pane-1',
      },
      strategy: identity,
      watchlist: {
        name: 'list',
        snapshot_id: `sha256:${'b'.repeat(64)}`,
        ordered_symbol_fingerprint: `sha256:${'c'.repeat(64)}`,
        symbol_count: 1,
      },
    },
    base_inputs: execution.base_inputs,
    base_inputs_fingerprint: execution.base_inputs_fingerprint,
    planned_experiments: execution.parameter_sets.map(persistableParameterSetPlan),
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1001,
    updated_at_iso: '1970-01-01T00:00:01.001Z',
    summary: {},
    experiments: [],
    error: null,
  };
  const watchlist = {
    watchlist: { name: 'list' },
    snapshot: {
      complete: true,
      snapshot_id: parent.resolved.watchlist.snapshot_id,
      ordered_symbol_fingerprint: parent.resolved.watchlist.ordered_symbol_fingerprint,
    },
    symbols: ['TWSE:2330'],
    symbol_validation: { performed: true, success: true },
  };
  const lineage = {
    output_root: outputRoot,
    parent_directory: join(outputRoot, 'parent-run'),
    chain: [{ path: join(outputRoot, 'parent-run'), artifacts: { run: parent, watchlist } }],
    parent: { run: parent, watchlist },
    parameter_sets: inherited,
    inherited_experiment_count: 1,
    inherited_parameter_sets_fingerprint: strategyParameterSetsFingerprint(inherited),
    parent_run_fingerprint: strategyRunFingerprint(parent),
    parent_lineage_fingerprint: null,
    lineage_depth: 0,
  };
  const desired = [...inherited, { name: 'candidate', inputs: { Length: 5 } }];
  const requested = {
    schema_version: 1,
    run: { run_id: 'child-run', generated: false, description: '' },
    strategy: {
      file: './moved-strategy.pine',
      file_path: '/tmp/moved-strategy.pine',
      saved_name: 'strategy',
      source_sha256: sourceSha256,
    },
    target: {
      layout: { name: 'dev' }, pane_index: 0, watchlist: { name: 'list' },
    },
    backtest: { timeframe: '1D' },
    experiments: { parameter_sets: desired },
    output: {
      directory: './output', directory_path: outputRoot,
      run_path: join(outputRoot, 'child-run'), format: 'csv',
    },
  };
  const loaded = {
    valid: true,
    errors: [],
    warnings: [],
    config_path: '/tmp/extended.json',
    config_sha256: 'extended-config',
    requested,
    pine_source: 'strategy("same")',
  };
  const runtime = {
    candidate_schema: candidate,
    target: { ...parent.resolved.target, target_id: 'target-1' },
    strategy: identity,
  };
  return { candidate, identity, lineage, loaded, parent, requested, runtime };
}

function preflightDeps(current, overrides = {}) {
  return {
    loadStrategyRunLineage: async () => current.lineage,
    loadStrategyRunConfig: async () => current.loaded,
    resolveStrategyResumeIdentity: async () => current.runtime,
    fs: { lstat: async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error; } },
    ...overrides,
  };
}

async function executeSelectedParameterSets({
  prepared,
  selected_indices: selectedIndices,
  before_experiment: beforeExperiment,
}, operation) {
  const results = [];
  for (const index of selectedIndices) {
    const parameterSet = prepared.parameter_sets[index];
    await beforeExperiment(parameterSet);
    results.push(await operation({ parameter_set: parameterSet }));
  }
  return { results };
}

async function executeSymbolAttempt({ attempt, symbol }) {
  await attempt.writeJson('report.json', { symbol });
  const trades = await attempt.openArtifact('trades.csv');
  await new Promise((resolveWrite, rejectWrite) => {
    trades.once('error', rejectWrite);
    trades.once('close', resolveWrite);
    trades.end('trade\n');
  });
  await attempt.writeJson('reconciliation.json', { success: true });
  const [report, tradeInfo, reconciliation] = await Promise.all([
    attempt.artifactInfo('report.json'),
    attempt.artifactInfo('trades.csv'),
    attempt.artifactInfo('reconciliation.json'),
  ]);
  return {
    resolved_symbol: symbol.replace('TWSE:', 'TWSE_DLY:'),
    snapshot_id: `sha256:${'5'.repeat(64)}`,
    total_trades: 1,
    batch_count: 1,
    artifacts: { report, trades: tradeInfo, reconciliation },
  };
}

describe('Strategy Extension preflight', () => {
  it('accepts only the appended suffix and allows the same Pine source at a new path', async () => {
    const current = fixture();
    const result = await dryRunStrategyExtension({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _include_internal: true,
      _deps: preflightDeps(current),
    });
    assert.equal(result.valid, true);
    assert.equal(result.extension.experiments_new, 1);
    assert.deepEqual(result.extension.new_parameter_sets, ['candidate']);
    assert.equal(result._internal.plan.extension.lineage_depth, 1);
    assert.equal(result._internal.plan.extension.inherited_experiment_count, 1);
  });

  it('adds Extension semantics to an auto-generated child Run ID', async () => {
    const current = fixture();
    current.loaded = {
      ...current.loaded,
      requested: {
        ...current.loaded.requested,
        run: {
          ...current.loaded.requested.run,
          run_id: 'strategy-20261008T010203Z-a1b2c3d4',
          generated: true,
        },
      },
    };
    const result = await dryRunStrategyExtension({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _deps: preflightDeps(current),
    });
    assert.equal(result.valid, true);
    assert.equal(result.extension.run_id, 'strategy-extension-20261008T010203Z-a1b2c3d4');
  });

  it('rejects prefix mutation before resolving TradingView identity', async () => {
    const current = fixture();
    current.loaded = {
      ...current.loaded,
      requested: {
        ...current.loaded.requested,
        experiments: {
          parameter_sets: [
            { name: 'baseline', inputs: { Length: 7 } },
            { name: 'candidate', inputs: { Length: 5 } },
          ],
        },
      },
    };
    let runtimeReads = 0;
    const result = await dryRunStrategyExtension({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _deps: preflightDeps(current, {
        resolveStrategyResumeIdentity: async () => { runtimeReads += 1; return current.runtime; },
      }),
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'RUN_EXTENSION_EXISTING_EXPERIMENT_CHANGED');
    assert.equal(runtimeReads, 0);
  });

  it('rejects a different normalized Pine source before runtime resolution', async () => {
    const current = fixture();
    current.loaded = {
      ...current.loaded,
      requested: {
        ...current.loaded.requested,
        strategy: {
          ...current.loaded.requested.strategy,
          source_sha256: `sha256:${'d'.repeat(64)}`,
        },
      },
    };
    let runtimeReads = 0;
    const result = await dryRunStrategyExtension({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _deps: preflightDeps(current, {
        resolveStrategyResumeIdentity: async () => { runtimeReads += 1; return current.runtime; },
      }),
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors[0].code, 'RUN_EXTENSION_CONFIG_MISMATCH');
    assert.equal(runtimeReads, 0);
  });

  it('rejects more than 4096 cumulative Experiments before runtime resolution', async () => {
    const current = fixture();
    const parameterSets = [{ name: 'baseline', inputs: {} }];
    for (let index = 1; index < 4097; index += 1) {
      parameterSets.push({ name: `candidate-${index}`, inputs: { Length: (index % 20) + 1 } });
    }
    current.loaded = {
      ...current.loaded,
      requested: {
        ...current.loaded.requested,
        experiments: { parameter_sets: parameterSets },
      },
    };
    let runtimeReads = 0;
    const result = await dryRunStrategyExtension({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _deps: preflightDeps(current, {
        resolveStrategyResumeIdentity: async () => { runtimeReads += 1; return current.runtime; },
      }),
    });
    assert.equal(result.valid, false);
    assert.equal(
      result.errors.some((error) => error.code === 'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED'),
      true,
    );
    assert.equal(runtimeReads, 0);
  });
});

describe('Strategy Extension shared lifecycle adapter', () => {
  it('passes a complete v4 child with new-only plans to the shared lifecycle', async () => {
    const current = fixture();
    const prepared = await dryRunStrategyExtension({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _include_internal: true,
      _deps: preflightDeps(current),
    });
    let received;
    const result = await extendStrategyAutomation({
      run_directory: current.lineage.parent_directory,
      config_path: current.loaded.config_path,
      _deps: {
        dryRunStrategyExtension: async () => prepared,
        now: () => 2000,
        executePreparedDurableRun: async (options) => {
          received = options;
          validateRunArtifactV4(options.spec.run);
          return { success: true, run_id: options.spec.run.run_id };
        },
      },
    });
    assert.equal(result.success, true);
    assert.equal(received.spec.run.run_kind, 'extension');
    assert.deepEqual(
      received.spec.run.requested.experiments.parameter_sets.map((item) => item.name),
      ['candidate'],
    );
    assert.equal(received.spec.run.planned_experiments.length, 1);
    assert.equal(received.spec.response_fields.parent_run_id, 'parent-run');
  });

  it('loads a v4 Extension child for Resume without an available Parent directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tv-extension-resume-'));
    temporaryDirectories.push(root);
    const child = await createResumeFixture({ root });
    const { schema_version: _artifactVersion, ...runFields } = child.run;
    const { schema_version: configSchemaVersion, ...requestedFields } = child.run.requested;
    const run = {
      ...runFields,
      artifact_schema_version: 4,
      run_kind: 'extension',
      requested: { config_schema_version: configSchemaVersion, ...requestedFields },
      extension: {
        fingerprint_schema_version: 1,
        parent_run_id: 'missing-parent',
        parent_artifact_schema_version: 4,
        parent_run_fingerprint: `sha256:${'1'.repeat(64)}`,
        lineage_fingerprint: `sha256:${'2'.repeat(64)}`,
        lineage_depth: 2,
        inherited_experiment_count: 3,
        new_experiment_count: child.plans.length,
        inherited_parameter_sets_fingerprint: `sha256:${'3'.repeat(64)}`,
        requested_parameter_sets_fingerprint: `sha256:${'4'.repeat(64)}`,
        new_parameter_sets: child.plans.map((plan, index) => ({
          name: plan.parameter_set.name,
          config_index: 3 + index,
          lineage_index: 3 + index,
          run_index: index,
        })),
      },
    };
    const store = await openDurableRunStore({ run_directory: child.store.run_path });
    await store.replaceRun(run);
    const local = await loadStrategyResume({ run_directory: child.store.run_path });
    assert.equal(local.artifacts.run.run_kind, 'extension');
    assert.equal(local.artifacts.run.extension.parent_run_id, 'missing-parent');
    assert.equal(local.plan.experiment_count, child.plans.length);
    const resumed = await resumeStrategyAutomation({
      run_directory: child.store.run_path,
      _deps: {
        withStrategyResumeContext: async (_options, operation) => operation({
          local,
          identity: {
            target: local.artifacts.run.resolved.target,
            strategy: local.artifacts.run.resolved.strategy,
          },
        }),
        withChartSession: async (_options, operation) => operation(),
        now: () => 2000,
        execution: { executeSelectedParameterSets, executeSymbolAttempt },
      },
    });
    assert.equal(resumed.success, true);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.parent_run_id, 'missing-parent');
    assert.equal(resumed.experiments_new, child.plans.length);
  });

  it('creates a real sibling child and leaves Parent files unchanged', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'tv-extension-formal-'));
    temporaryDirectories.push(outputRoot);
    const current = fixture({ outputRoot });
    const parentDirectory = join(outputRoot, 'parent-run');
    await mkdir(parentDirectory);
    const markerPath = join(parentDirectory, 'immutable.txt');
    await writeFile(markerPath, 'parent-evidence\n', 'utf8');
    current.lineage = {
      ...current.lineage,
      output_root: outputRoot,
      parent_directory: parentDirectory,
      chain: [{ path: parentDirectory, artifacts: current.lineage.parent }],
    };
    current.loaded = {
      ...current.loaded,
      requested: {
        ...current.loaded.requested,
        output: {
          ...current.loaded.requested.output,
          directory_path: outputRoot,
          run_path: join(outputRoot, 'child-run'),
        },
      },
    };
    const prepared = await dryRunStrategyExtension({
      run_directory: parentDirectory,
      config_path: current.loaded.config_path,
      _include_internal: true,
      _deps: preflightDeps(current),
    });
    assert.equal(prepared.valid, true);
    const validation = {
      schema_version: 1,
      performed: true,
      success: true,
      source: 'tradingview_desktop_cdp',
      max_attempts: WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS,
      attempt_timeout_ms: WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS,
      timeframe: '1D',
      requested: 1,
      valid: 1,
      failed: 0,
      validated_at: 3000,
      validated_at_iso: '1970-01-01T00:00:03.000Z',
      errors: [],
    };
    const result = await extendStrategyAutomation({
      run_directory: parentDirectory,
      config_path: current.loaded.config_path,
      _deps: {
        dryRunStrategyExtension: async () => prepared,
        loadStrategyRunLineage: async () => current.lineage,
        loadStrategyRunConfig: async () => current.loaded,
        resolveStrategyResumeIdentity: async () => current.runtime,
        acquireLeases: async () => ({ release: async () => {} }),
        withChartSession: async (_options, operation) => operation(),
        validateNamedWatchlistSymbols: async () => validation,
        now: () => 3000,
        execution: {
          executeSelectedParameterSets,
          executeSymbolAttempt,
        },
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.run_kind, 'extension');
    assert.equal(await readFile(markerPath, 'utf8'), 'parent-evidence\n');
    const childRun = JSON.parse(await readFile(join(outputRoot, 'child-run', 'run.json'), 'utf8'));
    assert.equal(childRun.status, 'succeeded');
    assert.equal(childRun.run_kind, 'extension');
    assert.deepEqual(childRun.planned_experiments.map((plan) => plan.parameter_set.name), [
      'candidate',
    ]);
    assert.equal(
      await readFile(
        join(outputRoot, 'child-run', 'experiments/candidate/symbols/TWSE_u3A_2330/trades.csv'),
        'utf8',
      ),
      'trade\n',
    );
  });
});
