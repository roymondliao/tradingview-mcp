import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunStrategyAutomation, runStrategyAutomation } from '../src/core/strategy-run.js';
import { CoreOperationError } from '../src/core/errors.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-strategy-run-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function requested() {
  return {
    schema_version: 1,
    run: { run_id: 'test-run', description: '', generated: false },
    strategy: {
      file: './obv.pine', saved_name: 'obv-v3', file_path: '/tmp/obv.pine', source_sha256: 'local-hash',
    },
    target: { layout: { name: 'dev' }, pane_index: 0, watchlist: { name: 'dev-testing-list' } },
    backtest: { timeframe: '1D' },
    experiments: { parameter_sets: [{ name: 'baseline', inputs: { Length: 5 } }] },
    output: { directory: './out', format: 'csv', directory_path: '/tmp/out', run_path: '/tmp/out/test-run' },
  };
}

function candidateSchema() {
  return {
    available: true,
    inputs: [{ name: 'Length', runtime_value_type: 'int', constraints: { min: 1, max: 20 } }],
    input_schema_fingerprint: 'candidate-schema',
  };
}

function successfulDeps(calls = []) {
  return {
    loadStrategyRunConfig: async () => ({
      valid: true, errors: [], warnings: [], config_path: '/tmp/run.json', config_directory: '/tmp',
      config_sha256: 'config-hash', requested: requested(), pine_source: 'source',
    }),
    checkPine: async () => ({ compiled: true, warnings: [], input_schema: candidateSchema() }),
    resolveLayoutTarget: async () => ({
      target_id: 'target-1', layout_name: 'dev', layout_id: 'layout-1', saved_layout_id: 1,
      pane_index: 0, pane_id: 'pane-0', symbol: 'TWSE_DLY:2330', timeframe: '1D',
    }),
    attachTarget: async () => calls.push('attach-target'),
    captureNamedWatchlistSnapshot: async () => ({
      success: true,
      watchlist: { name: 'dev-testing-list', watchlist_id: 1 },
      snapshot: { complete: true, returned_symbol_count: 8, snapshot_id: 'sha256:snapshot' },
      symbols: ['TWSE:2330', 'TWSE:2317', 'TWSE:2454', 'TWSE:2303', 'TWSE:2881', 'TWSE:2882', 'TWSE:2308', 'TWSE:2412'],
    }),
    resolveSavedStrategy: async () => ({
      saved_name: 'obv-v3', match_count: 1, exists: true,
      script: { script_id: 'USER;obv', name: 'obv-v3', type: 'strategy', version: 2 },
    }),
    readResolvedSavedStrategy: async () => ({
      script_id: 'USER;obv', source_sha256: 'local-hash', pine_source: 'source', version: 2,
    }),
    readTargetPaneStudies: async () => ({
      studies: [{
        type: 'strategy', definition_id: 'USER;obv', script_id: 'USER;obv',
        entity_id: 'entity-1', version: 2,
        inputs: [{ id: 'in_0', name: 'Length', type: 'integer', value: 10, constraints: { min: 1, max: 20 } }],
      }],
    }),
    mutation: async () => calls.push('mutation'),
  };
}

