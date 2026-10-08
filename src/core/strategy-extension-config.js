/** Pure append-only Strategy Extension Config comparison and child planning. */
import { join } from 'node:path';
import {
  createParameterSetExecutionPlan,
  persistableParameterSetPlan,
} from './strategy-parameter-sets.js';
import {
  STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS,
  strategyLineageFingerprint,
  strategyParameterSetsFingerprint,
} from './strategy-run-lineage.js';
import { strategyRunArtifactFamily } from './strategy-run-state.js';
import { stableJsonStringify } from './stable-json.js';

function problem(code, message, path = null) {
  return Object.freeze({
    code,
    phase: 'extension_config',
    message,
    retryable: false,
    ...(path && { path }),
  });
}

function valuesEqual(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function parentArtifactVersion(run) {
  return strategyRunArtifactFamily(run) === 'v2' ? 2 : run.artifact_schema_version;
}

function extensionRequested(loaded) {
  const requested = loaded.requested;
  if (!requested?.run?.generated) return requested;
  const generated = requested.run.run_id;
  const runId = /-\d{8}T\d{6}Z-/.test(generated)
    ? generated.replace(/-(\d{8}T\d{6}Z)-/, '-extension-$1-')
    : `${generated}-extension`;
  return Object.freeze({
    ...requested,
    run: Object.freeze({ ...requested.run, run_id: runId }),
    output: Object.freeze({
      ...requested.output,
      run_path: join(requested.output.directory_path, runId),
    }),
  });
}

function stableConfigMismatch(parent, requested, lineage) {
  const comparisons = [
    ['strategy.saved_name', parent.requested.strategy.saved_name, requested.strategy.saved_name],
    ['strategy.source_sha256', parent.source_sha256, requested.strategy.source_sha256],
    ['target.layout.name', parent.requested.target.layout.name, requested.target.layout.name],
    ['target.pane_index', parent.requested.target.pane_index, requested.target.pane_index],
    ['target.watchlist.name', parent.requested.target.watchlist.name, requested.target.watchlist.name],
    ['backtest.timeframe', parent.requested.backtest.timeframe, requested.backtest.timeframe],
    ['output.format', parent.requested.output.format, requested.output.format],
    ['output.directory', lineage.output_root, requested.output.directory_path],
  ];
  return comparisons.find(([, expected, actual]) => !valuesEqual(expected, actual)) || null;
}

/** Compare the full requested sequence with immutable root→Parent requests. */
export function compareStrategyExtensionConfig({ lineage, loaded } = {}) {
  const errors = [...(loaded?.errors || [])];
  if (!lineage?.parent?.run || !loaded?.requested) {
    if (!loaded?.requested && errors.length === 0) {
      errors.push(problem('RUN_EXTENSION_CONFIG_MISMATCH', 'A valid extended Run Config is required.'));
    }
    return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  }
  const requested = extensionRequested(loaded);
  const mismatch = stableConfigMismatch(lineage.parent.run, requested, lineage);
  if (mismatch) {
    const [path, expected, actual] = mismatch;
    errors.push(problem(
      'RUN_EXTENSION_CONFIG_MISMATCH',
      `Extended Config ${path} does not match Parent (${String(actual)} !== ${String(expected)}).`,
      path,
    ));
  }
  const inherited = lineage.parameter_sets;
  const desired = requested.experiments.parameter_sets;
  const prefixLength = Math.min(inherited.length, desired.length);
  for (let index = 0; index < prefixLength; index += 1) {
    if (!valuesEqual(inherited[index], desired[index])) {
      errors.push(problem(
        'RUN_EXTENSION_EXISTING_EXPERIMENT_CHANGED',
        `Existing Parameter Set at index ${index} was changed, reordered, or replaced.`,
        `experiments.parameter_sets[${index}]`,
      ));
      break;
    }
  }
  if (desired.length < inherited.length) {
    errors.push(problem(
      'RUN_EXTENSION_EXISTING_EXPERIMENT_CHANGED',
      'Extended Config removed one or more inherited Parameter Sets.',
      'experiments.parameter_sets',
    ));
  }
  const suffix = desired.slice(inherited.length);
  if (desired.length === inherited.length && errors.length === 0) {
    errors.push(problem(
      'RUN_EXTENSION_NO_NEW_EXPERIMENTS',
      'Extended Config must append at least one new Parameter Set.',
      'experiments.parameter_sets',
    ));
  }
  const inheritedNames = new Set(inherited.map((item) => item.name));
  const suffixNames = new Set();
  for (const [index, parameterSet] of suffix.entries()) {
    if (inheritedNames.has(parameterSet.name) || suffixNames.has(parameterSet.name)) {
      errors.push(problem(
        'RUN_EXTENSION_DUPLICATE_EXPERIMENT',
        `New Parameter Set name already exists in this lineage: ${parameterSet.name}`,
        `experiments.parameter_sets[${inherited.length + index}].name`,
      ));
    }
    suffixNames.add(parameterSet.name);
  }
  if (desired.length > STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS) {
    errors.push(problem(
      'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED',
      `Extended Config exceeds ${STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS} cumulative Experiments.`,
      'experiments.parameter_sets',
    ));
  }
  const ancestorIds = new Set(lineage.chain.map((entry) => entry.artifacts.run.run_id));
  if (ancestorIds.has(requested.run.run_id)) {
    errors.push(problem(
      'RUN_EXTENSION_CONFIG_MISMATCH',
      `Child Run ID collides with an ancestor: ${requested.run.run_id}`,
      'run.run_id',
    ));
  }
  const mappings = suffix.map((parameterSet, runIndex) => Object.freeze({
    name: parameterSet.name,
    config_index: inherited.length + runIndex,
    lineage_index: inherited.length + runIndex,
    run_index: runIndex,
  }));
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    requested,
    inherited_parameter_sets: inherited,
    new_parameter_sets: Object.freeze(suffix),
    mappings: Object.freeze(mappings),
    requested_parameter_sets_fingerprint: strategyParameterSetsFingerprint(desired),
  });
}

