/** Fixed Strategy Symbol retry policy and manifest-driven attempt execution. */
import { CoreOperationError } from './errors.js';
import {
  sanitizeStrategyRunError,
  transitionSymbolState,
  validateExperimentManifest,
} from './strategy-run-state.js';

export const STRATEGY_SYMBOL_MAX_ATTEMPTS = 3;
export const STRATEGY_SYMBOL_RETRY_DELAYS_MS = Object.freeze([1000, 2000]);

const RETRY_SYMBOL_CODES = new Set([
  'SYMBOL_SWITCH_FAILED',
  'TIMEFRAME_SWITCH_FAILED',
  'STRATEGY_ACTIVATION_FAILED',
  'STRATEGY_REPORT_UNAVAILABLE',
  'STRATEGY_CALCULATION_TIMEOUT',
  'STRATEGY_SNAPSHOT_UNAVAILABLE',
  'STALE_STRATEGY_SNAPSHOT',
  'TRADING_DATA_INCOMPLETE',
  'RECONCILIATION_MISMATCH',
]);
const FAIL_SYMBOL_CODES = new Set([
  'SYMBOL_INVALID',
  'SYMBOL_REQUIRED',
]);

function interruptedError(signal) {
  const reason = signal?.reason;
  return new CoreOperationError(
    `Strategy Symbol execution was interrupted${reason ? `: ${reason.message || String(reason)}` : '.'}`,
    { code: 'RUN_INTERRUPTED', phase: 'signal', cause: reason instanceof Error ? reason : undefined },
  );
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw interruptedError(signal);
}

