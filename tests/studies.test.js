import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  addActivePaneStudy,
  classifyStudyMetadata,
  classifyStudySource,
  getActivePaneState,
  getActivePaneStudy,
  getStudyInputs,
  listActivePaneStudies,
  normalizeCatalogResult,
  removeActivePaneStudy,
  sanitizeStudyInputs,
  searchCatalog,
  setStudyInputs,
  toggleStudyVisibility,
} from '../src/core/studies.js';

describe('Study type classification', () => {
  it('classifies TradingView strategy metadata', () => {
    assert.equal(classifyStudyMetadata({ isTVScriptStrategy: true }), 'strategy');
    assert.equal(classifyStudyMetadata({ is_strategy: true }), 'strategy');
  });

  it('uses reportData capability as a strategy fallback', () => {
    assert.equal(classifyStudyMetadata(null, true), 'strategy');
  });

  it('classifies metadata-backed non-strategies as indicators', () => {
    assert.equal(classifyStudyMetadata({ description: 'Moving Average' }), 'indicator');
    assert.equal(classifyStudyMetadata({ isTVScriptStrategy: false }), 'indicator');
  });

  it('returns unknown when metadata and strategy evidence are absent', () => {
    assert.equal(classifyStudyMetadata(null, false), 'unknown');
    assert.equal(classifyStudyMetadata(undefined, false), 'unknown');
  });

  it('classifies Account, Community, built-in, and unknown Study sources', () => {
    assert.equal(classifyStudySource({ id: 'StrategyScript$USER;one@tv-scripting' }), 'account');
    assert.equal(classifyStudySource({ fullId: 'Script$PUB;one@tv-scripting-101!' }), 'community');
    assert.equal(classifyStudySource({ fullId: 'Script$STD;RSI@tv-scripting-101!' }), 'built-in');
    assert.equal(classifyStudySource({ id: 'Volume@tv-basicstudies' }), 'built-in');
    assert.equal(classifyStudySource({}), 'unknown');
  });
});

describe('Active Pane state normalization', () => {
  it('preserves the normalized state returned by the page adapter', async () => {
    let expression = '';
    const result = await getActivePaneState({
      _deps: {
        evaluate: async (source) => {
          expression = source;
          return {
            symbol: 'NASDAQ:AAPL',
            resolution: '1D',
            chartType: 1,
            studies: [
              { id: 'one', entity_id: 'one', name: 'Strategy', type: 'strategy', visible: true, report_ready: true },
              { id: 'two', entity_id: 'two', name: 'Indicator', type: 'indicator', visible: false },
            ],
          };
        },
      },
    });

    assert.equal(result.success, true);
    assert.equal(result.studies[0].entity_id, 'one');
    assert.equal(result.studies[0].type, 'strategy');
    assert.equal(result.studies[1].visible, false);
    assert.match(expression, /_classifyStudyMetadata/);
    assert.match(expression, /report_ready/);
    assert.match(expression, /is_active_strategy/);
    assert.match(expression, /source: _studySourceOf/);
  });
});

describe('Study Catalog search', () => {
  it('normalizes account results with Saved Pine type and script_id', () => {
    const result = normalizeCatalogResult(
      { title: 'My Strategy', section: 'My scripts' },
      [{ script_id: 'USER;one', name: 'My Strategy', title: 'My Strategy', type: 'strategy' }],
    );
    assert.equal(result.source, 'account');
    assert.equal(result.type, 'strategy');
    assert.equal(result.script_id, 'USER;one');
  });

  it('keeps Community type unknown without reliable metadata', () => {
    const result = normalizeCatalogResult({ title: 'Public Script', section: 'Community Scripts' });
    assert.equal(result.source, 'community');
    assert.equal(result.type, 'unknown');
  });

  it('filters normalized search results without mutating the pane', async () => {
    const result = await searchCatalog({
      query: 'test', source: 'account', type: 'indicator',
      _deps: {
        listScripts: async () => ({ scripts: [
          { script_id: 'USER;saved', name: 'Test Saved Indicator', title: 'Test Saved Indicator', type: 'indicator' },
        ] }),
        listBuiltinCatalog: async () => [],
      },
    });
    assert.equal(result.count, 1);
    assert.equal(result.results[0].script_id, 'USER;saved');
  });

  it('searches built-in Pine metadata without opening the Indicators dialog', async () => {
    const result = await searchCatalog({
      query: 'relative strength', source: 'built-in', type: 'indicator',
      _deps: {
        listScripts: async () => ({ scripts: [] }),
        listBuiltinCatalog: async () => [{
          title: 'Relative Strength Index', study_id: 'STD;RSI', version: '27.0', kind: 'study',
        }],
      },
    });
    assert.equal(result.results[0].study_id, 'STD;RSI');
    assert.equal(result.results[0].source, 'built-in');
  });

  it('rejects deferred Community catalog search explicitly', async () => {
    await assert.rejects(() => searchCatalog({ query: 'Supertrend', source: 'community' }), /source must be one of/);
  });
});

