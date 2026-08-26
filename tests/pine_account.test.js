import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSavedScript,
  deleteSavedScript,
  detectPineType,
  getSavedScript,
  listScripts,
  normalizeSavedScript,
  updateSavedScript,
} from '../src/core/pine.js';

const rawScripts = [
  { scriptIdPart: 'USER;strategy', scriptName: 'My Strategy', scriptTitle: 'Strategy Title', version: '2.0', modified: 10, kind: 'strategy' },
  { scriptIdPart: 'USER;indicator', scriptName: 'My Indicator', scriptTitle: 'Indicator Title', version: '3.0', modified: 20, kind: 'study' },
  { scriptIdPart: 'USER;library', scriptName: 'My Library', version: '1.0', kind: 'library' },
  { scriptIdPart: 'USER;unknown', scriptName: 'Mystery', version: '1.0', kind: null },
];

describe('Account Saved Pine normalization', () => {
  it('maps Pine Facade kinds to public types', () => {
    assert.equal(normalizeSavedScript(rawScripts[0]).type, 'strategy');
    assert.equal(normalizeSavedScript(rawScripts[1]).type, 'indicator');
    assert.equal(normalizeSavedScript(rawScripts[2]).type, 'library');
    assert.equal(normalizeSavedScript(rawScripts[3]).type, 'unknown');
  });

  it('preserves script_id and account ownership', () => {
    const script = normalizeSavedScript(rawScripts[0]);
    assert.equal(script.id, 'USER;strategy');
    assert.equal(script.script_id, 'USER;strategy');
    assert.equal(script.owned, true);
    assert.equal(script.modified, 10);
    assert.equal(script.modified_iso, '1970-01-01T00:00:10.000Z');
  });
});

describe('Account Saved Pine list/get', () => {
  it('filters normalized scripts by type', async () => {
    const result = await listScripts({
      type: 'strategy',
      _deps: { evaluateAsync: async () => ({ scripts: rawScripts }) },
    });
    assert.equal(result.success, true);
    assert.equal(result.count, 1);
    assert.equal(result.total_count, 4);
    assert.equal(result.scripts[0].script_id, 'USER;strategy');
  });

  it('rejects unsupported filters before page evaluation', async () => {
    let called = false;
    await assert.rejects(
      listScripts({ type: 'other', _deps: { evaluateAsync: async () => { called = true; } } }),
      /type must be one of/,
    );
    assert.equal(called, false);
  });

  it('gets one account script by script_id without logging or listing source', async () => {
    let call = 0;
    const result = await getSavedScript({
      script_id: 'USER;strategy',
      _deps: {
        evaluateAsync: async () => {
          call++;
          return call === 1 ? { scripts: rawScripts } : { source: '//@version=6\nstrategy("Test")' };
        },
      },
    });
    assert.equal(result.script_id, 'USER;strategy');
    assert.equal(result.type, 'strategy');
    assert.equal(result.lines, 2);
    assert.match(result.pine_source, /strategy/);
  });

  it('rejects a Pane entity ID as the wrong ID kind', async () => {
    await assert.rejects(() => getSavedScript({ script_id: 'abc123' }), /expected USER;/);
  });
});

