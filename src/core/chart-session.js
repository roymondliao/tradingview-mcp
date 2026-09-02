/** Immutable Chart Session context, strict mutation readback, and local mutex. */
import { setSymbol as _setSymbol, setTimeframe as _setTimeframe } from './chart.js';
import {
  activatePaneContext as _activatePaneContext,
  assertPaneContext as _assertPaneContext,
  symbolIdentitiesMatch,
} from './pane.js';
import { CoreOperationError } from './errors.js';
import { unixMillisecondsToIso } from './time.js';

const DEFAULT_TIMEOUT_MS = 20000;
const POLL_INTERVAL_MS = 200;
const STABLE_READS = 2;

export class AsyncMutex {
  constructor() {
    this.tail = Promise.resolve();
  }

  async runExclusive(operation) {
    if (typeof operation !== 'function') throw new TypeError('Mutex operation must be a function');
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = previous.then(() => current, () => current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export const chartMutationMutex = new AsyncMutex();

function immutableContext(context) {
  if (!context || typeof context !== 'object') {
    throw new CoreOperationError('Resolved Chart context is required.', {
      code: 'CHART_SESSION_INVALID', phase: 'session_start',
    });
  }
  return Object.freeze({ ...context });
}

function timeoutValue(value) {
  const timeout = value == null ? DEFAULT_TIMEOUT_MS : Number(value);
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 60000) {
    throw new CoreOperationError('timeout_ms must be an integer from 100 to 60000.', {
      code: 'CHART_SESSION_INVALID', phase: 'session_validation',
    });
  }
  return timeout;
}

function timeframeMatches(expected, actual) {
  return expected != null && actual != null && String(expected) === String(actual);
}

async function waitForStrictReadback({
  context,
  symbol,
  timeframe,
  timeout_ms,
  phase = 'symbol_timeframe_readback',
  _deps,
}) {
  const activate = _deps?.activatePaneContext || _activatePaneContext;
  const delay = _deps?.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const now = _deps?.now || Date.now;
  const deadline = now() + timeout_ms;
  let stableReads = 0;
  let lastIdentity = null;
  let lastReadback = null;

  while (now() <= deadline) {
    const readback = await activate({
      context,
      phase,
      activate: true,
      reacquire: false,
      _deps,
    });
    lastReadback = readback;
    const symbolMatches = symbolIdentitiesMatch(symbol, readback.symbol);
    const resolutionMatches = timeframeMatches(timeframe, readback.resolution);
    const identity = `${readback.symbol || ''}|${readback.resolution || ''}`;
    if (symbolMatches && resolutionMatches) {
      stableReads = identity === lastIdentity ? stableReads + 1 : 1;
      if (stableReads >= STABLE_READS) return readback;
    } else {
      stableReads = 0;
    }
    lastIdentity = identity;
    await delay(POLL_INTERVAL_MS);
  }

  const symbolMismatch = !symbolIdentitiesMatch(symbol, lastReadback?.symbol);
  throw new CoreOperationError(
    symbolMismatch
      ? `Symbol readback timed out: expected ${symbol}, received ${lastReadback?.symbol || 'unresolved'}.`
      : `Timeframe readback timed out: expected ${timeframe}, received ${lastReadback?.resolution || 'unresolved'}.`,
    {
      code: symbolMismatch ? 'SYMBOL_SWITCH_FAILED' : 'TIMEFRAME_SWITCH_FAILED',
      phase,
      symbol,
      retryable: true,
      context,
    },
  );
}

/** Serialize a full chart-mutating operation and pin its immutable context. */
export async function withChartSession({ context, _deps } = {}, operation) {
  if (typeof operation !== 'function') throw new TypeError('Chart Session operation must be a function');
  const expectedContext = immutableContext(context);
  const mutex = _deps?.mutex || chartMutationMutex;
  const assertContext = _deps?.assertPaneContext || _assertPaneContext;
  return mutex.runExclusive(async () => {
    const initial = await assertContext({
      context: expectedContext,
      symbol: expectedContext.symbol,
      timeframe: expectedContext.resolution,
      phase: 'session_start',
      _deps,
    });
    const startedAt = (_deps?.now || Date.now)();
    const chartSession = Object.freeze({
      context: expectedContext,
      original_symbol: initial.symbol,
      original_timeframe: initial.resolution,
      started_at: startedAt,
      started_at_iso: unixMillisecondsToIso(startedAt),
    });
    return operation(chartSession);
  });
}

/** Mutate Symbol/Timeframe and require stable API readback from the pinned Pane. */
export async function prepareSymbolSession({
  context,
  symbol,
  timeframe,
  entity_id,
  timeout_ms,
  _deps,
} = {}) {
  const expectedContext = immutableContext(context);
  const timeout = timeoutValue(timeout_ms);
  const assertContext = _deps?.assertPaneContext || _assertPaneContext;
  const setSymbol = _deps?.setSymbol || _setSymbol;
  const setTimeframe = _deps?.setTimeframe || _setTimeframe;
  const before = await assertContext({
    context: expectedContext,
    symbol: expectedContext.symbol,
    timeframe: expectedContext.resolution,
    phase: 'symbol_session_start',
    _deps,
  });
  const requestedSymbol = symbol || before.symbol;
  const requestedTimeframe = timeframe == null ? before.resolution : String(timeframe);
  if (!requestedSymbol) {
    throw new CoreOperationError('Symbol is required for a Symbol Session.', {
      code: 'CHART_SESSION_INVALID', phase: 'session_validation', context: expectedContext,
    });
  }

  const symbolChanged = !symbolIdentitiesMatch(requestedSymbol, before.symbol);
  const timeframeChanged = !timeframeMatches(requestedTimeframe, before.resolution);
  let readback;
  try {
    if (symbolChanged) await setSymbol({ symbol: requestedSymbol, _deps });
    if (timeframeChanged) await setTimeframe({ timeframe: requestedTimeframe, _deps });
    readback = await waitForStrictReadback({
      context: expectedContext,
      symbol: requestedSymbol,
      timeframe: requestedTimeframe,
      timeout_ms: timeout,
      _deps,
    });
  } catch (error) {
    try {
      if (symbolChanged) await setSymbol({ symbol: before.symbol, _deps });
      if (timeframeChanged) await setTimeframe({ timeframe: before.resolution, _deps });
      await waitForStrictReadback({
        context: expectedContext,
        symbol: before.symbol,
        timeframe: before.resolution,
        timeout_ms: timeout,
        phase: 'chart_restore',
        _deps,
      });
    } catch (restoreError) {
      throw new CoreOperationError(
        `Symbol Session failed and original Chart could not be restored: ${restoreError?.message || String(restoreError)}`,
        {
          code: 'CHART_RESTORE_FAILED', phase: 'chart_restore', symbol: before.symbol,
          retryable: true, context: expectedContext, cause: restoreError,
        },
      );
    }
    throw error;
  }
  const startedAt = (_deps?.now || Date.now)();
  return Object.freeze({
    context: expectedContext,
    ...(entity_id && { entity_id }),
    original_symbol: before.symbol,
    original_timeframe: before.resolution,
    requested_symbol: requestedSymbol,
    resolved_symbol: readback.symbol,
    symbol: requestedSymbol,
    timeframe: readback.resolution,
    symbol_changed: symbolChanged,
    timeframe_changed: timeframeChanged,
    started_at: startedAt,
    started_at_iso: unixMillisecondsToIso(startedAt),
  });
}

/** Revalidate a prepared Symbol Session before or after every runtime phase. */
export async function assertSymbolSession(session, { phase = 'symbol_session', _deps } = {}) {
  if (!session?.context || !session?.symbol || session?.timeframe == null) {
    throw new CoreOperationError('Prepared Symbol Session is required.', {
      code: 'CHART_SESSION_INVALID', phase,
    });
  }
  const assertContext = _deps?.assertPaneContext || _assertPaneContext;
  return assertContext({
    context: session.context,
    symbol: session.resolved_symbol || session.symbol,
    timeframe: session.timeframe,
    phase,
    _deps,
  });
}

/** Restore the original Symbol/Timeframe after a prepared Symbol Session. */
export async function restoreSymbolSession(session, { timeout_ms, _deps } = {}) {
  if (!session?.context || !session?.original_symbol || session?.original_timeframe == null) {
    throw new CoreOperationError('Prepared Symbol Session with original Chart identity is required.', {
      code: 'CHART_RESTORE_FAILED', phase: 'chart_restore', context: session?.context,
    });
  }
  const timeout = timeoutValue(timeout_ms);
  const setSymbol = _deps?.setSymbol || _setSymbol;
  const setTimeframe = _deps?.setTimeframe || _setTimeframe;
  try {
    await assertSymbolSession(session, { phase: 'chart_restore_start', _deps });
    if (session.symbol_changed) await setSymbol({ symbol: session.original_symbol, _deps });
    if (session.timeframe_changed) await setTimeframe({ timeframe: session.original_timeframe, _deps });
    const readback = await waitForStrictReadback({
      context: session.context,
      symbol: session.original_symbol,
      timeframe: session.original_timeframe,
      timeout_ms: timeout,
      phase: 'chart_restore',
      _deps,
    });
    return {
      success: true,
      restored: session.symbol_changed || session.timeframe_changed,
      symbol: readback.symbol,
      timeframe: readback.resolution,
    };
  } catch (error) {
    if (error?.code === 'CHART_RESTORE_FAILED') throw error;
    throw new CoreOperationError(`Failed to restore original Chart: ${error?.message || String(error)}`, {
      code: 'CHART_RESTORE_FAILED',
      phase: 'chart_restore',
      symbol: session.original_symbol,
      retryable: true,
      context: session.context,
      cause: error,
    });
  }
}
