import { configuredEndpoint, effectiveStatus, implementationIdentity } from './identity.js';
import { readState } from './store.js';
export async function compatibilityStatus({ endpoint = configuredEndpoint(), root, implementation = implementationIdentity(), _deps = {} } = {}) {
  let loaded;
  try { loaded = await (_deps.readState || readState)({ root }); }
  catch { loaded = { status: 'invalid', reason: 'state_unreadable', state: { endpoints: {} } }; }
  const entry = loaded.state.endpoints[endpoint.key];
  const effective = loaded.status === 'invalid' ? { status: 'blocked', reason: loaded.reason } : effectiveStatus(entry, implementation);
  return {
    success: true, endpoint: endpoint.key, ...effective,
    last_observed_version: entry?.observed?.desktop_version || null,
    last_observed_at: entry?.observed?.observed_at || null,
    verified_version: entry?.verification?.identity?.desktop_version || null,
    ...(entry?.verification?.exclusions?.some(e => e.reason === 'USER_SCOPE_EXCLUDED') && {
      verified_excluded_checks: [...new Set(entry.verification.exclusions.filter(e => e.reason === 'USER_SCOPE_EXCLUDED').map(e => e.id.split('.')[0]))],
    }),
    last_check: entry?.last_check || null,
  };
}
export async function readCompatibilityAdvisory(options) {
  try {
    const result = await compatibilityStatus(options);
    if (result.status === 'passed') return null;
    const short = v => v == null ? null : String(v).slice(0, 100);
    return { level: 'warning', code: 'COMPATIBILITY_CHECK_RECOMMENDED', status: result.status,
      reason: short(result.reason), observed_version: short(result.last_observed_version),
      verified_version: short(result.verified_version), next_command: 'tv compatibility check' };
  } catch {
    return { level: 'warning', code: 'COMPATIBILITY_CHECK_RECOMMENDED', status: 'blocked', reason: 'state_unreadable', next_command: 'tv compatibility check' };
  }
}
export async function emitCompatibilityAdvisory({ dependency, write = text => process.stderr.write(text), ...options }) {
  if (dependency !== 'required') return;
  const warning = await readCompatibilityAdvisory(options);
  if (warning) write(`${JSON.stringify(warning)}\n`);
}
