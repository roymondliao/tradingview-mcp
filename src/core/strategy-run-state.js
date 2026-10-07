/** Pure Strategy Run artifact validation, transitions, summaries, and resume planning. */
import { isAbsolute } from 'node:path';
import { CoreOperationError } from './errors.js';
import { stableJsonStringify } from './stable-json.js';
import { unixMillisecondsToIso } from './time.js';

export const STRATEGY_RUN_ARTIFACT_VERSION = 3;
export const STRATEGY_RUN_LEGACY_ARTIFACT_VERSION = 2;
export const STRATEGY_RUN_ARTIFACT_FAMILIES = Object.freeze(['v2', 'v3']);
export const STRATEGY_RUN_STATUSES = Object.freeze(['running', 'succeeded', 'failed']);
export const STRATEGY_SYMBOL_STATUSES = Object.freeze([
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'skipped',
]);

const RUN_FIELDS = Object.freeze([
  'run_id',
  'status',
  'requested',
  'config',
  'source_sha256',
  'candidate_schema_fingerprint',
  'resolved',
  'base_inputs',
  'base_inputs_fingerprint',
  'planned_experiments',
  'started_at',
  'started_at_iso',
  'updated_at',
  'updated_at_iso',
  'summary',
  'experiments',
  'error',
]);
const EXPERIMENT_FIELDS = Object.freeze([
  'run_id',
  'experiment_id',
  'parameter_set',
  'strategy',
  'target',
  'base_inputs_fingerprint',
  'inputs_fingerprint',
  'effective_inputs',
  'started_at',
  'started_at_iso',
]);
const MANIFEST_FIELDS = Object.freeze([
  'run_id',
  'experiment_id',
  'parameter_set_name',
  'status',
  'strategy',
  'inputs_fingerprint',
  'watchlist',
  'requested_symbols',
  'timeframe',
  'format',
  'schema_versions',
  'started_at',
  'started_at_iso',
  'updated_at',
  'updated_at_iso',
  'summary',
  'symbols',
  'chart_restore',
  'error',
]);
const SYMBOL_FIELDS = Object.freeze([
  'index',
  'requested_symbol',
  'resolved_symbol',
  'status',
  'attempt_count',
  'updated_at',
  'updated_at_iso',
  'snapshot_id',
  'total_trades',
  'batch_count',
  'artifacts',
  'error',
]);
const ERROR_FIELDS = Object.freeze(['code', 'phase', 'message']);
const ARTIFACT_FIELDS = Object.freeze(['report', 'trades', 'reconciliation']);
const SUMMARY_FIELDS = Object.freeze([
  'requested',
  'pending',
  'running',
  'retry_wait',
  'succeeded',
  'failed',
  'skipped',
]);
const PARAMETER_SET_FIELDS = Object.freeze([
  'index',
  'name',
  'requested_inputs',
  'resolved_inputs',
  'requested_inputs_fingerprint',
]);
const PLANNED_EXPERIMENT_FIELDS = Object.freeze([
  'experiment_id',
  'parameter_set',
  'inputs_fingerprint',
  'effective_inputs',
]);
const REQUESTED_FIELDS = Object.freeze([
  'run',
  'strategy',
  'target',
  'backtest',
  'experiments',
  'output',
]);
const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PARAMETER_SET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const SHA256_ID_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const OUTPUT_FORMATS = Object.freeze(['json', 'jsonl', 'csv']);

function artifactError(message, { code = 'RUN_RESUME_ARTIFACT_INVALID', phase = 'resume_validation' } = {}) {
  return new CoreOperationError(message, { code, phase });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) throw artifactError(`${label} must be an object.`);
}

function assertAllowedFields(value, allowed, label) {
  assertObject(value, label);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw artifactError(`${label} contains an unknown field: ${key}.`);
  }
}

function assertNonEmptyString(value, label, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw artifactError(`${label} must be a non-empty string up to ${maximum} characters.`);
  }
}

function assertOptionalObject(value, label) {
  if (value != null) assertObject(value, label);
}

function valuesEqual(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function assertTimestamp(value, iso, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw artifactError(`${label} must be a non-negative integer timestamp.`);
  }
  if (iso !== unixMillisecondsToIso(value)) {
    throw artifactError(`${label}_iso does not match ${label}.`);
  }
}

