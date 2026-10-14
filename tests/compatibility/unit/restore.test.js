import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestoreCoordinator } from '../support/restore.js';
test('restore reverses effects and verifies readback; uncertainty stops further writes',async()=>{
 const r=new RestoreCoordinator();const calls=[];
 r.register('first',async()=>calls.push('first'),async()=>true);r.register('second',async()=>calls.push('second'),async()=>true);
 assert.equal((await r.restore()).status,'passed');assert.deepEqual(calls,['second','first']);
 const f=new RestoreCoordinator();f.register('unsafe-next',async()=>assert.fail(),async()=>true);f.register('bad-readback',async()=>{},async()=>false);
 const result=await f.restore();assert.equal(result.status,'failed');assert.deepEqual(result.pending,['unsafe-next']);
});
test('non-quiescent operations prevent unsafe restoration',async()=>{const r=new RestoreCoordinator();r.register('still-running',async()=>assert.fail(),async()=>true);r.quiescent=false;assert.equal((await r.restore()).status,'failed');});
test('timeout leaves pending effect evidence and stops unsafe overlap',async()=>{
 const r=new RestoreCoordinator({timeout_ms:10});let next=false;
 r.register('next',async()=>{next=true;},async()=>true);r.register('pending',()=>new Promise(()=>{}),async()=>true);
 const result=await r.restore();assert.equal(result.status,'failed');assert.equal(next,false);assert.deepEqual(result.pending,['next']);
});
test('cancelled async continuations cannot issue later CDP operations',async()=>{
 const {withCdpSignal,getClient}=await import('../../../src/connection.js');
 const controller=new AbortController();let resume;
 const pending=withCdpSignal(controller.signal,async()=>{await new Promise(r=>{resume=r;});return getClient();});
 controller.abort();resume();await assert.rejects(pending,{code:'CDP_OPERATION_CANCELLED'});
});
