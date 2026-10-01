import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CoreOperationError } from '../src/core/errors.js';
import {
  STRATEGY_SYMBOL_MAX_ATTEMPTS,
  STRATEGY_SYMBOL_RETRY_DELAYS_MS,
  classifyStrategySymbolError,
  executeStrategySymbolWithRetry,
} from '../src/core/strategy-run-retry.js';
import { STRATEGY_RUN_ARTIFACT_VERSION } from '../src/core/strategy-run-state.js';

function hash(character) {
  return `sha256:${character.repeat(64)}`;
}

function manifestArtifact({ status = 'running', symbols = [] } = {}) {
  const summary = {
    requested: 1,
    pending: symbols.length === 0 ? 1 : 0,
    running: symbols.filter((entry) => entry.status === 'running').length,
    retry_wait: symbols.filter((entry) => entry.status === 'retry_wait').length,
    succeeded: symbols.filter((entry) => entry.status === 'succeeded').length,
    failed: symbols.filter((entry) => entry.status === 'failed').length,
    skipped: symbols.filter((entry) => entry.status === 'skipped').length,
  };
  return {
    schema_version: STRATEGY_RUN_ARTIFACT_VERSION,
    run_id: 'run-1',
    experiment_id: hash('a'),
    parameter_set_name: 'baseline',
    status,
    strategy: { script_id: 'USER;test', version: '1.0' },
    inputs_fingerprint: { available: true, value: 'inputs' },
    watchlist: {
      snapshot_id: hash('f'),
      ordered_symbol_fingerprint: hash('e'),
      symbol_count: 1,
    },
    requested_symbols: ['TWSE:2330'],
    timeframe: '1D',
    format: 'csv',
    started_at: 1000,
    started_at_iso: '1970-01-01T00:00:01.000Z',
    updated_at: symbols.at(-1)?.updated_at || 1000,
    updated_at_iso: symbols.at(-1)?.updated_at_iso || '1970-01-01T00:00:01.000Z',
    summary,
    symbols,
  };
}

function successResult(attemptCount) {
  return {
    resolved_symbol: 'TWSE_DLY:2330',
    snapshot_id: hash(String(attemptCount)),
    total_trades: 0,
    batch_count: 1,
    artifacts: {
      report: 'experiments/baseline/symbols/TWSE_u3A_2330/report.json',
      trades: 'experiments/baseline/symbols/TWSE_u3A_2330/trades.csv',
      reconciliation: 'experiments/baseline/symbols/TWSE_u3A_2330/reconciliation.json',
    },
  };
}

function retryError(code = 'SYMBOL_SWITCH_FAILED') {
  return new CoreOperationError(`failure: ${code}`, {
    code,
    phase: 'test_attempt',
    retryable: false,
  });
}

function harness({ manifest = manifestArtifact(), outcomes = [] } = {}) {
  let clock = Math.max(1000, manifest.updated_at);
  let current = manifest;
  const calls = {
    transitions: [],
    cleanup: [],
    begin: [],
    execute: [],
    commit: [],
    abort: [],
    delays: [],
  };
  const attempts = [];
  const callbacks = {
    manifest: current,
    index: 0,
    symbol: 'TWSE:2330',
    onTransition: async (next, metadata) => {
      current = next;
      callbacks.manifest = next;
      calls.transitions.push({
        event: metadata.event,
        status: next.symbols[0].status,
        attempt_count: next.symbols[0].attempt_count,
      });
    },
    cleanupAttempt: async ({ local_attempt: localAttempt }) => {
      calls.cleanup.push(localAttempt);
    },
    beginAttempt: async ({ local_attempt: localAttempt, attempt_count: attemptCount }) => {
      calls.begin.push({ localAttempt, attemptCount });
      let state = 'open';
      const attempt = {
        state: () => state,
        async commit() {
          calls.commit.push(localAttempt);
          state = 'committed';
        },
        async abort() {
          calls.abort.push(localAttempt);
          if (state !== 'committed') state = 'aborted';
        },
      };
      attempts.push(attempt);
      return attempt;
    },
    executeAttempt: async ({ local_attempt: localAttempt, attempt_count: attemptCount }) => {
      calls.execute.push({ localAttempt, attemptCount });
      const outcome = outcomes[localAttempt - 1];
      if (outcome instanceof Error) throw outcome;
      return outcome || successResult(attemptCount);
    },
    _deps: {
      now: () => ++clock,
      delay: async (milliseconds) => { calls.delays.push(milliseconds); },
    },
  };
  return { callbacks, calls, attempts, current: () => current };
}

