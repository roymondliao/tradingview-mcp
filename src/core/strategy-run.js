/** Strategy automation read-only preflight and durable formal Run orchestration. */
import { loadStrategyRunConfig } from './strategy-run-config.js';
import { check as checkPine } from './pine.js';
import {
  readResolvedSavedStrategy,
  readTargetPaneStudies,
  resolveLayoutTarget,
  resolvePaneStrategyInstances,
  resolveSavedStrategy,
} from './strategy-run-resolver.js';
import {
  captureNamedWatchlistSnapshot,
  pendingWatchlistSymbolValidation,
  summarizeNamedWatchlistSnapshot,
  validateNamedWatchlistSymbols,
} from './watchlist.js';
import {
  compareInputSchemas,
  planParameterSets,
  prepareParameterSetExecution,
} from './strategy-parameter-sets.js';
import { planStrategySync } from './strategy-sync.js';
import { executeStrategySync } from './strategy-sync.js';
import { withChartSession } from './chart-session.js';
import { CoreOperationError } from './errors.js';
import { unixMillisecondsToIso } from './time.js';
import { reconnectTo } from '../connection.js';
import { assertPaneContext } from './pane.js';
import { createDurableRunStore } from './strategy-run-artifacts.js';
import { acquireStrategyRunPaneLeases } from './strategy-run-lease.js';
import {
  strategyRunArtifactVersionFields,
  transitionRunState,
} from './strategy-run-state.js';
import {
  durableStrategyRunResponse,
  executeDurableStrategyPlan,
  finalizeDurableStrategyRun,
} from './strategy-resume.js';
import { durableStrategyTargetContext } from './strategy-durable-experiment.js';
import { emitStrategyAutomationStatus } from './strategy-progress.js';

function diagnostic(error, fallbackCode, phase) {
  return Object.freeze({
    code: error?.code || fallbackCode,
    message: String(error?.message || error || fallbackCode).slice(0, 1000),
    phase: error?.phase || phase,
    retryable: error?.retryable === true,
    ...(error?.path && { path: error.path }),
    ...(error?.layout_name && { layout_name: error.layout_name }),
    ...(error?.pane_index != null && { pane_index: error.pane_index }),
    ...(error?.match_count != null && { match_count: error.match_count }),
  });
}

function blocked(stage, reason) {
  return Object.freeze({ stage, reason });
}

function compilerDiagnostics(result) {
  if (!result?.compiled) {
    return [Object.freeze({
      code: 'PINE_COMPILE_FAILED',
      message: 'Local Pine source did not compile.',
      phase: 'candidate_compile',
      retryable: false,
      diagnostics: result?.errors || [],
    })];
  }
  if (!result?.input_schema?.available) {
    return (result?.input_schema?.errors || []).map((error) => Object.freeze({
      ...error, phase: 'candidate_schema', retryable: false,
    }));
  }
  return [];
}