describe('Active Pane Study list/get', () => {
  const state = {
    success: true, symbol: 'NASDAQ:AAPL', resolution: '1D',
    studies: [
      { entity_id: 'strategy', name: 'Strategy', type: 'strategy', visible: true },
      { entity_id: 'indicator', name: 'Indicator', type: 'indicator', visible: false },
    ],
  };

  it('lists and filters active-pane Study Instances', async () => {
    const result = await listActivePaneStudies({
      type: 'strategy', _deps: { getActivePaneState: async () => state },
    });
    assert.equal(result.count, 1);
    assert.equal(result.total_count, 2);
    assert.equal(result.studies[0].entity_id, 'strategy');
  });

  it('gets one Study and filters oversized input values', async () => {
    const result = await getActivePaneStudy({
      entity_id: 'strategy',
      _deps: {
        getActivePaneState: async () => state,
        evaluate: async () => ({ inputs: [
          { id: 'length', name: 'Length', value: 20 },
          { id: 'text', value: 'x'.repeat(300) },
        ] }),
      },
    });
    assert.equal(result.entity_id, 'strategy');
    assert.deepEqual(result.inputs, [{ id: 'length', name: 'Length', value: 20 }]);
  });

  it('rejects an Entity outside the active pane before detail evaluation', async () => {
    let evaluated = false;
    await assert.rejects(() => getActivePaneStudy({
      entity_id: 'other',
      _deps: {
        getActivePaneState: async () => state,
        evaluate: async () => { evaluated = true; },
      },
    }), /not found in the active pane/);
    assert.equal(evaluated, false);
  });

  it('sanitizes malformed and encoded input payloads', () => {
    const circular = {}; circular.value = circular;
    assert.deepEqual(sanitizeStudyInputs([
      null,
      { id: 'pineFeatures', value: 'encoded-internal-data' },
      { id: 'valid', value: 'close' },
      { id: 'large', value: 'x'.repeat(501) },
      { id: 'circular', value: circular },
    ]), [{ id: 'valid', value: 'close' }]);
  });
});

describe('Active Pane Study mutations', () => {
  const strategy = {
    success: true, entity_id: 'strategy', name: 'Strategy', type: 'strategy', visible: true,
    inputs: [{ id: 'in_0', name: 'Length', value: 10 }, { id: 'in_1', name: 'Source', value: 'close' }],
  };

  it('gets Study inputs through the shared read model', async () => {
    const result = await getStudyInputs({
      entity_id: 'strategy', _deps: { getActivePaneStudy: async () => strategy },
    });
    assert.equal(result.inputs.length, 2);
    assert.equal(result.type, 'strategy');
  });

  it('sets known inputs and reports unknown IDs separately', async () => {
    const result = await setStudyInputs({
      entity_id: 'strategy', inputs: { in_0: 20, missing: true },
      _deps: {
        getActivePaneStudy: async () => strategy,
        evaluate: async () => ({ inputs: [
          { id: 'in_0', name: 'Length', value: 20 },
          { id: 'in_1', name: 'Source', value: 'close' },
        ] }),
      },
    });
    assert.equal(result.success, true);
    assert.deepEqual(result.applied_inputs, { in_0: 20 });
    assert.deepEqual(result.unknown_inputs, ['missing']);
    assert.equal(result.report_state, 'recalculating');
  });

  it('does not evaluate a mutation when all input IDs are unknown', async () => {
    let evaluated = false;
    await assert.rejects(() => setStudyInputs({
      entity_id: 'strategy', inputs: { missing: 1 },
      _deps: {
        getActivePaneStudy: async () => strategy,
        evaluate: async () => { evaluated = true; },
      },
    }), /None of the requested input IDs/);
    assert.equal(evaluated, false);
  });

  it('toggles visibility and verifies readback', async () => {
    const result = await toggleStudyVisibility({
      entity_id: 'strategy', visible: false,
      _deps: {
        getActivePaneStudy: async () => strategy,
        evaluate: async () => ({ visible: false }),
      },
    });
    assert.equal(result.previous_visible, true);
    assert.equal(result.visible, false);
    assert.equal(result.report_state, 'unavailable_while_hidden');
  });

  it('removes only after the Entity disappears from Active Pane readback', async () => {
    const result = await removeActivePaneStudy({
      entity_id: 'strategy',
      _deps: {
        getActivePaneStudy: async () => strategy,
        evaluate: async () => true,
        delay: async () => {},
        getActivePaneState: async () => ({ studies: [] }),
      },
    });
    assert.equal(result.removed, true);
    assert.equal(result.entity_id, 'strategy');
  });

  it('fails removal when readback still contains the Entity', async () => {
    await assert.rejects(() => removeActivePaneStudy({
      entity_id: 'strategy',
      _deps: {
        getActivePaneStudy: async () => strategy,
        evaluate: async () => true,
        delay: async () => {},
        getActivePaneState: async () => ({ studies: [{ entity_id: 'strategy' }] }),
      },
    }), /removal readback failed/);
  });
});

