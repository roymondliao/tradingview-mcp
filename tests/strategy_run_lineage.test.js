import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import {
  createDurableExperimentArtifact,
  createDurableExperimentManifest,
} from '../src/core/strategy-durable-experiment.js';
import {
  createParameterSetExecutionPlan,
  persistableParameterSetPlan,
} from '../src/core/strategy-parameter-sets.js';
import {
  deriveRunSummary,
  transitionExperimentState,
  transitionRunState,
  transitionSymbolState,
} from '../src/core/strategy-run-state.js';
import {
  STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES,
  loadStrategyRunLineage,
  strategyLineageFingerprint,
  strategyParameterSetsFingerprint,
  strategyRunFingerprint,
} from '../src/core/strategy-run-lineage.js';
import {
  baseInputs,
  candidateSchema,
  strategyIdentity,
} from './helpers/strategy_resume_fixture.js';

const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;
const SNAPSHOT_HASH = `sha256:${'b'.repeat(64)}`;
const SYMBOLS_HASH = `sha256:${'c'.repeat(64)}`;
const SYMBOL = 'TWSE:2330';

function watchlist() {
  return {
    snapshot: {
      complete: true,
      snapshot_id: SNAPSHOT_HASH,
      ordered_symbol_fingerprint: SYMBOLS_HASH,
    },
    symbols: [SYMBOL],
  };
}

function succeededArtifacts({
  runId,
  parameterSets,
  runKind = 'standalone',
  extension,
} = {}) {
  const identity = strategyIdentity({ source_sha256: SOURCE_HASH });
  const candidate = { ...candidateSchema(), source_sha256: SOURCE_HASH };
  const execution = createParameterSetExecutionPlan({
    base_catalog: baseInputs(),
    candidate_schema: candidate,
    parameter_sets: parameterSets,
    identity,
  });
  const plans = execution.parameter_sets.map(persistableParameterSetPlan);
  let run = {
    artifact_schema_version: 4,
    run_kind: runKind,
    run_id: runId,
    status: 'running',
    requested: {
      config_schema_version: 1,
      run: { run_id: runId, generated: false, description: '' },
      strategy: {
        file: './strategy.pine', file_path: '/tmp/strategy.pine',
        saved_name: 'strategy', source_sha256: SOURCE_HASH,
      },
      target: {
        layout: { name: 'dev' }, pane_index: 0, watchlist: { name: 'list' },
      },
      backtest: { timeframe: '1D' },
      experiments: { parameter_sets: parameterSets },
      output: { directory: './output', format: 'csv' },
    },
    config: { path: `/tmp/${runId}.json`, sha256: `${runId}-config` },
    source_sha256: SOURCE_HASH,
    candidate_schema_fingerprint: candidate.input_schema_fingerprint,
    resolved: {
      target: { layout_name: 'dev', saved_layout_id: 1, pane_index: 0, pane_id: 'pane' },
      strategy: identity,
      watchlist: {
        name: 'list', snapshot_id: SNAPSHOT_HASH,
        ordered_symbol_fingerprint: SYMBOLS_HASH, symbol_count: 1,
      },
    },
    base_inputs: execution.base_inputs,
    base_inputs_fingerprint: execution.base_inputs_fingerprint,
    planned_experiments: plans,
    ...(extension && { extension }),
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {},
    experiments: [],
    error: null,
  };
  const experiments = [];
  const manifests = [];
  plans.forEach((plan, index) => {
    const experiment = createDurableExperimentArtifact({ run, experiment_plan: plan, started_at: 1000 });
    let manifest = createDurableExperimentManifest({
      run,
      experiment,
      requested_symbols: [SYMBOL],
      timeframe: '1D',
      format: 'csv',
      started_at: 1000,
    });
    manifest = transitionSymbolState(manifest, { index: 0, status: 'running', updated_at: 1001 });
    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'succeeded',
      updated_at: 1002,
      details: {
        resolved_symbol: 'TWSE_DLY:2330',
        snapshot_id: `sha256:${'d'.repeat(64)}`,
        total_trades: 1,
        batch_count: 1,
        artifacts: {
          report: `experiments/${plan.parameter_set.name}/symbols/TWSE_u3A_2330/report.json`,
          trades: `experiments/${plan.parameter_set.name}/symbols/TWSE_u3A_2330/trades.csv`,
          reconciliation: `experiments/${plan.parameter_set.name}/symbols/TWSE_u3A_2330/reconciliation.json`,
        },
      },
    });
    manifest = transitionExperimentState(manifest, { status: 'succeeded', updated_at: 1003 });
    experiments.push(experiment);
    manifests.push(manifest);
  });
  const summary = deriveRunSummary({ run, manifests });
  run = transitionRunState(run, {
    status: 'succeeded',
    updated_at: 1004,
    patch: { summary, experiments: [] },
  });
  return { run, watchlist: watchlist(), experiments, manifests };
}

