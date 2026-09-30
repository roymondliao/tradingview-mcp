import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import {
  rename as nodeRename,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  beginSymbolAttempt,
  createDurableRunStore,
} from '../src/core/strategy-run-artifacts.js';
import { transitionRunState } from '../src/core/strategy-run-state.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-durable-faults-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function runArtifact(runPath) {
  return {
    schema_version: 2,
    run_id: 'run-1',
    status: 'running',
    requested: {
      run: { run_id: 'run-1' },
      experiments: { parameter_sets: [{ name: 'baseline', inputs: {} }] },
      backtest: { timeframe: '1D' },
      output: { run_path: runPath, format: 'csv' },
    },
    config: { path: '/tmp/config.json', sha256: 'config-hash' },
    source_sha256: 'source-hash',
    candidate_schema_fingerprint: 'candidate-schema',
    resolved: {
      target: { layout_name: 'dev', saved_layout_id: 1, pane_index: 0, pane_id: '1' },
      strategy: null,
      watchlist: {
        name: 'dev-testing-list',
        snapshot_id: hash('f'),
        ordered_symbol_fingerprint: hash('e'),
        symbol_count: 1,
      },
    },
    base_inputs: null,
    base_inputs_fingerprint: null,
    planned_experiments: null,
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {},
    experiments: [],
    error: null,
  };
}

async function writeAttemptFiles(attempt, marker) {
  await attempt.writeJson('report.json', { marker: `${marker}:report` });
  await attempt.writeJson('trades.csv', { marker: `${marker}:trades` });
  await attempt.writeJson('reconciliation.json', { marker: `${marker}:reconciliation` });
}

