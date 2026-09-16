/** Strict Strategy Automation Run Config v1 loading and filesystem validation. */
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { lstat as nodeLstat, readFile as nodeReadFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { normalizedPineSourceSha256, normalizePineSource } from './pine-input-schema.js';
import { sha256Hex } from './stable-json.js';

export const STRATEGY_RUN_CONFIG_VERSION = 1;
export const STRATEGY_RUN_OUTPUT_FORMATS = Object.freeze(['json', 'jsonl', 'csv']);

const PATH_SAFE_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const ROOT_FIELDS = ['schema_version', 'run', 'strategy', 'target', 'backtest', 'experiments', 'output'];

function problem(code, message, path, phase = 'config_validation') {
  return Object.freeze({ code, message, ...(path && { path }), phase, retryable: false });
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateObject(value, path, { allowed, required = [] }, errors) {
  if (!isObject(value)) {
    errors.push(problem('RUN_CONFIG_INVALID', `${path} must be an object.`, path));
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(problem('RUN_CONFIG_UNKNOWN_FIELD', `Unknown config field: ${path}.${key}`, `${path}.${key}`));
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(problem('RUN_CONFIG_REQUIRED', `Missing required config field: ${path}.${key}`, `${path}.${key}`));
    }
  }
  return true;
}

function validateNonEmptyString(value, path, errors) {
  if (typeof value !== 'string' || !value.trim()) {
    errors.push(problem('RUN_CONFIG_INVALID', `${path} must be a non-empty string.`, path));
    return null;
  }
  return value.trim();
}

function validateSafeName(value, path, code, errors) {
  const normalized = validateNonEmptyString(value, path, errors);
  if (normalized && !PATH_SAFE_NAME.test(normalized)) {
    errors.push(problem(
      code,
      `${path} must contain only ASCII letters, numbers, hyphen, or underscore and be at most 100 characters.`,
      path,
    ));
    return null;
  }
  return normalized;
}

function slugify(value) {
  const slug = String(value || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'strategy';
}

export function generateStrategyRunId({ strategy_name, now = Date.now(), random_suffix } = {}) {
  const timestamp = new Date(now).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  const suffix = String(random_suffix || nodeRandomBytes(4).toString('hex')).toLowerCase();
  return `${slugify(strategy_name)}-${timestamp}-${suffix}`;
}

/** Strictly validate a parsed config without filesystem or TradingView access. */
export function validateStrategyRunConfig(config, { now, random_suffix } = {}) {
  const errors = [];
  const warnings = [];
  if (!validateObject(config, 'config', { allowed: ROOT_FIELDS, required: [
    'schema_version', 'strategy', 'target', 'backtest', 'experiments', 'output',
  ] }, errors)) {
    return { valid: false, errors, warnings, requested: null };
  }
  if (config.schema_version !== STRATEGY_RUN_CONFIG_VERSION) {
    errors.push(problem(
      'RUN_CONFIG_VERSION_UNSUPPORTED',
      `schema_version must be ${STRATEGY_RUN_CONFIG_VERSION}.`,
      'schema_version',
    ));
  }

  const runValid = config.run == null || validateObject(
    config.run, 'run', { allowed: ['run_id', 'description'] }, errors,
  );
  let runId = null;
  if (runValid && config.run?.run_id != null) {
    runId = validateSafeName(config.run.run_id, 'run.run_id', 'RUN_ID_INVALID', errors);
  }
  if (runValid && config.run?.description != null && typeof config.run.description !== 'string') {
    errors.push(problem('RUN_CONFIG_INVALID', 'run.description must be a string.', 'run.description'));
  }

  const strategyValid = validateObject(config.strategy, 'strategy', {
    allowed: ['file', 'saved_name'], required: ['file', 'saved_name'],
  }, errors);
  const strategyFile = strategyValid
    ? validateNonEmptyString(config.strategy.file, 'strategy.file', errors)
    : null;
  const savedName = strategyValid
    ? validateNonEmptyString(config.strategy.saved_name, 'strategy.saved_name', errors)
    : null;

  const targetValid = validateObject(config.target, 'target', {
    allowed: ['layout', 'pane_index', 'watchlist'], required: ['layout', 'pane_index', 'watchlist'],
  }, errors);
  let layoutName = null;
  let watchlistName = null;
  let paneIndex = null;
  if (targetValid) {
    if (validateObject(config.target.layout, 'target.layout', { allowed: ['name'], required: ['name'] }, errors)) {
      layoutName = validateNonEmptyString(config.target.layout.name, 'target.layout.name', errors);
    }
    if (validateObject(config.target.watchlist, 'target.watchlist', { allowed: ['name'], required: ['name'] }, errors)) {
      watchlistName = validateNonEmptyString(config.target.watchlist.name, 'target.watchlist.name', errors);
    }
    if (!Number.isInteger(config.target.pane_index) || config.target.pane_index < 0) {
      errors.push(problem(
        'PANE_INDEX_INVALID', 'target.pane_index must be a non-negative integer.', 'target.pane_index',
      ));
    } else {
      paneIndex = config.target.pane_index;
    }
  }

  const backtestValid = validateObject(config.backtest, 'backtest', {
    allowed: ['timeframe'], required: ['timeframe'],
  }, errors);
  const timeframe = backtestValid
    ? validateNonEmptyString(config.backtest.timeframe, 'backtest.timeframe', errors)
    : null;

  const experimentsValid = validateObject(config.experiments, 'experiments', {
    allowed: ['parameter_sets'], required: ['parameter_sets'],
  }, errors);
  const parameterSets = [];
  if (experimentsValid) {
    if (!Array.isArray(config.experiments.parameter_sets) || config.experiments.parameter_sets.length === 0) {
      errors.push(problem(
        'RUN_CONFIG_INVALID',
        'experiments.parameter_sets must be a non-empty array.',
        'experiments.parameter_sets',
      ));
    } else {
      const names = new Set();
      config.experiments.parameter_sets.forEach((set, index) => {
        const path = `experiments.parameter_sets[${index}]`;
        if (!validateObject(set, path, { allowed: ['name', 'inputs'], required: ['name', 'inputs'] }, errors)) return;
        const name = validateSafeName(set.name, `${path}.name`, 'PARAMETER_SET_NAME_INVALID', errors);
        if (name && names.has(name)) {
          errors.push(problem(
            'PARAMETER_SET_NAME_DUPLICATE', `Parameter Set name is duplicated: ${name}`, `${path}.name`,
          ));
        }
        if (name) names.add(name);
        if (!isObject(set.inputs)) {
          errors.push(problem('RUN_CONFIG_INVALID', `${path}.inputs must be an object.`, `${path}.inputs`));
          return;
        }
        if (name) parameterSets.push(Object.freeze({ name, inputs: Object.freeze({ ...set.inputs }) }));
      });
    }
  }

  const outputValid = validateObject(config.output, 'output', {
    allowed: ['directory', 'format'], required: ['directory', 'format'],
  }, errors);
  const outputDirectory = outputValid
    ? validateNonEmptyString(config.output.directory, 'output.directory', errors)
    : null;
  let outputFormat = outputValid
    ? validateNonEmptyString(config.output.format, 'output.format', errors)
    : null;
  if (outputFormat && !STRATEGY_RUN_OUTPUT_FORMATS.includes(outputFormat)) {
    errors.push(problem(
      'RUN_CONFIG_INVALID',
      `output.format must be one of: ${STRATEGY_RUN_OUTPUT_FORMATS.join(', ')}.`,
      'output.format',
    ));
    outputFormat = null;
  }

  if (!runId && savedName) {
    runId = generateStrategyRunId({ strategy_name: savedName, now, random_suffix });
  }
  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    requested: Object.freeze({
      schema_version: config.schema_version,
      run: Object.freeze({
        run_id: runId,
        description: typeof config.run?.description === 'string' ? config.run.description : '',
        generated: config.run?.run_id == null,
      }),
      strategy: Object.freeze({ file: strategyFile, saved_name: savedName }),
      target: Object.freeze({
        layout: Object.freeze({ name: layoutName }),
        pane_index: paneIndex,
        watchlist: Object.freeze({ name: watchlistName }),
      }),
      backtest: Object.freeze({ timeframe }),
      experiments: Object.freeze({ parameter_sets: Object.freeze(parameterSets) }),
      output: Object.freeze({ directory: outputDirectory, format: outputFormat }),
    }),
  };
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

/** Load JSON, resolve config-relative paths, and perform read-only filesystem checks. */
export async function loadStrategyRunConfig({ config_path, _deps = {} } = {}) {
  const errors = [];
  const warnings = [];
  const readFile = _deps.readFile || nodeReadFile;
  const lstat = _deps.lstat || nodeLstat;
  const now = _deps.now ? _deps.now() : Date.now();
  const randomSuffix = _deps.randomSuffix
    ? _deps.randomSuffix()
    : (_deps.randomBytes || nodeRandomBytes)(4).toString('hex');
  if (typeof config_path !== 'string' || !config_path.trim()) {
    return {
      valid: false,
      errors: [problem('RUN_CONFIG_REQUIRED', 'config_path is required.', 'config_path', 'config_load')],
      warnings,
    };
  }
  const configPath = resolve(config_path);
  const configDirectory = dirname(configPath);
  let raw;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    return {
      valid: false,
      errors: [problem(
        'RUN_CONFIG_READ_FAILED',
        `Unable to read Run Config: ${configPath} (${error?.message || String(error)})`,
        'config_path',
        'config_load',
      )],
      warnings,
      config_path: configPath,
    };
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    return {
      valid: false,
      errors: [problem(
        'RUN_CONFIG_JSON_INVALID',
        `Run Config must be valid JSON: ${error.message}`,
        'config_path',
        'config_load',
      )],
      warnings,
      config_path: configPath,
    };
  }
  const validated = validateStrategyRunConfig(config, { now, random_suffix: randomSuffix });
  errors.push(...validated.errors);
  warnings.push(...validated.warnings);
  const requested = validated.requested;
  if (!requested) {
    return {
      valid: false,
      errors: Object.freeze(errors),
      warnings: Object.freeze(warnings),
      config_path: configPath,
      config_directory: configDirectory,
      config_sha256: sha256Hex(config),
      requested: null,
      pine_source: null,
    };
  }
  const strategyPath = requested?.strategy?.file
    ? resolve(configDirectory, requested.strategy.file)
    : null;
  const outputDirectory = requested?.output?.directory
    ? resolve(configDirectory, requested.output.directory)
    : null;
  const outputPath = outputDirectory && requested?.run?.run_id
    ? resolve(outputDirectory, requested.run.run_id)
    : null;

  let pineSource = null;
  let sourceSha256 = null;
  if (strategyPath) {
    try {
      pineSource = normalizePineSource(await readFile(strategyPath, 'utf8'));
      sourceSha256 = normalizedPineSourceSha256(pineSource);
    } catch (error) {
      errors.push(problem(
        'PINE_SOURCE_READ_FAILED',
        `Unable to read Pine source: ${strategyPath} (${error?.message || String(error)})`,
        'strategy.file',
        'filesystem_validation',
      ));
    }
  }

  if (outputDirectory) {
    try {
      const info = await lstat(outputDirectory);
      if (!info.isDirectory()) {
        errors.push(problem(
          'RUN_OUTPUT_INVALID',
          `output.directory exists but is not a directory: ${outputDirectory}`,
          'output.directory',
          'filesystem_validation',
        ));
      }
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(problem(
          'RUN_OUTPUT_INVALID',
          `Unable to inspect output.directory: ${outputDirectory} (${error?.message || String(error)})`,
          'output.directory',
          'filesystem_validation',
        ));
      }
    }
  }
  if (outputPath) {
    try {
      await lstat(outputPath);
      errors.push(problem(
        'RUN_OUTPUT_EXISTS',
        `Run output already exists: ${outputPath}`,
        'run.run_id',
        'filesystem_validation',
      ));
    } catch (error) {
      if (!isMissing(error)) {
        errors.push(problem(
          'RUN_OUTPUT_INVALID',
          `Unable to inspect Run output: ${outputPath} (${error?.message || String(error)})`,
          'output.directory',
          'filesystem_validation',
        ));
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: Object.freeze(errors),
    warnings: Object.freeze(warnings),
    config_path: configPath,
    config_directory: configDirectory,
    config_sha256: sha256Hex(config),
    requested: Object.freeze({
      ...requested,
      strategy: Object.freeze({
        ...requested.strategy,
        file_path: strategyPath,
        source_sha256: sourceSha256,
      }),
      output: Object.freeze({
        ...requested.output,
        directory_path: outputDirectory,
        run_path: outputPath,
      }),
    }),
    pine_source: pineSource,
  };
}
