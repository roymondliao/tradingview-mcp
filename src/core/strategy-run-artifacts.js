/** Durable filesystem store for versioned formal Strategy Run artifacts. */
import { createWriteStream as nodeCreateWriteStream } from 'node:fs';
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readFile as nodeReadFile,
  readdir as nodeReaddir,
  rename as nodeRename,
  rm as nodeRm,
  stat as nodeStat,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  join,
  resolve,
  sep,
} from 'node:path';
import { CoreOperationError } from './errors.js';
import { stableJsonStringify } from './stable-json.js';
import {
  assertSafeRelativeArtifactPath,
  safeSymbolPathSegment,
} from './artifacts.js';
import {
  STRATEGY_RUN_ARTIFACT_FAMILIES,
  strategyRunArtifactFamily,
  validateExperimentArtifact,
  validateExperimentManifest,
  validateRunArtifact,
} from './strategy-run-state.js';
import {
  WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS,
  WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS,
} from './watchlist.js';

export const STRATEGY_RUN_STATE_JSON_MAX_BYTES = 8 * 1024 * 1024;

const RUN_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const PARAMETER_SET_NAME_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const OUTPUT_FORMATS = Object.freeze(['json', 'jsonl', 'csv']);
const REQUIRED_SYMBOL_ARTIFACTS = Object.freeze(['report', 'trades', 'reconciliation']);

function operationError(message, {
  code = 'OUTPUT_WRITE_FAILED',
  phase = 'artifact_state_write',
  cause,
} = {}) {
  return new CoreOperationError(message, { code, phase, cause });
}

function artifactInvalid(message, cause) {
  return operationError(message, {
    code: 'RUN_RESUME_ARTIFACT_INVALID',
    phase: 'resume_validation',
    cause,
  });
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

function isAlreadyExists(error) {
  return error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY';
}

function assertRunId(value, { resume = false } = {}) {
  const runId = String(value ?? '').trim();
  if (!runId || runId === '.' || runId === '..' || !RUN_ID_PATTERN.test(runId)) {
    if (resume) throw artifactInvalid('Run Directory name must be one safe Run ID segment.');
    throw operationError('run_id must be one safe path segment.', {
      code: 'RUN_OUTPUT_INVALID',
      phase: 'output_validation',
    });
  }
  return runId;
}

function assertExperimentName(value) {
  const name = String(value ?? '').trim();
  if (!PARAMETER_SET_NAME_PATTERN.test(name)) {
    throw artifactInvalid('Experiment name must be one safe path segment.');
  }
  return name;
}

function assertOutputFormat(value) {
  const format = String(value ?? '').trim();
  if (!OUTPUT_FORMATS.includes(format)) {
    throw artifactInvalid(`Symbol artifact format must be one of: ${OUTPUT_FORMATS.join(', ')}.`);
  }
  return format;
}

function filesystemDeps(_deps = {}) {
  return {
    createWriteStream: nodeCreateWriteStream,
    lstat: nodeLstat,
    mkdir: nodeMkdir,
    open: nodeOpen,
    readFile: nodeReadFile,
    readdir: nodeReaddir,
    rename: nodeRename,
    rm: nodeRm,
    stat: nodeStat,
    writeFile: nodeWriteFile,
    uuid: nodeRandomUUID,
    ..._deps,
  };
}

function safePathInside(root, relativePath) {
  const safeRelative = assertSafeRelativeArtifactPath(relativePath);
  const path = resolve(root, safeRelative);
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw artifactInvalid(`Artifact path escaped the Run Directory: ${relativePath}`);
  }
  return { safeRelative, path };
}

function assertRunDirectoryInput(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw artifactInvalid('Run Directory is required.');
  }
  return resolve(value);
}

