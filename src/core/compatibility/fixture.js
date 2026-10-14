import { readJson } from './io.js';
import { compatibilityError } from './identity.js';
import { EXCLUDABLE_CHECKS } from './registry.js';
const fields=new Set(['schema_version','target','indicator','strategy','watchlist','graphics','drawing','exclude_checks']);
export function validateExcludedChecks(fixture) {
  if (!fixture || !Object.hasOwn(fixture, 'exclude_checks')) return [];
  const excluded = fixture.exclude_checks;
  if (!Array.isArray(excluded) || new Set(excluded).size !== excluded.length || excluded.some(id => !EXCLUDABLE_CHECKS.includes(id))) {
    throw compatibilityError('COMPATIBILITY_FIXTURE_INVALID', 'exclude_checks must contain unique optional feature IDs: PINE-001, GRAPHICS-001, DRAWING-001.');
  }
  return excluded;
}
export async function loadFixture(path) {
  if(!path) return null;
  const f=await readJson(path,65536);
  if(!f||f.schema_version!==1||Object.keys(f).some(k=>!fields.has(k))) throw compatibilityError('COMPATIBILITY_FIXTURE_INVALID','Invalid fixture schema or unknown field.');
  validateExcludedChecks(f);
  for(const key of ['target']) if(f[key]) {
    const target=f[key];
    if(Object.keys(target).some(k=>!['saved_layout_id','layout_name','pane_index'].includes(k))||Number.isInteger(target.pane_index)===false||target.pane_index<0||[target.saved_layout_id,target.layout_name].filter(v=>v!=null).length!==1) throw compatibilityError('COMPATIBILITY_FIXTURE_INVALID',`Invalid ${key} selector.`);
  }
  return f;
}
