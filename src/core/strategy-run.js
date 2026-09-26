/** Strategy automation preflight orchestration. TASK-004 is intentionally read-only. */
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
  summarizeNamedWatchlistSnapshot,
} from './watchlist.js';
import { compareInputSchemas, planParameterSets } from './strategy-parameter-sets.js';
import { planStrategySync } from './strategy-sync.js';
import { executeStrategySync } from './strategy-sync.js';
import { executeParameterSets } from './strategy-parameter-sets.js';
import { exportStrategySnapshotIntoRun } from './strategy-trading.js';
import { createArtifactSetTransaction } from './artifacts.js';
import { withChartSession } from './chart-session.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { unixMillisecondsToIso } from './time.js';
import { reconnectTo } from '../connection.js';

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

function experimentArtifactRoot(name) {
  return `experiments/${name}`;
}

function boundedExperimentResult(result) {
  return Object.freeze({
    name: result.experiment.parameter_set.name,
    experiment_id: result.experiment.experiment_id,
    inputs_fingerprint: result.experiment.inputs_fingerprint,
    status: result.operation.status,
    success: result.operation.success,
    summary: result.operation.summary,
    manifest: result.operation.artifacts.manifest.relative_path,
    started_at: result.experiment.started_at,
    started_at_iso: result.experiment.started_at_iso,
    completed_at: result.experiment.completed_at,
    completed_at_iso: result.experiment.completed_at_iso,
  });
}

function runFailureKind(experiments) {
  return experiments.some((item) => item.operation?.failure_kind === 'cdp_connection')
    ? 'cdp_connection'
    : null;
}

