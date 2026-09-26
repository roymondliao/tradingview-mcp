/** Account Saved Strategy synchronization and safe Pane Instance refresh. */
import {
  analyze as analyzePine,
  check as checkPine,
  createSavedScript,
  detectPineType,
  getSavedScript,
  updateSavedScript,
} from './pine.js';
import {
  addActivePaneStudy,
  fingerprintStudyInputs,
  removeActivePaneStudy,
  setStudyInputs,
} from './studies.js';
import { ensureStrategyActive, waitForFreshTradingReport } from './strategy-runtime.js';
import { withChartSession } from './chart-session.js';
import {
  listPaneStrategyInstances,
  readResolvedSavedStrategy,
  readTargetPaneStudies,
  resolveSavedStrategy,
} from './strategy-run-resolver.js';
import {
  normalizedInputValueType,
  validateInputValue,
} from './strategy-parameter-sets.js';
import { normalizedPineSourceSha256, normalizePineSource } from './pine-input-schema.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { stableJsonStringify } from './stable-json.js';

function syncIssue(code, message, phase = 'strategy_sync_planning', context = {}) {
  return Object.freeze({ code, message, phase, retryable: false, ...context });
}

function valuesEqual(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function exactSavedName(script, name) {
  return script?.name === name || script?.title === name;
}

function normalizeContext(context) {
  return Object.freeze({
    ...context,
    resolution: context?.resolution ?? context?.timeframe ?? null,
  });
}

function schemaByName(inputs) {
  const result = new Map();
  for (const input of Array.isArray(inputs) ? inputs : []) {
    if (!input?.name) continue;
    const matches = result.get(input.name) || [];
    matches.push(input);
    result.set(input.name, matches);
  }
  return result;
}

function comparableDefault(input) {
  if (Object.prototype.hasOwnProperty.call(input || {}, 'default_value')) {
    return { available: true, kind: 'value', value: input.default_value };
  }
  if (typeof input?.default_expression === 'string') {
    return { available: false, kind: 'expression', value: input.default_expression.trim() };
  }
  return { available: false, kind: 'none', value: null };
}

/** Verify that one new Runtime Input Catalog implements the Candidate Schema. */
export function compareCandidateRuntimeInputSchema({ candidate_schema, runtime_catalog } = {}) {
  const errors = [];
  const warnings = [];
  const mappings = [];
  if (!candidate_schema?.available) {
    errors.push(syncIssue(
      'PINE_INPUT_SCHEMA_UNRESOLVED',
      'Candidate Pine Input Schema is unavailable.',
      'strategy_runtime_schema',
    ));
    return { valid: false, errors, warnings, mappings };
  }
  if (!Array.isArray(runtime_catalog)) {
    errors.push(syncIssue(
      'STRATEGY_INPUT_SCHEMA_READBACK_MISMATCH',
      'Runtime Input Catalog is unavailable.',
      'strategy_runtime_schema',
    ));
    return { valid: false, errors, warnings, mappings };
  }
  const runtimeByName = schemaByName(runtime_catalog);
  const candidates = candidate_schema.inputs || [];
  if (candidates.length > 0 && runtime_catalog.length === 0) {
    errors.push(syncIssue(
      'RUNTIME_INPUT_CATALOG_EMPTY',
      `Runtime Input Catalog is empty but the Candidate Schema declares ${candidates.length} Inputs.`,
      'strategy_runtime_schema',
    ));
    return { valid: false, errors, warnings, mappings };
  }
  for (const candidate of candidates) {
    const matches = runtimeByName.get(candidate.name) || [];
    if (matches.length !== 1) {
      errors.push(syncIssue(
        'STRATEGY_INPUT_SCHEMA_READBACK_MISMATCH',
        matches.length
          ? `Runtime Input title is ambiguous: ${candidate.name}`
          : `Candidate Input is missing from the Runtime Catalog: ${candidate.name}`,
        'strategy_runtime_schema',
        { input_name: candidate.name },
      ));
      continue;
    }
    const runtime = matches[0];
    const candidateType = normalizedInputValueType(candidate);
    const runtimeType = normalizedInputValueType(runtime);
    const typeMatches = candidateType === runtimeType
      || (candidateType === 'enum' && ['enum', 'string'].includes(runtimeType));
    const changedFields = [];
    if (!typeMatches) changedFields.push('type');
    const candidateDefault = comparableDefault(candidate);
    const runtimeDefault = comparableDefault(runtime);
    if (
      candidateDefault.available
      && (!runtimeDefault.available || !valuesEqual(candidateDefault.value, runtimeDefault.value))
    ) changedFields.push('default');
    for (const field of ['min', 'max']) {
      if (!valuesEqual(candidate?.constraints?.[field] ?? null, runtime?.constraints?.[field] ?? null)) {
        changedFields.push(field);
      }
    }
    if (changedFields.length) {
      errors.push(syncIssue(
        'STRATEGY_INPUT_SCHEMA_READBACK_MISMATCH',
        `Runtime Input ${candidate.name} differs from Candidate fields: ${changedFields.join(', ')}.`,
        'strategy_runtime_schema',
        { input_name: candidate.name, changed_fields: changedFields },
      ));
      continue;
    }
    if (candidateDefault.kind === 'expression') {
      warnings.push(syncIssue(
        'STRATEGY_INPUT_DEFAULT_EXPRESSION_UNVERIFIED',
        `Runtime default cannot be compared statically for Input: ${candidate.name}`,
        'strategy_runtime_schema',
        { input_name: candidate.name },
      ));
    }
    mappings.push(Object.freeze({ name: candidate.name, candidate, runtime }));
  }
  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    mappings: Object.freeze(mappings),
  });
}

