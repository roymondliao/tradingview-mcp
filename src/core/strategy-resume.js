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
} from './strategy-parameter-sets.js';
import { readDurableRunArtifacts } from './strategy-run-artifacts.js';
import {
  buildResumePlan,
  deriveRunSummary,
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
  resolveSavedStrategy,
} from './strategy-run-resolver.js';
import { sha256Hex, stableJsonStringify } from './stable-json.js';
import { reconnectTo } from '../connection.js';

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
  if (
    !Array.isArray(run.planned_experiments)
    || run.planned_experiments.length !== requested.length
  ) {
    throw resumeError('run.json is missing one or more persisted Experiment plans.');
  }
  return requested;
}

function assertPlanIdentity(run) {
  const requested = requestedParameterSets(run);
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
    artifacts.run.planned_experiments.map((plan) => plan.parameter_set.name),
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
  if (basename(artifacts.store.run_path) !== artifacts.run.run_id) {
    throw resumeError('Run ID does not match the resolved Run Directory.');
  }
  assertPlanIdentity(artifacts.run);
  const symbols = assertFrozenWatchlist(artifacts);
  assertExperimentArtifacts(artifacts);
  const auditInventory = _deps.auditExperimentInventory || auditExperimentDirectoryInventory;
  await auditInventory(artifacts, _deps.fs);
  await auditSucceededArtifacts(artifacts);
  const purePlan = buildResumePlan({
    run: artifacts.run,
    watchlist: artifacts.watchlist,
    experiments: artifacts.experiments,
    manifests: artifacts.manifests,
  });
  if (purePlan.setup_required) {
    throw resumeError('Resume requires complete persisted Experiment plans.');
  }
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

async function readPersistedPineSource(run, _deps = {}) {
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
      run.resolved.strategy.source_sha256,
    ]);
    if (expected.size !== 1 || !expected.has(sourceSha256)) {
      throw identityError('Local Pine source hash differs from the persisted Run.');
    }
    return Object.freeze({ path, source, source_sha256: sourceSha256 });
  } catch (error) {
    if (error?.code === 'RUN_RESUME_IDENTITY_MISMATCH') throw error;
    throw identityError(`Unable to verify persisted Pine source: ${path}.`, error);
  }
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
    const identity = await resolveStrategyResumeIdentity({
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