/** Build deterministic new-only plans using the Parent's persisted Base Inputs. */
export function createStrategyExtensionPlan({
  lineage,
  comparison,
  candidate_schema,
  identity,
} = {}) {
  const errors = [...(comparison?.errors || [])];
  if (!comparison?.valid) {
    return Object.freeze({ valid: false, errors: Object.freeze(errors), parameter_sets: [] });
  }
  const parent = lineage.parent.run;
  if (
    !candidate_schema?.available
    || candidate_schema.input_schema_fingerprint !== parent.candidate_schema_fingerprint
  ) {
    errors.push(problem(
      'RUN_EXTENSION_IDENTITY_MISMATCH',
      'Candidate Pine Input schema does not match the Parent Run.',
      'strategy.file',
    ));
    return Object.freeze({ valid: false, errors: Object.freeze(errors), parameter_sets: [] });
  }
  let execution;
  try {
    execution = createParameterSetExecutionPlan({
      base_catalog: parent.base_inputs,
      candidate_schema,
      parameter_sets: comparison.new_parameter_sets,
      identity,
    });
  } catch (error) {
    errors.push(problem(
      error?.code || 'PARAMETER_SET_PLAN_INVALID',
      error?.message || String(error),
      'experiments.parameter_sets',
    ));
    return Object.freeze({ valid: false, errors: Object.freeze(errors), parameter_sets: [] });
  }
  errors.push(...execution.errors);
  if (!execution.valid) {
    return Object.freeze({ valid: false, errors: Object.freeze(errors), parameter_sets: [] });
  }
  const plannedExperiments = Object.freeze(
    execution.parameter_sets.map(persistableParameterSetPlan),
  );
  const lineageDepth = lineage.lineage_depth + 1;
  const metadata = Object.freeze({
    fingerprint_schema_version: 1,
    parent_run_id: parent.run_id,
    parent_artifact_schema_version: parentArtifactVersion(parent),
    parent_run_fingerprint: lineage.parent_run_fingerprint,
    lineage_fingerprint: strategyLineageFingerprint({
      direct_parent_run_fingerprint: lineage.parent_run_fingerprint,
      parent_lineage_fingerprint: lineage.parent_lineage_fingerprint,
      inherited_parameter_sets_fingerprint: lineage.inherited_parameter_sets_fingerprint,
      inherited_experiment_count: lineage.inherited_experiment_count,
      lineage_depth: lineageDepth,
    }),
    lineage_depth: lineageDepth,
    inherited_experiment_count: lineage.inherited_experiment_count,
    new_experiment_count: comparison.new_parameter_sets.length,
    inherited_parameter_sets_fingerprint: lineage.inherited_parameter_sets_fingerprint,
    requested_parameter_sets_fingerprint: comparison.requested_parameter_sets_fingerprint,
    new_parameter_sets: comparison.mappings,
  });
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    requested: comparison.requested,
    base_inputs: execution.base_inputs,
    base_inputs_fingerprint: execution.base_inputs_fingerprint,
    parameter_sets: execution.parameter_sets,
    planned_experiments: plannedExperiments,
    extension: metadata,
  });
}
