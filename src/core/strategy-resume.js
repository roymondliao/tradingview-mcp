/** Local audit, ownership, planning, and stable identity rebind for Strategy Resume. */
import {
  lstat as nodeLstat,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
} from 'node:fs/promises';
import {
  basename,
  isAbsolute,
  join,
  resolve,
} from 'node:path';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { check as checkPine } from './pine.js';
import { normalizedPineSourceSha256 } from './pine-input-schema.js';
import {
  assertPreparedInputFingerprint,
  effectiveInputsFingerprint,
  executeSelectedParameterSets,
  prepareParameterSetExecution,
} from './strategy-parameter-sets.js';
import { readDurableRunArtifacts } from './strategy-run-artifacts.js';
import {
  buildResumePlan,
  deriveRunSummary,
  transitionExperimentState,
  transitionRunState,
} from './strategy-run-state.js';
import {
  acquireStrategyRunPaneLeases,
  createStrategyPaneLeaseIdentity,
} from './strategy-run-lease.js';
import {
  assertStrategyResumeAccountIdentity,
  readResolvedSavedStrategy,
  readTargetPaneStudies,
  rebindStrategyResumePaneInstance,
  rebindStrategyResumeTarget,
  resolveLayoutTarget,
  resolvePaneStrategyInstances,
  resolveSavedStrategy,
} from './strategy-run-resolver.js';
import { planStrategySync } from './strategy-sync.js';
import { executeStrategySync } from './strategy-sync.js';
import {
  executeDurableStrategyExperiment,
  prepareDurableStrategyExperiment,
} from './strategy-durable-experiment.js';
import {
  executeDurableStrategySymbolAttempt,
} from './strategy-trading.js';
import { withChartSession } from './chart-session.js';
import { sha256Hex, stableJsonStringify } from './stable-json.js';
import { reconnectTo } from '../connection.js';
import { validateNamedWatchlistSymbols } from './watchlist.js';

const PINE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

function resumeError(message, {
  code = 'RUN_RESUME_ARTIFACT_INVALID',
  phase = 'resume_validation',
  cause,
} = {}) {
  return new CoreOperationError(message, { code, phase, cause });
}

function identityError(message, cause) {
  return resumeError(message, {
    code: 'RUN_RESUME_IDENTITY_MISMATCH',
    phase: 'resume_identity',
    cause,
  });
}

function valuesEqual(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

function freezeRecord(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRecord));
  if (!value || typeof value !== 'object') return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, freezeRecord(item)]),
  ));
}

function fingerprintsEqual(left, right) {
  return left?.available === true
    && right?.available === true
    && left.algorithm === right.algorithm
    && left.value === right.value
    && left.count === right.count;
}

function assertFingerprint(actual, expected, label) {
  if (!fingerprintsEqual(actual, expected)) {
    throw resumeError(`${label} fingerprint is inconsistent.`);
  }
}

function requestedParameterSets(run) {
  const requested = run.requested?.experiments?.parameter_sets;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw resumeError('run.json requested Parameter Sets are missing.');
  }
  return requested;
}

function assertPlanIdentity(run) {
  const requested = requestedParameterSets(run);
  const planningFields = [
    run.base_inputs,
    run.base_inputs_fingerprint,
    run.planned_experiments,
  ];
  const presentCount = planningFields.filter((value) => value != null).length;
  if (presentCount === 0) return false;
  if (
    run.resolved?.strategy == null
    || presentCount !== planningFields.length
    || !Array.isArray(run.planned_experiments)
    || run.planned_experiments.length !== requested.length
  ) {
    throw resumeError('run.json contains incomplete persisted Experiment setup metadata.');
  }
  assertFingerprint(
    effectiveInputsFingerprint(run.base_inputs),
    run.base_inputs_fingerprint,
    'Base Inputs',
  );
  for (const [index, plan] of run.planned_experiments.entries()) {
    const parameterSet = requested[index];
    if (
      parameterSet.name !== plan.parameter_set.name
      || !valuesEqual(parameterSet.inputs, plan.parameter_set.requested_inputs)
    ) {
      throw resumeError(`Experiment plan ${index} differs from the requested Parameter Set.`);
    }
    const requestedFingerprint = sha256Hex(
      Object.entries(parameterSet.inputs).sort(([left], [right]) => left.localeCompare(right)),
    );
    if (requestedFingerprint !== plan.parameter_set.requested_inputs_fingerprint) {
      throw resumeError(`Experiment plan ${index} requested Inputs fingerprint is inconsistent.`);
    }
    assertFingerprint(
      effectiveInputsFingerprint(plan.effective_inputs),
      plan.inputs_fingerprint,
      `Experiment plan ${index} Effective Inputs`,
    );
    const expectedExperimentId = `sha256:${sha256Hex({
      schema_version: 2,
      strategy: {
        entity_id: String(run.resolved.strategy.entity_id),
        script_id: String(run.resolved.strategy.script_id),
        version: String(run.resolved.strategy.version),
        source_sha256: run.resolved.strategy.source_sha256,
      },
      parameter_set_index: index,
      parameter_set_name: plan.parameter_set.name,
      requested_inputs_fingerprint: plan.parameter_set.requested_inputs_fingerprint,
      base_inputs_fingerprint: run.base_inputs_fingerprint.value,
      inputs_fingerprint: plan.inputs_fingerprint.value,
    })}`;
    if (plan.experiment_id !== expectedExperimentId) {
      throw resumeError(`Experiment plan ${index} ID is inconsistent.`);
    }
  }
  return true;
}

