/** Durable Experiment orchestration backed exclusively by artifact-v2 manifests. */
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { stableJsonStringify } from './stable-json.js';
import { unixMillisecondsToIso } from './time.js';
import {
  STRATEGY_RUN_ARTIFACT_VERSION,
  deriveManifestSummary,
  transitionExperimentState,
  validateExperimentArtifactV2,
  validateExperimentManifestV2,
  validateRunArtifactV2,
} from './strategy-run-state.js';
import { executeStrategySymbolWithRetry } from './strategy-run-retry.js';

function artifactInvalid(message) {
  return new CoreOperationError(message, {
    code: 'RUN_RESUME_ARTIFACT_INVALID',
    phase: 'experiment_validation',
  });
}

function equal(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

/** Stable Strategy identity; Pane entity_id is a volatile runtime binding. */
export function stableDurableStrategyIdentity(strategy) {
  return Object.freeze({
    script_id: strategy?.script_id,
    version: strategy?.version == null ? null : String(strategy.version),
    source_sha256: strategy?.source_sha256,
  });
}

/** Stable Layout/Pane identity; Chart state and renderer bindings are volatile. */
export function stableDurableTargetIdentity(target) {
  const savedLayoutId = target?.saved_layout_id ?? null;
  return Object.freeze({
    layout_name: target?.layout_name,
    saved_layout_id: savedLayoutId,
    ...(savedLayoutId == null && {
      layout_id: target?.layout_id ?? null,
      url_chart_id: target?.url_chart_id ?? null,
    }),
    pane_index: target?.pane_index,
    pane_id: target?.pane_id ?? null,
  });
}

/** Persistable worker Pane context; current Chart Symbol/timeframe are not Run identity. */
export function durableStrategyTargetContext(target) {
  const context = sanitizeCoreContext(target) || {};
  const { symbol: _symbol, resolution: _resolution, ...workerContext } = context;
  return Object.freeze(workerContext);
}

function parameterSetFromPlan(plan) {
  return Object.freeze({
    index: plan.parameter_set.index,
    name: plan.parameter_set.name,
    requested_inputs: plan.parameter_set.requested_inputs,
    ...(plan.parameter_set.resolved_inputs != null && {
      resolved_inputs: plan.parameter_set.resolved_inputs,
    }),
    requested_inputs_fingerprint: plan.parameter_set.requested_inputs_fingerprint,
  });
}

function plannedExperiment(run, plan) {
  if (!plan || !Number.isInteger(plan?.parameter_set?.index)) {
    throw artifactInvalid('A persisted Experiment plan is required.');
  }
  const persisted = run.planned_experiments?.[plan.parameter_set.index];
  if (!persisted || !equal(persisted, plan)) {
    throw artifactInvalid('Experiment plan does not match run.json.');
  }
  return persisted;
}

function strategyIdentity(run, strategy) {
  const resolved = strategy || run.resolved.strategy;
  if (!resolved || !resolved.script_id || resolved.version == null) {
    throw artifactInvalid('A resolved Strategy identity is required for an Experiment.');
  }
  return Object.freeze({ ...resolved });
}

function targetIdentity(run, target) {
  const resolved = target || run.resolved.target;
  if (!resolved || !resolved.layout_name || !Number.isInteger(resolved.pane_index)) {
    throw artifactInvalid('A resolved target identity is required for an Experiment.');
  }
  return durableStrategyTargetContext(resolved);
}

/** Build immutable experiment.json v2 from a persisted Run plan. */
export function createDurableExperimentArtifact({
  run,
  experiment_plan,
  strategy,
  target,
  started_at = Date.now(),
} = {}) {
  const validRun = validateRunArtifactV2(run);
  const plan = plannedExperiment(validRun, experiment_plan);
  return validateExperimentArtifactV2({
    schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: validRun.run_id,
    experiment_id: plan.experiment_id,
    parameter_set: parameterSetFromPlan(plan),
    strategy: strategyIdentity(validRun, strategy),
    target: targetIdentity(validRun, target),
    base_inputs_fingerprint: validRun.base_inputs_fingerprint,
    inputs_fingerprint: plan.inputs_fingerprint,
    effective_inputs: plan.effective_inputs,
    started_at,
    started_at_iso: unixMillisecondsToIso(started_at),
  });
}

function requestedSymbols(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw artifactInvalid('A non-empty frozen requested_symbols array is required.');
  }
  return Object.freeze([...value]);
}