describe('Strategy durable filesystem fault matrix', () => {
  it('maps Run directory mkdir failures to a bounded output error', async () => {
    await assert.rejects(
      createDurableRunStore({
        output_directory: temporaryDirectory(),
        run_id: 'run-1',
        _deps: {
          mkdir: async () => {
            throw Object.assign(new Error('mkdir denied'), { code: 'EACCES' });
          },
        },
      }),
      (error) => error.code === 'RUN_OUTPUT_INVALID' && error.phase === 'output_validation',
    );
  });

  it('leaves no apparent initial watchlist or run commit after a write failure', async () => {
    for (const artifact of ['watchlist', 'run']) {
      const output = temporaryDirectory();
      const store = await createDurableRunStore({
        output_directory: output,
        run_id: 'run-1',
        _deps: {
          writeFile: async () => { throw new Error(`${artifact} write failed`); },
        },
      });
      await assert.rejects(
        artifact === 'watchlist'
          ? store.writeInitialWatchlist({
            snapshot: {
              complete: true,
              snapshot_id: hash('1'),
              ordered_symbol_fingerprint: hash('2'),
            },
            symbols: ['TWSE:2330'],
          })
          : store.replaceRun(runArtifact(store.run_path)),
        (error) => error.code === 'OUTPUT_WRITE_FAILED',
      );
      assert.equal(existsSync(store.artifactPath(`${artifact}.json`)), false);
      assert.deepEqual(readdirSync(store.run_path), []);
    }
  });

  it('preserves the prior run.json when final Run replacement fails', async () => {
    const output = temporaryDirectory();
    let runReplacements = 0;
    const store = await createDurableRunStore({
      output_directory: output,
      run_id: 'run-1',
      _deps: {
        rename: async (from, to) => {
          if (basename(to) === 'run.json' && ++runReplacements === 2) {
            throw new Error('final run rename failed');
          }
          return nodeRename(from, to);
        },
      },
    });
    const running = runArtifact(store.run_path);
    await store.replaceRun(running);
    const updated = transitionRunState(running, { status: 'running', updated_at: 1001 });
    await assert.rejects(
      store.replaceRun(updated),
      (error) => error.code === 'OUTPUT_WRITE_FAILED',
    );
    const persisted = JSON.parse(readFileSync(store.artifactPath('run.json'), 'utf8'));
    assert.equal(persisted.updated_at, 1000);
    assert.equal(readdirSync(store.run_path).some((name) => name.endsWith('.tmp')), false);
  });

  it('propagates Trade stream start, batch, and finish failures and keeps output unpublished', async () => {
    const cases = [
      {
        name: 'start',
        stream: () => new Writable({
          construct(callback) { callback(new Error('stream start failed')); },
          write(_chunk, _encoding, callback) { callback(); },
        }),
        write(stream) { stream.end('batch'); },
      },
      {
        name: 'batch',
        stream: () => {
          let count = 0;
          return new Writable({
            write(_chunk, _encoding, callback) {
              count += 1;
              callback(count === 2 ? new Error('stream batch failed') : null);
            },
          });
        },
        write(stream) { stream.write('batch-1'); stream.end('batch-2'); },
      },
      {
        name: 'finish',
        stream: () => new Writable({
          write(_chunk, _encoding, callback) { callback(); },
          final(callback) { callback(new Error('stream finish failed')); },
        }),
        write(stream) { stream.end('batch'); },
      },
    ];
    for (const [index, fault] of cases.entries()) {
      const runDirectory = temporaryDirectory();
      let streamOptions;
      const attempt = await beginSymbolAttempt({
        run_directory: runDirectory,
        experiment_name: 'baseline',
        symbol: `TWSE:${2330 + index}`,
        attempt_count: 1,
        format: 'csv',
        _deps: {
          createWriteStream: (_path, options) => {
            streamOptions = options;
            return fault.stream();
          },
        },
      });
      const stream = await attempt.openArtifact('trades.csv');
      const completion = finished(stream);
      fault.write(stream);
      await assert.rejects(completion, new RegExp(`stream ${fault.name} failed`));
      assert.equal(streamOptions.flush, true);
      await attempt.abort();
      assert.equal(existsSync(attempt.staging_path), false);
      assert.equal(existsSync(attempt.final_path), false);
    }
  });

  it('keeps Report and Reconciliation write failures inside attempt staging', async () => {
    for (const filename of ['report.json', 'reconciliation.json']) {
      const runDirectory = temporaryDirectory();
      const attempt = await beginSymbolAttempt({
        run_directory: runDirectory,
        experiment_name: 'baseline',
        symbol: 'TWSE:2330',
        attempt_count: 1,
        format: 'csv',
        _deps: {
          writeFile: async (path, data, options) => {
            if (basename(path) === filename) throw new Error(`${filename} failed`);
            return nodeWriteFile(path, data, options);
          },
        },
      });
      await assert.rejects(
        attempt.writeJson(filename, {}),
        (error) => error.code === 'OUTPUT_WRITE_FAILED',
      );
      assert.equal(existsSync(attempt.final_path), false);
      await attempt.abort();
    }
  });

  it('leaves a complete staging attempt uncommitted when Symbol directory rename fails', async () => {
    const runDirectory = temporaryDirectory();
    const attempt = await beginSymbolAttempt({
      run_directory: runDirectory,
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      attempt_count: 1,
      format: 'csv',
      _deps: {
        rename: async (from, to) => {
          if (from.endsWith('.staging')) throw new Error('publish rename failed');
          return nodeRename(from, to);
        },
      },
    });
    await writeAttemptFiles(attempt, 'attempt-1');
    await assert.rejects(
      attempt.commit(),
      (error) => error.code === 'OUTPUT_WRITE_FAILED' && error.phase === 'artifact_publish',
    );
    assert.equal(existsSync(attempt.staging_path), true);
    assert.equal(existsSync(attempt.final_path), false);
    await attempt.abort();
  });

  it('never mixes aborted attempt markers into a later committed attempt', async () => {
    const runDirectory = temporaryDirectory();
    const options = {
      run_directory: runDirectory,
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      format: 'csv',
    };
    const first = await beginSymbolAttempt({ ...options, attempt_count: 1 });
    await writeAttemptFiles(first, 'attempt-1');
    await first.abort();
    const second = await beginSymbolAttempt({ ...options, attempt_count: 2 });
    await writeAttemptFiles(second, 'attempt-2');
    await second.commit();
    for (const filename of ['report.json', 'trades.csv', 'reconciliation.json']) {
      const artifact = JSON.parse(readFileSync(join(second.final_path, filename), 'utf8'));
      assert.match(artifact.marker, /^attempt-2:/);
      assert.doesNotMatch(artifact.marker, /attempt-1/);
    }
  });
});
