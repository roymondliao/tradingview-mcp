/** Refresh a frozen experiment collection through the shared durable lifecycle. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { CoreOperationError } from './errors.js';
import { generateStrategyRunId } from './strategy-run-config.js';
import { loadStrategyRunLineage } from './strategy-run-lineage.js';
import { createParameterSetExecutionPlan, persistableParameterSetPlan } from './strategy-parameter-sets.js';
import { resolveStrategyResumeIdentity, validateStrategyRunEvidence } from './strategy-resume.js';
import {
  durableStrategyTargetContext,
  stableDurableStrategyIdentity,
  stableDurableTargetIdentity,
} from './strategy-durable-experiment.js';
import { executePreparedDurableRun } from './strategy-durable-run-lifecycle.js';
import { pendingWatchlistSymbolValidation } from './watchlist.js';
import { strategyRunArtifactVersionFields } from './strategy-run-state.js';
import { stableJsonStringify } from './stable-json.js';
import { unixMillisecondsToIso } from './time.js';
import { emitStrategyAutomationStatus } from './strategy-progress.js';
import { createStrategyErrorBoundary } from './strategy-error-policy.js';

const updateBoundary = createStrategyErrorBoundary({
  phase: 'update_preflight',
  translations: Object.fromEntries([
    ['RUN_EXTENSION_PARENT_NOT_FOUND', 'RUN_UPDATE_SOURCE_NOT_FOUND', 'artifact'],
    ['RUN_EXTENSION_PARENT_NOT_SUCCEEDED', 'RUN_UPDATE_SOURCE_NOT_SUCCEEDED', 'conflict'],
    ['RUN_EXTENSION_LINEAGE_INVALID', 'RUN_UPDATE_LINEAGE_INVALID', 'artifact'],
    ['RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED', 'RUN_UPDATE_LINEAGE_LIMIT_EXCEEDED', 'validation'],
    ['RUN_RESUME_ARTIFACT_INVALID', 'RUN_UPDATE_LINEAGE_INVALID', 'artifact'],
    ['RUN_RESUME_IDENTITY_MISMATCH', 'RUN_UPDATE_IDENTITY_MISMATCH', 'identity'],
  ].map(([from, code, kind]) => [from, { code, kind }])),
});

function updateError(message, code = 'RUN_UPDATE_IDENTITY_MISMATCH') {
  return new CoreOperationError(message, {
    code,
    kind: code === 'RUN_UPDATE_LINEAGE_INVALID' ? 'artifact' : 'identity',
    phase: 'update_preflight',
  });
}

function equal(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

async function loadSource(runDirectory, deps) {
  return (deps.loadStrategyRunLineage || loadStrategyRunLineage)({
    run_directory: runDirectory,
    require_extension_capacity: false,
    _deps: deps.lineage,
  });
}

async function prepareUpdate(lineage, deps) {
  const source = lineage.parent.run;
  for (const { artifacts } of lineage.chain) validateStrategyRunEvidence(artifacts);
  const previousPlans = lineage.chain.flatMap(({ artifacts }) => artifacts.run.planned_experiments);
  // Runtime rebinding may match any experiment in the source collection.
  const identity = await (deps.resolveStrategyResumeIdentity || resolveStrategyResumeIdentity)({
    local: { artifacts: { run: { ...source, planned_experiments: previousPlans } } },
    _deps: deps.identity,
  });
  if (identity.candidate_schema?.input_schema_fingerprint !== source.candidate_schema_fingerprint) {
    throw updateError('Candidate schema differs from the source Run.');
  }
  for (const { artifacts: { run } } of lineage.chain) {
    if (!equal(run.base_inputs_fingerprint, source.base_inputs_fingerprint)
      || !equal(run.base_inputs, source.base_inputs)
      || !equal(run.requested.backtest, source.requested.backtest)
      || !equal(stableDurableTargetIdentity(run.resolved.target), stableDurableTargetIdentity(source.resolved.target))
      || !equal(run.resolved.watchlist, source.resolved.watchlist)
      || !equal(stableDurableStrategyIdentity(run.resolved.strategy), stableDurableStrategyIdentity(source.resolved.strategy))) {
      throw updateError('Source lineage contains inconsistent experiment conditions.', 'RUN_UPDATE_LINEAGE_INVALID');
    }
  }
  const execution = createParameterSetExecutionPlan({
    base_catalog: source.base_inputs,
    candidate_schema: identity.candidate_schema,
    parameter_sets: lineage.parameter_sets,
    identity: identity.strategy,
  });
  if (!execution.valid) throw updateError(execution.errors.map((item) => item.message).join('; '));
  const plans = execution.parameter_sets.map(persistableParameterSetPlan);
  if (!equal(execution.base_inputs_fingerprint, source.base_inputs_fingerprint)
    || plans.length !== previousPlans.length
    || plans.some((plan, index) => (
      plan.parameter_set.name !== previousPlans[index].parameter_set.name
      || !equal(plan.effective_inputs, previousPlans[index].effective_inputs)
      || !equal(plan.inputs_fingerprint, previousPlans[index].inputs_fingerprint)
      || plan.parameter_set.requested_inputs_fingerprint !== previousPlans[index].parameter_set.requested_inputs_fingerprint
    ))) {
    throw updateError('Rebuilt experiments differ from the persisted source plans.');
  }
  return { identity, execution, plans };
}

/** Read-only validation; no original Config or user-supplied date is required. */
export async function dryRunStrategyUpdate({ run_directory, _include_internal = false, _deps = {} } = {}) {
  try {
    const lineage = await loadSource(run_directory, _deps);
    const source = lineage.parent.run;
    const runId = generateStrategyRunId({
      strategy_name: source.requested.strategy.saved_name,
      now: (_deps.now || Date.now)(),
      random_suffix: _deps.random_suffix,
    }).replace(/-(\d{8}T\d{6}Z)-/, '-update-$1-');
    const runPath = join(lineage.output_root, runId);
    try {
      await (_deps.fs?.lstat || lstat)(runPath);
      throw new CoreOperationError(`Run output already exists: ${runPath}`, {
        code: 'RUN_OUTPUT_EXISTS', kind: 'conflict', phase: 'output_validation',
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        if (error instanceof CoreOperationError) throw error;
        throw new CoreOperationError(`Unable to check Update output: ${runPath}`, {
          code: 'RUN_OUTPUT_INVALID', kind: 'filesystem', phase: 'output_validation', cause: error,
        });
      }
    }
    const prepared = await prepareUpdate(lineage, _deps);
    const { schema_version, config_schema_version, ...fields } = source.requested;
    const requested = {
      config_schema_version: config_schema_version || schema_version,
      ...fields,
      run: { ...source.requested.run, run_id: runId, generated: true },
      experiments: { parameter_sets: lineage.parameter_sets },
      output: {
        ...source.requested.output,
        directory: lineage.output_root,
        directory_path: lineage.output_root,
        run_path: runPath,
      },
    };
    const response = {
      success: true, valid: true, dry_run: true,
      source_run_id: source.run_id,
      update: {
        run_id: runId,
        run_directory: runPath,
        experiments_updated: lineage.parameter_sets.length,
        symbols_per_experiment: source.resolved.watchlist.symbol_count,
      },
      errors: [], warnings: [], blocked: [],
    };
    return Object.freeze({
      ...response,
      ...(_include_internal && { _internal: { lineage, requested, ...prepared } }),
    });
  } catch (error) {
    return Object.freeze({
      success: false, valid: false, dry_run: true,
      errors: [updateBoundary.diagnostic(error)], warnings: [], blocked: ['execution'],
    });
  }
}

/** Create a self-contained Update root; old results are provenance, not inherited work. */
export async function updateStrategyAutomation({ run_directory, signal, on_progress, on_status, _deps = {} } = {}) {
  await emitStrategyAutomationStatus(on_status, 'preflight');
  const preflight = await dryRunStrategyUpdate({ run_directory, _include_internal: true, _deps });
  const { _internal: internal, ...response } = preflight;
  if (!preflight.valid) return { ...response, dry_run: false, phase: 'preflight' };
  const { lineage, requested } = internal;
  const source = lineage.parent.run;
  const startedAt = (_deps.now || Date.now)();
  const context = durableStrategyTargetContext(internal.identity.target);
  const run = {
    ...strategyRunArtifactVersionFields('v5'),
    run_kind: 'update',
    run_id: requested.run.run_id,
    status: 'running',
    requested,
    config: source.config,
    source_sha256: source.source_sha256,
    candidate_schema_fingerprint: source.candidate_schema_fingerprint,
    resolved: {
      target: context,
      strategy: internal.identity.strategy,
      watchlist: source.resolved.watchlist,
    },
    base_inputs: internal.execution.base_inputs,
    base_inputs_fingerprint: internal.execution.base_inputs_fingerprint,
    planned_experiments: internal.plans,
    update: {
      fingerprint_schema_version: 1,
      source_run_id: source.run_id,
      source_artifact_schema_version: source.artifact_schema_version || source.schema_version,
      source_run_fingerprint: lineage.parent_run_fingerprint,
      source_lineage_fingerprint: lineage.parent_lineage_fingerprint,
      parameter_sets_fingerprint: lineage.inherited_parameter_sets_fingerprint,
      experiment_count: lineage.parameter_sets.length,
    },
    started_at: startedAt,
    started_at_iso: unixMillisecondsToIso(startedAt),
    updated_at: startedAt,
    updated_at_iso: unixMillisecondsToIso(startedAt),
    summary: {}, experiments: [], error: null,
  };
  let locked = internal;
  return (_deps.executePreparedDurableRun || executePreparedDurableRun)({
    spec: {
      run_kind: 'update', run, context,
      output_directory: lineage.output_root,
      frozen_watchlist: {
        ...lineage.parent.watchlist,
        symbol_validation: pendingWatchlistSymbolValidation({ timeframe: requested.backtest.timeframe }),
      },
      prepare_creation: async () => {
        try {
          const current = await loadSource(run_directory, _deps);
          if (current.parent_run_fingerprint !== lineage.parent_run_fingerprint
            || current.parent_lineage_fingerprint !== lineage.parent_lineage_fingerprint
            || current.inherited_parameter_sets_fingerprint !== lineage.inherited_parameter_sets_fingerprint) {
            throw updateError('Source changed after Update preflight.', 'RUN_UPDATE_LINEAGE_INVALID');
          }
          const prepared = await prepareUpdate(current, _deps);
          if (!equal(stableDurableTargetIdentity(prepared.identity.target), stableDurableTargetIdentity(internal.identity.target))
            || !equal(stableDurableStrategyIdentity(prepared.identity.strategy), stableDurableStrategyIdentity(internal.identity.strategy))
            || prepared.identity.target.target_id !== internal.identity.target.target_id
            || prepared.identity.strategy.entity_id !== internal.identity.strategy.entity_id
            || !equal(prepared.plans, internal.plans)) {
            throw updateError('Update plan or runtime identity changed after preflight.');
          }
          locked = prepared;
        } catch (error) {
          throw updateBoundary.error(error);
        }
      },
      prepare_execution: async () => {
        await emitStrategyAutomationStatus(on_status, 'preparing_experiments');
        return {
          run,
          strategy: locked.identity.strategy,
          prepared: {
            ...locked.execution,
            planned_experiments: locked.plans,
            identity: locked.identity.strategy,
            context,
          },
        };
      },
    },
    signal, on_progress, on_status, _deps,
  });
}