/** Preserve only exact-name, type-compatible old values accepted by the new Runtime Catalog. */
export function planStrategyInputMigration({
  old_catalog, new_catalog, current_schema, candidate_schema,
} = {}) {
  const comparison = compareCandidateRuntimeInputSchema({ candidate_schema, runtime_catalog: new_catalog });
  if (!comparison.valid) {
    return Object.freeze({
      valid: false,
      errors: comparison.errors,
      warnings: comparison.warnings,
      overrides: Object.freeze({}),
      migrations: Object.freeze([]),
      removed: Object.freeze([]),
    });
  }
  const oldByName = schemaByName(old_catalog);
  const candidateNames = new Set((candidate_schema.inputs || []).map((input) => input.name));
  const oldSchemaNames = new Set((current_schema?.inputs || []).map((input) => input.name));
  const newRuntimeNames = new Set((new_catalog || []).map((input) => input?.name).filter(Boolean));
  const overrides = {};
  const migrations = [];
  const warnings = [...comparison.warnings];

  for (const next of new_catalog) {
    const name = next?.name || null;
    const oldMatches = name ? oldByName.get(name) || [] : [];
    if (oldMatches.length === 1) {
      const old = oldMatches[0];
      const sameType = normalizedInputValueType(old) === normalizedInputValueType(next);
      const invalid = sameType ? validateInputValue(next, old.value) : 'type changed';
      if (!invalid) {
        if (!valuesEqual(old.value, next.value)) overrides[next.id] = old.value;
        migrations.push(Object.freeze({
          name,
          old_id: old.id,
          new_id: next.id,
          action: 'preserve',
          value: old.value,
        }));
        continue;
      }
      warnings.push(syncIssue(
        'STRATEGY_INPUT_VALUE_DEFAULTED',
        `Input ${name} cannot preserve its old value (${invalid}); the new Runtime default is used.`,
        'strategy_input_migration',
        { input_name: name },
      ));
      migrations.push(Object.freeze({
        name, old_id: old.id, new_id: next.id, action: 'use_new_default',
      }));
      continue;
    }
    if (oldMatches.length > 1) {
      warnings.push(syncIssue(
        'STRATEGY_INPUT_OLD_NAME_AMBIGUOUS',
        `Old Runtime Input title is ambiguous; the new default is used: ${name}`,
        'strategy_input_migration',
        { input_name: name },
      ));
    } else if (name && candidateNames.has(name)) {
      warnings.push(syncIssue(
        'PARAMETER_SET_NEW_INPUT_DEFAULTED',
        `New Input uses its Runtime default: ${name}`,
        'strategy_input_migration',
        { input_name: name },
      ));
    }
    migrations.push(Object.freeze({ name, new_id: next.id, action: 'use_new_default' }));
  }

  const removedNames = new Set([
    ...[...oldSchemaNames].filter((name) => !candidateNames.has(name)),
    ...(old_catalog || []).map((input) => input?.name).filter((name) => name && !newRuntimeNames.has(name)),
  ]);
  const removed = [...removedNames]
    .map((name) => Object.freeze({ name, action: 'removed' }));
  return Object.freeze({
    valid: true,
    errors: Object.freeze([]),
    warnings: Object.freeze(warnings),
    overrides: Object.freeze(overrides),
    migrations: Object.freeze(migrations),
    removed: Object.freeze(removed),
  });
}

