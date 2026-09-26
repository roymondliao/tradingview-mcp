/** CLI-first Strategy Trading application services. */
import {
  prepareSymbolSession as _prepareSymbolSession,
  restoreSymbolSession as _restoreSymbolSession,
  withChartSession as _withChartSession,
} from './chart-session.js';
import { symbolIdentitiesMatch } from './pane.js';
import { captureActiveWatchlistSnapshot as _captureActiveWatchlistSnapshot } from './watchlist.js';
import {
  ensureStrategyActive as _ensureStrategyActive,
  inspectStrategySource as _inspectStrategySource,
  readRawReportState as _readRawReportState,
  readRawTradingReport as _readRawTradingReport,
  readRawTradingDataBatch as _readRawTradingDataBatch,
  strategyRuntimeLimits,
  waitForFreshTradingReport as _waitForFreshTradingReport,
} from './strategy-runtime.js';
import {
  compareSnapshotIdentity,
  createSnapshotIdentity,
  normalizeStrategyTradeBatch,
  normalizeTradingReport,
} from './strategy-trading-model.js';
import {
  createTradingDataMetricsAccumulator,
  reconcileTradingReport,
} from './strategy-reconciliation.js';
import {
  assertSafeRelativeArtifactPath,
  createArtifactSetTransaction,
  safeSymbolPathSegment,
  writeTradingDataArtifact,
} from './artifacts.js';
import {
  createTradingDataEncoder,
  resolveTradingDataFormat,
} from './strategy-trading-format.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';
import { unixMillisecondsToIso } from './time.js';

function validateStrategyContextRequest({ entity_id, context }) {
  if (!entity_id || !String(entity_id).trim()) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase: 'request_validation', context,
    });
  }
  if (!context || typeof context !== 'object') {
    throw new CoreOperationError('Resolved Pane context is required.', {
      code: 'CHART_SESSION_INVALID', phase: 'request_validation', entity_id,
    });
  }
}

function validateStrategySymbolRequest({ entity_id, symbol, context, command }) {
  validateStrategyContextRequest({ entity_id, context });
  if (!symbol || !String(symbol).trim()) {
    throw new CoreOperationError(`--symbol is required for ${command}.`, {
      code: 'SYMBOL_REQUIRED', phase: 'request_validation', entity_id, context,
    });
  }
  if (!/^[^:\s]+:[^:\s]+$/.test(String(symbol).trim())) {
    throw new CoreOperationError('--symbol must use exchange:symbol format.', {
      code: 'SYMBOL_INVALID', phase: 'request_validation', entity_id, symbol, context,
    });
  }
}

function paginationValues({ offset, limit, snapshot_id }) {
  const parsedOffset = offset == null ? 0 : Number(offset);
  const parsedLimit = limit == null ? strategyRuntimeLimits.default_batch_limit : Number(limit);
  if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
    throw new CoreOperationError('offset must be a non-negative integer.', {
      code: 'STRATEGY_RUNTIME_INVALID', phase: 'request_validation',
    });
  }
  if (
    !Number.isInteger(parsedLimit)
    || parsedLimit < 1
    || parsedLimit > strategyRuntimeLimits.max_batch_limit
  ) {
    throw new CoreOperationError(
      `limit must be an integer from 1 to ${strategyRuntimeLimits.max_batch_limit}.`,
      { code: 'STRATEGY_RUNTIME_INVALID', phase: 'request_validation' },
    );
  }
  if (parsedOffset > 0 && (!snapshot_id || !String(snapshot_id).trim())) {
    throw new CoreOperationError('--snapshot-id is required when offset is greater than 0.', {
      code: 'STALE_STRATEGY_SNAPSHOT', phase: 'request_validation',
    });
  }
  return {
    offset: parsedOffset,
    limit: parsedLimit,
    snapshot_id: snapshot_id == null ? null : String(snapshot_id).trim(),
  };
}

function publicSnapshot(snapshot) {
  return {
    available: snapshot.available === true,
    snapshot_schema_version: snapshot.snapshot_schema_version,
    snapshot_id: snapshot.snapshot_id,
    algorithm: snapshot.algorithm,
    missing_fields: snapshot.missing_fields,
  };
}

function assertAvailableSnapshot(snapshot, { entity_id, symbol, context, phase }) {
  if (snapshot.available) return snapshot;
  throw new CoreOperationError(
    `Strategy snapshot is incomplete: ${snapshot.missing_fields.join(', ')}`,
    {
      code: 'STRATEGY_SNAPSHOT_UNAVAILABLE', phase, entity_id, symbol, context,
    },
  );
}

function assertMatchingSnapshot(expected, actual, { entity_id, symbol, context, phase }) {
  const comparison = compareSnapshotIdentity(expected, actual);
  if (comparison.matched) return comparison;
  const differences = comparison.difference_paths.length
    ? ` Changed fields: ${comparison.difference_paths.slice(0, 8).join(', ')}.`
    : '';
  throw new CoreOperationError(
    `Strategy snapshot changed: expected ${comparison.expected_snapshot_id || 'unavailable'}, received ${comparison.actual_snapshot_id || 'unavailable'}.${differences}`,
    {
      code: 'STALE_STRATEGY_SNAPSHOT', phase, entity_id, symbol,
      retryable: true, context,
    },
  );
}

