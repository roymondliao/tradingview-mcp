import { randomUUID } from 'node:crypto';
import { CHECKS, REGISTRY_REVISION, DEPENDENCY_ASSERTIONS } from './registry.js';
import { configuredEndpoint, normalizeEndpoint, compatibilityError, CHECKER_REVISION, ADAPTER_REVISION, sameIdentity, effectiveStatus, COMPATIBILITY_SCOPE } from './identity.js';
import { observeDesktopVersion } from './version.js';
import { compatibilityRoot, acquireEndpointLease, readState, withStateTransaction, reconcileObservation, updateGeneration } from './store.js';
import { resultFor, finishReport, publishReport, validateOutputDestination } from './report.js';
import { sourceFingerprint, repositoryCommit } from './environment.js';
import { loadFixture, validateExcludedChecks } from './fixture.js';
import { surfaceInventory, attachImpacts } from './surfaces.js';
import { fixtureFingerprint, compareBaseline } from './baseline.js';

export async function checkCompatibility({ profile='read-only',fixture:fixturePath,desktop_version,output,force=false,include_replay,include_replay_trading,root=compatibilityRoot(),endpoint=configuredEndpoint(),signal,_deps={} }={}) {
  if(profile!=='read-only') throw compatibilityError('COMPATIBILITY_PROFILE_INVALID','Compatibility checks are read-only; controlled operations belong to E2E testing.');
  if(force&&!output) throw compatibilityError('COMPATIBILITY_OUTPUT_INVALID','--force requires --output.');
  if(include_replay!==undefined||include_replay_trading!==undefined) throw compatibilityError('COMPATIBILITY_OPTIONS_INVALID','Replay operation options belong to E2E testing, not compatibility checks.');
  endpoint=normalizeEndpoint(endpoint);
  const fixture=await (_deps.loadFixture||loadFixture)(fixturePath);
  const excludedChecks = new Set(validateExcludedChecks(fixture));
  await validateOutputDestination({root,output,force});
  const lease=await acquireEndpointLease({root,endpoint});
  const generation=randomUUID(), run_id=randomUUID();
  const report={schema_version:1,registry_revision:REGISTRY_REVISION,checker_revision:CHECKER_REVISION,adapter_revision:ADAPTER_REVISION,run_id,profile,scope:COMPATIBILITY_SCOPE,started_at:new Date().toISOString(),execution_status:'completed',observation_generation:generation,environment:null,baseline:null,baseline_comparison:{status:'not_comparable'},checks:CHECKS.map(c=>({...c,assertions:c.assertions.map(a=>resultFor(a,'not_run',{reason_code:'NOT_EXECUTED'}))})),sanitization:{policy_revision:1,redacted_fields:['credentials','source','account_payloads','raw_runtime'],truncated:false},impacted_surfaces:{cli:[],mcp:[]}};
  for (const check of report.checks) if (excludedChecks.has(check.id)) {
    check.assertions = check.assertions.map(a => resultFor(a, 'not_applicable', {
      reason_code: 'USER_SCOPE_EXCLUDED',
      observed: { source: 'fixture.exclude_checks' },
    }));
  }
  let observed,driver,knownState=false,driverFailed=false;
  const deadline=Date.now()+120000;
  const observer=_deps.observeDesktopVersion||observeDesktopVersion;
  try {
    const prior=(await readState({root})).state.endpoints[endpoint.key];
    const fingerprints=await (_deps.sourceFingerprint||sourceFingerprint)();
    try {
      observed=await observer({endpoint,desktop_version});
      report.fixture_fingerprint=fixtureFingerprint(fixture);
      report.environment={...observed,endpoint:endpoint.key,node_version:process.versions.node,repo_commit:await (_deps.repositoryCommit||repositoryCommit)(),source_fingerprint:fingerprints};
      report.baseline=prior?.verification?{report_path:prior.verification.report_path,desktop_version:prior.verification.identity.desktop_version}:null;
      await withStateTransaction({root},s=>{
        const entry=reconcileObservation(prior,observed,generation);
        entry.status='checking';entry.reason='check_running';
        entry.active_check={run_id,owner_token:lease.owner.owner_token,started_at:report.started_at};
        s.endpoints[endpoint.key]=entry;
      });knownState=true;
      report.checks[0].assertions=report.checks[0].assertions.map(a=>resultFor(a,'passed',{kind:'data',observed:{desktop_version:observed.desktop_version}}));
    }catch(err){
      // A store failure is not evidence about Desktop. Stop before any runtime mutation.
      if(observed)throw err;
      report.checks[0].assertions=report.checks[0].assertions.map(a=>resultFor(a,'blocked',{failure_origin:'environment',reason_code:err.code||'VERSION_UNAVAILABLE'}));
      if(err.kind==='cdp') report.failure_kind='cdp_connection';
    }
    let handlers=_deps.handlers;
    if(!handlers) {
      const runtime=await import('./runtime.js');
      handlers=runtime.handlers;
      if(observed) {
        try {driver=await runtime.createDriver({endpoint,fixture});}
        catch(err){driverFailed=true;report.checks[1].assertions=report.checks[1].assertions.map(a=>resultFor(a,'blocked',{failure_origin:/FIXTURE/.test(err.code||'')?'fixture':'environment',reason_code:err.code||'CDP_UNAVAILABLE'}));if(err.kind==='cdp')report.failure_kind='cdp_connection';}
      }
    }
    for(const check of report.checks.slice(1)) {
      if(excludedChecks.has(check.id))continue;
      if(signal?.aborted){report.execution_status='interrupted';break;}
      if(Date.now()>=deadline) break;
      const requiredAssertions=DEPENDENCY_ASSERTIONS[check.id] || check.depends_on.flatMap(id=>report.checks.find(c=>c.id===id).assertions.filter(a=>a.stage==='read-only').map(a=>a.id));
      const blockedBy=requiredAssertions.filter(id=>report.checks.flatMap(c=>c.assertions).find(a=>a.id===id)?.status!=='passed');
      if(blockedBy.length){check.assertions=check.assertions.map(a=>resultFor(a,'blocked',{failure_origin:'dependency',reason_code:'DEPENDENCY_BLOCKED',blocked_by:blockedBy}));continue;}
      if(driverFailed&&check.id==='CDP-001')continue;
      const started=Date.now();
      for(const assertion of check.assertions) {
        if(signal?.aborted){report.execution_status='interrupted';break;}
        if(Date.now()>=deadline){assertion.reason_code='TOTAL_BUDGET_EXCEEDED';break;}
        const handler=handlers?.[assertion.id];
        if(!handler){assertion.reason_code='HANDLER_NOT_IMPLEMENTED';continue;}
        let timer;
        const controller=new AbortController();
        const cancel=()=>controller.abort(signal.reason);
        signal?.addEventListener('abort',cancel,{once:true});
        try {
          await lease.assertOwned();
          const operation=()=>handler({driver,fixture,signal:controller.signal,report});
          const pending=driver?.connection?.withCdpSignal?driver.connection.withCdpSignal(controller.signal,operation):operation();
          const answer=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort(compatibilityError('CHECK_TIMEOUT','Check did not complete.','interrupt'));reject(compatibilityError('CHECK_TIMEOUT','Check did not complete.'));},Math.max(1,Math.min(deadline-Date.now(),15000)));})]);
          Object.assign(assertion,resultFor(assertion,answer.status,answer));
        }catch(err){
          Object.assign(assertion,resultFor(assertion,'blocked',{reason_code:err.code||'CHECK_ERROR',failure_origin:err.code==='CHECK_TIMEOUT'?'undetermined':'checker'}));
          if(!err.code)report.execution_status='checker_error';
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
      }
      check.duration_ms=Date.now()-started;
    }
    if(observed){
      try{
        const final=await observer({endpoint,desktop_version});
        const currentFingerprint=await (_deps.sourceFingerprint||sourceFingerprint)();
        if(!sameIdentity(observed,final)||currentFingerprint!==fingerprints)throw new Error('Environment changed');
        if(driver){await driver.guard();if((await driver.connection.getTargetInfo()).id!==driver.selected.target_id)throw new Error('Target changed');}
        if(knownState&&(await readState({root})).state.endpoints[endpoint.key]?.observation_generation!==generation)throw new Error('Observation superseded');
      }catch{
        report.checks[0].assertions[1]=resultFor(report.checks[0].assertions[1],'blocked',{failure_origin:'environment',reason_code:'ENVIRONMENT_CHANGED'});
      }
    }
    finishReport(report);
    report.baseline_comparison=await compareBaseline(report,prior,root);
    attachImpacts(report,await (_deps.surfaceInventory||surfaceInventory)());
    const published=await publishReport(report,{root,output,force});
    let state_update;
    try {
    if(!knownState){
      await withStateTransaction({root},s=>{s.endpoints[endpoint.key]={observation_generation:generation,observed:null,status:'blocked',reason:'version_unavailable',verification:null,last_check:{run_id,profile,overall_status:report.overall_status,completed_at:report.completed_at,report_path:published.path},active_check:null};});
      state_update={status:'updated',effective_status:'blocked'};
    }else state_update=await (_deps.updateGeneration||updateGeneration)({root,endpoint,generation,lease},entry=>{
      entry.last_check={run_id,profile,overall_status:report.overall_status,completed_at:report.completed_at,report_path:published.path};entry.active_check=null;
      if(report.promotion.target_status){entry.status=report.promotion.target_status;entry.reason=report.overall_status;}
      if(report.promotion.eligible) entry.verification={identity:observed,desktop_version:observed.desktop_version,checked_at:report.completed_at,report_path:published.path,report_sha256:published.sha256,source_fingerprint:fingerprints,scope:report.scope,exclusions:report.coverage.exclusions};
    });
    } catch {
      const local=await readState({root});
      state_update={status:'failed',effective_status:local.status==='ok'?effectiveStatus(local.state.endpoints[endpoint.key]).status:'blocked',code:'COMPATIBILITY_STATE_WRITE_FAILED'};
    }
    return {success:report.overall_status==='compatible'&&state_update.status==='updated',overall_status:report.overall_status,compatible:report.compatible,report_path:published.path,effective_status:state_update.effective_status,state_update,summary:report.summary,next_steps:report.next_steps,...(report.failure_kind&&{failure_kind:report.failure_kind}),...(signal?.aborted&&{exit_code:signal.reason?.exit_code||130})};
  }catch(err){
    if(knownState) await updateGeneration({root,endpoint,generation,lease},entry=>{entry.status='blocked';entry.reason='checker_or_publish_failed';entry.active_check=null;}).catch(()=>{});
    throw err;
  }finally{await driver?.close();await lease.release();}
}
