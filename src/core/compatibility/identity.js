/** Pure identity rules: safe to load from the local-only CLI advisory. */
import { CoreOperationError } from '../errors.js';
export const SCHEMA_VERSION = 1;
export const CHECKER_REVISION = 2;
export const ADAPTER_REVISION = 1;
export const COMPATIBILITY_SCOPE = 'read_only_desktop_contracts';
export const REGISTRY_REVISION = 2;
export const IDENTITY_FIELDS = Object.freeze([
  'desktop_version', 'electron_version', 'chromium_version', 'protocol_version',
  'platform', 'architecture', 'node_major', 'checker_revision', 'adapter_revision',
]);
export const STATUSES = Object.freeze(['unchecked', 'checking', 'passed', 'failed', 'blocked']);
export function compatibilityError(code, message, kind = 'validation', cause) {
  return new CoreOperationError(message, { code, kind, phase: 'compatibility', cause });
}
export function configuredEndpoint(env = process.env) {
  return normalizeEndpoint({ host: env.TV_CDP_HOST || env.CDP_HOST || '127.0.0.1', port: env.TV_CDP_PORT || env.CDP_PORT || 9222 });
}
export function normalizeEndpoint({ host = '127.0.0.1', port = 9222 } = {}) {
  host = String(host).trim().toLowerCase().replace(/^\[|\]$/g, '');
  port = Number(port);
  if (!host || !/^[a-z0-9.:%_-]+$/i.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw compatibilityError('COMPATIBILITY_ENDPOINT_INVALID', 'Invalid CDP host or port.');
  }
  const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  return Object.freeze({ host, port, key: authority, url: `http://${authority}` });
}
export function implementationIdentity() {
  return { platform: process.platform, architecture: process.arch, node_major: Number(process.versions.node.split('.')[0]), checker_revision: CHECKER_REVISION, adapter_revision: ADAPTER_REVISION };
}
export function sameIdentity(a, b) {
  return Boolean(a?.desktop_version && b?.desktop_version) && IDENTITY_FIELDS.every(k => Object.hasOwn(a, k) && Object.hasOwn(b, k) && a[k] === b[k]);
}
export function effectiveStatus(entry, implementation = implementationIdentity()) {
  if (!entry) return { status: 'unchecked', reason: 'no_observation' };
  if (!STATUSES.includes(entry.status)) return { status: 'blocked', reason: 'invalid_state' };
  if (entry.active_check) return { status: 'checking', reason: 'check_in_progress_or_interrupted' };
  if (!entry.observed?.desktop_version) return { status: 'blocked', reason: entry.reason || 'version_unavailable' };
  if (Object.entries(implementation).some(([k, v]) => entry.observed[k] !== v)) return { status: 'unchecked', reason: 'implementation_changed' };
  if (entry.status === 'passed' && (!sameIdentity(entry.observed, entry.verification?.identity)
      || !entry.verification?.report_path || !entry.verification?.report_sha256
      || entry.verification.scope !== COMPATIBILITY_SCOPE)) {
    return { status: 'unchecked', reason: 'verification_invalid' };
  }
  return { status: entry.status, reason: entry.reason || null };
}
