import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STRATEGY_RUN_STATE_JSON_MAX_BYTES,
  atomicReplaceJson,
  beginSymbolAttempt,
  cleanupUncommittedSymbolArtifacts,
  createDurableRunStore,
  openDurableRunStore,
  readBoundedJson,
  readDurableRunArtifacts,
  verifySucceededSymbolArtifacts,
} from '../src/core/strategy-run-artifacts.js';
import {
  STRATEGY_RUN_ARTIFACT_VERSION,
  STRATEGY_RUN_PREVIOUS_ARTIFACT_VERSION,
  STRATEGY_RUN_LEGACY_ARTIFACT_VERSION,
  transitionSymbolState,
} from '../src/core/strategy-run-state.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-durable-run-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function fingerprint(character) {
  return { available: true, algorithm: 'sha256', value: character.repeat(64), count: 1 };
}

function plannedExperiment() {
  return {
    experiment_id: hash('a'),
    parameter_set: {
      index: 0,
      name: 'baseline',
      requested_inputs: {},
      requested_inputs_fingerprint: 'a'.repeat(64),
    },
    inputs_fingerprint: fingerprint('a'),
    effective_inputs: [],
  };
}

function runArtifact({
  family = 'v3',
  runPath = '/tmp/output/run-1',
} = {}) {
  return {
    ...(family === 'v2'
      ? { schema_version: STRATEGY_RUN_LEGACY_ARTIFACT_VERSION }
      : { artifact_schema_version: family === 'v3'
        ? STRATEGY_RUN_PREVIOUS_ARTIFACT_VERSION
        : STRATEGY_RUN_ARTIFACT_VERSION }),
    run_id: 'run-1',
    status: 'running',
    requested: {
      ...(family === 'v2' ? { schema_version: 1 } : { config_schema_version: 1 }),
      run: { run_id: 'run-1' },
      output: { run_path: runPath },
    },
    config: { path: '/tmp/config.json', sha256: 'config-hash' },
    source_sha256: 'source-hash',
    candidate_schema_fingerprint: 'candidate-schema',
    resolved: {
      target: { layout_name: 'dev', saved_layout_id: 1, pane_index: 0, pane_id: '1' },
      strategy: { script_id: 'USER;test', version: '1.0', source_sha256: 'source-hash' },
      watchlist: {
        name: 'dev-testing-list',
        snapshot_id: hash('f'),
        ordered_symbol_fingerprint: hash('e'),
        symbol_count: 1,
      },
    },
    base_inputs: [],
    base_inputs_fingerprint: fingerprint('b'),
    planned_experiments: [plannedExperiment()],
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {},
    experiments: [],
    error: null,
  };
}

function watchlistArtifact({ symbolValidation } = {}) {
  return {
    success: true,
    snapshot: {
      snapshot_id: hash('f'),
      ordered_symbol_fingerprint: hash('e'),
      complete: true,
    },
    symbols: ['TWSE:2330'],
    ...(symbolValidation && { symbol_validation: symbolValidation }),
  };
}

function completedSymbolValidation() {
  return {
    schema_version: 1,
    performed: true,
    success: true,
    source: 'tradingview_desktop_cdp',
    timeframe: '1D',
    requested: 1,
    valid: 1,
    failed: 0,
    max_attempts: 3,
    attempt_timeout_ms: 1000,
    validated_at: 1800000000000,
    validated_at_iso: '2027-01-15T08:00:00.000Z',
    errors: [],
  };
}

function experimentArtifact(family = 'v3') {
  const planned = plannedExperiment();
  return {
    ...(family === 'v2'
      ? { schema_version: STRATEGY_RUN_LEGACY_ARTIFACT_VERSION }
      : { artifact_schema_version: family === 'v3'
        ? STRATEGY_RUN_PREVIOUS_ARTIFACT_VERSION
        : STRATEGY_RUN_ARTIFACT_VERSION }),
    run_id: 'run-1',
    experiment_id: planned.experiment_id,
    parameter_set: planned.parameter_set,
    strategy: { script_id: 'USER;test', version: '1.0' },
    target: { layout_name: 'dev', pane_index: 0, pane_id: '1' },
    base_inputs_fingerprint: fingerprint('b'),
    inputs_fingerprint: planned.inputs_fingerprint,
    effective_inputs: [],
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
  };
}