function canonicalReportResult({ entity_id, inspected, session, observation, context, phase }) {
  const report = normalizeTradingReport(observation, {
    context,
    entity_id,
    strategy_name: inspected.strategy?.name ?? null,
    requested_symbol: session.requested_symbol,
    resolved_symbol: session.resolved_symbol,
    timeframe: session.timeframe,
    calculation_mode: observation.snapshot_candidate?.calculation_mode,
  });
  const snapshot = assertAvailableSnapshot(
    createSnapshotIdentity(observation.snapshot_candidate),
    {
      entity_id, symbol: session.requested_symbol, context, phase,
    },
  );
  return { report, snapshot };
}

async function executeFreshStrategySymbol({
  entity_id,
  symbol,
  timeframe,
  context,
  timeout_ms,
  command,
  _deps,
}, operation) {
  validateStrategySymbolRequest({ entity_id, symbol, context, command });
  const requestedEntityId = String(entity_id).trim();
  const requestedSymbol = String(symbol).trim();
  const inspectStrategySource = _deps?.inspectStrategySource || _inspectStrategySource;
  const ensureStrategyActive = _deps?.ensureStrategyActive || _ensureStrategyActive;
  const readRawReportState = _deps?.readRawReportState || _readRawReportState;
  const prepareSymbolSession = _deps?.prepareSymbolSession || _prepareSymbolSession;
  const waitForFreshTradingReport = _deps?.waitForFreshTradingReport || _waitForFreshTradingReport;
  // Ownership/type validation deliberately precedes all Chart mutation.
  const inspected = await inspectStrategySource({
    entity_id: requestedEntityId, context, _deps,
  });
  await ensureStrategyActive({
    entity_id: requestedEntityId, context, timeout_ms, _deps,
  });
  const before = await readRawReportState({
    entity_id: requestedEntityId,
    context,
    phase: `${command}_before`,
    _deps,
  });
  const symbolSession = await prepareSymbolSession({
    context,
    entity_id: requestedEntityId,
    symbol: requestedSymbol,
    timeframe,
    timeout_ms,
    _deps,
  });
  const onSymbolSession = _deps?.onSymbolSession;
  if (onSymbolSession) await onSymbolSession(symbolSession);
  const observation = await waitForFreshTradingReport({
    entity_id: requestedEntityId,
    session: symbolSession,
    before,
    mutated: symbolSession.symbol_changed || symbolSession.timeframe_changed,
    timeout_ms,
    _deps,
  });
  const result = await operation({
    entity_id: requestedEntityId,
    requested_symbol: requestedSymbol,
    inspected,
    session: symbolSession,
    observation,
  });
  return { result, symbol_session: symbolSession };
}

async function withFreshStrategySymbol(options, operation) {
  validateStrategySymbolRequest({
    entity_id: options?.entity_id,
    symbol: options?.symbol,
    context: options?.context,
    command: options?.command,
  });
  const withChartSession = options?._deps?.withChartSession || _withChartSession;
  const restoreSymbolSession = options?._deps?.restoreSymbolSession || _restoreSymbolSession;
  return withChartSession({ context: options.context, _deps: options._deps }, async () => {
    let execution = null;
    let symbolSession = null;
    const originalOnSymbolSession = options?._deps?.onSymbolSession;
    const executionOptions = {
      ...options,
      _deps: {
        ...options._deps,
        onSymbolSession: async (session) => {
          symbolSession = session;
          if (originalOnSymbolSession) await originalOnSymbolSession(session);
        },
      },
    };
    try {
      execution = await executeFreshStrategySymbol(executionOptions, operation);
      return execution.result;
    } finally {
      if (symbolSession) {
        const restore = await restoreSymbolSession(symbolSession, {
          timeout_ms: options.timeout_ms, _deps: options._deps,
        });
        if (execution?.result) execution.result.chart_restore = restore;
      }
    }
  });
}

/** Resolve one explicit Strategy/Symbol to a fresh canonical Trading Report. */
export async function getStrategyTradingReport({
  entity_id,
  symbol,
  timeframe,
  context,
  timeout_ms,
  _deps,
} = {}) {
  return withFreshStrategySymbol({
    entity_id, symbol, timeframe, context, timeout_ms,
    command: 'trading_report', _deps,
  }, async ({ entity_id: requestedEntityId, inspected, session: symbolSession, observation }) => {
      const { report, snapshot } = canonicalReportResult({
        entity_id: requestedEntityId,
        inspected,
        session: symbolSession,
        observation,
        context,
        phase: 'snapshot_validation',
      });
      return {
        success: true,
        context: sanitizeCoreContext(context),
        strategy: inspected.strategy,
        requested_symbol: symbolSession.requested_symbol,
        resolved_symbol: symbolSession.resolved_symbol,
        symbol: symbolSession.resolved_symbol,
        timeframe: symbolSession.timeframe,
        currency: report.currency,
        metrics: report.metrics,
        reconciliation_metrics: report.reconciliation_metrics,
        calculation: {
          ...report.calculation,
          fresh: observation.fresh === true,
          transition_observed: observation.transition_observed === true,
          stable_reads: observation.stable_reads,
        },
        report,
        snapshot: publicSnapshot(snapshot),
        snapshot_id: snapshot.snapshot_id,
      };
  });
}

