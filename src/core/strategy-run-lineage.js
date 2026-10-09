/** Read-only Strategy Run lineage loading, bounds, and stable fingerprints. */
import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  lstat as nodeLstat,
  realpath as nodeRealpath,
} from 'node:fs/promises';
import { CoreOperationError } from './errors.js';
import {
  readDurableRunArtifacts,
  verifySucceededSymbolArtifacts,
} from './strategy-run-artifacts.js';
import {
  stableDurableStrategyIdentity,
  stableDurableTargetIdentity,
} from './strategy-durable-experiment.js';
import { deriveRunSummary, strategyRunArtifactFamily } from './strategy-run-state.js';
import { sha256Hex, stableJsonStringify } from './stable-json.js';

export const STRATEGY_RUN_LINEAGE_MAX_DEPTH = 64;
export const STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS = 4096;
export const STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES = 64 * 1024 * 1024;
export const STRATEGY_RUN_LINEAGE_FINGERPRINT_VERSION = 1;

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function lineageError(message, {
  code = 'RUN_EXTENSION_LINEAGE_INVALID',
  phase = 'extension_lineage',
  cause,
} = {}) {
  return new CoreOperationError(message, { code, phase, cause });
}

function sha256Identity(value) {
  return `sha256:${sha256Hex(value)}`;
}

function parameterSetProjection(parameterSet) {
  return Object.freeze({
    name: parameterSet?.name,
    inputs: parameterSet?.inputs || {},
  });
}

export function strategyParameterSetsFingerprint(parameterSets) {
  if (!Array.isArray(parameterSets)) {
    throw lineageError('Lineage Parameter Sets must be an array.');
  }
  return sha256Identity(parameterSets.map(parameterSetProjection));
}

function artifactSchemaVersion(run) {
  const family = strategyRunArtifactFamily(run, 'run.json');
  if (family === 'v2') return 2;
  return run.artifact_schema_version;
}

export function strategyRunFingerprintProjection(run) {
  const requestedParameterSets = run?.requested?.experiments?.parameter_sets;
  const plannedExperiments = run?.planned_experiments;
  if (run?.status !== 'succeeded' || !Array.isArray(requestedParameterSets)) {
    throw lineageError('Only a complete succeeded Run can be fingerprinted.');
  }
  if (!Array.isArray(plannedExperiments) || plannedExperiments.length !== requestedParameterSets.length) {
    throw lineageError('Succeeded Run plans do not match requested Parameter Sets.');
  }
  return Object.freeze({
    fingerprint_schema_version: STRATEGY_RUN_LINEAGE_FINGERPRINT_VERSION,
    run_id: run.run_id,
    artifact_schema_version: artifactSchemaVersion(run),
    run_kind: run.run_kind || 'standalone',
    status: 'succeeded',
    source_sha256: run.source_sha256,
    candidate_schema_fingerprint: run.candidate_schema_fingerprint,
    target: stableDurableTargetIdentity(run.resolved?.target),
    strategy: stableDurableStrategyIdentity(run.resolved?.strategy),
    base_inputs_fingerprint: run.base_inputs_fingerprint,
    watchlist: Object.freeze({
      snapshot_id: run.resolved?.watchlist?.snapshot_id,
      ordered_symbol_fingerprint: run.resolved?.watchlist?.ordered_symbol_fingerprint,
      symbol_count: run.resolved?.watchlist?.symbol_count,
    }),
    requested_parameter_sets: Object.freeze(requestedParameterSets.map(parameterSetProjection)),
    planned_experiments: Object.freeze(plannedExperiments.map((plan) => Object.freeze({
      name: plan.parameter_set?.name,
      requested_inputs_fingerprint: plan.parameter_set?.requested_inputs_fingerprint,
      inputs_fingerprint: plan.inputs_fingerprint,
    }))),
  });
}

export function strategyRunFingerprint(run) {
  return sha256Identity(strategyRunFingerprintProjection(run));
}

export function strategyLineageFingerprint({
  direct_parent_run_fingerprint,
  parent_lineage_fingerprint = null,
  inherited_parameter_sets_fingerprint,
  inherited_experiment_count,
  lineage_depth,
} = {}) {
  return sha256Identity({
    fingerprint_schema_version: STRATEGY_RUN_LINEAGE_FINGERPRINT_VERSION,
    direct_parent_run_fingerprint,
    parent_lineage_fingerprint,
    inherited_parameter_sets_fingerprint,
    inherited_experiment_count,
    lineage_depth,
  });
}

function assertSafeRunId(value, label = 'Parent Run ID') {
  if (
    typeof value !== 'string'
    || !RUN_ID_PATTERN.test(value)
    || value === '.'
    || value === '..'
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw lineageError(`${label} must be one safe path segment.`);
  }
  return value;
}

