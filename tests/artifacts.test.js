import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import {
  assertSafeRelativeArtifactPath,
  createArtifactSetTransaction,
  createArtifactTransaction,
  safeSymbolPathSegment,
  writeTradingDataArtifact,
} from '../src/core/artifacts.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-artifacts-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function batchResult() {
  return {
    success: true,
    schema_version: 1,
    snapshot_id: 'sha256:test',
    symbol: 'TWSE_DLY:2344',
    timeframe: '1D',
    currency: 'TWD',
    ordering: 'oldest_first',
    total: 1,
    offset: 0,
    limit: 500,
    returned: 1,
    next_offset: null,
    has_more: false,
    complete: true,
    trades: [{
      schema_version: 1,
      report_index: 0,
      trade_number: 1,
      status: 'open',
      entry: { label: 'Entry', time: 1, time_iso: '1970-01-01T00:00:00.001Z' },
      exit: null,
      mark: { time: 2, time_iso: '1970-01-01T00:00:00.002Z' },
      profit: { value: 1, percent: 1 },
      run_up: { value: 1, percent: 1 },
      drawdown: { value: null, percent: null },
      cumulative_profit: { value: 1, percent: 1 },
      commission: 0.1,
      currency: 'TWD',
    }],
  };
}

describe('Artifact path safety', () => {
  it('creates deterministic safe Symbol segments without path separators', () => {
    assert.equal(safeSymbolPathSegment('TWSE:2344'), 'TWSE_u3A_2344');
    assert.equal(safeSymbolPathSegment('指數/測試'), '_u6307__u6578__u2F__u6E2C__u8A66_');
    assert.equal(safeSymbolPathSegment('TWSE:2344'), safeSymbolPathSegment('TWSE:2344'));
  });

  it('rejects absolute paths and traversal segments', () => {
    assert.equal(assertSafeRelativeArtifactPath('symbols/TWSE_2344/trades.json'), join(
      'symbols', 'TWSE_2344', 'trades.json',
    ));
    assert.throws(() => assertSafeRelativeArtifactPath('../secret'), /traversal/);
    assert.throws(() => assertSafeRelativeArtifactPath('/tmp/output'), /relative/);
  });
});

describe('Atomic artifact transaction', () => {
  it('publishes complete JSON and returns a bounded summary', async () => {
    const directory = temporaryDirectory();
    const output = join(directory, 'nested', 'trades.json');
    const result = batchResult();
    const summary = await writeTradingDataArtifact({ result, output });
    assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), result);
    assert.equal('trades' in summary, false);
    assert.equal(summary.output.path, output);
    assert.equal(summary.output.format, 'json');
    assert.equal(summary.output.written_trades, 1);
    assert.equal(summary.output.atomic, true);
    assert.deepEqual(readdirSync(join(directory, 'nested')), ['trades.json']);
  });

  it('does not overwrite an existing artifact without force', async () => {
    const directory = temporaryDirectory();
    const output = join(directory, 'trades.json');
    writeFileSync(output, 'old');
    await assert.rejects(
      writeTradingDataArtifact({ result: batchResult(), output }),
      (error) => error.code === 'OUTPUT_ALREADY_EXISTS',
    );
    assert.equal(readFileSync(output, 'utf8'), 'old');
  });

  it('atomically replaces only after a successful forced write', async () => {
    const directory = temporaryDirectory();
    const output = join(directory, 'trades.csv');
    writeFileSync(output, 'old');
    const summary = await writeTradingDataArtifact({
      result: batchResult(), output, format: 'csv', force: true,
    });
    assert.equal(summary.output.format, 'csv');
    assert.match(readFileSync(output, 'utf8'), /^trade_number,leg_type,time,/);
    assert.deepEqual(readdirSync(directory), ['trades.csv']);
  });

  it('keeps the old final artifact and removes staging after a write failure', async () => {
    const directory = temporaryDirectory();
    const output = join(directory, 'trades.json');
    writeFileSync(output, 'old');
    const failingWritable = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('disk full')); },
    });
    await assert.rejects(
      writeTradingDataArtifact({
        result: batchResult(), output, force: true,
        _deps: { createWriteStream: () => failingWritable },
      }),
      (error) => error.code === 'OUTPUT_WRITE_FAILED' && error.phase === 'artifact_write',
    );
    assert.equal(readFileSync(output, 'utf8'), 'old');
    assert.deepEqual(readdirSync(directory), ['trades.json']);
  });

  it('aborts a closed staging artifact without publishing it', async () => {
    const directory = temporaryDirectory();
    const output = join(directory, 'trades.json');
    const transaction = await createArtifactTransaction({ output });
    const writable = transaction.openArtifact();
    await new Promise((resolveWrite, rejectWrite) => {
      writable.end('partial', (error) => (error ? rejectWrite(error) : resolveWrite()));
    });
    await transaction.abort();
    assert.deepEqual(readdirSync(directory), []);
  });
});

describe('Atomic artifact set transaction', () => {
  it('publishes a complete nested run tree with one directory rename', async () => {
    const directory = temporaryDirectory();
    const transaction = await createArtifactSetTransaction({
      output_directory: directory, run_id: 'run-1',
    });
    await transaction.writeJson('manifest.json', { status: 'succeeded' });
    await transaction.writeJson('symbols/TWSE/report.json', { net_profit: 1 });
    const publication = await transaction.publish();
    assert.equal(publication.path, join(directory, 'run-1'));
    assert.equal(publication.atomic, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(publication.path, 'manifest.json'), 'utf8')),
      { status: 'succeeded' },
    );
    assert.deepEqual(readdirSync(directory), ['run-1']);
  });

  it('replaces an incremental manifest and removes one failed Symbol subtree', async () => {
    const directory = temporaryDirectory();
    const transaction = await createArtifactSetTransaction({
      output_directory: directory, run_id: 'run-incremental',
    });
    await transaction.replaceJson('manifest.json', { status: 'running', completed: 0 });
    await transaction.writeJson('symbols/GOOD/report.json', { success: true });
    await transaction.writeJson('symbols/FAILED/report.json', { partial: true });
    await transaction.removePath('symbols/FAILED');
    await transaction.replaceJson('manifest.json', { status: 'partial', completed: 2 });
    const publication = await transaction.publish();
    assert.deepEqual(
      JSON.parse(readFileSync(join(publication.path, 'manifest.json'), 'utf8')),
      { status: 'partial', completed: 2 },
    );
    assert.deepEqual(readdirSync(join(publication.path, 'symbols')), ['GOOD']);
  });

  it('preserves an existing run by default and replaces it only with force', async () => {
    const directory = temporaryDirectory();
    const initial = await createArtifactSetTransaction({
      output_directory: directory, run_id: 'run-1',
    });
    await initial.writeJson('manifest.json', { version: 'old' });
    await initial.publish();
    await assert.rejects(
      createArtifactSetTransaction({ output_directory: directory, run_id: 'run-1' }),
      (error) => error.code === 'OUTPUT_ALREADY_EXISTS',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, 'run-1', 'manifest.json'), 'utf8')),
      { version: 'old' },
    );

    const replacement = await createArtifactSetTransaction({
      output_directory: directory, run_id: 'run-1', force: true,
    });
    await replacement.writeJson('manifest.json', { version: 'new' });
    const publication = await replacement.publish();
    assert.equal(publication.replaced, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, 'run-1', 'manifest.json'), 'utf8')),
      { version: 'new' },
    );
    assert.deepEqual(readdirSync(directory), ['run-1']);
  });
});
