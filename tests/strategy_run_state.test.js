import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STRATEGY_RUN_ARTIFACT_VERSION,
  buildResumePlan,
  deriveManifestSummary,
  deriveRunSummary,
  transitionExperimentState,
  transitionRunState,
  transitionSymbolState,
  validateExperimentArtifactV2,
  validateExperimentManifestV2,
  validateRunArtifactV2,
} from '../src/core/strategy-run-state.js';

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function fingerprint(character) {
  return { available: true, algorithm: 'sha256', value: character.repeat(64), count: 1 };
}

function plan(index, name, character) {
  return {
    experiment_id: hash(character),
    parameter_set: {
      index,
      name,
      requested_inputs: {},
      requested_inputs_fingerprint: character.repeat(64),
    },
    inputs_fingerprint: fingerprint(character),
    effective_inputs: [],
  };
}

function runArtifact({ status = 'running', plans = [plan(0, 'baseline', 'a')] } = {}) {
  return {
    schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: 'run-1',
    status,
    requested: {
      run: { run_id: 'run-1' },
      output: { run_path: '/tmp/output/run-1' },
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
        symbol_count: 2,
      },
    },
    base_inputs: [],
    base_inputs_fingerprint: fingerprint('b'),
    planned_experiments: plans,
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {},
    experiments: [],
    error: status === 'failed'
      ? { code: 'STRATEGY_RUN_FAILED', phase: 'test', message: 'failed' }
      : null,
  };
}

function experimentArtifact(currentPlan = plan(0, 'baseline', 'a')) {
  return {
    schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: 'run-1',
    experiment_id: currentPlan.experiment_id,
    parameter_set: currentPlan.parameter_set,
    strategy: { script_id: 'USER;test', version: '1.0' },
    target: { layout_name: 'dev', pane_index: 0, pane_id: '1' },
    base_inputs_fingerprint: fingerprint('b'),
    inputs_fingerprint: currentPlan.inputs_fingerprint,
    effective_inputs: [],
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
  };
}

function manifestArtifact(currentPlan = plan(0, 'baseline', 'a')) {
  return {
    schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: 'run-1',
    experiment_id: currentPlan.experiment_id,
    parameter_set_name: currentPlan.parameter_set.name,
    status: 'running',
    strategy: { script_id: 'USER;test', version: '1.0' },
    inputs_fingerprint: currentPlan.inputs_fingerprint,
    watchlist: {
      snapshot_id: hash('f'),
      ordered_symbol_fingerprint: hash('e'),
      symbol_count: 2,
    },
    requested_symbols: ['TWSE:2330', 'TWSE:2317'],
    timeframe: '1D',
    format: 'csv',
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {
      requested: 2,
      pending: 2,
      running: 0,
      retry_wait: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    },
    symbols: [],
  };
}

function watchlistArtifact() {
  return {
    snapshot: {
      snapshot_id: hash('f'),
      ordered_symbol_fingerprint: hash('e'),
      complete: true,
    },
    symbols: ['TWSE:2330', 'TWSE:2317'],
  };
}

