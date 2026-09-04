import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoreOperationError } from '../src/core/errors.js';
import { registerStrategyTools } from '../src/tools/strategy.js';

const context = Object.freeze({
  tab_index: 1,
  target_id: 'target-1',
  layout_id: 'layout-1',
  pane_index: 0,
  pane_id: '1',
  symbol: 'NASDAQ:AAPL',
  resolution: '1D',
});

function toolsWith(dependencies) {
  const tools = new Map();
  registerStrategyTools({
    tool(name, description, schema, handler) {
      tools.set(name, { description, schema, handler });
    },
  }, {
    prepareContext: async () => context,
    legacyCore: {
      getActiveStrategy: async () => ({ success: true }),
      selectStrategy: async () => ({ success: true }),
      getStrategyReport: async () => ({ success: true }),
      getStrategyOrders: async () => ({ success: true }),
      getStrategyTrades: async () => ({ success: true }),
      getStrategyEquity: async () => ({ success: true }),
      ...dependencies?.legacyCore,
    },
    tradingCore: {
      validateStrategyTradingExportScope: () => {},
      getStrategyTradingReport: async () => ({ success: true }),
      getStrategyTradingData: async () => ({ success: true }),
      exportStrategyTrading: async () => ({ success: true }),
      ...dependencies?.tradingCore,
    },
  });
  return tools;
}

function payload(response) {
  return JSON.parse(response.content[0].text);
}

describe('Strategy Trading MCP parity', () => {
  it('forwards the same explicit Report request and resolved context to Core', async () => {
    let received;
    const expected = { success: true, snapshot_id: 'snapshot-1', report: { schema_version: 1 } };
    const tools = toolsWith({
      tradingCore: {
        getStrategyTradingReport: async (options) => { received = options; return expected; },
      },
    });
    const response = await tools.get('strategy_get_trading_report').handler({
      entity_id: 'strategy-1', symbol: 'TWSE:2344', timeframe: '1D', timeout_ms: 1234,
      layout_id: 'layout-1', pane_index: 0,
    });
    assert.deepEqual(received, {
      entity_id: 'strategy-1', symbol: 'TWSE:2344', timeframe: '1D',
      timeout_ms: 1234, context,
    });
    assert.deepEqual(payload(response), expected);
    assert.equal(response.isError, undefined);
  });

  it('forwards pagination and artifact options to the same Trading Data Core service', async () => {
    let received;
    const expected = {
      success: true,
      snapshot_id: 'snapshot-1',
      total: 4000,
      output: { path: '/tmp/trades.jsonl', format: 'jsonl', written_trades: 500 },
    };
    const tools = toolsWith({
      tradingCore: {
        getStrategyTradingData: async (options) => { received = options; return expected; },
      },
    });
    const response = await tools.get('strategy_get_trading_data').handler({
      entity_id: 'strategy-1', symbol: 'TWSE:2344', timeframe: '1D',
      offset: 500, limit: 500, snapshot_id: 'snapshot-1',
      format: 'jsonl', output: '/tmp/trades.jsonl', force: true, timeout_ms: 20000,
    });
    assert.deepEqual(received, {
      entity_id: 'strategy-1', symbol: 'TWSE:2344', timeframe: '1D',
      offset: 500, limit: 500, snapshot_id: 'snapshot-1',
      format: 'jsonl', output: '/tmp/trades.jsonl', force: true,
      timeout_ms: 20000, context,
    });
    assert.deepEqual(payload(response), expected);
    assert.equal('trades' in payload(response), false);
  });

  it('returns only the bounded Watchlist export summary and marks partial results as MCP errors', async () => {
    let validated;
    let received;
    const expected = {
      success: false,
      status: 'partial',
      summary: { requested: 3, succeeded: 2, failed: 1, skipped: 0 },
      artifacts: { manifest: { path: '/tmp/run/manifest.json' } },
      symbols: [{ requested_symbol: 'TWSE:2344', status: 'failed' }],
    };
    const tools = toolsWith({
      tradingCore: {
        validateStrategyTradingExportScope: (options) => { validated = options; },
        exportStrategyTrading: async (options) => { received = options; return expected; },
      },
    });
    const args = {
      entity_id: 'strategy-1', watchlist: 'active', output_directory: '/tmp/run',
      format: 'csv', fail_fast: false, layout_id: 'layout-1', pane_index: 0,
    };
    const response = await tools.get('strategy_export_trading').handler(args);
    assert.equal(validated, args);
    assert.deepEqual(received, {
      entity_id: 'strategy-1', symbol: undefined, watchlist: 'active',
      timeframe: undefined, output_directory: '/tmp/run', format: 'csv',
      force: undefined, fail_fast: false, timeout_ms: undefined, context,
    });
    assert.deepEqual(payload(response), expected);
    assert.equal(response.isError, true);
    assert.equal('trades' in payload(response), false);
  });

  it('preserves stable Core error metadata and marks the tool result as an error', async () => {
    const tools = toolsWith({
      tradingCore: {
        getStrategyTradingReport: async () => {
          throw new CoreOperationError('snapshot changed', {
            code: 'STALE_STRATEGY_SNAPSHOT', phase: 'trading_data_batch',
            entity_id: 'strategy-1', symbol: 'TWSE:2344', retryable: true, context,
          });
        },
      },
    });
    const response = await tools.get('strategy_get_trading_report').handler({
      entity_id: 'strategy-1', symbol: 'TWSE:2344',
    });
    assert.equal(response.isError, true);
    assert.deepEqual(payload(response), {
      success: false,
      code: 'STALE_STRATEGY_SNAPSHOT',
      error: 'snapshot changed',
      phase: 'trading_data_batch',
      entity_id: 'strategy-1',
      symbol: 'TWSE:2344',
      retryable: true,
      context,
    });
  });

  it('keeps legacy Report and Trades tools explicit about incomplete compatibility semantics', async () => {
    const tools = toolsWith({
      legacyCore: {
        getStrategyReport: async () => ({ success: true, metrics: {} }),
        getStrategyTrades: async () => ({ success: true, trades: [{ report_index: 9 }] }),
      },
    });
    const report = payload(await tools.get('strategy_get_report').handler({ entity_id: 'strategy-1' }));
    const trades = payload(await tools.get('strategy_get_trades').handler({ entity_id: 'strategy-1' }));
    assert.equal(report.deprecated, true);
    assert.equal(report.snapshot_complete, false);
    assert.equal(trades.deprecated, true);
    assert.equal(trades.snapshot_complete, false);
  });
});
