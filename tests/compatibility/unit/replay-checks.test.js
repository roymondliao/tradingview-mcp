import{test}from'node:test';import assert from'node:assert/strict';import{handlers}from'../support/runtime.js';import{runtimeFixture}from'../support/runtime.js';
test('Replay requires separate fixture and never guesses one',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['REPLAY-001.controlled.start_step_stop'](f.context)).reason_code,'REPLAY_FIXTURE_MISSING');
 f.context.fixture.replay_target={layout_name:'dev',pane_index:0};assert.equal((await handlers['REPLAY-001.controlled.start_step_stop'](f.context)).reason_code,'REPLAY_FIXTURE_MUST_BE_SEPARATE');
});
test('missing Replay methods are a provider failure, not a success',async()=>{
 const f=runtimeFixture();f.globals.TradingViewApi._replayApi={isReplayAvailable:()=>true,isReplayStarted:()=>false};
 assert.equal((await handlers['REPLAY-001.read.capability'](f.context)).status,'failed');assert.equal((await handlers['REPLAY-001.read.state'](f.context)).status,'passed');
});

test('Replay probes await the accessor and reuse the initialized API', async () => {
  const fixture = runtimeFixture();
  const api = fixture.globals.TradingViewApi;
  api._replayApi = null;
  let loads = 0;
  let reads = 0;
  api.replayApi = async function () {
    assert.equal(this, api);
    loads++;
    await Promise.resolve();
    this._replayApi = {
      selectDate: () => assert.fail('Read-only probe must not start Replay'),
      doStep: () => assert.fail('Read-only probe must not step Replay'),
      goToRealtime: () => assert.fail('Read-only probe must not switch to realtime'),
      stopReplay: () => assert.fail('Read-only probe must not stop Replay'),
      isReplayAvailable: () => { reads++; return { value: () => true }; },
      isReplayStarted: () => { reads++; return false; },
    };
    return this._replayApi;
  };

  assert.equal((await handlers['REPLAY-001.read.capability'](fixture.context)).status, 'passed');
  assert.equal(reads, 0);
  const state = await handlers['REPLAY-001.read.state'](fixture.context);
  assert.equal(state.status, 'passed');
  assert.deepEqual(state.observed, { available: true, started: false });
  assert.equal(reads, 2);
  assert.equal(loads, 1);
});

test('Replay probes distinguish a missing provider from failed initialization and invalid state', async () => {
  const fixture = runtimeFixture();
  const api = fixture.globals.TradingViewApi;
  const check = handlers['REPLAY-001.read.state'];
  const missing = await check(fixture.context);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.reason_code, 'PROVIDER_UNAVAILABLE');

  api.replayApi = async () => { throw new Error('fixture controller rejected'); };
  const rejected = await check(fixture.context);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.reason_code, 'PROVIDER_INITIALIZATION_FAILED');

  api.replayApi = async () => null;
  assert.equal((await check(fixture.context)).reason_code, 'PROVIDER_INITIALIZATION_FAILED');

  api._replayApi = { isReplayAvailable: () => 'true', isReplayStarted: () => false };
  const invalid = await check(fixture.context);
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.reason_code, 'RETURN_SHAPE_CHANGED');
  assert.deepEqual(invalid.observed, { available: null, started: false });
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
