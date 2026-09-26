/** Planning and sequential execution for Strategy automation Parameter Sets. */
import { sha256Hex } from './stable-json.js';
import { setStudyInputs } from './studies.js';
import {
  ensureStrategyActive,
  readRawReportState,
  waitForFreshTradingReport,
} from './strategy-runtime.js';
import { withChartSession } from './chart-session.js';
import { assertPaneContext } from './pane.js';
import {
  listPaneStrategyInstances,
  readTargetPaneStudies,
} from './strategy-run-resolver.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { unixMillisecondsToIso } from './time.js';

const PARAMETER_SET_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const EXPERIMENT_SCHEMA_VERSION = 1;

function issue(code, message, context = {}) {
  return Object.freeze({
    code,
    message,
    phase: 'parameter_set_validation',
    retryable: false,
    ...context,
  });
}

function valuesEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function acceptsType(input, value) {
  if (String(input?.pine_input_type || '').toLowerCase() === 'enum') {
    return ['string', 'number'].includes(typeof value);
  }
  const type = String(input?.runtime_value_type || input?.type || input?.pine_input_type || '').toLowerCase();
  if (['bool', 'boolean'].includes(type)) return typeof value === 'boolean';
  if (['int', 'integer', 'time'].includes(type)) return Number.isInteger(value);
  if (['float', 'price', 'number'].includes(type)) return typeof value === 'number' && Number.isFinite(value);
  if (['string', 'text', 'text_area', 'source', 'symbol', 'resolution', 'timeframe', 'session'].includes(type)) {
    return typeof value === 'string';
  }
  if (type === 'color') return typeof value === 'string' || typeof value === 'number';
  if (type === 'enum') return ['string', 'number'].includes(typeof value);
  return false;
}

export function validateInputValue(input, value) {
  if (!acceptsType(input, value)) return `expects ${input.runtime_value_type || input.type || input.pine_input_type || 'a known type'}, received ${typeof value}`;
  const constraints = input.constraints || {};
  if (Array.isArray(constraints.options) && !constraints.options.some((option) => valuesEqual(option, value))) {
    return 'is not one of the allowed options';
  }
  if (typeof value === 'number') {
    if (constraints.min != null && value < Number(constraints.min)) return `must be at least ${constraints.min}`;
    if (constraints.max != null && value > Number(constraints.max)) return `must be at most ${constraints.max}`;
    if (constraints.step != null && Number(constraints.step) > 0 && constraints.min != null) {
      const quotient = (value - Number(constraints.min)) / Number(constraints.step);
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) return `must follow step ${constraints.step}`;
    }
  }
  return null;
}

function uniqueByName(inputs) {
  const byName = new Map();
  for (const input of Array.isArray(inputs) ? inputs : []) {
    const name = typeof input?.name === 'string' ? input.name : '';
    if (!name) continue;
    const current = byName.get(name) || [];
    current.push(input);
    byName.set(name, current);
  }
  return byName;
}

export function normalizedInputValueType(input) {
  const raw = String(input?.pine_input_type || input?.runtime_value_type || input?.type || '').toLowerCase();
  if (['bool', 'boolean'].includes(raw)) return 'bool';
  if (['int', 'integer', 'time'].includes(raw)) return 'int';
  if (['float', 'price', 'number'].includes(raw)) return 'float';
  if (['string', 'text', 'text_area', 'source', 'symbol', 'resolution', 'timeframe', 'session'].includes(raw)) return 'string';
  if (raw === 'enum') return 'enum';
  if (raw === 'color') return 'color';
  return raw || null;
}

function schemaComparisonFields(input) {
  const hasDefaultValue = Object.prototype.hasOwnProperty.call(input || {}, 'default_value');
  const hasDefaultExpression = typeof input?.default_expression === 'string';
  return Object.freeze({
    type: input?.pine_input_type || input?.runtime_value_type || input?.type || null,
    default: hasDefaultValue
      ? Object.freeze({ kind: 'value', value: input.default_value })
      : hasDefaultExpression
        ? Object.freeze({ kind: 'expression', value: input.default_expression.trim() })
        : null,
    min: input?.constraints?.min ?? null,
    max: input?.constraints?.max ?? null,
  });
}

