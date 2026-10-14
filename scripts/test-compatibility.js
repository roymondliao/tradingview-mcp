import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('../',import.meta.url));
const files=readdirSync(new URL('../tests/',import.meta.url)).filter(n=>/^compatibility_.*\.test\.js$/.test(n)).sort().map(n=>`tests/${n}`);
const child=spawnSync(process.execPath,['--test',...files],{cwd,stdio:'inherit'});
process.exitCode=child.status??1;