function valuesEqual(left, right) {
  return stableJsonStringify(left) === stableJsonStringify(right);
}

async function stateJsonBytes(artifacts, deps) {
  const relativePaths = ['run.json', 'watchlist.json'];
  for (const plan of artifacts.run.planned_experiments || []) {
    const name = assertSafeRunId(plan.parameter_set.name, 'Parameter Set name');
    relativePaths.push(
      `experiments/${name}/experiment.json`,
      `experiments/${name}/manifest.json`,
    );
  }
  let total = 0;
  for (const relativePath of relativePaths) {
    let info;
    try {
      info = await deps.lstat(artifacts.store.artifactPath(relativePath));
    } catch (error) {
      throw lineageError(`Required Parent artifact is missing: ${relativePath}`, { cause: error });
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw lineageError(`Required Parent artifact is not a regular file: ${relativePath}`);
    }
    total += info.size;
  }
  return total;
}

function assertSucceededEvidence(artifacts) {
  const { run, manifests, experiments } = artifacts;
  if (run.status !== 'succeeded') {
    throw lineageError(`Parent Run is not succeeded: ${run.run_id}`, {
      code: 'RUN_EXTENSION_PARENT_NOT_SUCCEEDED',
    });
  }
  if (
    !Array.isArray(run.planned_experiments)
    || manifests.length !== run.planned_experiments.length
    || experiments.length !== run.planned_experiments.length
    || manifests.some((manifest) => manifest.status !== 'succeeded')
  ) {
    throw lineageError(`Parent Run evidence is incomplete: ${run.run_id}`);
  }
  const derived = deriveRunSummary({ run, manifests });
  if (!valuesEqual(derived, run.summary)) {
    throw lineageError(`Parent Run summary does not match its manifests: ${run.run_id}`);
  }
}

function validateExtensionChain(chain) {
  const inherited = [];
  for (let index = 0; index < chain.length; index += 1) {
    const entry = chain[index];
    const { run } = entry.artifacts;
    const runKind = run.run_kind || 'standalone';
    if (index === 0 && runKind !== 'standalone') {
      throw lineageError('Strategy Run lineage must terminate at a standalone root.');
    }
    if (index > 0 && runKind !== 'extension') {
      throw lineageError('Only the lineage root may be a standalone Run.');
    }
    if (runKind === 'extension') {
      const parent = chain[index - 1];
      const extension = run.extension;
      const expectedDepth = index;
      const inheritedFingerprint = strategyParameterSetsFingerprint(inherited);
      const parentRunFingerprint = strategyRunFingerprint(parent.artifacts.run);
      const parentLineageFingerprint = parent.artifacts.run.run_kind === 'extension'
        ? parent.artifacts.run.extension.lineage_fingerprint
        : null;
      const expectedLineageFingerprint = strategyLineageFingerprint({
        direct_parent_run_fingerprint: parentRunFingerprint,
        parent_lineage_fingerprint: parentLineageFingerprint,
        inherited_parameter_sets_fingerprint: inheritedFingerprint,
        inherited_experiment_count: inherited.length,
        lineage_depth: expectedDepth,
      });
      if (
        extension.parent_run_id !== parent.artifacts.run.run_id
        || extension.parent_artifact_schema_version !== artifactSchemaVersion(parent.artifacts.run)
        || extension.parent_run_fingerprint !== parentRunFingerprint
        || extension.lineage_depth !== expectedDepth
        || extension.inherited_experiment_count !== inherited.length
        || extension.inherited_parameter_sets_fingerprint !== inheritedFingerprint
        || extension.lineage_fingerprint !== expectedLineageFingerprint
      ) {
        throw lineageError(`Extension lineage fingerprint or counts are inconsistent: ${run.run_id}`);
      }
    }
    inherited.push(...run.requested.experiments.parameter_sets.map(parameterSetProjection));
    if (
      runKind === 'extension'
      && run.extension.requested_parameter_sets_fingerprint
        !== strategyParameterSetsFingerprint(inherited)
    ) {
      throw lineageError(`Extension requested Parameter Set fingerprint is inconsistent: ${run.run_id}`);
    }
  }
  return Object.freeze(inherited);
}

