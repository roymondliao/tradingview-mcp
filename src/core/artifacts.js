/** Safe same-filesystem staging and atomic publication for local artifacts. */
import { createWriteStream as nodeCreateWriteStream } from 'node:fs';
import {
  link as nodeLink,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  rm as nodeRm,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  basename, dirname, isAbsolute, join, resolve, sep,
} from 'node:path';
import { CoreOperationError } from './errors.js';
import {
  createTradingDataEncoder,
  resolveTradingDataFormat,
} from './strategy-trading-format.js';

function outputError(message, { code = 'OUTPUT_WRITE_FAILED', phase, cause } = {}) {
  return new CoreOperationError(message, { code, phase, cause });
}

function isMissing(error) {
  return error?.code === 'ENOENT';
}

/** Encode a Symbol as one deterministic, traversal-safe path segment. */
export function safeSymbolPathSegment(symbol) {
  const input = String(symbol ?? '').trim();
  if (!input) throw outputError('Symbol is required for an artifact path.', { phase: 'output_validation' });
  const encoded = [...input].map((character) => (
    /[A-Za-z0-9._-]/.test(character)
      ? character
      : `_u${character.codePointAt(0).toString(16).toUpperCase()}_`
  )).join('');
  if (!encoded || encoded === '.' || encoded === '..') {
    throw outputError('Symbol did not produce a safe artifact path.', { phase: 'output_validation' });
  }
  return encoded;
}

/** Reject absolute and traversal-bearing paths used inside an artifact tree. */
export function assertSafeRelativeArtifactPath(relativePath) {
  const value = String(relativePath ?? '');
  if (!value || value.includes('\0') || isAbsolute(value)) {
    throw outputError('Artifact path must be a non-empty safe relative path.', {
      phase: 'output_validation',
    });
  }
  const segments = value.split(/[\\/]+/);
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw outputError('Artifact path must not contain empty or traversal segments.', {
      phase: 'output_validation',
    });
  }
  return segments.join(sep);
}

function safeRunId(value) {
  const runId = String(value ?? '').trim();
  if (!runId || runId === '.' || runId === '..' || !/^[A-Za-z0-9._-]+$/.test(runId)) {
    throw outputError('run_id must be one safe path segment.', { phase: 'output_validation' });
  }
  return runId;
}

/** Generate a sortable, path-safe run identity. */
export function createStrategyRunId({ now = Date.now(), uuid = randomUUID() } = {}) {
  const timestamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return safeRunId(`strategy-trading-${timestamp}-${String(uuid).slice(0, 8)}`);
}

/**
 * Stage a complete run tree beside its final directory and publish it only
 * after every artifact and Chart restore check succeeds.
 */
