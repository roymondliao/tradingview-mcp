import { test } from 'node:test';import assert from 'node:assert/strict';
import {validateBars}from'../src/core/compatibility/runtime.js';import {handlers}from'./helpers/compatibility-runtime.js';import{runtimeFixture}from'./helpers/compatibility-runtime.js';
test('real page bar projection validates layout and rejects invalid numeric/time data',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['DATA-001.read.bars'](f.context)).status,'passed');
 for(const tuple of [[1700000000000,1,2,0,1,1],[1700000000,1,0,2,1,1],[1700000000,1,2,0,NaN,1],[1700000000,1,2,0,1,Infinity]])assert.equal(validateBars({sample:[tuple],size:1}).status,'failed');
 assert.equal(validateBars({sample:[],size:0}).status,'blocked');
});
test('symbol metadata mismatch fails even when a chart exists',async()=>{
 const f=runtimeFixture();f.chart.symbolExt=()=>({full_name:'WRONG:X'});assert.equal((await handlers['CHART-001.read.symbol_metadata'](f.context)).status,'failed');
});
test('controlled symbol changes read back and restore the original state',async()=>{
 const f=runtimeFixture();const original=structuredClone(f.state);
 const result=await handlers['CHART-001.controlled.symbol_resolution'](f.context);
 assert.equal(result.status,'passed');assert.deepEqual(f.state,original);assert.equal((await f.context.restore.restore()).status,'passed');
});
test('history stop cannot claim progress when history is exhausted',async()=>{
 const f=runtimeFixture();f.series.requestMoreDataAvailable=()=>false;
 assert.equal((await handlers['HISTORY-001.controlled.progress'](f.context)).status,'blocked');
 assert.equal((await handlers['HISTORY-001.controlled.stop'](f.context)).status,'passed');
});
