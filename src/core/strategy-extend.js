/** Append-only Strategy Run Extension preflight and formal orchestration. */
import { lstat as nodeLstat } from 'node:fs/promises';
import { CoreOperationError } from './errors.js';
import { loadStrategyRunConfig } from './strategy-run-config.js';
import { loadStrategyRunLineage } from './strategy-run-lineage.js';
import {
  compareStrategyExtensionConfig,
  createStrategyExtensionPlan,
} from './strategy-extension-config.js';
import { resolveStrategyResumeIdentity } from './strategy-resume.js';
import {
  durableStrategyTargetContext,
  stableDurableStrategyIdentity,
  stableDurableTargetIdentity,
} from './strategy-durable-experiment.js';
import { pendingWatchlistSymbolValidation } from './watchlist.js';
import { strategyRunArtifactVersionFields } from './strategy-run-state.js';
import { unixMillisecondsToIso } from './time.js';
import { stableJsonStringify } from './stable-json.js';
import { executePreparedDurableRun } from './strategy-durable-run-lifecycle.js';
import { emitStrategyAutomationStatus } from './strategy-progress.js';

function diagnostic(error, fallbackCode = 'RUN_EXTENSION_LINEAGE_INVALID') {
  return Object.freeze({
    code: error?.code || fallbackCode,
    phase: error?.phase || 'extension_preflight',
    message: String(error?.message || error || fallbackCode).slice(0, 1000),
    retryable: error?.retryable === true,
  });
}

function identityDiagnostic(error) {
  if (error?.code !== 'RUN_RESUME_IDENTITY_MISMATCH') {
    return diagnostic(error, 'RUN_EXTENSION_IDENTITY_MISMATCH');
  }
  return Object.freeze({
    code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
    phase: 'extension_identity',
    message: String(error.message || error).slice(0, 1000),
    retryable: false,
  });
}

function publicPreflight(preflight) {
  const { _internal, ...response } = preflight;
  return response;
}

function allLineagePlans(lineage) {
  return Object.freeze(lineage.chain.flatMap(
    (entry) => entry.artifacts.run.planned_experiments || [],
  ));
}

function extensionIdentityRun(lineage, requested) {
  const parent = lineage.parent.run;
  return Object.freeze({
    ...parent,
    requested: Object.freeze({
      ...parent.requested,
      strategy: Object.freeze({
        ...parent.requested.strategy,
        file: requested.strategy.file,
        file_path: requested.strategy.file_path,
        source_sha256: requested.strategy.source_sha256,
      }),
    }),
    planned_experiments: allLineagePlans(lineage),
  });
}

async function resolveExtensionIdentity({ lineage, comparison, _deps }) {
  const run = extensionIdentityRun(lineage, comparison.requested);
  const resolveIdentity = _deps.resolveStrategyResumeIdentity || resolveStrategyResumeIdentity;
  return resolveIdentity({
    local: Object.freeze({ artifacts: Object.freeze({ run }) }),
    _deps: _deps.identity,
  });
}