describe('Strategy Run dry-run orchestration', () => {
  it('builds a complete bounded reuse plan without mutation', async () => {
    const calls = [];
    const result = await dryRunStrategyAutomation({ config_path: '/tmp/run.json', _deps: successfulDeps(calls) });
    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.equal(result.strategy_sync.account_action, 'reuse');
    assert.equal(result.strategy_sync.pane_action, 'reuse');
    assert.equal(result.parameter_sets[0].runtime_validation, 'complete');
    assert.equal('inputs' in result.resources.pane_strategy.instances[0], false);
    assert.equal(result.resources.pane_strategy.instances[0].input_count, 1);
    assert.deepEqual(result.watchlist.symbol_sample.first, ['TWSE:2330', 'TWSE:2317', 'TWSE:2454']);
    assert.deepEqual(result.watchlist.symbol_sample.last, ['TWSE:2882', 'TWSE:2308', 'TWSE:2412']);
    assert.equal(JSON.stringify(result).includes('"symbols"'), false);
    assert.deepEqual(calls, ['attach-target']);
  });

  it('aggregates independent Layout, Watchlist, Account, and Parameter errors', async () => {
    const deps = successfulDeps();
    deps.resolveLayoutTarget = async () => { throw Object.assign(new Error('layout missing'), { code: 'TARGET_LAYOUT_NOT_OPEN' }); };
    deps.captureNamedWatchlistSnapshot = async () => { throw Object.assign(new Error('watchlist missing'), { code: 'WATCHLIST_NOT_FOUND' }); };
    deps.resolveSavedStrategy = async () => { throw Object.assign(new Error('duplicate'), { code: 'STRATEGY_NAME_AMBIGUOUS' }); };
    deps.checkPine = async () => ({
      compiled: true,
      input_schema: { available: true, inputs: [], input_schema_fingerprint: 'empty' },
    });
    const result = await dryRunStrategyAutomation({ config_path: '/tmp/run.json', _deps: deps });
    assert.equal(result.success, false);
    const codes = result.errors.map((error) => error.code);
    assert.ok(codes.includes('TARGET_LAYOUT_NOT_OPEN'));
    assert.ok(codes.includes('WATCHLIST_NOT_FOUND'));
    assert.ok(codes.includes('STRATEGY_NAME_AMBIGUOUS'));
    assert.ok(codes.includes('PARAMETER_SET_INPUT_NOT_FOUND'));
  });

  it('blocks unknown Pane versions and empty Runtime Input Catalogs', async () => {
    const unknownVersion = successfulDeps();
    unknownVersion.readTargetPaneStudies = async () => ({
      studies: [{
        type: 'strategy', script_id: 'USER;obv', definition_id: 'USER;obv',
        entity_id: 'entity-1', version: null, inputs: [{ id: 'in_0', name: 'Length', type: 'integer', value: 10 }],
      }],
    });
    const unknownResult = await dryRunStrategyAutomation({
      config_path: '/tmp/run.json', _deps: unknownVersion,
    });
    assert.equal(unknownResult.valid, false);
    assert.ok(unknownResult.errors.some((error) => error.code === 'PANE_STRATEGY_VERSION_UNAVAILABLE'));

    const emptyCatalog = successfulDeps();
    emptyCatalog.readTargetPaneStudies = async () => ({
      studies: [{
        type: 'strategy', script_id: 'USER;obv', definition_id: 'USER;obv',
        entity_id: 'entity-1', version: 2, inputs: [],
      }],
    });
    const emptyResult = await dryRunStrategyAutomation({
      config_path: '/tmp/run.json', _deps: emptyCatalog,
    });
    assert.equal(emptyResult.valid, false);
    assert.ok(emptyResult.errors.some((error) => error.code === 'RUNTIME_INPUT_CATALOG_EMPTY'));
  });
});

function formalPreflight(outputDirectory, { parameterSets = null } = {}) {
  const request = requested();
  request.run = { run_id: 'formal-run', description: 'formal test', generated: false };
  request.output = {
    directory: outputDirectory,
    directory_path: outputDirectory,
    run_path: join(outputDirectory, 'formal-run'),
    format: 'csv',
  };
  request.experiments.parameter_sets = parameterSets || [
    { name: 'baseline', inputs: {} },
    { name: 'fast', inputs: { Length: 5 } },
  ];
  const watchlist = {
    success: true,
    watchlist: { name: 'dev-testing-list', watchlist_id: 1 },
    snapshot: {
      complete: true,
      snapshot_id: 'sha256:watchlist',
      returned_symbol_count: 2,
    },
    symbols: ['TWSE:2330', 'TWSE:2317'],
  };
  const target = {
    target_id: 'target-1', layout_name: 'dev', layout_id: 'layout-1', saved_layout_id: 1,
    pane_index: 0, pane_id: 'pane-0', symbol: 'TWSE_DLY:2330', timeframe: '1D',
  };
  return {
    success: true,
    valid: true,
    dry_run: true,
    run: request.run,
    strategy_sync: {
      account_action: 'reuse', pane_action: 'reuse',
      local_source_sha256: 'source-hash', account_source_sha256: 'source-hash',
      account_version: '3.0', pane_version: '3.0',
    },
    resources: {},
    watchlist: { snapshot: watchlist.snapshot },
    parameter_sets: [],
    blocked: [],
    warnings: [],
    errors: [],
    _internal: {
      loaded: {
        requested: request,
        pine_source: '//@version=6\nstrategy("test")\nlength=input.int(10, "Length")',
        config_path: '/tmp/run.json',
        config_sha256: 'config-hash',
      },
      candidate: { compiled: true, input_schema: candidateSchema() },
      target,
      watchlist,
      current_schema: candidateSchema(),
    },
  };
}