export function effectiveInputsFingerprint(inputs) {
  const canonical = (Array.isArray(inputs) ? inputs : [])
    .map((input) => ({ id: String(input.id), value: input.value }))
    .sort((left, right) => left.id.localeCompare(right.id, 'en', { numeric: true }));
  return Object.freeze({
    available: true,
    algorithm: 'sha256',
    value: sha256Hex(canonical),
    count: canonical.length,
  });
}

function unavailableFingerprint(reason) {
  return Object.freeze({ available: false, algorithm: 'sha256', value: null, count: null, reason });
}

function validateRuntimeCatalog({ candidate_schema, base_catalog }) {
  if (!Array.isArray(base_catalog)) return { available: false, complete: false, errors: [] };
  const errors = [];
  const candidateInputs = candidate_schema.inputs || [];
  const runtimeByName = uniqueByName(base_catalog);
  if (candidateInputs.length > 0 && base_catalog.length === 0) {
    errors.push(issue(
      'RUNTIME_INPUT_CATALOG_EMPTY',
      `Runtime Input Catalog is empty but the Candidate Schema declares ${candidateInputs.length} Inputs.`,
    ));
  }
  for (const candidate of base_catalog.length === 0 ? [] : candidateInputs) {
    const matches = runtimeByName.get(candidate.name) || [];
    if (matches.length === 0) {
      errors.push(issue(
        'RUNTIME_INPUT_NOT_FOUND',
        `Candidate Input is missing from the Runtime Catalog: ${candidate.name}`,
        { input_name: candidate.name },
      ));
      continue;
    }
    if (matches.length > 1) {
      errors.push(issue(
        'RUNTIME_INPUT_NAME_AMBIGUOUS',
        `Runtime Input title is ambiguous: ${candidate.name}`,
        { input_name: candidate.name },
      ));
      continue;
    }
    const candidateType = normalizedInputValueType(candidate);
    const runtimeType = normalizedInputValueType(matches[0]);
    const compatible = candidateType === runtimeType
      || (candidateType === 'enum' && ['enum', 'string'].includes(runtimeType));
    if (!compatible) {
      errors.push(issue(
        'RUNTIME_INPUT_TYPE_MISMATCH',
        `Runtime Input ${candidate.name} type ${runtimeType || 'unknown'} does not match Candidate type ${candidateType || 'unknown'}.`,
        { input_name: candidate.name },
      ));
    }
  }
  return { available: true, complete: errors.length === 0, errors };
}

/** Compare current Account or Runtime schema against the local candidate schema. */
export function compareInputSchemas({ current_schema, candidate_schema } = {}) {
  if (!candidate_schema?.available) return Object.freeze({ available: false, reason: 'candidate_schema_unavailable' });
  if (!current_schema?.available) return Object.freeze({ available: false, reason: 'current_schema_unavailable' });
  const current = uniqueByName(current_schema.inputs);
  const candidate = uniqueByName(candidate_schema.inputs);
  const added = [...candidate.keys()].filter((name) => !current.has(name));
  const removed = [...current.keys()].filter((name) => !candidate.has(name));
  const changed = [];
  for (const [name, candidateItems] of candidate) {
    const currentItems = current.get(name);
    if (!currentItems || currentItems.length !== 1 || candidateItems.length !== 1) continue;
    const before = currentItems[0];
    const after = candidateItems[0];
    const beforeFields = schemaComparisonFields(before);
    const afterFields = schemaComparisonFields(after);
    const changedFields = ['type', 'default', 'min', 'max']
      .filter((field) => !valuesEqual(beforeFields[field], afterFields[field]));
    if (changedFields.length) {
      changed.push(Object.freeze({
        name,
        changed_fields: Object.freeze(changedFields),
        before: beforeFields,
        after: afterFields,
      }));
    }
  }
  return Object.freeze({
    available: true,
    changed: added.length > 0 || removed.length > 0 || changed.length > 0,
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    modified: Object.freeze(changed),
  });
}