/** Build the initial authoritative manifest before the first Symbol attempt. */
export function createDurableExperimentManifest({
  run,
  experiment,
  requested_symbols,
  timeframe,
  format,
  started_at,
} = {}) {
  const validRun = validateRunArtifactV2(run);
  const validExperiment = validateExperimentArtifactV2(experiment);
  const symbols = requestedSymbols(requested_symbols);
  if (validExperiment.run_id !== validRun.run_id) {
    throw artifactInvalid('Experiment Run ID does not match run.json.');
  }
  if (symbols.length !== validRun.resolved.watchlist.symbol_count) {
    throw artifactInvalid('Frozen requested_symbols count does not match run.json.');
  }
  const timestamp = started_at ?? validExperiment.started_at;
  const manifest = {
    schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: validRun.run_id,
    experiment_id: validExperiment.experiment_id,
    parameter_set_name: validExperiment.parameter_set.name,
    status: 'running',
    strategy: validExperiment.strategy,
    inputs_fingerprint: validExperiment.inputs_fingerprint,
    watchlist: {
      snapshot_id: validRun.resolved.watchlist.snapshot_id,
      ordered_symbol_fingerprint: validRun.resolved.watchlist.ordered_symbol_fingerprint,
      symbol_count: symbols.length,
    },
    requested_symbols: symbols,
    timeframe,
    format,
    started_at: timestamp,
    started_at_iso: unixMillisecondsToIso(timestamp),
    updated_at: timestamp,
    updated_at_iso: unixMillisecondsToIso(timestamp),
    summary: {
      requested: symbols.length,
      pending: symbols.length,
      running: 0,
      retry_wait: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    },
    symbols: [],
  };
  return validateExperimentManifestV2(manifest);
}

function assertExperimentIdentity(actual, expected) {
  const fields = [
    'schema_version',
    'run_id',
    'experiment_id',
    'parameter_set',
    'base_inputs_fingerprint',
    'inputs_fingerprint',
    'effective_inputs',
  ];
  for (const field of fields) {
    if (!equal(actual[field], expected[field])) {
      throw artifactInvalid(`experiment.json ${field} does not match the persisted Run plan.`);
    }
  }
  if (!equal(
    stableDurableStrategyIdentity(actual.strategy),
    stableDurableStrategyIdentity(expected.strategy),
  )) {
    throw artifactInvalid('experiment.json stable Strategy identity does not match the persisted Run plan.');
  }
  if (!equal(
    stableDurableTargetIdentity(actual.target),
    stableDurableTargetIdentity(expected.target),
  )) {
    throw artifactInvalid('experiment.json stable target identity does not match the persisted Run plan.');
  }
}

function assertManifestIdentity(actual, expected) {
  const fields = [
    'schema_version',
    'run_id',
    'experiment_id',
    'parameter_set_name',
    'strategy',
    'inputs_fingerprint',
    'watchlist',
    'requested_symbols',
    'timeframe',
    'format',
  ];
  for (const field of fields) {
    if (!equal(actual[field], expected[field])) {
      throw artifactInvalid(`manifest.json ${field} does not match the Experiment plan.`);
    }
  }
}

function selectedSymbolIndices(manifest, selectedIndices) {
  const indices = selectedIndices == null
    ? manifest.requested_symbols.map((_symbol, index) => index)
    : selectedIndices;
  if (!Array.isArray(indices)) throw artifactInvalid('selected_indices must be an array.');
  const seen = new Set();
  return Object.freeze(indices.map((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= manifest.requested_symbols.length) {
      throw artifactInvalid(`Selected Symbol index is invalid: ${String(index)}.`);
    }
    if (seen.has(index)) throw artifactInvalid(`Selected Symbol index is duplicated: ${index}.`);
    seen.add(index);
    return index;
  }));
}