describe('Add Study to Active Pane', () => {
  const before = { studies: [{ entity_id: 'existing', name: 'Volume', type: 'indicator', visible: true }] };
  const after = { studies: [
    ...before.studies,
    { entity_id: 'new-one', name: 'New Study', type: 'indicator', visible: true },
  ] };

  it('adds a stable built-in study_id and verifies the new Entity', async () => {
    let stateCall = 0;
    let expression = '';
    const result = await addActivePaneStudy({
      study_id: 'Volume@tv-basicstudies',
      _deps: {
        getActivePaneState: async () => (++stateCall === 1 ? before : after),
        evaluate: async (source) => { expression = source; return true; },
        delay: async () => {},
      },
    });
    assert.equal(result.entity_id, 'new-one');
    assert.equal(result.definition_id, 'Volume@tv-basicstudies');
    assert.equal(result.definition, 'Volume@tv-basicstudies');
    assert.match(expression, /createStudy/);
  });

  it('uses a Pine descriptor for a standard catalog study_id', async () => {
    let stateCall = 0;
    let expression = '';
    const result = await addActivePaneStudy({
      study_id: 'STD;RSI',
      _deps: {
        getActivePaneState: async () => (++stateCall === 1 ? before : after),
        evaluate: async (source) => { expression = source; return true; },
        delay: async () => {},
      },
    });
    assert.deepEqual(result.definition, { type: 'pine', pineId: 'STD;RSI', version: 'last' });
    assert.match(expression, /"pineId":"STD;RSI"/);
  });

  it('converts an Account Strategy script_id to the TradingView definition ID', async () => {
    let stateCall = 0;
    const result = await addActivePaneStudy({
      script_id: 'USER;strategy',
      _deps: {
        getActivePaneState: async () => (++stateCall === 1 ? before : {
          studies: [...before.studies, { entity_id: 'strategy-new', name: 'Strategy', type: 'strategy', visible: true }],
        }),
        getSavedScript: async () => ({ script_id: 'USER;strategy', name: 'Strategy', type: 'strategy' }),
        evaluate: async () => true,
        delay: async () => {},
      },
    });
    assert.equal(result.definition_id, 'USER;strategy');
    assert.deepEqual(result.definition, { type: 'pine', pineId: 'USER;strategy', version: 'last' });
    assert.equal(result.script_id, 'USER;strategy');
    assert.equal(result.type, 'strategy');
  });

  it('converts an Account Indicator script_id and applies confirmed initial inputs', async () => {
    let stateCall = 0;
    const result = await addActivePaneStudy({
      script_id: 'USER;indicator', inputs: { in_0: 50 },
      _deps: {
        getActivePaneState: async () => (++stateCall === 1 ? before : {
          studies: [...before.studies, { entity_id: 'indicator-new', name: 'Indicator', type: 'indicator', source: 'account', visible: true }],
        }),
        getSavedScript: async () => ({ script_id: 'USER;indicator', name: 'Indicator', type: 'indicator' }),
        evaluate: async () => true,
        delay: async () => {},
        setStudyInputs: async ({ entity_id, inputs }) => ({
          success: true, entity_id, requested_inputs: inputs, applied_inputs: inputs,
        }),
      },
    });
    assert.equal(result.definition_id, 'USER;indicator');
    assert.equal(result.inputs.success, true);
  });

  it('rejects ambiguous selectors before mutation', async () => {
    await assert.rejects(() => addActivePaneStudy({ script_id: 'USER;x', study_id: 'Volume' }), /Exactly one/);
  });

  it('fails when readback does not contain exactly one new Entity', async () => {
    await assert.rejects(() => addActivePaneStudy({
      study_id: 'Volume',
      _deps: {
        getActivePaneState: async () => before,
        evaluate: async () => true,
        delay: async () => {},
      },
    }), /expected one new Entity, found 0/);
  });
});
