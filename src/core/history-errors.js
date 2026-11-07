import { CoreOperationError } from './errors.js';

export function historyError(code, message, options = {}) {
  return new CoreOperationError(message, {
    code, kind: 'internal', phase: 'history_load', retryable: false, ...options,
  });
}

export function emptyHistoryError(reason, toTime, timeoutMs) {
  if (reason === 'from_reached' || reason === 'no_more_data') {
    return historyError('HISTORY_RANGE_EMPTY', toTime == null
      ? 'No historical bars matched the requested start time.'
      : 'No historical bars matched the requested date range.', { kind: 'validation', stage: reason });
  }
  const codes = {
    load_timeout: 'HISTORY_LOAD_TIMEOUT', history_timeout: 'HISTORY_TIMEOUT',
    max_bars: 'HISTORY_LIMIT_REACHED', max_requests: 'HISTORY_LIMIT_REACHED',
    unsupported_end_state: 'HISTORY_END_STATE_UNSUPPORTED',
  };
  const limited = reason === 'max_bars' || reason === 'max_requests';
  return historyError(codes[reason] || 'HISTORY_LOAD_INCOMPLETE',
    `Historical data has not been confirmed for the requested range (${reason}).`, {
      kind: limited ? 'validation' : 'internal', stage: reason,
      retryable: ['load_timeout', 'history_timeout', 'read_failed', 'no_progress'].includes(reason),
      ...(['load_timeout', 'history_timeout'].includes(reason) ? { timeout_ms: timeoutMs } : {}),
    });
}
