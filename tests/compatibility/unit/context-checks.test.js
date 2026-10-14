import{test}from'node:test';import assert from'node:assert/strict';
import{handlers}from'../support/runtime.js';import{runtimeFixture}from'../support/runtime.js';
test('ambiguous active target is blocked rather than picking the first target',async()=>{
 const f=runtimeFixture();f.driver.inventory={tabs:[{is_chart:true,active:true},{is_chart:true,active:true}]};
 assert.equal((await handlers['TARGET-001.read.active_target'](f.context)).status,'blocked');
 f.driver.inventory.tabs[1].active=false;assert.equal((await handlers['TARGET-001.read.active_target'](f.context)).status,'passed');
});
test('missing Saved Layout mapping is a fixture block, not full compatibility',async()=>{
 const f=runtimeFixture();f.driver.metadata=async()=>({layout:{layout_id:'runtime',saved_layout_id:null}});
 assert.equal((await handlers['CONTEXT-001.read.layout_mapping'](f.context)).status,'blocked');
});
test('Pane switch readback restores exact original active Pane',async()=>{
 const f=runtimeFixture();let index=0;
 f.context.fixture.other_pane_index=1;
 f.driver.metadata=async()=>({active_index:index,panes:[{pane_id:'a'},{pane_id:'b'}]});
 f.driver.panes.focus=async({index:next})=>{index=next;};
 assert.equal((await handlers['CONTEXT-001.controlled.pane_switch_restore'](f.context)).status,'passed');assert.equal(index,0);
});