/** Read one canonical batch while retaining the caller's prepared Symbol Session. */
export async function readTradingDataBatchForSession({
  entity_id,
  inspected,
  session,
  observation,
  offset,
  limit,
  snapshot_id,
  context,
  _deps,
} = {}) {
  const pagination = paginationValues({ offset, limit, snapshot_id });
  const expectedContext = session?.context || context;
  const reportSnapshot = assertAvailableSnapshot(
    createSnapshotIdentity(observation?.snapshot_candidate),
    {
      entity_id, symbol: session?.requested_symbol,
      context: expectedContext, phase: 'trading_data_snapshot',
    },
  );
  if (pagination.snapshot_id) {
    assertMatchingSnapshot(pagination.snapshot_id, reportSnapshot, {
      entity_id, symbol: session?.requested_symbol,
      context: expectedContext, phase: 'trading_data_snapshot',
    });
  }

  const readRawTradingDataBatch = _deps?.readRawTradingDataBatch || _readRawTradingDataBatch;
  const rawBatch = await readRawTradingDataBatch({
    entity_id,
    session,
    offset: pagination.offset,
    limit: pagination.limit,
    _deps,
  });
  if (rawBatch.status_type !== 2 || rawBatch.snapshot_changed) {
    throw new CoreOperationError('Strategy Report changed while reading the Trade batch.', {
      code: 'STALE_STRATEGY_SNAPSHOT', phase: 'trading_data_batch',
      entity_id, symbol: session?.requested_symbol,
      retryable: true, context: expectedContext,
    });
  }
  const batchBefore = assertAvailableSnapshot(
    createSnapshotIdentity(rawBatch.snapshot_before),
    {
      entity_id, symbol: session?.requested_symbol,
      context: expectedContext, phase: 'trading_data_batch_before',
    },
  );
  const batchAfter = assertAvailableSnapshot(
    createSnapshotIdentity(rawBatch.snapshot_after),
    {
      entity_id, symbol: session?.requested_symbol,
      context: expectedContext, phase: 'trading_data_batch_after',
    },
  );
  assertMatchingSnapshot(reportSnapshot, batchBefore, {
    entity_id, symbol: session?.requested_symbol,
    context: expectedContext, phase: 'trading_data_batch_before',
  });
  assertMatchingSnapshot(batchBefore, batchAfter, {
    entity_id, symbol: session?.requested_symbol,
    context: expectedContext, phase: 'trading_data_batch_after',
  });

  const candidate = rawBatch.snapshot_before;
  const expectedTotal = Number(candidate.closed_trades) + Number(candidate.open_trades);
  if (
    candidate.first_trade_index !== 0
    || !Number.isInteger(expectedTotal)
    || rawBatch.total !== candidate.trade_count
    || rawBatch.total !== expectedTotal
    || pagination.offset > rawBatch.total
  ) {
    throw new CoreOperationError('Strategy Trading Data is retained, truncated, or count-inconsistent.', {
      code: 'TRADING_DATA_INCOMPLETE', phase: 'trading_data_completeness',
      entity_id, symbol: session?.requested_symbol, context: expectedContext,
    });
  }
  const expectedReturned = Math.min(pagination.limit, rawBatch.total - pagination.offset);
  if (rawBatch.returned !== expectedReturned) {
    throw new CoreOperationError('Strategy Trade batch did not return the expected contiguous range.', {
      code: 'TRADING_DATA_INCOMPLETE', phase: 'trading_data_completeness',
      entity_id, symbol: session?.requested_symbol, context: expectedContext,
    });
  }
  const canonical = normalizeStrategyTradeBatch({
    ...rawBatch,
    snapshot_id: batchBefore.snapshot_id,
  });
  const complete = canonical.offset === 0 && canonical.has_more === false;
  return {
    success: true,
    schema_version: canonical.schema_version,
    context: sanitizeCoreContext(expectedContext),
    strategy: inspected?.strategy || null,
    requested_symbol: session?.requested_symbol,
    resolved_symbol: session?.resolved_symbol,
    symbol: session?.resolved_symbol,
    timeframe: session?.timeframe,
    currency: candidate.currency,
    ordering: 'oldest_first',
    total: canonical.total,
    offset: canonical.offset,
    limit: pagination.limit,
    returned: canonical.returned,
    next_offset: canonical.next_offset,
    has_more: canonical.has_more,
    complete,
    first_trade_index: candidate.first_trade_index,
    trades: canonical.trades,
    snapshot: publicSnapshot(batchBefore),
    snapshot_id: batchBefore.snapshot_id,
  };
}

/** Read one canonical oldest-first Strategy Trade batch from a stable snapshot. */
export async function getStrategyTradingData({
  entity_id,
  symbol,
  timeframe,
  offset,
  limit,
  snapshot_id,
  format,
  output,
  force = false,
  context,
  timeout_ms,
  _deps,
} = {}) {
  validateStrategySymbolRequest({
    entity_id, symbol, context, command: 'strategy trading-data',
  });
  const resolvedFormat = resolveTradingDataFormat({ format, output });
  if (force && !output) {
    throw new CoreOperationError('--force requires --output.', {
      code: 'OUTPUT_WRITE_FAILED', phase: 'output_validation', entity_id, symbol, context,
    });
  }
  const pagination = paginationValues({ offset, limit, snapshot_id });
  const result = await withFreshStrategySymbol({
    entity_id, symbol, timeframe, context, timeout_ms,
    command: 'trading_data', _deps,
  }, ({ entity_id: requestedEntityId, inspected, session, observation }) => (
    readTradingDataBatchForSession({
      entity_id: requestedEntityId,
      inspected,
      session,
      observation,
      offset: pagination.offset,
      limit: pagination.limit,
      snapshot_id: pagination.snapshot_id,
      context,
      _deps,
    })
  ));
  return output
    ? writeTradingDataArtifact({
      result, output, format: resolvedFormat, force, _deps: _deps?.artifactDeps,
    })
    : result;
}

