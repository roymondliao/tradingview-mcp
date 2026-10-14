import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { finishReport, resultFor, validateReport, compactReport, publishReport } from '../src/core/compatibility/report.js';
import { baselineStatuses, compareBaseline } from '../src/core/compatibility/baseline.js';
import { CHECKS, REGISTRY_REVISION } from '../src/core/compatibility/registry.js';
const make = () => finishReport({
 schema_version:1,run_id:'test',profile:'read-only',scope:'read_only_desktop_contracts',
 started_at:new Date().toISOString(),execution_status:'completed',registry_revision:REGISTRY_REVISION,
 fixture_fingerprint:'fixture',environment:{desktop_version:'3.4.1',source_fingerprint:'source'},
 checks:CHECKS.map(c=>({...c,assertions:c.assertions.map(a=>resultFor(a,'passed',{observed:{success_detail:'not needed'}}))})),
});
const assertion = (r,id) => r.checks.flatMap(c=>c.assertions).find(a=>a.id===id);
test('read-only complete contracts certify; missing/blocked/failed contracts never promote',()=>{
 const r=make();assert.equal(r.compatible,true);validateReport(r);
 for(const status of ['not_run','blocked','failed']){
  const partial=make();Object.assign(assertion(partial,'DATA-001.read.bars'),{status,failure_origin:'desktop_runtime'});
  finishReport(partial);assert.equal(partial.promotion.eligible,false);
 }
 const invalid=make();assertion(invalid,'DATA-001.read.bars').stage='controlled';
 assert.throws(()=>validateReport(invalid),/non-read-only/);
});
test('interrupted and checker error cannot promote despite successful read assertions',()=>{
 for(const status of ['interrupted','checker_error']){
  const r=make();r.execution_status=status;finishReport(r);
  assert.equal(r.promotion.eligible,false);assert.equal(r.compatible,null);assert.equal(r.overall_status,status);
 }
});
test('exclusions require explicit evidence and never count as passed',()=>{
 const r=make();const a=assertion(r,'PINE-001.read.editor_model');a.status='not_applicable';
 finishReport(r);assert.throws(()=>validateReport(r),/evidence/);
 Object.assign(a,{reason_code:'USER_SCOPE_EXCLUDED',observed:{source:'fixture.exclude_checks'}});
 finishReport(r);validateReport(r);assert.equal(r.summary.assertion_counts.not_applicable,1);
 assert.equal(r.summary.assertion_counts.passed,36);
});
test('published report v3 and output copy have exact bytes/hash, exclusive and protected paths',async t=>{
 const parent=await mkdtemp(join(tmpdir(),'compat-publish-'));t.after(()=>rm(parent,{recursive:true,force:true}));const root=join(parent,'state');
 const report=make();const first=await publishReport(report,{root,output:join(parent,'copy.json')});
 const raw=await readFile(first.path,'utf8');const document=JSON.parse(raw);
 assert.equal(document.schema_version,3);assert.equal(document.compatible,true);
 assert.equal(await readFile(join(parent,'copy.json'),'utf8'),raw);
 assert.equal(first.sha256,createHash('sha256').update(raw).digest('hex'));
 await assert.rejects(publishReport(report,{root}),{code:'EEXIST'});
 await assert.rejects(publishReport({...report,run_id:'other'},{root,output:join(root,'state.json'),force:true}),{code:'COMPATIBILITY_OUTPUT_PROTECTED'});
});
test('compact report omits operation coverage and successful definitions/evidence',()=>{
 const original=make();original.baseline_comparison={status:'comparable',new_failures:[],recovered:[],unchanged:['redundant IDs']};
 const report=compactReport(original),serialized=JSON.stringify(report);
 assert.deepEqual(report.issues,[]);assert.equal(report.coverage.total,37);assert.equal(report.coverage.complete,true);
 assert.equal(report.checks.find(c=>c.id==='STRATEGY-001').status,'passed');
 for(const omitted of ['controlled','restore','next_check','success_detail','required_when','timeout_ms','unchanged','promotion','sanitization'])assert.equal(serialized.includes(omitted),false,omitted);
 assert.ok(serialized.length<JSON.stringify(original).length/2);
 assert.deepEqual(baselineStatuses(report),baselineStatuses(original));
});
test('grouped missing fixtures and real failure evidence remain actionable',()=>{
 const original=make();
 for(const a of original.checks.find(c=>c.id==='GRAPHICS-001').assertions)Object.assign(a,resultFor(a,'blocked',{reason_code:'GRAPHICS_FIXTURE_MISSING',failure_origin:'fixture'}));
 const a=assertion(original,'STRATEGY-001.read.report_shape');Object.assign(a,resultFor(a,'failed',{reason_code:'RETURN_SHAPE_CHANGED',failure_origin:'desktop_runtime',observed:{performance:false}}));
 original.impacted_surfaces={cli:[{name:'strategy trading-report',impact:'direct_failure',check_ids:['STRATEGY-001']}],mcp:[]};
 finishReport(original);const report=compactReport(original);
 assert.equal(report.issues.length,2);assert.equal(report.issues[0].status,'failed');
 assert.deepEqual(report.issues[0].expected,a.expected);assert.deepEqual(report.issues[0].observed,{performance:false});
 assert.equal(report.issues[0].version_relation,'not_established');assert.deepEqual(report.issues[0].affected.cli,['strategy trading-report']);
 assert.equal(report.issues[1].assertions.length,4);assert.equal('expected' in report.issues[1],false);
 assert.deepEqual(baselineStatuses(report),baselineStatuses(original));
 report.coverage.passed--;assert.throws(()=>baselineStatuses(report),/counts/);
});
test('baseline reads v1/v2/v3 read outcomes; a different registry is never compared',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-baseline-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'reports'));
 const before=make();const a=assertion(before,'CDP-001.read.evaluate');Object.assign(a,resultFor(a,'failed',{reason_code:'MISMATCH',failure_origin:'desktop_runtime'}));finishReport(before);
 const compact=compactReport(before);
 const v2={...compact,schema_version:2,coverage:{read:compact.coverage,controlled:{total:22,not_run:22}}};
 for(const document of [before,v2,compact]){
  const path=join(root,'reports',`v${document.schema_version}.json`);await writeFile(path,JSON.stringify(document));
  const comparison=await compareBaseline(make(),{last_check:{report_path:path}},root);
  assert.equal(comparison.status,'comparable');assert.deepEqual(comparison.recovered,[a.id]);assert.deepEqual(comparison.new_failures,[]);
  await writeFile(path,JSON.stringify({...document,registry_revision:0}));
  assert.equal((await compareBaseline(make(),{last_check:{report_path:path}},root)).status,'not_comparable');
 }
});
