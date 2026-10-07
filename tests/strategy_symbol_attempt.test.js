import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { finished } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDurableRunStore } from '../src/core/strategy-run-artifacts.js';
import { CoreOperationError } from '../src/core/errors.js';
import { executeStrategySymbolWithRetry } from '../src/core/strategy-run-retry.js';
import { STRATEGY_RUN_ARTIFACT_VERSION } from '../src/core/strategy-run-state.js';
import { createStrategySymbolAttemptArtifactWriter } from '../src/core/strategy-trading.js';

const temporaryDirectories = [];

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'tv-symbol-writer-'));
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

function manifestArtifact() {
  return {
    artifact_schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: 'run-1',
    experiment_id: hash('a'),
    parameter_set_name: 'baseline',
    status: 'running',
    strategy: { script_id: 'USER;test', version: '1.0' },
    inputs_fingerprint: { available: true, value: 'inputs' },
    watchlist: {
      snapshot_id: hash('f'),
      ordered_symbol_fingerprint: hash('e'),
      symbol_count: 1,
    },
    requested_symbols: ['TWSE:2330'],
    timeframe: '1D',
    format: 'csv',
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: 1000,
    updated_at_iso: '1970-01-01T00:00:01.000Z',
    summary: {
      requested: 1,
      pending: 1,
      running: 0,
      retry_wait: 0,
      succeeded: 0,
      failed: 0,
      skipped: 0,
    },
    symbols: [],
  };
}

async function writeSuccessfulAttempt(attempt) {
  const writer = createStrategySymbolAttemptArtifactWriter({ attempt, format: 'csv' });
  const trades = await writer.openTrades();
  trades.end('trade_number\n');
  await finished(trades);
  await writer.writeReport({ success: true });
  await writer.writeReconciliation({ success: true });
  return {
    resolved_symbol: 'TWSE_DLY:2330',
    snapshot_id: hash('1'),
    total_trades: 0,
    batch_count: 1,
    artifacts: await writer.artifactInfo(),
  };
}

describe('Durable Strategy Symbol artifact writer', () => {
  it('maps exactly Report, Trades, and Reconciliation into one attempt staging directory', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    const attempt = await store.beginSymbolAttempt({
      experiment_name: 'baseline',
      symbol: 'TWSE:2330',
      attempt_count: 1,
      format: 'jsonl',
    });
    const writer = createStrategySymbolAttemptArtifactWriter({ attempt, format: 'jsonl' });
    const trades = await writer.openTrades();
    trades.end('{"trade":1}\n');
    await finished(trades);
    await writer.writeReport({ success: true });
    await writer.writeReconciliation({ success: true });
    const artifacts = await writer.artifactInfo();
    assert.deepEqual(Object.keys(artifacts), ['report', 'trades', 'reconciliation']);
    assert.equal(
      artifacts.trades.relative_path,
      'experiments/baseline/symbols/TWSE_u3A_2330/trades.jsonl',
    );
    assert.deepEqual(readdirSync(attempt.staging_path).sort(), [
      'reconciliation.json', 'report.json', 'trades.jsonl',
    ]);

    await attempt.commit();
    assert.equal(existsSync(attempt.staging_path), false);
    assert.deepEqual(readdirSync(attempt.final_path).sort(), [
      'reconciliation.json', 'report.json', 'trades.jsonl',
    ]);
  });

  it('rejects incomplete attempt adapters and format mismatches at creation', () => {
    assert.throws(
      () => createStrategySymbolAttemptArtifactWriter({ attempt: {}, format: 'csv' }),
      /attempt artifact transaction/,
    );
    assert.throws(
      () => createStrategySymbolAttemptArtifactWriter({
        attempt: {
          openArtifact() {},
          writeJson() {},
          artifactInfo() {},
        },
        format: 'xlsx',
      }),
      (error) => error.code === 'OUTPUT_FORMAT_UNSUPPORTED',
    );
    assert.throws(
      () => createStrategySymbolAttemptArtifactWriter({
        attempt: {
          format: 'json',
          openArtifact() {},
          writeJson() {},
          artifactInfo() {},
        },
        format: 'csv',
      }),
      /does not match requested format/,
    );
  });

  it('reruns a rename-before-manifest-callback crash window without trusting the folder', async () => {
    const output = temporaryDirectory();
    const store = await createDurableRunStore({ output_directory: output, run_id: 'run-1' });
    let clock = 1000;
    let failSuccessCallback = true;
    const callbacks = (manifest) => ({
      manifest,
      index: 0,
      symbol: 'TWSE:2330',
      cleanupAttempt: ({ entry }) => store.cleanupUncommittedSymbolArtifacts({
        experiment_name: 'baseline',
        symbol: 'TWSE:2330',
        manifest_entry: entry,
        ownership_confirmed: true,
      }),
      beginAttempt: ({ attempt_count: attemptCount }) => store.beginSymbolAttempt({
        experiment_name: 'baseline',
        symbol: 'TWSE:2330',
        attempt_count: attemptCount,
        format: 'csv',
      }),
      executeAttempt: ({ attempt }) => writeSuccessfulAttempt(attempt),
      onTransition: async (next, metadata) => {
        if (metadata.event === 'attempt_succeeded' && failSuccessCallback) {
          throw new CoreOperationError('simulated manifest failure', {
            code: 'OUTPUT_WRITE_FAILED', phase: 'manifest_transition',
          });
        }
        await store.replaceManifest(next);
      },
      _deps: { now: () => ++clock },
    });

    await assert.rejects(
      executeStrategySymbolWithRetry(callbacks(manifestArtifact())),
      (error) => error.transition_persistence_failed === true,
    );
    const manifestPath = store.artifactPath('experiments/baseline/manifest.json');
    const afterCrash = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(afterCrash.symbols[0].status, 'running');
    const finalPath = store.artifactPath('experiments/baseline/symbols/TWSE_u3A_2330');
    assert.equal(existsSync(finalPath), true);

    failSuccessCallback = false;
    const resumed = await executeStrategySymbolWithRetry(callbacks(afterCrash));
    assert.equal(resumed.success, true);
    assert.equal(resumed.attempt_count, 2);
    assert.equal(resumed.manifest.symbols[0].status, 'succeeded');
    assert.equal(existsSync(finalPath), true);
    assert.deepEqual(readdirSync(finalPath).sort(), [
      'reconciliation.json', 'report.json', 'trades.csv',
    ]);
  });
});