export function planStrategySync({ local_source_sha256, account, pane_instances } = {}) {
  const errors = [];
  let accountAction = 'blocked';
  if (local_source_sha256 && account) {
    if (account.exists === false) accountAction = 'create';
    else if (account.exists === true && account.source_sha256) {
      accountAction = account.source_sha256 === local_source_sha256 ? 'reuse' : 'update';
    }
  }

  let paneAction = 'blocked';
  const matches = pane_instances?.matches || [];
  const accountVersion = account?.script?.version ?? null;
  const paneVersion = matches[0]?.version ?? null;
  const paneVersionMatches = accountVersion != null && paneVersion != null
    ? String(accountVersion) === String(paneVersion)
    : null;
  if (account?.exists === true && accountVersion == null) {
    errors.push(syncIssue(
      'ACCOUNT_STRATEGY_VERSION_UNAVAILABLE',
      'Account Saved Strategy version is unavailable; sync action cannot be verified.',
    ));
  }
  if (matches.length === 1 && paneVersion == null) {
    errors.push(syncIssue(
      'PANE_STRATEGY_VERSION_UNAVAILABLE',
      'Pane Strategy version is unavailable; latest-version reuse or refresh cannot be verified.',
    ));
  }
  if (accountAction !== 'blocked') {
    if (matches.length === 0) paneAction = 'add_latest';
    else if (matches.length === 1) {
      if (accountVersion == null || paneVersion == null) paneAction = 'blocked';
      else paneAction = accountAction === 'reuse' && paneVersionMatches === true ? 'reuse' : 'refresh';
    } else {
      paneAction = 'ambiguous';
    }
  }

  return Object.freeze({
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    account_action: accountAction,
    pane_action: paneAction,
    local_source_sha256: local_source_sha256 || null,
    account_source_sha256: account?.source_sha256 || null,
    source_matches: account?.exists && local_source_sha256
      ? account.source_sha256 === local_source_sha256
      : null,
    account_version: accountVersion,
    pane_version: paneVersion,
    pane_version_matches: paneVersionMatches,
  });
}

export class StrategySyncError extends CoreOperationError {
  constructor(message, {
    code = 'STRATEGY_SYNC_FAILED', phase = 'strategy_sync', retryable = false,
    context, entity_id, cause, sync_state, cleanup,
  } = {}) {
    super(message, { code, phase, retryable, context, entity_id, cause });
    this.name = 'StrategySyncError';
    this.sync_state = sync_state || null;
    this.cleanup = cleanup || null;
  }
}

function syncFailure(error, { code, phase, context, entity_id, sync_state, cleanup } = {}) {
  return new StrategySyncError(error?.message || String(error), {
    code: error?.code || code,
    phase: error?.phase || phase,
    retryable: error?.retryable === true,
    context: error?.context || context,
    entity_id: error?.entity_id || entity_id,
    cause: error,
    sync_state: error?.sync_state || sync_state,
    cleanup: error?.cleanup || cleanup,
  });
}

function assertExpectedPlan(expected, fresh, context) {
  if (!expected) return;
  const fields = [
    'account_action', 'pane_action', 'local_source_sha256',
    'account_source_sha256', 'account_version', 'pane_version',
  ];
  const changed = fields.filter((field) => (
    expected[field] !== undefined && !valuesEqual(expected[field], fresh[field])
  ));
  if (changed.length) {
    throw new StrategySyncError(`Strategy sync plan changed before mutation: ${changed.join(', ')}.`, {
      code: 'STRATEGY_SYNC_PLAN_STALE', phase: 'strategy_sync_revalidation', context,
    });
  }
}