function stableTargetIdentity(target) {
  return {
    layout_name: target?.layout_name,
    saved_layout_id: target?.saved_layout_id ?? null,
    layout_id: target?.layout_id ?? null,
    url_chart_id: target?.url_chart_id ?? null,
    pane_index: target?.pane_index,
    pane_id: target?.pane_id ?? null,
  };
}

function stableStrategyIdentity(strategy) {
  return {
    script_id: strategy?.script_id,
    version: strategy?.version == null ? null : String(strategy.version),
    source_sha256: strategy?.source_sha256,
  };
}

function assertExperimentArtifacts(artifacts) {
  const { run, experiments, manifests } = artifacts;
  const experimentById = new Map(experiments.map((item) => [item.experiment_id, item]));
  const manifestById = new Map(manifests.map((item) => [item.experiment_id, item]));
  for (const plan of run.planned_experiments) {
    const experiment = experimentById.get(plan.experiment_id);
    const manifest = manifestById.get(plan.experiment_id);
    if (experiment) {
      if (
        !valuesEqual(experiment.base_inputs_fingerprint, run.base_inputs_fingerprint)
        || !valuesEqual(
          stableStrategyIdentity(experiment.strategy),
          stableStrategyIdentity(run.resolved.strategy),
        )
        || !valuesEqual(
          stableTargetIdentity(experiment.target),
          stableTargetIdentity(run.resolved.target),
        )
      ) {
        throw resumeError(
          `Experiment ${plan.parameter_set.name} stable identity differs from run.json.`,
        );
      }
    }
    if (manifest) {
      if (
        !experiment
        || !valuesEqual(
          stableStrategyIdentity(manifest.strategy),
          stableStrategyIdentity(run.resolved.strategy),
        )
        || !valuesEqual(manifest.inputs_fingerprint, plan.inputs_fingerprint)
        || manifest.watchlist.snapshot_id !== run.resolved.watchlist.snapshot_id
        || manifest.watchlist.ordered_symbol_fingerprint
          !== run.resolved.watchlist.ordered_symbol_fingerprint
        || manifest.watchlist.symbol_count !== run.resolved.watchlist.symbol_count
        || manifest.timeframe !== run.requested.backtest.timeframe
        || manifest.format !== run.requested.output.format
      ) {
        throw resumeError(
          `Manifest ${plan.parameter_set.name} identity differs from run.json.`,
        );
      }
    }
  }
}

function assertFrozenWatchlist(artifacts) {
  const { run, watchlist } = artifacts;
  const symbols = watchlist.symbols.map((item) => (
    typeof item === 'string' ? item : item.symbol
  ));
  const orderedFingerprint = `sha256:${sha256Hex(symbols)}`;
  if (orderedFingerprint !== watchlist.snapshot.ordered_symbol_fingerprint) {
    throw resumeError('watchlist.json ordered Symbol fingerprint is inconsistent.');
  }
  if (
    watchlist.watchlist?.name != null
    && watchlist.watchlist.name !== run.resolved.watchlist.name
  ) {
    throw resumeError('watchlist.json name differs from run.json.');
  }
  const declaredCounts = [
    watchlist.snapshot.declared_symbol_count,
    watchlist.snapshot.returned_symbol_count,
    watchlist.snapshot.unique_symbol_count,
  ].filter((value) => value != null);
  if (declaredCounts.some((value) => Number(value) !== symbols.length)) {
    throw resumeError('watchlist.json Symbol counts are inconsistent.');
  }
  if (
    watchlist.watchlist?.watchlist_id != null
    && watchlist.watchlist?.name != null
    && watchlist.watchlist?.modified != null
  ) {
    const snapshotId = `sha256:${sha256Hex({
      watchlist_id: String(watchlist.watchlist.watchlist_id),
      name: watchlist.watchlist.name,
      modified: watchlist.watchlist.modified,
      symbols,
    })}`;
    if (snapshotId !== watchlist.snapshot.snapshot_id) {
      throw resumeError('watchlist.json Snapshot ID is inconsistent.');
    }
  }
  return Object.freeze(symbols);
}

function filesystemDependencies(_deps = {}) {
  return {
    lstat: nodeLstat,
    readFile: nodeReadFile,
    readdir: nodeReaddir,
    ..._deps,
  };
}

async function auditExperimentDirectoryInventory(artifacts, _deps = {}) {
  const deps = filesystemDependencies(_deps);
  const root = join(artifacts.store.run_path, 'experiments');
  let entries;
  try {
    const info = await deps.lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw resumeError('Experiments root must be a non-symlink directory.');
    }
    entries = await deps.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    if (error instanceof CoreOperationError) throw error;
    throw resumeError('Unable to audit the Experiments directory.', { cause: error });
  }
  const plannedNames = new Set(
    (artifacts.run.planned_experiments || []).map((plan) => plan.parameter_set.name),
  );
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory() || !plannedNames.has(entry.name)) {
      throw resumeError(`Run Directory contains an unplanned Experiment entry: ${entry.name}.`);
    }
  }
}

