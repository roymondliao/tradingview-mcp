/**
 * Shared MCP response formatting helper.
 * All tool files use this instead of manually constructing MCP responses.
 */
export function jsonResult(obj, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isError && { isError: true }),
  };
}

/** Preserve stable Core error metadata without exposing stack/cause/runtime objects. */
export function coreErrorPayload(error, extra = {}) {
  return {
    success: false,
    ...(error?.code && { code: error.code }),
    error: error?.message || String(error),
    ...(error?.stage && { stage: error.stage }),
    ...(error?.phase && { phase: error.phase }),
    ...(error?.entity_id && { entity_id: error.entity_id }),
    ...(error?.symbol && { symbol: error.symbol }),
    ...(error?.retryable !== undefined && { retryable: error.retryable === true }),
    ...(error?.context && { context: error.context }),
    ...(error?.timeout_ms !== undefined && { timeout_ms: error.timeout_ms }),
    ...extra,
  };
}

export function coreErrorResult(error, extra) {
  return jsonResult(coreErrorPayload(error, extra), true);
}
