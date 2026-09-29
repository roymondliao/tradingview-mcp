import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createDurableExperimentArtifact,
  createDurableExperimentManifest,
} from '../../src/core/strategy-durable-experiment.js';
import {
  createParameterSetExecutionPlan,
  persistableParameterSetPlan,
} from '../../src/core/strategy-parameter-sets.js';
import { createDurableRunStore } from '../../src/core/strategy-run-artifacts.js';
import { transitionSymbolState } from '../../src/core/strategy-run-state.js';
import { normalizedPineSourceSha256 } from '../../src/core/pine-input-schema.js';
import { sha256Hex } from '../../src/core/stable-json.js';

export function candidateSchema() {
  return {
    available: true,
    source_sha256: null,
    input_schema_fingerprint: 'candidate-schema',
    inputs: [{
      name: 'Length',
      pine_input_type: 'int',
      runtime_value_type: 'int',
      constraints: { min: 1, max: 20 },
    }],
  };
}

export function baseInputs(value = 10) {
  return [{
    id: 'in_0',
    name: 'Length',
    name_selectable: true,
    type: 'integer',
    value,
    default_value: 10,
    constraints: { min: 1, max: 20 },
  }];
}

export function strategyIdentity(overrides = {}) {
  return {
    entity_id: 'old-entity',
    script_id: 'USER;strategy-1',
    version: '3.0',
    source_sha256: overrides.source_sha256 || 'pending-source',
    ...overrides,
  };
}

export async function createResumeFixture({
  root,
  symbols = ['TWSE:2330', 'TWSE:2317', 'TWSE:2454'],
  parameter_sets = [
    { name: 'baseline', inputs: {} },
    { name: 'candidate', inputs: { Length: 5 } },
  ],
  status = 'running',
} = {}) {
  const output = join(root, 'output');
  await mkdir(output, { recursive: true });
  const pinePath = join(root, 'strategy.pine');
  const pineSource = '//@version=6\nstrategy("Resume")\nlength = input.int(10, "Length", minval=1, maxval=20)\n';
  await writeFile(pinePath, pineSource, 'utf8');
  const sourceSha256 = normalizedPineSourceSha256(pineSource);
  const identity = strategyIdentity({ source_sha256: sourceSha256 });
  const executionPlan = createParameterSetExecutionPlan({
    base_catalog: baseInputs(),
    candidate_schema: candidateSchema(),
    parameter_sets,
    identity,
  });
  const plans = executionPlan.parameter_sets.map(persistableParameterSetPlan);
  const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
  const watchlist = {
    success: true,
    watchlist: {
      name: 'stock_all_list',
      watchlist_id: 100,
      modified: '2026-09-29T00:00:00Z',
      active: false,
    },
    snapshot: {
      snapshot_id: `sha256:${sha256Hex({
        watchlist_id: '100',
        name: 'stock_all_list',
        modified: '2026-09-29T00:00:00Z',
        symbols,
      })}`,
      ordered_symbol_fingerprint: `sha256:${sha256Hex(symbols)}`,
      declared_symbol_count: symbols.length,
      returned_symbol_count: symbols.length,
      unique_symbol_count: symbols.length,
      complete: true,
    },
    symbols,
  };
  const run = {
    schema_version: 2,
    run_id: 'run-1',
    status,
    requested: {
      schema_version: 1,
      run: { run_id: 'run-1', description: 'resume fixture', generated: false },
      strategy: {
        file: 'strategy.pine',
        saved_name: 'resume-strategy',
        file_path: pinePath,
        source_sha256: sourceSha256,
      },
      target: {
        layout: { name: 'dev' },
        pane_index: 0,
        watchlist: { name: 'stock_all_list' },
      },
      backtest: { timeframe: '1D' },
      experiments: { parameter_sets },
      output: {
        directory: './output',
        format: 'csv',
        directory_path: output,
        run_path: store.run_path,
      },
    },
    config: { path: join(root, 'missing-config.json'), sha256: 'config-hash' },
    source_sha256: sourceSha256,
    candidate_schema_fingerprint: 'candidate-schema',
    resolved: {
      target: {
        tab_index: 1,
        target_id: 'old-target',
        url_chart_id: 'url-chart',
        layout_name: 'dev',
        layout_id: 'layout-id',
        saved_layout_id: 101,
        pane_layout: 's',
        pane_index: 0,
        pane_id: 'pane-1',
        symbol: symbols[0],
        timeframe: '1D',
      },
      strategy: identity,
      watchlist: {
        name: 'stock_all_list',
        snapshot_id: watchlist.snapshot.snapshot_id,
        ordered_symbol_fingerprint: watchlist.snapshot.ordered_symbol_fingerprint,
        symbol_count: symbols.length,
      },
    },
    base_inputs: executionPlan.base_inputs,
    base_inputs_fingerprint: executionPlan.base_inputs_fingerprint,
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
  await store.writeInitialWatchlist(watchlist);
  await store.replaceRun(run);

  async function createExperiment(index, { manifest = true } = {}) {
    const experiment = createDurableExperimentArtifact({
      run,
      experiment_plan: plans[index],
      started_at: 1000,
    });
    await store.createExperiment(experiment);
    const value = manifest
      ? createDurableExperimentManifest({
        run,
        experiment,
        requested_symbols: symbols,
        timeframe: '1D',
        format: 'csv',
      })
      : null;
    if (value) await store.replaceManifest(value);
    return { experiment, manifest: value };
  }

  async function publishSymbol({ experiment_name, symbol, attempt_count = 1 }) {
    const attempt = await store.beginSymbolAttempt({
      experiment_name,
      symbol,
      attempt_count,
      format: 'csv',
    });
    await attempt.writeJson('report.json', { success: true });
    const trades = await attempt.openArtifact('trades.csv');
    await new Promise((resolveWrite, rejectWrite) => {
      trades.once('error', rejectWrite);
      trades.once('close', resolveWrite);
      trades.end('trade\n');
    });
    await attempt.writeJson('reconciliation.json', { success: true });
    await attempt.commit();
  }

  function succeedSymbol(manifest, index, updatedAt = 1002) {
    const symbol = symbols[index];
    const safe = symbol.replace(':', '_u3A_');
    let next = transitionSymbolState(manifest, {
      index,
      status: 'running',
      updated_at: updatedAt - 1,
    });
    next = transitionSymbolState(next, {
      index,
      status: 'succeeded',
      updated_at: updatedAt,
      details: {
        resolved_symbol: symbol.replace('TWSE:', 'TWSE_DLY:'),
        snapshot_id: `sha256:${'1'.repeat(64)}`,
        total_trades: 1,
        batch_count: 1,
        artifacts: {
          report: `experiments/${manifest.parameter_set_name}/symbols/${safe}/report.json`,
          trades: `experiments/${manifest.parameter_set_name}/symbols/${safe}/trades.csv`,
          reconciliation: `experiments/${manifest.parameter_set_name}/symbols/${safe}/reconciliation.json`,
        },
      },
    });
    return next;
  }

  return {
    root,
    output,
    pinePath,
    pineSource,
    sourceSha256,
    candidate: candidateSchema(),
    identity,
    symbols,
    plans,
    executionPlan,
    watchlist,
    run,
    store,
    createExperiment,
    publishSymbol,
    succeedSymbol,
  };
}