async function verifiedAccountReadback({ script_id, saved_name, source_sha256, _deps }) {
  const getScript = _deps?.getSavedScript || getSavedScript;
  const script = await getScript({ script_id, _deps });
  if (script.script_id !== script_id || script.type !== 'strategy' || !exactSavedName(script, saved_name)) {
    throw new StrategySyncError('Account Saved Strategy identity/type readback mismatch.', {
      code: 'STRATEGY_ACCOUNT_READBACK_MISMATCH', phase: 'strategy_account_readback',
    });
  }
  const actualHash = normalizedPineSourceSha256(script.pine_source);
  if (actualHash !== source_sha256) {
    throw new StrategySyncError('Account Saved Strategy source readback does not match the local source.', {
      code: 'STRATEGY_SOURCE_READBACK_MISMATCH', phase: 'strategy_account_readback',
    });
  }
  if (script.version == null) {
    throw new StrategySyncError('Account Saved Strategy version is unavailable after synchronization.', {
      code: 'STRATEGY_VERSION_READBACK_MISMATCH', phase: 'strategy_account_readback',
    });
  }
  return Object.freeze({ ...script, source_sha256: actualHash });
}

async function readPane({ context, _deps }) {
  const reader = _deps?.readTargetPaneStudies || readTargetPaneStudies;
  return reader({ target_id: context.target_id, pane_index: context.pane_index, _deps });
}

async function cleanupOwnedNewInstance({ context, script_id, version, entity_id, _deps }) {
  if (!entity_id) return Object.freeze({ attempted: false, status: 'not_created' });
  try {
    const state = await readPane({ context, _deps });
    const owned = listPaneStrategyInstances({ pane_state: state, script_id })
      .find((instance) => (
        instance.entity_id === entity_id && String(instance.version) === String(version)
      ));
    if (!owned) {
      return Object.freeze({ attempted: false, status: 'ownership_unverified', entity_id });
    }
    const remove = _deps?.removeActivePaneStudy || removeActivePaneStudy;
    await remove({ entity_id, _deps });
    return Object.freeze({ attempted: true, status: 'removed', entity_id });
  } catch (error) {
    return Object.freeze({
      attempted: true,
      status: 'failed',
      entity_id,
      error: String(error?.message || error).slice(0, 500),
    });
  }
}

