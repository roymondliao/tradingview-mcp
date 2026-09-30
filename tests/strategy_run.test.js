import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dryRunStrategyAutomation, runStrategyAutomation } from '../src/core/strategy-run.js';
import {
  createParameterSetExecutionPlan,
  persistableParameterSetPlan,
} from '../src/core/strategy-parameter-sets.js';
import { createDurableRunStore } from '../src/core/strategy-run-artifacts.js';
import {
  loadStrategyResume,
  resumeStrategyAutomation,
} from '../src/core/strategy-resume.js';
import { CoreOperationError } from '../src/core/errors.js';
import { sha256Hex } from '../src/core/stable-json.js';

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
    assert.deepEqual(result.symbol_validation, {
      performed: false, reason: 'formal_run_only',
    });
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
  request.strategy.source_sha256 = 'source-hash';
  request.experiments.parameter_sets = parameterSets || [
    { name: 'baseline', inputs: {} },
    { name: 'fast', inputs: { Length: 5 } },
  ];
  const symbols = ['TWSE:2330', 'TWSE:2317'];
  const orderedFingerprint = `sha256:${sha256Hex(symbols)}`;
  const snapshotId = `sha256:${sha256Hex({
    watchlist_id: '1',
    name: 'dev-testing-list',
    modified: '2026-09-29T00:00:00Z',
    symbols,
  })}`;
  const watchlist = {
    success: true,
    watchlist: {
      name: 'dev-testing-list', watchlist_id: 1,
      modified: '2026-09-29T00:00:00Z', active: false,
    },
    snapshot: {
      complete: true,
      snapshot_id: snapshotId,
      ordered_symbol_fingerprint: orderedFingerprint,
      declared_symbol_count: symbols.length,
      returned_symbol_count: symbols.length,
      unique_symbol_count: symbols.length,
    },
    symbols,
  };
  const target = {
    tab_index: 0, target_id: 'target-1', url_chart_id: 'url-1',
    layout_name: 'dev', layout_id: 'layout-1', saved_layout_id: 1,
    pane_layout: 's', pane_index: 0, pane_id: 'pane-0',
    symbol: 'TWSE_DLY:2330', timeframe: '1D',
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

function baseInputs() {
  return [{
    id: 'in_0', name: 'Length', name_selectable: true,
    type: 'integer', value: 10, default_value: 10,
    constraints: { min: 1, max: 20 },
  }];
}

function preparedPlan(preflight, identity) {
  const plan = createParameterSetExecutionPlan({
    base_catalog: baseInputs(),
    candidate_schema: preflight._internal.candidate.input_schema,
    parameter_sets: preflight._internal.loaded.requested.experiments.parameter_sets,
    identity,
  });
  return Object.freeze({
    ...plan,
    planned_experiments: Object.freeze(plan.parameter_sets.map(persistableParameterSetPlan)),
    context: preflight._internal.target,
  });
}

async function closeTradeArtifact(attempt) {
  const writable = await attempt.openArtifact('trades.csv');
  await new Promise((resolveWrite, rejectWrite) => {
    writable.once('error', rejectWrite);
    writable.once('close', resolveWrite);
    writable.end('trade\n');
  });
}

function formalDeps(preflight, calls, {
  failedSymbol = null,
  fatalSymbol = null,
  parameterError = null,
  syncError = null,
  onAttempt = null,
  symbolValidation = null,
} = {}) {
  let clock = 1800000000000;
  const now = () => clock++;
  const identity = Object.freeze({
    script_id: 'USER;obv', version: '3.0', source_sha256: 'source-hash', entity_id: 'entity-1',
  });
  const prepared = preparedPlan(preflight, identity);
  return {
    now,
    acquireLeases: async () => {
      calls.events.push('leases-acquired');
      return { async release() { calls.events.push('leases-released'); } };
    },
    assertPaneContext: async () => {
      calls.events.push('pane-rechecked');
      return { symbol: 'TWSE_DLY:2330', resolution: '1D' };
    },
    createDurableRunStore: async (options) => {
      calls.events.push('store-created');
      return createDurableRunStore(options);
    },
    withChartSession: async ({ context: sessionContext }, operation) => {
      calls.sessions = (calls.sessions || 0) + 1;
      assert.equal(sessionContext.resolution, '1D');
      return operation({ context: sessionContext });
    },
    dryRunStrategyAutomation: async () => preflight,
    validateNamedWatchlistSymbols: async ({ snapshot, timeframe }) => {
      calls.events.push('watchlist-validated');
      const artifact = JSON.parse(readFileSync(
        join(preflight._internal.loaded.requested.output.run_path, 'watchlist.json'),
        'utf8',
      ));
      assert.equal(artifact.symbol_validation.performed, false);
      return symbolValidation || {
        schema_version: 1,
        performed: true,
        success: true,
        source: 'tradingview_desktop_cdp',
        timeframe,
        requested: snapshot.symbols.length,
        valid: snapshot.symbols.length,
        failed: 0,
        max_attempts: 3,
        attempt_timeout_ms: 1000,
        validated_at: now(),
        validated_at_iso: '2027-01-15T08:00:00.000Z',
        errors: [],
      };
    },
    executeStrategySync: async (args) => {
      calls.events.push('strategy-sync');
      assert.equal(existsSync(join(preflight._internal.loaded.requested.output.run_path, 'run.json')), true);
      assert.equal(existsSync(join(preflight._internal.loaded.requested.output.run_path, 'watchlist.json')), true);
      if (syncError) throw syncError;
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
    prepareParameterSetExecution: async () => prepared,
    execution: {
      retry: { now, delay: async () => {} },
      executeSelectedParameterSets: async (args, operation) => {
        if (parameterError) throw parameterError;
        const experiments = [];
        for (const index of args.selected_indices) {
          const plan = args.prepared.parameter_sets[index];
          await args.before_experiment(plan);
          const output = await operation({
            parameter_set: {
              index, name: plan.name,
              requested_inputs: plan.requested_inputs,
            },
          });
          experiments.push({ operation: output });
        }
        return {
          success: true,
          experiment_count: experiments.length,
          experiments,
          restore: { success: true, restored: true },
        };
      },
      executeSymbolAttempt: async ({ attempt, symbol, experiment }) => {
        const key = `${experiment.parameter_set.name}:${symbol}`;
        calls.attempts.push(key);
        if (onAttempt) await onAttempt({ key, symbol, experiment });
        if (fatalSymbol === key) {
          throw new CoreOperationError('CDP disconnected', {
            code: 'CDP_CONNECTION_FAILED', phase: 'cdp',
          });
        }
        if (failedSymbol === key) {
          throw new CoreOperationError('temporary switch failure', {
            code: 'SYMBOL_SWITCH_FAILED', phase: 'symbol_switch',
          });
        }
        await attempt.writeJson('report.json', { symbol });
        await closeTradeArtifact(attempt);
        await attempt.writeJson('reconciliation.json', { success: true });
        const [report, trades, reconciliation] = await Promise.all([
          attempt.artifactInfo('report.json'),
          attempt.artifactInfo('trades.csv'),
          attempt.artifactInfo('reconciliation.json'),
        ]);
        return {
          resolved_symbol: symbol.replace('TWSE:', 'TWSE_DLY:'),
          snapshot_id: `sha256:${'1'.repeat(64)}`,
          total_trades: 1,
          batch_count: 1,
          artifacts: { report, trades, reconciliation },
        };
      },
    },
  };
}

describe('Formal Strategy Run integration', () => {
  it('creates canonical durable artifacts before mutation and succeeds across Experiments', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], attempts: [], events: [] };
    const progress = [];
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      on_progress: async (event) => { progress.push(event); },
      _deps: formalDeps(preflight, calls),
    });
    assert.equal(result.success, true, JSON.stringify(result, null, 2));
    assert.equal(result.status, 'succeeded');
    assert.equal(result.durable, true);
    assert.equal(result.output.atomic, false);
    assert.equal(result.output.atomic_scope, 'state_file_and_symbol_directory');
    assert.equal(result.retry_supported, true);
    assert.equal(result.resume_supported, true);
    assert.equal(calls.sessions, 1);
    assert.equal(calls.innerSessions, 1);
    assert.deepEqual(calls.sync, [preflight.strategy_sync]);
    assert.deepEqual(calls.events.slice(0, 5), [
      'leases-acquired', 'pane-rechecked', 'store-created', 'watchlist-validated', 'strategy-sync',
    ]);
    assert.equal(calls.events.at(-1), 'leases-released');
    assert.equal(calls.attempts.length, 4);
    assert.equal('symbols' in result.watchlist, false);
    assert.equal('symbols' in result.experiments[0], false);
    assert.equal(JSON.stringify(result).includes('"symbols":'), false);
    assert.equal(JSON.stringify(result).includes('"trades":'), false);

    const root = result.output.path;
    assert.deepEqual(readdirSync(directory), ['formal-run']);
    assert.equal(existsSync(join(root, 'run.json')), true);
    assert.equal(existsSync(join(root, 'watchlist.json')), true);
    for (const name of ['baseline', 'fast']) {
      assert.equal(existsSync(join(root, 'experiments', name, 'experiment.json')), true);
      assert.equal(existsSync(join(root, 'experiments', name, 'manifest.json')), true);
      assert.equal(existsSync(join(root, 'experiments', name, 'symbols', 'TWSE_u3A_2330', 'report.json')), true);
    }
    const runArtifact = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'));
    const watchlistArtifact = JSON.parse(readFileSync(join(root, 'watchlist.json'), 'utf8'));
    assert.equal(runArtifact.status, 'succeeded');
    assert.equal(runArtifact.schema_version, 2);
    assert.equal('completed_at' in runArtifact, false);
    assert.deepEqual(watchlistArtifact.symbols, ['TWSE:2330', 'TWSE:2317']);
    assert.equal(watchlistArtifact.symbol_validation.success, true);
    assert.equal(result.watchlist.symbol_validation.success, true);
    assert.deepEqual(progress.map((event) => ({
      processed: event.processed,
      total: event.total,
      succeeded: event.succeeded,
      failed: event.failed,
      experiment: `${event.experiment.index}/${event.experiment.count}:${event.experiment.name}`,
    })), [
      { processed: 0, total: 4, succeeded: 0, failed: 0, experiment: '1/2:baseline' },
      { processed: 1, total: 4, succeeded: 1, failed: 0, experiment: '1/2:baseline' },
      { processed: 2, total: 4, succeeded: 2, failed: 0, experiment: '1/2:baseline' },
      { processed: 2, total: 4, succeeded: 2, failed: 0, experiment: '2/2:fast' },
      { processed: 3, total: 4, succeeded: 3, failed: 0, experiment: '2/2:fast' },
      { processed: 4, total: 4, succeeded: 4, failed: 0, experiment: '2/2:fast' },
    ]);
  });

  it('marks retry exhaustion failed but continues remaining Symbols and Experiments', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], attempts: [], events: [] };
    const progress = [];
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      on_progress: async (event) => { progress.push(event); },
      _deps: formalDeps(preflight, calls, { failedSymbol: 'baseline:TWSE:2330' }),
    });
    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.summary.experiments_failed, 1);
    assert.equal(result.summary.symbols_failed, 1);
    assert.equal(calls.attempts.filter((item) => item === 'baseline:TWSE:2330').length, 3);
    assert.ok(calls.attempts.includes('fast:TWSE:2317'));
    assert.equal(existsSync(join(result.output.path, 'run.json')), true);
    assert.deepEqual(progress.at(-1), {
      processed: 4,
      total: 4,
      succeeded: 3,
      failed: 1,
      experiment: { index: 2, count: 2, name: 'fast' },
    });
    assert.deepEqual(progress.map((event) => event.processed), [0, 1, 2, 2, 3, 4]);
  });

  it('persists invalid Watchlist evidence and blocks Strategy mutation', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], attempts: [], events: [] };
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      _deps: formalDeps(preflight, calls, {
        symbolValidation: {
          schema_version: 1,
          performed: true,
          success: false,
          source: 'tradingview_desktop_cdp',
          timeframe: '1D',
          requested: 2,
          valid: 1,
          failed: 1,
          max_attempts: 3,
          attempt_timeout_ms: 1000,
          validated_at: 1800000000000,
          validated_at_iso: '2027-01-15T08:00:00.000Z',
          errors: [{
            index: 1,
            symbol: 'TWSE:2317',
            code: 'WATCHLIST_SYMBOL_NOT_FOUND',
            phase: 'watchlist_symbol_validation',
            attempt_count: 1,
            message: 'TradingView reports that TWSE:2317 does not exist.',
          }],
        },
      }),
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'WATCHLIST_SYMBOL_VALIDATION_FAILED');
    assert.equal(result.watchlist.symbol_validation.failed, 1);
    assert.deepEqual(calls.sync, []);
    assert.deepEqual(calls.attempts, []);
    const watchlist = JSON.parse(readFileSync(join(result.output.path, 'watchlist.json'), 'utf8'));
    assert.equal(watchlist.symbol_validation.errors[0].symbol, 'TWSE:2317');
  });

  it('rejects a Run ID collision before Strategy mutation', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory, {
      parameterSets: [{ name: 'baseline', inputs: {} }],
    });
    const calls = { sync: [], attempts: [], events: [] };
    const deps = formalDeps(preflight, calls);
    await runStrategyAutomation({ config_path: '/tmp/run.json', _deps: deps });
    await assert.rejects(
      runStrategyAutomation({ config_path: '/tmp/run.json', _deps: deps }),
      (error) => error.code === 'RUN_OUTPUT_EXISTS',
    );
    assert.equal(calls.sync.length, 1);
  });

  it('keeps initialized durable state when Parameter execution or restore fails', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], attempts: [], events: [] };
    const failure = new CoreOperationError('restore failed', {
      code: 'PARAMETER_SET_RESTORE_FAILED', phase: 'parameter_set_restore',
    });
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      _deps: formalDeps(preflight, calls, { parameterError: failure }),
    });
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'PARAMETER_SET_RESTORE_FAILED');
    assert.equal(existsSync(join(directory, 'formal-run', 'run.json')), true);
    assert.equal(JSON.parse(readFileSync(join(directory, 'formal-run', 'run.json'))).status, 'failed');
  });

  it('stops later Symbols on fatal errors and maps CDP failures', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory);
    const calls = { sync: [], attempts: [], events: [] };
    const progress = [];
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      on_progress: async (event) => { progress.push(event); },
      _deps: formalDeps(preflight, calls, { fatalSymbol: 'baseline:TWSE:2330' }),
    });
    assert.equal(result.success, false);
    assert.equal(result.failure_kind, 'cdp_connection');
    assert.deepEqual(calls.attempts, ['baseline:TWSE:2330']);
    assert.deepEqual(progress.at(-1), {
      processed: 1,
      total: 4,
      succeeded: 0,
      failed: 1,
      experiment: { index: 1, count: 2, name: 'baseline' },
    });
  });

  it('resumes the same Run and executes only the previously failed Symbol', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory, {
      parameterSets: [{ name: 'baseline', inputs: {} }],
    });
    const initialCalls = { sync: [], attempts: [], events: [] };
    const initial = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      _deps: formalDeps(preflight, initialCalls, { failedSymbol: 'baseline:TWSE:2330' }),
    });
    assert.equal(initial.status, 'failed');
    const watchlistPath = join(initial.output.path, 'watchlist.json');
    const pendingWatchlist = JSON.parse(readFileSync(watchlistPath, 'utf8'));
    pendingWatchlist.symbol_validation = {
      schema_version: 1, performed: false, reason: 'pending', timeframe: '1D',
    };
    writeFileSync(watchlistPath, `${JSON.stringify(pendingWatchlist, null, 2)}\n`);
    const local = await loadStrategyResume({ run_directory: initial.output.path });
    assert.deepEqual(local.plan.experiments[0].selected_indices, [0]);

    const resumeCalls = { sync: [], attempts: [], events: [] };
    const resumeDeps = formalDeps(preflight, resumeCalls);
    const progress = [];
    const identity = {
      target: { ...preflight._internal.target, resolution: '1D' },
      strategy: local.artifacts.run.resolved.strategy,
    };
    const resumed = await resumeStrategyAutomation({
      run_directory: initial.output.path,
      on_progress: async (event) => { progress.push(event); },
      _deps: {
        withStrategyResumeContext: async (_options, operation) => operation({ local, identity }),
        withChartSession: resumeDeps.withChartSession,
        validateNamedWatchlistSymbols: resumeDeps.validateNamedWatchlistSymbols,
        execution: resumeDeps.execution,
        now: resumeDeps.now,
      },
    });
    assert.equal(resumed.success, true, JSON.stringify(resumed, null, 2));
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.run_id, initial.run_id);
    assert.deepEqual(resumeCalls.attempts, ['baseline:TWSE:2330']);
    assert.ok(resumeCalls.events.includes('watchlist-validated'));
    assert.equal(resumed.watchlist.symbol_validation.success, true);
    assert.deepEqual(progress, [
      {
        processed: 0, total: 1, succeeded: 0, failed: 0,
        experiment: { index: 1, count: 1, name: 'baseline' },
      },
      {
        processed: 1, total: 1, succeeded: 1, failed: 0,
        experiment: { index: 1, count: 1, name: 'baseline' },
      },
    ]);
  });

  it('keeps original Experiment identity when Resume selects only Experiment 2 of 3', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory, {
      parameterSets: [
        { name: 'baseline', inputs: {} },
        { name: 'candidate-check', inputs: { Length: 5 } },
        { name: 'rsi-check', inputs: { Length: 6 } },
      ],
    });
    const initialCalls = { sync: [], attempts: [], events: [] };
    const initial = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      _deps: formalDeps(preflight, initialCalls, {
        failedSymbol: 'candidate-check:TWSE:2330',
      }),
    });
    assert.equal(initial.status, 'failed');
    const local = await loadStrategyResume({ run_directory: initial.output.path });
    assert.deepEqual(local.plan.experiments.map((item) => item.selected_indices), [[], [0], []]);

    const resumeCalls = { sync: [], attempts: [], events: [] };
    const resumeDeps = formalDeps(preflight, resumeCalls);
    const progress = [];
    const resumed = await resumeStrategyAutomation({
      run_directory: initial.output.path,
      on_progress: async (event) => { progress.push(event); },
      _deps: {
        withStrategyResumeContext: async (_options, operation) => operation({
          local,
          identity: {
            target: { ...preflight._internal.target, resolution: '1D' },
            strategy: local.artifacts.run.resolved.strategy,
          },
        }),
        withChartSession: resumeDeps.withChartSession,
        execution: resumeDeps.execution,
        now: resumeDeps.now,
      },
    });
    assert.equal(resumed.success, true, JSON.stringify(resumed, null, 2));
    assert.deepEqual(resumeCalls.attempts, ['candidate-check:TWSE:2330']);
    assert.deepEqual(progress, [
      {
        processed: 0, total: 1, succeeded: 0, failed: 0,
        experiment: { index: 2, count: 3, name: 'candidate-check' },
      },
      {
        processed: 1, total: 1, succeeded: 1, failed: 0,
        experiment: { index: 2, count: 3, name: 'candidate-check' },
      },
    ]);
  });

  it('completes setup idempotently when the first invocation failed during Strategy sync', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory, {
      parameterSets: [{ name: 'baseline', inputs: {} }],
    });
    const initialCalls = { sync: [], attempts: [], events: [] };
    const initial = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      _deps: formalDeps(preflight, initialCalls, {
        syncError: new CoreOperationError('sync interrupted', {
          code: 'STRATEGY_SYNC_FAILED', phase: 'strategy_sync',
        }),
      }),
    });
    assert.equal(initial.status, 'failed');
    const local = await loadStrategyResume({ run_directory: initial.output.path });
    assert.equal(local.plan.setup_required, true);

    const resumeCalls = { sync: [], attempts: [], events: [] };
    const resumeDeps = formalDeps(preflight, resumeCalls);
    const setupIdentity = {
      target: { ...preflight._internal.target, resolution: '1D' },
      pine: { source: preflight._internal.loaded.pine_source },
      candidate_schema: preflight._internal.candidate.input_schema,
      current_schema: preflight._internal.current_schema,
      strategy_sync: preflight.strategy_sync,
    };
    const resumed = await resumeStrategyAutomation({
      run_directory: initial.output.path,
      _deps: {
        withStrategyResumeContext: async (_options, operation) => operation({
          local, identity: setupIdentity,
        }),
        executeStrategySync: resumeDeps.executeStrategySync,
        prepareParameterSetExecution: resumeDeps.prepareParameterSetExecution,
        withChartSession: resumeDeps.withChartSession,
        execution: resumeDeps.execution,
        now: resumeDeps.now,
      },
    });
    assert.equal(resumed.success, true, JSON.stringify(resumed, null, 2));
    assert.equal(resumed.run_id, initial.run_id);
    assert.equal(resumeCalls.attempts.length, 2);
  });

  it('persists RUN_INTERRUPTED after initialization and returns the signal exit code', async () => {
    const directory = temporaryDirectory();
    const preflight = formalPreflight(directory, {
      parameterSets: [{ name: 'baseline', inputs: {} }],
    });
    const calls = { sync: [], attempts: [], events: [] };
    const controller = new AbortController();
    const reason = new CoreOperationError('SIGINT', { code: 'RUN_INTERRUPTED', phase: 'signal' });
    reason.exit_code = 130;
    reason.signal = 'SIGINT';
    let aborted = false;
    const result = await runStrategyAutomation({
      config_path: '/tmp/run.json',
      signal: controller.signal,
      _deps: formalDeps(preflight, calls, {
        onAttempt: async () => {
          if (!aborted) {
            aborted = true;
            controller.abort(reason);
          }
        },
      }),
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'RUN_INTERRUPTED');
    assert.equal(result.exit_code, 130);
    assert.equal(calls.events.at(-1), 'leases-released');
  });

  it('returns failed preflight diagnostics without mutation or artifacts', async () => {
    const calls = { sync: 0, leases: 0 };
    const result = await runStrategyAutomation({
      config_path: '/tmp/missing.json',
      _deps: {
        dryRunStrategyAutomation: async () => ({
          success: false, valid: false, dry_run: true,
          errors: [{ code: 'RUN_CONFIG_INVALID', message: 'invalid' }], warnings: [],
        }),
        executeStrategySync: async () => { calls.sync += 1; },
        acquireLeases: async () => { calls.leases += 1; },
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.dry_run, false);
    assert.equal(result.phase, 'preflight');
    assert.equal(calls.sync, 0);
    assert.equal(calls.leases, 0);
  });
});