/** Validate all configured sets by exact, case-sensitive user-facing input title. */
export function planParameterSets({ base_catalog, candidate_schema, parameter_sets } = {}) {
  const errors = [];
  const plans = [];
  if (!candidate_schema?.available) {
    return {
      valid: false,
      errors: [issue('PINE_INPUT_SCHEMA_UNRESOLVED', 'Candidate Pine Input Schema is unavailable.')],
      parameter_sets: [],
    };
  }
  const candidateByName = uniqueByName(candidate_schema.inputs);
  const baseByName = uniqueByName(base_catalog);
  const runtimeCatalog = validateRuntimeCatalog({ candidate_schema, base_catalog });
  errors.push(...runtimeCatalog.errors);

  const sets = Array.isArray(parameter_sets) ? parameter_sets : [];
  if (sets.length === 0) {
    errors.push(issue('PARAMETER_SETS_REQUIRED', 'At least one Parameter Set is required.'));
  }
  const seenNames = new Set();
  for (const [setIndex, set] of sets.entries()) {
    const setErrorStart = errors.length;
    const setName = typeof set?.name === 'string' ? set.name : '';
    if (!PARAMETER_SET_NAME.test(setName)) {
      errors.push(issue(
        'PARAMETER_SET_NAME_INVALID',
        `Parameter Set name must be path-safe ASCII and at most 100 characters: ${setName || '<missing>'}`,
        { parameter_set: setName || null, parameter_set_index: setIndex },
      ));
    } else if (seenNames.has(setName)) {
      errors.push(issue(
        'PARAMETER_SET_NAME_DUPLICATE',
        `Parameter Set name is duplicated: ${setName}`,
        { parameter_set: setName, parameter_set_index: setIndex },
      ));
    } else {
      seenNames.add(setName);
    }
    const resolved = [];
    for (const [name, value] of Object.entries(set.inputs || {})) {
      const candidateMatches = candidateByName.get(name) || [];
      if (candidateMatches.length === 0) {
        errors.push(issue(
          'PARAMETER_SET_INPUT_NOT_FOUND',
          `Parameter Set ${set.name} references an unknown Candidate Input: ${name}`,
          { parameter_set: set.name, input_name: name },
        ));
        continue;
      }
      if (candidateMatches.length > 1) {
        errors.push(issue(
          'PARAMETER_SET_INPUT_AMBIGUOUS',
          `Parameter Set ${set.name} references a duplicated Candidate Input title: ${name}`,
          { parameter_set: set.name, input_name: name },
        ));
        continue;
      }
      const candidate = candidateMatches[0];
      const invalid = validateInputValue(candidate, value);
      if (invalid) {
        errors.push(issue(
          'PARAMETER_SET_INPUT_VALUE_INVALID',
          `Parameter Set ${set.name} Input ${name} ${invalid}.`,
          { parameter_set: set.name, input_name: name },
        ));
        continue;
      }
      const runtimeMatches = baseByName.get(name) || [];
      if (runtimeCatalog.complete && runtimeMatches.length === 1) {
        const runtimeInvalid = validateInputValue(runtimeMatches[0], value);
        if (runtimeInvalid) {
          errors.push(issue(
            'PARAMETER_SET_INPUT_VALUE_INVALID',
            `Parameter Set ${set.name} Runtime Input ${name} ${runtimeInvalid}.`,
            { parameter_set: set.name, input_name: name },
          ));
          continue;
        }
      }
      resolved.push(Object.freeze({
        name,
        ...(runtimeMatches[0]?.id && { id: runtimeMatches[0].id }),
        ...(runtimeMatches[0] && { base_value: runtimeMatches[0].value }),
        requested_value: value,
      }));
    }
    const setValid = errors.length === setErrorStart;
    let fingerprint = unavailableFingerprint(
      !setValid
        ? 'parameter_validation_failed'
        : runtimeCatalog.available ? 'runtime_validation_failed' : 'pending_strategy_sync',
    );
    if (runtimeCatalog.complete && setValid) {
      const overrides = new Map(Object.entries(set.inputs || {}));
      const effective = base_catalog.map((input) => ({
        id: input.id,
        value: input.name && overrides.has(input.name) ? overrides.get(input.name) : input.value,
      }));
      fingerprint = effectiveInputsFingerprint(effective);
    }
    plans.push(Object.freeze({
      index: setIndex,
      name: setName,
      requested_inputs: Object.freeze({ ...(set.inputs || {}) }),
      resolved_inputs: Object.freeze(resolved),
      requested_inputs_fingerprint: sha256Hex(Object.entries(set.inputs || {}).sort(([a], [b]) => a.localeCompare(b))),
      inputs_fingerprint: fingerprint,
      runtime_validation: !runtimeCatalog.available
        ? 'blocked_pending_pane_sync'
        : runtimeCatalog.complete && setValid ? 'complete' : 'invalid',
    }));
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    parameter_sets: Object.freeze(plans),
  });
}