function formalDeps(preflight, calls, { partial = false, parameterError = null } = {}) {
  let clock = 1800000000000;
  return {
    withChartSession: async ({ context: sessionContext }, operation) => {
      calls.sessions = (calls.sessions || 0) + 1;
      assert.equal(sessionContext.resolution, '1D');
      return operation({ context: sessionContext });
    },
    dryRunStrategyAutomation: async () => preflight,
    executeStrategySync: async (args) => {
      calls.sync.push(args.expected_plan);
      await args._deps.withChartSession({}, async () => {
        calls.innerSessions = (calls.innerSessions || 0) + 1;
      });
      return {
        success: true,
        source_sha256: 'source-hash',
        account: {
          action: args.expected_plan.account_action,
          script_id: 'USER;obv', version: '3.0', source_sha256: 'source-hash',
        },
        pane: {
          action: args.expected_plan.pane_action,
          entity_id: 'entity-1', version: '3.0',
          inputs_fingerprint: { available: true, value: 'base-inputs', count: 1 },
        },
      };
    },
    executeParameterSets: async (args, operation) => {
      if (parameterError) throw parameterError;
      await args._deps.withChartSession({}, async () => {
        calls.innerSessions = (calls.innerSessions || 0) + 1;
      });
      const experiments = [];
      for (const [index, set] of args.parameter_sets.entries()) {
        const startedAt = clock++;
        const experiment = {
          schema_version: 1,
          experiment_id: `sha256:experiment-${index}`,
          parameter_set: {
            index, name: set.name, requested_inputs: set.inputs, resolved_inputs: [],
            requested_inputs_fingerprint: `requested-${index}`,
          },
          strategy: args.identity,
          context: args.context,
          base_inputs_fingerprint: { available: true, value: 'base-inputs', count: 1 },
          inputs_fingerprint: { available: true, value: `inputs-${index}`, count: 1 },
          effective_inputs: [{ id: 'in_0', name: 'Length', value: index ? 5 : 10 }],
          started_at: startedAt,
          started_at_iso: new Date(startedAt).toISOString(),
          report: { stable_reads: 2, fresh: index > 0 },
        };
        const exported = await operation(experiment);
        experiments.push({
          success: true,
          experiment: {
            ...experiment,
            completed_at: clock++,
            completed_at_iso: new Date(clock - 1).toISOString(),
          },
          operation: exported,
          mutation: { mutated: index > 0, applied_input_count: index > 0 ? 1 : 0 },
        });
      }
      return {
        success: true,
        strategy: args.identity,
        context: args.context,
        base_inputs_fingerprint: { available: true, value: 'base-inputs', count: 1 },
        experiment_count: experiments.length,
        experiments,
        restore: { success: true, restored: true },
      };
    },
    exportStrategySnapshotIntoRun: async (args) => {
      calls.snapshots.push(args.snapshot);
      calls.namespaces.push(args.namespace);
      const manifestPath = `${args.namespace}/manifest.json`;
      const failed = partial && args.namespace.endsWith('/fast');
      const summary = {
        requested: args.snapshot.symbols.length,
        succeeded: failed ? 1 : args.snapshot.symbols.length,
        failed: failed ? 1 : 0,
        skipped: 0,
      };
      await args.transaction.replaceJson(manifestPath, {
        status: failed ? 'partial' : 'succeeded', summary,
      });
      for (const symbol of args.snapshot.symbols) {
        const directory = `${args.namespace}/symbols/${symbol.replace(':', '_')}`;
        await args.transaction.writeJson(`${directory}/report.json`, { symbol });
        await args.transaction.writeJson(`${directory}/reconciliation.json`, { success: true });
        await args.transaction.writeJson(`${directory}/trades.csv`, { format: 'csv' });
      }
      return {
        success: !failed,
        status: failed ? 'partial' : 'succeeded',
        summary,
        artifacts: { manifest: await args.transaction.artifactInfo(manifestPath) },
        chart_restore: { success: true, restored: true },
      };
    },
    now: () => clock++,
  };
}