function hasOwn(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function assertExpectedFamily(family, label = 'Artifact family') {
  if (family != null && !STRATEGY_RUN_ARTIFACT_FAMILIES.includes(family)) {
    throw new TypeError(`${label} must be v2 or v3.`);
  }
}

export function strategyRunArtifactFamily(value, label = 'artifact') {
  assertObject(value, label);
  const hasLegacy = hasOwn(value, 'schema_version');
  const hasExplicit = hasOwn(value, 'artifact_schema_version');
  if (hasLegacy && hasExplicit) {
    throw artifactError(
      `${label} must not contain both schema_version and artifact_schema_version.`,
    );
  }
  if (!hasLegacy && !hasExplicit) {
    throw artifactError(
      `${label} must contain exactly one artifact schema version field.`,
    );
  }
  if (hasLegacy) {
    if (value.schema_version !== STRATEGY_RUN_LEGACY_ARTIFACT_VERSION) {
      throw artifactError(
        `${label} schema_version ${String(value.schema_version)} is not resumable; expected ${STRATEGY_RUN_LEGACY_ARTIFACT_VERSION}.`,
        { code: 'RUN_RESUME_VERSION_UNSUPPORTED' },
      );
    }
    return 'v2';
  }
  if (value.artifact_schema_version !== STRATEGY_RUN_ARTIFACT_VERSION) {
    throw artifactError(
      `${label} artifact_schema_version ${String(value.artifact_schema_version)} is not resumable; expected ${STRATEGY_RUN_ARTIFACT_VERSION}.`,
      { code: 'RUN_RESUME_VERSION_UNSUPPORTED' },
    );
  }
  return 'v3';
}

export function strategyRunArtifactVersionFields(family = 'v3') {
  assertExpectedFamily(family);
  return family === 'v2'
    ? Object.freeze({ schema_version: STRATEGY_RUN_LEGACY_ARTIFACT_VERSION })
    : Object.freeze({ artifact_schema_version: STRATEGY_RUN_ARTIFACT_VERSION });
}

function artifactFields(fields, family) {
  return family === 'v2'
    ? ['schema_version', ...fields]
    : ['artifact_schema_version', ...fields];
}

function assertArtifactFamily(value, label, expectedFamily) {
  assertExpectedFamily(expectedFamily, `${label} expected family`);
  const family = strategyRunArtifactFamily(value, label);
  if (expectedFamily != null && family !== expectedFamily) {
    throw artifactError(`${label} artifact family ${family} does not match expected ${expectedFamily}.`);
  }
  return family;
}

function assertRequestedConfigVersion(requested, family) {
  assertObject(requested, 'run.json.requested');
  const hasLegacy = hasOwn(requested, 'schema_version');
  const hasExplicit = hasOwn(requested, 'config_schema_version');
  if (hasLegacy && hasExplicit) {
    throw artifactError(
      'run.json.requested must not contain both schema_version and config_schema_version.',
    );
  }
  const field = family === 'v2' ? 'schema_version' : 'config_schema_version';
  const unexpected = family === 'v2' ? 'config_schema_version' : 'schema_version';
  if (hasOwn(requested, unexpected) || requested[field] !== 1) {
    throw artifactError(`run.json.requested.${field} must be 1 for artifact ${family}.`);
  }
  assertAllowedFields(requested, [field, ...REQUESTED_FIELDS], 'run.json.requested');
}

function assertRunId(runId, label = 'run_id') {
  assertNonEmptyString(runId, label, 200);
  if (!RUN_ID_PATTERN.test(runId) || runId === '.' || runId === '..') {
    throw artifactError(`${label} must be one safe path segment.`);
  }
}

function assertExperimentId(experimentId, label = 'experiment_id') {
  assertNonEmptyString(experimentId, label, 100);
  if (!SHA256_ID_PATTERN.test(experimentId)) {
    throw artifactError(`${label} must be a sha256 identity.`);
  }
}

function assertParameterSetName(name, label = 'parameter_set_name') {
  assertNonEmptyString(name, label, 100);
  if (!PARAMETER_SET_NAME_PATTERN.test(name)) {
    throw artifactError(`${label} must be one path-safe Parameter Set name.`);
  }
}

function assertStatus(status, allowed, label) {
  if (!allowed.includes(status)) {
    throw artifactError(`${label} has unsupported status: ${String(status)}.`);
  }
}

function assertSafeArtifactReference(value, label) {
  assertNonEmptyString(value, label, 2000);
  if (value.includes('\0') || isAbsolute(value)) {
    throw artifactError(`${label} must be a safe relative artifact path.`);
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw artifactError(`${label} contains an unsafe path segment.`);
  }
}

function freezeRecord(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRecord));
  if (!isObject(value)) return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, freezeRecord(item)]),
  ));
}

export function sanitizeStrategyRunError(error, {
  fallback_code = 'STRATEGY_RUN_FAILED',
  fallback_phase = 'strategy_run_execution',
} = {}) {
  const value = error?.error && isObject(error.error) ? error.error : error;
  return Object.freeze({
    code: String(value?.code || fallback_code).slice(0, 100),
    phase: String(value?.phase || fallback_phase).slice(0, 100),
    message: String(value?.message || value || fallback_code).slice(0, 1000),
  });
}

function assertError(value, label, { required = false } = {}) {
  if (value == null) {
    if (required) throw artifactError(`${label} is required.`);
    return;
  }
  assertAllowedFields(value, ERROR_FIELDS, label);
  assertNonEmptyString(value.code, `${label}.code`, 100);
  assertNonEmptyString(value.phase, `${label}.phase`, 100);
  assertNonEmptyString(value.message, `${label}.message`, 1000);
}

