import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeStudySeriesArtifact } from '../../../src/core/study-series-format.js';
import { runSeries } from '../../../src/cli/commands/study.js';

test('dry-run uses export selection and headers, and bypasses all output writes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-preview-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'existing.csv');
  await writeFile(output, 'original');
  const plotColumn = { key: 'plot_2', title: 'EMA of VFI', source_slot: 3 };
  const plots = { key: 'plots', basis: 'bar_time', columns: [plotColumn],
    rows: [{ plot_2: 5 }], row_count: 1, period: { from: 15, to: 15 } };
  const boxes = { key: 'boxes', basis: 'chart_snapshot', columns: [{ key: 'id' }],
    rows: [], row_count: 0, period: null };
  const context = { pane_index: 1 };
  const issues = [{ code: 'ANCHOR_UNRESOLVED' }];
  const deps = {
    withContext: (opts, read) => read(context),
    getSeries: async ({ entity_id, context: selected, range }) => {
      assert.equal(entity_id, 'id');
      assert.equal(selected, context);
      return { study: { entity_id }, available_datasets: ['plots', 'boxes'], chart_bar_time: 25,
        requested_range: range, status: 'partial', issues, datasets: [plots, boxes] };
    },
  };
  const preview = opts => runSeries({ 'dry-run': true, ...opts }, ['id'], deps);
  const all = await preview({});
  assert.equal(all.dry_run, true);
  assert.equal(all.recommended_format, 'json');
  assert.equal(all.export_format, 'json');
  assert.deepEqual(all.issues, issues);
  assert.ok(all.datasets.every(d => d.csv_available && d.row_represents && !Object.hasOwn(d, 'rows')));
  await assert.rejects(preview({ format: 'csv' }), { code: 'STUDY_DATASET_REQUIRED' });
  await assert.rejects(preview({ dataset: 'missing' }), { code: 'STUDY_DATASET_UNAVAILABLE' });
  await assert.rejects(preview({ dataset: 'boxes', from: '10', to: '20' }), { code: 'STUDY_SNAPSHOT_OUTSIDE_RANGE' });

  const empty = await preview({ dataset: 'boxes', format: 'csv' });
  assert.equal(empty.datasets[0].row_count, 0);
  assert.equal(empty.recommended_format, 'csv');
  const options = { format: 'csv', from: '10', to: '20', output, force: true };
  const plan = await preview(options);
  assert.equal(plan.export_format, 'csv');
  assert.equal(plan.recommended_format, 'csv');
  assert.equal(plan.chart_bar_time, 25);
  assert.deepEqual(plan.requested_range, { from: 10, to: 20 });
  assert.deepEqual(plan.datasets.map(d => d.period), [plots.period]);
  assert.equal(await readFile(output, 'utf8'), 'original');
  await preview({ output: join(dir, 'absent', 'study.json') });
  assert.deepEqual(await readdir(dir), ['existing.csv']);
  await runSeries(options, ['id'], deps);
  assert.equal((await readFile(output, 'utf8')).split('\n')[0], plan.datasets[0].columns[0].csv_header);
});

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

test('CSV plot headers include escaped titles and unambiguous keys while rows use raw keys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-headers-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, 'study.csv');
  const columns = [
    { key: 'time' },
    { key: 'plot_0', source_slot: 1, title: 'Fast, "EMA"' },
    { key: 'plot_1', source_slot: 2, title: 'Fast, "EMA"' },
  ];
  const rows = [{ time: 123, plot_0: 0, plot_1: null }];
  await writeStudySeriesArtifact({ datasets: [{ key: 'plots', columns, rows }] }, { format: 'csv', output });
  assert.equal(await readFile(output, 'utf8'),
    'time,"Fast, ""EMA"" [plot_0]","Fast, ""EMA"" [plot_1]"\n123,0,\n');
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
