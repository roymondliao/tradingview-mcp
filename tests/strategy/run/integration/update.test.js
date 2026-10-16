import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createResumeFixture } from '../support/resume-fixture.js';
import { loadStrategyResume, resumeStrategyAutomation } from '../../../../src/core/strategy-resume.js';
import { dryRunStrategyUpdate, updateStrategyAutomation } from '../../../../src/core/strategy-update.js';
import { extendStrategyAutomation } from '../../../../src/core/strategy-extend.js';
import { loadStrategyRunLineage } from '../../../../src/core/strategy-run-lineage.js';
import { effectiveInputsFingerprint } from '../../../../src/core/strategy-parameter-sets.js';
import { validateRunArtifactV5 } from '../../../../src/core/strategy-run-state.js';
import { CoreOperationError } from '../../../../src/core/errors.js';
import { WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS, WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS } from '../../../../src/core/watchlist.js';
import { CdpOperationError } from '../../../../src/connection.js';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function executeSelectedParameterSets({ prepared, selected_indices, before_experiment }, operation) {
  const results = [];
  for (const index of selected_indices) {
    const parameterSet = prepared.parameter_sets[index];
    await before_experiment(parameterSet);
    results.push(await operation({ parameter_set: parameterSet }));
  }
  return { results };
}

async function executeSymbolAttempt({ attempt, symbol }) {
  await attempt.writeJson('report.json', { symbol, refreshed: true });
  const stream = await attempt.openArtifact('trades.csv');
  await new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.once('close', resolve);
    stream.end('fresh-trades\n');
  });
  await attempt.writeJson('reconciliation.json', { success: true });
  const [report, trades, reconciliation] = await Promise.all([
    attempt.artifactInfo('report.json'), attempt.artifactInfo('trades.csv'), attempt.artifactInfo('reconciliation.json'),
  ]);
  return {
    resolved_symbol: symbol, snapshot_id: `sha256:${'5'.repeat(64)}`,
    total_trades: 1, batch_count: 1, artifacts: { report, trades, reconciliation },
  };
}

function runtimeDeps(fixture, overrides = {}) {
  return {
    now: () => 1790812800000,
    resolveStrategyResumeIdentity: async () => ({
      candidate_schema: fixture.candidate,
      strategy: fixture.identity,
      target: fixture.run.resolved.target,
    }),
    acquireLeases: async () => ({ release: async () => {} }),
    withChartSession: async (_options, operation) => operation(),
    validateNamedWatchlistSymbols: async ({ snapshot }) => ({
      schema_version: 1, source: 'tradingview_desktop_cdp',
      max_attempts: WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS, attempt_timeout_ms: WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS, timeframe: '1D',
      validated_at: 1790812800000, validated_at_iso: '2026-10-01T00:00:00.000Z',
      performed: true, success: true, requested: snapshot.symbols.length,
      valid: snapshot.symbols.length, failed: 0, errors: [],
    }),
    execution: { executeSelectedParameterSets, executeSymbolAttempt },
    ...overrides,
  };
}

async function resume(path, fixture, overrides = {}) {
  return resumeStrategyAutomation({
    run_directory: path,
    _deps: {
      ...runtimeDeps(fixture),
      withStrategyResumeContext: async (_options, operation) => operation({
        local: await loadStrategyResume({ run_directory: path }),
        identity: { target: fixture.run.resolved.target, strategy: fixture.identity },
      }),
      ...overrides,
    },
  });
}

