import{test}from'node:test';import assert from'node:assert/strict';import vm from'node:vm';
import{handlers}from'../support/runtime.js';import{create}from'../../../src/core/alerts.js';import{runtimeFixture}from'../support/runtime.js';
test('account empty list is valid but provider errors are not an empty success',async()=>{
 const f=runtimeFixture();f.driver.pine={listScripts:async()=>({scripts:[],count:0})};
 assert.equal((await handlers['PINE-ACCOUNT-001.read.inventory'](f.context)).status,'passed');
 f.driver.pine.listScripts=async()=>({scripts:[],error:'login required'});assert.equal((await handlers['PINE-ACCOUNT-001.read.inventory'](f.context)).status,'blocked');
 f.driver.watchlist={listWatchlists:async()=>({lists:[{watchlist_id:1}],count:1})};assert.equal((await handlers['WATCHLIST-001.read.inventory'](f.context)).status,'passed');
});
test('alert probe validates business status, not just HTTP success',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['ALERT-001.read.inventory'](f.context)).status,'passed');
 f.globals.fetch=async()=>({ok:true,json:async()=>({s:'error',r:[]})});assert.equal((await handlers['ALERT-001.read.inventory'](f.context)).status,'failed');
});
test('controlled Alert creation suppresses all outbound notification channels',async()=>{
 let payload;
 class Request{open(){}setRequestHeader(){}send(body){payload=JSON.parse(body).payload;this.responseText=JSON.stringify({s:'ok',r:{alert_id:1}});}}
 const globals={window:{TradingViewApi:{_activeChartWidgetWV:{value:()=>({_chartWidget:{model:()=>({mainSeries:()=>({proSymbol:()=> 'TEST:A'})})}})}}},XMLHttpRequest:Request};
 const result=await create({condition:'greater',price:100,notifications:false,_deps:{evaluate:async expression=>vm.runInNewContext(expression,globals)}});
 assert.equal(result.alert_id,1);for(const field of ['popup','mobile_push','email','sms_over_email'])assert.equal(payload[field],false);assert.equal(payload.web_hook,null);
});
test('created Pine ownership is journaled before readback failure, then cleaned',async()=>{
 const f=runtimeFixture();let exists=false,removed=false;
 f.driver.pine={
  createSavedScript:async options=>{exists=true;await options._deps.onCreated({script_id:'USER;owned'});throw new Error('readback failed');},
  listScripts:async()=>({scripts:exists?[{script_id:'USER;owned'}]:[]}),
  deleteSavedScript:async({script_id,confirmed})=>{assert.equal(script_id,'USER;owned');assert.equal(confirmed,true);exists=false;removed=true;},
 };
 const result=await handlers['PINE-ACCOUNT-001.controlled.script_lifecycle'](f.context);
 assert.equal(result.status,'blocked');assert.equal(removed,true);assert.equal((await f.context.restore.restore()).status,'passed');
});
test('Watchlist mutation uses exact named snapshot and restores original ordered symbols',async()=>{
 const f=runtimeFixture();f.context.fixture.watchlist={name:'test',mutable:true,test_symbol:'TEST:NEW'};
 let symbols=['TEST:A','TEST:B'];
 f.driver.ui={RIGHT_PANEL_LOCATORS:{watchlist:{}}};
 f.driver.read=async()=>({button_count:1,watchlist_open:true});
 f.driver.watchlist={captureNamedWatchlistSnapshot:async()=>({watchlist:{watchlist_id:1},snapshot:{complete:true},symbols:[...symbols]}),getWatchlist:async()=>({list_id:1}),add:async({symbol})=>{symbols.push(symbol);},remove:async({symbols:removed})=>{symbols=symbols.filter(s=>!removed.includes(s));}};
 const result=await handlers['WATCHLIST-001.controlled.symbols_restore'](f.context);assert.equal(result.status,'passed');assert.deepEqual(symbols,['TEST:A','TEST:B']);
});