/** Validate the mutually-exclusive trading-export source before context discovery. */
export function validateStrategyTradingExportScope({ entity_id, symbol, watchlist, fail_fast } = {}) {
  if (!entity_id || !String(entity_id).trim()) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase: 'request_validation',
    });
  }
  if (Boolean(symbol) === Boolean(watchlist)) {
    throw new CoreOperationError('Provide exactly one of --symbol or --watchlist active.', {
      code: 'TRADING_EXPORT_SCOPE_INVALID', phase: 'request_validation', entity_id,
    });
  }
  if (watchlist && watchlist !== 'active') {
    throw new CoreOperationError('--watchlist currently supports only active.', {
      code: 'WATCHLIST_SCOPE_UNSUPPORTED', phase: 'request_validation', entity_id,
    });
  }
  if (symbol && !/^[^:\s]+:[^:\s]+$/.test(String(symbol).trim())) {
    throw new CoreOperationError('--symbol must use exchange:symbol format.', {
      code: 'SYMBOL_INVALID', phase: 'request_validation', entity_id, symbol,
    });
  }
  if (fail_fast && !watchlist) {
    throw new CoreOperationError('--fail-fast requires --watchlist active.', {
      code: 'TRADING_EXPORT_SCOPE_INVALID', phase: 'request_validation', entity_id,
    });
  }
}

function artifactWriteError(error, { entity_id, symbol, context, phase = 'artifact_write' }) {
  if (error instanceof CoreOperationError) return error;
  return new CoreOperationError(`Failed to write Strategy Trading export: ${error?.message || String(error)}`, {
    code: 'OUTPUT_WRITE_FAILED', phase, entity_id, symbol, context, cause: error,
  });
}

function completeTradingDataMetadata({ report, snapshot, batchLimit, total }) {
  return {
    success: true,
    schema_version: report.schema_version,
    context: report.context,
    strategy: report.strategy,
    requested_symbol: report.requested_symbol,
    resolved_symbol: report.resolved_symbol,
    symbol: report.resolved_symbol,
    timeframe: report.timeframe,
    currency: report.currency,
    ordering: 'oldest_first',
    total,
    offset: 0,
    limit: batchLimit,
    returned: total,
    next_offset: null,
    has_more: false,
    complete: true,
    first_trade_index: report.first_trade_index,
    snapshot: publicSnapshot(snapshot),
    snapshot_id: snapshot.snapshot_id,
  };
}

function artifactNamespace(namespace) {
  if (!namespace) return '';
  return assertSafeRelativeArtifactPath(namespace).split('\\').join('/');
}

function namespacedArtifactPath(namespace, relativePath) {
  const prefix = artifactNamespace(namespace);
  return prefix ? `${prefix}/${relativePath}` : relativePath;
}

function symbolArtifactPaths(symbol, format, namespace) {
  const symbolDirectory = namespacedArtifactPath(
    namespace, `symbols/${safeSymbolPathSegment(symbol)}`,
  );
  return {
    directory: symbolDirectory,
    report: `${symbolDirectory}/report.json`,
    trades: `${symbolDirectory}/trades.${format}`,
    reconciliation: `${symbolDirectory}/reconciliation.json`,
  };
}

function manifestSymbolSuccess(exported) {
  return {
    requested_symbol: exported.requested_symbol,
    resolved_symbol: exported.resolved_symbol,
    status: 'succeeded',
    phase: 'completed',
    snapshot_id: exported.snapshot_id,
    total_trades: exported.total_trades,
    batch_count: exported.batch_count,
    diagnostics: [],
    artifacts: Object.fromEntries(Object.entries(exported.artifacts).map(([name, info]) => (
      [name, info.relative_path]
    ))),
  };
}

function boundedSymbolError(error) {
  return {
    code: String(error?.code || 'CORE_OPERATION_FAILED').slice(0, 100),
    message: String(error?.message || error || 'Unknown error').slice(0, 500),
    phase: String(error?.phase || 'unknown').slice(0, 100),
    retryable: error?.retryable === true,
  };
}

function summaryForSymbols(symbols, requested = symbols.length) {
  return {
    requested,
    succeeded: symbols.filter((item) => item.status === 'succeeded').length,
    failed: symbols.filter((item) => item.status === 'failed').length,
    skipped: symbols.filter((item) => item.status === 'skipped').length,
  };
}

