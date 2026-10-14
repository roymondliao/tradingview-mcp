import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLaunchObservation } from '../../../src/core/compatibility/launch.js';
import { readState, withStateTransaction } from '../../../src/core/compatibility/store.js';
import { normalizeEndpoint } from '../../../src/core/compatibility/identity.js';
const endpoint = normalizeEndpoint();
const version = v => ({ 'User-Agent': `TVDesktop/${v}`, 'Protocol-Version': '1.3' });
test('launch pending precedes operation, changes version without promoting, preserves failure', async t => {
  const root = await mkdtemp(join(tmpdir(), 'compat-launch-')); t.after(() => rm(root, { recursive: true, force: true }));
  const options = { root, endpoint };
  await withLaunchObservation(options, async () => {
    assert.equal((await readState({ root })).state.endpoints[endpoint.key].reason, 'launch_pending');
    return { success: true, version_response: version('3.4.1') };
  });
  await withStateTransaction({ root }, s => { s.endpoints[endpoint.key].status = 'failed'; });
  assert.equal((await withLaunchObservation(options, async () => ({ success: true, version_response: version('3.4.1') }))).compatibility.effective_status, 'failed');
  assert.equal((await withLaunchObservation(options, async () => ({ success: true, version_response: version('3.5.0') }))).compatibility.effective_status, 'unchecked');
  await assert.rejects(withLaunchObservation(options, async () => { throw new Error('spawn failed'); }));
  assert.equal((await readState({ root })).state.endpoints[endpoint.key].status, 'blocked');
});
test('all platform launchers invoke shared helper, which owns the parent lease', async () => {
  for (const name of ['launch_tv_debug_mac.sh','launch_tv_debug_linux.sh','launch_tv_debug.bat','launch_tv_debug.vbs']) {
    const content = await readFile(`scripts/${name}`, 'utf8');
    assert.match(content, /compatibility-launch\.js/); assert.match(content, /TV_COMPATIBILITY_RESPONSE_FILE/);
  }
  const helper = await readFile('scripts/compatibility-launch.js','utf8');
  assert.match(helper, /withLaunchObservation/); assert.match(helper, /await new Promise/);
});
test('Core launch holds observation across real launch orchestration with injected OS operations', async t => {
  const { launch } = await import('../../../src/core/health.js');
  const { EventEmitter } = await import('node:events');
  const { readFileSync } = await import('node:fs');
  const root=await mkdtemp(join(tmpdir(),'compat-core-launch-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let spawned=false;
  const result=await launch({_deps:{compatibilityRoot:root,
    existsSync:()=>true,execSync:()=>{assert.equal(JSON.parse(readFileSync(join(root,'state.json'),'utf8')).endpoints[endpoint.key].reason,'launch_pending');return '';},
    spawn:()=>{spawned=true;const child=new EventEmitter();child.pid=1;child.unref=()=>{};return child;},delay:async()=>{},probeCdp:async()=>JSON.stringify(version('3.4.1')),
  }});
  assert.equal(spawned,true);assert.equal(result.compatibility.effective_status,'unchecked');
  assert.equal((await readState({root})).state.endpoints[endpoint.key].observed.desktop_version,'3.4.1');
});
test('shell helper owns the lease until a fixture launcher supplies its version response', async t => {
  if(process.platform==='win32'){t.skip('POSIX shell fixture');return;}
  const {writeFile}=await import('node:fs/promises');const {spawnSync}=await import('node:child_process');
  const home=await mkdtemp(join(tmpdir(),'compat-shell-'));t.after(()=>rm(home,{recursive:true,force:true}));
  const script=join(home,'fixture launcher.sh');
  await writeFile(script,`#!/bin/bash\nprintf '%s' '{"User-Agent":"TVDesktop/3.4.1"}' > "$TV_COMPATIBILITY_RESPONSE_FILE"\n`);
  const result=spawnSync(process.execPath,['scripts/compatibility-launch.js',script,'9543'],{encoding:'utf8',env:{...process.env,HOME:home}});
  assert.equal(result.status,0,result.stderr);
  const s=JSON.parse(await readFile(join(home,'.tradingview-mcp/compatibility/state.json'),'utf8'));
  assert.equal(s.endpoints['127.0.0.1:9543'].status,'unchecked');assert.equal(s.endpoints['127.0.0.1:9543'].observed.desktop_version,'3.4.1');
});
