import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
const repository=fileURLToPath(new URL('../../../',import.meta.url));
export async function sourceFingerprint() {
  const hash=createHash('sha256');
  async function walk(directory){
    const entries=await readdir(join(repository,directory),{withFileTypes:true});
    for(const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))){
      const path=join(directory,entry.name);
      if(entry.isDirectory()) await walk(path);
      else if(entry.isFile()&&/\.(js|json|pine|sh|bat|vbs)$/.test(entry.name)) {hash.update(path);hash.update(await readFile(join(repository,path)));}
    }
  }
  await walk('src'); await walk('tests'); await walk('scripts');
  for(const file of ['package.json','package-lock.json']) {hash.update(file);hash.update(await readFile(join(repository,file)));}
  return hash.digest('hex');
}
export async function repositoryCommit() {
  return new Promise(resolve=>execFile('git',['rev-parse','HEAD'],{cwd:repository,timeout:2000},(err,out)=>resolve(err?null:out.trim())));
}
