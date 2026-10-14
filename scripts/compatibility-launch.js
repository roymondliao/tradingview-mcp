#!/usr/bin/env node
/** Hold the endpoint lease for the entire shell launcher, not a short-lived begin helper. */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, extname } from 'node:path';
import { withLaunchObservation } from '../src/core/compatibility/launch.js';
import { readJson } from '../src/core/compatibility/io.js';
import { normalizeEndpoint } from '../src/core/compatibility/identity.js';

if (Number(process.versions.node.split('.')[0]) < 22) { console.error('Launch requires Node.js >=22.'); process.exit(1); }
const [script, port = '9222'] = process.argv.slice(2);
if (!script) { console.error('Usage: node compatibility-launch.js <launcher-script> [port]'); process.exit(1); }
const temporary = await mkdtemp(join(tmpdir(), 'tv-launch-'));
const responseFile = join(temporary, 'version.json');
try {
  const endpoint = normalizeEndpoint({ host: '127.0.0.1', port });
  const result = await withLaunchObservation({ endpoint }, async () => {
    const path = resolve(script);
    const extension = extname(path).toLowerCase();
    const command = extension === '.vbs' ? 'cscript.exe' : extension === '.bat' ? 'cmd.exe' : 'bash';
    const args = extension === '.vbs' ? ['//nologo', path, port] : extension === '.bat' ? ['/d', '/s', '/c', `""${path}" ${port}"`] : [path, port];
    const child = spawn(command, args, { stdio: 'inherit', windowsVerbatimArguments: extension === '.bat', env: { ...process.env, TV_COMPATIBILITY_CHILD: '1', TV_COMPATIBILITY_RESPONSE_FILE: responseFile } });
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', terminate); process.on('SIGTERM', terminate);
    let code;
    try { code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }); }
    finally { process.off('SIGINT', terminate); process.off('SIGTERM', terminate); }
    if (code !== 0) throw new Error(`Desktop launcher exited with ${code}; Desktop may already be running.`);
    let version_response;
    try { version_response = await readJson(responseFile, 65536); } catch { /* reported blocked */ }
    return { success: true, version_response };
  });
  if (result.compatibility.effective_status !== 'passed') console.error(JSON.stringify({ level: 'warning', code: 'COMPATIBILITY_CHECK_RECOMMENDED', ...result.compatibility }));
} catch (error) { console.error(JSON.stringify({ success: false, code: error.code || 'COMPATIBILITY_LAUNCH_FAILED', error: error.message })); process.exitCode = 1; }
finally { await rm(temporary, { recursive: true, force: true }); }