async function exportStrategySymbolIntoRun({
  entity_id,
  symbol,
  timeframe,
  context,
  format,
  batch_limit,
  timeout_ms,
  transaction,
  namespace,
  _deps,
}) {
  validateStrategySymbolRequest({
    entity_id, symbol, context, command: 'strategy trading-export',
  });
  if (!transaction) throw new TypeError('A run artifact transaction is required.');
  const resolvedFormat = resolveTradingDataFormat({ format });
  const pagination = paginationValues({ offset: 0, limit: batch_limit });
  const relativePaths = symbolArtifactPaths(symbol, resolvedFormat, namespace);
  const createEncoder = _deps?.createTradingDataEncoder || createTradingDataEncoder;
  const createAccumulator = _deps?.createTradingDataMetricsAccumulator
    || createTradingDataMetricsAccumulator;
  const reconcile = _deps?.reconcileTradingReport || reconcileTradingReport;
  const readRawTradingReport = _deps?.readRawTradingReport || _readRawTradingReport;
  let encoder = null;
  try {
    const execution = await executeFreshStrategySymbol({
      entity_id, symbol, timeframe, context, timeout_ms,
      command: 'trading_export', _deps,
    }, async ({ entity_id: requestedEntityId, inspected, session, observation }) => {
      const reportA = canonicalReportResult({
        entity_id: requestedEntityId, inspected, session, observation, context,
        phase: 'trading_export_report_a_snapshot',
      });
      const total = Number(observation.snapshot_candidate?.trade_count);
      const metadata = completeTradingDataMetadata({
        report: reportA.report, snapshot: reportA.snapshot,
        batchLimit: pagination.limit, total,
      });
      try {
        const writable = await transaction.openArtifact(relativePaths.trades);
        encoder = createEncoder({ format: resolvedFormat, metadata, writable });
        await encoder.start();
      } catch (error) {
        throw artifactWriteError(error, {
          entity_id: requestedEntityId, symbol: session.requested_symbol,
          context, phase: 'artifact_write',
        });
      }

      const accumulator = createAccumulator();
      let offset = 0;
      let batchCount = 0;
      let writtenTrades = 0;
      while (true) {
        const batch = await readTradingDataBatchForSession({
          entity_id: requestedEntityId, inspected, session, observation, offset,
          limit: pagination.limit, snapshot_id: reportA.snapshot.snapshot_id,
          context, _deps,
        });
        if (batch.total !== total || batch.offset !== offset) {
          throw new CoreOperationError('Strategy Trade pagination changed during export.', {
            code: 'TRADING_DATA_INCOMPLETE', phase: 'trading_export_pagination',
            entity_id: requestedEntityId, symbol: session.requested_symbol, context,
          });
        }
        try {
          accumulator.addBatch(batch.trades);
          await encoder.writeBatch(batch.trades);
        } catch (error) {
          throw artifactWriteError(error, {
            entity_id: requestedEntityId, symbol: session.requested_symbol,
            context, phase: 'artifact_write',
          });
        }
        batchCount += 1;
        writtenTrades += batch.returned;
        if (!batch.has_more) break;
        if (!Number.isInteger(batch.next_offset) || batch.next_offset <= offset) {
          throw new CoreOperationError('Strategy Trade pagination did not advance.', {
            code: 'TRADING_DATA_INCOMPLETE', phase: 'trading_export_pagination',
            entity_id: requestedEntityId, symbol: session.requested_symbol, context,
          });
        }
        offset = batch.next_offset;
      }
      if (writtenTrades !== total) {
        throw new CoreOperationError('Strategy Trading export did not read every Trade.', {
          code: 'TRADING_DATA_INCOMPLETE', phase: 'trading_export_pagination',
          entity_id: requestedEntityId, symbol: session.requested_symbol, context,
        });
      }
      let encoderResult;
      try {
        encoderResult = await encoder.finish();
      } catch (error) {
        throw artifactWriteError(error, {
          entity_id: requestedEntityId, symbol: session.requested_symbol,
          context, phase: 'artifact_write',
        });
      }

      const reportBObservation = await readRawTradingReport({
        entity_id: requestedEntityId, session,
        phase: 'trading_export_report_b', _deps,
      });
      const reportB = canonicalReportResult({
        entity_id: requestedEntityId, inspected, session,
        observation: reportBObservation, context,
        phase: 'trading_export_report_b_snapshot',
      });
      assertMatchingSnapshot(reportA.snapshot, reportB.snapshot, {
        entity_id: requestedEntityId, symbol: session.requested_symbol,
        context, phase: 'trading_export_report_b_snapshot',
      });

      const tradingDataMetrics = accumulator.finish();
      const reconciliation = reconcile({
        reportMetrics: reportB.report.reconciliation_metrics,
        tradingDataMetrics,
      });
      if (!reconciliation.success) {
        throw new CoreOperationError(
          `Strategy Trading reconciliation failed: ${reconciliation.mismatched_metrics.join(', ')}.`,
          {
            code: 'RECONCILIATION_MISMATCH', phase: 'trading_export_reconciliation',
            entity_id: requestedEntityId, symbol: session.requested_symbol, context,
          },
        );
      }

      const reportArtifact = {
        success: true, ...reportB.report,
        snapshot: publicSnapshot(reportB.snapshot),
        snapshot_id: reportB.snapshot.snapshot_id,
      };
      const reconciliationArtifact = {
        success: true,
        schema_version: 1,
        context: sanitizeCoreContext(context),
        strategy: inspected.strategy,
        requested_symbol: session.requested_symbol,
        resolved_symbol: session.resolved_symbol,
        symbol: session.resolved_symbol,
        timeframe: session.timeframe,
        snapshot_id: reportB.snapshot.snapshot_id,
        report_metrics: reportB.report.reconciliation_metrics,
        trading_data_metrics: tradingDataMetrics,
        reconciliation,
      };
      try {
        await transaction.writeJson(relativePaths.report, reportArtifact);
        await transaction.writeJson(relativePaths.reconciliation, reconciliationArtifact);
      } catch (error) {
        throw artifactWriteError(error, {
          entity_id: requestedEntityId, symbol: session.requested_symbol,
          context, phase: 'artifact_write',
        });
      }
      const [reportInfo, tradesInfo, reconciliationInfo] = await Promise.all([
        transaction.artifactInfo(relativePaths.report),
        transaction.artifactInfo(relativePaths.trades),
        transaction.artifactInfo(relativePaths.reconciliation),
      ]);
      return {
        success: true,
        context: sanitizeCoreContext(context),
        strategy: inspected.strategy,
        requested_symbol: session.requested_symbol,
        resolved_symbol: session.resolved_symbol,
        symbol: session.resolved_symbol,
        timeframe: session.timeframe,
        inputs_fingerprint: observation.snapshot_candidate.inputs_fingerprint,
        snapshot_id: reportB.snapshot.snapshot_id,
        snapshot_schema_version: reportB.snapshot.snapshot_schema_version,
        report_schema_version: reportB.report.schema_version,
        trading_data_schema_version: metadata.schema_version,
        total_trades: total,
        batch_count: batchCount,
        format: resolvedFormat,
        encoder: encoderResult,
        reconciliation,
        artifacts: {
          report: reportInfo, trades: tradesInfo, reconciliation: reconciliationInfo,
        },
      };
    });
    return { ...execution.result, symbol_session: execution.symbol_session };
  } catch (error) {
    try {
      await encoder?.abort();
    } catch {
      // Keep the workflow failure as the primary error.
    }
    throw error;
  }
}