describe('Strategy Run artifact v2 validation', () => {
  it('accepts the v2 Run, Experiment, and Manifest shapes', () => {
    assert.equal(validateRunArtifactV2(runArtifact()).schema_version, 2);
    assert.equal(validateExperimentArtifactV2(experimentArtifact()).schema_version, 2);
    assert.equal(validateExperimentManifestV2(manifestArtifact()).schema_version, 2);
  });

  it('rejects v1 and future artifacts as unsupported without rewriting them', () => {
    for (const schemaVersion of [1, 3]) {
      const value = { ...runArtifact(), schema_version: schemaVersion };
      assert.throws(
        () => validateRunArtifactV2(value),
        (error) => error.code === 'RUN_RESUME_VERSION_UNSUPPORTED',
      );
    }
  });

  it('rejects unknown identity fields and inconsistent timestamps', () => {
    assert.throws(
      () => validateRunArtifactV2({ ...runArtifact(), unexpected: true }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
    assert.throws(
      () => validateRunArtifactV2({ ...runArtifact(), updated_at_iso: 'invalid' }),
      (error) => error.code === 'RUN_RESUME_ARTIFACT_INVALID',
    );
  });
});

describe('Strategy Symbol state transitions', () => {
  it('records cumulative attempts and derives every status count', () => {
    let manifest = manifestArtifact();
    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'running',
      updated_at: 1001,
    });
    assert.equal(manifest.symbols[0].attempt_count, 1);
    assert.equal(manifest.summary.running, 1);

    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'retry_wait',
      updated_at: 1002,
      error: { code: 'SYMBOL_SWITCH_FAILED', phase: 'switch', message: 'retry' },
    });
    assert.equal(manifest.summary.retry_wait, 1);
    assert.equal('retryable' in manifest.symbols[0].error, false);

    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'running',
      updated_at: 1003,
    });
    assert.equal(manifest.symbols[0].attempt_count, 2);

    manifest = transitionSymbolState(manifest, {
      index: 0,
      status: 'succeeded',
      updated_at: 1004,
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
    assert.equal(manifest.summary.succeeded, 1);
    assert.equal(manifest.summary.pending, 1);
    assert.equal(manifest.symbols[0].attempt_count, 2);
    assert.equal('error' in manifest.symbols[0], false);
  });

  it('keeps succeeded Symbols immutable and validates terminal Experiment success', () => {
    let manifest = manifestArtifact();
    for (let index = 0; index < 2; index += 1) {
      manifest = transitionSymbolState(manifest, {
        index,
        status: 'running',
        updated_at: 1001 + (index * 2),
      });
      const safe = index === 0 ? 'TWSE_u3A_2330' : 'TWSE_u3A_2317';
      manifest = transitionSymbolState(manifest, {
        index,
        status: 'succeeded',
        updated_at: 1002 + (index * 2),
        details: {
          resolved_symbol: manifest.requested_symbols[index],
          snapshot_id: hash(String(index + 2)),
          total_trades: 0,
          batch_count: 1,
          artifacts: {
            report: `experiments/baseline/symbols/${safe}/report.json`,
            trades: `experiments/baseline/symbols/${safe}/trades.csv`,
            reconciliation: `experiments/baseline/symbols/${safe}/reconciliation.json`,
          },
        },
      });
    }
    const succeeded = transitionExperimentState(manifest, {
      status: 'succeeded',
      updated_at: 1005,
    });
    assert.equal(succeeded.status, 'succeeded');
    assert.throws(
      () => transitionSymbolState(succeeded, { index: 0, status: 'running', updated_at: 1006 }),
      /immutable/,
    );
  });

  it('rejects summary drift, duplicate indices, and unsafe artifact paths', () => {
    const summaryDrift = manifestArtifact();
    summaryDrift.summary.pending = 1;
    assert.throws(() => validateExperimentManifestV2(summaryDrift), /summary\.pending/);

    let manifest = transitionSymbolState(manifestArtifact(), {
      index: 0,
      status: 'running',
      updated_at: 1001,
    });
    manifest = {
      ...manifest,
      symbols: [...manifest.symbols, manifest.symbols[0]],
      summary: { ...manifest.summary, pending: 0, running: 2 },
    };
    assert.throws(() => validateExperimentManifestV2(manifest), /duplicate Symbol index/);

    let unsafe = transitionSymbolState(manifestArtifact(), {
      index: 0,
      status: 'running',
      updated_at: 1001,
    });
    assert.throws(() => transitionSymbolState(unsafe, {
      index: 0,
      status: 'succeeded',
      updated_at: 1002,
      details: {
        resolved_symbol: 'TWSE_DLY:2330',
        snapshot_id: hash('3'),
        total_trades: 0,
        batch_count: 1,
        artifacts: {
          report: '../report.json',
          trades: 'trades.csv',
          reconciliation: 'reconciliation.json',
        },
      },
    }), /unsafe path segment/);
  });

  it('derives summaries without trusting stored values', () => {
    const summary = deriveManifestSummary(manifestArtifact());
    assert.deepEqual(summary, {
      requested: 2,
      pending: 2,
      running: 0,
      retry_wait: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('Strategy Run state transitions and Resume planning', () => {
  it('allows failed Runs to return to running but keeps succeeded Runs immutable', () => {
    const failed = transitionRunState(runArtifact(), {
      status: 'failed',
      updated_at: 1001,
      error: { code: 'TEST_FAILED', phase: 'test', message: 'failed', retryable: true },
    });
    assert.deepEqual(failed.error, { code: 'TEST_FAILED', phase: 'test', message: 'failed' });
    const resumed = transitionRunState(failed, { status: 'running', updated_at: 1002 });
    assert.equal(resumed.error, null);
    const succeeded = transitionRunState(resumed, { status: 'succeeded', updated_at: 1003 });
    assert.throws(
      () => transitionRunState(succeeded, { status: 'running', updated_at: 1004 }),
      /immutable/,
    );
  });

  it('skips only succeeded Symbols and schedules a missing manifest in full', () => {
    const plans = [plan(0, 'baseline', 'a'), plan(1, 'candidate', 'c')];
    const run = runArtifact({ plans });
    const baselineExperiment = experimentArtifact(plans[0]);
    let baselineManifest = manifestArtifact(plans[0]);
    baselineManifest = transitionSymbolState(baselineManifest, {
      index: 0,
      status: 'running',
      updated_at: 1001,
    });
    baselineManifest = transitionSymbolState(baselineManifest, {
      index: 0,
      status: 'succeeded',
      updated_at: 1002,
      details: {
        resolved_symbol: 'TWSE_DLY:2330',
        snapshot_id: hash('4'),
        total_trades: 0,
        batch_count: 1,
        artifacts: {
          report: 'experiments/baseline/symbols/TWSE_u3A_2330/report.json',
          trades: 'experiments/baseline/symbols/TWSE_u3A_2330/trades.csv',
          reconciliation: 'experiments/baseline/symbols/TWSE_u3A_2330/reconciliation.json',
        },
      },
    });
    const resume = buildResumePlan({
      run,
      watchlist: watchlistArtifact(),
      experiments: [baselineExperiment],
      manifests: [baselineManifest],
    });
    assert.deepEqual(resume.experiments[0].selected_indices, [1]);
    assert.deepEqual(resume.experiments[1].selected_indices, [0, 1]);
    assert.equal(resume.experiments[1].manifest_present, false);
  });

  it('reports setup-required before Parameter Set plans have been persisted', () => {
    const run = runArtifact({ plans: undefined });
    delete run.planned_experiments;
    const resume = buildResumePlan({ run, watchlist: watchlistArtifact() });
    assert.equal(resume.setup_required, true);
    assert.equal(resume.experiment_count, 0);
  });

  it('counts missing Experiment manifests as pending work in the Run summary', () => {
    const plans = [plan(0, 'baseline', 'a'), plan(1, 'candidate', 'c')];
    const summary = deriveRunSummary({
      run: runArtifact({ plans }),
      manifests: [manifestArtifact(plans[0])],
    });
    assert.equal(summary.experiments_requested, 2);
    assert.equal(summary.symbols_requested, 4);
    assert.equal(summary.symbols_pending, 4);
  });
});
