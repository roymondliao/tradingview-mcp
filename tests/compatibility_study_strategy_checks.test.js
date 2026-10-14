import{test}from'node:test';import assert from'node:assert/strict';import{handlers}from'./helpers/compatibility-runtime.js';import{runtimeFixture}from'./helpers/compatibility-runtime.js';
test('strategy data shape, counts and order are checked independently of presence',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['STRATEGY-001.read.report_shape'](f.context)).status,'passed');assert.equal((await handlers['STRATEGY-001.read.trades'](f.context)).status,'passed');
 f.report.performance.all.totalTrades=4;assert.equal((await handlers['STRATEGY-001.read.trades'](f.context)).status,'failed');
 delete f.report.performance;assert.equal((await handlers['STRATEGY-001.read.report_shape'](f.context)).status,'failed');
});
test('calculating, absent fixture and legitimate unavailable equity are not false incompatibilities',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['STRATEGY-001.read.equity'](f.context)).status,'passed');
 f.state.strategyStatus=1;assert.equal((await handlers['STRATEGY-001.read.report_shape'](f.context)).status,'blocked');
 f.context.fixture={};assert.equal((await handlers['STRATEGY-001.read.active_source'](f.context)).reason_code,'STRATEGY_FIXTURE_MISSING');
});
test('controlled Inputs and visibility restore exact prior values',async()=>{
 const f=runtimeFixture();const result=await handlers['STUDY-001.controlled.input_visibility'](f.context);
 assert.equal(result.status,'passed');assert.equal(f.state.inputs[0].value,10);assert.equal(f.state.visible,true);
});