/** Resolve and validate one complete run without any TradingView or filesystem mutation. */
export async function dryRunStrategyAutomation({ config_path, _include_internal = false, _deps = {} } = {}) {
  const errors = [];
  const warnings = [];
  const blockedStages = [];
  const loadConfig = _deps.loadStrategyRunConfig || loadStrategyRunConfig;
  const loaded = await loadConfig({ config_path, _deps: _deps.config });
  errors.push(...(loaded.errors || []));
  warnings.push(...(loaded.warnings || []));
  const requested = loaded.requested;
  if (!requested) {
    return {
      success: false,
      valid: false,
      dry_run: true,
      config: { path: loaded.config_path || null, sha256: loaded.config_sha256 || null },
      resources: {},
      strategy_sync: null,
      input_schema_changes: { available: false, reason: 'config_invalid' },
      parameter_sets: [],
      watchlist: null,
      symbol_validation: { performed: false, reason: 'formal_run_only' },
      blocked: [blocked('all_resolution', 'Run Config root is invalid.')],
      warnings,
      errors,
    };
  }

  const runCheckPine = _deps.checkPine || checkPine;
  let candidate = null;
  if (loaded.pine_source != null) {
    try {
      candidate = await runCheckPine({ source: loaded.pine_source });
      errors.push(...compilerDiagnostics(candidate));
      for (const warning of candidate?.warnings || []) {
        warnings.push(Object.freeze({ ...warning, code: 'PINE_COMPILE_WARNING', phase: 'candidate_compile' }));
      }
    } catch (error) {
      errors.push(diagnostic(error, 'PINE_COMPILE_UNAVAILABLE', 'candidate_compile'));
    }
  } else {
    blockedStages.push(blocked('candidate_compile', 'Local Pine source is unavailable.'));
  }

  let target = null;
  if (requested.target.layout.name && Number.isInteger(requested.target.pane_index)) {
    try {
      const resolveLayout = _deps.resolveLayoutTarget || resolveLayoutTarget;
      target = await resolveLayout({
        layout_name: requested.target.layout.name,
        pane_index: requested.target.pane_index,
        _deps: _deps.layout,
      });
      // Bind this process-local CDP client to the resolved renderer. This does
      // not activate or visually switch the Desktop Tab; it makes subsequent
      // same-origin Account API reads deterministic instead of active-tab based.
      const attachTarget = _deps.attachTarget || reconnectTo;
      await attachTarget(target.target_id);
    } catch (error) {
      errors.push(diagnostic(error, 'TARGET_LAYOUT_RESOLUTION_FAILED', 'resource_resolution'));
    }
  } else {
    blockedStages.push(blocked('layout_resolution', 'Layout name or Pane index is invalid.'));
  }

  let watchlist = null;
  let watchlistComplete = null;
  if (requested.target.watchlist.name) {
    try {
      const captureWatchlist = _deps.captureNamedWatchlistSnapshot || captureNamedWatchlistSnapshot;
      const complete = await captureWatchlist({
        name: requested.target.watchlist.name,
        _deps: _deps.watchlist,
      });
      watchlistComplete = complete;
      watchlist = summarizeNamedWatchlistSnapshot(complete, { sample_size: 3 });
    } catch (error) {
      errors.push(diagnostic(error, 'WATCHLIST_RESOLUTION_FAILED', 'watchlist_snapshot'));
    }
  } else {
    blockedStages.push(blocked('watchlist_snapshot', 'Watchlist name is invalid.'));
  }

  let accountResolution = null;
  let accountDetail = null;
  if (requested.strategy.saved_name) {
    try {
      const resolveAccount = _deps.resolveSavedStrategy || resolveSavedStrategy;
      accountResolution = await resolveAccount({
        saved_name: requested.strategy.saved_name,
        _deps: _deps.account,
      });
      if (accountResolution.exists) {
        const readAccount = _deps.readResolvedSavedStrategy || readResolvedSavedStrategy;
        accountDetail = await readAccount({ resolved_account: accountResolution, _deps: _deps.account });
      }
    } catch (error) {
      errors.push(diagnostic(error, 'STRATEGY_RESOLUTION_FAILED', 'resource_resolution'));
    }
  } else {
    blockedStages.push(blocked('strategy_resolution', 'Saved Strategy name is invalid.'));
  }

  let paneState = null;
  let paneInstances = null;
  if (target) {
    try {
      const readPane = _deps.readTargetPaneStudies || readTargetPaneStudies;
      paneState = await readPane({
        target_id: target.target_id,
        pane_index: target.pane_index,
        _deps: _deps.pane,
      });
      if (accountResolution?.exists) {
        paneInstances = resolvePaneStrategyInstances({
          pane_state: paneState,
          script_id: accountResolution.script.script_id,
        });
      } else if (accountResolution) {
        paneInstances = { match_count: 0, matches: [] };
      }
    } catch (error) {
      errors.push(diagnostic(error, 'PANE_STUDY_INVENTORY_UNAVAILABLE', 'resource_resolution'));
    }
  } else {
    blockedStages.push(blocked('pane_strategy_inventory', 'Target Layout and Pane are unresolved.'));
  }

  const sync = planStrategySync({
    local_source_sha256: requested.strategy.source_sha256,
    account: accountResolution ? {
      ...accountResolution,
      source_sha256: accountDetail?.source_sha256 || null,
    } : null,
    pane_instances: paneInstances,
  });
  errors.push(...(sync.errors || []));

  let currentSchema = null;
  if (accountDetail?.pine_source && candidate?.input_schema?.available) {
    if (sync.source_matches) {
      currentSchema = candidate.input_schema;
    } else {
      try {
        const currentCheck = await runCheckPine({ source: accountDetail.pine_source });
        currentSchema = currentCheck?.input_schema || null;
        if (!currentCheck?.compiled || !currentSchema?.available) {
          warnings.push(Object.freeze({
            code: 'CURRENT_PINE_INPUT_SCHEMA_UNAVAILABLE',
            message: 'Current Account source schema could not be compared with the local candidate.',
            phase: 'current_schema',
          }));
        }
      } catch (error) {
        warnings.push(diagnostic(error, 'CURRENT_PINE_INPUT_SCHEMA_UNAVAILABLE', 'current_schema'));
      }
    }
  }
  const schemaChanges = compareInputSchemas({
    current_schema: currentSchema,
    candidate_schema: candidate?.input_schema,
  });

  let parameterPlan = { valid: false, errors: [], parameter_sets: [] };
  if (candidate?.input_schema?.available) {
    const runtimeCatalog = sync.account_action === 'reuse'
      && sync.pane_action === 'reuse'
      && sync.pane_version_matches === true
      && paneInstances?.match_count === 1
      ? paneInstances.matches[0].inputs
      : undefined;
    parameterPlan = planParameterSets({
      base_catalog: runtimeCatalog,
      candidate_schema: candidate.input_schema,
      parameter_sets: requested.experiments.parameter_sets,
    });
    errors.push(...parameterPlan.errors);
    if (!runtimeCatalog) {
      blockedStages.push(blocked(
        'runtime_parameter_validation',
        'Runtime Input catalog depends on Account/Pane synchronization; Candidate validation is complete.',
      ));
    }
  } else {
    blockedStages.push(blocked('parameter_set_validation', 'Candidate Input Schema is unavailable.'));
  }

  const hasConnectionFailure = errors.some((error) => (
    String(error.code || '').startsWith('CDP_')
    || /CDP|ECONNREFUSED|not running/i.test(error.message || '')
  ));
  const valid = errors.length === 0;
  const response = {
    success: valid,
    valid,
    dry_run: true,
    ...(hasConnectionFailure && { failure_kind: 'cdp_connection' }),
    run: requested.run,
    config: {
      path: loaded.config_path,
      directory: loaded.config_directory,
      sha256: loaded.config_sha256,
      requested,
    },
    resources: {
      layout: target,
      account_strategy: accountResolution ? {
        saved_name: accountResolution.saved_name,
        match_count: accountResolution.match_count,
        exists: accountResolution.exists,
        script: accountResolution.script,
        source_sha256: accountDetail?.source_sha256 || null,
      } : null,
      pane_strategy: paneInstances ? {
        match_count: paneInstances.match_count,
        instances: paneInstances.matches.map(({ inputs, ...instance }) => ({
          ...instance,
          input_count: inputs?.length || 0,
        })),
      } : null,
      pane_study_count: paneState?.studies?.length ?? null,
    },
    strategy_sync: sync,
    watchlist,
    symbol_validation: { performed: false, reason: 'formal_run_only' },
    candidate_input_schema: candidate?.input_schema || null,
    input_schema_changes: schemaChanges,
    parameter_sets: parameterPlan.parameter_sets,
    blocked: blockedStages,
    warnings,
    errors,
  };
  if (!_include_internal) return response;
  return {
    ...response,
    _internal: Object.freeze({
      loaded,
      candidate,
      target,
      watchlist: watchlistComplete,
      account_resolution: accountResolution,
      account_detail: accountDetail,
      pane_state: paneState,
      pane_instances: paneInstances,
      current_schema: currentSchema,
    }),
  };
}

