import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{loadFixture}from'../../../src/core/compatibility/fixture.js';
test('fixture validation rejects ambiguous targets and malformed mutation prerequisites before writes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'compat-fixture-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'fixture.json');
 for(const fixture of [{schema_version:2},{schema_version:1,unknown:true},{schema_version:1,target:{layout_name:'dev',saved_layout_id:'1',pane_index:0}},{schema_version:1,symbols:['A','B']},{schema_version:1,input_mutation:{name:'Length'}}]){
  await writeFile(file,JSON.stringify(fixture));await assert.rejects(loadFixture(file),{code:'COMPATIBILITY_FIXTURE_INVALID'});
 }
 await writeFile(file,JSON.stringify({schema_version:1,target:{layout_name:'dev',pane_index:0},watchlist:{name:'dev-testing-list'}}));assert.equal((await loadFixture(file)).target.layout_name,'dev');
});

test('fixture accepts explicit optional feature exclusions, but rejects core/unknown/duplicate exclusions', async t => {
 const root=await mkdtemp(join(tmpdir(),'compat-exclusions-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'fixture.json');
 for(const exclude_checks of [null,'PINE-001',['CHART-001'],['ENV-001'],['UNKNOWN'],['PINE-001','PINE-001']]) {
  await writeFile(file,JSON.stringify({schema_version:1,exclude_checks}));
  await assert.rejects(loadFixture(file),{code:'COMPATIBILITY_FIXTURE_INVALID'});
 }
 const exclude_checks=['PINE-001','GRAPHICS-001','DRAWING-001'];
 await writeFile(file,JSON.stringify({schema_version:1,exclude_checks}));
 assert.deepEqual((await loadFixture(file)).exclude_checks,exclude_checks);
});
