#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createWriteStream as nodeCreateWriteStream } from 'node:fs';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  statfs,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { finished } from 'node:stream/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import {
  createDurableExperimentArtifact,
  createDurableExperimentManifest,
} from '../src/core/strategy-durable-experiment.js';
import {
  createParameterSetExecutionPlan,
  persistableParameterSetPlan,
} from '../src/core/strategy-parameter-sets.js';
import {
  createDurableRunStore,
  readDurableRunArtifacts,
} from '../src/core/strategy-run-artifacts.js';
import {
  buildResumePlan,
  transitionExperimentState,
  transitionSymbolState,
} from '../src/core/strategy-run-state.js';
import {
  finalizeDurableStrategyRun,
  loadStrategyResume,
} from '../src/core/strategy-resume.js';
import { sha256Hex } from '../src/core/stable-json.js';

export const STRATEGY_DURABLE_BENCHMARK_SYMBOL_COUNT = 652;
export const STRATEGY_DURABLE_BENCHMARK_PARAMETER_SET_COUNT = 3;
export const STRATEGY_DURABLE_BENCHMARK_REPETITIONS = 3;

// D-014 thresholds are populated from the first accepted 652 x 3 measurement.
// Correctness limits are always enforced; hardware-sensitive limits are enforced
// only for the canonical benchmark shape and can be skipped with --measure.
export const STRATEGY_DURABLE_BENCHMARK_THRESHOLDS = Object.freeze({
  max_median_wall_time_ms: 120_000,
  max_worst_wall_time_ms: 180_000,
  max_peak_rss_bytes: 256 * 1024 * 1024,
  max_bytes_written: 1536 * 1024 * 1024,
  max_final_disk_bytes: 4 * 1024 * 1024,
  max_manifest_bytes: 1024 * 1024,
  max_resume_audit_and_planning_ms: 15_000,
  max_pure_planning_ms: 250,
});

function symbolsFor(count) {
  return Object.freeze(Array.from(
    { length: count },
    (_unused, index) => `TEST:${String(index + 1).padStart(4, '0')}`,
  ));
}

function parameterSetsFor(count) {
  assert.ok(count >= 1 && count <= 20, 'parameter_set_count must be from 1 to 20');
  return Object.freeze(Array.from({ length: count }, (_unused, index) => ({
    name: index === 0 ? 'baseline' : `candidate_${index}`,
    inputs: index === 0 ? {} : { Length: 10 + index },
  })));
}

function planningArtifacts({ root, runPath, symbols, parameterSets, runId }) {
  const identity = Object.freeze({
    entity_id: 'benchmark-entity',
    script_id: 'USER;durable-benchmark',
    version: '1.0',
    source_sha256: sha256Hex('strategy durable benchmark source'),
  });
  const baseInputs = Object.freeze([{
    id: 'in_0',
    name: 'Length',
    name_selectable: true,
    type: 'integer',
    value: 10,
    default_value: 10,
    constraints: { min: 1, max: 100 },
  }]);
  const candidateSchema = Object.freeze({
    available: true,
    source_sha256: identity.source_sha256,
    input_schema_fingerprint: sha256Hex('benchmark-candidate-schema'),
    inputs: [{
      name: 'Length',
      pine_input_type: 'int',
      runtime_value_type: 'int',
      constraints: { min: 1, max: 100 },
    }],
  });
  const executionPlan = createParameterSetExecutionPlan({
    base_catalog: baseInputs,
    candidate_schema: candidateSchema,
    parameter_sets: parameterSets,
    identity,
  });
  const plans = executionPlan.parameter_sets.map(persistableParameterSetPlan);
  const orderedFingerprint = `sha256:${sha256Hex(symbols)}`;
  const modified = '2026-09-29T00:00:00.000Z';
  const watchlistName = 'synthetic_652';
  const watchlistId = 652;
  const snapshotId = `sha256:${sha256Hex({
    watchlist_id: String(watchlistId),
    name: watchlistName,
    modified,
    symbols,
  })}`;
  const watchlist = Object.freeze({
    success: true,
    watchlist: {
      name: watchlistName,
      watchlist_id: watchlistId,
      modified,
      active: false,
    },
    snapshot: {
      snapshot_id: snapshotId,
      ordered_symbol_fingerprint: orderedFingerprint,
      declared_symbol_count: symbols.length,
      returned_symbol_count: symbols.length,
      unique_symbol_count: symbols.length,
      invalid_symbol_count: 0,
      duplicate_symbol_count: 0,
      complete: true,
    },
    symbols,
  });
  const startedAt = 1000;
  const run = Object.freeze({
    schema_version: 2,
    run_id: runId,
    status: 'running',
    requested: {
      schema_version: 1,
      run: { run_id: runId, description: '652 x 3 filesystem benchmark', generated: false },
      strategy: {
        file: 'benchmark.pine',
        saved_name: 'durable-benchmark',
        file_path: join(root, 'benchmark.pine'),
        source_sha256: identity.source_sha256,
      },
      target: {
        layout: { name: 'benchmark' },
        pane_index: 0,
        watchlist: { name: watchlistName },
      },
      backtest: { timeframe: '1D' },
      experiments: { parameter_sets: parameterSets },
      output: {
        directory: '.',
        directory_path: root,
        run_path: runPath,
        format: 'csv',
      },
    },
    config: { path: join(root, 'benchmark-config.json'), sha256: sha256Hex('benchmark-config') },
    source_sha256: identity.source_sha256,
    candidate_schema_fingerprint: candidateSchema.input_schema_fingerprint,
    resolved: {
      target: {
        tab_index: 0,
        target_id: 'benchmark-target',
        url_chart_id: 'benchmark-chart',
        layout_name: 'benchmark',
        layout_id: 'benchmark-chart',
        saved_layout_id: 652,
        pane_layout: 's',
        pane_index: 0,
        pane_id: '1',
        symbol: symbols[0],
        timeframe: '1D',
      },
      strategy: identity,
      watchlist: {
        name: watchlistName,
        snapshot_id: snapshotId,
        ordered_symbol_fingerprint: orderedFingerprint,
        symbol_count: symbols.length,
      },
    },
    base_inputs: executionPlan.base_inputs,
    base_inputs_fingerprint: executionPlan.base_inputs_fingerprint,
    planned_experiments: plans,
    started_at: startedAt,
    started_at_iso: new Date(startedAt).toISOString(),
    updated_at: startedAt,
    updated_at_iso: new Date(startedAt).toISOString(),
    summary: {},
    experiments: [],
    error: null,
  });
  return { run, watchlist, plans };
}

