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
export async function dryRunStrategyAutomation({ config_path, _deps = {} } = {}) {
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
  if (requested.target.watchlist.name) {
    try {
      const captureWatchlist = _deps.captureNamedWatchlistSnapshot || captureNamedWatchlistSnapshot;
      const complete = await captureWatchlist({
        name: requested.target.watchlist.name,
        _deps: _deps.watchlist,
      });
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
  return {
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
}

export async function runStrategyAutomation() {
  const error = new Error('Formal strategy run is not implemented yet; use --dry-run.');
  Object.assign(error, { code: 'STRATEGY_RUN_NOT_IMPLEMENTED', phase: 'request_validation' });
  throw error;
}