function publicPreflight(preflight) {
  const { _internal, ...response } = preflight;
  return response;
}

function initialRunArtifact({ internal, context, startedAt }) {
  const requested = internal.loaded.requested;
  const { schema_version: configSchemaVersion, ...requestedFields } = requested;
  const persistedRequested = {
    config_schema_version: configSchemaVersion,
    ...requestedFields,
  };
  const watchlist = internal.watchlist;
  return {
    ...strategyRunArtifactVersionFields('v3'),
    run_id: requested.run.run_id,
    status: 'running',
    requested: persistedRequested,
    config: {
      path: internal.loaded.config_path,
      sha256: internal.loaded.config_sha256,
    },
    source_sha256: requested.strategy.source_sha256,
    candidate_schema_fingerprint: internal.candidate.input_schema.input_schema_fingerprint,
    resolved: {
      target: durableStrategyTargetContext(context),
      watchlist: {
        name: watchlist.watchlist.name,
        snapshot_id: watchlist.snapshot.snapshot_id,
        ordered_symbol_fingerprint: watchlist.snapshot.ordered_symbol_fingerprint,
        symbol_count: watchlist.symbols.length,
      },
    },
    started_at: startedAt,
    started_at_iso: unixMillisecondsToIso(startedAt),
    updated_at: startedAt,
    updated_at_iso: unixMillisecondsToIso(startedAt),
    summary: {},
    experiments: [],
    error: null,
  };
}

