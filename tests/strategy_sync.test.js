import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planStrategySync } from '../src/core/strategy-sync.js';

describe('Strategy sync planning', () => {
  it('keeps sync blocked when Account resolution or source readback is unavailable', () => {
    assert.equal(planStrategySync({ local_source_sha256: 'local' }).account_action, 'blocked');
    assert.equal(planStrategySync({
      local_source_sha256: 'local', account: { exists: true },
    }).account_action, 'blocked');
  });

  it('plans Account create and Pane add when the Saved Strategy is absent', () => {
    const result = planStrategySync({
      local_source_sha256: 'local', account: { exists: false }, pane_instances: { matches: [] },
    });
    assert.equal(result.account_action, 'create');
    assert.equal(result.pane_action, 'add_latest');
  });

  it('reuses matching source and Pane version', () => {
    const result = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: '3.0' } },
      pane_instances: { matches: [{ version: '3.0' }] },
    });
    assert.equal(result.account_action, 'reuse');
    assert.equal(result.pane_action, 'reuse');
    assert.equal(result.pane_version_matches, true);
  });

  it('refreshes a stale Pane even when Account source is already current', () => {
    const result = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: '3.0' } },
      pane_instances: { matches: [{ version: '2.0' }] },
    });
    assert.equal(result.account_action, 'reuse');
    assert.equal(result.pane_action, 'refresh');
    assert.equal(result.pane_version_matches, false);
  });

  it('blocks when Account or Pane version cannot be read', () => {
    const accountUnknown = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: null } },
      pane_instances: { matches: [] },
    });
    assert.equal(accountUnknown.valid, false);
    assert.equal(accountUnknown.errors[0].code, 'ACCOUNT_STRATEGY_VERSION_UNAVAILABLE');

    const paneUnknown = planStrategySync({
      local_source_sha256: 'same',
      account: { exists: true, source_sha256: 'same', script: { version: '3.0' } },
      pane_instances: { matches: [{ version: null }] },
    });
    assert.equal(paneUnknown.valid, false);
    assert.equal(paneUnknown.pane_action, 'blocked');
    assert.equal(paneUnknown.errors[0].code, 'PANE_STRATEGY_VERSION_UNAVAILABLE');
  });

  it('plans Account update and Pane refresh for changed local source', () => {
    const result = planStrategySync({
      local_source_sha256: 'new',
      account: { exists: true, source_sha256: 'old', script: { version: '2.0' } },
      pane_instances: { matches: [{ version: '2.0' }] },
    });
    assert.equal(result.account_action, 'update');
    assert.equal(result.pane_action, 'refresh');
  });
});