describe('Formal Strategy Run integration', () => {
  it('publishes canonical artifacts for multiple Parameter Sets using one Snapshot', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], snapshots: [], namespaces: [] };
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json', _deps: formalDeps(preflight, calls),
    });
    assert.equal(result.success, true);
    assert.equal(result.status, 'succeeded');
    assert.equal(calls.sessions, 1);
    assert.equal(calls.innerSessions, 2);
    assert.deepEqual(calls.sync, [preflight.strategy_sync]);
    assert.equal(calls.snapshots.length, 2);
    assert.equal(calls.snapshots[0], preflight._internal.watchlist);
    assert.equal(calls.snapshots[1], preflight._internal.watchlist);
    assert.deepEqual(calls.namespaces, ['experiments/baseline', 'experiments/fast']);
    assert.equal('symbols' in result.watchlist, false);
    assert.equal('symbols' in result.experiments[0], false);

    const root = result.output.path;
    assert.equal(existsSync(join(root, 'run.json')), true);
    assert.equal(existsSync(join(root, 'watchlist.json')), true);
    for (const name of ['baseline', 'fast']) {
      assert.equal(existsSync(join(root, 'experiments', name, 'experiment.json')), true);
      assert.equal(existsSync(join(root, 'experiments', name, 'manifest.json')), true);
      assert.equal(existsSync(join(root, 'experiments', name, 'symbols', 'TWSE_2330', 'report.json')), true);
    }
    const runArtifact = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'));
    const watchlistArtifact = JSON.parse(readFileSync(join(root, 'watchlist.json'), 'utf8'));
    assert.equal(runArtifact.status, 'succeeded');
    assert.deepEqual(watchlistArtifact.symbols, ['TWSE:2330', 'TWSE:2317']);
    assert.equal(runArtifact.retry_supported, false);
    assert.equal(runArtifact.resume_supported, false);
  });

  it('publishes a bounded partial result when one Experiment has Symbol failures', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], snapshots: [], namespaces: [] };
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      _deps: formalDeps(preflight, calls, { partial: true }),
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 'partial');
    assert.equal(result.summary.experiments_partial, 1);
    assert.equal(result.summary.symbols_failed, 1);
    assert.equal(existsSync(join(result.output.path, 'run.json')), true);
  });

  it('rejects a Run ID collision before Strategy mutation', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory, {
      parameterSets: [{ name: 'baseline', inputs: {} }],
    });
    const calls = { sync: [], snapshots: [], namespaces: [] };
    const deps = formalDeps(preflight, calls);
    await runStrategyAutomation({ config_path: '/tmp/run.json', _deps: deps });
    await assert.rejects(
      runStrategyAutomation({ config_path: '/tmp/run.json', _deps: deps }),
      (error) => error.code === 'OUTPUT_ALREADY_EXISTS',
    );
    assert.equal(calls.sync.length, 1);
  });

  it('aborts staging when Parameter execution or restore fails', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], snapshots: [], namespaces: [] };
    const failure = new CoreOperationError('restore failed', {
      code: 'PARAMETER_SET_RESTORE_FAILED', phase: 'parameter_set_restore',
    });
    await assert.rejects(
      runStrategyAutomation({
        config_path: '/tmp/run.json',
        _deps: formalDeps(preflight, calls, { parameterError: failure }),
      }),
      (error) => error.code === 'PARAMETER_SET_RESTORE_FAILED',
    );
    assert.deepEqual(readdirSync(directory), []);
  });

  it('returns failed preflight diagnostics without mutation or artifacts', async () => {
    const calls = { sync: 0, transaction: 0 };
    const result = await runStrategyAutomation({
      config_path: '/tmp/missing.json',
      _deps: {
        dryRunStrategyAutomation: async () => ({
          success: false, valid: false, dry_run: true,
          errors: [{ code: 'RUN_CONFIG_INVALID', message: 'invalid' }], warnings: [],
        }),
        executeStrategySync: async () => { calls.sync += 1; },
        createArtifactSetTransaction: async () => { calls.transaction += 1; },
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.dry_run, false);
    assert.equal(result.phase, 'preflight');
    assert.equal(calls.sync, 0);
    assert.equal(calls.transaction, 0);
  });
});
