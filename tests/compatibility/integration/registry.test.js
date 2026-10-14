import{test}from'node:test';import assert from'node:assert/strict';import{CHECKS}from'../../../src/core/compatibility/registry.js';import{handlers}from'../../../src/core/compatibility/runtime.js';import{surfaceInventory}from'../../../src/core/compatibility/surfaces.js';
test('all 17 checks have bounded unique implemented assertions and an acyclic graph',()=>{
 assert.equal(CHECKS.length,17);assert.equal(CHECKS.flatMap(c=>c.assertions).length,37);const ids=new Set();
 for(const c of CHECKS){assert.ok(c.timeout_ms>0&&c.timeout_ms<=60000);for(const a of c.assertions){assert.ok(!ids.has(a.id));ids.add(a.id);assert.ok(a.expected);assert.equal(a.stage,'read-only');if(c.id!=='ENV-001')assert.equal(typeof handlers[a.id],'function');}}
 function visit(id,path=[]){assert.ok(!path.includes(id));const c=CHECKS.find(c=>c.id===id);assert.ok(c);for(const dep of c.depends_on)visit(dep,[...path,id]);}
 CHECKS.forEach(c=>visit(c.id));
});
test('every registered CLI/MCP surface maps to existing shared providers',async()=>{
 const inventory=await surfaceInventory();assert.ok(inventory.cli.length>70);assert.ok(inventory.mcp.length>90);
 for(const s of [...inventory.cli,...inventory.mcp])for(const id of s.checks)assert.ok(CHECKS.some(c=>c.id===id),`${s.name}: ${id}`);
});
