import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeStudySeriesArtifact } from '../../../src/core/study-series-format.js';

test('atomic CSV and JSON preserve values, nulls, escaping and no-overwrite', async t => {
  const dir = await mkdtemp(join(tmpdir(),'study-series-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const result = {status:'partial',issues:[{code:'ANCHOR_UNRESOLVED'}],datasets:[{
    key:'labels',columns:['id','t','price'].map(key=>({key})),row_count:1, rows:[{id:0,t:'a,"b"\n文',price:null}],
  }]};
  const output = join(dir,'labels.csv');
  const write = () => writeStudySeriesArtifact(result,{format:'csv',output});
  const attempts = await Promise.allSettled([write(),write()]);
  assert.equal(attempts.filter(a=>a.status==='fulfilled').length,1);
  assert.equal(attempts.find(a=>a.status==='rejected').reason.code,'OUTPUT_ALREADY_EXISTS');
  const summary = attempts.find(a=>a.status==='fulfilled').value;
  assert.equal(summary.datasets[0].rows,undefined);
  assert.deepEqual(summary.issues,result.issues);
  assert.equal(await readFile(output,'utf8'),'id,t,price\n0,"a,""b""\n文",\n');
  const empty = {...result,datasets:[{...result.datasets[0],rows:[],row_count:0}]};
  await writeStudySeriesArtifact(empty,{format:'csv',output,force:true});
  assert.equal(await readFile(output,'utf8'),'id,t,price\n');
  const json = join(dir,'result.json');
  await writeStudySeriesArtifact(result,{format:'json',output:json});
  assert.deepEqual(JSON.parse(await readFile(json,'utf8')),result);
  assert.deepEqual((await readdir(dir)).sort(),['labels.csv','result.json']);
});

test('CLI validates range, dataset and file format before pane resolution', () => {
  for (const [args,expected] of [
    [['--format','csv'], /require --output/],
    [['--saved-layou-id','123'],/Unknown option/],
    [['--to','2020-12-30'],/requires --from/],
    [['--dataset',''],/Missing value/],
  ]) {
    const r=spawnSync(process.execPath,['src/cli/index.js','study','series','id',...args],{encoding:'utf8'});
    assert.equal(r.status,1);
    assert.match(r.stderr,expected);
  }
});
