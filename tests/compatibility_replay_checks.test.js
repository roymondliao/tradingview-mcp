import{test}from'node:test';import assert from'node:assert/strict';import{handlers}from'./helpers/compatibility-runtime.js';import{runtimeFixture}from'./helpers/compatibility-runtime.js';
test('Replay requires separate fixture and never guesses one',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['REPLAY-001.controlled.start_step_stop'](f.context)).reason_code,'REPLAY_FIXTURE_MISSING');
 f.context.fixture.replay_target={layout_name:'dev',pane_index:0};assert.equal((await handlers['REPLAY-001.controlled.start_step_stop'](f.context)).reason_code,'REPLAY_FIXTURE_MUST_BE_SEPARATE');
});
test('missing Replay methods are a provider failure, not a success',async()=>{
 const f=runtimeFixture();f.globals.TradingViewApi._replayApi={isReplayAvailable:()=>true,isReplayStarted:()=>false};
 assert.equal((await handlers['REPLAY-001.read.capability'](f.context)).status,'failed');assert.equal((await handlers['REPLAY-001.read.state'](f.context)).status,'passed');
});
test('owned Replay session steps, stops and restores connection; existing Replay is never stopped',async()=>{
 const f=runtimeFixture();f.context.fixture.replay_target={layout_name:'replay-test',pane_index:0};
 f.driver.selected={target_id:'main'};let target='main',started=false,date=1,stops=0;
 f.driver.tabs={list:async()=>({tabs:[{target_id:'replay',layout:{layout_name:'replay-test'}}]})};
 f.driver.connection.reconnectTo=async id=>{target=id;};f.driver.metadata=async()=>({active_index:0});
 f.driver.replay={status:async()=>({is_replay_started:started,current_date:date}),start:async()=>{started=true;return {replay_started:true};},step:async()=>{date++;},stop:async()=>{started=false;stops++;}};
 const result=await handlers['REPLAY-001.controlled.start_step_stop'](f.context);assert.equal(result.status,'passed');assert.equal(started,false);assert.equal(target,'main');assert.equal(stops,1);
 started=true;const second=await handlers['REPLAY-001.controlled.start_step_stop'](f.context);assert.equal(second.status,'blocked');assert.equal(stops,1);assert.equal(started,true);
});