/** Execute one complete non-durable Strategy automation Run and atomically publish its artifacts. */
export async function runStrategyAutomation({ config_path, _deps = {} } = {}) {
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

  const internal = preflight._internal;
  const requested = internal.loaded.requested;
  const runContext = Object.freeze({
    ...internal.target,
    resolution: internal.target.resolution ?? internal.target.timeframe ?? null,
  });
  const createTransaction = _deps.createArtifactSetTransaction || createArtifactSetTransaction;
  const transaction = await createTransaction({
    output_directory: requested.output.directory_path,
    run_id: requested.run.run_id,
    force: false,
    _deps: _deps.artifactDeps,
  });
  const now = _deps.now || Date.now;
  const startedAt = now();
  let sync = null;
  try {
    const runWithSession = _deps.withChartSession || withChartSession;
    return await runWithSession({ context: runContext, _deps: _deps.session }, async () => {
    const alreadyLockedSession = async (_options, operation) => operation();
    const runSync = _deps.executeStrategySync || executeStrategySync;
    sync = await runSync({
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
    const strategyIdentity = Object.freeze({
      script_id: sync.account.script_id,
      version: sync.account.version,
      source_sha256: sync.source_sha256,
      entity_id: sync.pane.entity_id,
    });
    const resolved = Object.freeze({
      context: sanitizeCoreContext(runContext),
      strategy: strategyIdentity,
      account: sync.account,
      pane: sync.pane,
      watchlist: internal.watchlist.watchlist,
      watchlist_snapshot_id: internal.watchlist.snapshot.snapshot_id,
    });
    const runningRun = {
      schema_version: 1,
      run_id: transaction.run_id,
      status: 'running',
      requested,
      config: {
        path: internal.loaded.config_path,
        sha256: internal.loaded.config_sha256,
      },
      source_sha256: requested.strategy.source_sha256,
      candidate_schema_fingerprint: internal.candidate.input_schema.input_schema_fingerprint,
      resolved,
      started_at: startedAt,
      started_at_iso: unixMillisecondsToIso(startedAt),
      retry_supported: false,
      resume_supported: false,
      experiments: [],
    };
    await transaction.writeJson('watchlist.json', internal.watchlist);
    await transaction.replaceJson('run.json', runningRun);

    const exportSnapshot = _deps.exportStrategySnapshotIntoRun || exportStrategySnapshotIntoRun;
    const runParameterSets = _deps.executeParameterSets || executeParameterSets;
    const executed = await runParameterSets({
      candidate_schema: internal.candidate.input_schema,
      parameter_sets: requested.experiments.parameter_sets,
      identity: strategyIdentity,
      context: runContext,
      timeout_ms: _deps.timeout_ms,
      _deps: { ..._deps.parameter_sets, withChartSession: alreadyLockedSession },
    }, async (experiment) => exportSnapshot({
      entity_id: strategyIdentity.entity_id,
      snapshot: internal.watchlist,
      timeframe: requested.backtest.timeframe,
      context: runContext,
      format: requested.output.format,
      fail_fast: false,
      timeout_ms: _deps.timeout_ms,
      transaction,
      namespace: experimentArtifactRoot(experiment.parameter_set.name),
      expected_inputs_fingerprint: experiment.inputs_fingerprint,
      mode: 'named_watchlist_experiment',
      _deps: _deps.export,
    }));

    for (const result of executed.experiments) {
      const root = experimentArtifactRoot(result.experiment.parameter_set.name);
      await transaction.writeJson(`${root}/experiment.json`, {
        ...result.experiment,
        export: {
          status: result.operation.status,
          success: result.operation.success,
          summary: result.operation.summary,
          manifest: result.operation.artifacts.manifest.relative_path,
          chart_restore: result.operation.chart_restore,
        },
      });
    }

    const boundedExperiments = executed.experiments.map(boundedExperimentResult);
    const success = boundedExperiments.every((item) => item.success);
    const status = success ? 'succeeded' : 'partial';
    const completedAt = now();
    const finalRun = {
      ...runningRun,
      status,
      completed_at: completedAt,
      completed_at_iso: unixMillisecondsToIso(completedAt),
      base_inputs_fingerprint: executed.base_inputs_fingerprint,
      input_restore: executed.restore,
      summary: {
        experiments_requested: boundedExperiments.length,
        experiments_succeeded: boundedExperiments.filter((item) => item.success).length,
        experiments_partial: boundedExperiments.filter((item) => !item.success).length,
        symbols_requested: boundedExperiments.reduce((sum, item) => sum + item.summary.requested, 0),
        symbols_succeeded: boundedExperiments.reduce((sum, item) => sum + item.summary.succeeded, 0),
        symbols_failed: boundedExperiments.reduce((sum, item) => sum + item.summary.failed, 0),
      },
      experiments: boundedExperiments,
    };
    await transaction.replaceJson('run.json', finalRun);
    const [runInfo, watchlistInfo] = await Promise.all([
      transaction.artifactInfo('run.json'),
      transaction.artifactInfo('watchlist.json'),
    ]);
    const publication = await transaction.publish();
    const failureKind = runFailureKind(executed.experiments);
    return Object.freeze({
      success,
      ...(failureKind && { failure_kind: failureKind }),
      run_id: transaction.run_id,
      status,
      output: publication,
      strategy: strategyIdentity,
      context: sanitizeCoreContext(runContext),
      watchlist: {
        name: internal.watchlist.watchlist.name,
        snapshot_id: internal.watchlist.snapshot.snapshot_id,
        symbol_count: internal.watchlist.snapshot.returned_symbol_count,
      },
      summary: finalRun.summary,
      experiments: boundedExperiments,
      artifacts: { run: runInfo, watchlist: watchlistInfo },
      retry_supported: false,
      resume_supported: false,
    });
    });
  } catch (error) {
    try {
      await transaction.abort();
    } catch {
      // Preserve the primary orchestration error.
    }
    if (error instanceof CoreOperationError) throw error;
    throw new CoreOperationError(`Strategy Run failed: ${error?.message || String(error)}`, {
      code: error?.code || 'STRATEGY_RUN_FAILED',
      phase: error?.phase || (sync ? 'strategy_run_execution' : 'strategy_sync'),
      retryable: error?.retryable === true,
      context: runContext,
      cause: error,
    });
  }
}