async function auditSucceededArtifacts(artifacts) {
  for (const manifest of artifacts.manifests) {
    for (const entry of manifest.symbols) {
      if (entry.status !== 'succeeded') continue;
      await artifacts.store.verifySucceededSymbolArtifacts({ manifest, entry });
    }
  }
}

function manifestByExperimentId(artifacts) {
  return new Map(artifacts.manifests.map((manifest) => [manifest.experiment_id, manifest]));
}

function experimentByExperimentId(artifacts) {
  return new Map(artifacts.experiments.map((item) => [item.experiment_id, item]));
}

function enrichResumePlan(artifacts, purePlan) {
  const manifests = manifestByExperimentId(artifacts);
  const experiments = experimentByExperimentId(artifacts);
  const frozenSymbols = artifacts.watchlist.symbols.map((item) => (
    typeof item === 'string' ? item : item.symbol
  ));
  return freezeRecord({
    run_id: purePlan.run_id,
    run_directory: artifacts.store.run_path,
    setup_required: purePlan.setup_required,
    watchlist_symbol_count: purePlan.watchlist_symbol_count,
    experiment_count: purePlan.experiment_count,
    experiments: purePlan.experiments.map((item) => {
      const persistedPlan = artifacts.run.planned_experiments[item.index];
      const manifest = manifests.get(item.experiment_id) || null;
      const experiment = experiments.get(item.experiment_id) || null;
      const selectedIndices = item.selected_indices;
      return {
        ...item,
        timeframe: manifest?.timeframe || artifacts.run.requested.backtest.timeframe,
        format: manifest?.format || artifacts.run.requested.output.format,
        experiment,
        manifest,
        persisted_plan: persistedPlan,
        cleanup_targets: selectedIndices.map((index) => ({
          experiment_name: item.name,
          index,
          symbol: frozenSymbols[index],
        })),
      };
    }),
  });
}

export function summarizeStrategyResume({ artifacts, plan } = {}) {
  const summary = deriveRunSummary({
    run: artifacts.run,
    manifests: artifacts.manifests,
  });
  return freezeRecord({
    run_id: artifacts.run.run_id,
    status: artifacts.run.status,
    run_directory: artifacts.store.run_path,
    experiment_count: plan.experiment_count,
    experiments_selected: plan.experiments.filter(
      (item) => item.selected_indices.length > 0,
    ).length,
    symbols_selected: plan.experiments.reduce(
      (count, item) => count + item.selected_indices.length,
      0,
    ),
    ...summary,
  });
}

/** Read and fully audit local durable evidence without any TradingView call. */
export async function loadStrategyResume({ run_directory, _deps = {} } = {}) {
  const absoluteRunDirectory = typeof run_directory === 'string'
    ? resolve(run_directory)
    : run_directory;
  const readArtifacts = _deps.readArtifacts || readDurableRunArtifacts;
  const artifacts = await readArtifacts({
    run_directory: absoluteRunDirectory,
    _deps: _deps.artifacts,
  });
  if (artifacts.run.status === 'succeeded') {
    throw resumeError('Run has already succeeded.', {
      code: 'RUN_ALREADY_SUCCEEDED',
      phase: 'resume_validation',
    });
  }
  if (
    artifacts.watchlist.symbol_validation?.performed === true
    && artifacts.watchlist.symbol_validation.success === false
  ) {
    throw resumeError('The frozen Watchlist failed TradingView Symbol validation.', {
      code: 'WATCHLIST_SYMBOL_VALIDATION_FAILED',
      phase: 'watchlist_symbol_validation',
    });
  }
  if (basename(artifacts.store.run_path) !== artifacts.run.run_id) {
    throw resumeError('Run ID does not match the resolved Run Directory.');
  }
  const setupComplete = assertPlanIdentity(artifacts.run);
  const symbols = assertFrozenWatchlist(artifacts);
  if (setupComplete) assertExperimentArtifacts(artifacts);
  const auditInventory = _deps.auditExperimentInventory || auditExperimentDirectoryInventory;
  await auditInventory(artifacts, _deps.fs);
  await auditSucceededArtifacts(artifacts);
  const purePlan = buildResumePlan({
    run: artifacts.run,
    watchlist: artifacts.watchlist,
    experiments: artifacts.experiments,
    manifests: artifacts.manifests,
  });
  const plan = enrichResumePlan(artifacts, purePlan);
  return Object.freeze({
    run_directory: artifacts.store.run_path,
    artifacts,
    symbols,
    plan,
    summary: summarizeStrategyResume({ artifacts, plan }),
  });
}

function samePaneLeaseIdentity(left, right) {
  return createStrategyPaneLeaseIdentity({ pane: left }).stable_key
    === createStrategyPaneLeaseIdentity({ pane: right }).stable_key;
}

