/** Pure validation and planning for Strategy automation Parameter Sets. */
import { sha256Hex } from './stable-json.js';

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

function effectiveInputsFingerprint(inputs) {
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

  for (const set of Array.isArray(parameter_sets) ? parameter_sets : []) {
    const setErrorStart = errors.length;
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
      name: set.name,
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
