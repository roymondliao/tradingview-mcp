import { ownDataProperty, toCoreDiagnostic } from '../core/errors.js';
import { normalizePresentationError } from '../core/error-policy.js';

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
  const diagnostic = toCoreDiagnostic(normalizePresentationError(error, {
    phase: ownDataProperty(error, 'phase') || 'mcp_delivery',
  }));
  const { message, ...fields } = diagnostic;
  return {
    success: false,
    ...extra,
    ...fields,
    error: message,
  };
}

export function coreErrorResult(error, extra) {
  return jsonResult(coreErrorPayload(error, extra), true);
}