async function fixture({ succeeded = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tv-update-')));
  roots.push(root);
  const result = await createResumeFixture({ root });
  if (succeeded) assert.equal((await resume(result.store.run_path, result)).success, true);
  return result;
}

async function readRun(path) { return JSON.parse(await readFile(join(path, 'run.json'), 'utf8')); }
async function update(source, current, overrides = {}) {
  return updateStrategyAutomation({ run_directory: source, _deps: runtimeDeps(current, overrides) });
}

async function extend(source, current, name = 'extra') {
  const lineage = await loadStrategyRunLineage({ run_directory: source });
  const requested = lineage.parent.run.requested;
  const configPath = join(current.root, `${name}.json`);
  await writeFile(configPath, JSON.stringify({
    schema_version: 1,
    run: { run_id: name },
    strategy: { file: current.pinePath, saved_name: requested.strategy.saved_name },
    target: requested.target, backtest: requested.backtest,
    experiments: { parameter_sets: [...lineage.parameter_sets, { name, inputs: { Length: 7 } }] },
    output: { directory: current.output, format: 'csv' },
  }));
  const result = await extendStrategyAutomation({
    run_directory: source, config_path: configPath, _deps: runtimeDeps(current),
  });
  assert.equal(result.success, true, JSON.stringify(result));
  return join(current.output, name);
}

describe('Strategy Update', () => {
  it('dry-runs without Config or output writes and generates a fresh ID on every invocation', async () => {
    const current = await fixture();
    const before = await readdir(current.output);
    const options = { run_directory: current.store.run_path, _deps: runtimeDeps(current) };
    const a = await dryRunStrategyUpdate(options);
    const b = await dryRunStrategyUpdate(options);
    assert.equal(a.valid, true, JSON.stringify(a));
    assert.equal(a.update.experiments_updated, 2);
    assert.equal(a.update.symbols_per_experiment, 3);
    assert.notEqual(a.update.run_id, b.update.run_id);
    assert.match(a.update.run_id, /-update-/);
    assert.deepEqual(await readdir(current.output), before);
    assert.equal('_internal' in a, false);
  });

  it('reruns every experiment/symbol into a sibling v5 Run and keeps source files unchanged', async () => {
    const current = await fixture();
    const source = current.store.run_path;
    const before = await readFile(join(source, 'run.json'), 'utf8');
    const calls = [];
    const result = await update(source, current, {
      execution: {
        executeSelectedParameterSets,
        executeSymbolAttempt: async (options) => { calls.push(options.symbol); return executeSymbolAttempt(options); },
      },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.run_kind, 'update');
    assert.equal(result.source_run_id, 'run-1');
    assert.equal(result.experiments_updated, 2);
    assert.equal(calls.length, 6);
    const path = join(current.output, result.run_id);
    assert.equal(dirname(path), dirname(source));
    assert.notEqual(path, source);
    const run = validateRunArtifactV5(await readRun(path));
    assert.equal(run.status, 'succeeded');
    assert.equal(run.update.experiment_count, 2);
    assert.deepEqual(run.base_inputs, current.run.base_inputs);
    assert.deepEqual(run.requested.experiments, current.run.requested.experiments);
    assert.equal(await readFile(join(source, 'run.json'), 'utf8'), before);
    const lineage = await loadStrategyRunLineage({ run_directory: path });
    assert.equal(lineage.chain.length, 1);
    assert.deepEqual(lineage.parameter_sets, current.run.requested.experiments.parameter_sets);
  });

  it('updates an Extension collection, then supports repeated Update and Extend without duplicates', async () => {
    const current = await fixture();
    const extension = await extend(current.store.run_path, current);
    const first = await update(extension, current);
    assert.equal(first.success, true, JSON.stringify(first));
    assert.equal(first.experiments_updated, 3);
    const firstPath = join(current.output, first.run_id);
    // A refreshed snapshot is complete even when old provenance directories are unavailable.
    await rm(current.store.run_path, { recursive: true });
    await rm(extension, { recursive: true });
    const second = await update(firstPath, current);
    assert.equal(second.success, true, JSON.stringify(second));
    assert.equal(second.experiments_updated, 3);
    const secondPath = join(current.output, second.run_id);
    const nextExtension = await extend(secondPath, current, 'extra-again');
    assert.equal((await readRun(nextExtension)).artifact_schema_version, 5);
    const third = await update(nextExtension, current);
    assert.equal(third.success, true, JSON.stringify(third));
    assert.equal(third.experiments_updated, 4);
    const run = await readRun(join(current.output, third.run_id));
    assert.deepEqual(run.planned_experiments.map((p) => p.parameter_set.index), [0, 1, 2, 3]);
  });

  it('resumes an interrupted Update independently and skips its successful symbols', async () => {
    const current = await fixture();
    const controller = new AbortController();
    const result = await updateStrategyAutomation({
      run_directory: current.store.run_path, signal: controller.signal,
      on_progress: (progress) => {
        if (progress.succeeded === 1) controller.abort(new CoreOperationError('stop', {
          code: 'RUN_INTERRUPTED', kind: 'interrupt', phase: 'test',
        }));
      },
      _deps: runtimeDeps(current),
    });
    assert.equal(result.success, false);
    const path = join(current.output, result.run_id);
    const local = await loadStrategyResume({ run_directory: path });
    assert.equal(local.artifacts.run.run_kind, 'update');
    await rm(current.store.run_path, { recursive: true });
    let calls = 0;
    const done = await resume(path, current, {
      execution: {
        executeSelectedParameterSets,
        executeSymbolAttempt: async (options) => { calls++; return executeSymbolAttempt(options); },
      },
    });
    assert.equal(done.success, true, JSON.stringify(done));
    assert.equal(done.resumed, true);
    assert.equal(done.source_run_id, 'run-1');
    assert.equal(calls, 5);
  });

  it('keeps Update plans valid across repeated Resume after runtime entity rebinding', async () => {
    const current = await fixture();
    const interruptedRun = new AbortController();
    const stop = (controller) => controller.abort(new CoreOperationError('stop', {
      code: 'RUN_INTERRUPTED', kind: 'interrupt', phase: 'test',
    }));
    const first = await updateStrategyAutomation({
      run_directory: current.store.run_path, signal: interruptedRun.signal,
      on_progress: (progress) => { if (progress.succeeded === 1) stop(interruptedRun); },
      _deps: runtimeDeps(current),
    });
    const path = join(current.output, first.run_id);
    const original = await readRun(path);
    const interruptedResume = new AbortController();
    const rebound = { ...current.identity, entity_id: 'restarted-entity' };
    const result = await resumeStrategyAutomation({
      run_directory: path, signal: interruptedResume.signal,
      on_progress: (progress) => { if (progress.succeeded === 1) stop(interruptedResume); },
      _deps: {
        ...runtimeDeps(current),
        withStrategyResumeContext: async (_options, operation) => operation({
          local: await loadStrategyResume({ run_directory: path }),
          identity: { target: current.run.resolved.target, strategy: rebound },
        }),
        execution: {
          executeSelectedParameterSets,
          executeSymbolAttempt: async (options) => {
            assert.equal(options.identity.entity_id, 'restarted-entity');
            return executeSymbolAttempt(options);
          },
        },
      },
    });
    assert.equal(result.success, false);
    const local = await loadStrategyResume({ run_directory: path });
    assert.deepEqual(local.artifacts.run.planned_experiments, original.planned_experiments);
    const completed = await resume(path, current);
    assert.equal(completed.success, true, JSON.stringify(completed));
    const next = await dryRunStrategyUpdate({ run_directory: path, _deps: runtimeDeps(current) });
    assert.equal(next.valid, true, JSON.stringify(next));
  });

  it('accepts historical v3 and v4 source artifacts without converting the source', async () => {
    for (const version of [3, 4]) {
      const current = await fixture();
      const source = current.store.run_path;
      const files = await readdir(source, { recursive: true });
      for (const file of files.filter((file) => /(^|\/)(run|experiment|manifest)\.json$/.test(file))) {
        const path = join(source, file);
        const { schema_version, ...value } = JSON.parse(await readFile(path, 'utf8'));
        assert.equal(schema_version, 2);
        value.artifact_schema_version = version;
        if (file === 'run.json') {
          const { schema_version: configVersion, ...requested } = value.requested;
          value.requested = { config_schema_version: configVersion, ...requested };
          if (version === 4) value.run_kind = 'standalone';
        }
        await writeFile(path, JSON.stringify(value));
      }
      const result = await update(source, current);
      assert.equal(result.success, true, JSON.stringify(result));
      assert.equal((await readRun(source)).artifact_schema_version, version);
      assert.equal((await readRun(join(current.output, result.run_id))).update.source_artifact_schema_version, version);
    }
  });

  it('rejects a changed or missing persisted Pine source using the real identity resolver', async () => {
    const current = await fixture();
    const before = await readdir(current.output);
    await writeFile(current.pinePath, 'strategy("changed")');
    const changed = await dryRunStrategyUpdate({ run_directory: current.store.run_path });
    assert.equal(changed.valid, false);
    assert.equal(changed.errors[0].code, 'RUN_UPDATE_IDENTITY_MISMATCH');
    await rm(current.pinePath);
    const missing = await dryRunStrategyUpdate({ run_directory: current.store.run_path });
    assert.equal(missing.valid, false);
    assert.deepEqual(await readdir(current.output), before);
  });

  it('uses the real identity resolver for an Extension with rebound runtime IDs and ancestor inputs', async () => {
    const current = await fixture();
    const extension = await extend(current.store.run_path, current);
    const currentInputs = current.run.planned_experiments[1].effective_inputs;
    const result = await update(extension, current, {
      resolveStrategyResumeIdentity: undefined,
      identity: {
        checkPine: async () => ({
          compiled: true,
          input_schema: { ...current.candidate, source_sha256: current.sourceSha256 },
        }),
        resolveLayoutTarget: async () => ({ ...current.run.resolved.target, target_id: 'new-target' }),
        attachTarget: async () => {},
        resolveSavedStrategy: async () => ({
          saved_name: current.run.requested.strategy.saved_name, exists: true, match_count: 1,
          script: { ...current.identity, id: current.identity.script_id, type: 'strategy' },
        }),
        readResolvedSavedStrategy: async () => ({
          ...current.identity, pine_source: current.pineSource,
        }),
        readTargetPaneStudies: async () => ({
          studies: [{
            ...current.identity, entity_id: 'new-entity', type: 'strategy',
            inputs: currentInputs, inputs_fingerprint: effectiveInputsFingerprint(currentInputs),
          }],
        }),
      },
    });
    assert.equal(result.success, true, JSON.stringify(result));
    const run = await readRun(join(current.output, result.run_id));
    assert.equal(run.resolved.strategy.entity_id, 'new-entity');
    assert.equal(run.resolved.target.target_id, 'new-target');
    assert.equal(run.planned_experiments.length, 3);
    const again = await dryRunStrategyUpdate({
      run_directory: join(current.output, result.run_id), _deps: runtimeDeps(current),
    });
    assert.equal(again.valid, true, JSON.stringify(again));
  });

  it('rejects runtime rebinding between preflight and ownership without creating output', async () => {
    const current = await fixture();
    const before = await readdir(current.output);
    let reads = 0;
    let releases = 0;
    await assert.rejects(update(current.store.run_path, current, {
      resolveStrategyResumeIdentity: async () => ({
        candidate_schema: current.candidate, target: current.run.resolved.target,
        strategy: { ...current.identity, entity_id: ++reads === 1 ? 'first-entity' : 'changed-entity' },
      }),
      acquireLeases: async () => ({ release: async () => { releases++; } }),
    }), (error) => error.code === 'RUN_UPDATE_IDENTITY_MISMATCH');
    assert.equal(releases, 1);
    assert.deepEqual(await readdir(current.output), before);
  });

  it('rejects unfinished or missing sources before runtime access', async () => {
    const current = await fixture({ succeeded: false });
    let reads = 0;
    const deps = runtimeDeps(current, { resolveStrategyResumeIdentity: async () => { reads++; } });
    for (const [path, code] of [
      [current.store.run_path, 'RUN_UPDATE_SOURCE_NOT_SUCCEEDED'],
      [join(current.output, 'missing'), 'RUN_UPDATE_SOURCE_NOT_FOUND'],
    ]) {
      const result = await dryRunStrategyUpdate({ run_directory: path, _deps: deps });
      assert.equal(result.valid, false);
      assert.equal(result.errors[0].code, code);
    }
    assert.equal(reads, 0);
  });

  it('preserves infrastructure errors and translates known identity errors', async () => {
    const current = await fixture();
    for (const [error, code] of [
      [new CdpOperationError('offline', { code: 'CDP_DISCOVERY_FAILED' }), 'CDP_DISCOVERY_FAILED'],
      [new CoreOperationError('source changed', { code: 'RUN_RESUME_IDENTITY_MISMATCH', kind: 'identity' }), 'RUN_UPDATE_IDENTITY_MISMATCH'],
      [new TypeError('unexpected'), 'CORE_UNCLASSIFIED_ERROR'],
    ]) {
      const result = await dryRunStrategyUpdate({
        run_directory: current.store.run_path,
        _deps: runtimeDeps(current, { resolveStrategyResumeIdentity: async () => { throw error; } }),
      });
      assert.equal(result.valid, false);
      assert.equal(result.errors[0].code, code);
    }
  });

  it('rejects output collisions without runtime access or overwriting existing output', async () => {
    const current = await fixture();
    const deps = runtimeDeps(current, { random_suffix: '12345678' });
    assert.equal((await update(current.store.run_path, current, deps)).success, true);
    let reads = 0;
    const result = await dryRunStrategyUpdate({
      run_directory: current.store.run_path,
      _deps: { ...deps, resolveStrategyResumeIdentity: async () => { reads++; } },
    });
    assert.equal(result.errors[0].code, 'RUN_OUTPUT_EXISTS');
    assert.equal(reads, 0);
  });

  it('revalidates source evidence under ownership before creating output', async () => {
    const current = await fixture();
    const before = await readdir(current.output);
    let loads = 0;
    let releases = 0;
    await assert.rejects(update(current.store.run_path, current, {
      loadStrategyRunLineage: async (options) => {
        const lineage = await loadStrategyRunLineage(options);
        return ++loads === 1 ? lineage : { ...lineage, parent_run_fingerprint: `sha256:${'f'.repeat(64)}` };
      },
      acquireLeases: async () => ({ release: async () => { releases++; } }),
    }), (error) => error.code === 'RUN_UPDATE_LINEAGE_INVALID');
    assert.equal(releases, 1);
    assert.deepEqual(await readdir(current.output), before);
  });

  it('validates Update provenance and rejects corrupt metadata or frozen symbols', async () => {
    const current = await fixture();
    const result = await update(current.store.run_path, current);
    assert.equal(result.success, true, JSON.stringify(result));
    const run = await readRun(join(current.output, result.run_id));
    for (const patch of [
      { source_run_id: run.run_id }, { experiment_count: 9 },
      { parameter_sets_fingerprint: `sha256:${'0'.repeat(64)}` }, { source_artifact_schema_version: 99 },
    ]) {
      assert.throws(() => validateRunArtifactV5({ ...run, update: { ...run.update, ...patch } }));
    }
    assert.throws(() => validateRunArtifactV5({ ...run, run_kind: 'standalone' }));
    const watchlistPath = join(current.store.run_path, 'watchlist.json');
    const watchlist = JSON.parse(await readFile(watchlistPath, 'utf8'));
    watchlist.symbols[0] = 'TWSE:9999';
    await writeFile(watchlistPath, JSON.stringify(watchlist));
    const invalid = await dryRunStrategyUpdate({ run_directory: current.store.run_path, _deps: runtimeDeps(current) });
    assert.equal(invalid.valid, false);
    assert.equal(invalid.errors[0].code, 'RUN_UPDATE_LINEAGE_INVALID');
  });
});
