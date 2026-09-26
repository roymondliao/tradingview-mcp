import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountScriptIdFromDefinition,
  readTargetPaneStudies,
  resolveLayoutFromInventory,
  resolvePaneStrategyInstances,
  resolveSavedStrategyFromInventory,
} from '../src/core/strategy-run-resolver.js';

function tab(overrides = {}) {
  return {
    is_chart: true,
    tab_index: 1,
    target_id: 'target-1',
    url_chart_id: 'url-1',
    layout: { layout_name: 'dev', layout_id: 'layout-1', saved_layout_id: 101, pane_layout: '2h' },
    panes: [{ pane_index: 0, pane_id: 'pane-0', symbol: 'TWSE_DLY:2330', resolution: '1D' }],
    ...overrides,
  };
}

describe('Strategy Run exact-name resource resolution', () => {
  it('resolves one open Layout and the required Pane identity', () => {
    const result = resolveLayoutFromInventory({
      inventory: { tabs: [tab()] }, layout_name: 'dev', pane_index: 0,
    });
    assert.deepEqual(result, {
      tab_index: 1,
      target_id: 'target-1',
      url_chart_id: 'url-1',
      layout_name: 'dev',
      layout_id: 'layout-1',
      saved_layout_id: 101,
      pane_layout: '2h',
      pane_index: 0,
      pane_id: 'pane-0',
      symbol: 'TWSE_DLY:2330',
      timeframe: '1D',
    });
  });

  it('rejects absent, duplicate, and out-of-range Layout/Pane matches', () => {
    assert.throws(
      () => resolveLayoutFromInventory({ inventory: { tabs: [] }, layout_name: 'dev', pane_index: 0 }),
      (error) => error.code === 'TARGET_LAYOUT_NOT_OPEN',
    );
    assert.throws(
      () => resolveLayoutFromInventory({ inventory: { tabs: [tab(), tab({ target_id: 'target-2' })] }, layout_name: 'dev', pane_index: 0 }),
      (error) => error.code === 'TARGET_LAYOUT_AMBIGUOUS',
    );
    assert.throws(
      () => resolveLayoutFromInventory({ inventory: { tabs: [tab()] }, layout_name: 'dev', pane_index: 2 }),
      (error) => error.code === 'PANE_INDEX_INVALID',
    );
  });

  it('treats a missing Account Strategy as a create candidate and rejects duplicates', () => {
    const missing = resolveSavedStrategyFromInventory({
      inventory: { scripts: [] }, saved_name: 'obv-v3',
    });
    assert.equal(missing.exists, false);
    assert.equal(missing.match_count, 0);
    assert.throws(() => resolveSavedStrategyFromInventory({
      inventory: { scripts: [
        { type: 'strategy', name: 'obv-v3', script_id: 'USER;1' },
        { type: 'strategy', title: 'obv-v3', name: 'other', script_id: 'USER;2' },
      ] },
      saved_name: 'obv-v3',
    }), (error) => error.code === 'STRATEGY_NAME_AMBIGUOUS');
  });

  it('reads a selected Pane without focus mutation and builds its Runtime Input catalog', async () => {
    let expression = '';
    const result = await readTargetPaneStudies({
      target_id: 'target-1', pane_index: 0,
      _deps: {
        evaluateTarget: async (_targetId, source) => {
          expression = source;
          return {
            pane_index: 0,
            symbol: 'TWSE_DLY:2330',
            timeframe: '1D',
            studies: [{
              entity_id: 'entity-1', name: 'obv-v3', type: 'strategy',
              definition_id: 'Script$USER;obv@tv-scripting-101!', version: 2,
              values: [{ id: 'in_0', value: 10 }],
              info: [{ id: 'in_0', name: 'Length', type: 'integer', defval: 10, min: 1, max: 20 }],
            }],
          };
        },
      },
    });
    assert.doesNotMatch(expression, /_activateChart|\.click\(/);
    assert.equal(result.studies[0].inputs[0].name, 'Length');
    assert.equal(result.studies[0].inputs[0].default_value, 10);
    const matches = resolvePaneStrategyInstances({ pane_state: result, script_id: 'USER;obv' });
    assert.equal(matches.match_count, 1);
    assert.equal(matches.matches[0].entity_id, 'entity-1');
  });

  it('extracts and compares the complete Account Script ID instead of a substring', () => {
    assert.equal(
      accountScriptIdFromDefinition('StrategyScript$USER;abcdef@tv-scripting-101'),
      'USER;abcdef',
    );
    const paneState = {
      studies: [{
        type: 'strategy',
        definition_id: 'StrategyScript$USER;abcdef@tv-scripting-101',
        entity_id: 'one',
      }],
    };
    assert.equal(resolvePaneStrategyInstances({
      pane_state: paneState, script_id: 'USER;abc',
    }).match_count, 0);
    assert.equal(resolvePaneStrategyInstances({
      pane_state: paneState, script_id: 'USER;abcdef',
    }).match_count, 1);
  });

  it('rejects multiple Pane Strategy Instances for the same Account script', () => {
    const strategy = { type: 'strategy', definition_id: 'USER;obv', entity_id: 'one' };
    assert.throws(() => resolvePaneStrategyInstances({
      pane_state: { studies: [strategy, { ...strategy, entity_id: 'two' }] },
      script_id: 'USER;obv',
    }), (error) => error.code === 'STRATEGY_INSTANCE_AMBIGUOUS');
  });
});
