/** Shared structured errors for Core application and runtime operations. */

export const CORE_ERROR_KINDS = Object.freeze([
  'validation',
  'identity',
  'cdp',
  'filesystem',
  'artifact',
  'conflict',
  'interrupt',
  'internal',
]);

export const CORE_ERROR_CAUSE_MAX_NODES = 16;

const CORE_ERROR_KIND_SET = new Set(CORE_ERROR_KINDS);
const STRING_LIMITS = Object.freeze({
  message: 1000,
  code: 100,
  phase: 100,
  stage: 100,
  entity_id: 200,
  symbol: 200,
  target_id: 200,
  chart_id: 200,
});
const SAFE_CONTEXT_FIELDS = Object.freeze([
  'tab_index',
  'target_id',
  'url_chart_id',
  'layout_id',
  'saved_layout_id',
  'layout_name',
  'pane_layout',
  'pane_index',
  'pane_id',
  'symbol',
  'resolution',
]);
const DIAGNOSTIC_STRING_FIELDS = Object.freeze([
  'phase',
  'stage',
  'entity_id',
  'symbol',
  'target_id',
  'chart_id',
]);

function boundedString(value, field, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw new TypeError(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string.`);
  const text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (!text && required) throw new TypeError(`${field} is required.`);
  return text.slice(0, STRING_LIMITS[field] || STRING_LIMITS.message);
}

export function ownDataProperty(object, key) {
  if (!object || (typeof object !== 'object' && typeof object !== 'function')) return undefined;
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(object, key);
  } catch {
    return undefined;
  }
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function traversable(value) {
  if (value instanceof Error) return true;
  if (!value) return false;
  try {
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

export function sanitizeCoreContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  const sanitized = {};
  for (const field of SAFE_CONTEXT_FIELDS) {
    const value = ownDataProperty(context, field);
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) sanitized[field] = value;
  }
  return Object.keys(sanitized).length > 0 ? Object.freeze(sanitized) : undefined;
}

export class CoreOperationError extends Error {
  constructor(message, {
    code = 'CORE_OPERATION_FAILED',
    kind,
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
    const safeMessage = boundedString(String(message ?? code), 'message', { required: true });
    super(safeMessage, cause !== undefined ? { cause } : undefined);
    this.name = 'CoreOperationError';
    this.code = boundedString(code, 'code', { required: true });
    if (kind !== undefined) {
      if (!CORE_ERROR_KIND_SET.has(kind)) throw new TypeError(`Unknown Core error kind: ${kind}`);
      this.kind = kind;
    }
    for (const [field, value] of Object.entries({ phase, stage, entity_id, symbol, target_id, chart_id })) {
      const safe = boundedString(value, field);
      if (safe !== undefined) this[field] = safe;
    }
    this.retryable = retryable === true;
    const safeContext = sanitizeCoreContext(context);
    if (safeContext) this.context = safeContext;
    if (timeout_ms !== undefined) {
      const timeout = Number(timeout_ms);
      if (!Number.isFinite(timeout) || timeout < 0) throw new TypeError('timeout_ms must be non-negative.');
      this.timeout_ms = timeout;
    }
    if (signal !== undefined) {
      if (!['SIGINT', 'SIGTERM'].includes(signal)) throw new TypeError('signal must be SIGINT or SIGTERM.');
      this.signal = signal;
    }
    if (exit_code !== undefined) {
      if (![130, 143].includes(exit_code)) throw new TypeError('exit_code must be 130 or 143.');
      if ((signal === 'SIGINT' && exit_code !== 130) || (signal === 'SIGTERM' && exit_code !== 143)) {
        throw new TypeError('signal and exit_code do not match.');
      }
      this.exit_code = exit_code;
    }
  }
}

export function findErrorCause(error, predicate, {
  max_nodes = CORE_ERROR_CAUSE_MAX_NODES,
} = {}) {
  if (typeof predicate !== 'function') throw new TypeError('Cause predicate is required.');
  const limit = Math.max(0, Math.trunc(Number(max_nodes) || 0));
  const seen = new Set();
  let current = error;
  for (let visited = 0; traversable(current) && visited < limit; visited += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (predicate(current)) return current;
    current = ownDataProperty(current, 'cause');
  }
  return null;
}

export function isNormalizedCoreError(error) {
  if (!error || typeof error !== 'object') return false;
  const code = ownDataProperty(error, 'code');
  const kind = ownDataProperty(error, 'kind');
  const message = ownDataProperty(error, 'message');
  const phase = ownDataProperty(error, 'phase');
  const stage = ownDataProperty(error, 'stage');
  const retryable = ownDataProperty(error, 'retryable');
  return typeof code === 'string'
    && code.length > 0
    && CORE_ERROR_KIND_SET.has(kind)
    && typeof message === 'string'
    && message.length > 0
    && typeof retryable === 'boolean'
    && ((typeof phase === 'string' && phase.length > 0) || (typeof stage === 'string' && stage.length > 0));
}

export function assertNormalizedCoreError(error) {
  if (!isNormalizedCoreError(error)) {
    throw new TypeError('A normalized Core error with code, kind, phase/stage, message, and retryable is required.');
  }
  return error;
}

function normalizedOptions(error, overrides = {}) {
  const options = {};
  for (const field of [
    'code', 'kind', 'phase', 'stage', 'entity_id', 'symbol', 'retryable', 'context',
    'timeout_ms', 'target_id', 'chart_id', 'signal', 'exit_code', 'cause',
  ]) {
    const value = Object.prototype.hasOwnProperty.call(overrides, field)
      ? overrides[field]
      : ownDataProperty(error, field);
    if (value !== undefined) options[field] = value;
  }
  return options;
}

export function copyCoreError(error, overrides = {}) {
  const message = Object.prototype.hasOwnProperty.call(overrides, 'message')
    ? overrides.message
    : ownDataProperty(error, 'message');
  return new CoreOperationError(message, normalizedOptions(error, overrides));
}

export function withCoreErrorPhase(error, phase) {
  assertNormalizedCoreError(error);
  if (!phase || ownDataProperty(error, 'phase') === phase) return error;
  return copyCoreError(error, { phase });
}

export function boundedRootCauseMessage(error, fallback = 'Unexpected Core operation failure.') {
  let selected;
  findErrorCause(error, (current) => {
    const message = ownDataProperty(current, 'message');
    if (typeof message === 'string' && message.trim()) selected = message;
    return false;
  });
  if (!selected && !traversable(error) && error != null) selected = String(error);
  return boundedString(String(selected || fallback), 'message', { required: true });
}

export function toCoreDiagnostic(error) {
  assertNormalizedCoreError(error);
  const diagnostic = {
    code: boundedString(ownDataProperty(error, 'code'), 'code', { required: true }),
    kind: ownDataProperty(error, 'kind'),
    message: boundedString(ownDataProperty(error, 'message'), 'message', { required: true }),
  };
  for (const field of DIAGNOSTIC_STRING_FIELDS) {
    const value = boundedString(ownDataProperty(error, field), field);
    if (value !== undefined) diagnostic[field] = value;
  }
  diagnostic.retryable = ownDataProperty(error, 'retryable') === true;
  const context = sanitizeCoreContext(ownDataProperty(error, 'context'));
  if (context) diagnostic.context = context;
  const timeout = ownDataProperty(error, 'timeout_ms');
  if (Number.isFinite(timeout) && timeout >= 0) diagnostic.timeout_ms = timeout;
  const signal = ownDataProperty(error, 'signal');
  const exitCode = ownDataProperty(error, 'exit_code');
  if (['SIGINT', 'SIGTERM'].includes(signal)) diagnostic.signal = signal;
  if ([130, 143].includes(exitCode)) diagnostic.exit_code = exitCode;
  return Object.freeze(diagnostic);
}
