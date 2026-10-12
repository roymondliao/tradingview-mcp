import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_ERROR_CAUSE_MAX_NODES,
  CoreOperationError,
  findErrorCause,
  isNormalizedCoreError,
  toCoreDiagnostic,
} from '../src/core/errors.js';
import {
  boundedUnclassifiedError,
  createErrorBoundary,
  normalizeLegacyCodes,
  preserveNormalizedError,
  preserveOwnedAbortReason,
  promoteInfrastructureCause,
  translateErrorCodes,
} from '../src/core/error-policy.js';
import { rehydrateStrategyRunError } from '../src/core/strategy-error-policy.js';

describe('Core normalized error contract', () => {
  it('keeps legacy construction compatible but rejects it at presentation', () => {
    const legacy = new CoreOperationError('missing config', {
      code: 'RUN_CONFIG_REQUIRED',
      phase: 'request_validation',
    });
    assert.equal(legacy.kind, undefined);
    assert.equal(isNormalizedCoreError(legacy), false);
    assert.throws(() => toCoreDiagnostic(legacy), /normalized Core error/);
  });

  it('validates kind and signal metadata', () => {
    assert.throws(
      () => new CoreOperationError('bad', { code: 'BAD', kind: 'network', phase: 'test' }),
      /Unknown Core error kind/,
    );
    assert.throws(
      () => new CoreOperationError('bad signal', {
        code: 'RUN_INTERRUPTED',
        kind: 'interrupt',
        phase: 'test',
        signal: 'SIGINT',
        exit_code: 143,
      }),
      /do not match/,
    );
  });

  it('projects one immutable safe allowlist', () => {
    const error = new CoreOperationError('offline', {
      code: 'CDP_DISCOVERY_FAILED',
      kind: 'cdp',
      phase: 'extension_identity',
      stage: 'target_discovery',
      retryable: true,
      target_id: 'target-1',
      context: { layout_name: 'dev', secret: 'hidden' },
      cause: new Error('private'),
    });
    error.extra = 'not public';
    const diagnostic = toCoreDiagnostic(error);
    assert.deepEqual(diagnostic, {
      code: 'CDP_DISCOVERY_FAILED',
      kind: 'cdp',
      message: 'offline',
      phase: 'extension_identity',
      stage: 'target_discovery',
      target_id: 'target-1',
      retryable: true,
      context: { layout_name: 'dev' },
    });
    assert.equal(Object.isFrozen(diagnostic), true);
    assert.equal(Object.isFrozen(diagnostic.context), true);
    assert.equal('cause' in diagnostic, false);
    assert.equal('stack' in diagnostic, false);
    assert.equal('extra' in diagnostic, false);
  });
});

describe('bounded Core cause traversal', () => {
  it('visits at most sixteen nodes and stops cycles', () => {
    const nodes = Array.from({ length: CORE_ERROR_CAUSE_MAX_NODES + 1 }, (_, index) => ({ index }));
    for (let index = 0; index < nodes.length - 1; index += 1) nodes[index].cause = nodes[index + 1];
    assert.equal(findErrorCause(nodes[0], (item) => item.index === 15), nodes[15]);
    assert.equal(findErrorCause(nodes[0], (item) => item.index === 16), null);
    nodes[4].cause = nodes[1];
    assert.equal(findErrorCause(nodes[0], () => false), null);
  });

  it('never invokes a cause getter', () => {
    let invoked = false;
    const error = {};
    Object.defineProperty(error, 'cause', {
      get() {
        invoked = true;
        throw new Error('getter must not run');
      },
    });
    assert.equal(findErrorCause(error, () => false), null);
    assert.equal(invoked, false);
  });
});