function trackedFilesystem(metrics) {
  return {
    async writeFile(path, data, options) {
      metrics.bytes_written += Buffer.byteLength(data);
      return nodeWriteFile(path, data, options);
    },
    createWriteStream(path, options) {
      const stream = nodeCreateWriteStream(path, options);
      const originalWrite = stream.write.bind(stream);
      const originalEnd = stream.end.bind(stream);
      stream.write = (chunk, ...args) => {
        metrics.bytes_written += Buffer.byteLength(chunk);
        return originalWrite(chunk, ...args);
      };
      stream.end = (chunk, ...args) => {
        if (chunk != null) metrics.bytes_written += Buffer.byteLength(chunk);
        return originalEnd(chunk, ...args);
      };
      return stream;
    },
  };
}

function sampleMemory(metrics) {
  const memory = process.memoryUsage();
  metrics.peak_rss_bytes = Math.max(metrics.peak_rss_bytes, memory.rss);
  metrics.peak_heap_used_bytes = Math.max(metrics.peak_heap_used_bytes, memory.heapUsed);
}

async function directoryBytes(path) {
  const entries = await readdir(path, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const entryPath = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(entryPath);
    else if (entry.isFile()) total += (await stat(entryPath)).size;
  }
  return total;
}

async function verifyArtifactMarkers({ store, manifests }) {
  for (const manifest of manifests) {
    for (const entry of manifest.symbols) {
      const marker = `${manifest.parameter_set_name}:${entry.requested_symbol}`;
      const report = JSON.parse(await readFile(store.artifactPath(entry.artifacts.report), 'utf8'));
      const reconciliation = JSON.parse(
        await readFile(store.artifactPath(entry.artifacts.reconciliation), 'utf8'),
      );
      const trades = await readFile(store.artifactPath(entry.artifacts.trades), 'utf8');
      assert.equal(report.marker, `${marker}:report`);
      assert.equal(reconciliation.marker, `${marker}:reconciliation`);
      assert.equal(trades, `${marker}:trades\n`);
    }
  }
}