/** Acquire Run then Pane ownership, re-read artifacts, and release after the callback. */
export async function withStrategyResumeOwnership({
  run_directory,
  _deps = {},
} = {}, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Strategy Resume ownership callback is required.');
  }
  const initial = await loadStrategyResume({ run_directory, _deps: _deps.local });
  const acquireLeases = _deps.acquireLeases || acquireStrategyRunPaneLeases;
  const leases = await acquireLeases({
    run_directory: initial.run_directory,
    pane: initial.artifacts.run.resolved.target,
    run_id: initial.artifacts.run.run_id,
    _deps: _deps.leases,
  });
  try {
    const locked = await loadStrategyResume({
      run_directory: initial.run_directory,
      _deps: _deps.local,
    });
    if (
      locked.artifacts.run.run_id !== initial.artifacts.run.run_id
      || !samePaneLeaseIdentity(
        initial.artifacts.run.resolved.target,
        locked.artifacts.run.resolved.target,
      )
    ) {
      throw resumeError('Run or Pane identity changed while acquiring ownership.');
    }
    return await operation(Object.freeze({ initial, locked, leases }));
  } finally {
    await leases.release();
  }
}

export async function readPersistedPineSource(run, _deps = {}) {
  const path = run.requested?.strategy?.file_path;
  if (typeof path !== 'string' || !path.trim() || !isAbsolute(path)) {
    throw resumeError('run.json does not contain an absolute persisted Pine source path.');
  }
  const deps = filesystemDependencies(_deps);
  try {
    const info = await deps.lstat(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > PINE_SOURCE_MAX_BYTES) {
      throw identityError('Persisted Pine source must be a bounded non-symlink regular file.');
    }
    const source = await deps.readFile(path, 'utf8');
    const sourceSha256 = normalizedPineSourceSha256(source);
    const expected = new Set([
      run.source_sha256,
      run.requested.strategy.source_sha256,
      run.resolved.strategy?.source_sha256,
    ].filter((value) => value != null));
    if (expected.size !== 1 || !expected.has(sourceSha256)) {
      throw identityError('Local Pine source hash differs from the persisted Run.');
    }
    return Object.freeze({ path, source, source_sha256: sourceSha256 });
  } catch (error) {
    if (error?.code === 'RUN_RESUME_IDENTITY_MISMATCH') throw error;
    throw identityError(`Unable to verify persisted Pine source: ${path}.`, error);
  }
}

async function resolveResumeCandidate(run, pine, _deps) {
  const compile = _deps.checkPine || checkPine;
  let candidate;
  try {
    candidate = await compile({ source: pine.source, _deps: _deps.pine });
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to verify the persisted Candidate Pine schema.');
  }
  if (
    candidate?.compiled !== true
    || candidate?.input_schema?.available !== true
    || candidate.input_schema.source_sha256 !== run.source_sha256
    || candidate.input_schema.input_schema_fingerprint !== run.candidate_schema_fingerprint
  ) {
    throw identityError('Candidate Pine schema differs from the persisted Run.');
  }
  return candidate;
}

async function resolveResumeTarget(run, _deps) {
  const resolveLayout = _deps.resolveLayoutTarget || resolveLayoutTarget;
  let currentTarget;
  try {
    currentTarget = await resolveLayout({
      layout_name: run.resolved.target.layout_name,
      pane_index: run.resolved.target.pane_index,
      _deps: _deps.layout,
    });
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to resolve the persisted Layout and Pane.');
  }
  const context = rebindStrategyResumeTarget({
    persisted: run.resolved.target,
    current: currentTarget,
  });
  const attachTarget = _deps.attachTarget || reconnectTo;
  try {
    await attachTarget(context.target_id);
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to attach the resolved Strategy Resume target.');
  }
  return context;
}

/** Resolve the read-only inputs needed to complete a crash-interrupted setup phase. */
export async function resolveStrategyResumeSetup({ local, _deps = {} } = {}) {
  const run = local?.artifacts?.run;
  if (!run || local.plan.setup_required !== true) {
    throw resumeError('Strategy Resume setup resolution requires an unfinished setup Run.');
  }
  const pine = await readPersistedPineSource(run, _deps.fs);
  const candidate = await resolveResumeCandidate(run, pine, _deps);
  const context = await resolveResumeTarget(run, _deps);
  const resolveAccount = _deps.resolveSavedStrategy || resolveSavedStrategy;
  const readAccount = _deps.readResolvedSavedStrategy || readResolvedSavedStrategy;
  let account;
  let accountDetail = null;
  try {
    account = await resolveAccount({
      saved_name: run.requested.strategy.saved_name,
      _deps: _deps.account,
    });
    if (account?.exists) {
      accountDetail = await readAccount({ resolved_account: account, _deps: _deps.account });
    }
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to resolve the requested Saved Strategy for setup.');
  }
  const readPane = _deps.readTargetPaneStudies || readTargetPaneStudies;
  let paneState;
  try {
    paneState = await readPane({
      target_id: context.target_id,
      pane_index: context.pane_index,
      _deps: _deps.pane,
    });
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to read the requested Pane for setup.');
  }
  const paneInstances = account?.exists
    ? resolvePaneStrategyInstances({
      pane_state: paneState,
      script_id: account.script.script_id || account.script.id,
    })
    : Object.freeze({ match_count: 0, matches: Object.freeze([]) });
  let currentSchema = null;
  if (accountDetail?.pine_source) {
    if (accountDetail.source_sha256 === pine.source_sha256) {
      currentSchema = candidate.input_schema;
    } else {
      const current = await (_deps.checkPine || checkPine)({
        source: accountDetail.pine_source,
        _deps: _deps.pine,
      });
      currentSchema = current?.input_schema || null;
    }
  }
  const syncPlan = planStrategySync({
    local_source_sha256: pine.source_sha256,
    account: account ? {
      ...account,
      source_sha256: accountDetail?.source_sha256 || null,
    } : null,
    pane_instances: paneInstances,
  });
  if (syncPlan.errors?.length) {
    throw identityError(syncPlan.errors[0].message || 'Strategy setup plan is invalid.');
  }
  return Object.freeze({
    pine,
    candidate_schema: candidate.input_schema,
    target: Object.freeze({
      ...context,
      symbol: paneState.symbol ?? context.symbol,
      timeframe: paneState.timeframe ?? context.timeframe,
      resolution: paneState.timeframe ?? context.resolution,
    }),
    account,
    account_detail: accountDetail,
    pane_state: paneState,
    pane_instances: paneInstances,
    current_schema: currentSchema,
    strategy_sync: syncPlan,
  });
}