function extensionMetadata({ parent, inherited, full, depth }) {
  const parentFingerprint = strategyRunFingerprint(parent.run);
  const inheritedFingerprint = strategyParameterSetsFingerprint(inherited);
  return {
    fingerprint_schema_version: 1,
    parent_run_id: parent.run.run_id,
    parent_artifact_schema_version: 4,
    parent_run_fingerprint: parentFingerprint,
    lineage_fingerprint: strategyLineageFingerprint({
      direct_parent_run_fingerprint: parentFingerprint,
      parent_lineage_fingerprint: parent.run.run_kind === 'extension'
        ? parent.run.extension.lineage_fingerprint
        : null,
      inherited_parameter_sets_fingerprint: inheritedFingerprint,
      inherited_experiment_count: inherited.length,
      lineage_depth: depth,
    }),
    lineage_depth: depth,
    inherited_experiment_count: inherited.length,
    new_experiment_count: full.length - inherited.length,
    inherited_parameter_sets_fingerprint: inheritedFingerprint,
    requested_parameter_sets_fingerprint: strategyParameterSetsFingerprint(full),
    new_parameter_sets: full.slice(inherited.length).map((set, index) => ({
      name: set.name,
      config_index: inherited.length + index,
      lineage_index: inherited.length + index,
      run_index: index,
    })),
  };
}

function loaderDeps(artifactsByPath) {
  const directoryInfo = { isDirectory: () => true, isSymbolicLink: () => false, isFile: () => false };
  const fileInfo = { isDirectory: () => false, isSymbolicLink: () => false, isFile: () => true, size: 100 };
  return {
    lstat: async (path) => (/\.(?:json|csv)$/.test(path) ? fileInfo : directoryInfo),
    realpath: async (path) => path,
    readArtifacts: async ({ run_directory: runDirectory }) => ({
      ...artifactsByPath.get(runDirectory),
      store: {
        run_path: runDirectory,
        artifactPath: (relativePath) => join(runDirectory, relativePath),
      },
    }),
    verifySucceededSymbolArtifacts: async () => ({ verified: true }),
  };
}