/**
 * Export one Strategy/Symbol. An internal run transaction lets the Watchlist
 * orchestrator reuse this exact workflow without nested publication/restores.
 */
export async function exportStrategySymbol(options = {}) {
  if (options?._run?.transaction) {
    return exportStrategySymbolIntoRun({
      ...options,
      transaction: options._run.transaction,
      namespace: options._run.namespace,
    });
  }
  const {
    entity_id, symbol, timeframe, context, output_directory, format, force = false,
    batch_limit, run_id, timeout_ms, _deps,
  } = options;
  validateStrategySymbolRequest({
    entity_id, symbol, context, command: 'strategy trading-export',
  });
  if (output_directory == null || !String(output_directory).trim()) {
    throw new CoreOperationError('--output directory is required for strategy trading-export.', {
      code: 'OUTPUT_WRITE_FAILED', phase: 'output_validation', entity_id, symbol, context,
    });
  }
  const resolvedFormat = resolveTradingDataFormat({ format });
  paginationValues({ offset: 0, limit: batch_limit });
  const createTransaction = _deps?.createArtifactSetTransaction || createArtifactSetTransaction;
  const transaction = await createTransaction({
    output_directory, run_id, force, _deps: _deps?.artifactDeps,
  });
  const now = _deps?.now || Date.now;
  const withChartSession = _deps?.withChartSession || _withChartSession;
  const restoreSymbolSession = _deps?.restoreSymbolSession || _restoreSymbolSession;
  const startedAt = now();
  let symbolSession = null;
  try {
    const exported = await withChartSession({ context, _deps }, async () => {
      let result;
      try {
        result = await exportStrategySymbolIntoRun({
          entity_id, symbol, timeframe, context, format: resolvedFormat,
          batch_limit, timeout_ms, transaction,
          _deps: {
            ..._deps,
            onSymbolSession: async (session) => { symbolSession = session; },
          },
        });
        return result;
      } finally {
        if (symbolSession) {
          const restore = await restoreSymbolSession(symbolSession, { timeout_ms, _deps });
          if (result) result.chart_restore = restore;
        }
      }
    });

    const completedAt = now();
    const manifest = {
      schema_version: 1,
      run_id: transaction.run_id,
      mode: 'single_symbol',
      status: 'succeeded',
      context: exported.context,
      strategy: exported.strategy,
      inputs_fingerprint: exported.inputs_fingerprint,
      requested_symbols: [exported.requested_symbol],
      timeframe: exported.timeframe,
      format: resolvedFormat,
      schema_versions: {
        manifest: 1,
        trading_report: exported.report_schema_version,
        trading_data: exported.trading_data_schema_version,
        reconciliation: 1,
        snapshot: exported.snapshot_schema_version,
      },
      started_at: startedAt,
      started_at_iso: unixMillisecondsToIso(startedAt),
      completed_at: completedAt,
      completed_at_iso: unixMillisecondsToIso(completedAt),
      summary: { requested: 1, succeeded: 1, failed: 0, skipped: 0 },
      symbols: [manifestSymbolSuccess(exported)],
      chart_restore: exported.chart_restore,
    };
    await transaction.writeJson('manifest.json', manifest);
    const manifestInfo = await transaction.artifactInfo('manifest.json');
    const publication = await transaction.publish();
    const { symbol_session: _symbolSession, ...publicExported } = exported;
    return {
      ...publicExported,
      success: true,
      run_id: transaction.run_id,
      mode: 'single_symbol',
      status: 'succeeded',
      output: publication,
      reconciliation: { success: true },
      artifacts: { manifest: manifestInfo, ...exported.artifacts },
    };
  } catch (error) {
    try {
      await transaction.abort();
    } catch {
      // Keep the workflow failure as the primary error.
    }
    throw error;
  }
}

function contextAtCurrentChart(context, session) {
  if (!session) return context;
  return Object.freeze({
    ...context,
    symbol: session.resolved_symbol,
    resolution: session.timeframe,
  });
}