export async function createArtifactSetTransaction({
  output_directory,
  run_id,
  force = false,
  _deps = {},
} = {}) {
  if (output_directory == null || !String(output_directory).trim()) {
    throw outputError('An output directory is required.', { phase: 'output_validation' });
  }
  const deps = {
    createWriteStream: nodeCreateWriteStream,
    lstat: nodeLstat,
    mkdir: nodeMkdir,
    rename: nodeRename,
    rm: nodeRm,
    stat: nodeStat,
    writeFile: nodeWriteFile,
    uuid: randomUUID,
    now: Date.now,
    ..._deps,
  };
  const outputDirectory = resolve(String(output_directory));
  const runId = safeRunId(run_id || createStrategyRunId({
    now: deps.now(), uuid: deps.uuid(),
  }));
  const finalPath = join(outputDirectory, runId);
  const stagingPath = join(outputDirectory, `.${runId}.${deps.uuid()}.staging`);
  const streams = new Set();
  let state = 'created';

  async function inspectFinal() {
    try {
      return await deps.lstat(finalPath);
    } catch (error) {
      if (isMissing(error)) return null;
      throw outputError(`Failed to inspect output target: ${finalPath}`, {
        phase: 'output_validation', cause: error,
      });
    }
  }

  function validateReplaceTarget(existing) {
    if (!existing) return;
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw outputError(`Run output target is not a replaceable directory: ${finalPath}`, {
        phase: 'output_validation',
      });
    }
  }

  function stagingArtifactPath(relativePath) {
    const safeRelative = assertSafeRelativeArtifactPath(relativePath);
    const artifactPath = resolve(stagingPath, safeRelative);
    if (artifactPath !== stagingPath && !artifactPath.startsWith(`${stagingPath}${sep}`)) {
      throw outputError('Artifact path escaped the staging directory.', {
        phase: 'output_validation',
      });
    }
    return { safeRelative, artifactPath };
  }

  try {
    await deps.mkdir(outputDirectory, { recursive: true });
    const existing = await inspectFinal();
    validateReplaceTarget(existing);
    if (existing && !force) {
      throw outputError(`Output run already exists: ${finalPath}`, {
        code: 'OUTPUT_ALREADY_EXISTS', phase: 'output_validation',
      });
    }
    await deps.mkdir(stagingPath, { recursive: false });
    state = 'open';
  } catch (error) {
    if (error instanceof CoreOperationError) throw error;
    throw outputError(`Failed to prepare run staging directory: ${stagingPath}`, {
      phase: 'output_validation', cause: error,
    });
  }

  return {
    run_id: runId,
    output_directory: outputDirectory,
    final_path: finalPath,
    staging_path: stagingPath,

    artifactPath(relativePath, { staging = false } = {}) {
      const { safeRelative, artifactPath } = stagingArtifactPath(relativePath);
      return staging ? artifactPath : join(finalPath, safeRelative);
    },

    async openArtifact(relativePath) {
      if (state !== 'open') throw new Error(`Artifact set transaction is ${state}.`);
      const { artifactPath } = stagingArtifactPath(relativePath);
      await deps.mkdir(dirname(artifactPath), { recursive: true });
      const writable = deps.createWriteStream(artifactPath, { encoding: 'utf8', flags: 'wx' });
      streams.add(writable);
      writable.once('close', () => streams.delete(writable));
      return writable;
    },

    async writeJson(relativePath, value) {
      if (state !== 'open') throw new Error(`Artifact set transaction is ${state}.`);
      const { artifactPath } = stagingArtifactPath(relativePath);
      await deps.mkdir(dirname(artifactPath), { recursive: true });
      await deps.writeFile(artifactPath, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx',
      });
      return artifactPath;
    },

    async artifactInfo(relativePath) {
      const { safeRelative, artifactPath } = stagingArtifactPath(relativePath);
      const info = await deps.stat(artifactPath);
      if (!info.isFile()) throw new Error(`Artifact is not a regular file: ${safeRelative}`);
      return {
        relative_path: safeRelative.split(sep).join('/'),
        path: join(finalPath, safeRelative),
        bytes: info.size,
      };
    },

    async publish() {
      if (state !== 'open') throw new Error(`Artifact set transaction is ${state}.`);
      if ([...streams].some((stream) => !stream.writableFinished && !stream.destroyed)) {
        throw outputError('Cannot publish while an artifact stream is still open.', {
          phase: 'artifact_publish',
        });
      }
      const existing = await inspectFinal();
      validateReplaceTarget(existing);
      if (existing && !force) {
        throw outputError(`Output run already exists: ${finalPath}`, {
          code: 'OUTPUT_ALREADY_EXISTS', phase: 'artifact_publish',
        });
      }

      let backupPath = null;
      try {
        if (existing) {
          backupPath = join(outputDirectory, `.${runId}.${deps.uuid()}.backup`);
          await deps.rename(finalPath, backupPath);
        }
        try {
          await deps.rename(stagingPath, finalPath);
        } catch (error) {
          if (backupPath) await deps.rename(backupPath, finalPath);
          throw error;
        }
        state = 'published';
        let cleanupWarning = null;
        if (backupPath) {
          try {
            await deps.rm(backupPath, { recursive: true, force: false });
          } catch {
            cleanupWarning = `Previous run backup could not be removed: ${backupPath}`;
          }
        }
        return {
          path: finalPath,
          atomic: true,
          replaced: Boolean(existing),
          ...(cleanupWarning && { cleanup_warning: cleanupWarning }),
        };
      } catch (error) {
        if (error instanceof CoreOperationError) throw error;
        if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
          throw outputError(`Output run already exists: ${finalPath}`, {
            code: 'OUTPUT_ALREADY_EXISTS', phase: 'artifact_publish', cause: error,
          });
        }
        throw outputError(`Failed to publish run output: ${finalPath}`, {
          phase: 'artifact_publish', cause: error,
        });
      }
    },

    async abort() {
      if (state === 'published' || state === 'aborted') return;
      state = 'aborted';
      for (const stream of streams) {
        if (!stream.destroyed) stream.destroy();
      }
      try {
        await deps.rm(stagingPath, { recursive: true, force: true });
      } catch (error) {
        throw outputError(`Failed to remove run staging directory: ${stagingPath}`, {
          phase: 'artifact_abort', cause: error,
        });
      }
    },
  };
}

/**
 * Create a single-file transaction. The staging file lives beside the final
 * target so publish never crosses filesystems.
 */