describe('composed error boundaries', () => {
  const legacyKinds = Object.freeze({
    CDP_DISCOVERY_FAILED: { kind: 'cdp', retryable: true },
    RUN_OUTPUT_EXISTS: { kind: 'conflict' },
  });

  function extensionBoundary() {
    return createErrorBoundary({
      phase: 'extension_identity',
      mappers: [
        preserveOwnedAbortReason,
        promoteInfrastructureCause({ legacy_codes: legacyKinds }),
        translateErrorCodes({
          RUN_RESUME_IDENTITY_MISMATCH: {
            code: 'RUN_EXTENSION_IDENTITY_MISMATCH',
            kind: 'identity',
          },
        }),
        preserveNormalizedError,
        normalizeLegacyCodes(legacyKinds),
        boundedUnclassifiedError(),
      ],
    });
  }

  it('promotes nested CDP before identity translation and adds domain phase', () => {
    const cdp = new CoreOperationError('fetch failed', {
      code: 'CDP_DISCOVERY_FAILED',
      kind: 'cdp',
      stage: 'target_discovery',
      retryable: true,
    });
    const resume = new CoreOperationError('resume identity failed', {
      code: 'RUN_RESUME_IDENTITY_MISMATCH',
      phase: 'resume_identity',
      cause: cdp,
    });
    const diagnostic = extensionBoundary().diagnostic(resume);
    assert.equal(diagnostic.code, 'CDP_DISCOVERY_FAILED');
    assert.equal(diagnostic.kind, 'cdp');
    assert.equal(diagnostic.phase, 'extension_identity');
    assert.equal(diagnostic.stage, 'target_discovery');
  });

  it('translates a true normalized Resume identity error before generic preservation', () => {
    const resume = new CoreOperationError('stable identity differs', {
      code: 'RUN_RESUME_IDENTITY_MISMATCH',
      kind: 'identity',
      phase: 'resume_identity',
    });
    const diagnostic = extensionBoundary().diagnostic(resume);
    assert.equal(diagnostic.code, 'RUN_EXTENSION_IDENTITY_MISMATCH');
    assert.equal(diagnostic.kind, 'identity');
    assert.equal(diagnostic.phase, 'extension_identity');
  });

  it('does not promote raw errno or classify it as artifact/filesystem', () => {
    const raw = Object.assign(new Error('missing file'), { code: 'ENOENT' });
    const diagnostic = extensionBoundary().diagnostic(raw);
    assert.equal(diagnostic.code, 'CORE_UNCLASSIFIED_ERROR');
    assert.equal(diagnostic.kind, 'internal');
    assert.equal(diagnostic.message, 'missing file');
  });

  it('uses the deepest safe message for unknown fallback', () => {
    const inner = new Error('root failure');
    const outer = new Error('outer wrapper', { cause: inner });
    const diagnostic = extensionBoundary().diagnostic(outer);
    assert.equal(diagnostic.code, 'CORE_UNCLASSIFIED_ERROR');
    assert.equal(diagnostic.message, 'root failure');
  });

  it('preserves a typed abort reason instead of classifying AbortError', () => {
    const controller = new AbortController();
    controller.abort(new CoreOperationError('Received SIGINT.', {
      code: 'RUN_INTERRUPTED',
      kind: 'interrupt',
      phase: 'strategy_run_execution',
      stage: 'process_signal',
      signal: 'SIGINT',
      exit_code: 130,
    }));
    const diagnostic = extensionBoundary().diagnostic(
      new DOMException('aborted', 'AbortError'),
      { signal: controller.signal },
    );
    assert.equal(diagnostic.kind, 'interrupt');
    assert.equal(diagnostic.phase, 'extension_identity');
    assert.equal(diagnostic.stage, 'process_signal');
    assert.equal(diagnostic.exit_code, 130);
  });

  it('requires an explicit final fallback mapper', () => {
    assert.throws(
      () => createErrorBoundary({ phase: 'test', mappers: [preserveNormalizedError] }),
      /final fallback/,
    );
  });
});

describe('persisted Strategy error rehydration', () => {
  it('restores a known kind without changing the strict artifact record', () => {
    const record = Object.freeze({
      code: 'CDP_DISCOVERY_FAILED',
      phase: 'extension_identity',
      message: 'fetch failed',
    });
    const runtime = rehydrateStrategyRunError(record);
    assert.equal(runtime.code, record.code);
    assert.equal(runtime.kind, 'cdp');
    assert.equal(runtime.phase, record.phase);
    assert.equal(runtime.message, record.message);
    assert.deepEqual(record, {
      code: 'CDP_DISCOVERY_FAILED',
      phase: 'extension_identity',
      message: 'fetch failed',
    });
  });

  it('preserves an unknown persisted code and classifies only its runtime view as internal', () => {
    const runtime = rehydrateStrategyRunError({
      code: 'FUTURE_RUN_FAILURE',
      phase: 'future_phase',
      message: 'future failure',
    });
    assert.equal(runtime.code, 'FUTURE_RUN_FAILURE');
    assert.equal(runtime.kind, 'internal');
    assert.equal(runtime.message, 'future failure');
  });
});