/** Load root→direct Parent and validate every immutable lineage edge. */
export async function loadStrategyRunLineage({ run_directory, _deps = {} } = {}) {
  if (typeof run_directory !== 'string' || !run_directory.trim()) {
    throw lineageError('Parent Run Directory is required.', {
      code: 'RUN_EXTENSION_PARENT_NOT_FOUND',
    });
  }
  const deps = {
    lstat: nodeLstat,
    realpath: nodeRealpath,
    readArtifacts: readDurableRunArtifacts,
    verifySucceededSymbolArtifacts,
    ..._deps,
  };
  const directParentPath = resolve(run_directory);
  const outputRoot = dirname(directParentPath);
  try {
    const [parentInfo, rootInfo] = await Promise.all([
      deps.lstat(directParentPath),
      deps.lstat(outputRoot),
    ]);
    if (
      parentInfo.isSymbolicLink()
      || !parentInfo.isDirectory()
      || rootInfo.isSymbolicLink()
      || !rootInfo.isDirectory()
    ) {
      throw lineageError('Parent and output root must be non-symlink directories.');
    }
    const [canonicalParent, canonicalRoot] = await Promise.all([
      deps.realpath(directParentPath),
      deps.realpath(outputRoot),
    ]);
    if (canonicalParent !== directParentPath || canonicalRoot !== outputRoot) {
      throw lineageError('Parent and output root paths must already be canonical.');
    }
  } catch (error) {
    if (error instanceof CoreOperationError) throw error;
    throw lineageError(`Parent Run Directory was not found: ${directParentPath}`, {
      code: 'RUN_EXTENSION_PARENT_NOT_FOUND',
      cause: error,
    });
  }

  const reversed = [];
  const visitedIds = new Set();
  const visitedPaths = new Set();
  let currentPath = directParentPath;
  let cumulativeBytes = 0;
  let cumulativeExperiments = 0;
  while (true) {
    if (reversed.length > STRATEGY_RUN_LINEAGE_MAX_DEPTH) {
      throw lineageError('Strategy Run lineage exceeds the maximum Extension depth.', {
        code: 'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED',
      });
    }
    if (visitedPaths.has(currentPath)) {
      throw lineageError('Strategy Run lineage contains a path cycle.');
    }
    visitedPaths.add(currentPath);
    let artifacts;
    try {
      artifacts = await deps.readArtifacts({
        run_directory: currentPath,
        _deps: _deps.artifacts,
      });
    } catch (error) {
      throw lineageError(`Unable to load Parent lineage Run: ${currentPath}`, { cause: error });
    }
    assertSucceededEvidence(artifacts);
    for (const manifest of artifacts.manifests) {
      for (const entry of manifest.symbols) {
        await deps.verifySucceededSymbolArtifacts({
          run_directory: currentPath,
          manifest,
          entry,
          _deps: _deps.artifacts,
        });
      }
    }
    if (visitedIds.has(artifacts.run.run_id)) {
      throw lineageError(`Strategy Run lineage contains duplicate Run ID: ${artifacts.run.run_id}`);
    }
    visitedIds.add(artifacts.run.run_id);
    if (join(outputRoot, artifacts.run.run_id) !== currentPath) {
      throw lineageError('A lineage Run escaped the common output root.');
    }
    cumulativeBytes += await stateJsonBytes(artifacts, deps);
    cumulativeExperiments += artifacts.run.requested.experiments.parameter_sets.length;
    if (
      cumulativeBytes > STRATEGY_RUN_LINEAGE_MAX_JSON_BYTES
      || cumulativeExperiments > STRATEGY_RUN_LINEAGE_MAX_EXPERIMENTS
    ) {
      throw lineageError('Strategy Run lineage exceeds its bounded read limits.', {
        code: 'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED',
      });
    }
    reversed.push(Object.freeze({ path: currentPath, artifacts }));
    if ((artifacts.run.run_kind || 'standalone') === 'standalone') break;
    const parentRunId = assertSafeRunId(artifacts.run.extension?.parent_run_id);
    currentPath = join(outputRoot, parentRunId);
  }

  const chain = Object.freeze(reversed.reverse());
  const parameterSets = validateExtensionChain(chain);
  const parent = chain.at(-1);
  const lineageDepth = chain.length - 1;
  if (lineageDepth >= STRATEGY_RUN_LINEAGE_MAX_DEPTH) {
    throw lineageError('The next Extension would exceed the maximum lineage depth.', {
      code: 'RUN_EXTENSION_LINEAGE_LIMIT_EXCEEDED',
    });
  }
  return Object.freeze({
    output_root: outputRoot,
    parent_directory: directParentPath,
    chain,
    parent: parent.artifacts,
    parameter_sets: parameterSets,
    inherited_experiment_count: parameterSets.length,
    inherited_parameter_sets_fingerprint: strategyParameterSetsFingerprint(parameterSets),
    parent_run_fingerprint: strategyRunFingerprint(parent.artifacts.run),
    parent_lineage_fingerprint: parent.artifacts.run.run_kind === 'extension'
      ? parent.artifacts.run.extension.lineage_fingerprint
      : null,
    lineage_depth: lineageDepth,
    cumulative_json_bytes: cumulativeBytes,
  });
}
