import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerPineTools } from '../src/tools/pine.js';
import { registerStudyTools } from '../src/tools/studies.js';
import { registerStrategyTools } from '../src/tools/strategy.js';
import { registerDataTools } from '../src/tools/data.js';

function collectTools(registerGroup) {
  const tools = new Map();
  const server = {
    tool(name, description, schema, handler) {
      assert.equal(tools.has(name), false, `duplicate MCP tool: ${name}`);
      tools.set(name, { description, schema, handler });
    },
  };
  registerGroup(server);
  return tools;
}

describe('Study and Strategy MCP registration inventory', () => {
  it('registers Account Pine read/write vertical slices', () => {
    const tools = collectTools(registerPineTools);
    for (const name of [
      'pine_list_scripts', 'pine_get_script', 'pine_create_script',
      'pine_update_script', 'pine_delete_script', 'pine_analyze', 'pine_check',
    ]) {
      assert.equal(typeof tools.get(name)?.handler, 'function', `${name} registered`);
    }
    assert.ok(tools.get('pine_check')?.schema?.source, 'pine_check exposes source');
  });

  it('registers the complete Active Pane Study lifecycle', () => {
    const tools = collectTools(registerStudyTools);
    for (const name of [
      'study_search', 'study_list', 'study_get', 'study_add',
      'study_get_inputs', 'study_set_inputs', 'study_toggle_visibility', 'study_remove',
    ]) {
      assert.equal(typeof tools.get(name)?.handler, 'function', `${name} registered`);
    }
    for (const key of ['tab_index', 'url_chart_id', 'layout_id', 'saved_layout_id', 'pane_index']) {
      assert.ok(tools.get('study_list')?.schema?.[key], `study_list exposes ${key}`);
    }
    assert.ok(tools.get('study_set_inputs')?.schema?.inputs, 'study_set_inputs exposes inputs');
    assert.ok(tools.get('study_set_inputs')?.schema?.inputs_by_name, 'study_set_inputs exposes inputs_by_name');
  });

  it('registers explicit Strategy selection and data commands', () => {
    const tools = collectTools(registerStrategyTools);
    for (const name of [
      'strategy_get_active', 'strategy_get_trading_report',
      'strategy_get_trading_data', 'strategy_export_trading',
      'strategy_select', 'strategy_get_report',
      'strategy_get_orders', 'strategy_get_trades', 'strategy_get_equity',
    ]) {
      assert.equal(typeof tools.get(name)?.handler, 'function', `${name} registered`);
    }
    for (const key of ['tab_index', 'url_chart_id', 'layout_id', 'saved_layout_id', 'pane_index']) {
      assert.ok(tools.get('strategy_get_trading_report')?.schema?.[key], `strategy_get_trading_report exposes ${key}`);
    }
    for (const key of ['entity_id', 'symbol', 'timeframe', 'offset', 'limit', 'snapshot_id', 'format', 'output', 'force', 'timeout_ms']) {
      assert.ok(tools.get('strategy_get_trading_data')?.schema?.[key], `strategy_get_trading_data exposes ${key}`);
    }
    for (const key of ['entity_id', 'symbol', 'watchlist', 'timeframe', 'output_directory', 'format', 'force', 'fail_fast', 'timeout_ms']) {
      assert.ok(tools.get('strategy_export_trading')?.schema?.[key], `strategy_export_trading exposes ${key}`);
    }
    assert.match(tools.get('strategy_select').description, /Deprecated/);
    assert.match(tools.get('strategy_get_report').description, /Deprecated/);
    assert.match(tools.get('strategy_get_trades').description, /Deprecated/);
  });

  it('keeps legacy Data aliases explicit and Pane-addressable', () => {
    const tools = collectTools(registerDataTools);
    for (const name of ['data_get_strategy_results', 'data_get_trades', 'data_get_equity']) {
      assert.match(tools.get(name).description, /Deprecated/);
      assert.ok(tools.get(name).schema.entity_id);
      for (const key of ['tab_index', 'layout_id', 'saved_layout_id', 'pane_index']) {
        assert.ok(tools.get(name).schema[key], `${name} exposes ${key}`);
      }
    }
  });
});