async function executePaneSync({
  context, account, account_action, candidate_schema, current_schema, timeout_ms, _deps,
}) {
  let phase = 'pane_sync_revalidation';
  let newEntityId = null;
  let oldRemovalStarted = false;
  let oldRemoved = false;
  let preserveNewForInspection = false;
  let oldInstance = null;
  const syncState = {
    account: {
      action: account_action,
      script_id: account.script_id,
      version: account.version,
      source_sha256: account.source_sha256,
    },
    pane: { action: null, old_entity_id: null, new_entity_id: null, phase },
  };
  try {
    let paneState = await readPane({ context, _deps });
    let matches = listPaneStrategyInstances({ pane_state: paneState, script_id: account.script_id });
    if (matches.length > 1) {
      throw new StrategySyncError(`Pane contains ${matches.length} matching Strategy Instances.`, {
        code: 'STRATEGY_INSTANCE_AMBIGUOUS', phase, context,
      });
    }
    oldInstance = matches[0] || null;
    if (oldInstance && oldInstance.version == null) {
      throw new StrategySyncError('Pane Strategy version is unavailable.', {
        code: 'PANE_STRATEGY_VERSION_UNAVAILABLE', phase, context,
        entity_id: oldInstance.entity_id,
      });
    }
    const paneAction = !oldInstance
      ? 'add_latest'
      : String(oldInstance.version) === String(account.version) ? 'reuse' : 'refresh';
    syncState.pane.action = paneAction;
    syncState.pane.old_entity_id = oldInstance?.entity_id || null;

    if (paneAction === 'reuse') {
      const schema = compareCandidateRuntimeInputSchema({
        candidate_schema, runtime_catalog: oldInstance.inputs,
      });
      if (!schema.valid) {
        throw new StrategySyncError(schema.errors[0].message, {
          code: schema.errors[0].code, phase: schema.errors[0].phase,
          context, entity_id: oldInstance.entity_id,
        });
      }
      phase = 'strategy_activation';
      const activate = _deps?.ensureStrategyActive || ensureStrategyActive;
      await activate({ entity_id: oldInstance.entity_id, context, timeout_ms, _deps });
      phase = 'strategy_report_stability';
      const waitReport = _deps?.waitForFreshTradingReport || waitForFreshTradingReport;
      const report = await waitReport({
        entity_id: oldInstance.entity_id, context, mutated: false, timeout_ms, _deps,
      });
      return Object.freeze({
        success: true,
        action: 'reuse',
        previous_entity_id: oldInstance.entity_id,
        entity_id: oldInstance.entity_id,
        script_id: account.script_id,
        version: account.version,
        inputs_fingerprint: oldInstance.inputs_fingerprint || fingerprintStudyInputs(oldInstance.inputs || []),
        schema_fingerprint: candidate_schema.input_schema_fingerprint || null,
        migration: Object.freeze({ action: 'not_required', warnings: schema.warnings }),
        report: Object.freeze({ stable_reads: report.stable_reads, status_type: report.status_type }),
      });
    }

    phase = 'pane_add_latest';
    const beforeIds = new Set(matches.map((instance) => instance.entity_id));
    const add = _deps?.addActivePaneStudy || addActivePaneStudy;
    const addResult = await add({ script_id: account.script_id, _deps });
    newEntityId = addResult?.entity_id || null;
    syncState.pane.new_entity_id = newEntityId;
    if (!newEntityId) {
      throw new StrategySyncError('Pane add latest returned no new entity_id.', {
        code: 'STRATEGY_REFRESH_FAILED', phase, context,
      });
    }
    paneState = await readPane({ context, _deps });
    matches = listPaneStrategyInstances({ pane_state: paneState, script_id: account.script_id });
    const created = matches.filter((instance) => !beforeIds.has(instance.entity_id));
    if (created.length !== 1 || created[0].entity_id !== newEntityId) {
      throw new StrategySyncError(`Pane add latest expected one new matching Instance, found ${created.length}.`, {
        code: 'STRATEGY_REFRESH_FAILED', phase, context, entity_id: newEntityId,
      });
    }
    const newInstance = created[0];
    if (String(newInstance.version) !== String(account.version)) {
      throw new StrategySyncError('New Pane Strategy identity/version readback mismatch.', {
        code: 'STRATEGY_VERSION_READBACK_MISMATCH', phase: 'pane_add_readback',
        context, entity_id: newEntityId,
      });
    }

    phase = 'strategy_runtime_schema';
    const migration = planStrategyInputMigration({
      old_catalog: oldInstance?.inputs || [],
      new_catalog: newInstance.inputs || [],
      current_schema,
      candidate_schema,
    });
    if (!migration.valid) {
      throw new StrategySyncError(migration.errors[0].message, {
        code: migration.errors[0].code, phase: migration.errors[0].phase,
        context, entity_id: newEntityId,
      });
    }

    if (Object.keys(migration.overrides).length) {
      phase = 'strategy_input_migration';
      const setInputs = _deps?.setStudyInputs || setStudyInputs;
      await setInputs({ entity_id: newEntityId, inputs: migration.overrides, _deps });
    }

    phase = 'strategy_new_readback';
    paneState = await readPane({ context, _deps });
    const readback = listPaneStrategyInstances({ pane_state: paneState, script_id: account.script_id })
      .find((instance) => instance.entity_id === newEntityId);
    if (!readback || String(readback.version) !== String(account.version)) {
      throw new StrategySyncError('New Pane Strategy disappeared or changed version during readback.', {
        code: 'STRATEGY_REFRESH_FAILED', phase, context, entity_id: newEntityId,
      });
    }
    const schemaReadback = compareCandidateRuntimeInputSchema({
      candidate_schema, runtime_catalog: readback.inputs,
    });
    if (!schemaReadback.valid) {
      throw new StrategySyncError(schemaReadback.errors[0].message, {
        code: schemaReadback.errors[0].code, phase: schemaReadback.errors[0].phase,
        context, entity_id: newEntityId,
      });
    }
    const readbackById = new Map((readback.inputs || []).map((input) => [input.id, input]));
    const changedInput = Object.entries(migration.overrides).find(([id, value]) => (
      !readbackById.has(id) || !valuesEqual(readbackById.get(id).value, value)
    ));
    if (changedInput) {
      throw new StrategySyncError(`Migrated Input readback mismatch: ${changedInput[0]}.`, {
        code: 'STUDY_INPUT_READBACK_MISMATCH', phase: 'strategy_input_migration_readback',
        context, entity_id: newEntityId,
      });
    }

    phase = 'strategy_activation';
    const activate = _deps?.ensureStrategyActive || ensureStrategyActive;
    await activate({ entity_id: newEntityId, context, timeout_ms, _deps });
    phase = 'strategy_report_stability';
    const waitReport = _deps?.waitForFreshTradingReport || waitForFreshTradingReport;
    const report = await waitReport({
      entity_id: newEntityId, context, mutated: false, timeout_ms, _deps,
    });

    if (oldInstance) {
      phase = 'pane_remove_ownership_check';
      paneState = await readPane({ context, _deps });
      matches = listPaneStrategyInstances({ pane_state: paneState, script_id: account.script_id });
      const verifiedOld = matches.find((instance) => (
        instance.entity_id === oldInstance.entity_id
        && String(instance.version) === String(oldInstance.version)
      ));
      const verifiedNew = matches.find((instance) => (
        instance.entity_id === newEntityId
        && String(instance.version) === String(account.version)
      ));
      if (matches.length !== 2 || !verifiedOld || !verifiedNew) {
        preserveNewForInspection = true;
        throw new StrategySyncError('Pane Strategy ownership changed before old Instance removal.', {
          code: 'STRATEGY_INSTANCE_OWNERSHIP_CHANGED', phase, context,
          entity_id: newEntityId,
        });
      }
      phase = 'pane_remove_old';
      oldRemovalStarted = true;
      const remove = _deps?.removeActivePaneStudy || removeActivePaneStudy;
      await remove({ entity_id: oldInstance.entity_id, _deps });
      oldRemoved = true;
    }

    phase = 'pane_final_readback';
    paneState = await readPane({ context, _deps });
    matches = listPaneStrategyInstances({ pane_state: paneState, script_id: account.script_id });
    if (
      matches.length !== 1
      || matches[0].entity_id !== newEntityId
      || String(matches[0].version) !== String(account.version)
    ) {
      throw new StrategySyncError('Pane final readback did not contain exactly one latest matching Instance.', {
        code: 'STRATEGY_REFRESH_FAILED', phase, context, entity_id: newEntityId,
      });
    }
    return Object.freeze({
      success: true,
      action: paneAction,
      previous_entity_id: oldInstance?.entity_id || null,
      entity_id: newEntityId,
      script_id: account.script_id,
      version: account.version,
      inputs_fingerprint: matches[0].inputs_fingerprint || fingerprintStudyInputs(matches[0].inputs || []),
      schema_fingerprint: candidate_schema.input_schema_fingerprint || null,
      migration: Object.freeze({
        preserved_count: migration.migrations.filter((item) => item.action === 'preserve').length,
        defaulted_count: migration.migrations.filter((item) => item.action === 'use_new_default').length,
        removed: migration.removed,
        warnings: migration.warnings,
      }),
      report: Object.freeze({ stable_reads: report.stable_reads, status_type: report.status_type }),
    });
  } catch (error) {
    let cleanup = Object.freeze({ attempted: false, status: 'not_required' });
    if (newEntityId && preserveNewForInspection) {
      cleanup = Object.freeze({
        attempted: false,
        status: 'preserve_new_after_ownership_change',
        entity_id: newEntityId,
      });
    } else if (newEntityId && !oldRemovalStarted) {
      cleanup = await cleanupOwnedNewInstance({
        context, script_id: account.script_id, version: account.version,
        entity_id: newEntityId, _deps,
      });
    } else if (newEntityId && oldRemovalStarted) {
      cleanup = Object.freeze({
        attempted: false,
        status: 'preserve_new_after_old_removal_started',
        entity_id: newEntityId,
      });
    }
    syncState.pane.phase = phase;
    syncState.recovery = Object.freeze({
      account_action: 'reuse',
      pane_action: oldRemovalStarted || preserveNewForInspection
        ? 'inspect'
        : oldInstance ? 'refresh' : 'add_latest',
      old_instance_preserved: oldInstance ? !oldRemoved : null,
      safe_to_retry: !oldRemovalStarted && !preserveNewForInspection
        && ['not_required', 'removed'].includes(cleanup.status),
    });
    throw syncFailure(error, {
      code: 'STRATEGY_REFRESH_FAILED', phase, context,
      entity_id: newEntityId || oldInstance?.entity_id,
      sync_state: Object.freeze(syncState), cleanup,
    });
  }
}