function normalizeContext(context) {
  return Object.freeze({
    ...context,
    resolution: context?.resolution ?? context?.timeframe ?? null,
  });
}

function fixedIdentity(identity) {
  if (
    !identity?.entity_id
    || !identity?.script_id
    || identity?.version == null
    || !identity?.source_sha256
  ) {
    throw new ParameterSetExecutionError(
      'Fixed Strategy identity requires entity_id, script_id, version, and source_sha256.',
      { code: 'PARAMETER_SET_IDENTITY_INVALID', phase: 'parameter_set_validation' },
    );
  }
  return Object.freeze({
    entity_id: String(identity.entity_id),
    script_id: String(identity.script_id),
    version: String(identity.version),
    source_sha256: identity.source_sha256 || null,
  });
}

function catalogSnapshot(catalog) {
  return Object.freeze((Array.isArray(catalog) ? catalog : []).map((input) => Object.freeze({
    ...input,
    constraints: Object.freeze({ ...(input.constraints || {}) }),
  })));
}

function assertExpectedCatalog(expected, actual, { identity, context, phase }) {
  const expectedById = new Map((expected || []).map((input) => [String(input.id), input]));
  const actualById = new Map((actual || []).map((input) => [String(input.id), input]));
  if (expectedById.size !== actualById.size) {
    throw new ParameterSetExecutionError('Runtime Input Catalog count changed during Parameter Set execution.', {
      code: 'RUNTIME_INPUT_CATALOG_CHANGED', phase, identity, context,
    });
  }
  for (const [id, expectedInput] of expectedById) {
    const actualInput = actualById.get(id);
    if (
      !actualInput
      || expectedInput.name !== actualInput.name
      || normalizedInputValueType(expectedInput) !== normalizedInputValueType(actualInput)
    ) {
      throw new ParameterSetExecutionError(`Runtime Input identity changed: ${id}.`, {
        code: 'RUNTIME_INPUT_CATALOG_CHANGED', phase, identity, context,
      });
    }
  }
}

function changedValues(expected, actual) {
  const actualById = new Map((actual || []).map((input) => [String(input.id), input.value]));
  return Object.fromEntries((expected || [])
    .filter((input) => !valuesEqual(input.value, actualById.get(String(input.id))))
    .map((input) => [String(input.id), input.value]));
}

function assertFingerprint(actual, expected, { identity, context, phase }) {
  if (
    actual?.available !== true
    || expected?.available !== true
    || actual.value !== expected.value
    || actual.count !== expected.count
  ) {
    throw new ParameterSetExecutionError('Effective Inputs fingerprint readback mismatch.', {
      code: 'PARAMETER_SET_INPUT_FINGERPRINT_MISMATCH', phase, identity, context,
    });
  }
}

function boundedError(error) {
  if (!error) return null;
  return Object.freeze({
    name: error.name || 'Error',
    code: error.code || 'PARAMETER_SET_EXECUTION_FAILED',
    phase: error.phase || null,
    message: String(error.message || error).slice(0, 1000),
    retryable: error.retryable === true,
    ...(error.parameter_set && { parameter_set: error.parameter_set }),
  });
}