describe('Strategy Symbol retry classifier', () => {
  it('uses the fixed stable-code table and ignores retryable booleans', () => {
    const retryCodes = [
      'SYMBOL_SWITCH_FAILED',
      'TIMEFRAME_SWITCH_FAILED',
      'STRATEGY_ACTIVATION_FAILED',
      'STRATEGY_REPORT_UNAVAILABLE',
      'STRATEGY_CALCULATION_TIMEOUT',
      'STRATEGY_SNAPSHOT_UNAVAILABLE',
      'STALE_STRATEGY_SNAPSHOT',
      'TRADING_DATA_INCOMPLETE',
      'RECONCILIATION_MISMATCH',
    ];
    for (const code of retryCodes) {
      assert.equal(classifyStrategySymbolError({ code, retryable: false }), 'retry_symbol');
    }
    for (const code of ['SYMBOL_INVALID', 'SYMBOL_REQUIRED']) {
      assert.equal(classifyStrategySymbolError({ code, retryable: true }), 'fail_symbol');
    }
    for (const code of [
      'CDP_TIMEOUT',
      'CDP_CONNECTION_FAILED',
      'PANE_CONTEXT_CHANGED',
      'STRATEGY_INPUTS_CHANGED',
      'CHART_RESTORE_FAILED',
      'PARAMETER_SET_RESTORE_FAILED',
      'RUNTIME_INPUT_CATALOG_CHANGED',
      'OUTPUT_WRITE_FAILED',
      'UNKNOWN_FAILURE',
    ]) {
      assert.equal(classifyStrategySymbolError({ code, retryable: true }), 'abort_run');
    }
    assert.equal(classifyStrategySymbolError({ retryable: true }), 'abort_run');
  });

  it('exports an immutable fixed production policy', () => {
    assert.equal(STRATEGY_SYMBOL_MAX_ATTEMPTS, 3);
    assert.deepEqual(STRATEGY_SYMBOL_RETRY_DELAYS_MS, [1000, 2000]);
    assert.equal(Object.isFrozen(STRATEGY_SYMBOL_RETRY_DELAYS_MS), true);
  });
});

