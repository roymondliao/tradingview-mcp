/** Safe same-filesystem staging and atomic publication for local artifacts. */
import { createWriteStream as nodeCreateWriteStream } from 'node:fs';
import {
  link as nodeLink,
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
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