function preparedInputsFromRun(run, strategy, context) {
  return Object.freeze({
    valid: true,
    identity: strategy,
    context,
    base_inputs: run.base_inputs,
    base_inputs_fingerprint: run.base_inputs_fingerprint,
    parameter_sets: Object.freeze(run.planned_experiments.map((plan) => Object.freeze({
      index: plan.parameter_set.index,
      name: plan.parameter_set.name,
      inputs_fingerprint: plan.inputs_fingerprint,
      effective_inputs: plan.effective_inputs,
    }))),
  });
}

function wrapIdentityFailure(error, message) {
  if (
    error?.code === 'RUN_RESUME_IDENTITY_MISMATCH'
    && error?.phase === 'resume_identity'
  ) throw error;
  if (String(error?.code || '').startsWith('CDP_')) throw error;
  throw identityError(message, error);
}

/** Resolve current read-only runtime bindings and prove all stable identities. */
export async function resolveStrategyResumeIdentity({ local, _deps = {} } = {}) {
  const run = local?.artifacts?.run;
  if (!run?.resolved?.strategy || !run.base_inputs || !run.planned_experiments) {
    throw resumeError('Resume identity requires complete persisted setup metadata.');
  }
  const pine = await readPersistedPineSource(run, _deps.fs);
  const candidate = await resolveResumeCandidate(run, pine, _deps);
  const context = await resolveResumeTarget(run, _deps);

  const resolveAccount = _deps.resolveSavedStrategy || resolveSavedStrategy;
  const readAccount = _deps.readResolvedSavedStrategy || readResolvedSavedStrategy;
  let account;
  let accountDetail;
  try {
    account = await resolveAccount({
      saved_name: run.requested.strategy.saved_name,
      _deps: _deps.account,
    });
    accountDetail = await readAccount({ resolved_account: account, _deps: _deps.account });
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to resolve the persisted Saved Strategy.');
  }
  const stableStrategy = assertStrategyResumeAccountIdentity({
    persisted: run.resolved.strategy,
    resolved_account: account,
    account_detail: accountDetail,
  });
  if (stableStrategy.source_sha256 !== pine.source_sha256) {
    throw identityError('Local and Account Strategy source hashes differ.');
  }

  const readPane = _deps.readTargetPaneStudies || readTargetPaneStudies;
  let paneState;
  try {
    paneState = await readPane({
      target_id: context.target_id,
      pane_index: context.pane_index,
      _deps: _deps.pane,
    });
  } catch (error) {
    wrapIdentityFailure(error, 'Unable to read the persisted Pane Strategy identity.');
  }
  const rebound = rebindStrategyResumePaneInstance({
    pane_state: paneState,
    persisted_strategy: stableStrategy,
    base_inputs: run.base_inputs,
  });
  if (!rebound.entity_id) {
    throw identityError('Current Pane Strategy has no runtime entity ID.');
  }
  const strategy = Object.freeze({
    script_id: rebound.script_id,
    version: rebound.version,
    source_sha256: rebound.source_sha256,
    entity_id: rebound.entity_id,
  });
  const reboundContext = Object.freeze({
    ...context,
    symbol: paneState.symbol ?? context.symbol,
    timeframe: paneState.timeframe ?? context.timeframe,
    resolution: paneState.timeframe ?? context.resolution,
  });
  const prepared = preparedInputsFromRun(run, strategy, reboundContext);
  try {
    assertPreparedInputFingerprint({
      prepared,
      inputs_fingerprint: rebound.inputs_fingerprint,
    });
  } catch (error) {
    wrapIdentityFailure(error, 'Current Inputs differ from persisted Base and planned values.');
  }
  return Object.freeze({
    pine,
    candidate_schema: candidate.input_schema,
    target: reboundContext,
    chart_restore_baseline: Object.freeze({
      symbol: paneState.symbol ?? context.symbol,
      resolution: paneState.timeframe ?? context.resolution,
    }),
    strategy,
    current_inputs_fingerprint: rebound.inputs_fingerprint,
    prepared_inputs: prepared,
    account: stableStrategy,
  });
}