function assertStore(store, methods) {
  for (const method of methods) {
    if (typeof store?.[method] !== 'function') {
      throw new TypeError(`Durable Run store ${method}() is required.`);
    }
  }
}

function incompleteExperimentError(manifest) {
  return new CoreOperationError(
    `Experiment ${manifest.parameter_set_name} has incomplete or failed Symbols.`,
    { code: 'STRATEGY_EXPERIMENT_FAILED', phase: 'experiment_execution' },
  );
}

/**
 * Persist or validate immutable Experiment identity and its initial manifest.
 * Callers run this phase before applying Effective Inputs.
 */
export async function prepareDurableStrategyExperiment({
  store,
  run,
  experiment_plan,
  experiment: existingExperiment = null,
  manifest: existingManifest = null,
  requested_symbols,
  strategy,
  target,
  timeframe,
  format,
  _deps = {},
} = {}) {
  assertStore(store, ['createExperiment', 'replaceManifest']);
  const now = _deps.now || Date.now;
  const validRun = validateRunArtifactV2(run);
  const plannedArtifact = createDurableExperimentArtifact({
    run: validRun,
    experiment_plan,
    strategy: strategy || existingExperiment?.strategy,
    target: target || existingExperiment?.target,
    started_at: existingExperiment?.started_at ?? now(),
  });
  let experiment;
  if (existingExperiment == null) {
    await store.createExperiment(plannedArtifact);
    experiment = plannedArtifact;
  } else {
    experiment = validateExperimentArtifactV2(existingExperiment);
    assertExperimentIdentity(experiment, plannedArtifact);
  }

  const initialManifest = createDurableExperimentManifest({
    run: validRun,
    experiment,
    requested_symbols,
    timeframe,
    format,
  });
  let manifest;
  if (existingManifest == null) {
    manifest = initialManifest;
    await store.replaceManifest(manifest);
  } else {
    manifest = validateExperimentManifestV2(existingManifest);
    assertManifestIdentity(manifest, initialManifest);
  }
  return Object.freeze({
    run: validRun,
    experiment_plan: plannedExperiment(validRun, experiment_plan),
    experiment,
    manifest,
    requested_symbols: manifest.requested_symbols,
    timeframe: manifest.timeframe,
    format: manifest.format,
  });
}

