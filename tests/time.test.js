import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  unixMillisecondsToIso,
  unixSecondsToIso,
  withUnixSecondsIso,
} from '../src/core/time.js';

describe('Unix timestamp ISO companions', () => {
  it('formats Unix seconds as UTC ISO 8601', () => {
    assert.equal(unixSecondsToIso(1704067200), '2024-01-01T00:00:00.000Z');
  });

  it('formats stream emission milliseconds without changing their unit', () => {
    assert.equal(unixMillisecondsToIso(1704067200000), '2024-01-01T00:00:00.000Z');
  });

  it('preserves numeric fields and appends named ISO companions', () => {
    assert.deepEqual(withUnixSecondsIso({ from: 1704067200, to: 1704153600 }, ['from', 'to']), {
      from: 1704067200,
      to: 1704153600,
      from_iso: '2024-01-01T00:00:00.000Z',
      to_iso: '2024-01-02T00:00:00.000Z',
    });
  });

  it('returns null for absent or invalid timestamps', () => {
    assert.equal(unixSecondsToIso(null), null);
    assert.equal(unixSecondsToIso('not-a-timestamp'), null);
  });
});
