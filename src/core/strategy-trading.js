/** CLI-first Strategy Trading application services. */
import {
  prepareSymbolSession as _prepareSymbolSession,
  restoreSymbolSession as _restoreSymbolSession,
  withChartSession as _withChartSession,
} from './chart-session.js';
import {
  ensureStrategyActive as _ensureStrategyActive,
  inspectStrategySource as _inspectStrategySource,
  readRawReportState as _readRawReportState,
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
import { CoreOperationError, sanitizeCoreContext } from './errors.js';

function validateStrategySymbolRequest({ entity_id, symbol, context, command }) {
  if (!entity_id || !String(entity_id).trim()) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase: 'request_validation', context,
    });
  }
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
  if (!context || typeof context !== 'object') {
    throw new CoreOperationError('Resolved Pane context is required.', {
      code: 'CHART_SESSION_INVALID', phase: 'request_validation', entity_id, symbol,
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

async function withFreshStrategySymbol({
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
  const withChartSession = _deps?.withChartSession || _withChartSession;
  const inspectStrategySource = _deps?.inspectStrategySource || _inspectStrategySource;
  const ensureStrategyActive = _deps?.ensureStrategyActive || _ensureStrategyActive;
  const readRawReportState = _deps?.readRawReportState || _readRawReportState;
  const prepareSymbolSession = _deps?.prepareSymbolSession || _prepareSymbolSession;
  const waitForFreshTradingReport = _deps?.waitForFreshTradingReport || _waitForFreshTradingReport;
  const restoreSymbolSession = _deps?.restoreSymbolSession || _restoreSymbolSession;

  return withChartSession({ context, _deps }, async () => {
    let symbolSession = null;
    let result;
    try {
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
      symbolSession = await prepareSymbolSession({
        context,
        entity_id: requestedEntityId,
        symbol: requestedSymbol,
        timeframe,
        timeout_ms,
        _deps,
      });
      const observation = await waitForFreshTradingReport({
        entity_id: requestedEntityId,
        session: symbolSession,
        before,
        mutated: symbolSession.symbol_changed || symbolSession.timeframe_changed,
        timeout_ms,
        _deps,
      });
      result = await operation({
        entity_id: requestedEntityId,
        requested_symbol: requestedSymbol,
        inspected,
        session: symbolSession,
        observation,
      });
    } finally {
      if (symbolSession) {
        const restore = await restoreSymbolSession(symbolSession, { timeout_ms, _deps });
        if (result) result.chart_restore = restore;
      }
    }
    return result;
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
      const report = normalizeTradingReport(observation, {
        context,
        entity_id: requestedEntityId,
        strategy_name: inspected.strategy?.name ?? null,
        requested_symbol: symbolSession.requested_symbol,
        resolved_symbol: symbolSession.resolved_symbol,
        timeframe: symbolSession.timeframe,
        calculation_mode: observation.snapshot_candidate?.calculation_mode,
      });
      const snapshot = assertAvailableSnapshot(
        createSnapshotIdentity(observation.snapshot_candidate),
        {
          entity_id: requestedEntityId, symbol: symbolSession.requested_symbol,
          context, phase: 'snapshot_validation',
        },
      );
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

/** Read one canonical oldest-first Strategy Trade batch from a stable snapshot. */
export async function getStrategyTradingData({
  entity_id,
  symbol,
  timeframe,
  offset,
  limit,
  snapshot_id,
  context,
  timeout_ms,
  _deps,
} = {}) {
  validateStrategySymbolRequest({
    entity_id, symbol, context, command: 'strategy trading-data',
  });
  const pagination = paginationValues({ offset, limit, snapshot_id });
  const readRawTradingDataBatch = _deps?.readRawTradingDataBatch || _readRawTradingDataBatch;
  return withFreshStrategySymbol({
    entity_id, symbol, timeframe, context, timeout_ms,
    command: 'trading_data', _deps,
  }, async ({ entity_id: requestedEntityId, inspected, session, observation }) => {
    const reportSnapshot = assertAvailableSnapshot(
      createSnapshotIdentity(observation.snapshot_candidate),
      {
        entity_id: requestedEntityId, symbol: session.requested_symbol,
        context, phase: 'trading_data_snapshot',
      },
    );
    if (pagination.snapshot_id) {
      assertMatchingSnapshot(pagination.snapshot_id, reportSnapshot, {
        entity_id: requestedEntityId, symbol: session.requested_symbol,
        context, phase: 'trading_data_snapshot',
      });
    }

    const rawBatch = await readRawTradingDataBatch({
      entity_id: requestedEntityId,
      session,
      offset: pagination.offset,
      limit: pagination.limit,
      _deps,
    });
    if (rawBatch.status_type !== 2 || rawBatch.snapshot_changed) {
      throw new CoreOperationError('Strategy Report changed while reading the Trade batch.', {
        code: 'STALE_STRATEGY_SNAPSHOT', phase: 'trading_data_batch',
        entity_id: requestedEntityId, symbol: session.requested_symbol,
        retryable: true, context,
      });
    }
    const batchBefore = assertAvailableSnapshot(
      createSnapshotIdentity(rawBatch.snapshot_before),
      {
        entity_id: requestedEntityId, symbol: session.requested_symbol,
        context, phase: 'trading_data_batch_before',
      },
    );
    const batchAfter = assertAvailableSnapshot(
      createSnapshotIdentity(rawBatch.snapshot_after),
      {
        entity_id: requestedEntityId, symbol: session.requested_symbol,
        context, phase: 'trading_data_batch_after',
      },
    );
    assertMatchingSnapshot(reportSnapshot, batchBefore, {
      entity_id: requestedEntityId, symbol: session.requested_symbol,
      context, phase: 'trading_data_batch_before',
    });
    assertMatchingSnapshot(batchBefore, batchAfter, {
      entity_id: requestedEntityId, symbol: session.requested_symbol,
      context, phase: 'trading_data_batch_after',
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
        entity_id: requestedEntityId, symbol: session.requested_symbol, context,
      });
    }
    const expectedReturned = Math.min(pagination.limit, rawBatch.total - pagination.offset);
    if (rawBatch.returned !== expectedReturned) {
      throw new CoreOperationError('Strategy Trade batch did not return the expected contiguous range.', {
        code: 'TRADING_DATA_INCOMPLETE', phase: 'trading_data_completeness',
        entity_id: requestedEntityId, symbol: session.requested_symbol, context,
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
      context: sanitizeCoreContext(context),
      strategy: inspected.strategy,
      requested_symbol: session.requested_symbol,
      resolved_symbol: session.resolved_symbol,
      symbol: session.resolved_symbol,
      timeframe: session.timeframe,
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
  });
}