function finalRestoreSession(lastSession, chartSession) {
  return Object.freeze({
    ...lastSession,
    original_symbol: chartSession.original_symbol,
    original_timeframe: chartSession.original_timeframe,
    symbol_changed: !symbolIdentitiesMatch(lastSession.resolved_symbol, chartSession.original_symbol),
    timeframe_changed: String(lastSession.timeframe) !== String(chartSession.original_timeframe),
  });
}

function providedSnapshotSymbols(snapshot) {
  const items = Array.isArray(snapshot?.symbols) ? snapshot.symbols : [];
  return items.map((item) => (
    typeof item === 'string' ? item : item?.symbol
  )).filter((symbol) => typeof symbol === 'string' && symbol.length > 0);
}

function snapshotIsComplete(snapshot, mode) {
  if (snapshot?.snapshot?.complete != null) return snapshot.snapshot.complete === true;
  if (snapshot?.complete != null) return snapshot.complete === true;
  return mode === 'active_watchlist' && Array.isArray(snapshot?.symbols);
}

/**
 * Export a caller-supplied immutable Snapshot inside an existing artifact and
 * Chart transaction. This is the shared seam for formal Strategy Runs and the
 * legacy Active Watchlist command.
 */
export async function exportStrategySnapshotIntoRun({
  entity_id,
  snapshot,
  timeframe,
  context,
  format,
  fail_fast = false,
  batch_limit,
  timeout_ms,
  transaction,
  namespace,
  expected_inputs_fingerprint,
  mode = 'provided_watchlist',
  _deps = {},
} = {}) {
  validateStrategyContextRequest({ entity_id, context });
  if (!transaction) throw new TypeError('A run artifact transaction is required.');
  if (!snapshotIsComplete(snapshot, mode)) {
    throw new CoreOperationError('Provided Watchlist Snapshot is incomplete.', {
      code: 'WATCHLIST_INCOMPLETE', phase: 'watchlist_snapshot', entity_id, context,
    });
  }
  const resolvedFormat = resolveTradingDataFormat({ format });
  paginationValues({ offset: 0, limit: batch_limit });
  const requestedSymbols = providedSnapshotSymbols(snapshot);
  if (requestedSymbols.length === 0) {
    throw new CoreOperationError('Watchlist Snapshot is empty.', {
      code: 'WATCHLIST_EMPTY', phase: 'watchlist_snapshot', entity_id, context,
    });
  }
  const safeNamespace = artifactNamespace(namespace);
  const manifestPath = namespacedArtifactPath(safeNamespace, 'manifest.json');
  const now = _deps.now || Date.now;
  const restoreSymbolSession = _deps.restoreSymbolSession || _restoreSymbolSession;
  const exportSymbol = _deps.exportStrategySymbol || exportStrategySymbol;
  const startedAt = now();
  const symbolResults = [];
  const seen = new Map();
  let lastSession = null;
  let chartRestore = null;
  let strategy = null;
  let inputsFingerprint = expected_inputs_fingerprint || null;
  let schemaVersions = null;

  const manifest = (status, completedAt = null) => ({
    schema_version: 1,
    run_id: transaction.run_id,
    mode,
    namespace: safeNamespace || null,
    status,
    context: sanitizeCoreContext(context),
    strategy: strategy || { entity_id: String(entity_id).trim(), type: 'strategy' },
    inputs_fingerprint: inputsFingerprint,
    watchlist: snapshot,
    requested_symbols: requestedSymbols,
    timeframe: timeframe == null ? context.resolution : String(timeframe),
    format: resolvedFormat,
    schema_versions: schemaVersions || {
      manifest: 1, trading_report: null, trading_data: null,
      reconciliation: 1, snapshot: null,
    },
    duplicate_policy: 'first_occurrence_wins_later_entries_skipped',
    started_at: startedAt,
    started_at_iso: unixMillisecondsToIso(startedAt),
    ...(completedAt != null && {
      completed_at: completedAt,
      completed_at_iso: unixMillisecondsToIso(completedAt),
    }),
    summary: summaryForSymbols(symbolResults, requestedSymbols.length),
    symbols: symbolResults,
    ...(chartRestore && { chart_restore: chartRestore }),
  });

  await transaction.replaceJson(manifestPath, manifest('running'));
  let stop = false;
  try {
    for (let index = 0; index < requestedSymbols.length; index += 1) {
          const requestedSymbol = requestedSymbols[index];
          if (stop) {
            symbolResults.push({
              index, requested_symbol: requestedSymbol, status: 'skipped',
              phase: 'not_started', reason: 'fail_fast',
              diagnostics: [{ code: 'FAIL_FAST', message: 'Skipped after an earlier Symbol failed.' }],
            });
            await transaction.replaceJson(manifestPath, manifest('running'));
            continue;
          }
          const duplicateOf = seen.get(requestedSymbol);
          if (duplicateOf != null) {
            symbolResults.push({
              index, requested_symbol: requestedSymbol, status: 'skipped',
              phase: 'not_started', reason: 'duplicate_symbol', duplicate_of_index: duplicateOf,
              diagnostics: [{
                code: 'DUPLICATE_SYMBOL',
                message: `First occurrence at Watchlist index ${duplicateOf}.`,
              }],
            });
            await transaction.replaceJson(manifestPath, manifest('running'));
            continue;
          }
          seen.set(requestedSymbol, index);
          const currentContext = contextAtCurrentChart(context, lastSession);
          try {
            const exported = await exportSymbol({
              entity_id, symbol: requestedSymbol, timeframe,
              context: currentContext, format: resolvedFormat,
              batch_limit, timeout_ms, _run: { transaction, namespace: safeNamespace },
              _deps: {
                ..._deps,
                onSymbolSession: async (session) => { lastSession = session; },
              },
            });
            lastSession = exported.symbol_session || lastSession;
            if (
              inputsFingerprint
              && JSON.stringify(exported.inputs_fingerprint) !== JSON.stringify(inputsFingerprint)
            ) {
              throw new CoreOperationError('Strategy inputs changed during the Watchlist export.', {
                code: 'STRATEGY_INPUTS_CHANGED', phase: 'watchlist_strategy_validation',
                entity_id, symbol: requestedSymbol, context: currentContext,
              });
            }
            strategy = strategy || exported.strategy;
            inputsFingerprint = inputsFingerprint || exported.inputs_fingerprint;
            schemaVersions = schemaVersions || {
              manifest: 1,
              trading_report: exported.report_schema_version,
              trading_data: exported.trading_data_schema_version,
              reconciliation: 1,
              snapshot: exported.snapshot_schema_version,
            };
            symbolResults.push({ index, ...manifestSymbolSuccess(exported) });
          } catch (error) {
            await transaction.removePath(
              symbolArtifactPaths(requestedSymbol, resolvedFormat, safeNamespace).directory,
            );
            symbolResults.push({
              index,
              requested_symbol: requestedSymbol,
              status: 'failed',
              phase: error?.phase || 'unknown',
              error: boundedSymbolError(error),
              diagnostics: [boundedSymbolError(error)],
            });
            if (fail_fast) stop = true;
          }
          await transaction.replaceJson(manifestPath, manifest('running'));
    }
  } finally {
    if (lastSession) {
      chartRestore = await restoreSymbolSession(
        finalRestoreSession(lastSession, {
          original_symbol: context.symbol,
          original_timeframe: context.resolution,
        }),
        { timeout_ms, _deps },
      );
    } else {
      chartRestore = {
        success: true, restored: false,
        symbol: context.symbol,
        timeframe: context.resolution,
      };
    }
  }

    const summary = summaryForSymbols(symbolResults, requestedSymbols.length);
    const status = summary.failed > 0 ? 'partial' : 'succeeded';
    const completedAt = now();
    await transaction.replaceJson(manifestPath, manifest(status, completedAt));
    const manifestInfo = await transaction.artifactInfo(manifestPath);
    const hasCdpFailure = symbolResults.some((item) => (
      item.status === 'failed' && String(item.error?.code || '').startsWith('CDP_')
    ));
    return {
      success: summary.failed === 0,
      run_id: transaction.run_id,
      mode,
      status,
      context: sanitizeCoreContext(context),
      strategy: strategy || { entity_id: String(entity_id).trim(), type: 'strategy' },
      watchlist: snapshot,
      timeframe: timeframe == null ? context.resolution : String(timeframe),
      format: resolvedFormat,
      summary,
      symbols: symbolResults,
      artifacts: { manifest: manifestInfo },
      chart_restore: chartRestore,
      ...(hasCdpFailure && { failure_kind: 'cdp_connection' }),
    };
}

