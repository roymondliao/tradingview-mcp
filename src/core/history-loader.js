import { historyError, emptyHistoryError } from './history-errors.js';

/** One pending backward request; events are hints and snapshots establish completion. */
export async function loadHistory({ runtime, token, deadline, fromTime, toTime, barsPerRequest, maxRequests, maxBars }) {
  const { now, sleep, policy } = runtime;
  const barsByTime = new Map();
  let snapshot = null, lastCollected = null, collected = false, pending = null;
  let requestsMade = 0, stopReason = null, unreadable = false;
  let waitDeadline = Math.min(deadline, now() + policy.loadTimeoutMs);
  const inRange = time => (fromTime == null || time >= fromTime) && (toTime == null || time <= toTime);
  const expired = () => now() >= deadline ? 'history_timeout'
    : now() >= waitDeadline ? (unreadable ? 'read_failed' : 'load_timeout') : null;
  const read = async options => {
    try { return await runtime.readSnapshot(token, options); }
    catch (error) {
      // The budget can expire between the loop check and the adapter's preflight.
      // Keep partial bars for our deadline; actual CDP failures retain their classification.
      if (error.code === 'HISTORY_TIMEOUT' && expired()) return null;
      throw error;
    }
  };
  const check = s => {
    if (!s) return;
    if (s.identity?.sourceMatches !== true) throw historyError('HISTORY_CONTEXT_CHANGED', 'History source changed.', { kind: 'conflict' });
    if (s.events.error > 0) throw historyError('HISTORY_SOURCE_ERROR', 'Desktop reported a history source error.');
  };
  while (!stopReason) {
    stopReason = expired();
    if (stopReason) break;
    const readDeadline = Math.min(deadline, waitDeadline);
    let next = await read({ includeBars: false, deadline: readDeadline });
    check(next);
    if ((stopReason = expired())) break;
    if (next && !next.loading && (!collected || lastCollected == null || next.first_time < lastCollected)) {
      next = await read({ includeBars: true, beforeTime: collected ? lastCollected : null, deadline: readDeadline });
      check(next);
      if ((stopReason = expired())) break;
      if (next && !next.loading) {
        for (const bar of next.bars || []) if (bar?.time != null && inRange(Number(bar.time))) barsByTime.set(Number(bar.time), bar);
        lastCollected = next.first_time;
        collected = true;
      }
    }
    unreadable = next == null;
    if (next) {
      snapshot = next;
      if (next.loading) {
        if (pending) pending.observedLoading = true;
      } else {
        const progress = pending && next.first_time != null && (pending.previousFirst == null || next.first_time < pending.previousFirst);
        const completed = pending && (pending.observedLoading || next.events.completed > pending.baselineEvents.completed
          || next.events.dataLoaded > pending.baselineEvents.dataLoaded);
        if (barsByTime.size > maxBars) stopReason = 'max_bars';
        else if (fromTime != null && next.first_time != null && next.first_time <= fromTime) stopReason = 'from_reached';
        else if (next.end_of_data && next.end_of_data_type === 'end') stopReason = 'no_more_data';
        else if (next.end_of_data) stopReason = 'unsupported_end_state';
        else if (requestsMade >= maxRequests && (!pending || progress || completed)) stopReason = 'max_requests';
        else if (barsByTime.size === maxBars) stopReason = 'max_bars';
        if (stopReason) break;
        if (pending) {
          if (progress) pending = null;
          else if (completed) { stopReason = 'no_progress'; break; }
        }
        if (!pending && next.more) {
          // A new wait budget is earned by settled progress, not by rejected send attempts.
          const requestDeadline = Math.min(deadline, now() + policy.loadTimeoutMs);
          const response = await runtime.requestMore(token, { count: barsPerRequest, expectedFirst: next.first_time, deadline: requestDeadline });
          if (response?.issued) {
            requestsMade++;
            pending = { previousFirst: next.first_time, baselineEvents: response.baselineEvents, observedLoading: false };
            waitDeadline = requestDeadline;
          }
        }
      }
    }
    const remaining = Math.min(deadline, waitDeadline) - now();
    if (remaining > 0) await sleep(Math.min(policy.pollIntervalMs, remaining));
  }
  let bars = [...barsByTime.values()].sort((a, b) => a.time - b.time);
  if (bars.length > maxBars) bars = bars.slice(-maxBars);
  if (!bars.length) throw emptyHistoryError(stopReason, toTime,
    stopReason === 'history_timeout' ? policy.historyTimeoutMs : policy.loadTimeoutMs);
  return { bars, snapshot, requestsMade, stopReason, complete: ['from_reached', 'no_more_data'].includes(stopReason) };
}