async function lstatOptional(path, deps) {
  try {
    return await deps.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function ensureSafeDirectoryChain(root, relativeDirectory, deps, { create = false } = {}) {
  assertDirectory(await deps.lstat(root), `Run Directory ${root}`);
  const safeRelative = assertSafeRelativeArtifactPath(relativeDirectory);
  const segments = safeRelative.split(sep);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let info = await lstatOptional(current, deps);
    if (!info && create) {
      try {
        await deps.mkdir(current, { recursive: false });
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
      }
      info = await deps.lstat(current);
    }
    if (!info) return false;
    assertDirectory(info, `Artifact directory ${current}`);
  }
  return true;
}

function assertRegularFile(info, label) {
  if (!info || info.isSymbolicLink() || !info.isFile()) {
    throw artifactInvalid(`${label} must be a regular non-symlink file.`);
  }
}

function assertDirectory(info, label) {
  if (!info || info.isSymbolicLink() || !info.isDirectory()) {
    throw artifactInvalid(`${label} must be a non-symlink directory.`);
  }
}

async function syncDirectoryBestEffort(directory, deps) {
  let handle = null;
  try {
    handle = await deps.open(directory, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is not supported consistently on every platform.
  } finally {
    try {
      await handle?.close();
    } catch {
      // The durable file/rename operations remain the primary result.
    }
  }
}

export async function atomicReplaceJson({
  path,
  value,
  max_bytes = STRATEGY_RUN_STATE_JSON_MAX_BYTES,
  _deps = {},
} = {}) {
  if (typeof path !== 'string' || !path.trim()) {
    throw operationError('A JSON artifact path is required.');
  }
  const deps = filesystemDeps(_deps);
  const outputPath = resolve(path);
  const directory = dirname(outputPath);
  let serialized;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch (error) {
    throw operationError(`JSON artifact is not serializable: ${outputPath}`, { cause: error });
  }
  if (typeof serialized !== 'string') {
    throw operationError(`JSON artifact must have a serializable value: ${outputPath}`);
  }
  const content = `${serialized}\n`;
  if (Buffer.byteLength(content, 'utf8') > max_bytes) {
    throw operationError(`JSON artifact exceeds the ${max_bytes}-byte limit: ${outputPath}`, {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'artifact_state_write',
    });
  }
  const temporaryPath = join(
    directory,
    `.${basename(outputPath)}.${process.pid}.${deps.uuid()}.tmp`,
  );
  try {
    await deps.mkdir(directory, { recursive: true });
    const directoryInfo = await deps.lstat(directory);
    assertDirectory(directoryInfo, `Artifact directory ${directory}`);
    const existing = await lstatOptional(outputPath, deps);
    if (existing) assertRegularFile(existing, `JSON artifact ${outputPath}`);
    await deps.writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      flush: true,
    });
    await deps.rename(temporaryPath, outputPath);
    await syncDirectoryBestEffort(directory, deps);
    return outputPath;
  } catch (error) {
    try {
      await deps.rm(temporaryPath, { force: true });
    } catch {
      // Preserve the primary atomic-write error.
    }
    if (error instanceof CoreOperationError) throw error;
    throw operationError(`Failed to atomically replace JSON artifact: ${outputPath}`, {
      cause: error,
    });
  }
}