describe('Strategy Run lineage', () => {
  it('loads and verifies an A → B → C chain in root-to-parent order', async () => {
    const rootSets = [{ name: 'baseline', inputs: {} }];
    const bSet = { name: 'candidate', inputs: { Length: 5 } };
    const cSet = { name: 'candidate-2', inputs: { Length: 7 } };
    const root = succeededArtifacts({ runId: 'run-a', parameterSets: rootSets });
    const bFull = [...rootSets, bSet];
    const b = succeededArtifacts({
      runId: 'run-b',
      runKind: 'extension',
      parameterSets: [bSet],
      extension: extensionMetadata({ parent: root, inherited: rootSets, full: bFull, depth: 1 }),
    });
    const cFull = [...bFull, cSet];
    const c = succeededArtifacts({
      runId: 'run-c',
      runKind: 'extension',
      parameterSets: [cSet],
      extension: extensionMetadata({ parent: b, inherited: bFull, full: cFull, depth: 2 }),
    });
    const outputRoot = '/tmp/lineage-output';
    const paths = new Map([
      [join(outputRoot, 'run-a'), root],
      [join(outputRoot, 'run-b'), b],
      [join(outputRoot, 'run-c'), c],
    ]);
    const lineage = await loadStrategyRunLineage({
      run_directory: join(outputRoot, 'run-c'),
      _deps: loaderDeps(paths),
    });
    assert.deepEqual(lineage.chain.map((entry) => entry.artifacts.run.run_id), [
      'run-a', 'run-b', 'run-c',
    ]);
    assert.deepEqual(lineage.parameter_sets.map((set) => set.name), [
      'baseline', 'candidate', 'candidate-2',
    ]);
    assert.equal(lineage.lineage_depth, 2);
    assert.equal(lineage.inherited_experiment_count, 3);
    assert.equal(lineage.output_root, dirname(join(outputRoot, 'run-c')));
  });

  it('rejects a changed Parent fingerprint in an existing Extension edge', async () => {
    const rootSets = [{ name: 'baseline', inputs: {} }];
    const childSet = { name: 'candidate', inputs: { Length: 5 } };
    const root = succeededArtifacts({ runId: 'run-a', parameterSets: rootSets });
    const full = [...rootSets, childSet];
    const metadata = extensionMetadata({ parent: root, inherited: rootSets, full, depth: 1 });
    metadata.parent_run_fingerprint = `sha256:${'f'.repeat(64)}`;
    const child = succeededArtifacts({
      runId: 'run-b', runKind: 'extension', parameterSets: [childSet], extension: metadata,
    });
    const outputRoot = '/tmp/lineage-corrupt';
    const paths = new Map([
      [join(outputRoot, 'run-a'), root],
      [join(outputRoot, 'run-b'), child],
    ]);
    await assert.rejects(
      loadStrategyRunLineage({
        run_directory: join(outputRoot, 'run-b'),
        _deps: loaderDeps(paths),
      }),
      (error) => error.code === 'RUN_EXTENSION_LINEAGE_INVALID',
    );
  });

  it('rejects a Parent at depth 64 because the next child would exceed the bound', async () => {
    const outputRoot = '/tmp/lineage-depth';
    const rootSets = [{ name: 'baseline', inputs: {} }];
    let parent = succeededArtifacts({ runId: 'run-0', parameterSets: rootSets });
    let inherited = [...rootSets];
    const paths = new Map([[join(outputRoot, 'run-0'), parent]]);
    for (let depth = 1; depth <= 64; depth += 1) {
      const parameterSet = { name: `candidate-${depth}`, inputs: { Length: depth % 20 || 20 } };
      const full = [...inherited, parameterSet];
      const child = succeededArtifacts({
        runId: `run-${depth}`,
        runKind: 'extension',
        parameterSets: [parameterSet],
        extension: extensionMetadata({ parent, inherited, full, depth }),
      });
      paths.set(join(outputRoot, `run-${depth}`), child);
      parent = child;
      inherited = full;
    }
    await assert.rejects(
      loadStrategyRunLineage({
        run_directory: join(outputRoot, 'run-64'),
        _deps: loaderDeps(paths),
      }),
      (error) => error.code === 'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED',
    );
  });

  it('rejects cumulative lineage JSON bytes above 64 MiB', async () => {
    const outputRoot = '/tmp/lineage-bytes';
    const root = succeededArtifacts({
      runId: 'run-a', parameterSets: [{ name: 'baseline', inputs: {} }],
    });
    const path = join(outputRoot, 'run-a');
    const deps = loaderDeps(new Map([[path, root]]));
    const originalLstat = deps.lstat;
    deps.lstat = async (target) => {
      const info = await originalLstat(target);
      if (info.isFile()) return { ...info, size: STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES };
      return info;
    };
    await assert.rejects(
      loadStrategyRunLineage({ run_directory: path, _deps: deps }),
      (error) => error.code === 'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED',
    );
  });
});