/** Hold both leases while runtime identity and the caller's Resume operation execute. */
export async function withStrategyResumeContext({
  run_directory,
  _deps = {},
} = {}, operation) {
  if (typeof operation !== 'function') {
    throw new TypeError('Strategy Resume context callback is required.');
  }
  return withStrategyResumeOwnership({
    run_directory,
    _deps: _deps.ownership,
  }, async (owned) => {
    const identity = owned.locked.plan.setup_required
      ? await resolveStrategyResumeSetup({
        local: owned.locked,
        _deps: _deps.identity,
      })
      : await resolveStrategyResumeIdentity({
        local: owned.locked,
        _deps: _deps.identity,
      });
    return operation(Object.freeze({
      ...owned,
      local: owned.locked,
      identity,
      context: sanitizeCoreContext(identity.target),
    }));
  });
}

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

function executablePreparedRun(run, identity, context) {
  return Object.freeze({
    valid: true,
    errors: Object.freeze([]),
    identity,
    context,
    base_inputs: run.base_inputs,
    base_inputs_fingerprint: run.base_inputs_fingerprint,
    planned_experiments: run.planned_experiments,
    parameter_sets: Object.freeze(run.planned_experiments.map((plan) => Object.freeze({
      index: plan.parameter_set.index,
      name: plan.parameter_set.name,
      requested_inputs: plan.parameter_set.requested_inputs,
      resolved_inputs: plan.parameter_set.resolved_inputs || Object.freeze([]),
      requested_inputs_fingerprint: plan.parameter_set.requested_inputs_fingerprint,
      inputs_fingerprint: plan.inputs_fingerprint,
      effective_inputs: plan.effective_inputs,
      experiment_id: plan.experiment_id,
    }))),
  });
}

/** Shared selected-Experiment execution used by new Run and explicit Resume. */
export async function executeDurableStrategyPlan({
  store,
  run,
  watchlist,
  prepared,
  identity,
  context,
  selected_experiments,
  signal,
  timeout_ms,
  _deps = {},
} = {}) {
  assertNotAborted(signal);
  const symbols = (watchlist?.symbols || []).map((item) => (
    typeof item === 'string' ? item : item.symbol
  ));
  const selections = Array.isArray(selected_experiments)
    ? selected_experiments
    : run.planned_experiments.map((plan, index) => ({
      index,
      selected_indices: symbols.map((_symbol, symbolIndex) => symbolIndex),
      experiment: null,
      manifest: null,
      persisted_plan: plan,
    }));
  const selected = selections.filter((item) => item.selected_indices.length > 0);
  const durableStates = new Map();
  const rawNow = _deps.now || Date.now;
  let lastTimestamp = Math.max(
    run.updated_at || 0,
    ...selections.map((item) => item.manifest?.updated_at || 0),
  );
  const now = () => {
    const candidate = Number(rawNow());
    if (Number.isInteger(candidate)) lastTimestamp = Math.max(lastTimestamp, candidate);
    return lastTimestamp;
  };
  for (const selection of selected) {
    assertNotAborted(signal);
    let state = await (_deps.prepareDurableStrategyExperiment
      || prepareDurableStrategyExperiment)({
      store,
      run,
      experiment_plan: run.planned_experiments[selection.index],
      experiment: selection.experiment,
      manifest: selection.manifest,
      requested_symbols: symbols,
      strategy: identity,
      target: run.resolved.target,
      timeframe: selection.timeframe || run.requested.backtest.timeframe,
      format: selection.format || run.requested.output.format,
      _deps: { now },
    });
    if (state.manifest.status === 'failed') {
      const manifest = transitionExperimentState(state.manifest, {
        status: 'running',
        updated_at: Math.max(state.manifest.updated_at, now()),
      });
      await store.replaceManifest(manifest);
      state = Object.freeze({ ...state, manifest });
    }
    durableStates.set(selection.index, state);
  }

  const executePlan = _deps.executeSelectedParameterSets || executeSelectedParameterSets;
  const executeExperiment = _deps.executeDurableStrategyExperiment
    || executeDurableStrategyExperiment;
  const executeAttempt = _deps.executeSymbolAttempt || executeDurableStrategySymbolAttempt;
  const results = await executePlan({
    prepared,
    selected_indices: selected.map((item) => item.index),
    identity,
    context,
    timeout_ms,
    before_experiment: async () => { assertNotAborted(signal); },
    _deps: _deps.parameter_sets,
  }, async (parameterExperiment) => {
    assertNotAborted(signal);
    const index = parameterExperiment.parameter_set.index;
    const selection = selected.find((item) => item.index === index);
    const state = durableStates.get(index);
    const operation = await executeExperiment({
      store,
      prepared_experiment: state,
      selected_indices: selection.selected_indices,
      context,
      signal,
      ownership_confirmed: true,
      execute_symbol_attempt: (attempt) => executeAttempt({
        ...attempt,
        identity,
        context,
        timeframe: state.timeframe,
        format: state.format,
        timeout_ms,
        _deps,
      }),
      _deps: { now, retry: { ..._deps.retry, now } },
    });
    durableStates.set(index, Object.freeze({ ...state, manifest: operation.manifest }));
    return operation;
  });
  return Object.freeze({ results, durable_states: durableStates });
}

