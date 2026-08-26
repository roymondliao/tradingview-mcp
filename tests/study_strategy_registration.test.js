import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerPineTools } from '../src/tools/pine.js';
import { registerStudyTools } from '../src/tools/studies.js';
import { registerStrategyTools } from '../src/tools/strategy.js';

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
      'pine_update_script', 'pine_delete_script',
    ]) {
      assert.equal(typeof tools.get(name)?.handler, 'function', `${name} registered`);
    }
  });

  it('registers the complete Active Pane Study lifecycle', () => {
    const tools = collectTools(registerStudyTools);
    for (const name of [
      'study_search', 'study_list', 'study_get', 'study_add',
      'study_get_inputs', 'study_set_inputs', 'study_toggle_visibility', 'study_remove',
    ]) {
      assert.equal(typeof tools.get(name)?.handler, 'function', `${name} registered`);
    }
    for (const key of ['tab_index', 'url_chart_id', 'layout_id', 'pane_index']) {
      assert.ok(tools.get('study_list')?.schema?.[key], `study_list exposes ${key}`);
    }
  });

  it('registers explicit Strategy selection and data commands', () => {
    const tools = collectTools(registerStrategyTools);
    for (const name of [
      'strategy_get_active', 'strategy_select', 'strategy_get_report',
      'strategy_get_orders', 'strategy_get_trades', 'strategy_get_equity',
    ]) {
      assert.equal(typeof tools.get(name)?.handler, 'function', `${name} registered`);
    }
    for (const key of ['tab_index', 'url_chart_id', 'layout_id', 'pane_index']) {
      assert.ok(tools.get('strategy_get_report')?.schema?.[key], `strategy_get_report exposes ${key}`);
    }
  });
});