export async function createArtifactTransaction({ output, force = false, _deps = {} } = {}) {
  if (output == null || !String(output).trim()) {
    throw outputError('An output file is required.', { phase: 'output_validation' });
  }
  const deps = {
    createWriteStream: nodeCreateWriteStream,
    link: nodeLink,
    lstat: nodeLstat,
    mkdir: nodeMkdir,
    rename: nodeRename,
    stat: nodeStat,
    unlink: nodeUnlink,
    uuid: randomUUID,
    ..._deps,
  };
  const outputPath = resolve(String(output));
  const outputDirectory = dirname(outputPath);
  try {
    await deps.mkdir(outputDirectory, { recursive: true });
  } catch (error) {
    throw outputError(`Failed to prepare output directory: ${outputDirectory}`, {
      phase: 'output_validation', cause: error,
    });
  }

  try {
    const existing = await deps.lstat(outputPath);
    if (existing.isDirectory()) {
      throw outputError(`Output target is a directory: ${outputPath}`, {
        phase: 'output_validation',
      });
    }
    if (!force) {
      throw outputError(`Output already exists: ${outputPath}`, {
        code: 'OUTPUT_ALREADY_EXISTS', phase: 'output_validation',
      });
    }
  } catch (error) {
    if (isMissing(error)) {
      // A missing target is the normal create-new path.
    } else if (error instanceof CoreOperationError) {
      throw error;
    } else {
      throw outputError(`Failed to inspect output target: ${outputPath}`, {
        phase: 'output_validation', cause: error,
      });
    }
  }

  const stagingPath = resolve(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${deps.uuid()}.staging`,
  );
  let writable = null;
  let state = 'created';

  async function removeStaging() {
    try {
      await deps.unlink(stagingPath);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  return {
    output_path: outputPath,
    staging_path: stagingPath,

    openArtifact() {
      if (state !== 'created') throw new Error(`Artifact transaction is ${state}.`);
      state = 'open';
      writable = deps.createWriteStream(stagingPath, { encoding: 'utf8', flags: 'wx' });
      return writable;
    },

    async publish() {
      if (state !== 'open') throw new Error(`Artifact transaction is ${state}.`);
      try {
        const staged = await deps.stat(stagingPath);
        if (!staged.isFile()) throw new Error('Staging output is not a regular file.');
        if (force) {
          await deps.rename(stagingPath, outputPath);
        } else {
          // Hard-link publication gives no-overwrite semantics without a TOCTOU window.
          await deps.link(stagingPath, outputPath);
          await deps.unlink(stagingPath);
        }
        state = 'published';
        return { path: outputPath, bytes: staged.size, atomic: true };
      } catch (error) {
        try {
          await removeStaging();
        } catch {
          // Preserve the publication error as the primary failure.
        }
        state = 'aborted';
        if (error?.code === 'EEXIST') {
          throw outputError(`Output already exists: ${outputPath}`, {
            code: 'OUTPUT_ALREADY_EXISTS', phase: 'artifact_publish', cause: error,
          });
        }
        if (error instanceof CoreOperationError) throw error;
        throw outputError(`Failed to publish output: ${outputPath}`, {
          phase: 'artifact_publish', cause: error,
        });
      }
    },

    async abort() {
      if (state === 'published' || state === 'aborted') return;
      state = 'aborted';
      if (writable && !writable.destroyed) writable.destroy();
      try {
        await removeStaging();
      } catch (error) {
        throw outputError(`Failed to remove staging output: ${stagingPath}`, {
          phase: 'artifact_abort', cause: error,
        });
      }
    },
  };
}

/** Write one canonical Trading Data batch and return a bounded stdout summary. */
export async function writeTradingDataArtifact({
  result,
  output,
  format,
  force = false,
  _deps,
} = {}) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.trades)) {
    throw outputError('Canonical Trading Data result with trades is required.', {
      phase: 'output_validation',
    });
  }
  const resolvedFormat = resolveTradingDataFormat({ format, output });
  const transaction = await createArtifactTransaction({ output, force, _deps });
  const { trades, ...metadata } = result;
  const writable = transaction.openArtifact();
  const encoder = createTradingDataEncoder({
    format: resolvedFormat,
    metadata,
    writable,
  });
  try {
    await encoder.start();
    await encoder.writeBatch(trades);
    const encoded = await encoder.finish();
    const published = await transaction.publish();
    return {
      ...metadata,
      output: {
        path: published.path,
        format: resolvedFormat,
        bytes: published.bytes,
        written_trades: encoded.written_trades,
        written_rows: encoded.written_rows,
        atomic: published.atomic,
      },
    };
  } catch (error) {
    await encoder.abort();
    await transaction.abort();
    if (error instanceof CoreOperationError) throw error;
    throw outputError(`Failed to write output: ${transaction.output_path}`, {
      phase: 'artifact_write', cause: error,
    });
  }
}