function boundedExperiment(manifest) {
  return Object.freeze({
    name: manifest.parameter_set_name,
    experiment_id: manifest.experiment_id,
    inputs_fingerprint: manifest.inputs_fingerprint,
    status: manifest.status,
    success: manifest.status === 'succeeded',
    summary: manifest.summary,
    manifest: `experiments/${manifest.parameter_set_name}/manifest.json`,
    started_at: manifest.started_at,
    started_at_iso: manifest.started_at_iso,
    updated_at: manifest.updated_at,
    updated_at_iso: manifest.updated_at_iso,
  });
}

function setupFailureSummary(run) {
  const experimentsRequested = run.requested.experiments.parameter_sets.length;
  const symbolsPerExperiment = run.resolved.watchlist.symbol_count;
  return Object.freeze({
    experiments_requested: experimentsRequested,
    experiments_running: 0,
    experiments_succeeded: 0,
    experiments_failed: 0,
    symbols_requested: experimentsRequested * symbolsPerExperiment,
    symbols_pending: experimentsRequested * symbolsPerExperiment,
    symbols_running: 0,
    symbols_retry_wait: 0,
    symbols_succeeded: 0,
    symbols_failed: 0,
    symbols_skipped: 0,
  });
}

/** Derive and persist the terminal Run state from all authoritative manifests. */
export async function finalizeDurableStrategyRun({
  store,
  error = null,
  _deps = {},
} = {}) {
  const readArtifacts = _deps.readArtifacts || readDurableRunArtifacts;
  const loaded = await readArtifacts({
    run_directory: store.run_path,
    _deps: _deps.artifacts,
  });
  const manifests = loaded.manifests;
  const complete = Array.isArray(loaded.run.planned_experiments)
    && manifests.length === loaded.run.planned_experiments.length
    && manifests.every((manifest) => manifest.status === 'succeeded');
  const terminalError = error || (!complete
    ? new CoreOperationError('Strategy Run has incomplete or failed Experiments.', {
      code: 'STRATEGY_RUN_FAILED', phase: 'strategy_run_execution',
    })
    : null);
  const summary = loaded.run.planned_experiments
    ? deriveRunSummary({ run: loaded.run, manifests })
    : setupFailureSummary(loaded.run);
  const experiments = manifests.map(boundedExperiment);
  const now = _deps.now || Date.now;
  const run = transitionRunState(loaded.run, {
    status: complete && terminalError == null ? 'succeeded' : 'failed',
    updated_at: Math.max(loaded.run.updated_at, now()),
    error: terminalError,
    patch: { summary, experiments },
  });
  await store.replaceRun(run);
  return Object.freeze({ run, watchlist: loaded.watchlist, manifests, summary, experiments });
}

export async function durableStrategyRunResponse({
  finalized,
  store,
  context,
  strategy,
  resumed = false,
  signal,
} = {}) {
  const [runArtifact, watchlistArtifact] = await Promise.all([
    store.artifactInfo('run.json'),
    store.artifactInfo('watchlist.json'),
  ]);
  const interrupted = finalized.run.error?.code === 'RUN_INTERRUPTED';
  const signalExitCode = Number.isInteger(signal?.reason?.exit_code)
    ? signal.reason.exit_code
    : null;
  const cdpFailure = String(finalized.run.error?.code || '').startsWith('CDP_');
  return Object.freeze({
    success: finalized.run.status === 'succeeded',
    ...(cdpFailure && { failure_kind: 'cdp_connection' }),
    ...(interrupted && signalExitCode != null && { exit_code: signalExitCode }),
    run_id: finalized.run.run_id,
    status: finalized.run.status,
    durable: true,
    resumed,
    output: Object.freeze({
      path: store.run_path,
      atomic: false,
      atomic_scope: 'state_file_and_symbol_directory',
      replaced: false,
    }),
    strategy: strategy || finalized.run.resolved.strategy || null,
    context: sanitizeCoreContext(context || finalized.run.resolved.target),
    watchlist: Object.freeze({
      name: finalized.run.resolved.watchlist.name,
      snapshot_id: finalized.run.resolved.watchlist.snapshot_id,
      symbol_count: finalized.run.resolved.watchlist.symbol_count,
      ...(finalized.watchlist.symbol_validation && {
        symbol_validation: finalized.watchlist.symbol_validation,
      }),
    }),
    summary: finalized.summary,
    experiments: finalized.experiments,
    ...(finalized.run.error && { error: finalized.run.error }),
    artifacts: Object.freeze({ run: runArtifact, watchlist: watchlistArtifact }),
    retry_supported: true,
    resume_supported: true,
  });
}

function setupRunPatch(run, { strategy, target, prepared }) {
  return {
    resolved: {
      ...run.resolved,
      target: { ...run.resolved.target, ...sanitizeCoreContext(target) },
      strategy,
    },
    base_inputs: prepared.base_inputs,
    base_inputs_fingerprint: prepared.base_inputs_fingerprint,
    planned_experiments: prepared.planned_experiments,
  };
}