function assertFormat(value, label = 'format') {
  if (!OUTPUT_FORMATS.includes(value)) {
    throw artifactError(`${label} must be one of: ${OUTPUT_FORMATS.join(', ')}.`);
  }
}

function assertParameterSet(value, label) {
  assertAllowedFields(value, PARAMETER_SET_FIELDS, label);
  if (!Number.isInteger(value.index) || value.index < 0) {
    throw artifactError(`${label}.index must be a non-negative integer.`);
  }
  assertParameterSetName(value.name, `${label}.name`);
  assertObject(value.requested_inputs, `${label}.requested_inputs`);
  if (value.resolved_inputs != null && !Array.isArray(value.resolved_inputs)) {
    throw artifactError(`${label}.resolved_inputs must be an array when present.`);
  }
  assertNonEmptyString(
    value.requested_inputs_fingerprint,
    `${label}.requested_inputs_fingerprint`,
    200,
  );
}

function plannedExperimentIdentity(plan, index) {
  assertAllowedFields(
    plan,
    PLANNED_EXPERIMENT_FIELDS,
    `run.planned_experiments[${index}]`,
  );
  assertExperimentId(plan.experiment_id, `run.planned_experiments[${index}].experiment_id`);
  assertParameterSet(plan.parameter_set, `run.planned_experiments[${index}].parameter_set`);
  if (plan.parameter_set.index !== index) {
    throw artifactError(`run.planned_experiments[${index}] has a mismatched Parameter Set index.`);
  }
  assertObject(plan.inputs_fingerprint, `run.planned_experiments[${index}].inputs_fingerprint`);
  if (!Array.isArray(plan.effective_inputs)) {
    throw artifactError(`run.planned_experiments[${index}].effective_inputs must be an array.`);
  }
  return {
    experiment_id: plan.experiment_id,
    index,
    name: plan.parameter_set.name,
    inputs_fingerprint: plan.inputs_fingerprint,
  };
}

export function validateRunArtifact(value, { expected_family } = {}) {
  const family = assertArtifactFamily(value, 'run.json', expected_family);
  assertAllowedFields(value, artifactFields(RUN_FIELDS, family), 'run.json');
  assertRunId(value.run_id);
  assertStatus(value.status, STRATEGY_RUN_STATUSES, 'run.json');
  assertRequestedConfigVersion(value.requested, family);
  assertObject(value.config, 'run.json.config');
  assertNonEmptyString(value.config.path, 'run.json.config.path', 4000);
  assertNonEmptyString(value.config.sha256, 'run.json.config.sha256', 200);
  assertNonEmptyString(value.source_sha256, 'run.json.source_sha256', 200);
  assertNonEmptyString(
    value.candidate_schema_fingerprint,
    'run.json.candidate_schema_fingerprint',
    200,
  );
  assertObject(value.resolved, 'run.json.resolved');
  assertObject(value.resolved.target, 'run.json.resolved.target');
  assertNonEmptyString(value.resolved.target.layout_name, 'run.json.resolved.target.layout_name', 500);
  if (!Number.isInteger(value.resolved.target.pane_index) || value.resolved.target.pane_index < 0) {
    throw artifactError('run.json.resolved.target.pane_index must be a non-negative integer.');
  }
  if (
    value.resolved.target.saved_layout_id == null
    && value.resolved.target.layout_id == null
  ) {
    throw artifactError('run.json.resolved.target requires a stable Layout identity.');
  }
  assertObject(value.resolved.watchlist, 'run.json.resolved.watchlist');
  assertNonEmptyString(value.resolved.watchlist.name, 'run.json.resolved.watchlist.name', 500);
  assertNonEmptyString(value.resolved.watchlist.snapshot_id, 'run.json.resolved.watchlist.snapshot_id', 200);
  if (
    !Number.isInteger(value.resolved.watchlist.symbol_count)
    || value.resolved.watchlist.symbol_count < 1
  ) {
    throw artifactError('run.json.resolved.watchlist.symbol_count must be a positive integer.');
  }
  assertNonEmptyString(
    value.resolved.watchlist.ordered_symbol_fingerprint,
    'run.json.resolved.watchlist.ordered_symbol_fingerprint',
    200,
  );
  assertOptionalObject(value.resolved.strategy, 'run.json.resolved.strategy');
  if (value.resolved.strategy) {
    assertNonEmptyString(value.resolved.strategy.script_id, 'run.json.resolved.strategy.script_id', 500);
    assertNonEmptyString(value.resolved.strategy.source_sha256, 'run.json.resolved.strategy.source_sha256', 200);
    if (value.resolved.strategy.version == null) {
      throw artifactError('run.json.resolved.strategy.version is required.');
    }
  }
  assertTimestamp(value.started_at, value.started_at_iso, 'run.json.started_at');
  assertTimestamp(value.updated_at, value.updated_at_iso, 'run.json.updated_at');
  if (value.updated_at < value.started_at) {
    throw artifactError('run.json.updated_at must not precede started_at.');
  }
  if (value.requested?.run?.run_id != null && value.requested.run.run_id !== value.run_id) {
    throw artifactError('run.json requested Run ID does not match run_id.');
  }
  if (value.base_inputs != null && !Array.isArray(value.base_inputs)) {
    throw artifactError('run.json.base_inputs must be an array when present.');
  }
  assertOptionalObject(value.base_inputs_fingerprint, 'run.json.base_inputs_fingerprint');
  if ((value.base_inputs == null) !== (value.base_inputs_fingerprint == null)) {
    throw artifactError('run.json Base Inputs and fingerprint must be persisted together.');
  }
  if (value.planned_experiments != null) {
    if (!Array.isArray(value.planned_experiments) || value.planned_experiments.length === 0) {
      throw artifactError('run.json.planned_experiments must be a non-empty array when present.');
    }
    if (value.base_inputs == null || value.resolved.strategy == null) {
      throw artifactError('run.json plans require resolved Strategy and Base Inputs.');
    }
    const experimentIds = new Set();
    const names = new Set();
    value.planned_experiments.forEach((plan, index) => {
      const identity = plannedExperimentIdentity(plan, index);
      if (experimentIds.has(identity.experiment_id)) {
        throw artifactError(`run.json has duplicate Experiment ID: ${identity.experiment_id}.`);
      }
      if (names.has(identity.name)) {
        throw artifactError(`run.json has duplicate Parameter Set name: ${identity.name}.`);
      }
      experimentIds.add(identity.experiment_id);
      names.add(identity.name);
    });
  }
  if (!Array.isArray(value.experiments)) {
    throw artifactError('run.json.experiments must be an array.');
  }
  assertOptionalObject(value.summary, 'run.json.summary');
  assertError(value.error, 'run.json.error', { required: value.status === 'failed' });
  if (value.status === 'succeeded' && value.error != null) {
    throw artifactError('A succeeded run.json must not retain an error.');
  }
  return freezeRecord(value);
}

