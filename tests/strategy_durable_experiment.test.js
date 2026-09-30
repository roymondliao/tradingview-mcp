import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoreOperationError } from '../src/core/errors.js';
import {
  createDurableExperimentArtifact,
  createDurableExperimentManifest,
  executeDurableStrategyExperiment,
  prepareDurableStrategyExperiment,
} from '../src/core/strategy-durable-experiment.js';
import {
  transitionExperimentState,
  transitionSymbolState,
  validateExperimentManifestV2,
} from '../src/core/strategy-run-state.js';

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function fingerprint(character) {
  return { available: true, algorithm: 'sha256', value: character.repeat(64), count: 1 };
}

function plan() {
  return {
    experiment_id: hash('a'),
    parameter_set: {
      index: 0,
      name: 'baseline',
      requested_inputs: {},
      resolved_inputs: [],
      requested_inputs_fingerprint: 'a'.repeat(64),
    },
    inputs_fingerprint: fingerprint('c'),
    effective_inputs: [{ id: 'in_1', name: 'Length', type: 'integer', value: 10 }],
  };
}

function runArtifact(symbols = ['TWSE:2330', 'TWSE:2317']) {
  const currentPlan = plan();
  return {
    schema_version: 2,
    run_id: 'run-1',
    status: 'running',
    requested: {
      run: { run_id: 'run-1' },
      output: { run_path: '/tmp/output/run-1' },
    },
    config: { path: '/tmp/config.json', sha256: 'config-hash' },
    source_sha256: 'source-hash',
    candidate_schema_fingerprint: 'candidate-schema',
    resolved: {
      target: { layout_name: 'dev', saved_layout_id: 1, pane_index: 0, pane_id: '1' },
      strategy: {
        script_id: 'USER;test', version: '1.0', source_sha256: 'source-hash',
      },
      watchlist: {
        name: 'dev-testing-list',
        snapshot_id: hash('f'),
        ordered_symbol_fingerprint: hash('e'),
        symbol_count: symbols.length,
      },
    },
    base_inputs: [{ id: 'in_1', name: 'Length', type: 'integer', value: 10 }],
    base_inputs_fingerprint: fingerprint('b'),
    planned_experiments: [currentPlan],
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {},
    experiments: [],
    error: null,
  };
}

function successResult(symbol, experimentName = 'baseline') {
  const safe = symbol.replace(':', '_u3A_');
  const root = `experiments/${experimentName}/symbols/${safe}`;
  return {
    requested_symbol: symbol,
    resolved_symbol: symbol.replace('TWSE:', 'TWSE_DLY:'),
    snapshot_id: hash('1'),
    total_trades: 1,
    batch_count: 1,
    artifacts: {
      report: { relative_path: `${root}/report.json` },
      trades: { relative_path: `${root}/trades.csv` },
      reconciliation: { relative_path: `${root}/reconciliation.json` },
    },
  };
}

function clock(start = 2000) {
  let value = start;
  return () => {
    const current = value;
    value += 1;
    return current;
  };
}

function storeHarness() {
  const calls = {
    events: [],
    experiments: [],
    manifests: [],
    cleanup: [],
    begin: [],
    commit: [],
    abort: [],
  };
  const store = {
    async createExperiment(experiment) {
      calls.events.push('experiment');
      calls.experiments.push(experiment);
    },
    async replaceManifest(manifest) {
      calls.events.push(`manifest:${manifest.status}:${manifest.summary.succeeded}`);
      calls.manifests.push(validateExperimentManifestV2(manifest));
    },
    async cleanupUncommittedSymbolArtifacts(options) {
      calls.cleanup.push(options);
      return { removed: [] };
    },
    async beginSymbolAttempt(options) {
      calls.begin.push(options);
      return {
        async commit() { calls.commit.push(options.symbol); },
        async abort() { calls.abort.push(options.symbol); },
      };
    },
  };
  return { store, calls };
}

function existingArtifacts(symbols) {
  const run = runArtifact(symbols);
  const experiment = createDurableExperimentArtifact({
    run,
    experiment_plan: plan(),
    started_at: 1000,
  });
  const manifest = createDurableExperimentManifest({
    run,
    experiment,
    requested_symbols: symbols,
    timeframe: '1D',
    format: 'csv',
  });
  return { run, experiment, manifest };
}

function executeOptions({
  symbols,
  harness,
  existing,
  execute,
  selected,
  onTerminal,
} = {}) {
  const now = clock();
  const run = existing?.run || runArtifact(symbols);
  return {
    store: harness.store,
    run,
    experiment_plan: plan(),
    experiment: existing?.experiment,
    manifest: existing?.manifest,
    requested_symbols: symbols,
    selected_indices: selected,
    context: { target_id: 'target-1', pane_index: 0, symbol: 'TWSE:2330', resolution: '1D' },
    timeframe: '1D',
    format: 'csv',
    ownership_confirmed: true,
    on_symbol_terminal: onTerminal,
    execute_symbol_attempt: execute,
    _deps: {
      now,
      retry: { now, delay: async () => {} },
    },
  };
}