function interruptedError(signal) {
  const reason = signal?.reason;
  const error = new CoreOperationError(
    `Strategy Run was interrupted${reason ? `: ${reason.message || String(reason)}` : '.'}`,
    { code: 'RUN_INTERRUPTED', phase: 'signal', cause: reason instanceof Error ? reason : undefined },
  );
  if (Number.isInteger(reason?.exit_code)) error.exit_code = reason.exit_code;
  return error;
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw interruptedError(signal);
}

/** Execute one complete durable Strategy automation Run in its canonical directory. */
export async function runStrategyAutomation({
  config_path,
  signal,
  on_progress,
  on_status,
  _deps = {},
} = {}) {
  await emitStrategyAutomationStatus(on_status, 'preflight');
  const runPreflight = _deps.dryRunStrategyAutomation || dryRunStrategyAutomation;
  const preflight = await runPreflight({
    config_path,
    _include_internal: true,
    _deps: _deps.preflight || _deps,
  });
  if (!preflight.valid || !preflight._internal) {
    return Object.freeze({
      ...publicPreflight(preflight),
      dry_run: false,
      phase: 'preflight',
    });
  }

  await emitStrategyAutomationStatus(on_status, 'acquiring_ownership');
  const internal = preflight._internal;
  const requested = internal.loaded.requested;
  const runContext = durableStrategyTargetContext(internal.target);
  const runWatchlist = Object.freeze({
    ...internal.watchlist,
    symbol_validation: pendingWatchlistSymbolValidation({
      timeframe: requested.backtest.timeframe,
    }),
  });
  assertNotAborted(signal);
  const acquireLeases = _deps.acquireLeases || acquireStrategyRunPaneLeases;
  const leases = await acquireLeases({
    run_directory: requested.output.run_path,
    pane: runContext,
    run_id: requested.run.run_id,
    _deps: _deps.leases,
  });
  const now = _deps.now || Date.now;
  const startedAt = now();
  let store = null;
  let initialized = false;
  let run = null;
  let primaryError = null;
  let strategyIdentity = null;
  try {
    assertNotAborted(signal);
    await emitStrategyAutomationStatus(on_status, 'initializing_run');
    const recheckPane = _deps.assertPaneContext || assertPaneContext;
    await recheckPane({
      context: runContext,
      symbol: null,
      timeframe: null,
      phase: 'strategy_run_precreate',
      _deps: _deps.pane,
    });
    const createStore = _deps.createDurableRunStore || createDurableRunStore;
    store = await createStore({
      output_directory: requested.output.directory_path,
      run_id: requested.run.run_id,
      _deps: _deps.artifacts,
    });
    run = initialRunArtifact({ internal, context: runContext, startedAt });
    await store.writeInitialWatchlist(runWatchlist);
    await store.replaceRun(run);
    initialized = true;

    const runWithSession = _deps.withChartSession || withChartSession;
    await runWithSession({
      context: runContext,
      capture_chart_state: false,
      _deps: _deps.session,
    }, async () => {
      const alreadyLockedSession = async (_options, operation) => operation();
      assertNotAborted(signal);
      await emitStrategyAutomationStatus(on_status, 'validating_watchlist');
      const validateWatchlist = _deps.validateNamedWatchlistSymbols
        || validateNamedWatchlistSymbols;
      const symbolValidation = await validateWatchlist({
        snapshot: runWatchlist,
        context: runContext,
        timeframe: requested.backtest.timeframe,
        restore_chart: false,
        signal,
        _deps: _deps.watchlist_validation,
      });
      const validatedWatchlist = Object.freeze({
        ...runWatchlist,
        symbol_validation: symbolValidation,
      });
      await store.replaceWatchlist(validatedWatchlist);
      if (!symbolValidation.success) {
        throw new CoreOperationError(
          `Watchlist Symbol validation failed for ${symbolValidation.failed} of ${symbolValidation.requested} Symbols.`,
          {
            code: 'WATCHLIST_SYMBOL_VALIDATION_FAILED',
            phase: 'watchlist_symbol_validation',
            context: runContext,
          },
        );
      }
      assertNotAborted(signal);
      await emitStrategyAutomationStatus(on_status, 'synchronizing_strategy');
      const runSync = _deps.executeStrategySync || executeStrategySync;
      const sync = await runSync({
        saved_name: requested.strategy.saved_name,
        source: internal.loaded.pine_source,
        source_sha256: requested.strategy.source_sha256,
        candidate_schema: internal.candidate.input_schema,
        current_schema: internal.current_schema,
        context: runContext,
        expected_plan: preflight.strategy_sync,
        timeout_ms: _deps.timeout_ms,
        _deps: { ..._deps.sync, withChartSession: alreadyLockedSession },
      });
      strategyIdentity = Object.freeze({
        script_id: sync.account.script_id,
        version: String(sync.account.version),
        source_sha256: sync.source_sha256,
        entity_id: sync.pane.entity_id,
      });
      run = transitionRunState(run, {
        status: 'running',
        updated_at: Math.max(run.updated_at, now()),
        patch: {
          resolved: { ...run.resolved, strategy: strategyIdentity },
        },
      });
      await store.replaceRun(run);

      await emitStrategyAutomationStatus(on_status, 'preparing_experiments');
      const prepare = _deps.prepareParameterSetExecution || prepareParameterSetExecution;
      const prepared = await prepare({
        candidate_schema: internal.candidate.input_schema,
        parameter_sets: requested.experiments.parameter_sets,
        identity: strategyIdentity,
        context: runContext,
        _deps: _deps.parameter_sets,
      });
      run = transitionRunState(run, {
        status: 'running',
        updated_at: Math.max(run.updated_at, now()),
        patch: {
          base_inputs: prepared.base_inputs,
          base_inputs_fingerprint: prepared.base_inputs_fingerprint,
          planned_experiments: prepared.planned_experiments,
        },
      });
      await store.replaceRun(run);
      assertNotAborted(signal);
      await emitStrategyAutomationStatus(on_status, 'executing_experiments');
      await executeDurableStrategyPlan({
        store,
        run,
        watchlist: validatedWatchlist,
        prepared,
        identity: strategyIdentity,
        context: runContext,
        on_progress,
        signal,
        timeout_ms: _deps.timeout_ms,
        _deps: { now, ..._deps.execution, parameter_sets: {
          ..._deps.execution?.parameter_sets,
          withChartSession: alreadyLockedSession,
        } },
      });
    });
    assertNotAborted(signal);
  } catch (error) {
    primaryError = error instanceof CoreOperationError ? error : new CoreOperationError(
      `Strategy Run failed: ${error?.message || String(error)}`,
      {
        code: error?.code || 'STRATEGY_RUN_FAILED',
        phase: error?.phase || 'strategy_run_execution',
        retryable: error?.retryable === true,
        context: runContext,
        cause: error,
      },
    );
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
    response = await durableStrategyRunResponse({
      finalized,
      store,
      context: runContext,
      strategy: strategyIdentity,
      resumed: false,
      signal,
    });
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