export async function readBoundedJson({
  path,
  label = 'JSON artifact',
  required = true,
  max_bytes = STRATEGY_RUN_STATE_JSON_MAX_BYTES,
  _deps = {},
} = {}) {
  const deps = filesystemDeps(_deps);
  const inputPath = resolve(String(path || ''));
  let info;
  try {
    info = await deps.lstat(inputPath);
  } catch (error) {
    if (isMissing(error) && !required) return null;
    if (isMissing(error)) throw artifactInvalid(`${label} is missing: ${inputPath}`, error);
    throw artifactInvalid(`Unable to inspect ${label}: ${inputPath}`, error);
  }
  assertRegularFile(info, label);
  if (info.size > max_bytes) {
    throw artifactInvalid(`${label} exceeds the ${max_bytes}-byte limit.`);
  }
  let raw;
  try {
    raw = await deps.readFile(inputPath, 'utf8');
  } catch (error) {
    throw artifactInvalid(`Unable to read ${label}: ${inputPath}`, error);
  }
  if (Buffer.byteLength(raw, 'utf8') > max_bytes) {
    throw artifactInvalid(`${label} exceeds the ${max_bytes}-byte limit.`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw artifactInvalid(`${label} must contain valid JSON.`, error);
  }
}

function experimentRoot(name) {
  return `experiments/${assertExperimentName(name)}`;
}

function symbolPaths({ experiment_name, symbol, format }) {
  const name = assertExperimentName(experiment_name);
  const safeSymbol = safeSymbolPathSegment(symbol);
  const resolvedFormat = assertOutputFormat(format);
  const directory = `experiments/${name}/symbols/${safeSymbol}`;
  return Object.freeze({
    experiment_name: name,
    safe_symbol: safeSymbol,
    format: resolvedFormat,
    directory,
    report: `${directory}/report.json`,
    trades: `${directory}/trades.${resolvedFormat}`,
    reconciliation: `${directory}/reconciliation.json`,
  });
}

function createStore({ runPath, runId, deps, created }) {
  const artifactPath = (relativePath) => safePathInside(runPath, relativePath);
  let artifactFamily = null;

  function bindArtifactFamily(family) {
    if (!STRATEGY_RUN_ARTIFACT_FAMILIES.includes(family)) {
      throw artifactInvalid(`Unsupported Run Directory artifact family: ${String(family)}.`);
    }
    if (artifactFamily != null && artifactFamily !== family) {
      throw artifactInvalid(
        `Artifact family ${family} does not match Run Directory family ${artifactFamily}.`,
      );
    }
    artifactFamily = family;
    return family;
  }

  async function ensureArtifactParent(relativePath) {
    const safeRelative = assertSafeRelativeArtifactPath(relativePath);
    const parent = dirname(safeRelative);
    if (parent !== '.') await ensureSafeDirectoryChain(runPath, parent, deps, { create: true });
  }

  async function writeExclusiveJson(relativePath, value) {
    const target = artifactPath(relativePath);
    await ensureArtifactParent(target.safeRelative);
    const existing = await lstatOptional(target.path, deps);
    if (existing) throw artifactInvalid(`Artifact already exists: ${target.safeRelative}`);
    return atomicReplaceJson({ path: target.path, value, _deps: deps });
  }

  return Object.freeze({
    run_id: runId,
    run_path: runPath,
    created,

    bindArtifactFamily,

    artifactPath(relativePath) {
      return artifactPath(relativePath).path;
    },

    async writeInitialWatchlist(watchlist) {
      return writeExclusiveJson('watchlist.json', assertWatchlistArtifact(watchlist));
    },

    async replaceWatchlist(watchlist) {
      const validated = assertWatchlistArtifact(watchlist);
      const path = artifactPath('watchlist.json').path;
      const current = assertWatchlistArtifact(await readBoundedJson({
        path,
        label: 'watchlist.json',
        _deps: deps,
      }));
      const { symbol_validation: currentValidation, ...currentIdentity } = current;
      const { symbol_validation: nextValidation, ...nextIdentity } = validated;
      if (stableJsonStringify(currentIdentity) !== stableJsonStringify(nextIdentity)) {
        throw artifactInvalid(
          'Validated Watchlist replacement may only change symbol_validation.',
        );
      }
      if (currentValidation?.performed === true) {
        throw artifactInvalid('Completed Watchlist Symbol validation is immutable.');
      }
      if (nextValidation?.performed !== true) {
        throw artifactInvalid('Watchlist replacement requires completed Symbol validation.');
      }
      return atomicReplaceJson({ path, value: validated, _deps: deps });
    },

    async replaceRun(run) {
      const validated = validateRunArtifact(run);
      if (validated.run_id !== runId) throw artifactInvalid('run.json Run ID does not match the store.');
      if (
        validated.requested?.output?.run_path != null
        && resolve(String(validated.requested.output.run_path)) !== runPath
      ) {
        throw artifactInvalid('run.json requested output path does not match the store.');
      }
      bindArtifactFamily(strategyRunArtifactFamily(validated, 'run.json'));
      return atomicReplaceJson({ path: artifactPath('run.json').path, value: validated, _deps: deps });
    },

    async createExperiment(experiment) {
      const validated = validateExperimentArtifact(experiment);
      if (validated.run_id !== runId) {
        throw artifactInvalid('experiment.json Run ID does not match the store.');
      }
      bindArtifactFamily(strategyRunArtifactFamily(validated, 'experiment.json'));
      return writeExclusiveJson(
        `${experimentRoot(validated.parameter_set.name)}/experiment.json`,
        validated,
      );
    },

    async replaceManifest(manifest) {
      const validated = validateExperimentManifest(manifest);
      if (validated.run_id !== runId) {
        throw artifactInvalid('manifest.json Run ID does not match the store.');
      }
      bindArtifactFamily(strategyRunArtifactFamily(validated, 'manifest.json'));
      const relativePath = `${experimentRoot(validated.parameter_set_name)}/manifest.json`;
      await ensureArtifactParent(relativePath);
      return atomicReplaceJson({
        path: artifactPath(relativePath).path,
        value: validated,
        _deps: deps,
      });
    },

    async artifactInfo(relativePath) {
      const target = artifactPath(relativePath);
      const info = await deps.lstat(target.path);
      assertRegularFile(info, target.safeRelative);
      return Object.freeze({
        relative_path: target.safeRelative.split(sep).join('/'),
        path: target.path,
        bytes: info.size,
      });
    },

    beginSymbolAttempt(options) {
      return beginSymbolAttempt({
        ...options,
        run_directory: runPath,
        _deps: deps,
      });
    },

    cleanupUncommittedSymbolArtifacts(options) {
      return cleanupUncommittedSymbolArtifacts({
        ...options,
        run_directory: runPath,
        _deps: deps,
      });
    },

    verifySucceededSymbolArtifacts(options) {
      return verifySucceededSymbolArtifacts({
        ...options,
        run_directory: runPath,
        _deps: deps,
      });
    },
  });
}

export async function createDurableRunStore({
  output_directory,
  run_id,
  _deps = {},
} = {}) {
  if (typeof output_directory !== 'string' || !output_directory.trim()) {
    throw operationError('An output directory is required.', {
      code: 'RUN_OUTPUT_INVALID',
      phase: 'output_validation',
    });
  }
  const deps = filesystemDeps(_deps);
  const outputDirectory = resolve(output_directory);
  const runId = assertRunId(run_id);
  const runPath = join(outputDirectory, runId);
  try {
    await deps.mkdir(outputDirectory, { recursive: true });
    assertDirectory(await deps.lstat(outputDirectory), `Output directory ${outputDirectory}`);
    await deps.mkdir(runPath, { recursive: false });
    await syncDirectoryBestEffort(outputDirectory, deps);
    return createStore({ runPath, runId, deps, created: true });
  } catch (error) {
    if (error instanceof CoreOperationError) throw error;
    if (isAlreadyExists(error)) {
      throw operationError(`Run output already exists: ${runPath}`, {
        code: 'RUN_OUTPUT_EXISTS',
        phase: 'output_validation',
        cause: error,
      });
    }
    throw operationError(`Failed to create durable Run Directory: ${runPath}`, {
      code: 'RUN_OUTPUT_INVALID',
      phase: 'output_validation',
      cause: error,
    });
  }
}

export async function openDurableRunStore({ run_directory, _deps = {} } = {}) {
  if (typeof run_directory !== 'string' || !run_directory.trim()) {
    throw operationError('Run Directory is required.', {
      code: 'RUN_RESUME_NOT_FOUND',
      phase: 'resume_load',
    });
  }
  const deps = filesystemDeps(_deps);
  const runPath = resolve(run_directory);
  let info;
  try {
    info = await deps.lstat(runPath);
  } catch (error) {
    if (isMissing(error)) {
      throw operationError(`Run Directory was not found: ${runPath}`, {
        code: 'RUN_RESUME_NOT_FOUND',
        phase: 'resume_load',
        cause: error,
      });
    }
    throw artifactInvalid(`Unable to inspect Run Directory: ${runPath}`, error);
  }
  assertDirectory(info, `Run Directory ${runPath}`);
  const runId = assertRunId(basename(runPath), { resume: true });
  return createStore({ runPath, runId, deps, created: false });
}

function assertWatchlistSymbolValidation(validation, symbols) {
  if (validation == null) return;
  if (!validation || typeof validation !== 'object' || Array.isArray(validation)) {
    throw artifactInvalid('watchlist.json.symbol_validation must be an object.');
  }
  if (validation.schema_version !== 1) {
    throw artifactInvalid('watchlist.json Symbol validation schema_version must be 1.');
  }
  if (typeof validation.timeframe !== 'string' || !validation.timeframe) {
    throw artifactInvalid('watchlist.json Symbol validation timeframe is required.');
  }
  if (validation.performed === false) {
    if (validation.reason !== 'pending') {
      throw artifactInvalid('Pending Watchlist Symbol validation reason must be pending.');
    }
    return;
  }
  if (validation.performed !== true || typeof validation.success !== 'boolean') {
    throw artifactInvalid('watchlist.json Symbol validation completion is invalid.');
  }
  if (
    validation.source !== 'tradingview_desktop_cdp'
    || validation.max_attempts !== WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS
    || validation.attempt_timeout_ms !== WATCHLIST_SYMBOL_VALIDATION_ATTEMPT_TIMEOUT_MS
  ) {
    throw artifactInvalid('watchlist.json Symbol validation policy is invalid.');
  }
  for (const field of ['requested', 'valid', 'failed', 'validated_at']) {
    if (!Number.isInteger(validation[field]) || validation[field] < 0) {
      throw artifactInvalid(`watchlist.json Symbol validation ${field} is invalid.`);
    }
  }
  if (
    validation.requested !== symbols.length
    || validation.valid + validation.failed !== validation.requested
    || validation.success !== (validation.failed === 0)
    || typeof validation.validated_at_iso !== 'string'
    || !Array.isArray(validation.errors)
    || validation.errors.length !== validation.failed
  ) {
    throw artifactInvalid('watchlist.json Symbol validation summary is inconsistent.');
  }
  const seen = new Set();
  for (const error of validation.errors) {
    if (
      !error || typeof error !== 'object' || Array.isArray(error)
      || !Number.isInteger(error.index) || error.index < 0 || error.index >= symbols.length
      || error.symbol !== symbols[error.index]
      || error.symbol.length > 500
      || seen.has(error.index)
      || !['WATCHLIST_SYMBOL_NOT_FOUND', 'WATCHLIST_SYMBOL_VALIDATION_TIMEOUT'].includes(error.code)
      || error.phase !== 'watchlist_symbol_validation'
      || !Number.isInteger(error.attempt_count)
      || error.attempt_count < 1
      || error.attempt_count > WATCHLIST_SYMBOL_VALIDATION_MAX_ATTEMPTS
      || typeof error.message !== 'string'
      || error.message.length > 500
    ) {
      throw artifactInvalid('watchlist.json Symbol validation error is invalid.');
    }
    if (error.diagnostics != null) {
      const diagnostics = error.diagnostics;
      const boundedStrings = [
        [diagnostics.api_symbol, 500],
        [diagnostics.metadata_identity, 500],
        [diagnostics.exchange, 200],
        [diagnostics.description, 500],
        [diagnostics.type, 200],
      ];
      if (
        !diagnostics || typeof diagnostics !== 'object' || Array.isArray(diagnostics)
        || boundedStrings.some(([value, maximum]) => (
          value != null && (typeof value !== 'string' || value.length > maximum)
        ))
        || !Number.isInteger(diagnostics.bar_count) || diagnostics.bar_count < 0
        || typeof diagnostics.invalid_ui !== 'boolean'
      ) {
        throw artifactInvalid('watchlist.json Symbol validation diagnostics are invalid.');
      }
    }
    seen.add(error.index);
  }
}

function assertWatchlistArtifact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw artifactInvalid('watchlist.json must be an object.');
  }
  if (!value.snapshot || typeof value.snapshot !== 'object' || Array.isArray(value.snapshot)) {
    throw artifactInvalid('watchlist.json.snapshot must be an object.');
  }
  if (value.snapshot.complete !== true) {
    throw artifactInvalid('watchlist.json Snapshot must be complete.');
  }
  if (typeof value.snapshot.snapshot_id !== 'string' || !value.snapshot.snapshot_id) {
    throw artifactInvalid('watchlist.json Snapshot ID is required.');
  }
  if (
    typeof value.snapshot.ordered_symbol_fingerprint !== 'string'
    || !value.snapshot.ordered_symbol_fingerprint
  ) {
    throw artifactInvalid('watchlist.json ordered Symbol fingerprint is required.');
  }
  if (!Array.isArray(value.symbols) || value.symbols.length === 0) {
    throw artifactInvalid('watchlist.json.symbols must be a non-empty array.');
  }
  const symbols = [];
  for (const [index, item] of value.symbols.entries()) {
    const symbol = typeof item === 'string' ? item : item?.symbol;
    if (typeof symbol !== 'string' || !symbol.trim()) {
      throw artifactInvalid(`watchlist.json.symbols[${index}] is invalid.`);
    }
    symbols.push(symbol);
  }
  if (new Set(symbols).size !== symbols.length) {
    throw artifactInvalid('watchlist.json.symbols must not contain duplicates.');
  }
  assertWatchlistSymbolValidation(value.symbol_validation, symbols);
  return value;
}

