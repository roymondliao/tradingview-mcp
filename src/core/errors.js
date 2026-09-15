/** Shared structured errors for Core application and runtime operations. */

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

export function sanitizeCoreContext(context) {
  if (!context || typeof context !== 'object') return undefined;
  const sanitized = {};
  for (const field of SAFE_CONTEXT_FIELDS) {
    const value = context[field];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) sanitized[field] = value;
  }
  return sanitized;
}

export class CoreOperationError extends Error {
  constructor(message, {
    code = 'CORE_OPERATION_FAILED',
    phase,
    entity_id,
    symbol,
    retryable = false,
    context,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CoreOperationError';
    this.code = code;
    if (phase) this.phase = phase;
    if (entity_id) this.entity_id = entity_id;
    if (symbol) this.symbol = symbol;
    this.retryable = retryable === true;
    const safeContext = sanitizeCoreContext(context);
    if (safeContext) this.context = safeContext;
  }
}
