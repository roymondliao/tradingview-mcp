/**
 * Core replay mode logic.
 */
import { evaluate as _evaluate, getReplayApi as _getReplayApi } from '../connection.js';
import { unixSecondsToIso } from './time.js';

export const VALID_AUTOPLAY_DELAYS = [100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000];
export const REPLAY_START_RATIO = 0.10;
export const REPLAY_MIN_FUTURE_BARS = 5;
export const REPLAY_MAX_FUTURE_BARS = 200;
export const REPLAY_MIN_VALID_BARS = 10;
const REPLAY_STATE_TIMEOUT_MS = 20000;
const REPLAY_POLL_MS = 200;

function wv(path) {
  return `(function(){ var v = ${path}; return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; })()`;
}

function _resolve(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    getReplayApi: deps?.getReplayApi || _getReplayApi,
    delay: deps?.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))),
  };
}

/** Select a bounded recent Replay point from ordered, valid loaded-bar timestamps. */
export function selectReplayStartBar(barTimes, {
  ratio = 0.10, minimumFutureBars = 5, maximumFutureBars = 200, minimumValidBars = 10,
} = {}) {
  const valid = Array.isArray(barTimes)
    ? barTimes.filter((time) => typeof time === 'number' && Number.isFinite(time))
    : [];
  if (valid.length < minimumValidBars) {
    return {
      error: 'REPLAY_HISTORY_INSUFFICIENT',
      valid_bar_count: valid.length,
      minimum_valid_bars: minimumValidBars,
    };
  }
  const futureBars = Math.min(
    maximumFutureBars,
    Math.max(minimumFutureBars, Math.ceil(valid.length * ratio)),
  );
  const targetPosition = valid.length - 1 - futureBars;
  if (targetPosition < 0 || targetPosition >= valid.length - 1) {
    return {
      error: 'REPLAY_HISTORY_INSUFFICIENT',
      valid_bar_count: valid.length,
      minimum_valid_bars: minimumValidBars,
    };
  }
  return {
    selection_mode: 'loaded_bars_ratio',
    ratio,
    valid_bar_count: valid.length,
    future_bar_count: futureBars,
    target_position: targetPosition,
    target_time: valid[targetPosition],
  };
}