export class ParameterSetExecutionError extends CoreOperationError {
  constructor(message, {
    code = 'PARAMETER_SET_EXECUTION_FAILED', phase = 'parameter_set_execution',
    retryable = false, identity, context, parameter_set, cause,
    execution_state, restore,
  } = {}) {
    super(message, {
      code, phase, retryable, context, entity_id: identity?.entity_id, cause,
    });
    this.name = 'ParameterSetExecutionError';
    this.parameter_set = parameter_set || null;
    this.strategy_identity = identity || null;
    this.execution_state = execution_state || null;
    this.restore = restore || null;
  }
}

function executionFailure(error, options = {}) {
  return new ParameterSetExecutionError(error?.message || String(error), {
    code: error?.code || options.code,
    phase: error?.phase || options.phase,
    retryable: error?.retryable === true,
    identity: options.identity,
    context: error?.context || options.context,
    parameter_set: error?.parameter_set || options.parameter_set,
    cause: error,
    execution_state: options.execution_state,
    restore: options.restore,
  });
}

/** Build the complete internal Base + Effective Inputs plan without exposing it in dry-run output. */
export function createParameterSetExecutionPlan({
  base_catalog, candidate_schema, parameter_sets, identity,
} = {}) {
  const base = catalogSnapshot(base_catalog);
  const summary = planParameterSets({ base_catalog: base, candidate_schema, parameter_sets });
  const strategyIdentity = fixedIdentity(identity);
  if (!summary.valid) {
    return Object.freeze({
      valid: false,
      errors: summary.errors,
      identity: strategyIdentity,
      base_inputs: base,
      base_inputs_fingerprint: effectiveInputsFingerprint(base),
      parameter_sets: Object.freeze([]),
    });
  }
  const plans = summary.parameter_sets.map((planned, index) => {
    const overrides = new Map(Object.entries(planned.requested_inputs));
    const effective = Object.freeze(base.map((input) => Object.freeze({
      ...input,
      constraints: input.constraints,
      value: input.name && overrides.has(input.name)
        ? overrides.get(input.name)
        : input.value,
    })));
    const fingerprint = effectiveInputsFingerprint(effective);
    return Object.freeze({
      ...planned,
      index,
      effective_inputs: effective,
      inputs_fingerprint: fingerprint,
      experiment_id: `sha256:${sha256Hex({
        schema_version: EXPERIMENT_SCHEMA_VERSION,
        strategy: strategyIdentity,
        parameter_set_index: index,
        parameter_set_name: planned.name,
        requested_inputs_fingerprint: planned.requested_inputs_fingerprint,
        base_inputs_fingerprint: effectiveInputsFingerprint(base).value,
        inputs_fingerprint: fingerprint.value,
      })}`,
    });
  });
  return Object.freeze({
    valid: true,
    errors: Object.freeze([]),
    identity: strategyIdentity,
    base_inputs: base,
    base_inputs_fingerprint: effectiveInputsFingerprint(base),
    parameter_sets: Object.freeze(plans),
  });
}

/** Reacquire the exact target and verify the fixed Pane Strategy identity and Runtime Catalog. */
export async function readFixedStrategyInputs({ identity, context, expected_catalog, phase, _deps } = {}) {
  const expectedIdentity = fixedIdentity(identity);
  const expectedContext = normalizeContext(context);
  const assertContext = _deps?.assertPaneContext || assertPaneContext;
  await assertContext({
    context: expectedContext,
    symbol: expectedContext.symbol,
    timeframe: expectedContext.resolution,
    phase: phase || 'parameter_set_identity',
    _deps,
  });
  const readPane = _deps?.readTargetPaneStudies || readTargetPaneStudies;
  const pane = await readPane({
    target_id: expectedContext.target_id,
    pane_index: expectedContext.pane_index,
    _deps,
  });
  const matches = listPaneStrategyInstances({
    pane_state: pane, script_id: expectedIdentity.script_id,
  });
  const target = matches.find((study) => study.entity_id === expectedIdentity.entity_id);
  if (
    matches.length !== 1
    || !target
    || String(target.version) !== expectedIdentity.version
  ) {
    throw new ParameterSetExecutionError('Fixed Pane Strategy identity changed during Parameter Set execution.', {
      code: 'PARAMETER_SET_STRATEGY_CHANGED',
      phase: phase || 'parameter_set_identity',
      identity: expectedIdentity,
      context: expectedContext,
    });
  }
  if (expected_catalog) {
    assertExpectedCatalog(expected_catalog, target.inputs, {
      identity: expectedIdentity, context: expectedContext,
      phase: phase || 'parameter_set_identity',
    });
  }
  return Object.freeze({
    ...target,
    inputs: catalogSnapshot(target.inputs),
    inputs_fingerprint: target.inputs_fingerprint || effectiveInputsFingerprint(target.inputs),
  });
}

