import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateStrategyRunId,
  loadStrategyRunConfig,
  validateStrategyRunConfig,
} from '../src/core/strategy-run-config.js';
import { normalizedPineSourceSha256 } from '../src/core/pine-input-schema.js';

const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length) {
    await rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

function validConfig(overrides = {}) {
  return {
    schema_version: 1,
    run: { run_id: 'obv-baseline' },
    strategy: { file: './strategy.pine', saved_name: 'obv-v3' },
    target: { layout: { name: 'dev' }, pane_index: 0, watchlist: { name: 'dev-testing-list' } },
    backtest: { timeframe: '1D' },
    experiments: { parameter_sets: [{ name: 'baseline', inputs: {} }] },
    output: { directory: './out', format: 'csv' },
    ...overrides,
  };
}

describe('Strategy Run Config v1 validation', () => {
  it('accepts exact fields and generates a deterministic path-safe Run ID', () => {
    const config = validConfig({ run: { description: 'generated' } });
    const result = validateStrategyRunConfig(config, {
      now: Date.UTC(2026, 8, 16, 1, 2, 3), random_suffix: 'a13f8c2d',
    });
    assert.equal(result.valid, true);
    assert.equal(result.requested.run.run_id, 'obv-v3-20260916T010203Z-a13f8c2d');
    assert.equal(result.requested.run.generated, true);
    assert.equal(generateStrategyRunId({
      strategy_name: '測試', now: 0, random_suffix: '12345678',
    }), 'strategy-19700101T000000Z-12345678');
  });

  it('aggregates unknown, missing, unsafe, duplicate, and value errors', () => {
    const config = validConfig({
      extra: true,
      run: { run_id: '../unsafe' },
      target: { layout: { name: 'dev', unknown: true }, pane_index: -1, watchlist: { name: '' } },
      experiments: { parameter_sets: [
        { name: 'same', inputs: {} },
        { name: 'same', inputs: [] },
      ] },
      output: { directory: './out', format: 'xlsx' },
    });
    const result = validateStrategyRunConfig(config);
    assert.equal(result.valid, false);
    const codes = result.errors.map((error) => error.code);
    assert.ok(codes.includes('RUN_CONFIG_UNKNOWN_FIELD'));
    assert.ok(codes.includes('RUN_ID_INVALID'));
    assert.ok(codes.includes('PANE_INDEX_INVALID'));
    assert.ok(codes.includes('PARAMETER_SET_NAME_DUPLICATE'));
    assert.ok(codes.includes('RUN_CONFIG_INVALID'));
    assert.ok(result.errors.length >= 6);
  });

  it('returns a bounded invalid result for a non-object root', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tv-run-config-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'run.json');
    await writeFile(path, 'null');
    const result = await loadStrategyRunConfig({ config_path: path });
    assert.equal(result.valid, false);
    assert.equal(result.requested, null);
    assert.equal(result.errors[0].code, 'RUN_CONFIG_INVALID');
  });

  it('accepts run: null as the explicit auto-generated Run ID form', () => {
    const result = validateStrategyRunConfig(validConfig({ run: null }), {
      now: Date.UTC(2026, 8, 16, 1, 2, 3), random_suffix: '12345678',
    });
    assert.equal(result.valid, true);
    assert.equal(result.requested.run.generated, true);
    assert.equal(result.requested.run.run_id, 'obv-v3-20260916T010203Z-12345678');
  });
});

describe('Strategy Run Config filesystem resolution', () => {
  it('resolves Pine and output paths relative to the config directory and normalizes source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tv-run-config-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'out'));
    await writeFile(join(directory, 'strategy.pine'), '//@version=6\r\nstrategy("Test")\r\n');
    const path = join(directory, 'run.json');
    await writeFile(path, JSON.stringify(validConfig()));
    const result = await loadStrategyRunConfig({ config_path: path });
    assert.equal(result.valid, true);
    assert.equal(result.requested.strategy.file_path, join(directory, 'strategy.pine'));
    assert.equal(result.requested.output.directory_path, join(directory, 'out'));
    assert.equal(result.requested.output.run_path, join(directory, 'out', 'obv-baseline'));
    assert.equal(result.pine_source.includes('\r'), false);
    assert.equal(
      result.requested.strategy.source_sha256,
      normalizedPineSourceSha256('//@version=6\nstrategy("Test")\n'),
    );
  });

  it('reports unreadable Pine and an existing run directory without writing artifacts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tv-run-config-'));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, 'out', 'obv-baseline'), { recursive: true });
    const path = join(directory, 'run.json');
    await writeFile(path, JSON.stringify(validConfig({
      strategy: { file: './missing.pine', saved_name: 'obv-v3' },
    })));
    const result = await loadStrategyRunConfig({ config_path: path });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'PINE_SOURCE_READ_FAILED'));
    assert.ok(result.errors.some((error) => error.code === 'RUN_OUTPUT_EXISTS'));
  });
});