async function defaultDelay(milliseconds, { signal, _deps = {} } = {}) {
  assertNotAborted(signal);
  const setTimer = _deps.setTimeout || globalThis.setTimeout.bind(globalThis);
  const clearTimer = _deps.clearTimeout || globalThis.clearTimeout.bind(globalThis);
  await new Promise((resolveDelay, rejectDelay) => {
    let timer = null;
    const onAbort = () => {
      if (timer != null) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      rejectDelay(interruptedError(signal));
    };
    timer = setTimer(() => {
      signal?.removeEventListener('abort', onAbort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  assertNotAborted(signal);
}

export function classifyStrategySymbolError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (RETRY_SYMBOL_CODES.has(code)) return 'retry_symbol';
  if (FAIL_SYMBOL_CODES.has(code)) return 'fail_symbol';
  return 'abort_run';
}

export function strategySymbolSuccessDetails(result) {
  if (!result || typeof result !== 'object') {
    throw new CoreOperationError('Strategy Symbol attempt returned no result.', {
      code: 'STRATEGY_RUN_FAILED', phase: 'symbol_attempt_result',
    });
  }
  const artifacts = Object.fromEntries(
    ['report', 'trades', 'reconciliation'].map((name) => {
      const artifact = result.artifacts?.[name];
      const relativePath = typeof artifact === 'string' ? artifact : artifact?.relative_path;
      return [name, relativePath];
    }),
  );
  return Object.freeze({
    resolved_symbol: result.resolved_symbol,
    snapshot_id: result.snapshot_id,
    total_trades: result.total_trades,
    batch_count: result.batch_count,
    artifacts: Object.freeze(artifacts),
  });
}

function transitionPersistenceError(error) {
  const wrapped = new CoreOperationError(
    `Failed to persist Strategy Symbol state: ${error?.message || String(error)}`,
    {
      code: error?.code || 'OUTPUT_WRITE_FAILED',
      phase: error?.phase || 'manifest_transition',
      cause: error,
    },
  );
  wrapped.transition_persistence_failed = true;
  return wrapped;
}

/**
 * Execute one logical Symbol with a fresh fixed retry budget for this invocation.
 * The caller owns the Experiment loop; this function owns attempt cleanup,
 * staging commit ordering, and every Symbol manifest transition.
 */
export async function executeStrategySymbolWithRetry({
  manifest,
  index,
  symbol,
  signal,
  onTransition,
  cleanupAttempt,
  beginAttempt,
  executeAttempt,
  _deps = {},
} = {}) {
  let current = validateExperimentManifest(manifest);
  if (!Number.isInteger(index) || index < 0 || index >= current.requested_symbols.length) {
    throw new CoreOperationError('Strategy Symbol retry index is outside requested_symbols.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID', phase: 'symbol_attempt_validation',
    });
  }
  if (current.requested_symbols[index] !== symbol) {
    throw new CoreOperationError('Strategy Symbol retry identity differs from the manifest.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID', phase: 'symbol_attempt_validation', symbol,
    });
  }
  const existing = current.symbols.find((entry) => entry.index === index);
  if (existing?.status === 'succeeded') {
    throw new CoreOperationError('A succeeded Strategy Symbol must not be executed again.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID', phase: 'symbol_attempt_validation', symbol,
    });
  }
  for (const [name, callback] of Object.entries({
    onTransition, cleanupAttempt, beginAttempt, executeAttempt,
  })) {
    if (typeof callback !== 'function') {
      throw new TypeError(`${name} callback is required for Strategy Symbol retry execution.`);
    }
  }
  const now = _deps.now || Date.now;
  const delay = _deps.delay || ((milliseconds, options) => defaultDelay(
    milliseconds,
    { ...options, _deps },
  ));

  async function persist(next, event) {
    try {
      await onTransition(next, Object.freeze({ event, index, symbol }));
    } catch (error) {
      throw transitionPersistenceError(error);
    }
    current = next;
  }

  for (let localAttempt = 1; localAttempt <= STRATEGY_SYMBOL_MAX_ATTEMPTS; localAttempt += 1) {
    assertNotAborted(signal);
    const currentEntry = current.symbols.find((entry) => entry.index === index) || null;
    await cleanupAttempt(Object.freeze({
      manifest: current,
      entry: currentEntry,
      index,
      symbol,
      local_attempt: localAttempt,
    }));
    assertNotAborted(signal);

    const running = transitionSymbolState(current, {
      index,
      status: 'running',
      updated_at: now(),
    });
    await persist(running, 'attempt_started');
    const runningEntry = current.symbols.find((entry) => entry.index === index);
    const attemptCount = runningEntry.attempt_count;
    let attempt = null;
    let committed = false;
    let result = null;
    try {
      attempt = await beginAttempt(Object.freeze({
        manifest: current,
        entry: runningEntry,
        index,
        symbol,
        local_attempt: localAttempt,
        attempt_count: attemptCount,
      }));
      if (!attempt || typeof attempt.commit !== 'function' || typeof attempt.abort !== 'function') {
        throw new TypeError('beginAttempt must return commit() and abort() methods.');
      }
      assertNotAborted(signal);
      result = await executeAttempt(Object.freeze({
        manifest: current,
        entry: runningEntry,
        index,
        symbol,
        local_attempt: localAttempt,
        attempt_count: attemptCount,
        attempt,
        signal,
      }));
      assertNotAborted(signal);
      await attempt.commit();
      committed = true;
      const succeeded = transitionSymbolState(current, {
        index,
        status: 'succeeded',
        updated_at: now(),
        details: strategySymbolSuccessDetails(result),
      });
      await persist(succeeded, 'attempt_succeeded');
      return Object.freeze({
        success: true,
        status: 'succeeded',
        manifest: current,
        result,
        local_attempts: localAttempt,
        attempt_count: attemptCount,
      });
    } catch (caught) {
      let error = caught;
      if (!committed && attempt && typeof attempt.abort === 'function') {
        try {
          await attempt.abort();
        } catch (abortError) {
          error = new CoreOperationError(
            `Strategy Symbol attempt cleanup failed: ${abortError?.message || String(abortError)}`,
            {
              code: abortError?.code || 'OUTPUT_WRITE_FAILED',
              phase: abortError?.phase || 'artifact_abort',
              symbol,
              cause: error,
            },
          );
        }
      }
      if (error?.transition_persistence_failed === true) throw error;
      const action = classifyStrategySymbolError(error);
      const hasBudget = localAttempt < STRATEGY_SYMBOL_MAX_ATTEMPTS;
      if (action === 'retry_symbol' && hasBudget) {
        const retryWait = transitionSymbolState(current, {
          index,
          status: 'retry_wait',
          updated_at: now(),
          error,
        });
        await persist(retryWait, 'attempt_retry_wait');
        await delay(STRATEGY_SYMBOL_RETRY_DELAYS_MS[localAttempt - 1], {
          signal,
          local_attempt: localAttempt,
          attempt_count: attemptCount,
        });
        assertNotAborted(signal);
        continue;
      }

      const failed = transitionSymbolState(current, {
        index,
        status: 'failed',
        updated_at: now(),
        error,
      });
      await persist(failed, 'attempt_failed');
      if (action === 'abort_run') throw error;
      return Object.freeze({
        success: false,
        status: 'failed',
        action,
        manifest: current,
        error: sanitizeStrategyRunError(error),
        local_attempts: localAttempt,
        attempt_count: attemptCount,
      });
    }
  }
  throw new Error('Unreachable Strategy Symbol retry state.');
}