async function applyEffectiveInputs({ plan, identity, context, current, phase, _deps }) {
  assertExpectedCatalog(plan.effective_inputs, current.inputs, { identity, context, phase });
  const overrides = changedValues(plan.effective_inputs, current.inputs);
  if (Object.keys(overrides).length) {
    const setInputs = _deps?.setStudyInputs || setStudyInputs;
    await setInputs({ entity_id: identity.entity_id, inputs: overrides, _deps });
  }
  const readback = await readFixedStrategyInputs({
    identity, context, expected_catalog: plan.effective_inputs,
    phase: `${phase}_readback`, _deps,
  });
  assertFingerprint(readback.inputs_fingerprint, plan.inputs_fingerprint, {
    identity, context, phase: `${phase}_readback`,
  });
  return Object.freeze({
    mutated: Object.keys(overrides).length > 0,
    applied_inputs: Object.freeze(overrides),
    readback,
  });
}

function assertReportFingerprint(report, expected, { identity, context, phase }) {
  assertFingerprint(report?.inputs_fingerprint, expected, { identity, context, phase });
}

/** Apply one Effective Inputs plan, wait for its stable Report, then invoke the caller operation. */
export async function withParameterSet({
  plan, base, expected_current, identity, context, timeout_ms, _deps = {},
} = {}, operation) {
  if (!plan?.experiment_id || !Array.isArray(plan.effective_inputs)) {
    throw new ParameterSetExecutionError('A complete Parameter Set execution plan is required.', {
      code: 'PARAMETER_SET_PLAN_INVALID', phase: 'parameter_set_validation', identity, context,
    });
  }
  if (typeof operation !== 'function') {
    throw new ParameterSetExecutionError('Parameter Set operation callback is required.', {
      code: 'PARAMETER_SET_OPERATION_REQUIRED', phase: 'parameter_set_validation', identity, context,
    });
  }
  const expectedIdentity = fixedIdentity(identity);
  const expectedContext = normalizeContext(context);
  const now = _deps.now || Date.now;
  const startedAt = now();
  try {
    let current = await readFixedStrategyInputs({
      identity: expectedIdentity, context: expectedContext,
      expected_catalog: expected_current || base, phase: 'parameter_set_start', _deps,
    });
    assertFingerprint(current.inputs_fingerprint, effectiveInputsFingerprint(expected_current || base), {
      identity: expectedIdentity, context: expectedContext,
      phase: 'parameter_set_start',
    });
    const activate = _deps.ensureStrategyActive || ensureStrategyActive;
    await activate({
      entity_id: expectedIdentity.entity_id,
      context: expectedContext,
      timeout_ms,
      _deps,
    });
    const readReport = _deps.readRawReportState || readRawReportState;
    const before = await readReport({
      entity_id: expectedIdentity.entity_id,
      context: expectedContext,
      phase: 'parameter_set_before_report',
      _deps,
    });
    assertReportFingerprint(before, current.inputs_fingerprint, {
      identity: expectedIdentity, context: expectedContext,
      phase: 'parameter_set_before_report',
    });
    const applied = await applyEffectiveInputs({
      plan, identity: expectedIdentity, context: expectedContext,
      current, phase: 'parameter_set_apply', _deps,
    });
    current = applied.readback;
    const waitReport = _deps.waitForFreshTradingReport || waitForFreshTradingReport;
    const report = await waitReport({
      entity_id: expectedIdentity.entity_id,
      context: expectedContext,
      before,
      mutated: applied.mutated,
      timeout_ms,
      _deps,
    });
    assertReportFingerprint(report, plan.inputs_fingerprint, {
      identity: expectedIdentity, context: expectedContext,
      phase: 'parameter_set_report_readback',
    });
    const experiment = Object.freeze({
      schema_version: EXPERIMENT_SCHEMA_VERSION,
      experiment_id: plan.experiment_id,
      parameter_set: Object.freeze({
        index: plan.index,
        name: plan.name,
        requested_inputs: plan.requested_inputs,
        resolved_inputs: plan.resolved_inputs,
        requested_inputs_fingerprint: plan.requested_inputs_fingerprint,
      }),
      strategy: expectedIdentity,
      context: sanitizeCoreContext(expectedContext),
      base_inputs_fingerprint: effectiveInputsFingerprint(base),
      inputs_fingerprint: plan.inputs_fingerprint,
      effective_inputs: plan.effective_inputs,
      started_at: startedAt,
      started_at_iso: unixMillisecondsToIso(startedAt),
      report: Object.freeze({
        runtime_signature: report.runtime_signature,
        snapshot_candidate: report.snapshot_candidate,
        stable_reads: report.stable_reads,
        transition_observed: report.transition_observed,
        fresh: report.fresh,
      }),
    });
    const output = await operation(experiment);
    const finalStudy = await readFixedStrategyInputs({
      identity: expectedIdentity, context: expectedContext,
      expected_catalog: plan.effective_inputs,
      phase: 'parameter_set_operation_readback', _deps,
    });
    assertFingerprint(finalStudy.inputs_fingerprint, plan.inputs_fingerprint, {
      identity: expectedIdentity, context: expectedContext,
      phase: 'parameter_set_operation_readback',
    });
    const completedAt = now();
    return Object.freeze({
      success: true,
      experiment: Object.freeze({
        ...experiment,
        completed_at: completedAt,
        completed_at_iso: unixMillisecondsToIso(completedAt),
      }),
      operation: output,
      mutation: Object.freeze({
        mutated: applied.mutated,
        applied_input_count: Object.keys(applied.applied_inputs).length,
      }),
    });
  } catch (error) {
    throw executionFailure(error, {
      identity: expectedIdentity, context: expectedContext, parameter_set: plan.name,
    });
  }
}

