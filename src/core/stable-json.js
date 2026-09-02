/** Deterministic JSON and SHA-256 helpers for versioned Core identities. */
import { createHash } from 'node:crypto';

export function normalizeStableValue(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(normalizeStableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeStableValue(value[key])]),
    );
  }
  return String(value);
}

export function stableJsonStringify(value) {
  return JSON.stringify(normalizeStableValue(value));
}

export function sha256Hex(value) {
  return createHash('sha256').update(
    typeof value === 'string' ? value : stableJsonStringify(value),
  ).digest('hex');
}