export function validateRunArtifactV2(value) {
  return validateRunArtifact(value, { expected_family: 'v2' });
}

export function validateRunArtifactV3(value) {
  return validateRunArtifact(value, { expected_family: 'v3' });
}

export function validateExperimentArtifact(value, { expected_family } = {}) {
  const family = assertArtifactFamily(value, 'experiment.json', expected_family);
  assertAllowedFields(value, artifactFields(EXPERIMENT_FIELDS, family), 'experiment.json');
  assertRunId(value.run_id, 'experiment.json.run_id');
  assertExperimentId(value.experiment_id, 'experiment.json.experiment_id');
  assertParameterSet(value.parameter_set, 'experiment.json.parameter_set');
  assertObject(value.strategy, 'experiment.json.strategy');
  assertObject(value.target, 'experiment.json.target');
  assertObject(value.base_inputs_fingerprint, 'experiment.json.base_inputs_fingerprint');
  assertObject(value.inputs_fingerprint, 'experiment.json.inputs_fingerprint');
  if (!Array.isArray(value.effective_inputs)) {
    throw artifactError('experiment.json.effective_inputs must be an array.');
  }
  assertTimestamp(value.started_at, value.started_at_iso, 'experiment.json.started_at');
  return freezeRecord(value);
}

export function validateExperimentArtifactV2(value) {
  return validateExperimentArtifact(value, { expected_family: 'v2' });
}

export function validateExperimentArtifactV3(value) {
  return validateExperimentArtifact(value, { expected_family: 'v3' });
}