/** Restore and verify the complete captured Base Inputs catalog. */
export async function restoreBaseInputs({
  base, identity, context, timeout_ms, _deps = {},
} = {}) {
  const expectedIdentity = fixedIdentity(identity);
  const expectedContext = normalizeContext(context);
  const plan = Object.freeze({
    effective_inputs: catalogSnapshot(base),
    inputs_fingerprint: effectiveInputsFingerprint(base),
  });
  const current = await readFixedStrategyInputs({
    identity: expectedIdentity, context: expectedContext,
    expected_catalog: base, phase: 'parameter_set_restore_start', _deps,
  });
  const pendingOverrides = changedValues(plan.effective_inputs, current.inputs);
  if (!Object.keys(pendingOverrides).length) {
    assertFingerprint(current.inputs_fingerprint, plan.inputs_fingerprint, {
      identity: expectedIdentity, context: expectedContext,
      phase: 'parameter_set_restore_readback',
    });
    return Object.freeze({
      success: true,
      restored: false,
      applied_input_count: 0,
      inputs_fingerprint: plan.inputs_fingerprint,
      report_stable_reads: null,
    });
  }
  const activate = _deps.ensureStrategyActive || ensureStrategyActive;
  await activate({ entity_id: expectedIdentity.entity_id, context: expectedContext, timeout_ms, _deps });
  const readReport = _deps.readRawReportState || readRawReportState;
  const before = await readReport({
    entity_id: expectedIdentity.entity_id,
    context: expectedContext,
    phase: 'parameter_set_restore_before_report', _deps,
  });
  const applied = await applyEffectiveInputs({
    plan, identity: expectedIdentity, context: expectedContext,
    current, phase: 'parameter_set_restore', _deps,
  });
  let report = before;
  if (applied.mutated) {
    const waitReport = _deps.waitForFreshTradingReport || waitForFreshTradingReport;
    report = await waitReport({
      entity_id: expectedIdentity.entity_id,
      context: expectedContext,
      before,
      mutated: true,
      timeout_ms,
      _deps,
    });
    assertReportFingerprint(report, plan.inputs_fingerprint, {
      identity: expectedIdentity, context: expectedContext,
      phase: 'parameter_set_restore_report',
    });
  }
  return Object.freeze({
    success: true,
    restored: applied.mutated,
    applied_input_count: Object.keys(applied.applied_inputs).length,
    inputs_fingerprint: plan.inputs_fingerprint,
    report_stable_reads: report?.stable_reads ?? null,
  });
}

