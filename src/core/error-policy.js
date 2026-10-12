import {
  CoreOperationError,
  assertNormalizedCoreError,
  boundedRootCauseMessage,
  findErrorCause,
  isNormalizedCoreError,
  ownDataProperty,
  toCoreDiagnostic,
  withCoreErrorPhase,
} from './errors.js';

function exactMapping(map, code) {
  if (!map || !code || !Object.prototype.hasOwnProperty.call(map, code)) return null;
  const mapping = map[code];
  return typeof mapping === 'string' ? { kind: mapping } : mapping;
}

function mappedError(error, mapping, context = {}) {
  const phase = mapping.phase || context.phase || ownDataProperty(error, 'phase');
  return new CoreOperationError(
    mapping.message || ownDataProperty(error, 'message') || boundedRootCauseMessage(error),
    {
      code: mapping.code || ownDataProperty(error, 'code') || 'CORE_UNCLASSIFIED_ERROR',
      kind: mapping.kind,
      phase,
      stage: mapping.stage || ownDataProperty(error, 'stage'),
      entity_id: ownDataProperty(error, 'entity_id'),
      symbol: ownDataProperty(error, 'symbol'),
      retryable: mapping.retryable ?? (ownDataProperty(error, 'retryable') === true),
      context: ownDataProperty(error, 'context'),
      timeout_ms: ownDataProperty(error, 'timeout_ms'),
      target_id: ownDataProperty(error, 'target_id'),
      chart_id: ownDataProperty(error, 'chart_id'),
      signal: ownDataProperty(error, 'signal'),
      exit_code: ownDataProperty(error, 'exit_code'),
      cause: ownDataProperty(error, 'cause'),
    },
  );
}

function markFallback(mapper) {
  Object.defineProperty(mapper, 'is_error_fallback', { value: true });
  return mapper;
}

export function composeErrorMappers(...mappers) {
  if (mappers.length === 0 || mappers.at(-1)?.is_error_fallback !== true) {
    throw new TypeError('Error mapper chain requires a final fallback.');
  }
  return (error, context = {}) => {
    for (const mapper of mappers) {
      if (typeof mapper !== 'function') throw new TypeError('Error mapper must be a function.');
      const mapped = mapper(error, context);
      if (!mapped) continue;
      return assertNormalizedCoreError(mapped);
    }
    throw new TypeError('Error mapper chain requires a final fallback.');
  };
}

export function preserveOwnedAbortReason(error, context = {}) {
  const reason = context.signal?.reason;
  if (isNormalizedCoreError(reason)) return withCoreErrorPhase(reason, context.phase);
  const interrupt = findErrorCause(error, (candidate) => (
    isNormalizedCoreError(candidate) && ownDataProperty(candidate, 'kind') === 'interrupt'
  ));
  if (interrupt) return withCoreErrorPhase(interrupt, context.phase);
  const legacy = findErrorCause(error, (candidate) => (
    ['RUN_INTERRUPTED', 'RUN_CANCELLED'].includes(ownDataProperty(candidate, 'code'))
  ));
  if (!legacy) return null;
  return mappedError(legacy, {
    kind: 'interrupt',
    stage: ownDataProperty(legacy, 'stage') || (ownDataProperty(legacy, 'signal') ? 'process_signal' : undefined),
  }, context);
}

export function promoteInfrastructureCause({ legacy_codes = {} } = {}) {
  return (error, context = {}) => {
    for (const kind of ['cdp', 'filesystem']) {
      const normalized = findErrorCause(error, (candidate) => (
        isNormalizedCoreError(candidate) && ownDataProperty(candidate, 'kind') === kind
      ));
      if (normalized) return withCoreErrorPhase(normalized, context.phase);
      const legacy = findErrorCause(error, (candidate) => (
        exactMapping(legacy_codes, ownDataProperty(candidate, 'code'))?.kind === kind
      ));
      if (legacy) return mappedError(legacy, exactMapping(legacy_codes, ownDataProperty(legacy, 'code')), context);
    }
    return null;
  };
}

export function preserveNormalizedError(error, context = {}) {
  return isNormalizedCoreError(error) ? withCoreErrorPhase(error, context.phase) : null;
}

export function normalizeLegacyCodes(map = {}) {
  return (error, context = {}) => {
    const mapping = exactMapping(map, ownDataProperty(error, 'code'));
    return mapping?.kind ? mappedError(error, mapping, context) : null;
  };
}

export function translateErrorCodes(map = {}) {
  return (error, context = {}) => {
    const mapping = exactMapping(map, ownDataProperty(error, 'code'));
    return mapping?.kind ? mappedError(error, mapping, context) : null;
  };
}

export function boundedUnclassifiedError({ phase, stage } = {}) {
  return markFallback((error, context = {}) => new CoreOperationError(
    boundedRootCauseMessage(error),
    {
      code: 'CORE_UNCLASSIFIED_ERROR',
      kind: 'internal',
      phase: context.phase || phase,
      stage: ownDataProperty(error, 'stage') || stage || (!(context.phase || phase) ? 'error_normalization' : undefined),
      retryable: false,
      cause: error instanceof Error ? error : undefined,
    },
  ));
}

export function createErrorBoundary({
  phase,
  mappers,
  projection = toCoreDiagnostic,
} = {}) {
  const normalizeMapped = composeErrorMappers(...(mappers || []));
  const normalize = (error, context = {}) => normalizeMapped(error, {
    phase: context.phase || phase,
    signal: context.signal,
  });
  return Object.freeze({
    normalize,
    error: normalize,
    diagnostic(error, context) {
      return projection(normalize(error, context));
    },
  });
}

export function normalizePresentationError(error, {
  phase = 'presentation',
} = {}) {
  return createErrorBoundary({
    phase,
    mappers: [
      preserveOwnedAbortReason,
      preserveNormalizedError,
      boundedUnclassifiedError(),
    ],
  }).error(error);
}

export function coreErrorFromDiagnostic(diagnostic, { cause } = {}) {
  return new CoreOperationError(diagnostic.message, {
    code: diagnostic.code,
    kind: diagnostic.kind,
    phase: diagnostic.phase,
    stage: diagnostic.stage,
    entity_id: diagnostic.entity_id,
    symbol: diagnostic.symbol,
    retryable: diagnostic.retryable,
    context: diagnostic.context,
    timeout_ms: diagnostic.timeout_ms,
    target_id: diagnostic.target_id,
    chart_id: diagnostic.chart_id,
    signal: diagnostic.signal,
    exit_code: diagnostic.exit_code,
    cause,
  });
}