export async function readDurableRunArtifacts({ run_directory, _deps = {} } = {}) {
  const deps = filesystemDeps(_deps);
  const store = await openDurableRunStore({ run_directory, _deps: deps });
  let rawRun;
  try {
    rawRun = await readBoundedJson({
      path: store.artifactPath('run.json'),
      label: 'run.json',
      _deps: deps,
    });
  } catch (error) {
    if (error?.code === 'RUN_RESUME_ARTIFACT_INVALID' && error.cause?.code === 'ENOENT') {
      throw operationError(`Run metadata was not found: ${store.artifactPath('run.json')}`, {
        code: 'RUN_RESUME_NOT_FOUND',
        phase: 'resume_load',
        cause: error,
      });
    }
    throw error;
  }
  const run = validateRunArtifact(rawRun);
  const family = strategyRunArtifactFamily(run, 'run.json');
  store.bindArtifactFamily(family);
  if (run.run_id !== store.run_id) {
    throw artifactInvalid('run.json Run ID does not match the Run Directory name.');
  }
  if (
    run.requested?.output?.run_path != null
    && resolve(String(run.requested.output.run_path)) !== store.run_path
  ) {
    throw artifactInvalid('run.json requested output path does not match the Run Directory.');
  }
  const watchlist = assertWatchlistArtifact(await readBoundedJson({
    path: store.artifactPath('watchlist.json'),
    label: 'watchlist.json',
    _deps: deps,
  }));
  const watchlistSymbols = watchlist.symbols.map((item) => (
    typeof item === 'string' ? item : item.symbol
  ));
  if (watchlistSymbols.length !== run.resolved.watchlist.symbol_count) {
    throw artifactInvalid('watchlist.json Symbol count does not match run.json.');
  }
  if (
    watchlist.snapshot?.snapshot_id != null
    && watchlist.snapshot.snapshot_id !== run.resolved.watchlist.snapshot_id
  ) {
    throw artifactInvalid('watchlist.json Snapshot ID does not match run.json.');
  }
  if (
    run.resolved.watchlist.ordered_symbol_fingerprint != null
    && watchlist.snapshot?.ordered_symbol_fingerprint
      !== run.resolved.watchlist.ordered_symbol_fingerprint
  ) {
    throw artifactInvalid('watchlist.json ordered Symbol fingerprint does not match run.json.');
  }
  const experiments = [];
  const manifests = [];
  for (const plan of run.planned_experiments || []) {
    const name = assertExperimentName(plan.parameter_set?.name);
    const rootExists = await ensureSafeDirectoryChain(
      store.run_path,
      experimentRoot(name),
      deps,
    );
    if (!rootExists) continue;
    const experiment = await readBoundedJson({
      path: store.artifactPath(`${experimentRoot(name)}/experiment.json`),
      label: `Experiment ${name} experiment.json`,
      required: false,
      _deps: deps,
    });
    const manifest = await readBoundedJson({
      path: store.artifactPath(`${experimentRoot(name)}/manifest.json`),
      label: `Experiment ${name} manifest.json`,
      required: false,
      _deps: deps,
    });
    const validExperiment = experiment
      ? validateExperimentArtifact(experiment, { expected_family: family })
      : null;
    const validManifest = manifest
      ? validateExperimentManifest(manifest, { expected_family: family })
      : null;
    if (validExperiment) {
      if (
        validExperiment.run_id !== run.run_id
        || validExperiment.experiment_id !== plan.experiment_id
        || stableJsonStringify(validExperiment.parameter_set)
          !== stableJsonStringify(plan.parameter_set)
        || stableJsonStringify(validExperiment.inputs_fingerprint)
          !== stableJsonStringify(plan.inputs_fingerprint)
        || stableJsonStringify(validExperiment.effective_inputs)
          !== stableJsonStringify(plan.effective_inputs)
      ) {
        throw artifactInvalid(`Experiment identity does not match run.json: ${name}.`);
      }
      experiments.push(validExperiment);
    }
    if (validManifest) {
      if (!validExperiment) {
        throw artifactInvalid(`Manifest exists without experiment.json: ${name}.`);
      }
      if (
        validManifest.run_id !== run.run_id
        || validManifest.experiment_id !== plan.experiment_id
        || validManifest.parameter_set_name !== name
      ) {
        throw artifactInvalid(`Manifest identity does not match run.json: ${name}.`);
      }
      if (
        validManifest.requested_symbols.length !== watchlistSymbols.length
        || validManifest.requested_symbols.some((symbol, index) => symbol !== watchlistSymbols[index])
      ) {
        throw artifactInvalid(`Manifest Watchlist does not match watchlist.json: ${name}.`);
      }
      manifests.push(validManifest);
    }
  }
  return Object.freeze({
    store,
    run,
    watchlist: Object.freeze(watchlist),
    experiments: Object.freeze(experiments),
    manifests: Object.freeze(manifests),
  });
}

