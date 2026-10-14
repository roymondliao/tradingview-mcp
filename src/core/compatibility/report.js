import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { atomicJson } from './io.js';
import { compatibilityError } from './identity.js';
export const ASSERTION_STATUSES = ['passed','failed','blocked','not_run','not_applicable'];
export function resultFor(definition, status, details = {}) {
  if (!ASSERTION_STATUSES.includes(status)) throw new TypeError('Invalid assertion status');
  return { ...definition, kind: definition.kind || 'behavior', expected: definition.expected || null, observed: null, reason_code: null, failure_origin: null, version_relation: 'not_established', blocked_by: [], status, ...details };
}
export function aggregateStatus(assertions) {
  if (!assertions.length || assertions.every(a=>a.status==='not_applicable')) return 'not_applicable';
  return ['failed','blocked','not_run','passed'].find(s=>assertions.some(a=>a.status===s));
}
const count = entries => Object.fromEntries([['total',entries.length],...ASSERTION_STATUSES.map(s=>[s,entries.filter(x=>x.status===s).length])]);
export function finishReport(report) {
  for (const check of report.checks) check.status = aggregateStatus(check.assertions);
  const assertions = report.checks.flatMap(c => c.assertions);
  const applicable = assertions.filter(a => a.status !== 'not_applicable');
  const failures = assertions.filter(a => a.status === 'failed');
  const blocked = applicable.filter(a => a.status === 'blocked');
  const unrun = applicable.filter(a => a.status === 'not_run');
  const unknown = failures.some(a => ['checker', 'undetermined'].includes(a.failure_origin));
  let overall;
  if (report.execution_status === 'interrupted') overall = 'interrupted';
  else if (report.execution_status === 'checker_error' || unknown) overall = 'checker_error';
  else if (failures.length) overall = 'incompatible';
  else if (blocked.some(a => a.failure_origin === 'environment')) overall = 'environment_blocked';
  else if (blocked.some(a => a.failure_origin === 'fixture')) overall = 'fixture_blocked';
  else if (blocked.length || unrun.length || !applicable.length) overall = 'validation_blocked';
  else overall = 'compatible';
  report.overall_status = overall;
  report.compatible = failures.some(a => !['checker', 'undetermined'].includes(a.failure_origin)) ? false : overall === 'compatible' ? true : null;
  report.summary = { check_counts: count(report.checks), assertion_counts: count(assertions) };
  report.coverage = {
    full_contract_complete: applicable.length > 0 && applicable.every(a => a.status === 'passed'),
    exclusions: assertions.filter(a => a.status === 'not_applicable').map(a => ({ id: a.id, reason: a.reason_code, evidence: a.observed })),
  };
  report.promotion = { eligible: overall === 'compatible', target_status: overall === 'compatible' ? 'passed' : overall === 'incompatible' ? 'failed' : 'blocked', reason: overall };
  report.next_steps = [];
  const unresolved = applicable.filter(a => a.status !== 'passed');
  if (unresolved.length) report.next_steps.push({ action: overall === 'incompatible' ? 'INVESTIGATE_CONTRACT' : 'RESOLVE_PREREQUISITES', assertion_ids: unresolved.map(a => a.id), check_ids: report.checks.filter(c => c.assertions.some(a => unresolved.includes(a))).map(c => c.id) });
  report.completed_at = new Date().toISOString();
  report.duration_ms = Date.now() - Date.parse(report.started_at);
  return report;
}
export function validateReport(report) {
  if (report.schema_version !== 1 || report.profile !== 'read-only' || !Array.isArray(report.checks) || !/^[A-Za-z0-9_-]{1,100}$/.test(report.run_id) || !Number.isFinite(Date.parse(report.started_at)) || !report.promotion) throw new Error('Invalid compatibility report');
  const seen = new Set();
  for (const check of report.checks) for (const a of check.assertions) {
    if (a.stage !== 'read-only' || seen.has(a.id) || !ASSERTION_STATUSES.includes(a.status)) throw new Error('Invalid/duplicate/non-read-only assertion');
    if (a.status === 'not_applicable' && (!a.reason_code || a.observed == null)) throw new Error('Exclusion lacks evidence');
    seen.add(a.id);
  }
  if (report.promotion.eligible && (!report.coverage.full_contract_complete || report.execution_status !== 'completed' || report.overall_status !== 'compatible')) throw new Error('Invalid passed eligibility');
}

const remedies = {
  EDITOR_NOT_OPEN: 'Open the Pine Editor on the test Layout, then rerun the read-only check.',
  GRAPHICS_FIXTURE_MISSING: 'Set graphics.study_name to a visible test Study containing lines, labels, tables and boxes.',
  DRAWING_FIXTURE_MISSING: 'Set drawing.entity_id to a known Drawing on the test Pane.',
  DEPENDENCY_BLOCKED: 'Resolve the listed prerequisite assertions first.',
  HANDLER_NOT_IMPLEMENTED: 'Install a checker that implements this assertion.',
  ENVIRONMENT_CHANGED: 'Keep the Desktop version, test context and checker source unchanged during the check.',
  CDP_UNAVAILABLE: 'Launch TradingView Desktop with CDP enabled and verify the configured endpoint.',
};
function actionFor(assertion) {
  if (remedies[assertion.reason_code]) return remedies[assertion.reason_code];
  if (assertion.status === 'failed') return 'Inspect the failed Core contract and its expected/observed evidence before rerunning.';
  if (assertion.failure_origin === 'fixture') return 'Prepare the named test fixture described in the compatibility runbook.';
  if (assertion.failure_origin === 'environment') return 'Resolve the Desktop connection, loading or account prerequisite before rerunning.';
  return 'Review the reason and checker prerequisite before rerunning.';
}