/** Resume the same durable Run ID without creating continuation output. */
export async function resumeStrategyAutomation({
  run_directory,
  signal,
  _deps = {},
} = {}) {
  const runWithResumeContext = _deps.withStrategyResumeContext || withStrategyResumeContext;
  return runWithResumeContext({
    run_directory,
    _deps: _deps.context,
  }, async ({ local, identity }) => {
    const store = local.artifacts.store;
    let run = local.artifacts.run;
    let context = identity.target;
    let runtimeStrategy = run.resolved.strategy || null;
    let primaryError = null;
    try {
      assertNotAborted(signal);
      const runWithSession = _deps.withChartSession || withChartSession;
      await runWithSession({ context, _deps: _deps.session }, async () => {
        const alreadyLockedSession = async (_options, operation) => operation();
        let executionWatchlist = local.artifacts.watchlist;
        if (local.artifacts.watchlist.symbol_validation?.performed === false) {
          const validateWatchlist = _deps.validateNamedWatchlistSymbols
            || validateNamedWatchlistSymbols;
          const symbolValidation = await validateWatchlist({
            snapshot: local.artifacts.watchlist,
            context,
            timeframe: run.requested.backtest.timeframe,
            signal,
            _deps: _deps.watchlist_validation,
          });
          executionWatchlist = Object.freeze({
            ...local.artifacts.watchlist,
            symbol_validation: symbolValidation,
          });
          await store.replaceWatchlist(executionWatchlist);
          if (!symbolValidation.success) {
            throw resumeError(
              `Watchlist Symbol validation failed for ${symbolValidation.failed} of ${symbolValidation.requested} Symbols.`,
              {
                code: 'WATCHLIST_SYMBOL_VALIDATION_FAILED',
                phase: 'watchlist_symbol_validation',
              },
            );
          }
        }
        assertNotAborted(signal);
        let strategy;
        let prepared;
        let selections;
        if (local.plan.setup_required) {
          const runSync = _deps.executeStrategySync || executeStrategySync;
          const sync = await runSync({
            saved_name: run.requested.strategy.saved_name,
            source: identity.pine.source,
            source_sha256: run.source_sha256,
            candidate_schema: identity.candidate_schema,
            current_schema: identity.current_schema,
            context,
            expected_plan: identity.strategy_sync,
            timeout_ms: _deps.timeout_ms,
            _deps: { ..._deps.sync, withChartSession: alreadyLockedSession },
          });
          strategy = Object.freeze({
            script_id: sync.account.script_id,
            version: String(sync.account.version),
            source_sha256: sync.source_sha256,
            entity_id: sync.pane.entity_id,
          });
          runtimeStrategy = strategy;
          run = transitionRunState(run, {
            status: 'running',
            updated_at: Math.max(run.updated_at, (_deps.now || Date.now)()),
            patch: { resolved: { ...run.resolved, strategy } },
          });
          await store.replaceRun(run);
          const prepare = _deps.prepareParameterSetExecution || prepareParameterSetExecution;
          prepared = await prepare({
            candidate_schema: identity.candidate_schema,
            parameter_sets: run.requested.experiments.parameter_sets,
            identity: strategy,
            context,
            _deps: _deps.parameter_sets,
          });
          run = transitionRunState(run, {
            status: 'running',
            updated_at: Math.max(run.updated_at, (_deps.now || Date.now)()),
            patch: setupRunPatch(run, { strategy, target: context, prepared }),
          });
          await store.replaceRun(run);
          selections = run.planned_experiments.map((plan, index) => ({
            index,
            selected_indices: local.symbols.map((_symbol, symbolIndex) => symbolIndex),
            experiment: null,
            manifest: null,
            persisted_plan: plan,
            timeframe: run.requested.backtest.timeframe,
            format: run.requested.output.format,
          }));
        } else {
          strategy = identity.strategy;
          runtimeStrategy = strategy;
          context = identity.target;
          prepared = executablePreparedRun(run, strategy, context);
          selections = local.plan.experiments;
          run = transitionRunState(run, {
            status: 'running',
            updated_at: Math.max(run.updated_at, (_deps.now || Date.now)()),
            patch: {
              resolved: {
                ...run.resolved,
                target: { ...run.resolved.target, ...sanitizeCoreContext(context) },
              },
            },
          });
          await store.replaceRun(run);
        }
        assertNotAborted(signal);
        await executeDurableStrategyPlan({
          store,
          run,
          watchlist: executionWatchlist,
          prepared,
          identity: strategy,
          context,
          selected_experiments: selections,
          signal,
          timeout_ms: _deps.timeout_ms,
          _deps: { now: _deps.now, ..._deps.execution, parameter_sets: {
            ..._deps.execution?.parameter_sets,
            withChartSession: alreadyLockedSession,
          } },
        });
      });
      assertNotAborted(signal);
    } catch (error) {
      primaryError = error;
    }
    const finalized = await finalizeDurableStrategyRun({
      store,
      error: primaryError,
      _deps: { now: _deps.now, ..._deps.finalize },
    });
    return durableStrategyRunResponse({
      finalized,
      store,
      context,
      strategy: runtimeStrategy,
      resumed: true,
      signal,
    });
  });
}