function validateManifestSymbol(symbol, manifest, position) {
  const label = `manifest.json.symbols[${position}]`;
  assertAllowedFields(symbol, SYMBOL_FIELDS, label);
  if (!Number.isInteger(symbol.index) || symbol.index < 0 || symbol.index >= manifest.requested_symbols.length) {
    throw artifactError(`${label}.index is outside requested_symbols.`);
  }
  assertNonEmptyString(symbol.requested_symbol, `${label}.requested_symbol`, 500);
  if (symbol.requested_symbol !== manifest.requested_symbols[symbol.index]) {
    throw artifactError(`${label}.requested_symbol does not match requested_symbols[index].`);
  }
  if (symbol.resolved_symbol != null) {
    assertNonEmptyString(symbol.resolved_symbol, `${label}.resolved_symbol`, 500);
  }
  assertStatus(symbol.status, STRATEGY_SYMBOL_STATUSES, label);
  if (!Number.isInteger(symbol.attempt_count) || symbol.attempt_count < 0) {
    throw artifactError(`${label}.attempt_count must be a non-negative integer.`);
  }
  if (symbol.status !== 'skipped' && symbol.attempt_count < 1) {
    throw artifactError(`${label}.attempt_count must be positive for ${symbol.status}.`);
  }
  assertTimestamp(symbol.updated_at, symbol.updated_at_iso, `${label}.updated_at`);
  if (symbol.updated_at < manifest.started_at || symbol.updated_at > manifest.updated_at) {
    throw artifactError(`${label}.updated_at must be within the manifest time range.`);
  }
  if (symbol.total_trades != null && (!Number.isInteger(symbol.total_trades) || symbol.total_trades < 0)) {
    throw artifactError(`${label}.total_trades must be a non-negative integer.`);
  }
  if (symbol.batch_count != null && (!Number.isInteger(symbol.batch_count) || symbol.batch_count < 0)) {
    throw artifactError(`${label}.batch_count must be a non-negative integer.`);
  }
  if (symbol.status === 'succeeded') {
    assertNonEmptyString(symbol.resolved_symbol, `${label}.resolved_symbol`, 500);
    assertNonEmptyString(symbol.snapshot_id, `${label}.snapshot_id`, 200);
    if (!Number.isInteger(symbol.total_trades) || symbol.total_trades < 0) {
      throw artifactError(`${label}.total_trades is required for succeeded Symbols.`);
    }
    if (!Number.isInteger(symbol.batch_count) || symbol.batch_count < 1) {
      throw artifactError(`${label}.batch_count must be positive for succeeded Symbols.`);
    }
    assertAllowedFields(symbol.artifacts, ARTIFACT_FIELDS, `${label}.artifacts`);
    for (const name of ARTIFACT_FIELDS) {
      assertSafeArtifactReference(symbol.artifacts[name], `${label}.artifacts.${name}`);
    }
    if (symbol.error != null) throw artifactError(`${label} succeeded but still contains an error.`);
  } else if (symbol.artifacts != null) {
    throw artifactError(`${label} must not publish artifacts before succeeded.`);
  }
  assertError(symbol.error, `${label}.error`, {
    required: symbol.status === 'retry_wait' || symbol.status === 'failed',
  });
  if (symbol.status === 'running' && symbol.error != null) {
    throw artifactError(`${label} must not retain an error while running.`);
  }
}