/** Execute all declared Parameter Sets sequentially and always restore Base Inputs. */
export async function executeParameterSets({
  base_catalog,
  candidate_schema,
  parameter_sets,
  identity,
  context,
  timeout_ms,
  _deps = {},
} = {}, operation) {
  const expectedIdentity = fixedIdentity(identity);
  const expectedContext = normalizeContext(context);
  const runWithSession = _deps.withChartSession || withChartSession;
  return runWithSession({ context: expectedContext, _deps }, async () => {
    const captured = await readFixedStrategyInputs({
      identity: expectedIdentity, context: expectedContext,
      expected_catalog: base_catalog,
      phase: 'parameter_set_base_capture', _deps,
    });
    const base = catalogSnapshot(captured.inputs);
    const plan = createParameterSetExecutionPlan({
      base_catalog: base,
      candidate_schema,
      parameter_sets,
      identity: expectedIdentity,
    });
    if (!plan.valid) {
      throw new ParameterSetExecutionError(plan.errors[0]?.message || 'Parameter Set planning failed.', {
        code: plan.errors[0]?.code || 'PARAMETER_SET_PLAN_INVALID',
        phase: 'parameter_set_validation', identity: expectedIdentity,
        context: expectedContext,
        execution_state: Object.freeze({ errors: plan.errors }),
      });
    }
    const results = [];
    let expectedCurrent = base;
    let primaryError = null;
    let restore = null;
    try {
      for (const parameterSet of plan.parameter_sets) {
        results.push(await withParameterSet({
          plan: parameterSet,
          base,
          expected_current: expectedCurrent,
          identity: expectedIdentity,
          context: expectedContext,
          timeout_ms,
          _deps,
        }, operation));
        expectedCurrent = parameterSet.effective_inputs;
      }
    } catch (error) {
      primaryError = error;
    } finally {
      try {
        restore = await restoreBaseInputs({
          base,
          identity: expectedIdentity,
          context: expectedContext,
          timeout_ms,
          _deps,
        });
      } catch (error) {
        throw new ParameterSetExecutionError(
          `Base Inputs restore failed: ${error?.message || String(error)}`,
          {
            code: 'PARAMETER_SET_RESTORE_FAILED',
            phase: 'parameter_set_restore',
            retryable: error?.retryable === true,
            identity: expectedIdentity,
            context: expectedContext,
            cause: error,
            execution_state: Object.freeze({
              completed_experiments: results.length,
              original_error: boundedError(primaryError),
            }),
            restore: Object.freeze({ success: false, error: boundedError(error) }),
          },
        );
      }
    }
    if (primaryError) {
      throw executionFailure(primaryError, {
        identity: expectedIdentity,
        context: expectedContext,
        execution_state: Object.freeze({ completed_experiments: results.length }),
        restore,
      });
    }
    return Object.freeze({
      success: true,
      strategy: expectedIdentity,
      context: sanitizeCoreContext(expectedContext),
      base_inputs_fingerprint: plan.base_inputs_fingerprint,
      experiment_count: results.length,
      experiments: Object.freeze(results),
      restore,
    });
  });
}