/** Export the immutable Active Watchlist sequentially in one Chart/run transaction. */
export async function exportStrategyWatchlist({
  entity_id,
  watchlist = 'active',
  timeframe,
  context,
  output_directory,
  format,
  force = false,
  fail_fast = false,
  batch_limit,
  run_id,
  timeout_ms,
  _deps = {},
} = {}) {
  validateStrategyContextRequest({ entity_id, context });
  if (watchlist !== 'active') {
    throw new CoreOperationError('--watchlist currently supports only active.', {
      code: 'WATCHLIST_SCOPE_UNSUPPORTED', phase: 'request_validation', entity_id, context,
    });
  }
  if (output_directory == null || !String(output_directory).trim()) {
    throw new CoreOperationError('--output directory is required for strategy trading-export.', {
      code: 'OUTPUT_WRITE_FAILED', phase: 'output_validation', entity_id, context,
    });
  }
  const captureWatchlist = _deps.captureActiveWatchlistSnapshot
    || _captureActiveWatchlistSnapshot;
  const snapshot = await captureWatchlist({ _deps });
  if (providedSnapshotSymbols(snapshot).length === 0) {
    throw new CoreOperationError('Active Watchlist is empty.', {
      code: 'WATCHLIST_EMPTY', phase: 'watchlist_snapshot', entity_id, context,
    });
  }
  const createTransaction = _deps.createArtifactSetTransaction || createArtifactSetTransaction;
  const transaction = await createTransaction({
    output_directory, run_id, force, _deps: _deps.artifactDeps,
  });
  const withChartSession = _deps.withChartSession || _withChartSession;
  try {
    const exported = await withChartSession({ context, _deps }, () => (
      exportStrategySnapshotIntoRun({
        entity_id, snapshot, timeframe, context, format, fail_fast,
        batch_limit, timeout_ms, transaction, mode: 'active_watchlist', _deps,
      })
    ));
    const publication = await transaction.publish();
    return { ...exported, output: publication };
  } catch (error) {
    try {
      await transaction.abort();
    } catch {
      // Keep the workflow failure as the primary error.
    }
    throw error;
  }
}

/** Dispatch the stable trading-export contract to one Symbol or Active Watchlist. */
export async function exportStrategyTrading(options = {}) {
  validateStrategyTradingExportScope(options);
  if (options.watchlist != null) return exportStrategyWatchlist(options);
  return exportStrategySymbol(options);
}
