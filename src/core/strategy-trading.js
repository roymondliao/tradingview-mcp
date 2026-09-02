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
  waitForFreshTradingReport as _waitForFreshTradingReport,
} from './strategy-runtime.js';
import {
  createSnapshotIdentity,
  normalizeTradingReport,
} from './strategy-trading-model.js';
import { CoreOperationError, sanitizeCoreContext } from './errors.js';

function validateTradingReportRequest({ entity_id, symbol, context }) {
  if (!entity_id || !String(entity_id).trim()) {
    throw new CoreOperationError('entity_id is required. Use study list --type strategy.', {
      code: 'STRATEGY_ENTITY_REQUIRED', phase: 'request_validation', context,
    });
  }
  if (!symbol || !String(symbol).trim()) {
    throw new CoreOperationError('--symbol is required for strategy trading-report.', {
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

function publicSnapshot(snapshot) {
  return {
    available: snapshot.available === true,
    snapshot_schema_version: snapshot.snapshot_schema_version,
    snapshot_id: snapshot.snapshot_id,
    algorithm: snapshot.algorithm,
    missing_fields: snapshot.missing_fields,
  };
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
  validateTradingReportRequest({ entity_id, symbol, context });
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
        phase: 'trading_report_before',
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
      const report = normalizeTradingReport(observation, {
        context,
        entity_id: requestedEntityId,
        strategy_name: inspected.strategy?.name ?? null,
        requested_symbol: symbolSession.requested_symbol,
        resolved_symbol: symbolSession.resolved_symbol,
        timeframe: symbolSession.timeframe,
        calculation_mode: observation.snapshot_candidate?.calculation_mode,
      });
      const snapshot = createSnapshotIdentity(observation.snapshot_candidate);
      if (!snapshot.available) {
        throw new CoreOperationError(
          `Trading Report snapshot is incomplete: ${snapshot.missing_fields.join(', ')}`,
          {
            code: 'STRATEGY_SNAPSHOT_UNAVAILABLE',
            phase: 'snapshot_validation',
            entity_id: requestedEntityId,
            symbol: requestedSymbol,
            context,
          },
        );
      }
      result = {
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
    } finally {
      if (symbolSession) {
        const restore = await restoreSymbolSession(symbolSession, { timeout_ms, _deps });
        if (result) result.chart_restore = restore;
      }
    }
    return result;
  });
}