describe('Account Saved Pine write operations', () => {
  const strategySource = '//@version=6\nstrategy("Disposable")\n';
  const updatedStrategySource = '//@version=6\nstrategy("Disposable")\nplot(close)\n';
  const metadata = {
    script_id: 'USER;disposable', name: 'Disposable', type: 'strategy',
    version: '1.0', owned: true,
  };

  it('detects the declared Pine resource type', () => {
    assert.equal(detectPineType(strategySource), 'strategy');
    assert.equal(detectPineType('//@version=6\nindicator("One")'), 'indicator');
    assert.equal(detectPineType('//@version=6\nlibrary("One")'), 'library');
    assert.equal(detectPineType('//@version=6\nplot(close)'), 'unknown');
  });

  it('creates and verifies a new Saved Pine Script', async () => {
    let listCall = 0;
    const result = await createSavedScript({
      name: 'Disposable', type: 'strategy', source: strategySource,
      _deps: {
        listScripts: async () => ({ scripts: listCall++ === 0 ? [] : [metadata] }),
        saveNew: async () => ({ success: true, metaInfo: { scriptIdPart: metadata.script_id, version: '1.0' } }),
        getSavedScript: async () => ({ ...metadata, pine_source: strategySource }),
        delay: async () => {}, readbackAttempts: 1,
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.script_id, metadata.script_id);
    assert.equal(result.compile_ok, true);
  });

  it('rejects create when the requested type disagrees with the declaration', async () => {
    await assert.rejects(() => createSavedScript({
      name: 'Wrong', type: 'indicator', source: strategySource,
    }), /declaration type is strategy/);
  });

  it('updates only an owned Script and verifies normalized source readback', async () => {
    let getCall = 0;
    const result = await updateSavedScript({
      script_id: metadata.script_id, source: updatedStrategySource,
      _deps: {
        getSavedScript: async () => getCall++ === 0
          ? { ...metadata, pine_source: strategySource }
          : { ...metadata, version: '2.0', pine_source: updatedStrategySource.replace(/\n/g, '\r\n') },
        saveNext: async () => ({ success: true, metaInfo: { scriptIdPart: metadata.script_id, version: '2.0' } }),
        listScripts: async () => ({ scripts: [{ ...metadata, version: '2.0' }] }),
        delay: async () => {}, readbackAttempts: 1,
      },
    });
    assert.equal(result.success, true);
    assert.equal(result.previous_version, '1.0');
    assert.equal(result.version, '2.0');
  });

  it('reports compile failure honestly even when TradingView persisted the version', async () => {
    let getCall = 0;
    const result = await updateSavedScript({
      script_id: metadata.script_id, source: updatedStrategySource,
      _deps: {
        getSavedScript: async () => getCall++ === 0
          ? { ...metadata, pine_source: strategySource }
          : { ...metadata, version: '2.0', pine_source: updatedStrategySource },
        saveNext: async () => ({ success: false, compileErrors: { errors: [{ message: 'compile failed' }] } }),
        listScripts: async () => ({ scripts: [metadata] }),
        delay: async () => {}, readbackAttempts: 1,
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.saved, true);
    assert.equal(result.compile_ok, false);
    assert.match(result.revert_hint, /previous source/);
  });

  it('requires confirmation before delete touches account data', async () => {
    let read = false;
    await assert.rejects(() => deleteSavedScript({
      script_id: metadata.script_id,
      _deps: { getSavedScript: async () => { read = true; } },
    }), /explicit confirmation/);
    assert.equal(read, false);
  });

  it('deletes an owned Script and confirms it is absent', async () => {
    const result = await deleteSavedScript({
      script_id: metadata.script_id, confirmed: true,
      _deps: {
        getSavedScript: async () => ({ ...metadata, pine_source: strategySource }),
        deleteScript: async () => ({ ok: true, status: 200, body: 'ok' }),
        listScripts: async () => ({ scripts: [] }),
        delay: async () => {}, readbackAttempts: 1,
      },
    });
    assert.equal(result.deleted, true);
    assert.equal(result.script_id, metadata.script_id);
  });

  it('fails create when source readback does not match', async () => {
    let listCall = 0;
    await assert.rejects(() => createSavedScript({
      name: 'Disposable', type: 'strategy', source: strategySource,
      _deps: {
        listScripts: async () => ({ scripts: listCall++ === 0 ? [] : [metadata] }),
        saveNew: async () => ({ success: true, metaInfo: { scriptIdPart: metadata.script_id } }),
        getSavedScript: async () => ({ ...metadata, pine_source: '//@version=6\nstrategy("Other")' }),
        delay: async () => {}, readbackAttempts: 1,
      },
    }), /source readback mismatch/);
  });
});
