import{test}from'node:test';import assert from'node:assert/strict';import{handlers}from'./helpers/compatibility-runtime.js';import{runtimeFixture}from'./helpers/compatibility-runtime.js';
test('closed Editor blocks read-only without opening anything',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['PINE-001.read.editor_model'](f.context)).reason_code,'EDITOR_NOT_OPEN');
});
test('screenshot validates the actual PNG bytes',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['UI-001.read.screenshot'](f.context)).status,'passed');
 f.driver.connection.getClient=async()=>({Page:{captureScreenshot:async()=>({data:Buffer.from('not a png').toString('base64')})}});assert.equal((await handlers['UI-001.read.screenshot'](f.context)).status,'failed');
});
test('unknown depth entitlement is blocked; explicit exclusion retains evidence',async()=>{
 const f=runtimeFixture();assert.equal((await handlers['UI-001.controlled.depth'](f.context)).status,'blocked');
 f.context.fixture.entitlements={depth:{applicable:false,evidence:'fixture account has no market depth'}};
 const result=await handlers['UI-001.controlled.depth'](f.context);assert.equal(result.status,'not_applicable');assert.ok(result.observed.evidence);
});
test('panel/dialog/Input controlled path restores original panel state',async()=>{
 const f=runtimeFixture();f.context.fixture.ui={indicator_query:'Volume'};
 let open=true,dialog=false;const calls=[];
 f.driver.read=async()=>({button_count:1,area_open:open,watchlist_open:open,dialog_present:dialog,text_input_active:false});
 f.driver.ui={RIGHT_PANEL_LOCATORS:{watchlist:{}},openPanel:async({action})=>{open=action==='open';},click:async()=>{dialog=true;},keyboard:async({key})=>{calls.push(key);dialog=false;}};
 f.driver.indicators={searchStudies:async()=>({success:true,count:1})};
 const result=await handlers['UI-001.controlled.panels_dialogs'](f.context);
 assert.equal(result.status,'passed');assert.equal(open,true);assert.equal(dialog,false);assert.deepEqual(calls,['Escape']);
});
test('Editor compile restores saved source and only removes proven test-owned studies',async()=>{
 const f=runtimeFixture();f.context.fixture.editor={disposable:true,script_name:'test-editor',script_id:'USER;test-editor'};
 let source='//@version=6\nindicator("test-editor")\nplot(close)',saved=source,items=[],errors=[],removed=[];
 const original=source;
 f.driver.read=async(fn,args)=>args?.[0]==='editor'?{model:true}:items;
 f.driver.studies.removeActivePaneStudy=async({entity_id})=>{removed.push(entity_id);items=items.filter(s=>s.entity_id!==entity_id);};
 f.driver.pine={listScripts:async()=>({scripts:[{name:'test-editor',script_id:'USER;test-editor'}]}),getSource:async()=>({source}),getSavedScript:async()=>({pine_source:saved}),updateSavedScript:async o=>{saved=o.source;},setSource:async o=>{source=o.source;},getErrors:async()=>({errors}),compile:async()=>{saved=source;if(source.endsWith('plot('))errors=['syntax'];else{errors=[];items=[{entity_id:'owned',script_id:'USER;test-editor'},{entity_id:'unrelated',script_id:'USER;other'}];}}};
 await handlers['PINE-001.controlled.compile_success_error'](f.context);
 assert.deepEqual(removed,['owned']);assert.deepEqual(items,[{entity_id:'unrelated',script_id:'USER;other'}]);
 assert.equal(source,original);assert.equal(saved,original);
 assert.equal((await f.context.restore.restore()).status,'failed');
});
