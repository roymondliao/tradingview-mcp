/** Shared formal durable lifecycle for standalone and Extension Strategy Runs. */
import { CoreOperationError } from './errors.js';
import { withChartSession } from './chart-session.js';
import { createDurableRunStore } from './strategy-run-artifacts.js';
import { acquireStrategyRunPaneLeases } from './strategy-run-lease.js';
import { validateNamedWatchlistSymbols } from './watchlist.js';
import {
  durableStrategyRunResponse,
  executeDurableStrategyPlan,
  finalizeDurableStrategyRun,
} from './strategy-resume.js';
import { emitStrategyAutomationStatus } from './strategy-progress.js';

function interruptedError(signal) {
  const reason = signal?.reason;
  const error = new CoreOperationError(
    `Strategy automation was interrupted${reason ? `: ${reason.message || String(reason)}` : '.'}`,
    { code: 'RUN_INTERRUPTED', phase: 'signal', cause: reason instanceof Error ? reason : undefined },
  );
  if (Number.isInteger(reason?.exit_code)) error.exit_code = reason.exit_code;
  if (reason?.signal) error.signal = reason.signal;
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw interruptedError(signal);
}

function executionFailure(error, context) {
  if (error instanceof CoreOperationError) return error;
  return new CoreOperationError(`Strategy Run failed: ${error?.message || String(error)}`, {
    code: error?.code || 'STRATEGY_RUN_FAILED',
    phase: error?.phase || 'strategy_run_execution',
    retryable: error?.retryable === true,
    context,
    cause: error,
  });
}

/**
 * Execute an already planned durable Run. Caller adapters own domain-specific
 * preflight; this service owns leases, child store, session, execution, restore,
 * finalization, and the bounded response.
 */
export async function executePreparedDurableRun({
  spec,
  signal,
  on_progress,
  on_status,
  _deps = {},
} = {}) {
  if (!spec?.run || !spec?.output_directory || !spec?.context || !spec?.frozen_watchlist) {
    throw new TypeError('A complete DurableRunExecutionSpec is required.');
  }
  if (typeof spec.prepare_execution !== 'function') {
    throw new TypeError('DurableRunExecutionSpec.prepare_execution is required.');
  }
  await emitStrategyAutomationStatus(on_status, 'acquiring_ownership');
  assertNotAborted(signal);
  const acquireLeases = _deps.acquireLeases || acquireStrategyRunPaneLeases;
  const leases = await acquireLeases({
    run_directory: spec.run.requested.output.run_path,
    pane: spec.context,
    run_id: spec.run.run_id,
    _deps: _deps.leases,
  });
  const now = _deps.now || Date.now;
  let run = spec.run;
  let frozenWatchlist = spec.frozen_watchlist;
  let store = null;
  let initialized = false;
  let primaryError = null;
  let runtimeStrategy = run.resolved?.strategy || null;
  try {
    assertNotAborted(signal);
    if (typeof spec.prepare_creation === 'function') {
      const rechecked = await spec.prepare_creation({ run, frozen_watchlist: frozenWatchlist });
      run = rechecked?.run || run;
      frozenWatchlist = rechecked?.frozen_watchlist || frozenWatchlist;
    }
    await emitStrategyAutomationStatus(on_status, 'initializing_run');
    const createStore = _deps.createDurableRunStore || createDurableRunStore;
    store = await createStore({
      output_directory: spec.output_directory,
      run_id: run.run_id,
      _deps: _deps.artifacts,
    });
    await store.writeInitialWatchlist(frozenWatchlist);
    await store.replaceRun(run);
    initialized = true;

    const runWithSession = _deps.withChartSession || withChartSession;
    await runWithSession({
      context: spec.context,
      capture_chart_state: false,
      _deps: _deps.session,
    }, async () => {
      const alreadyLockedSession = async (_options, operation) => operation();
      assertNotAborted(signal);
      await emitStrategyAutomationStatus(on_status, 'validating_watchlist');
      const validateWatchlist = _deps.validateNamedWatchlistSymbols
        || validateNamedWatchlistSymbols;
      const symbolValidation = await validateWatchlist({
        snapshot: frozenWatchlist,
        context: spec.context,
        timeframe: run.requested.backtest.timeframe,
        restore_chart: false,
        signal,
        _deps: _deps.watchlist_validation,
      });
      const validatedWatchlist = Object.freeze({
        ...frozenWatchlist,
        symbol_validation: symbolValidation,
      });
      await store.replaceWatchlist(validatedWatchlist);
      if (!symbolValidation.success) {
        throw new CoreOperationError(
          `Watchlist Symbol validation failed for ${symbolValidation.failed} of ${symbolValidation.requested} Symbols.`,
          {
            code: 'WATCHLIST_SYMBOL_VALIDATION_FAILED',
            phase: 'watchlist_symbol_validation',
            context: spec.context,
          },
        );
      }
      assertNotAborted(signal);
      const execution = await spec.prepare_execution({
        run,
        store,
        context: spec.context,
        already_locked_session: alreadyLockedSession,
        now,
        signal,
        on_status,
      });
      run = execution.run || run;
      runtimeStrategy = execution.strategy || runtimeStrategy;
      assertNotAborted(signal);
      await emitStrategyAutomationStatus(on_status, 'executing_experiments');
      await executeDurableStrategyPlan({
        store,
        run,
        watchlist: validatedWatchlist,
        prepared: execution.prepared,
        identity: runtimeStrategy,
        context: spec.context,
        selected_experiments: execution.selected_experiments,
        on_progress,
        signal,
        timeout_ms: _deps.timeout_ms,
        _deps: {
          now,
          ..._deps.execution,
          parameter_sets: {
            ..._deps.execution?.parameter_sets,
            withChartSession: alreadyLockedSession,
          },
        },
      });
    });
    assertNotAborted(signal);
  } catch (error) {
    primaryError = executionFailure(error, spec.context);
  }

  let response = null;
  let completionError = null;
  try {
    if (!initialized) {
      if (primaryError) throw primaryError;
      throw new CoreOperationError('Strategy Run did not initialize durable output.', {
        code: 'STRATEGY_RUN_FAILED', phase: 'strategy_run_initialization',
      });
    }
    await emitStrategyAutomationStatus(on_status, 'finalizing_run');
    const finalized = await finalizeDurableStrategyRun({
      store,
      error: primaryError,
      _deps: { now, ..._deps.finalize },
    });
    const baseResponse = await durableStrategyRunResponse({
      finalized,
      store,
      context: spec.context,
      strategy: runtimeStrategy,
      resumed: false,
      signal,
    });
    response = Object.freeze({ ...baseResponse, ...(spec.response_fields || {}) });
  } catch (error) {
    completionError = error;
  }
  try {
    await leases.release();
  } catch (error) {
    if (!completionError) completionError = error;
  }
  if (completionError) throw completionError;
  return response;
}
