import{test}from'node:test';import assert from'node:assert/strict';import{handlers}from'./helpers/compatibility-runtime.js';import{runtimeFixture}from'./helpers/compatibility-runtime.js';
test('drawing lifecycle verifies geometry and removes only the owned shape',async()=>{
 const f=runtimeFixture();f.state.shapes=[{id:'existing',point:{time:1,price:4}}];
 assert.equal((await handlers['DRAWING-001.controlled.shape_lifecycle'](f.context)).status,'passed');assert.deepEqual(f.state.shapes.map(s=>s.id),['existing']);
});
test('graphics fixture absence is not an empty-array pass',async()=>{
 const f=runtimeFixture();for(const name of ['lines','labels','tables','boxes'])assert.equal((await handlers[`GRAPHICS-001.read.${name}`](f.context)).status,'blocked');
});
test('graphics provider must return valid coordinates, not merely a nonempty study',async()=>{
 const f=runtimeFixture();f.context.fixture.graphics={study_name:'fixture'};
 f.driver.data.getPineLines=async()=>({studies:[{name:'fixture',all_lines:[{y1:1,y2:1,x1:10,x2:20}]}]});
 assert.equal((await handlers['GRAPHICS-001.read.lines'](f.context)).status,'passed');
 f.driver.data.getPineLines=async()=>({studies:[{name:'fixture',all_lines:[{y1:NaN}]}]});
 assert.equal((await handlers['GRAPHICS-001.read.lines'](f.context)).status,'failed');
});