export function deriveManifestSummary(manifest) {
  assertObject(manifest, 'manifest');
  if (!Array.isArray(manifest.requested_symbols) || !Array.isArray(manifest.symbols)) {
    throw artifactError('Manifest requested_symbols and symbols must be arrays.');
  }
  const summary = {
    requested: manifest.requested_symbols.length,
    pending: manifest.requested_symbols.length - manifest.symbols.length,
    running: 0,
    retry_wait: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  if (summary.pending < 0) throw artifactError('Manifest contains more Symbol entries than requested Symbols.');
  for (const symbol of manifest.symbols) {
    if (!STRATEGY_SYMBOL_STATUSES.includes(symbol?.status)) {
      throw artifactError(`Manifest contains unsupported Symbol status: ${String(symbol?.status)}.`);
    }
    summary[symbol.status] += 1;
  }
  return Object.freeze(summary);
}

function assertManifestSummary(actual, expected) {
  assertAllowedFields(actual, SUMMARY_FIELDS, 'manifest.json.summary');
  for (const field of SUMMARY_FIELDS) {
    if (actual[field] !== expected[field]) {
      throw artifactError(`manifest.json.summary.${field} does not match the Symbol records.`);
    }
  }
}

export function validateExperimentManifest(value, { expected_family } = {}) {
  const family = assertArtifactFamily(value, 'manifest.json', expected_family);
  assertAllowedFields(value, artifactFields(MANIFEST_FIELDS, family), 'manifest.json');
  assertRunId(value.run_id, 'manifest.json.run_id');
  assertExperimentId(value.experiment_id, 'manifest.json.experiment_id');
  assertParameterSetName(value.parameter_set_name, 'manifest.json.parameter_set_name');
  assertStatus(value.status, STRATEGY_RUN_STATUSES, 'manifest.json');
  assertObject(value.strategy, 'manifest.json.strategy');
  assertObject(value.inputs_fingerprint, 'manifest.json.inputs_fingerprint');
  assertObject(value.watchlist, 'manifest.json.watchlist');
  assertNonEmptyString(value.watchlist.snapshot_id, 'manifest.json.watchlist.snapshot_id', 200);
  if (!Number.isInteger(value.watchlist.symbol_count) || value.watchlist.symbol_count < 1) {
    throw artifactError('manifest.json.watchlist.symbol_count must be a positive integer.');
  }
  assertNonEmptyString(
    value.watchlist.ordered_symbol_fingerprint,
    'manifest.json.watchlist.ordered_symbol_fingerprint',
    200,
  );
  if (!Array.isArray(value.requested_symbols) || value.requested_symbols.length === 0) {
    throw artifactError('manifest.json.requested_symbols must be a non-empty array.');
  }
  value.requested_symbols.forEach((symbol, index) => (
    assertNonEmptyString(symbol, `manifest.json.requested_symbols[${index}]`, 500)
  ));
  if (new Set(value.requested_symbols).size !== value.requested_symbols.length) {
    throw artifactError('manifest.json.requested_symbols must not contain duplicates.');
  }
  if (value.watchlist.symbol_count !== value.requested_symbols.length) {
    throw artifactError('manifest.json Watchlist count does not match requested_symbols.');
  }
  assertNonEmptyString(value.timeframe, 'manifest.json.timeframe', 100);
  assertFormat(value.format, 'manifest.json.format');
  assertOptionalObject(value.schema_versions, 'manifest.json.schema_versions');
  assertTimestamp(value.started_at, value.started_at_iso, 'manifest.json.started_at');
  assertTimestamp(value.updated_at, value.updated_at_iso, 'manifest.json.updated_at');
  if (value.updated_at < value.started_at) {
    throw artifactError('manifest.json.updated_at must not precede started_at.');
  }
  if (!Array.isArray(value.symbols)) throw artifactError('manifest.json.symbols must be an array.');
  const indices = new Set();
  value.symbols.forEach((symbol, index) => {
    validateManifestSymbol(symbol, value, index);
    if (indices.has(symbol.index)) {
      throw artifactError(`manifest.json has a duplicate Symbol index: ${symbol.index}.`);
    }
    indices.add(symbol.index);
    if (index > 0 && value.symbols[index - 1].index >= symbol.index) {
      throw artifactError('manifest.json.symbols must be ordered by increasing index.');
    }
  });
  const summary = deriveManifestSummary(value);
  assertManifestSummary(value.summary, summary);
  if (value.status === 'succeeded' && summary.succeeded !== summary.requested) {
    throw artifactError('A succeeded manifest must have every requested Symbol succeeded.');
  }
  if (value.status === 'failed' && summary.succeeded === summary.requested) {
    throw artifactError('A failed manifest cannot have every requested Symbol succeeded.');
  }
  assertError(value.error, 'manifest.json.error');
  if (value.status === 'succeeded' && value.error != null) {
    throw artifactError('A succeeded manifest must not retain an error.');
  }
  return freezeRecord(value);
}

export function validateExperimentManifestV2(value) {
  return validateExperimentManifest(value, { expected_family: 'v2' });
}

export function validateExperimentManifestV3(value) {
  return validateExperimentManifest(value, { expected_family: 'v3' });
}

function transitionTime(current, updatedAt, label) {
  const value = updatedAt == null ? Date.now() : Number(updatedAt);
  if (!Number.isInteger(value) || value < current.updated_at) {
    throw artifactError(`${label} updated_at must be a non-decreasing integer timestamp.`);
  }
  return value;
}

export function transitionRunState(run, {
  status,
  updated_at,
  error = null,
  patch = {},
} = {}) {
  const current = validateRunArtifact(run);
  assertStatus(status, STRATEGY_RUN_STATUSES, 'Run transition');
  if (current.status === 'succeeded' && status !== 'succeeded') {
    throw artifactError('A succeeded Run is immutable.');
  }
  if (status === 'failed' && error == null) {
    throw artifactError('A failed Run transition requires an error.');
  }
  assertObject(patch, 'Run transition patch');
  for (const key of Object.keys(patch)) {
    if (!RUN_FIELDS.includes(key) || [
      'run_id',
      'status',
      'started_at',
      'started_at_iso',
      'updated_at',
      'updated_at_iso',
      'error',
    ].includes(key)) {
      throw artifactError(`Run transition cannot patch field: ${key}.`);
    }
  }
  const timestamp = transitionTime(current, updated_at, 'Run transition');
  const next = {
    ...current,
    ...patch,
    status,
    updated_at: timestamp,
    updated_at_iso: unixMillisecondsToIso(timestamp),
    error: status === 'failed' ? sanitizeStrategyRunError(error) : null,
  };
  return validateRunArtifact(next);
}

function symbolTransitionAllowed(from, to) {
  if (from == null) return to === 'running' || to === 'skipped';
  if (from === 'succeeded') return to === 'succeeded';
  if (from === 'retry_wait') return to === 'running' || to === 'failed';
  if (from === 'failed' || from === 'skipped') return to === 'running';
  return ['running', 'retry_wait', 'succeeded', 'failed', 'skipped'].includes(to);
}

export function transitionSymbolState(manifest, {
  index,
  status,
  updated_at,
  error = null,
  details = {},
} = {}) {
  const current = validateExperimentManifest(manifest);
  if (!Number.isInteger(index) || index < 0 || index >= current.requested_symbols.length) {
    throw artifactError('Symbol transition index is outside requested_symbols.');
  }
  assertStatus(status, STRATEGY_SYMBOL_STATUSES, 'Symbol transition');
  assertObject(details, 'Symbol transition details');
  const allowedDetails = SYMBOL_FIELDS.filter((field) => ![
    'index', 'requested_symbol', 'status', 'attempt_count', 'updated_at', 'updated_at_iso', 'error',
  ].includes(field));
  for (const key of Object.keys(details)) {
    if (!allowedDetails.includes(key)) {
      throw artifactError(`Symbol transition contains unsupported detail: ${key}.`);
    }
  }
  const existingIndex = current.symbols.findIndex((entry) => entry.index === index);
  const existing = existingIndex < 0 ? null : current.symbols[existingIndex];
  if (existing?.status === 'succeeded' && status !== 'succeeded') {
    throw artifactError('A succeeded Symbol is immutable.');
  }
  if (!symbolTransitionAllowed(existing?.status, status)) {
    throw artifactError(`Illegal Symbol transition: ${existing?.status || 'pending'} -> ${status}.`);
  }
  const timestamp = transitionTime(current, updated_at, 'Symbol transition');
  const attemptCount = status === 'running'
    ? (existing?.attempt_count || 0) + 1
    : (existing?.attempt_count || 0);
  const nextEntry = {
    index,
    requested_symbol: current.requested_symbols[index],
    ...(existing || {}),
    ...details,
    status,
    attempt_count: attemptCount,
    updated_at: timestamp,
    updated_at_iso: unixMillisecondsToIso(timestamp),
  };
  if (status === 'succeeded') {
    delete nextEntry.error;
  } else {
    delete nextEntry.artifacts;
    if (error != null) nextEntry.error = sanitizeStrategyRunError(error);
    else if (!['retry_wait', 'failed'].includes(status)) delete nextEntry.error;
  }
  const symbols = [...current.symbols];
  if (existingIndex < 0) symbols.push(nextEntry);
  else symbols[existingIndex] = nextEntry;
  symbols.sort((left, right) => left.index - right.index);
  const next = {
    ...current,
    updated_at: timestamp,
    updated_at_iso: unixMillisecondsToIso(timestamp),
    symbols,
  };
  next.summary = deriveManifestSummary(next);
  return validateExperimentManifest(next);
}

export function transitionExperimentState(manifest, {
  status,
  updated_at,
  error = null,
} = {}) {
  const current = validateExperimentManifest(manifest);
  assertStatus(status, STRATEGY_RUN_STATUSES, 'Experiment transition');
  if (current.status === 'succeeded' && status !== 'succeeded') {
    throw artifactError('A succeeded Experiment is immutable.');
  }
  const timestamp = transitionTime(current, updated_at, 'Experiment transition');
  const next = {
    ...current,
    status,
    updated_at: timestamp,
    updated_at_iso: unixMillisecondsToIso(timestamp),
    error: status === 'failed' && error != null ? sanitizeStrategyRunError(error) : null,
  };
  return validateExperimentManifest(next);
}

export function deriveRunSummary({ run, manifests = [] } = {}) {
  const validRun = validateRunArtifact(run);
  const family = strategyRunArtifactFamily(validRun, 'run.json');
  if (!Array.isArray(manifests)) throw artifactError('Run manifests must be an array.');
  const validManifests = manifests.map((manifest) => (
    validateExperimentManifest(manifest, { expected_family: family })
  ));
  const requestedExperiments = validRun.planned_experiments?.length ?? validManifests.length;
  const plannedIds = new Set(
    (validRun.planned_experiments || []).map((plan, index) => (
      plannedExperimentIdentity(plan, index).experiment_id
    )),
  );
  const manifestIds = new Set();
  for (const manifest of validManifests) {
    if (manifestIds.has(manifest.experiment_id)) {
      throw artifactError(`Duplicate manifest for Experiment: ${manifest.experiment_id}.`);
    }
    if (plannedIds.size > 0 && !plannedIds.has(manifest.experiment_id)) {
      throw artifactError(`Unplanned manifest for Experiment: ${manifest.experiment_id}.`);
    }
    manifestIds.add(manifest.experiment_id);
  }
  const totals = {
    experiments_requested: requestedExperiments,
    experiments_running: validManifests.filter((item) => item.status === 'running').length,
    experiments_succeeded: validManifests.filter((item) => item.status === 'succeeded').length,
    experiments_failed: validManifests.filter((item) => item.status === 'failed').length,
    symbols_requested: 0,
    symbols_pending: 0,
    symbols_running: 0,
    symbols_retry_wait: 0,
    symbols_succeeded: 0,
    symbols_failed: 0,
    symbols_skipped: 0,
  };
  for (const manifest of validManifests) {
    const summary = deriveManifestSummary(manifest);
    totals.symbols_requested += summary.requested;
    totals.symbols_pending += summary.pending;
    totals.symbols_running += summary.running;
    totals.symbols_retry_wait += summary.retry_wait;
    totals.symbols_succeeded += summary.succeeded;
    totals.symbols_failed += summary.failed;
    totals.symbols_skipped += summary.skipped;
  }
  const missingExperiments = Math.max(0, requestedExperiments - validManifests.length);
  const symbolsPerExperiment = validRun.resolved.watchlist.symbol_count;
  totals.symbols_requested += missingExperiments * symbolsPerExperiment;
  totals.symbols_pending += missingExperiments * symbolsPerExperiment;
  return Object.freeze(totals);
}

function watchlistSymbols(watchlist) {
  assertObject(watchlist, 'watchlist.json');
  if (!Array.isArray(watchlist.symbols) || watchlist.symbols.length === 0) {
    throw artifactError('watchlist.json.symbols must be a non-empty array.');
  }
  return Object.freeze(watchlist.symbols.map((item, index) => {
    const symbol = typeof item === 'string' ? item : item?.symbol;
    assertNonEmptyString(symbol, `watchlist.json.symbols[${index}]`, 500);
    return symbol;
  }));
}

export function buildResumePlan({
  run,
  watchlist,
  experiments = [],
  manifests = [],
} = {}) {
  const validRun = validateRunArtifact(run);
  const family = strategyRunArtifactFamily(validRun, 'run.json');
  if (validRun.status === 'succeeded') {
    throw artifactError('Run has already succeeded.', { code: 'RUN_ALREADY_SUCCEEDED' });
  }
  const symbols = watchlistSymbols(watchlist);
  const snapshot = watchlist.snapshot || {};
  if (validRun.resolved.watchlist.symbol_count !== symbols.length) {
    throw artifactError('watchlist.json Symbol count differs from run.json.');
  }
  if (
    snapshot.snapshot_id != null
    && snapshot.snapshot_id !== validRun.resolved.watchlist.snapshot_id
  ) {
    throw artifactError('watchlist.json Snapshot ID differs from run.json.');
  }
  if (
    validRun.resolved.watchlist.ordered_symbol_fingerprint != null
    && snapshot.ordered_symbol_fingerprint !== validRun.resolved.watchlist.ordered_symbol_fingerprint
  ) {
    throw artifactError('watchlist.json ordered Symbol fingerprint differs from run.json.');
  }
  if (!Array.isArray(experiments) || !Array.isArray(manifests)) {
    throw artifactError('Resume experiments and manifests must be arrays.');
  }
  const validExperiments = experiments.map((experiment) => (
    validateExperimentArtifact(experiment, { expected_family: family })
  ));
  const validManifests = manifests.map((manifest) => (
    validateExperimentManifest(manifest, { expected_family: family })
  ));
  const experimentById = new Map(validExperiments.map((item) => [item.experiment_id, item]));
  const manifestById = new Map(validManifests.map((item) => [item.experiment_id, item]));
  if (!validRun.planned_experiments) {
    return Object.freeze({
      run_id: validRun.run_id,
      setup_required: true,
      watchlist_symbol_count: symbols.length,
      experiment_count: 0,
      experiments: Object.freeze([]),
    });
  }
  const plan = validRun.planned_experiments.map((planned, index) => {
    const identity = plannedExperimentIdentity(planned, index);
    const experiment = experimentById.get(identity.experiment_id) || null;
    const manifest = manifestById.get(identity.experiment_id) || null;
    if (experiment) {
      if (
        experiment.run_id !== validRun.run_id
        || !valuesEqual(experiment.parameter_set, planned.parameter_set)
      ) {
        throw artifactError(`Experiment identity mismatch for ${identity.name}.`);
      }
      if (!valuesEqual(experiment.inputs_fingerprint, identity.inputs_fingerprint)) {
        throw artifactError(`Experiment Inputs fingerprint mismatch for ${identity.name}.`);
      }
      if (!valuesEqual(experiment.effective_inputs, planned.effective_inputs)) {
        throw artifactError(`Experiment effective Inputs mismatch for ${identity.name}.`);
      }
    }
    if (manifest) {
      if (!experiment) {
        throw artifactError(`Manifest exists without experiment.json for ${identity.name}.`);
      }
      if (manifest.run_id !== validRun.run_id || manifest.parameter_set_name !== identity.name) {
        throw artifactError(`Manifest identity mismatch for ${identity.name}.`);
      }
      if (
        manifest.requested_symbols.length !== symbols.length
        || manifest.requested_symbols.some((symbol, symbolIndex) => symbol !== symbols[symbolIndex])
      ) {
        throw artifactError(`Manifest Watchlist differs for ${identity.name}.`);
      }
    }
    const succeeded = new Set(
      (manifest?.symbols || []).filter((entry) => entry.status === 'succeeded').map((entry) => entry.index),
    );
    const pendingIndices = symbols.map((_symbol, symbolIndex) => symbolIndex)
      .filter((symbolIndex) => !succeeded.has(symbolIndex));
    return Object.freeze({
      index,
      name: identity.name,
      experiment_id: identity.experiment_id,
      experiment_present: Boolean(experiment),
      manifest_present: Boolean(manifest),
      status: manifest?.status || 'running',
      selected_indices: Object.freeze(manifest?.status === 'succeeded' ? [] : pendingIndices),
    });
  });
  const plannedIds = new Set(plan.map((item) => item.experiment_id));
  if (validExperiments.some((item) => !plannedIds.has(item.experiment_id))) {
    throw artifactError('Run Directory contains an unplanned Experiment artifact.');
  }
  if (validManifests.some((item) => !plannedIds.has(item.experiment_id))) {
    throw artifactError('Run Directory contains an unplanned Experiment manifest.');
  }
  return Object.freeze({
    run_id: validRun.run_id,
    setup_required: false,
    watchlist_symbol_count: symbols.length,
    experiment_count: plan.length,
    experiments: Object.freeze(plan),
  });
}
