import { CoreOperationError, ownDataProperty, toCoreDiagnostic } from './errors.js';
import {
  boundedUnclassifiedError,
  createErrorBoundary,
  normalizeLegacyCodes,
  preserveNormalizedError,
  preserveOwnedAbortReason,
  promoteInfrastructureCause,
  translateErrorCodes,
} from './error-policy.js';

export const STRATEGY_ERROR_KINDS = Object.freeze({
  ACCOUNT_STRATEGY_VERSION_UNAVAILABLE: 'validation',
  CHART_RESTORE_FAILED: 'identity',
  CHART_SESSION_INVALID: 'validation',
  CURRENT_PINE_INPUT_SCHEMA_UNAVAILABLE: 'validation',
  ENTITY_NOT_STRATEGY: 'validation',
  OUTPUT_ALREADY_EXISTS: 'conflict',
  OUTPUT_WRITE_FAILED: 'filesystem',
  PANE_CONTEXT_CHANGED: 'identity',
  PANE_INDEX_INVALID: 'validation',
  PANE_STUDY_INVENTORY_UNAVAILABLE: 'validation',
  PANE_STRATEGY_VERSION_UNAVAILABLE: 'validation',
  PARAMETER_SETS_REQUIRED: 'validation',
  PARAMETER_SET_EXECUTION_FAILED: 'internal',
  PARAMETER_SET_IDENTITY_INVALID: 'identity',
  PARAMETER_SET_INPUT_AMBIGUOUS: 'validation',
  PARAMETER_SET_INPUT_FINGERPRINT_MISMATCH: 'identity',
  PARAMETER_SET_INPUT_NOT_FOUND: 'validation',
  PARAMETER_SET_INPUT_VALUE_INVALID: 'validation',
  PARAMETER_SET_NAME_DUPLICATE: 'validation',
  PARAMETER_SET_NAME_INVALID: 'validation',
  PARAMETER_SET_PLAN_INVALID: 'validation',
  PARAMETER_SET_OPERATION_REQUIRED: 'validation',
  PARAMETER_SET_RESTORE_FAILED: 'internal',
  PARAMETER_SET_STRATEGY_CHANGED: 'identity',
  PINE_ANALYZE_FAILED: 'validation',
  PINE_ANALYZE_UNAVAILABLE: 'internal',
  PINE_COMPILE_FAILED: 'validation',
  PINE_COMPILE_UNAVAILABLE: 'internal',
  PINE_SOURCE_READ_FAILED: 'filesystem',
  PINE_INPUT_SCHEMA_UNRESOLVED: 'validation',
  PINE_TYPE_MISMATCH: 'validation',
  RUN_ALREADY_ACTIVE: 'conflict',
  RUN_ALREADY_SUCCEEDED: 'conflict',
  RUN_CONFIG_INVALID: 'validation',
  RUN_CONFIG_JSON_INVALID: 'validation',
  RUN_CONFIG_READ_FAILED: 'filesystem',
  RUN_CONFIG_REQUIRED: 'validation',
  RUN_CONFIG_UNKNOWN_FIELD: 'validation',
  RUN_CONFIG_VERSION_UNSUPPORTED: 'validation',
  RUN_UPDATE_SOURCE_NOT_FOUND: 'artifact',
  RUN_UPDATE_SOURCE_NOT_SUCCEEDED: 'conflict',
  RUN_UPDATE_LINEAGE_INVALID: 'artifact',
  RUN_UPDATE_LINEAGE_LIMIT_EXCEEDED: 'validation',
  RUN_UPDATE_IDENTITY_MISMATCH: 'identity',
  RUN_UPDATE_OPTION_INVALID: 'validation',
  RUN_EXTENSION_CONFIG_MISMATCH: 'validation',
  RUN_EXTENSION_DUPLICATE_EXPERIMENT: 'validation',
  RUN_EXTENSION_EXISTING_EXPERIMENT_CHANGED: 'validation',
  RUN_EXTENSION_IDENTITY_MISMATCH: 'identity',
  RUN_EXTENSION_LINEAGE_INVALID: 'artifact',
  RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED: 'validation',
  RUN_EXTENSION_NO_NEW_EXPERIMENTS: 'validation',
  RUN_EXTENSION_PARENT_NOT_FOUND: 'artifact',
  RUN_EXTENSION_PARENT_NOT_SUCCEEDED: 'conflict',
  RUN_ID_INVALID: 'validation',
  RUN_INTERRUPTED: 'interrupt',
  RUN_CANCELLED: 'interrupt',
  RUN_LEASE_FAILED: 'conflict',
  RUN_OUTPUT_EXISTS: 'conflict',
  RUN_OUTPUT_INVALID: 'filesystem',
  RUN_RESUME_ARTIFACT_INVALID: 'artifact',
  RUN_RESUME_IDENTITY_MISMATCH: 'identity',
  RUN_RESUME_NOT_FOUND: 'artifact',
  RUN_RESUME_VERSION_UNSUPPORTED: 'artifact',
  RUNTIME_INPUT_CATALOG_CHANGED: 'identity',
  RUNTIME_INPUT_CATALOG_EMPTY: 'validation',
  RUNTIME_INPUT_NAME_AMBIGUOUS: 'validation',
  RUNTIME_INPUT_NOT_FOUND: 'validation',
  RUNTIME_INPUT_TYPE_MISMATCH: 'validation',
  STALE_STRATEGY_SNAPSHOT: 'identity',
  STRATEGY_ACCOUNT_READBACK_MISMATCH: 'identity',
  STRATEGY_ACCOUNT_SYNC_FAILED: 'internal',
  STRATEGY_ACTIVATION_FAILED: 'identity',
  STRATEGY_CALCULATION_TIMEOUT: 'internal',
  STRATEGY_ENTITY_REQUIRED: 'validation',
  STRATEGY_EXPERIMENT_FAILED: 'internal',
  STRATEGY_INPUT_DEFAULT_EXPRESSION_UNVERIFIED: 'validation',
  STRATEGY_INPUT_OLD_NAME_AMBIGUOUS: 'validation',
  STRATEGY_INPUT_SCHEMA_READBACK_MISMATCH: 'identity',
  STRATEGY_INSTANCE_AMBIGUOUS: 'validation',
  STRATEGY_INSTANCE_OWNERSHIP_CHANGED: 'identity',
  STRATEGY_NAME_AMBIGUOUS: 'validation',
  STRATEGY_NOT_FOUND_IN_PANE: 'validation',
  STRATEGY_REPORT_UNAVAILABLE: 'internal',
  STRATEGY_REFRESH_FAILED: 'internal',
  STRATEGY_RESOLUTION_FAILED: 'validation',
  STRATEGY_RUNTIME_INVALID: 'validation',
  STRATEGY_RUN_FAILED: 'internal',
  STRATEGY_SOURCE_READBACK_MISMATCH: 'identity',
  STRATEGY_SYNC_FAILED: 'internal',
  STRATEGY_SYNC_INVALID: 'validation',
  STRATEGY_SYNC_PLAN_STALE: 'identity',
  STRATEGY_VERSION_READBACK_MISMATCH: 'identity',
  STUDY_INPUT_READBACK_MISMATCH: 'identity',
  SYMBOL_INVALID: 'validation',
  SYMBOL_REQUIRED: 'validation',
  TARGET_LAYOUT_AMBIGUOUS: 'validation',
  TARGET_LAYOUT_NOT_OPEN: 'validation',
  TARGET_LAYOUT_RESOLUTION_FAILED: 'validation',
  WATCHLIST_RESOLUTION_FAILED: 'validation',
  WATCHLIST_AMBIGUOUS: 'validation',
  WATCHLIST_DUPLICATE_SYMBOLS: 'validation',
  WATCHLIST_ID_REQUIRED: 'validation',
  WATCHLIST_INCOMPLETE: 'validation',
  WATCHLIST_INVALID_SYMBOLS: 'validation',
  WATCHLIST_NAME_REQUIRED: 'validation',
  WATCHLIST_NOT_FOUND: 'validation',
  WATCHLIST_SNAPSHOT_INVALID: 'validation',
  WATCHLIST_SNAPSHOT_UNAVAILABLE: 'validation',
  WATCHLIST_SNAPSHOT_UNSTABLE: 'identity',
  WATCHLIST_SNAPSHOT_UNSUPPORTED: 'validation',
  WATCHLIST_SYMBOL_INVALID: 'validation',
  WATCHLIST_SYMBOL_NOT_FOUND: 'validation',
  WATCHLIST_SYMBOL_VALIDATION_FAILED: 'validation',
  WATCHLIST_SYMBOL_VALIDATION_TIMEOUT: 'internal',
});

