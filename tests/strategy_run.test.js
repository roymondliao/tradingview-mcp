import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dryRunStrategyAutomation } from '../src/core/strategy-run.js';

function requested() {
  return {
    schema_version: 1,
    run: { run_id: 'test-run', description: '', generated: false },
    strategy: {
      file: './obv.pine', saved_name: 'obv-v3', file_path: '/tmp/obv.pine', source_sha256: 'local-hash',
    },
    target: { layout: { name: 'dev' }, pane_index: 0, watchlist: { name: 'dev-testing-list' } },
    backtest: { timeframe: '1D' },
    experiments: { parameter_sets: [{ name: 'baseline', inputs: { Length: 5 } }] },
    output: { directory: './out', format: 'csv', directory_path: '/tmp/out', run_path: '/tmp/out/test-run' },
  };
}

function candidateSchema() {
  return {
    available: true,
    inputs: [{ name: 'Length', runtime_value_type: 'int', constraints: { min: 1, max: 20 } }],
    input_schema_fingerprint: 'candidate-schema',
  };
}

function successfulDeps(calls = []) {
  return {
    loadStrategyRunConfig: async () => ({
      valid: true, errors: [], warnings: [], config_path: '/tmp/run.json', config_directory: '/tmp',
      config_sha256: 'config-hash', requested: requested(), pine_source: 'source',
    }),
    checkPine: async () => ({ compiled: true, warnings: [], input_schema: candidateSchema() }),
    resolveLayoutTarget: async () => ({
      target_id: 'target-1', layout_name: 'dev', layout_id: 'layout-1', saved_layout_id: 1,
      pane_index: 0, pane_id: 'pane-0', symbol: 'TWSE_DLY:2330', timeframe: '1D',
    }),
    attachTarget: async () => calls.push('attach-target'),
    captureNamedWatchlistSnapshot: async () => ({
      success: true,
      watchlist: { name: 'dev-testing-list', watchlist_id: 1 },
      snapshot: { complete: true, returned_symbol_count: 8, snapshot_id: 'sha256:snapshot' },
      symbols: ['TWSE:2330', 'TWSE:2317', 'TWSE:2454', 'TWSE:2303', 'TWSE:2881', 'TWSE:2882', 'TWSE:2308', 'TWSE:2412'],
    }),
    resolveSavedStrategy: async () => ({
      saved_name: 'obv-v3', match_count: 1, exists: true,
      script: { script_id: 'USER;obv', name: 'obv-v3', type: 'strategy', version: 2 },
    }),
    readResolvedSavedStrategy: async () => ({
      script_id: 'USER;obv', source_sha256: 'local-hash', pine_source: 'source', version: 2,
    }),
    readTargetPaneStudies: async () => ({
      studies: [{
        type: 'strategy', definition_id: 'USER;obv', script_id: 'USER;obv',
        entity_id: 'entity-1', version: 2,
        inputs: [{ id: 'in_0', name: 'Length', type: 'integer', value: 10, constraints: { min: 1, max: 20 } }],
      }],
    }),
    mutation: async () => calls.push('mutation'),
  };
}

describe('Strategy Run dry-run orchestration', () => {
  it('builds a complete bounded reuse plan without mutation', async () => {
    const calls = [];
    const result = await dryRunStrategyAutomation({ config_path: '/tmp/run.json', _deps: successfulDeps(calls) });
    assert.equal(result.success, true, JSON.stringify(result.errors));
    assert.equal(result.strategy_sync.account_action, 'reuse');
    assert.equal(result.strategy_sync.pane_action, 'reuse');
    assert.equal(result.parameter_sets[0].runtime_validation, 'complete');
    assert.equal('inputs' in result.resources.pane_strategy.instances[0], false);
    assert.equal(result.resources.pane_strategy.instances[0].input_count, 1);
    assert.deepEqual(result.watchlist.symbol_sample.first, ['TWSE:2330', 'TWSE:2317', 'TWSE:2454']);
    assert.deepEqual(result.watchlist.symbol_sample.last, ['TWSE:2882', 'TWSE:2308', 'TWSE:2412']);
    assert.equal(JSON.stringify(result).includes('"symbols"'), false);
    assert.deepEqual(calls, ['attach-target']);
  });

  it('aggregates independent Layout, Watchlist, Account, and Parameter errors', async () => {
    const deps = successfulDeps();
    deps.resolveLayoutTarget = async () => { throw Object.assign(new Error('layout missing'), { code: 'TARGET_LAYOUT_NOT_OPEN' }); };
    deps.captureNamedWatchlistSnapshot = async () => { throw Object.assign(new Error('watchlist missing'), { code: 'WATCHLIST_NOT_FOUND' }); };
    deps.resolveSavedStrategy = async () => { throw Object.assign(new Error('duplicate'), { code: 'STRATEGY_NAME_AMBIGUOUS' }); };
    deps.checkPine = async () => ({
      compiled: true,
      input_schema: { available: true, inputs: [], input_schema_fingerprint: 'empty' },
    });
    const result = await dryRunStrategyAutomation({ config_path: '/tmp/run.json', _deps: deps });
    assert.equal(result.success, false);
    const codes = result.errors.map((error) => error.code);
    assert.ok(codes.includes('TARGET_LAYOUT_NOT_OPEN'));
    assert.ok(codes.includes('WATCHLIST_NOT_FOUND'));
    assert.ok(codes.includes('STRATEGY_NAME_AMBIGUOUS'));
    assert.ok(codes.includes('PARAMETER_SET_INPUT_NOT_FOUND'));
  });

  it('blocks unknown Pane versions and empty Runtime Input Catalogs', async () => {
    const unknownVersion = successfulDeps();
    unknownVersion.readTargetPaneStudies = async () => ({
      studies: [{
        type: 'strategy', script_id: 'USER;obv', definition_id: 'USER;obv',
        entity_id: 'entity-1', version: null, inputs: [{ id: 'in_0', name: 'Length', type: 'integer', value: 10 }],
      }],
    });
    const unknownResult = await dryRunStrategyAutomation({
      config_path: '/tmp/run.json', _deps: unknownVersion,
    });
    assert.equal(unknownResult.valid, false);
    assert.ok(unknownResult.errors.some((error) => error.code === 'PANE_STRATEGY_VERSION_UNAVAILABLE'));

    const emptyCatalog = successfulDeps();
    emptyCatalog.readTargetPaneStudies = async () => ({
      studies: [{
        type: 'strategy', script_id: 'USER;obv', definition_id: 'USER;obv',
        entity_id: 'entity-1', version: 2, inputs: [],
      }],
    });
    const emptyResult = await dryRunStrategyAutomation({
      config_path: '/tmp/run.json', _deps: emptyCatalog,
    });
    assert.equal(emptyResult.valid, false);
    assert.ok(emptyResult.errors.some((error) => error.code === 'RUNTIME_INPUT_CATALOG_EMPTY'));
  });
});
