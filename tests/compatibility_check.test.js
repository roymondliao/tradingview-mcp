import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCompatibility } from '../src/core/compatibility/check.js';
import { implementationIdentity } from '../src/core/compatibility/identity.js';
import { CHECKS } from '../src/core/compatibility/registry.js';
import { readState } from '../src/core/compatibility/store.js';
import { baselineStatuses } from '../src/core/compatibility/baseline.js';
import { compatibilityStatus } from '../src/core/compatibility/advisory.js';
const observed={desktop_version:'3.4.1',electron_version:null,chromium_version:'146',protocol_version:'1.3',...implementationIdentity()};
const deps={observeDesktopVersion:async()=>observed,sourceFingerprint:async()=>'fixture-hash',repositoryCommit:async()=>null};
test('incomplete registry produces an honest report, never passed',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const result=await checkCompatibility({root,_deps:{...deps,handlers:{}}});
 assert.equal(result.success,false);assert.equal(result.compatible,null);
 const report=JSON.parse(await readFile(result.report_path,'utf8'));assert.equal(report.checks.length,17);assert.equal(report.coverage.complete,false);
});
test('complete read-only compatibility promotes and binds published evidence',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=Object.fromEntries(CHECKS.flatMap(c=>c.assertions.map(a=>[a.id,async()=>({status:'passed'})])));
 const full=await checkCompatibility({root,_deps:{...deps,handlers}});
 assert.equal(full.overall_status,'compatible');assert.equal(full.compatible,true);assert.equal(full.effective_status,'passed');
 const entry=Object.values((await readState({root})).state.endpoints)[0];
 assert.equal(entry.verification.report_path,full.report_path);
 assert.equal(entry.verification.scope,'read_only_desktop_contracts');
});
test('version changes during a check invalidate otherwise successful assertions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-check-'));t.after(()=>rm(root,{recursive:true,force:true}));let reads=0;
 const handlers=Object.fromEntries(CHECKS.flatMap(c=>c.assertions.map(a=>[a.id,async()=>({status:'passed'})])));
 const result=await checkCompatibility({root,_deps:{...deps,handlers,observeDesktopVersion:async()=>({...observed,desktop_version:++reads===1?'3.4.1':'3.5.0'})}});
 assert.equal(result.overall_status,'environment_blocked');assert.equal(result.effective_status,'blocked');
});
test('missing unrelated Indicator values does not block bars-only dependencies',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=Object.fromEntries(CHECKS.flatMap(c=>c.assertions.map(a=>[a.id,async()=>({status:'passed'})])));
 handlers['DATA-001.read.study_values']=async()=>({status:'blocked',failure_origin:'fixture',reason_code:'INDICATOR_FIXTURE_MISSING'});
 const result=await checkCompatibility({root,_deps:{...deps,handlers}});
 const report=JSON.parse(await readFile(result.report_path,'utf8'));
 assert.equal(report.checks.find(c=>c.id==='HISTORY-001').status,'passed');
 assert.equal(report.checks.find(c=>c.id==='REPLAY-001').status,'passed');
});
test('publication remains accessible when state update fails',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=Object.fromEntries(CHECKS.flatMap(c=>c.assertions.map(a=>[a.id,async()=>({status:'passed'})])));
 const result=await checkCompatibility({root,_deps:{...deps,handlers,updateGeneration:async()=>{throw new Error('disk full');}}});
 assert.equal(result.success,false);assert.equal(result.state_update.status,'failed');assert.ok(JSON.parse(await readFile(result.report_path,'utf8')));
});
test('output collision is rejected before opening a Desktop session',async t=>{
 const {writeFile}=await import('node:fs/promises');const root=await mkdtemp(join(tmpdir(),'compat-check-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const output=join(root,'existing.json');await writeFile(output,'original');
 await assert.rejects(checkCompatibility({root:join(root,'home'),output,_deps:{observeDesktopVersion:()=>assert.fail('must not contact Desktop')}}),{code:'OUTPUT_ALREADY_EXISTS'});
 assert.equal(await readFile(output,'utf8'),'original');
});

test('excluded features are never probed or counted as passed; read-only contracts certify configured scope', async t => {
 const root=await mkdtemp(join(tmpdir(),'compat-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const excluded=['PINE-001','GRAPHICS-001','DRAWING-001'];
 const handlers=Object.fromEntries(CHECKS.flatMap(c=>c.assertions.map(a=>[a.id,async()=>{
  assert.ok(!excluded.includes(c.id),'excluded feature must never be probed');
  return {status:'passed'};
 }])));
 const options={root,_deps:{...deps,handlers,loadFixture:async()=>({schema_version:1,target:{layout_name:'test',pane_index:0},exclude_checks:excluded})}};
 const ro=await checkCompatibility(options);
 assert.equal(ro.overall_status,'compatible');
 assert.equal(ro.compatible,true);
 assert.equal(ro.effective_status,'passed');
 assert.equal(ro.summary.assertion_counts.passed,30);
 assert.equal(ro.summary.assertion_counts.not_applicable,7);
 const report=JSON.parse(await readFile(ro.report_path,'utf8'));
 assert.deepEqual(report.issues,[]);
 assert.deepEqual(report.exclusions.map(e=>e.check),excluded);
 assert.ok(report.exclusions.every(e=>e.reason==='USER_SCOPE_EXCLUDED'));
 const statuses=baselineStatuses(report);
 assert.equal([...statuses.values()].filter(s=>s==='not_applicable').length,7);
 for(const check of report.checks.filter(c=>excluded.includes(c.id)))assert.equal(check.status,'not_applicable');
 assert.deepEqual(ro.next_steps,[]);
 const verification=Object.values((await readState({root})).state.endpoints)[0].verification;
 assert.equal(verification.exclusions.length,7);
 assert.ok(verification.exclusions.every(e=>e.reason==='USER_SCOPE_EXCLUDED'));
 assert.deepEqual((await compatibilityStatus({root})).verified_excluded_checks,excluded);
});

test('scope cannot exclude a required core check before any network/state operation', async t => {
 const {readdir}=await import('node:fs/promises');
 const root=await mkdtemp(join(tmpdir(),'compat-invalid-scope-'));t.after(()=>rm(root,{recursive:true,force:true}));
 await assert.rejects(checkCompatibility({root,_deps:{...deps,loadFixture:async()=>({schema_version:1,exclude_checks:['CDP-001']}),observeDesktopVersion:()=>assert.fail('must not contact Desktop')}}),{code:'COMPATIBILITY_FIXTURE_INVALID'});
 assert.deepEqual(await readdir(root),[]);
});

test('controlled and Replay operation options are rejected before Desktop access', async () => {
 for (const options of [{profile:'controlled'},{include_replay:true},{include_replay_trading:true}]) {
  await assert.rejects(checkCompatibility({...options,_deps:{observeDesktopVersion:()=>assert.fail('must not contact Desktop')}}),error=>['COMPATIBILITY_PROFILE_INVALID','COMPATIBILITY_OPTIONS_INVALID'].includes(error.code));
 }
});
test('a required missing read contract cannot certify or preserve a new passed result', async t => {
 const root=await mkdtemp(join(tmpdir(),'compat-required-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const handlers=Object.fromEntries(CHECKS.flatMap(c=>c.assertions.map(a=>[a.id,async()=>({status:'passed'})])));
 handlers['STUDY-001.read.inputs']=async()=>({status:'blocked',failure_origin:'fixture',reason_code:'INPUT_FIXTURE_MISSING'});
 const result=await checkCompatibility({root,_deps:{...deps,handlers}});
 assert.equal(result.compatible,null);assert.equal(result.effective_status,'blocked');
 assert.equal(Object.values((await readState({root})).state.endpoints)[0].verification,null);
});