async function discoverReplayStart(evaluate) {
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var bars = chart._chartWidget.model().mainSeries().bars();
      var times = [];
      if (bars && typeof bars.firstIndex === 'function' && typeof bars.lastIndex === 'function') {
        var first = bars.firstIndex();
        var last = bars.lastIndex();
        for (var index = first; index <= last; index++) {
          var value = bars.valueAt(index);
          if (value && typeof value[0] === 'number' && isFinite(value[0])) times.push(value[0]);
        }
      }
      var select = (${selectReplayStartBar.toString()});
      return select(times, {
        ratio: ${REPLAY_START_RATIO},
        minimumFutureBars: ${REPLAY_MIN_FUTURE_BARS},
        maximumFutureBars: ${REPLAY_MAX_FUTURE_BARS},
        minimumValidBars: ${REPLAY_MIN_VALID_BARS}
      });
    })()
  `);
}

async function readReplayChartState(evaluate) {
  return evaluate(`
    (function() {
      var chart = window.TradingViewApi._activeChartWidgetWV.value();
      var bars = chart._chartWidget.model().mainSeries().bars();
      var bodyText = document.body && document.body.innerText || '';
      return {
        symbol: chart.symbol() || '',
        resolution: chart.resolution() || '',
        bar_count: bars && typeof bars.size === 'function' ? bars.size() : 0,
        invalid_symbol: /商品不存在|invalid symbol|symbol not found/i.test(bodyText),
        upstream_error: /upstream error/i.test(bodyText)
      };
    })()
  `);
}

async function waitForReplayChartReady({
  evaluate, before, delay, timeoutMs = REPLAY_STATE_TIMEOUT_MS,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  let lastSignature = null;
  let stableReads = 0;
  while (Date.now() <= deadline) {
    const state = await readReplayChartState(evaluate);
    lastState = state;
    const ready = !state.invalid_symbol
      && !state.upstream_error
      && state.bar_count > 0
      && state.symbol === before.symbol
      && state.resolution === before.resolution;
    const signature = `${state.symbol}|${state.resolution}|${state.bar_count}`;
    if (ready) stableReads = signature === lastSignature ? stableReads + 1 : 1;
    else stableReads = 0;
    if (stableReads >= 3) return state;
    lastSignature = signature;
    await delay(REPLAY_POLL_MS);
  }
  return lastState;
}

async function waitForReplayStopped({ evaluate, rp, delay, timeoutMs = REPLAY_STATE_TIMEOUT_MS }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (!await evaluate(wv(`${rp}.isReplayStarted()`))) return true;
    await delay(REPLAY_POLL_MS);
  }
  return false;
}

async function exitReplay({ evaluate, rp, delay }) {
  await evaluate(`${rp}.goToRealtime()`);
  const stopped = await waitForReplayStopped({ evaluate, rp, delay });
  if (!stopped) throw new Error('Replay did not return to realtime within 20 seconds.');
  // Desktop 3.4.0 requires manager shutdown before closing the Replay UI/session.
  await evaluate(`${rp}.stopReplay()`);
}

export async function start({ date, _deps } = {}) {
  const { evaluate, getReplayApi, delay } = _resolve(_deps);
  let explicitTimestamp = null;
  if (date) {
    explicitTimestamp = new Date(date).getTime();
    if (isNaN(explicitTimestamp)) throw new Error(`Invalid date: "${date}". Use YYYY-MM-DD format.`);
  }
  const rp = await getReplayApi();
  const available = await evaluate(wv(`${rp}.isReplayAvailable()`));
  if (!available) throw new Error('Replay is not available for the current symbol/timeframe');

  const before = await readReplayChartState(evaluate);
  let selection = null;
  if (!date) {
    selection = await discoverReplayStart(evaluate);
    if (selection?.error === 'REPLAY_HISTORY_INSUFFICIENT') {
      throw new Error(
        `REPLAY_HISTORY_INSUFFICIENT: Replay requires at least ${selection.minimum_valid_bars} `
        + `valid loaded bars; received ${selection.valid_bar_count}.`,
      );
    }
    if (!Number.isFinite(selection?.target_time)) {
      throw new Error('REPLAY_HISTORY_INSUFFICIENT: Unable to select a valid loaded-bar timestamp.');
    }
  }

  await evaluate(`${rp}.showReplayToolbar()`);

  // selectDate() is async — it calls enableReplayMode() then _onPointSelected()
  // which initializes the server-side replay session. Must be awaited inside the
  // page context, otherwise the promise is fire-and-forget and replay state says
  // "started" but stepping doesn't work (issue #26).
  if (date) {
    await evaluate(`${rp}.selectDate(${explicitTimestamp}).then(function() { return 'ok'; })`);
  } else {
    await evaluate(`${rp}.selectDate(${selection.target_time * 1000}).then(function() { return 'ok'; })`);
  }

  // Poll until replay is fully initialized: isReplayStarted AND currentDate is set.
  // selectDate()'s promise resolves before the data series is ready, so we need
  // to wait for currentDate to become non-null before stepping will work.
  let started = false;
  let currentDate = null;
  for (let i = 0; i < 30; i++) {
    started = await evaluate(wv(`${rp}.isReplayStarted()`));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (started && currentDate !== null) break;
    await delay(250);
  }

  if (!started) {
    try {
      await exitReplay({ evaluate, rp, delay });
    } catch (cleanupError) {
      throw new Error(
        `Replay failed to start and cleanup failed: ${cleanupError?.message || String(cleanupError)}`,
      );
    }
    throw new Error('Replay failed to start. The selected date may not have data for this timeframe. Try a more recent date or a higher timeframe (e.g., Daily).');
  }

  const after = await waitForReplayChartReady({ evaluate, before, delay });
  if (
    !after || after.invalid_symbol || after.upstream_error || after.bar_count < 1
    || after.symbol !== before.symbol || after.resolution !== before.resolution
  ) {
    try {
      await exitReplay({ evaluate, rp, delay });
    } catch (cleanupError) {
      throw new Error(
        `Replay entered an invalid Chart state and cleanup failed: ${cleanupError?.message || String(cleanupError)}`,
      );
    }
    throw new Error(
      `Replay entered an invalid Chart state: symbol=${after?.symbol || 'unresolved'}, `
      + `resolution=${after?.resolution || 'unresolved'}, bars=${after?.bar_count ?? 0}.`,
    );
  }

  return {
    success: true,
    replay_started: true,
    date: date || unixSecondsToIso(selection.target_time),
    current_date: currentDate,
    current_date_iso: unixSecondsToIso(currentDate),
    ...(selection && { selection }),
  };
}

export async function step({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  const before = await evaluate(wv(`${rp}.currentDate()`));
  await evaluate(`${rp}.doStep()`);
  // doStep() is async internally — currentDate takes ~500ms to update.
  // Poll until it changes or timeout after 3s.
  let currentDate = before;
  for (let i = 0; i < 12; i++) {
    await new Promise(r => setTimeout(r, 250));
    currentDate = await evaluate(wv(`${rp}.currentDate()`));
    if (currentDate !== before) break;
  }
  return {
    success: true,
    action: 'step',
    current_date: currentDate,
    current_date_iso: unixSecondsToIso(currentDate),
  };
}

export async function autoplay({ speed, _deps } = {}) {
  // Validate BEFORE any CDP calls — invalid values corrupt cloud account state permanently
  if (speed > 0 && !VALID_AUTOPLAY_DELAYS.includes(speed))
    throw new Error(`Invalid autoplay delay ${speed}ms. Valid values: ${VALID_AUTOPLAY_DELAYS.join(', ')}`);

  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');
  if (speed > 0) {
    await evaluate(`${rp}.changeAutoplayDelay(${speed})`);
  }
  await evaluate(`${rp}.toggleAutoplay()`);
  const isAutoplay = await evaluate(wv(`${rp}.isAutoplayStarted()`));
  const currentDelay = await evaluate(wv(`${rp}.autoplayDelay()`));
  return { success: true, autoplay_active: !!isAutoplay, delay_ms: currentDelay };
}

export async function stop({ _deps } = {}) {
  const { evaluate, getReplayApi, delay } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) {
    return { success: true, action: 'already_stopped' };
  }
  await exitReplay({ evaluate, rp, delay });
  return { success: true, action: 'replay_stopped' };
}

export async function trade({ action, _deps }) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const started = await evaluate(wv(`${rp}.isReplayStarted()`));
  if (!started) throw new Error('Replay is not started. Use replay_start first.');

  if (action === 'buy') await evaluate(`${rp}.buy()`);
  else if (action === 'sell') await evaluate(`${rp}.sell()`);
  else if (action === 'close') await evaluate(`${rp}.closePosition()`);
  else throw new Error('Invalid action. Use: buy, sell, or close');

  const position = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return { success: true, action, position, realized_pnl: pnl };
}

export async function status({ _deps } = {}) {
  const { evaluate, getReplayApi } = _resolve(_deps);
  const rp = await getReplayApi();
  const st = await evaluate(`
    (function() {
      var r = ${rp};
      function unwrap(v) { return (v && typeof v === 'object' && typeof v.value === 'function') ? v.value() : v; }
      return {
        is_replay_available: unwrap(r.isReplayAvailable()),
        is_replay_started: unwrap(r.isReplayStarted()),
        is_autoplay_started: unwrap(r.isAutoplayStarted()),
        replay_mode: unwrap(r.replayMode()),
        current_date: unwrap(r.currentDate()),
        autoplay_delay: unwrap(r.autoplayDelay()),
      };
    })()
  `);
  const pos = await evaluate(wv(`${rp}.position()`));
  const pnl = await evaluate(wv(`${rp}.realizedPL()`));
  return {
    success: true,
    ...st,
    current_date_iso: unixSecondsToIso(st.current_date),
    position: pos,
    realized_pnl: pnl,
  };
}