function manifestArtifact(family = 'v3') {
  const planned = plannedExperiment();
  return {
    ...(family === 'v2'
      ? { schema_version: STRATEGY_RUN_LEGACY_ARTIFACT_VERSION }
      : { artifact_schema_version: family === 'v3'
        ? STRATEGY_RUN_PREVIOUS_ARTIFACT_VERSION
        : STRATEGY_RUN_ARTIFACT_VERSION }),
    run_id: 'run-1',
    experiment_id: planned.experiment_id,
    parameter_set_name: 'baseline',
    status: 'running',
    strategy: { script_id: 'USER;test', version: '1.0' },
    inputs_fingerprint: planned.inputs_fingerprint,
    watchlist: {
      snapshot_id: hash('f'),
      ordered_symbol_fingerprint: hash('e'),
      symbol_count: 1,
    },
    requested_symbols: ['TWSE:2330'],
    timeframe: '1D',
    format: 'csv',
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {
      requested: 1,
      pending: 1,
      running: 0,
      retry_wait: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    },
    symbols: [],
  };
}

describe('Durable JSON primitives', () => {
  it('flushes and atomically replaces JSON beside the final file', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'run.json');
    let writeOptions = null;
    await atomicReplaceJson({
      path,
      value: { status: 'running' },
      _deps: {
        writeFile: async (...args) => {
          writeOptions = args[2];
          return writeFileAsync(...args);
        },
      },
    });
    assert.equal(writeOptions.flush, true);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { status: 'running' });
  });

  it('preserves the previous JSON when the temporary write fails', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'run.json');
    writeFileSync(path, '{"status":"old"}\n');
    await assert.rejects(
      atomicReplaceJson({
        path,
        value: { status: 'new' },
        _deps: { writeFile: async () => { throw new Error('disk full'); } },
      }),
      (error) => error.code === 'OUTPUT_WRITE_FAILED',
    );
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { status: 'old' });
  });

  it('preserves the previous JSON and removes temp files when rename fails', async () => {
    const directory = temporaryDirectory();
    const path = join(directory, 'run.json');
    writeFileSync(path, '{"status":"old"}\n');
    await assert.rejects(
      atomicReplaceJson({
        path,
        value: { status: 'new' },
        _deps: { rename: async () => { throw new Error('rename failed'); } },
      }),
      (error) => error.code === 'OUTPUT_WRITE_FAILED',
    );
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { status: 'old' });
    assert.deepEqual(readdirSync(directory), ['run.json']);
  });

  it('rejects oversized and symlink JSON artifacts', async () => {
    const directory = temporaryDirectory();
    const oversized = join(directory, 'oversized.json');
    writeFileSync(oversized, JSON.stringify({ value: 'x'.repeat(100) }));
    await assert.rejects(
      readBoundedJson({ path: oversized, max_bytes: 10 }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );

    const target = join(directory, 'target.json');
    const link = join(directory, 'link.json');
    writeFileSync(target, '{}');
    symlinkSync(target, link);
    await assert.rejects(
      readBoundedJson({ path: link }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
    assert.ok(STRATEGY_RUN_STATE_JSON_MAX_BYTES > 100);
  });

  it('rejects values that cannot be serialized as JSON', async () => {
    const directory = temporaryDirectory();
    const cyclic = {};
    cyclic.self = cyclic;
    await assert.rejects(
      atomicReplaceJson({ path: join(directory, 'run.json'), value: cyclic }),
      (error) => error.code === 'OUTPUT_WRITE_FAILED',
    );
    assert.equal(existsSync(join(directory, 'run.json')), false);
  });
});

describe('Durable Run store', () => {
  it('exclusive-creates a canonical Run and reads its v3 artifacts', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.replaceRun(runArtifact({ runPath: store.run_path }));
    await store.writeInitialWatchlist(watchlistArtifact());
    await store.createExperiment(experimentArtifact());
    await store.replaceManifest(manifestArtifact());

    const loaded = await readDurableRunArtifacts({ run_directory: join(output, 'run-1') });
    assert.equal(loaded.run.artifact_schema_version, 3);
    assert.equal(loaded.run.requested.config_schema_version, 1);
    assert.deepEqual(loaded.watchlist.symbols, ['TWSE:2330']);
    assert.equal(loaded.experiments.length, 1);
    assert.equal(loaded.manifests.length, 1);
    assert.equal(loaded.store.created, false);

    await assert.rejects(
      createDurableRunStore({ output_directory: output, run_id: 'run-1' }),
      (error) => error.code === 'RUN_OUTPUT_EXISTS',
    );
  });

  it('loads a complete legacy v2 tree without rewriting its version fields', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.replaceRun(runArtifact({ family: 'v2', runPath: store.run_path }));
    await store.writeInitialWatchlist(watchlistArtifact());
    await store.createExperiment(experimentArtifact('v2'));
    await store.replaceManifest(manifestArtifact('v2'));

    const loaded = await readDurableRunArtifacts({ run_directory: store.run_path });
    assert.equal(loaded.run.schema_version, 2);
    assert.equal(loaded.run.requested.schema_version, 1);
    assert.equal(loaded.experiments[0].schema_version, 2);
    assert.equal(loaded.manifests[0].schema_version, 2);
  });

  it('rejects mixed formal artifact families in one Run Directory', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.replaceRun(runArtifact({ runPath: store.run_path }));
    await store.writeInitialWatchlist(watchlistArtifact());
    await assert.rejects(
      store.createExperiment(experimentArtifact('v2')),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
    assert.equal(
      existsSync(store.artifactPath('experiments/baseline/experiment.json')),
      false,
    );
    mkdirSync(store.artifactPath('experiments/baseline'), { recursive: true });
    writeFileSync(
      store.artifactPath('experiments/baseline/experiment.json'),
      `${JSON.stringify(experimentArtifact('v2'))}\n`,
    );
    await assert.rejects(
      readDurableRunArtifacts({ run_directory: store.run_path }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('rejects a second initial Watchlist write', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.writeInitialWatchlist(watchlistArtifact());
    await assert.rejects(
      store.writeInitialWatchlist(watchlistArtifact()),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('atomically completes only Symbol validation while preserving frozen Watchlist identity', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    const pending = watchlistArtifact({
      symbolValidation: {
        schema_version: 1, performed: false, reason: 'pending', timeframe: '1D',
      },
    });
    await store.writeInitialWatchlist(pending);
    const completed = watchlistArtifact({ symbolValidation: completedSymbolValidation() });
    await store.replaceWatchlist(completed);
    assert.deepEqual(
      JSON.parse(readFileSync(join(store.run_path, 'watchlist.json'), 'utf8')),
      completed,
    );

    await assert.rejects(
      store.replaceWatchlist(completed),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('rejects Watchlist identity changes during Symbol validation replacement', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.writeInitialWatchlist(watchlistArtifact({
      symbolValidation: {
        schema_version: 1, performed: false, reason: 'pending', timeframe: '1D',
      },
    }));
    await assert.rejects(store.replaceWatchlist({
      ...watchlistArtifact({ symbolValidation: completedSymbolValidation() }),
      symbols: ['TWSE:2317'],
    }), (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID');
  });

  it('rejects a Run artifact whose requested output path differs from the store', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await assert.rejects(
      store.replaceRun(runArtifact()),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('returns structured errors for missing and unsupported Runs', async () => {
    const output = temporaryDirectory();
    await assert.rejects(
      openDurableRunStore({ run_directory: join(output, 'missing') }),
      (error) => error.code === 'RUN_RESUME_NOT_FOUND',
    );

    const legacy = join(output, 'legacy-run');
    mkdirSync(legacy);
    writeFileSync(join(legacy, 'run.json'), JSON.stringify({
      ...runArtifact({ family: 'v2' }),
      schema_version: 1,
    }));
    writeFileSync(join(legacy, 'watchlist.json'), JSON.stringify(watchlistArtifact()));
    await assert.rejects(
      readDurableRunArtifacts({ run_directory: legacy }),
      (error) => error.code === 'RUN_RESUME_VERSION_UNSUPPORTED',
    );
  });

  it('rejects symlink Experiment directories during local artifact loading', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.replaceRun(runArtifact({ runPath: store.run_path }));
    await store.writeInitialWatchlist(watchlistArtifact());
    const external = join(output, 'external');
    mkdirSync(external);
    mkdirSync(join(store.run_path, 'experiments'));
    symlinkSync(external, join(store.run_path, 'experiments', 'baseline'), 'dir');
    await assert.rejects(
      readDurableRunArtifacts({ run_directory: store.run_path }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('rejects a manifest without its immutable experiment.json', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    await store.replaceRun(runArtifact({ runPath: store.run_path }));
    await store.writeInitialWatchlist(watchlistArtifact());
    await store.replaceManifest(manifestArtifact());
    await assert.rejects(
      readDurableRunArtifacts({ run_directory: store.run_path }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });
});

describe('Atomic Symbol attempt artifacts', () => {
  it('publishes one complete Symbol directory and verifies succeeded evidence', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    const attempt = await store.beginSymbolAttempt({
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      attempt_count: 1,
      format: 'csv',
    });
    await attempt.writeJson('report.json', { success: true });
    await attempt.writeJson('trades.csv', { trades: [] });
    await attempt.writeJson('reconciliation.json', { success: true });
    const stagedInfo = await attempt.artifactInfo('report.json');
    assert.equal(stagedInfo.relative_path, 'experiments/baseline/symbols/TWSE_u3A_2330/report.json');
    const committed = await attempt.commit();
    assert.equal(committed.atomic, true);
    assert.equal(existsSync(join(committed.path, 'report.json')), true);
    assert.equal(existsSync(attempt.staging_path), false);

    let manifest = transitionSymbolState(manifestArtifact(), {
      index: 0,
      status: 'running',
      updated_at: 1001,
    });
    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'succeeded',
      updated_at: 1002,
      details: {
        resolved_symbol: 'TWSE_DLY:2330',
        snapshot_id: hash('1'),
        total_trades: 0,
        batch_count: 1,
        artifacts: {
          report: 'experiments/baseline/symbols/TWSE_u3A_2330/report.json',
          trades: 'experiments/baseline/symbols/TWSE_u3A_2330/trades.csv',
          reconciliation: 'experiments/baseline/symbols/TWSE_u3A_2330/reconciliation.json',
        },
      },
    });
    const verified = await store.verifySucceededSymbolArtifacts({
      manifest,
      entry: manifest.symbols[0],
    });
    assert.ok(verified.report.bytes > 0);

    rmSync(join(committed.path, 'reconciliation.json'));
    await assert.rejects(
      store.verifySucceededSymbolArtifacts({ manifest, entry: manifest.symbols[0] }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('cleans rename-before-callback output only for a non-succeeded Symbol', async () => {
    const output = temporaryDirectory();
    const runDirectory = join(output, 'run-1');
    mkdirSync(runDirectory);
    const attempt = await beginSymbolAttempt({
      run_directory: runDirectory,
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      attempt_count: 2,
      format: 'csv',
    });
    await attempt.writeJson('report.json', {});
    await attempt.writeJson('trades.csv', {});
    await attempt.writeJson('reconciliation.json', {});
    await attempt.commit();
    assert.equal(existsSync(attempt.final_path), true);

    const result = await cleanupUncommittedSymbolArtifacts({
      run_directory: runDirectory,
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      manifest_entry: { status: 'running' },
      ownership_confirmed: true,
    });
    assert.equal(result.removed.includes(attempt.final_path), true);
    assert.equal(existsSync(attempt.final_path), false);

    await assert.rejects(
      cleanupUncommittedSymbolArtifacts({
        run_directory: runDirectory,
        experiment_name: 'baseline',
        symbol: 'TWSE:2330',
        manifest_entry: { status: 'succeeded' },
        ownership_confirmed: true,
      }),
      /immutable/,
    );
  });

  it('refuses commit while a Trade stream is open and aborts only its staging directory', async () => {
    const output = temporaryDirectory();
    const runDirectory = join(output, 'run-1');
    mkdirSync(runDirectory);
    const attempt = await beginSymbolAttempt({
      run_directory: runDirectory,
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      attempt_count: 1,
      format: 'csv',
    });
    const stream = await attempt.openArtifact('trades.csv');
    stream.write('partial');
    await assert.rejects(attempt.commit(), /still open/);
    await attempt.abort();
    assert.equal(existsSync(attempt.staging_path), false);
    assert.equal(existsSync(attempt.final_path), false);
  });

  it('requires confirmed Run ownership before cleanup', async () => {
    const output = temporaryDirectory();
    const runDirectory = join(output, 'run-1');
    mkdirSync(runDirectory);
    await assert.rejects(
      cleanupUncommittedSymbolArtifacts({
        run_directory: runDirectory,
        experiment_name: 'baseline',
        symbol: 'TWSE:2330',
      }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });

  it('rejects direct verification with a non-succeeded entry', async () => {
    const output = temporaryDirectory();
    const runDirectory = join(output, 'run-1');
    mkdirSync(runDirectory);
    await assert.rejects(
      verifySucceededSymbolArtifacts({
        run_directory: runDirectory,
        manifest: manifestArtifact(),
        entry: { index: 0, status: 'running' },
      }),
      /Only a succeeded Symbol/,
    );
  });
});