function attemptFilename(value) {
  const name = String(value ?? '');
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw artifactInvalid('Attempt artifact name must be one safe filename.');
  }
  return name;
}

function escapeRegularExpression(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function beginSymbolAttempt({
  run_directory,
  experiment_name,
  symbol,
  attempt_count,
  format,
  _deps = {},
} = {}) {
  if (!Number.isInteger(attempt_count) || attempt_count < 1) {
    throw artifactInvalid('Symbol attempt_count must be a positive integer.');
  }
  const deps = filesystemDeps(_deps);
  const runPath = assertRunDirectoryInput(run_directory);
  assertDirectory(await lstatOptional(runPath, deps), `Run Directory ${runPath}`);
  const paths = symbolPaths({ experiment_name, symbol, format });
  const symbolsDirectory = safePathInside(
    runPath,
    `${experimentRoot(paths.experiment_name)}/symbols`,
  ).path;
  const finalPath = safePathInside(runPath, paths.directory).path;
  const stagingName = `.${paths.safe_symbol}.attempt-${attempt_count}.staging`;
  const stagingPath = join(symbolsDirectory, stagingName);
  const streams = new Set();
  let state = 'creating';

  try {
    await ensureSafeDirectoryChain(
      runPath,
      `${experimentRoot(paths.experiment_name)}/symbols`,
      deps,
      { create: true },
    );
    const finalInfo = await lstatOptional(finalPath, deps);
    if (finalInfo) throw artifactInvalid(`Final Symbol directory already exists: ${finalPath}`);
    await deps.mkdir(stagingPath, { recursive: false });
    state = 'open';
  } catch (error) {
    if (error instanceof CoreOperationError) throw error;
    throw operationError(`Failed to create Symbol attempt staging: ${stagingPath}`, {
      cause: error,
    });
  }

  function stagingArtifact(name) {
    const filename = attemptFilename(name);
    return { filename, path: join(stagingPath, filename) };
  }

  function finalRelative(name) {
    return `${paths.directory}/${attemptFilename(name)}`;
  }

  return Object.freeze({
    state: () => state,
    staging_path: stagingPath,
    final_path: finalPath,
    relative_directory: paths.directory,
    format: paths.format,

    async openArtifact(name) {
      if (state !== 'open') throw new Error(`Symbol attempt is ${state}.`);
      const target = stagingArtifact(name);
      const writable = deps.createWriteStream(target.path, {
        encoding: 'utf8',
        flags: 'wx',
        flush: true,
      });
      streams.add(writable);
      writable.once('close', () => streams.delete(writable));
      return writable;
    },

    async writeJson(name, value) {
      if (state !== 'open') throw new Error(`Symbol attempt is ${state}.`);
      const target = stagingArtifact(name);
      try {
        await deps.writeFile(target.path, `${JSON.stringify(value, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
          flush: true,
        });
      } catch (error) {
        throw operationError(`Failed to write Symbol attempt artifact: ${target.filename}`, {
          cause: error,
        });
      }
      return target.path;
    },

    async artifactInfo(name) {
      const target = stagingArtifact(name);
      const info = await deps.lstat(target.path);
      assertRegularFile(info, `Symbol artifact ${target.filename}`);
      return Object.freeze({
        relative_path: finalRelative(target.filename),
        path: join(finalPath, target.filename),
        bytes: info.size,
      });
    },

    async commit() {
      if (state !== 'open') throw new Error(`Symbol attempt is ${state}.`);
      if (streams.size > 0) {
        throw operationError('Cannot commit while a Symbol artifact stream is still open.', {
          phase: 'artifact_publish',
        });
      }
      const required = [
        'report.json',
        `trades.${paths.format}`,
        'reconciliation.json',
      ];
      try {
        for (const name of required) {
          assertRegularFile(
            await deps.lstat(stagingArtifact(name).path),
            `Symbol artifact ${name}`,
          );
        }
        const finalInfo = await lstatOptional(finalPath, deps);
        if (finalInfo) throw artifactInvalid(`Final Symbol directory already exists: ${finalPath}`);
        await deps.rename(stagingPath, finalPath);
        await syncDirectoryBestEffort(symbolsDirectory, deps);
        state = 'committed';
        return Object.freeze({
          path: finalPath,
          relative_path: paths.directory,
          atomic: true,
        });
      } catch (error) {
        if (error instanceof CoreOperationError) throw error;
        throw operationError(`Failed to commit Symbol attempt: ${finalPath}`, {
          phase: 'artifact_publish',
          cause: error,
        });
      }
    },

    async abort() {
      if (state === 'committed' || state === 'aborted') return;
      state = 'aborted';
      for (const stream of streams) {
        if (!stream.destroyed) stream.destroy();
      }
      try {
        await deps.rm(stagingPath, { recursive: true, force: true });
      } catch (error) {
        throw operationError(`Failed to remove Symbol attempt staging: ${stagingPath}`, {
          phase: 'artifact_abort',
          cause: error,
        });
      }
    },
  });
}

export async function cleanupUncommittedSymbolArtifacts({
  run_directory,
  experiment_name,
  symbol,
  manifest_entry = null,
  ownership_confirmed = false,
  _deps = {},
} = {}) {
  if (!ownership_confirmed) {
    throw artifactInvalid('Run ownership must be confirmed before Symbol cleanup.');
  }
  if (manifest_entry?.status === 'succeeded') {
    throw artifactInvalid('A succeeded Symbol directory is immutable and cannot be cleaned.');
  }
  const deps = filesystemDeps(_deps);
  const runPath = assertRunDirectoryInput(run_directory);
  const name = assertExperimentName(experiment_name);
  const safeSymbol = safeSymbolPathSegment(symbol);
  const symbolsDirectory = safePathInside(
    runPath,
    `${experimentRoot(name)}/symbols`,
  ).path;
  const directoryExists = await ensureSafeDirectoryChain(
    runPath,
    `${experimentRoot(name)}/symbols`,
    deps,
  );
  if (!directoryExists) return Object.freeze({ removed: Object.freeze([]) });
  const entries = await deps.readdir(symbolsDirectory, { withFileTypes: true });
  const stagingPattern = new RegExp(
    `^\\.${escapeRegularExpression(safeSymbol)}\\.attempt-[1-9][0-9]*\\.staging$`,
  );
  const targets = [];
  for (const entry of entries) {
    if (entry.name === safeSymbol) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw artifactInvalid(`Uncommitted Symbol path is not a directory: ${entry.name}`);
      }
      targets.push(join(symbolsDirectory, entry.name));
    } else if (stagingPattern.test(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw artifactInvalid(`Symbol staging path is not a directory: ${entry.name}`);
      }
      targets.push(join(symbolsDirectory, entry.name));
    }
  }
  try {
    for (const target of targets) await deps.rm(target, { recursive: true, force: false });
  } catch (error) {
    throw operationError('Failed to clean uncommitted Symbol artifacts.', {
      code: 'RUN_RESUME_ARTIFACT_INVALID',
      phase: 'artifact_cleanup',
      cause: error,
    });
  }
  return Object.freeze({ removed: Object.freeze(targets) });
}

export async function verifySucceededSymbolArtifacts({
  run_directory,
  manifest,
  entry,
  _deps = {},
} = {}) {
  const validManifest = validateExperimentManifest(manifest);
  if (!entry || entry.status !== 'succeeded') {
    throw artifactInvalid('Only a succeeded Symbol entry can be verified.');
  }
  const stored = validManifest.symbols.find((item) => item.index === entry.index);
  if (!stored || stored.status !== 'succeeded') {
    throw artifactInvalid('Succeeded Symbol entry does not belong to the manifest.');
  }
  const deps = filesystemDeps(_deps);
  const runPath = assertRunDirectoryInput(run_directory);
  const expected = symbolPaths({
    experiment_name: validManifest.parameter_set_name,
    symbol: stored.requested_symbol,
    format: validManifest.format,
  });
  const expectedReferences = {
    report: expected.report,
    trades: expected.trades,
    reconciliation: expected.reconciliation,
  };
  const verified = {};
  for (const name of REQUIRED_SYMBOL_ARTIFACTS) {
    if (stored.artifacts[name] !== expectedReferences[name]) {
      throw artifactInvalid(`Succeeded Symbol ${name} path does not match its canonical path.`);
    }
    await ensureSafeDirectoryChain(runPath, dirname(stored.artifacts[name]), deps);
    const target = safePathInside(runPath, stored.artifacts[name]);
    let info;
    try {
      info = await deps.lstat(target.path);
    } catch (error) {
      throw artifactInvalid(`Succeeded Symbol artifact is missing: ${target.safeRelative}`, error);
    }
    assertRegularFile(info, `Succeeded Symbol artifact ${target.safeRelative}`);
    verified[name] = Object.freeze({
      relative_path: target.safeRelative.split(sep).join('/'),
      path: target.path,
      bytes: info.size,
    });
  }
  return Object.freeze(verified);
}