/** Execute compile-gated Account sync and safe Pane refresh in one pinned Chart Session. */
export async function executeStrategySync({
  saved_name,
  source,
  source_sha256,
  candidate_schema,
  current_schema,
  context,
  expected_plan,
  timeout_ms,
  _deps = {},
} = {}) {
  const normalizedSource = normalizePineSource(source);
  const localHash = normalizedPineSourceSha256(normalizedSource);
  const resolvedContext = normalizeContext(context);
  if (!saved_name || !normalizedSource.trim() || !resolvedContext.target_id) {
    throw new StrategySyncError('saved_name, Pine source, and resolved Chart context are required.', {
      code: 'STRATEGY_SYNC_INVALID', phase: 'strategy_sync_validation', context: resolvedContext,
    });
  }
  if (source_sha256 && source_sha256 !== localHash) {
    throw new StrategySyncError('Local Pine source changed after preflight.', {
      code: 'STRATEGY_SYNC_PLAN_STALE', phase: 'strategy_sync_revalidation', context: resolvedContext,
    });
  }
  if (detectPineType(normalizedSource) !== 'strategy') {
    throw new StrategySyncError('Local Pine source must declare strategy(...).', {
      code: 'PINE_TYPE_MISMATCH', phase: 'strategy_compile_gate', context: resolvedContext,
    });
  }
  const analyze = _deps.analyzePine || analyzePine;
  let analysis;
  try {
    analysis = await analyze({ source: normalizedSource });
  } catch (error) {
    throw new StrategySyncError(`Local Pine static analysis is unavailable: ${error?.message || String(error)}`, {
      code: 'PINE_ANALYZE_UNAVAILABLE', phase: 'strategy_compile_gate',
      retryable: error?.retryable === true, context: resolvedContext, cause: error,
    });
  }
  const staticErrors = (analysis.diagnostics || []).filter((item) => item.severity === 'error');
  if (staticErrors.length) {
    throw new StrategySyncError('Local Pine static analysis failed.', {
      code: 'PINE_ANALYZE_FAILED', phase: 'strategy_compile_gate', context: resolvedContext,
    });
  }
  const compile = _deps.checkPine || checkPine;
  let compiled;
  try {
    compiled = await compile({ source: normalizedSource });
  } catch (error) {
    throw new StrategySyncError(`TradingView Pine compile is unavailable: ${error?.message || String(error)}`, {
      code: 'PINE_COMPILE_UNAVAILABLE', phase: 'strategy_compile_gate',
      retryable: true, context: resolvedContext, cause: error,
    });
  }
  if (!compiled?.compiled || !compiled?.input_schema?.available) {
    throw new StrategySyncError('Local Pine source failed the server compile or Candidate Schema gate.', {
      code: compiled?.compiled ? 'PINE_INPUT_SCHEMA_UNRESOLVED' : 'PINE_COMPILE_FAILED',
      phase: 'strategy_compile_gate', context: resolvedContext,
    });
  }
  if (
    candidate_schema?.input_schema_fingerprint
    && candidate_schema.input_schema_fingerprint !== compiled.input_schema.input_schema_fingerprint
  ) {
    throw new StrategySyncError('Candidate Input Schema changed after preflight.', {
      code: 'STRATEGY_SYNC_PLAN_STALE', phase: 'strategy_sync_revalidation', context: resolvedContext,
    });
  }
  const effectiveCandidate = compiled.input_schema;
  const runWithSession = _deps.withChartSession || withChartSession;
  return runWithSession({ context: resolvedContext, _deps }, async () => {
    let phase = 'strategy_sync_revalidation';
    let accountAction = 'blocked';
    let accountBefore = null;
    let accountAfter = null;
    let accountWrite = null;
    try {
      const resolveAccount = _deps.resolveSavedStrategy || resolveSavedStrategy;
      const accountResolution = await resolveAccount({ saved_name, _deps });
      if (accountResolution.exists) {
        const readAccount = _deps.readResolvedSavedStrategy || readResolvedSavedStrategy;
        accountBefore = await readAccount({ resolved_account: accountResolution, _deps });
      }
      const paneState = await readPane({ context: resolvedContext, _deps });
      const paneMatches = accountResolution.exists
        ? listPaneStrategyInstances({
          pane_state: paneState, script_id: accountResolution.script.script_id,
        })
        : [];
      if (paneMatches.length > 1) {
        throw new StrategySyncError(`Pane contains ${paneMatches.length} matching Strategy Instances.`, {
          code: 'STRATEGY_INSTANCE_AMBIGUOUS', phase, context: resolvedContext,
        });
      }
      const freshPlan = planStrategySync({
        local_source_sha256: localHash,
        account: accountResolution.exists ? {
          ...accountResolution,
          source_sha256: accountBefore?.source_sha256 || null,
        } : accountResolution,
        pane_instances: { matches: paneMatches },
      });
      if (!freshPlan.valid) {
        throw new StrategySyncError(freshPlan.errors[0].message, {
          code: freshPlan.errors[0].code, phase: freshPlan.errors[0].phase,
          context: resolvedContext,
        });
      }
      assertExpectedPlan(expected_plan, freshPlan, resolvedContext);
      accountAction = freshPlan.account_action;

      if (accountAction === 'create') {
        phase = 'strategy_account_create';
        const create = _deps.createSavedScript || createSavedScript;
        accountWrite = await create({
          name: saved_name, type: 'strategy', source: normalizedSource, _deps,
        });
      } else if (accountAction === 'update') {
        phase = 'strategy_account_update';
        const update = _deps.updateSavedScript || updateSavedScript;
        accountWrite = await update({
          script_id: accountResolution.script.script_id,
          name: saved_name,
          source: normalizedSource,
          _deps,
        });
      }
      if (accountWrite && (accountWrite.success !== true || accountWrite.compile_ok !== true)) {
        throw new StrategySyncError(`Account Strategy ${accountAction} did not pass compile/readback.`, {
          code: 'STRATEGY_ACCOUNT_SYNC_FAILED', phase, context: resolvedContext,
        });
      }

      phase = 'strategy_account_readback';
      const scriptId = accountAction === 'create'
        ? accountWrite?.script_id
        : accountResolution.script.script_id;
      const account = await verifiedAccountReadback({
        script_id: scriptId,
        saved_name,
        source_sha256: localHash,
        _deps,
      });
      accountAfter = account;
      if (accountAction === 'update') {
        if (account.script_id !== accountResolution.script.script_id) {
          throw new StrategySyncError('Account update changed script_id.', {
            code: 'STRATEGY_ACCOUNT_READBACK_MISMATCH', phase, context: resolvedContext,
          });
        }
        const previousVersion = Number(accountBefore.version);
        const nextVersion = Number(account.version);
        const versionIncreased = Number.isFinite(previousVersion) && Number.isFinite(nextVersion)
          ? nextVersion > previousVersion
          : String(account.version) !== String(accountBefore.version);
        if (!versionIncreased) {
          throw new StrategySyncError('Account update did not create a newer version.', {
            code: 'STRATEGY_VERSION_READBACK_MISMATCH', phase, context: resolvedContext,
          });
        }
      }

      const pane = await executePaneSync({
        context: resolvedContext,
        account,
        account_action: accountAction,
        candidate_schema: effectiveCandidate,
        current_schema,
        timeout_ms,
        _deps,
      });
      return Object.freeze({
        success: true,
        context: sanitizeCoreContext(resolvedContext),
        source_sha256: localHash,
        candidate_schema_fingerprint: effectiveCandidate.input_schema_fingerprint,
        account: Object.freeze({
          action: accountAction,
          script_id: account.script_id,
          name: account.name,
          version: account.version,
          previous_version: accountBefore?.version || null,
          source_sha256: account.source_sha256,
        }),
        pane,
        warnings: Object.freeze([
          ...(compiled.warnings || []),
          ...(accountWrite?.warnings || []),
          ...(pane.migration?.warnings || []),
        ]),
      });
    } catch (error) {
      if (error instanceof StrategySyncError && error.sync_state) throw error;
      throw syncFailure(error, {
        code: 'STRATEGY_SYNC_FAILED', phase, context: resolvedContext,
        sync_state: Object.freeze({
          account: {
            action: accountAction,
            script_id: accountAfter?.script_id || accountWrite?.script_id || accountBefore?.script_id || null,
            version: accountAfter?.version || accountWrite?.version || accountBefore?.version || null,
            previous_version: accountBefore?.version || null,
            source_sha256: accountAfter?.source_sha256 || accountBefore?.source_sha256 || null,
          },
          pane: null,
        }),
      });
    }
  });
}