export const STRATEGY_INFRASTRUCTURE_ERROR_KINDS = Object.freeze({
  CDP_ACTIVE_TAB_NOT_CHART: 'cdp',
  CDP_ACTIVE_TARGET_AMBIGUOUS: 'cdp',
  CDP_ACTIVE_TARGET_UNRESOLVED: 'cdp',
  CDP_CHART_TARGET_NOT_FOUND: 'cdp',
  CDP_CONNECTION_FAILED: 'cdp',
  CDP_CONNECTION_CLOSED: 'cdp',
  CDP_DISCOVERY_FAILED: 'cdp',
  CDP_ERROR: 'cdp',
  CDP_TARGET_NOT_FOUND: 'cdp',
  CDP_TIMEOUT: 'cdp',
  OUTPUT_WRITE_FAILED: 'filesystem',
  PINE_SOURCE_READ_FAILED: 'filesystem',
  RUN_CONFIG_READ_FAILED: 'filesystem',
  RUN_OUTPUT_INVALID: 'filesystem',
});

function mappingTable(kinds) {
  return Object.freeze(Object.fromEntries(
    Object.entries(kinds).map(([code, kind]) => [code, Object.freeze({ kind })]),
  ));
}

const STRATEGY_LEGACY_MAPPINGS = mappingTable({
  ...STRATEGY_ERROR_KINDS,
  ...STRATEGY_INFRASTRUCTURE_ERROR_KINDS,
});
const STRATEGY_INFRASTRUCTURE_MAPPINGS = mappingTable(STRATEGY_INFRASTRUCTURE_ERROR_KINDS);
const SAFE_EXTRA_FIELDS = Object.freeze([
  'path',
  'layout_name',
  'pane_index',
  'match_count',
  'diagnostics',
]);

