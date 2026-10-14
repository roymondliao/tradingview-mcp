import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, join } from 'node:path';
import { readJson } from './io.js';
import { CHECKS } from './registry.js';
export const fixtureFingerprint = fixture => createHash('sha256').update(JSON.stringify(fixture||null)).digest('hex');
/** Restore only read-only outcomes; operation tests never contribute to certification. */
export function baselineStatuses(report) {
  if (report.schema_version === 1) return new Map(report.checks.flatMap(c => c.assertions).filter(a => a.stage === 'read-only').map(a => [a.id, a.status]));
  if (![2, 3].includes(report.schema_version) || !Array.isArray(report.checks) || !Array.isArray(report.issues)) throw new Error('Unsupported baseline report');
  const present = new Set(report.checks.map(c => c.id));
  if (CHECKS.some(c => !present.has(c.id))) throw new Error('Incomplete baseline report');
  const statuses = new Map(CHECKS.flatMap(c => c.assertions.map(a => [a.id, 'passed'])));
  const apply = (id, status) => {
    if (report.schema_version === 2 && id?.includes('.controlled.')) return;
    if (!statuses.has(id)) throw new Error('Invalid baseline assertion');
    statuses.set(id, status);
  };
  for (const issue of report.issues) {
    if (!['failed', 'blocked', 'not_run'].includes(issue.status)) throw new Error('Invalid baseline issue');
    for (const id of issue.assertions) apply(id, issue.status);
  }
  for (const exclusion of report.exclusions || []) {
    const ids = exclusion.assertions || [exclusion.assertion];
    if (!ids.length || !exclusion.reason || exclusion.evidence == null) throw new Error('Invalid baseline exclusion');
    for (const id of ids) apply(id, 'not_applicable');
  }
  const counts = report.schema_version === 2 ? report.coverage?.read : report.coverage;
  if (counts?.total !== statuses.size) throw new Error('Invalid baseline coverage');
  for (const status of ['passed', 'failed', 'blocked', 'not_run', 'not_applicable']) if (counts[status] !== [...statuses.values()].filter(s => s === status).length) throw new Error('Invalid baseline counts');
  return statuses;
}
export async function compareBaseline(report, previous, root) {
  const reference=previous?.last_check?.report_path || previous?.verification?.report_path;
  if(!reference)return {status:'not_comparable',reason:'NO_BASELINE'};
  const rel=relative(resolve(root,'reports'),resolve(reference));
  if(rel.startsWith('..')||isAbsolute(rel))return {status:'not_comparable',reason:'BASELINE_OUTSIDE_REPORT_STORE'};
  try{
    const before=await readJson(join(root,'reports',rel),1024*1024);
    if(before.profile!==report.profile||before.registry_revision!==report.registry_revision||before.fixture_fingerprint!==report.fixture_fingerprint||before.environment?.source_fingerprint!==report.environment?.source_fingerprint)return {status:'not_comparable',reason:'SCOPE_OR_IMPLEMENTATION_DIFFERS'};
    const old=baselineStatuses(before);
    const current=report.checks.flatMap(c=>c.assertions);
    return {status:'comparable',from_version:before.desktop_version||before.environment?.desktop_version||null,to_version:report.environment?.desktop_version||null,report_path:reference,new_failures:current.filter(a=>a.status==='failed'&&old.get(a.id)!=='failed').map(a=>a.id),recovered:current.filter(a=>a.status==='passed'&&old.get(a.id)==='failed').map(a=>a.id),unchanged:current.filter(a=>old.get(a.id)===a.status).map(a=>a.id)};
  }catch{return {status:'not_comparable',reason:'BASELINE_UNAVAILABLE'};}
}
