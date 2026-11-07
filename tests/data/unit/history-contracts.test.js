import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHistoryTool } from '../../../src/tools/data.js';
import { getHistory } from '../../../src/core/data.js';
import { runHistoryCommand } from '../../../src/cli/commands/data.js';
import { historyError } from '../../../src/core/history-errors.js';
import { CoreOperationError, toCoreDiagnostic } from '../../../src/core/errors.js';
import { normalizePresentationError } from '../../../src/core/error-policy.js';
import { desktopFixture } from '../support/history-runtime.js';

const withContext = async (_args, operation) => operation();

test('CLI diagnostic and MCP preserve the same typed timeout code and retryability', async () => {
  const error = historyError('HISTORY_LOAD_TIMEOUT', 'Data has not loaded to the requested range.', {
    retryable: true, stage: 'load_timeout', timeout_ms: 10000,
  });
  const mcp = await runHistoryTool({}, { withContext, getHistory: async () => { throw error; } });
  assert.equal(mcp.isError, true);
  const payload = JSON.parse(mcp.content[0].text);
  const cli = toCoreDiagnostic(normalizePresentationError(error, { phase: error.phase }));
  for (const key of ['code', 'kind', 'phase', 'stage', 'retryable', 'timeout_ms']) assert.equal(payload[key], cli[key]);
  assert.equal(payload.success, false); assert.equal(payload.error, error.message);
});

test('MCP returns incomplete success unchanged rather than converting it to an error', async () => {
  const result = { success: true, complete: false, stop_reason: 'load_timeout', bar_count: 2 };
  const response = await runHistoryTool({}, { withContext, getHistory: async () => result });
  assert.deepEqual(JSON.parse(response.content[0].text), result); assert.equal(response.isError, undefined);
});

test('CLI never writes output if restoration fails', async () => {
  const f = desktopFixture(); f.state.end = true; f.state.endType = 'end';
  f.chart.setSymbol = symbol => { if (symbol === 'TEST:A') throw Error('restore'); f.state.symbol = symbol; };
  let writes = 0;
  await assert.rejects(runHistoryCommand({ symbol: 'TEST:B', output: 'unused.json' }, {
    withContext, getHistory: options => getHistory({ ...options, _deps: { runtime: f.runtime } }),
    writeOutput: () => { writes++; },
  }), { code: 'HISTORY_RESTORE_FAILED' });
  assert.equal(writes, 0); assert.equal(f.listeners(), 0);
});

test('infrastructure exceptions retain their classification and still clean the observer', async () => {
  const f = desktopFixture(); const expected = new CoreOperationError('connection lost', {
    code: 'CDP_CONNECTION_FAILED', kind: 'cdp', retryable: true,
  });
  f.runtime.readSnapshot = async () => { throw expected; };
  await assert.rejects(getHistory({ _deps: { runtime: f.runtime } }), error => error === expected);
  assert.equal(f.listeners(), 0);
});

test('history lock serializes concurrent calls and releases after failure', async () => {
  const a = desktopFixture(), b = desktopFixture();
  let release; const gate = new Promise(resolve => { release = resolve; });
  let started; const ready = new Promise(resolve => { started = resolve; });
  a.runtime.readSnapshot = async () => { started(); await gate; throw Error('first failed'); };
  let secondReads = 0; const readB = b.runtime.readSnapshot;
  b.runtime.readSnapshot = async (...args) => { secondReads++; return readB(...args); };
  b.state.end = true; b.state.endType = 'end';
  const first = getHistory({ _deps: { runtime: a.runtime } });
  const rejected = assert.rejects(first, /first failed/);
  await ready;
  const second = getHistory({ _deps: { runtime: b.runtime } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(secondReads, 0);
  release(); await rejected; assert.equal((await second).complete, true);
  assert.equal(a.listeners(), 0); assert.equal(b.listeners(), 0);
});

test('same-process runtime never polls after overall deadline', async () => {
  const f = desktopFixture({ policy: { historyTimeoutMs: 25 } });
  const read = f.runtime.readSnapshot; let calls = 0;
  f.runtime.readSnapshot = async (...args) => { calls++; return read(...args); };
  const result = await getHistory({ _deps: { runtime: f.runtime } });
  assert.equal(result.stop_reason, 'history_timeout'); assert.ok(calls > 0);
  assert.equal(f.runtime.now(), 25);
});