async function runRepetition({ root, repetition, symbolCount, parameterSetCount }) {
  const metrics = {
    bytes_written: 0,
    peak_rss_bytes: 0,
    peak_heap_used_bytes: 0,
  };
  sampleMemory(metrics);
  const repetitionRoot = join(root, `repetition-${repetition + 1}`);
  const runId = `durable-benchmark-${repetition + 1}`;
  const store = await createDurableRunStore({
    output_directory: repetitionRoot,
    run_id: runId,
    _deps: trackedFilesystem(metrics),
  });
  const symbols = symbolsFor(symbolCount);
  const parameterSets = parameterSetsFor(parameterSetCount);
  const artifacts = planningArtifacts({
    root: repetitionRoot,
    runPath: store.run_path,
    symbols,
    parameterSets,
    runId,
  });
  let timestamp = artifacts.run.updated_at;
  const started = performance.now();
  await store.writeInitialWatchlist(artifacts.watchlist);
  await store.replaceRun(artifacts.run);
  const finalManifests = [];
  for (const plan of artifacts.plans) {
    const experiment = createDurableExperimentArtifact({
      run: artifacts.run,
      experiment_plan: plan,
      started_at: ++timestamp,
    });
    await store.createExperiment(experiment);
    let manifest = createDurableExperimentManifest({
      run: artifacts.run,
      experiment,
      requested_symbols: symbols,
      timeframe: '1D',
      format: 'csv',
    });
    await store.replaceManifest(manifest);
    for (const [index, symbol] of symbols.entries()) {
      manifest = transitionSymbolState(manifest, {
        index,
        status: 'running',
        updated_at: ++timestamp,
      });
      await store.replaceManifest(manifest);
      const attempt = await store.beginSymbolAttempt({
        experiment_name: plan.parameter_set.name,
        symbol,
        attempt_count: 1,
        format: 'csv',
      });
      const marker = `${plan.parameter_set.name}:${symbol}`;
      await attempt.writeJson('report.json', { marker: `${marker}:report` });
      const trades = await attempt.openArtifact('trades.csv');
      trades.end(`${marker}:trades\n`);
      await finished(trades);
      await attempt.writeJson('reconciliation.json', {
        marker: `${marker}:reconciliation`,
      });
      const [report, tradeInfo, reconciliation] = await Promise.all([
        attempt.artifactInfo('report.json'),
        attempt.artifactInfo('trades.csv'),
        attempt.artifactInfo('reconciliation.json'),
      ]);
      await attempt.commit();
      manifest = transitionSymbolState(manifest, {
        index,
        status: 'succeeded',
        updated_at: ++timestamp,
        details: {
          resolved_symbol: symbol,
          snapshot_id: `sha256:${sha256Hex(marker)}`,
          total_trades: 0,
          batch_count: 1,
          artifacts: {
            report: report.relative_path,
            trades: tradeInfo.relative_path,
            reconciliation: reconciliation.relative_path,
          },
        },
      });
      await store.replaceManifest(manifest);
      sampleMemory(metrics);
    }
    manifest = transitionExperimentState(manifest, {
      status: 'succeeded',
      updated_at: ++timestamp,
    });
    await store.replaceManifest(manifest);
    finalManifests.push(manifest);
  }

  const loaded = await readDurableRunArtifacts({ run_directory: store.run_path });
  const purePlanningStarted = performance.now();
  const purePlan = buildResumePlan({
    run: loaded.run,
    watchlist: loaded.watchlist,
    experiments: loaded.experiments,
    manifests: loaded.manifests,
  });
  const purePlanningMs = performance.now() - purePlanningStarted;
  assert.equal(
    purePlan.experiments.reduce((count, item) => count + item.selected_indices.length, 0),
    0,
  );
  const resumeStarted = performance.now();
  const resume = await loadStrategyResume({ run_directory: store.run_path });
  const resumeAuditAndPlanningMs = performance.now() - resumeStarted;
  assert.equal(resume.summary.symbols_selected, 0);
  assert.equal(resume.summary.symbols_succeeded, symbolCount * parameterSetCount);
  await verifyArtifactMarkers({ store, manifests: finalManifests });
  const finalized = await finalizeDurableStrategyRun({
    store,
    _deps: { now: () => ++timestamp },
  });
  assert.equal(finalized.run.status, 'succeeded');
  assert.equal(finalized.summary.symbols_succeeded, symbolCount * parameterSetCount);
  const wallTimeMs = performance.now() - started;
  const manifestSizes = await Promise.all(artifacts.plans.map(async (plan) => (
    await stat(store.artifactPath(`experiments/${plan.parameter_set.name}/manifest.json`))
  ).size));
  sampleMemory(metrics);
  return Object.freeze({
    repetition: repetition + 1,
    wall_time_ms: Number(wallTimeMs.toFixed(3)),
    resume_audit_and_planning_ms: Number(resumeAuditAndPlanningMs.toFixed(3)),
    pure_planning_ms: Number(purePlanningMs.toFixed(3)),
    peak_rss_bytes: metrics.peak_rss_bytes,
    peak_heap_used_bytes: metrics.peak_heap_used_bytes,
    bytes_written: metrics.bytes_written,
    final_disk_bytes: await directoryBytes(store.run_path),
    manifest_bytes: manifestSizes,
    max_manifest_bytes: Math.max(...manifestSizes),
    symbols_succeeded: finalized.summary.symbols_succeeded,
    experiments_succeeded: finalized.summary.experiments_succeeded,
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function aggregateResults(results) {
  const field = (name) => results.map((result) => result[name]);
  return Object.freeze({
    median_wall_time_ms: Number(median(field('wall_time_ms')).toFixed(3)),
    worst_wall_time_ms: Math.max(...field('wall_time_ms')),
    worst_resume_audit_and_planning_ms: Math.max(...field('resume_audit_and_planning_ms')),
    worst_pure_planning_ms: Math.max(...field('pure_planning_ms')),
    peak_rss_bytes: Math.max(...field('peak_rss_bytes')),
    peak_heap_used_bytes: Math.max(...field('peak_heap_used_bytes')),
    max_bytes_written: Math.max(...field('bytes_written')),
    max_final_disk_bytes: Math.max(...field('final_disk_bytes')),
    max_manifest_bytes: Math.max(...field('max_manifest_bytes')),
  });
}

function enforceThresholds(summary) {
  const thresholds = STRATEGY_DURABLE_BENCHMARK_THRESHOLDS;
  for (const [name, maximum] of Object.entries({
    median_wall_time_ms: thresholds.max_median_wall_time_ms,
    worst_wall_time_ms: thresholds.max_worst_wall_time_ms,
    peak_rss_bytes: thresholds.max_peak_rss_bytes,
    max_bytes_written: thresholds.max_bytes_written,
    max_final_disk_bytes: thresholds.max_final_disk_bytes,
    max_manifest_bytes: thresholds.max_manifest_bytes,
    worst_resume_audit_and_planning_ms: thresholds.max_resume_audit_and_planning_ms,
    worst_pure_planning_ms: thresholds.max_pure_planning_ms,
  })) {
    if (maximum == null) {
      throw new Error('D-014 measured thresholds have not been accepted; use --measure first.');
    }
    assert.ok(summary[name] <= maximum, `${name} ${summary[name]} exceeded ${maximum}`);
  }
}

export async function runStrategyDurableBenchmark({
  symbol_count = STRATEGY_DURABLE_BENCHMARK_SYMBOL_COUNT,
  parameter_set_count = STRATEGY_DURABLE_BENCHMARK_PARAMETER_SET_COUNT,
  repetitions = STRATEGY_DURABLE_BENCHMARK_REPETITIONS,
  measure_only = false,
  keep = false,
} = {}) {
  assert.ok(Number.isInteger(symbol_count) && symbol_count > 0);
  assert.ok(Number.isInteger(parameter_set_count) && parameter_set_count > 0);
  assert.ok(Number.isInteger(repetitions) && repetitions > 0);
  const root = await mkdtemp(join(tmpdir(), 'tv-durable-benchmark-'));
  try {
    const filesystem = await statfs(root);
    const results = [];
    for (let repetition = 0; repetition < repetitions; repetition += 1) {
      results.push(await runRepetition({
        root,
        repetition,
        symbolCount: symbol_count,
        parameterSetCount: parameter_set_count,
      }));
    }
    const summary = aggregateResults(results);
    const canonicalShape = symbol_count === STRATEGY_DURABLE_BENCHMARK_SYMBOL_COUNT
      && parameter_set_count === STRATEGY_DURABLE_BENCHMARK_PARAMETER_SET_COUNT
      && repetitions >= STRATEGY_DURABLE_BENCHMARK_REPETITIONS;
    if (!measure_only && canonicalShape) enforceThresholds(summary);
    return Object.freeze({
      benchmark: 'strategy-durable-export-recovery',
      shape: {
        symbols: symbol_count,
        parameter_sets: parameter_set_count,
        symbol_executions: symbol_count * parameter_set_count,
        repetitions,
      },
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        filesystem_type: String(filesystem.type),
        filesystem_block_size: Number(filesystem.bsize),
      },
      thresholds_enforced: !measure_only && canonicalShape,
      thresholds: STRATEGY_DURABLE_BENCHMARK_THRESHOLDS,
      summary,
      repetitions: results,
      ...(keep && { retained_directory: root }),
    });
  } finally {
    if (!keep) await rm(root, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === '--measure') options.measure_only = true;
    else if (argument === '--keep') options.keep = true;
    else if (argument.startsWith('--symbols=')) options.symbol_count = Number(argument.slice(10));
    else if (argument.startsWith('--parameter-sets=')) {
      options.parameter_set_count = Number(argument.slice(17));
    } else if (argument.startsWith('--repetitions=')) {
      options.repetitions = Number(argument.slice(14));
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await runStrategyDurableBenchmark(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${basename(fileURLToPath(import.meta.url))}: ${error.stack || error}\n`);
    process.exitCode = 1;
  }
}