/** User-facing schema v3: only read-only Desktop contracts are certified. */
export function compactReport(report) {
  const issues = new Map();
  const exclusions = [];
  const scopeExclusions = new Map();
  for (const check of report.checks) for (const assertion of check.assertions) {
    if (assertion.status === 'passed') continue;
    if (assertion.status === 'not_applicable') {
      if (assertion.reason_code === 'USER_SCOPE_EXCLUDED') {
        if (!scopeExclusions.has(check.id)) scopeExclusions.set(check.id, {
          check: check.id, reason: assertion.reason_code, evidence: assertion.observed, assertions: [],
        });
        scopeExclusions.get(check.id).assertions.push(assertion.id);
        continue;
      }
      exclusions.push({ assertion: assertion.id, reason: assertion.reason_code, evidence: assertion.observed });
      continue;
    }
    const issue = {
      check: check.id,
      status: assertion.status,
      reason: assertion.reason_code || 'NOT_EXECUTED',
      ...(assertion.failure_origin && { origin: assertion.failure_origin }),
      ...(assertion.blocked_by?.length && { blocked_by: assertion.blocked_by }),
      ...(assertion.status === 'failed' && {
        provider: assertion.provider,
        expected: assertion.expected,
        observed: assertion.observed,
        version_relation: assertion.version_relation,
      }),
      ...(assertion.status !== 'failed' && assertion.observed != null && { observed: assertion.observed }),
      action: actionFor(assertion),
    };
    const key = JSON.stringify(issue);
    if (!issues.has(key)) issues.set(key, { ...issue, assertions: [] });
    issues.get(key).assertions.push(assertion.id);
  }
  // Failures first, prerequisites second, dependent fallout last.
  const priority = issue => issue.status === 'failed' ? 0 : issue.origin === 'dependency' ? 2 : 1;
  const ordered = [...issues.values()].sort((a, b) => priority(a) - priority(b));
  for (const issue of ordered) {
    if (issue.status !== 'failed') continue;
    const affected = Object.fromEntries(['cli', 'mcp'].map(type => [type,
      (report.impacted_surfaces?.[type] || []).filter(s => s.impact === 'direct_failure' && s.check_ids.includes(issue.check)).map(s => s.name),
    ]));
    if (affected.cli.length || affected.mcp.length) issue.affected = affected;
  }
  const comparison = report.baseline_comparison || { status: 'not_comparable', reason: 'NO_BASELINE' };
  const { unchanged: _unchanged, ...changes } = comparison;
  const environment = { ...(report.environment || {}) };
  delete environment.observed_at;
  delete environment.node_major;
  delete environment.checker_revision;
  delete environment.adapter_revision;
  delete environment.desktop_version;
  return {
    schema_version: 3,
    checked_at: report.completed_at,
    desktop_version: report.environment?.desktop_version || null,
    profile: report.profile,
    scope: report.scope,
    overall_status: report.overall_status,
    compatible: report.compatible,
    issues: ordered,
    checks: report.checks.map(check => ({ id: check.id, status: check.status })),
    coverage: { ...report.summary.assertion_counts, complete: report.coverage.full_contract_complete },
    ...((exclusions.length || scopeExclusions.size) && { exclusions: [...scopeExclusions.values(), ...exclusions] }),
    changes,
    environment,
    run_id: report.run_id,
    registry_revision: report.registry_revision,
    checker_revision: report.checker_revision,
    adapter_revision: report.adapter_revision,
    fixture_fingerprint: report.fixture_fingerprint,
  };
}
async function canonicalDestination(path) {
  path=resolve(path);
  const missing=[];
  while(true){
    try{return join(await realpath(path),...missing.reverse());}
    catch(error){if(error.code!=='ENOENT')throw error;const parent=dirname(path);if(parent===path)throw error;missing.push(basename(path));path=parent;}
  }
}
export async function validateOutputDestination({root,output,force=false}) {
  if(!output)return;
  const rel=relative(await canonicalDestination(root),await canonicalDestination(output));
  if(!rel||(!rel.startsWith('..')&&!isAbsolute(rel)))throw compatibilityError('COMPATIBILITY_OUTPUT_PROTECTED','Output must be outside the compatibility state directory.');
  try{await lstat(resolve(output));if(!force)throw compatibilityError('OUTPUT_ALREADY_EXISTS','Output already exists; use --force to replace it.','conflict');}
  catch(err){if(err.code!=='ENOENT')throw err;}
}
export async function publishReport(report,{root,output,force=false}={}) {
  validateReport(report);
  const document=compactReport(report);
  const json=JSON.stringify(document,null,2)+'\n';
  if (Buffer.byteLength(json)>1024*1024) throw compatibilityError('COMPATIBILITY_REPORT_TOO_LARGE','Compatibility report exceeds 1 MiB.','artifact');
  const path=join(root,'reports',`${report.started_at.replace(/[:.]/g,'-')}-${report.run_id}.json`);
  await validateOutputDestination({root,output,force});
  await atomicJson(path,document,{replace:false});
  if (output) await atomicJson(resolve(output),document,{replace:force});
  return {path,sha256:createHash('sha256').update(json).digest('hex')};
}
