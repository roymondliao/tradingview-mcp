/** Source inventory is read only by explicit checks, never normal CLI advisory. */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { checkForSurface } from './registry.js';
export async function surfaceInventory() {
  const src=fileURLToPath(new URL('../../',import.meta.url));
  const result={cli:[],mcp:[]};
  for(const file of await readdir(join(src,'tools'))){
    if(!file.endsWith('.js'))continue;
    const text=await readFile(join(src,'tools',file),'utf8');
    for(const m of text.matchAll(/server\.tool\('([^']+)'/g))result.mcp.push({name:m[1],checks:checkForSurface(m[1],'mcp')});
  }
  // CLI modules only register metadata; index.js (which runs the CLI) is not imported.
  for(const file of await readdir(join(src,'cli','commands')))if(file.endsWith('.js'))await import(new URL(`../../cli/commands/${file}`,import.meta.url));
  const {commandInventory}=await import('../../cli/router.js');
  result.cli=commandInventory().map(c=>({name:c.name,checks:checkForSurface(c.name)}));
  if([...result.cli,...result.mcp].some(x=>x.checks===null))throw new Error('Desktop surface inventory contains an unmapped entry');
  return result;
}
export function attachImpacts(report,inventory){
  const direct=new Set(report.checks.filter(c=>c.assertions.some(a=>a.status==='failed')).map(c=>c.id));
  const affected=new Set(report.checks.filter(c=>c.assertions.some(a=>['failed','blocked','not_run'].includes(a.status))).map(c=>c.id));
  report.impacted_surfaces=Object.fromEntries(['cli','mcp'].map(type=>[type,inventory[type].filter(s=>s.checks.some(id=>affected.has(id))).map(s=>({name:s.name,impact:s.checks.some(id=>direct.has(id))?'direct_failure':'unverified_or_dependency',check_ids:s.checks.filter(id=>affected.has(id))}))]));
}