async function outputCollision(path, _deps) {
  const lstat = _deps.lstat || nodeLstat;
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Validate Parent lineage, full Config, runtime identity, and new-only plans without writes. */
export async function dryRunStrategyExtension({
  run_directory,
  config_path,
  _include_internal = false,
  _deps = {},
} = {}) {
  const errors = [];
  const warnings = [];
  let lineage;
  try {
    const loadLineage = _deps.loadStrategyRunLineage || loadStrategyRunLineage;
    lineage = await loadLineage({ run_directory, _deps: _deps.lineage });
  } catch (error) {
    errors.push(diagnostic(error, 'RUN_EXTENSION_PARENT_NOT_FOUND'));
  }
  const loadConfig = _deps.loadStrategyRunConfig || loadStrategyRunConfig;
  const loaded = await loadConfig({ config_path, _deps: _deps.config });
  warnings.push(...(loaded.warnings || []));
  if (!lineage) {
    errors.push(...(loaded.errors || []));
    return Object.freeze({
      success: false,
      valid: false,
      dry_run: true,
      parent: null,
      extension: null,
      blocked: Object.freeze(['lineage']),
      warnings: Object.freeze(warnings),
      errors: Object.freeze(errors),
    });
  }
  const compare = _deps.compareStrategyExtensionConfig || compareStrategyExtensionConfig;
  const comparison = compare({ lineage, loaded });
  errors.push(...comparison.errors);
  if (!comparison.valid) {
    return Object.freeze({
      success: false,
      valid: false,
      dry_run: true,
      parent: Object.freeze({
        run_id: lineage.parent.run.run_id,
        lineage_depth: lineage.lineage_depth,
        experiments_inherited: lineage.inherited_experiment_count,
      }),
      extension: null,
      blocked: Object.freeze(['runtime_identity', 'execution']),
      warnings: Object.freeze(warnings),
      errors: Object.freeze(errors),
    });
  }
  try {
    if (await outputCollision(comparison.requested.output.run_path, _deps.fs || {})) {
      errors.push(diagnostic(new CoreOperationError(
        `Run output already exists: ${comparison.requested.output.run_path}`,
        { code: 'RUN_OUTPUT_EXISTS', phase: 'output_validation' },
      )));
    }
  } catch (error) {
    errors.push(diagnostic(error, 'RUN_OUTPUT_INVALID'));
  }
  if (errors.length > 0) {
    return Object.freeze({
      success: false,
      valid: false,
      dry_run: true,
      parent: Object.freeze({
        run_id: lineage.parent.run.run_id,
        lineage_depth: lineage.lineage_depth,
        experiments_inherited: lineage.inherited_experiment_count,
      }),
      extension: null,
      blocked: Object.freeze(['runtime_identity', 'execution']),
      warnings: Object.freeze(warnings),
      errors: Object.freeze(errors),
    });
  }

  let identity;
  try {
    identity = await resolveExtensionIdentity({ lineage, comparison, _deps });
  } catch (error) {
    errors.push(identityDiagnostic(error));
  }
  const createPlan = _deps.createStrategyExtensionPlan || createStrategyExtensionPlan;
  const plan = identity ? createPlan({
    lineage,
    comparison,
    candidate_schema: identity.candidate_schema,
    identity: identity.strategy,
  }) : null;
  errors.push(...(plan?.errors || []));
  const valid = errors.length === 0 && plan?.valid === true;
  const response = {
    success: valid,
    valid,
    dry_run: true,
    parent: Object.freeze({
      run_id: lineage.parent.run.run_id,
      lineage_depth: lineage.lineage_depth,
      experiments_inherited: lineage.inherited_experiment_count,
    }),
    extension: Object.freeze({
      run_id: comparison.requested.run.run_id,
      lineage_depth: lineage.lineage_depth + 1,
      experiments_requested: comparison.requested.experiments.parameter_sets.length,
      experiments_new: comparison.new_parameter_sets.length,
      new_parameter_sets: Object.freeze(comparison.new_parameter_sets.map((item) => item.name)),
    }),
    blocked: Object.freeze(valid ? [] : ['execution']),
    warnings: Object.freeze(warnings),
    errors: Object.freeze(errors),
  };
  if (!_include_internal || !valid) return Object.freeze(response);
  return Object.freeze({
    ...response,
    _internal: Object.freeze({ lineage, loaded, comparison, identity, plan }),
  });
}

function initialExtensionRun({ internal, started_at }) {
  const { lineage, loaded, comparison, identity, plan } = internal;
  const requested = comparison.requested;
  const { schema_version: configSchemaVersion, ...requestedFields } = requested;
  const persistedRequested = Object.freeze({
    config_schema_version: configSchemaVersion,
    ...requestedFields,
    experiments: Object.freeze({ parameter_sets: comparison.new_parameter_sets }),
  });
  const parentWatchlist = lineage.parent.run.resolved.watchlist;
  return Object.freeze({
    ...strategyRunArtifactVersionFields('v4'),
    run_kind: 'extension',
    run_id: requested.run.run_id,
    status: 'running',
    requested: persistedRequested,
    config: Object.freeze({ path: loaded.config_path, sha256: loaded.config_sha256 }),
    source_sha256: requested.strategy.source_sha256,
    candidate_schema_fingerprint: identity.candidate_schema.input_schema_fingerprint,
    resolved: Object.freeze({
      target: durableStrategyTargetContext(identity.target),
      strategy: identity.strategy,
      watchlist: Object.freeze({ ...parentWatchlist }),
    }),
    base_inputs: plan.base_inputs,
    base_inputs_fingerprint: plan.base_inputs_fingerprint,
    planned_experiments: plan.planned_experiments,
    extension: plan.extension,
    started_at,
    started_at_iso: unixMillisecondsToIso(started_at),
    updated_at: started_at,
    updated_at_iso: unixMillisecondsToIso(started_at),
    summary: Object.freeze({}),
    experiments: Object.freeze([]),
    error: null,
  });
}

function preparedExtension(plan, identity, context) {
  return Object.freeze({
    valid: true,
    errors: Object.freeze([]),
    identity,
    context,
    base_inputs: plan.base_inputs,
    base_inputs_fingerprint: plan.base_inputs_fingerprint,
    planned_experiments: plan.planned_experiments,
    parameter_sets: plan.parameter_sets,
  });
}

function sameStableIdentity(left, right) {
  return stableJsonStringify({
    strategy: stableDurableStrategyIdentity(left.strategy),
    target: stableDurableTargetIdentity(left.target),
  }) === stableJsonStringify({
    strategy: stableDurableStrategyIdentity(right.strategy),
    target: stableDurableTargetIdentity(right.target),
  });
}

/** Create one immutable-parent, new-only Extension Run Directory. */
export async function extendStrategyAutomation({
  run_directory,
  config_path,
  signal,
  on_progress,
  on_status,
  _deps = {},
} = {}) {
  await emitStrategyAutomationStatus(on_status, 'preflight');
  const runPreflight = _deps.dryRunStrategyExtension || dryRunStrategyExtension;
  const preflight = await runPreflight({
    run_directory,
    config_path,
    _include_internal: true,
    _deps: _deps.preflight || _deps,
  });
  if (!preflight.valid || !preflight._internal) {
    return Object.freeze({ ...publicPreflight(preflight), dry_run: false, phase: 'preflight' });
  }
  const internal = preflight._internal;
  const now = _deps.now || Date.now;
  const run = initialExtensionRun({ internal, started_at: now() });
  const parentWatchlist = internal.lineage.parent.watchlist;
  const frozenWatchlist = Object.freeze({
    ...parentWatchlist,
    symbol_validation: pendingWatchlistSymbolValidation({
      timeframe: run.requested.backtest.timeframe,
    }),
  });
  const context = durableStrategyTargetContext(internal.identity.target);
  let lockedIdentity = internal.identity;
  let lockedPlan = internal.plan;
  const executeLifecycle = _deps.executePreparedDurableRun || executePreparedDurableRun;
  return executeLifecycle({
    spec: Object.freeze({
      run_kind: 'extension',
      run,
      output_directory: internal.lineage.output_root,
      frozen_watchlist: frozenWatchlist,
      context,
      response_fields: Object.freeze({
        run_kind: 'extension',
        parent_run_id: internal.lineage.parent.run.run_id,
        experiments_inherited: internal.lineage.inherited_experiment_count,
        experiments_new: internal.comparison.new_parameter_sets.length,
      }),
      prepare_creation: async () => {
        const loadLineage = _deps.loadStrategyRunLineage || loadStrategyRunLineage;
        const loadConfig = _deps.loadStrategyRunConfig || loadStrategyRunConfig;
        const [currentLineage, currentConfig] = await Promise.all([
          loadLineage({ run_directory, _deps: _deps.lineage }),
          loadConfig({ config_path, _deps: _deps.config }),
        ]);
        if (
          currentLineage.parent_run_fingerprint !== internal.lineage.parent_run_fingerprint
          || currentConfig.config_sha256 !== internal.loaded.config_sha256
          || currentConfig.requested?.strategy?.source_sha256
            !== internal.loaded.requested.strategy.source_sha256
        ) {
          throw new CoreOperationError('Parent or Config changed after Extension preflight.', {
            code: 'RUN_EXTENSION_LINEAGE_INVALID',
            phase: 'extension_precreate',
          });
        }
        const currentIdentity = await resolveExtensionIdentity({
          lineage: currentLineage,
          comparison: internal.comparison,
          _deps,
        });
        if (!sameStableIdentity(internal.identity, currentIdentity)) {
          throw new CoreOperationError('Strategy or Pane identity changed after Extension preflight.', {
            code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
            phase: 'extension_identity',
          });
        }
        const currentPlan = createStrategyExtensionPlan({
          lineage: currentLineage,
          comparison: internal.comparison,
          candidate_schema: currentIdentity.candidate_schema,
          identity: currentIdentity.strategy,
        });
        if (
          !currentPlan.valid
          || stableJsonStringify(currentPlan.planned_experiments)
            !== stableJsonStringify(internal.plan.planned_experiments)
        ) {
          throw new CoreOperationError('Extension plan changed after child initialization.', {
            code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
            phase: 'extension_identity',
          });
        }
        lockedIdentity = currentIdentity;
        lockedPlan = currentPlan;
      },
      prepare_execution: async () => {
        await emitStrategyAutomationStatus(on_status, 'preparing_experiments');
        return Object.freeze({
          run,
          strategy: lockedIdentity.strategy,
          prepared: preparedExtension(lockedPlan, lockedIdentity.strategy, context),
        });
      },
    }),
    signal,
    on_progress,
    on_status,
    _deps,
  });
}