/** Execute selected Symbols using an authoritative durable Experiment manifest. */
export async function executeDurableStrategyExperiment({
  store,
  prepared_experiment,
  run,
  experiment_plan,
  experiment: existingExperiment = null,
  manifest: existingManifest = null,
  requested_symbols,
  selected_indices,
  strategy,
  target,
  context,
  timeframe,
  format,
  signal,
  ownership_confirmed = false,
  execute_symbol_attempt,
  on_symbol_terminal,
  _deps = {},
} = {}) {
  assertStore(store, [
    'createExperiment',
    'replaceManifest',
    'cleanupUncommittedSymbolArtifacts',
    'beginSymbolAttempt',
  ]);
  if (typeof execute_symbol_attempt !== 'function') {
    throw new TypeError('execute_symbol_attempt callback is required.');
  }
  if (on_symbol_terminal != null && typeof on_symbol_terminal !== 'function') {
    throw new TypeError('on_symbol_terminal must be a function when provided.');
  }
  const now = _deps.now || Date.now;
  const prepared = prepared_experiment || await prepareDurableStrategyExperiment({
    store,
    run,
    experiment_plan,
    experiment: existingExperiment,
    manifest: existingManifest,
    requested_symbols,
    strategy,
    target,
    timeframe,
    format,
    _deps,
  });
  const validRun = validateRunArtifactV2(prepared.run);
  const experiment = validateExperimentArtifactV2(prepared.experiment);
  let manifest = validateExperimentManifestV2(prepared.manifest);
  const persistedPlan = plannedExperiment(validRun, prepared.experiment_plan);
  assertExperimentIdentity(experiment, createDurableExperimentArtifact({
    run: validRun,
    experiment_plan: persistedPlan,
    strategy: experiment.strategy,
    target: experiment.target,
    started_at: experiment.started_at,
  }));
  assertManifestIdentity(manifest, createDurableExperimentManifest({
    run: validRun,
    experiment,
    requested_symbols: prepared.requested_symbols,
    timeframe: prepared.timeframe,
    format: prepared.format,
  }));

  const indices = selectedSymbolIndices(manifest, selected_indices);
  if (manifest.status === 'succeeded') {
    if (indices.some((index) => {
      const entry = manifest.symbols.find((item) => item.index === index);
      return entry?.status !== 'succeeded';
    })) {
      throw artifactInvalid('A succeeded Experiment contains selected incomplete Symbols.');
    }
    return Object.freeze({
      success: true,
      status: 'succeeded',
      experiment,
      manifest,
      summary: manifest.summary,
      selected_count: 0,
    });
  }

  if (manifest.status !== 'running') {
    manifest = transitionExperimentState(manifest, {
      status: 'running',
      updated_at: now(),
    });
    await store.replaceManifest(manifest);
  }

  let attempted = 0;
  try {
    for (const index of indices) {
      const symbol = manifest.requested_symbols[index];
      const existing = manifest.symbols.find((entry) => entry.index === index);
      if (existing?.status === 'succeeded') continue;
      attempted += 1;
      const result = await executeStrategySymbolWithRetry({
        manifest,
        index,
        symbol,
        signal,
        onTransition: async (next, metadata) => {
          await store.replaceManifest(next);
          manifest = next;
          if (
            on_symbol_terminal
            && ['attempt_succeeded', 'attempt_failed'].includes(metadata.event)
          ) {
            const entry = next.symbols.find((item) => item.index === metadata.index);
            try {
              await on_symbol_terminal(Object.freeze({
                index: metadata.index,
                status: entry?.status,
              }));
            } catch {
              // Progress presentation cannot change durable execution correctness.
            }
          }
        },
        cleanupAttempt: ({ entry }) => store.cleanupUncommittedSymbolArtifacts({
          experiment_name: experiment.parameter_set.name,
          symbol,
          manifest_entry: entry,
          ownership_confirmed,
        }),
        beginAttempt: ({ attempt_count }) => store.beginSymbolAttempt({
          experiment_name: experiment.parameter_set.name,
          symbol,
          attempt_count,
          format: manifest.format,
        }),
        executeAttempt: (attempt) => execute_symbol_attempt(Object.freeze({
          ...attempt,
          experiment,
          experiment_plan: persistedPlan,
          context: sanitizeCoreContext(context),
        })),
        _deps: _deps.retry,
      });
      manifest = result.manifest;
    }
  } catch (error) {
    try {
      const failed = transitionExperimentState(manifest, {
        status: 'failed',
        updated_at: now(),
        error,
      });
      await store.replaceManifest(failed);
      manifest = failed;
    } catch (persistenceError) {
      if (error && typeof error === 'object' && Object.isExtensible(error)) {
        error.experiment_state_error = persistenceError;
      }
    }
    throw error;
  }

  const summary = deriveManifestSummary(manifest);
  const succeeded = summary.succeeded === summary.requested;
  manifest = transitionExperimentState(manifest, {
    status: succeeded ? 'succeeded' : 'failed',
    updated_at: now(),
    error: succeeded ? null : incompleteExperimentError(manifest),
  });
  await store.replaceManifest(manifest);
  return Object.freeze({
    success: succeeded,
    status: manifest.status,
    experiment,
    manifest,
    summary: manifest.summary,
    selected_count: attempted,
  });
}