describe('Strategy Symbol retry executor', () => {
  it('commits success on the first attempt before the manifest success callback', async () => {
    const runtime = harness();
    const result = await executeStrategySymbolWithRetry(runtime.callbacks);
    assert.equal(result.success, true);
    assert.equal(result.local_attempts, 1);
    assert.deepEqual(runtime.calls.commit, [1]);
    assert.deepEqual(runtime.calls.transitions, [
      { event: 'attempt_started', status: 'running', attempt_count: 1 },
      { event: 'attempt_succeeded', status: 'succeeded', attempt_count: 1 },
    ]);
    assert.equal(result.manifest.symbols[0].attempt_count, 1);
    assert.equal('retryable' in result.manifest.symbols[0], false);
  });

  it('retries the complete attempt and succeeds on attempts two and three', async () => {
    for (const successAttempt of [2, 3]) {
      const outcomes = Array.from({ length: successAttempt }, (_item, index) => (
        index + 1 === successAttempt ? null : retryError()
      ));
      const runtime = harness({ outcomes });
      const result = await executeStrategySymbolWithRetry(runtime.callbacks);
      assert.equal(result.success, true);
      assert.equal(result.local_attempts, successAttempt);
      assert.deepEqual(
        runtime.calls.execute.map((item) => item.localAttempt),
        Array.from({ length: successAttempt }, (_item, index) => index + 1),
      );
      assert.deepEqual(
        runtime.calls.delays,
        STRATEGY_SYMBOL_RETRY_DELAYS_MS.slice(0, successAttempt - 1),
      );
      assert.deepEqual(runtime.calls.abort, Array.from(
        { length: successAttempt - 1 },
        (_item, index) => index + 1,
      ));
    }
  });

  it('marks retry exhaustion failed and returns so the caller can continue', async () => {
    const runtime = harness({ outcomes: [retryError(), retryError(), retryError()] });
    const result = await executeStrategySymbolWithRetry(runtime.callbacks);
    assert.equal(result.success, false);
    assert.equal(result.action, 'retry_symbol');
    assert.equal(result.local_attempts, 3);
    assert.equal(result.attempt_count, 3);
    assert.deepEqual(runtime.calls.delays, [1000, 2000]);
    assert.equal(result.manifest.symbols[0].status, 'failed');
    assert.equal('retryable' in result.manifest.symbols[0].error, false);
    assert.equal('retry_exhausted' in result.manifest.symbols[0], false);
    assert.deepEqual(result.error, {
      code: 'SYMBOL_SWITCH_FAILED',
      phase: 'test_attempt',
      message: 'failure: SYMBOL_SWITCH_FAILED',
    });
  });

  it('gives a failed Symbol a fresh budget while keeping cumulative attempt_count', async () => {
    const exhausted = harness({ outcomes: [retryError(), retryError(), retryError()] });
    const failed = await executeStrategySymbolWithRetry(exhausted.callbacks);
    const resumed = harness({
      manifest: failed.manifest,
      outcomes: [retryError(), retryError(), null],
    });
    const result = await executeStrategySymbolWithRetry(resumed.callbacks);
    assert.equal(result.success, true);
    assert.equal(result.local_attempts, 3);
    assert.equal(result.attempt_count, 6);
    assert.deepEqual(resumed.calls.begin.map((item) => item.attemptCount), [4, 5, 6]);
  });

  it('fails a non-retryable Symbol immediately without sleeping', async () => {
    const runtime = harness({ outcomes: [retryError('SYMBOL_INVALID')] });
    const result = await executeStrategySymbolWithRetry(runtime.callbacks);
    assert.equal(result.success, false);
    assert.equal(result.action, 'fail_symbol');
    assert.equal(result.local_attempts, 1);
    assert.deepEqual(runtime.calls.delays, []);
  });

  it('persists the current failure and aborts the invocation for CDP errors', async () => {
    const runtime = harness({ outcomes: [retryError('CDP_CONNECTION_FAILED')] });
    await assert.rejects(
      executeStrategySymbolWithRetry(runtime.callbacks),
      (error) => error.code === 'CDP_CONNECTION_FAILED',
    );
    assert.deepEqual(runtime.calls.transitions.map((item) => item.status), ['running', 'failed']);
    assert.deepEqual(runtime.calls.execute, [{ localAttempt: 1, attemptCount: 1 }]);
  });

  it('does not create an attempt when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const runtime = harness();
    runtime.callbacks.signal = controller.signal;
    await assert.rejects(
      executeStrategySymbolWithRetry(runtime.callbacks),
      (error) => error.code === 'RUN_INTERRUPTED',
    );
    assert.deepEqual(runtime.calls.cleanup, []);
    assert.deepEqual(runtime.calls.transitions, []);
  });

  it('stops in retry_wait when interrupted during backoff', async () => {
    const controller = new AbortController();
    const runtime = harness({ outcomes: [retryError()] });
    runtime.callbacks.signal = controller.signal;
    runtime.callbacks._deps.delay = async () => {
      controller.abort(new Error('stop during delay'));
      throw new CoreOperationError('interrupted', { code: 'RUN_INTERRUPTED', phase: 'signal' });
    };
    await assert.rejects(
      executeStrategySymbolWithRetry(runtime.callbacks),
      (error) => error.code === 'RUN_INTERRUPTED',
    );
    assert.equal(runtime.current().symbols[0].status, 'retry_wait');
    assert.equal(runtime.calls.execute.length, 1);
  });

  it('cancels the built-in backoff timer through AbortSignal', async () => {
    const controller = new AbortController();
    const runtime = harness({ outcomes: [retryError()] });
    runtime.callbacks.signal = controller.signal;
    delete runtime.callbacks._deps.delay;
    let notifyScheduled;
    const scheduled = new Promise((resolveScheduled) => { notifyScheduled = resolveScheduled; });
    let cleared = 0;
    runtime.callbacks._deps.setTimeout = (_callback, milliseconds) => {
      notifyScheduled(milliseconds);
      return { timer: true };
    };
    runtime.callbacks._deps.clearTimeout = () => { cleared += 1; };
    const execution = executeStrategySymbolWithRetry(runtime.callbacks);
    assert.equal(await scheduled, 1000);
    controller.abort(new Error('cancel default delay'));
    await assert.rejects(execution, (error) => error.code === 'RUN_INTERRUPTED');
    assert.equal(cleared, 1);
    assert.equal(runtime.current().symbols[0].status, 'retry_wait');
  });

  it('never reports success when the post-rename manifest callback fails', async () => {
    const runtime = harness();
    const originalTransition = runtime.callbacks.onTransition;
    runtime.callbacks.onTransition = async (next, metadata) => {
      if (metadata.event === 'attempt_succeeded') {
        throw new CoreOperationError('manifest disk full', {
          code: 'OUTPUT_WRITE_FAILED', phase: 'manifest_transition',
        });
      }
      return originalTransition(next, metadata);
    };
    await assert.rejects(
      executeStrategySymbolWithRetry(runtime.callbacks),
      (error) => error.code === 'OUTPUT_WRITE_FAILED'
        && error.transition_persistence_failed === true,
    );
    assert.deepEqual(runtime.calls.commit, [1]);
    assert.equal(runtime.attempts[0].state(), 'committed');
    assert.equal(runtime.current().symbols[0].status, 'running');
  });

  it('treats attempt cleanup failure as a fatal artifact error', async () => {
    const runtime = harness({ outcomes: [retryError()] });
    runtime.callbacks.beginAttempt = async ({ local_attempt: localAttempt }) => ({
      async commit() { runtime.calls.commit.push(localAttempt); },
      async abort() {
        throw new CoreOperationError('cannot remove staging', {
          code: 'OUTPUT_WRITE_FAILED', phase: 'artifact_abort',
        });
      },
    });
    await assert.rejects(
      executeStrategySymbolWithRetry(runtime.callbacks),
      (error) => error.code === 'OUTPUT_WRITE_FAILED',
    );
    assert.equal(runtime.current().symbols[0].status, 'failed');
  });
});