describe('Durable Strategy Experiment artifacts', () => {
  it('creates immutable experiment.json and running manifest v2 without completed_at', () => {
    const symbols = ['TWSE:2330', 'TWSE:2317'];
    const { run, experiment, manifest } = existingArtifacts(symbols);
    assert.equal(experiment.schema_version, 2);
    assert.equal(experiment.experiment_id, run.planned_experiments[0].experiment_id);
    assert.equal('completed_at' in experiment, false);
    assert.equal(manifest.status, 'running');
    assert.equal(manifest.summary.pending, 2);
    assert.deepEqual(manifest.symbols, []);
  });

  it('rejects an Experiment plan not persisted in run.json', () => {
    const run = runArtifact();
    assert.throws(
      () => createDurableExperimentArtifact({
        run,
        experiment_plan: { ...plan(), experiment_id: hash('9') },
      }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });
});

describe('Durable Strategy Experiment execution', () => {
  it('supports a separate pre-mutation persistence phase', async () => {
    const symbols = ['TWSE:2330'];
    const harness = storeHarness();
    const now = clock();
    const prepared = await prepareDurableStrategyExperiment({
      store: harness.store,
      run: runArtifact(symbols),
      experiment_plan: plan(),
      requested_symbols: symbols,
      timeframe: '1D',
      format: 'csv',
      _deps: { now },
    });
    harness.calls.events.push('parameter-mutation');
    const result = await executeDurableStrategyExperiment({
      store: harness.store,
      prepared_experiment: prepared,
      context: { target_id: 'target-1', pane_index: 0, resolution: '1D' },
      ownership_confirmed: true,
      execute_symbol_attempt: async ({ symbol }) => successResult(symbol),
      _deps: { now, retry: { now, delay: async () => {} } },
    });
    assert.equal(result.success, true);
    assert.deepEqual(harness.calls.events.slice(0, 3), [
      'experiment', 'manifest:running:0', 'parameter-mutation',
    ]);
    assert.equal(harness.calls.experiments.length, 1);
  });

  it('persists Experiment and initial manifest before executing a missing manifest in full', async () => {
    const symbols = ['TWSE:2330', 'TWSE:2317'];
    const harness = storeHarness();
    const executed = [];
    const result = await executeDurableStrategyExperiment(executeOptions({
      symbols,
      harness,
      execute: async ({ symbol }) => {
        executed.push(symbol);
        harness.calls.events.push(`execute:${symbol}`);
        return successResult(symbol);
      },
    }));
    assert.equal(result.success, true);
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(executed, symbols);
    assert.deepEqual(harness.calls.events.slice(0, 3), [
      'experiment',
      'manifest:running:0',
      'manifest:running:0',
    ]);
    assert.ok(harness.calls.events.indexOf('experiment') < harness.calls.events.indexOf('execute:TWSE:2330'));
    assert.equal(result.manifest.summary.succeeded, 2);
    assert.equal(harness.calls.commit.length, 2);
  });

  it('executes an ordered mixed-state selection but never reruns succeeded Symbols', async () => {
    const symbols = ['TWSE:1', 'TWSE:2', 'TWSE:3', 'TWSE:4', 'TWSE:5'];
    const existing = existingArtifacts(symbols);
    let manifest = existing.manifest;
    let timestamp = 1100;
    const states = ['succeeded', 'failed', 'running', 'retry_wait', 'skipped'];
    for (const [index, status] of states.entries()) {
      manifest = transitionSymbolState(manifest, {
        index,
        status: status === 'skipped' ? 'skipped' : 'running',
        updated_at: timestamp,
      });
      timestamp += 1;
      if (['failed', 'retry_wait'].includes(status)) {
        manifest = transitionSymbolState(manifest, {
          index,
          status,
          updated_at: timestamp,
          error: { code: 'SYMBOL_SWITCH_FAILED', phase: 'test', message: 'retry me' },
        });
        timestamp += 1;
      }
      if (status === 'succeeded') {
        manifest = transitionSymbolState(manifest, {
          index,
          status: 'succeeded',
          updated_at: timestamp,
          details: {
            resolved_symbol: symbols[index],
            snapshot_id: hash('1'),
            total_trades: 1,
            batch_count: 1,
            artifacts: Object.fromEntries(Object.entries(successResult(symbols[index]).artifacts)
              .map(([name, info]) => [name, info.relative_path])),
          },
        });
        timestamp += 1;
      }
    }
    existing.manifest = transitionExperimentState(manifest, {
      status: 'failed', updated_at: timestamp, error: new Error('incomplete'),
    });
    const harness = storeHarness();
    const executed = [];
    const selected = [4, 0, 3, 1, 2];
    const result = await executeDurableStrategyExperiment(executeOptions({
      symbols,
      harness,
      existing,
      selected,
      execute: async ({ symbol }) => {
        executed.push(symbol);
        return successResult(symbol);
      },
    }));
    assert.deepEqual(executed, ['TWSE:5', 'TWSE:4', 'TWSE:2', 'TWSE:3']);
    assert.equal(result.selected_count, 4);
    assert.equal(result.status, 'succeeded');
    assert.equal(harness.calls.experiments.length, 0);
  });

  it('continues after retry exhaustion and leaves the Experiment failed', async () => {
    const symbols = ['TWSE:2330', 'TWSE:2317'];
    const harness = storeHarness();
    const counts = new Map();
    const result = await executeDurableStrategyExperiment(executeOptions({
      symbols,
      harness,
      execute: async ({ symbol }) => {
        counts.set(symbol, (counts.get(symbol) || 0) + 1);
        if (symbol === symbols[0]) {
          throw new CoreOperationError('temporary failure', {
            code: 'SYMBOL_SWITCH_FAILED', phase: 'test',
          });
        }
        return successResult(symbol);
      },
    }));
    assert.equal(result.success, false);
    assert.equal(result.status, 'failed');
    assert.equal(counts.get(symbols[0]), 3);
    assert.equal(counts.get(symbols[1]), 1);
    assert.equal(result.manifest.summary.failed, 1);
    assert.equal(result.manifest.summary.succeeded, 1);
  });

  it('emits one post-persist terminal event per selected Symbol across retries', async () => {
    const symbols = ['TWSE:2330', 'TWSE:2317'];
    const harness = storeHarness();
    const attempts = new Map();
    const terminal = [];
    const result = await executeDurableStrategyExperiment(executeOptions({
      symbols,
      harness,
      onTerminal: async (event) => {
        const persisted = harness.calls.manifests.at(-1).symbols.find(
          (entry) => entry.index === event.index,
        );
        assert.equal(persisted.status, event.status);
        terminal.push(event);
      },
      execute: async ({ symbol }) => {
        const count = (attempts.get(symbol) || 0) + 1;
        attempts.set(symbol, count);
        if (symbol === symbols[0] && count < 3) {
          throw new CoreOperationError('temporary failure', {
            code: 'SYMBOL_SWITCH_FAILED', phase: 'test',
          });
        }
        return successResult(symbol);
      },
    }));
    assert.equal(result.success, true);
    assert.deepEqual(terminal, [
      { index: 0, status: 'succeeded' },
      { index: 1, status: 'succeeded' },
    ]);
    assert.equal(attempts.get(symbols[0]), 3);
  });

  it('does not emit terminal progress when its manifest transition is not persisted', async () => {
    const symbols = ['TWSE:2330'];
    const harness = storeHarness();
    const replaceManifest = harness.store.replaceManifest;
    harness.store.replaceManifest = async (manifest) => {
      if (manifest.symbols.some((entry) => entry.status === 'succeeded')) {
        throw new CoreOperationError('manifest disk full', {
          code: 'OUTPUT_WRITE_FAILED', phase: 'manifest_transition',
        });
      }
      return replaceManifest(manifest);
    };
    const terminal = [];
    await assert.rejects(executeDurableStrategyExperiment(executeOptions({
      symbols,
      harness,
      onTerminal: async (event) => { terminal.push(event); },
      execute: async ({ symbol }) => successResult(symbol),
    })), (error) => error.code === 'OUTPUT_WRITE_FAILED');
    assert.deepEqual(terminal, []);
  });

  it('isolates terminal progress callback failures from durable execution', async () => {
    const symbols = ['TWSE:2330'];
    const harness = storeHarness();
    const result = await executeDurableStrategyExperiment(executeOptions({
      symbols,
      harness,
      onTerminal: async () => { throw new Error('renderer failed'); },
      execute: async ({ symbol }) => successResult(symbol),
    }));
    assert.equal(result.success, true);
    assert.equal(result.manifest.summary.succeeded, 1);
  });

  it('marks the Experiment failed and stops new Symbols on a fatal error', async () => {
    const symbols = ['TWSE:2330', 'TWSE:2317'];
    const harness = storeHarness();
    const executed = [];
    const terminal = [];
    await assert.rejects(
      executeDurableStrategyExperiment(executeOptions({
        symbols,
        harness,
        onTerminal: async (event) => { terminal.push(event); },
        execute: async ({ symbol }) => {
          executed.push(symbol);
          throw new CoreOperationError('connection lost', {
            code: 'CDP_CONNECTION_FAILED', phase: 'cdp',
          });
        },
      })),
      (error) => error.code === 'CDP_CONNECTION_FAILED',
    );
    assert.deepEqual(executed, ['TWSE:2330']);
    const final = harness.calls.manifests.at(-1);
    assert.equal(final.status, 'failed');
    assert.equal(final.summary.failed, 1);
    assert.equal(final.summary.pending, 1);
    assert.deepEqual(terminal, [{ index: 0, status: 'failed' }]);
  });
});