export function strategyErrorKind(code) {
  return STRATEGY_ERROR_KINDS[code]
    || STRATEGY_INFRASTRUCTURE_ERROR_KINDS[code]
    || null;
}

export function createStrategyErrorBoundary({
  phase,
  translations = {},
} = {}) {
  return createErrorBoundary({
    phase,
    mappers: [
      preserveOwnedAbortReason,
      promoteInfrastructureCause({ legacy_codes: STRATEGY_INFRASTRUCTURE_MAPPINGS }),
      translateErrorCodes(translations),
      preserveNormalizedError,
      normalizeLegacyCodes(STRATEGY_LEGACY_MAPPINGS),
      boundedUnclassifiedError(),
    ],
  });
}

export function strategyDiagnostic(error, {
  phase,
  translations,
} = {}) {
  const ownedPhase = ownDataProperty(error, 'phase') || phase;
  const diagnostic = createStrategyErrorBoundary({ phase: ownedPhase, translations }).diagnostic(error);
  const result = { ...diagnostic };
  for (const field of SAFE_EXTRA_FIELDS) {
    const value = ownDataProperty(error, field);
    if (value !== undefined) result[field] = value;
  }
  return Object.freeze(result);
}

export function strategyDiagnostics(errors, options) {
  return Object.freeze((errors || []).map((error) => strategyDiagnostic(error, options)));
}

export function strategyCoreError(message, {
  code,
  kind = strategyErrorKind(code) || 'internal',
  phase,
  stage,
  entity_id,
  symbol,
  retryable = false,
  context,
  timeout_ms,
  target_id,
  chart_id,
  signal,
  exit_code,
  cause,
} = {}) {
  return new CoreOperationError(message, {
    code,
    kind,
    phase,
    stage,
    entity_id,
    symbol,
    retryable,
    context,
    timeout_ms,
    target_id,
    chart_id,
    signal,
    exit_code,
    cause,
  });
}

export function rehydrateStrategyRunError(record) {
  if (!record) return null;
  return new CoreOperationError(record.message, {
    code: record.code,
    kind: strategyErrorKind(record.code) || 'internal',
    phase: record.phase,
    retryable: false,
  });
}

export function strategyErrorDiagnosticFromRecord(record) {
  return toCoreDiagnostic(rehydrateStrategyRunError(record));
}
