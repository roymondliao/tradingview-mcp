import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
// Overridable via TV_CDP_HOST/TV_CDP_PORT (or CDP_HOST/CDP_PORT) env vars.
// Default is 127.0.0.1, not localhost: on some Windows machines localhost
// resolves to ::1 first, and Electron's --remote-debugging-port only listens on IPv4.
export const CDP_HOST = process.env.TV_CDP_HOST || process.env.CDP_HOST || '127.0.0.1';
export const CDP_PORT = Number(process.env.TV_CDP_PORT || process.env.CDP_PORT) || 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;
export const CDP_TIMEOUTS = Object.freeze({
  discovery: positiveEnvNumber('TV_CDP_DISCOVERY_TIMEOUT_MS', 3000),
  connect: positiveEnvNumber('TV_CDP_CONNECT_TIMEOUT_MS', 5000),
  command: positiveEnvNumber('TV_CDP_COMMAND_TIMEOUT_MS', 10000),
  activeTarget: positiveEnvNumber('TV_CDP_ACTIVE_TARGET_TIMEOUT_MS', 2500),
  total: positiveEnvNumber('TV_CDP_TOTAL_TIMEOUT_MS', 15000),
});

function positiveEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class CdpOperationError extends Error {
  constructor(message, { code = 'CDP_ERROR', stage, timeout_ms, target_id, chart_id, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CdpOperationError';
    this.code = code;
    if (stage) this.stage = stage;
    if (timeout_ms !== undefined) this.timeout_ms = timeout_ms;
    if (target_id) this.target_id = target_id;
    if (chart_id) this.chart_id = chart_id;
  }
}

export function withTimeout(promise, timeoutMs, { stage = 'operation', target_id } = {}) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CdpOperationError(
        `CDP ${stage} timed out after ${ms}ms`,
        { code: 'CDP_TIMEOUT', stage, timeout_ms: ms, target_id },
      )), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function remainingTimeout(deadline, preferred, stage) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new CdpOperationError(`CDP ${stage} exceeded the total ${CDP_TIMEOUTS.total}ms deadline`, {
      code: 'CDP_TIMEOUT', stage, timeout_ms: CDP_TIMEOUTS.total,
    });
  }
  return Math.max(1, Math.min(preferred, remaining));
}

async function fetchTargets(timeoutMs = CDP_TIMEOUTS.discovery) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const targets = await resp.json();
    if (!Array.isArray(targets)) throw new Error('CDP target list is not an array');
    return targets;
  } catch (err) {
    if (err instanceof CdpOperationError) throw err;
    const timedOut = err?.name === 'AbortError';
    throw new CdpOperationError(
      timedOut ? `CDP target discovery timed out after ${timeoutMs}ms` : `CDP target discovery failed: ${err.message}`,
      {
        code: timedOut ? 'CDP_TIMEOUT' : 'CDP_DISCOVERY_FAILED',
        stage: 'target_discovery',
        ...(timedOut && { timeout_ms: timeoutMs }),
        cause: err,
      },
    );
  } finally {
    clearTimeout(timer);
  }
}

function isChartTarget(target) {
  return target?.type === 'page' && /tradingview\.com\/chart/i.test(target.url || '');
}

function isLandingTarget(target) {
  return target?.type === 'page' && target.title === 'New tab';
}

function isShellTarget(target) {
  return target?.type === 'page' && /\/window\/index\.html/i.test(target.url || '');
}

async function closeQuietly(cdpClient) {
  try { if (cdpClient) await cdpClient.close(); } catch { /* already closed */ }
}

async function connectRaw(target, timeoutMs, stage) {
  let settled = false;
  const pending = CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id }).then((cdpClient) => {
    settled = true;
    return cdpClient;
  });
  try {
    return await withTimeout(pending, timeoutMs, { stage, target_id: target.id });
  } catch (err) {
    if (!settled) pending.then(closeQuietly).catch(() => {});
    throw err;
  }
}

async function activeTabIndexFromShell(targets, timeoutMs) {
  const shells = targets.filter(isShellTarget);
  for (const shell of shells) {
    let shellClient;
    try {
      shellClient = await connectRaw(shell, timeoutMs, 'active_target_shell_connect');
      const response = await withTimeout(shellClient.Runtime.evaluate({
        expression: `(function() {
          var tabs = Array.from(document.querySelectorAll('.tabs-container .tab'));
          if (!tabs.length) return null;
          var active = document.querySelector('.tabs-container .tab.active')
            || document.querySelector('.tabs-container .tab[aria-selected="true"]');
          return active ? tabs.indexOf(active) : null;
        })()`,
        returnByValue: true,
      }), timeoutMs, { stage: 'active_target_shell_evaluate', target_id: shell.id });
      const index = response.result?.value;
      if (Number.isInteger(index) && index >= 0) return index;
    } catch {
      // A stale shell target should not prevent trying another shell or the
      // bounded visibility fallback below.
    } finally {
      await closeQuietly(shellClient);
    }
  }
  return null;
}

async function probeTargetState(target, timeoutMs) {
  let probeClient;
  try {
    probeClient = await connectRaw(target, timeoutMs, 'active_target_probe_connect');
    const response = await withTimeout(probeClient.Runtime.evaluate({
      expression: `({ visibility: document.visibilityState, focused: document.hasFocus() })`,
      returnByValue: true,
    }), timeoutMs, { stage: 'active_target_probe_evaluate', target_id: target.id });
    return response.result?.value || null;
  } catch {
    return null;
  } finally {
    await closeQuietly(probeClient);
  }
}

export async function selectActiveChartTarget(targets, {
  getActiveTabIndex = activeTabIndexFromShell,
  probeTarget = probeTargetState,
  timeoutMs = CDP_TIMEOUTS.activeTarget,
} = {}) {
  const orderedTabs = targets.filter((target) => isChartTarget(target) || isLandingTarget(target));
  const charts = orderedTabs.filter(isChartTarget);
  if (!charts.length) {
    throw new CdpOperationError('No TradingView chart target found. Is TradingView open with a chart?', {
      code: 'CDP_CHART_TARGET_NOT_FOUND', stage: 'active_target',
    });
  }
  if (charts.length === 1) return charts[0];

  // CDP /json/list order is not guaranteed to match the Electron shell tab
  // order. Prefer renderer visibility/focus, which identifies the actual
  // page target, before using the shell ordinal as a bounded fallback.
  const states = await Promise.all(charts.map(async (target) => ({
    target,
    state: await probeTarget(target, timeoutMs),
  })));
  const focused = states.filter(({ state }) => state?.focused);
  if (focused.length === 1) return focused[0].target;
  const visible = states.filter(({ state }) => state?.visibility === 'visible');
  if (visible.length === 1) return visible[0].target;

  const activeIndex = await getActiveTabIndex(targets, timeoutMs);
  if (Number.isInteger(activeIndex)) {
    const active = orderedTabs[activeIndex];
    if (isLandingTarget(active)) {
      throw new CdpOperationError('The active TradingView tab is a New tab page, not a chart.', {
        code: 'CDP_ACTIVE_TAB_NOT_CHART', stage: 'active_target', target_id: active.id,
      });
    }
    // Only trust the ordinal fallback when probing did not prove that the
    // mapped target is hidden. This avoids returning a known background tab.
    const mapped = states.find(({ target }) => target.id === active?.id);
    if (isChartTarget(active) && mapped?.state?.visibility !== 'hidden') return active;
  }

  throw new CdpOperationError('Unable to resolve the active TradingView chart target.', {
    code: focused.length > 1 || visible.length > 1 ? 'CDP_ACTIVE_TARGET_AMBIGUOUS' : 'CDP_ACTIVE_TARGET_UNRESOLVED',
    stage: 'active_target',
    timeout_ms: timeoutMs,
  });
}

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await withTimeout(
        client.Runtime.evaluate({ expression: '1', returnByValue: true }),
        CDP_TIMEOUTS.command,
        { stage: 'client_liveness', target_id: targetInfo?.id },
      );
      return client;
    } catch {
      await closeQuietly(client);
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect(targetId = null) {
  let lastError;
  const deadline = Date.now() + CDP_TIMEOUTS.total;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const targetTimeout = remainingTimeout(deadline, CDP_TIMEOUTS.discovery, 'target_discovery');
      const target = targetId ? await findTargetById(targetId, targetTimeout) : await findChartTarget(targetTimeout);
      if (!target) {
        throw new CdpOperationError(`CDP target ${targetId} not found — is the tab still open?`, {
          code: 'CDP_TARGET_NOT_FOUND', stage: 'target_discovery', target_id: targetId,
        });
      }
      targetInfo = target;
      client = await connectRaw(
        target,
        remainingTimeout(deadline, CDP_TIMEOUTS.connect, 'websocket_connect'),
        'websocket_connect',
      );

      // Enable required domains
      await withTimeout(client.Runtime.enable(), remainingTimeout(deadline, CDP_TIMEOUTS.connect, 'runtime_enable'), {
        stage: 'runtime_enable', target_id: target.id,
      });
      await withTimeout(client.Page.enable(), remainingTimeout(deadline, CDP_TIMEOUTS.connect, 'page_enable'), {
        stage: 'page_enable', target_id: target.id,
      });
      await withTimeout(client.DOM.enable(), remainingTimeout(deadline, CDP_TIMEOUTS.connect, 'dom_enable'), {
        stage: 'dom_enable', target_id: target.id,
      });

      return client;
    } catch (err) {
      lastError = err;
      await closeQuietly(client);
      client = null;
      targetInfo = null;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || attempt === MAX_RETRIES - 1) break;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000, remaining);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  if (lastError instanceof CdpOperationError) throw lastError;
  throw new CdpOperationError(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`, {
    code: 'CDP_CONNECTION_FAILED', stage: 'connect', cause: lastError,
  });
}

/**
 * Re-attach the cached CDP client to a specific target id.
 * Used by tab_switch so subsequent reads (chart_get_state, data_get_*,
 * quote_get, screenshots) follow the activated tab instead of staying
 * glued to the target picked at first connect.
 */
export async function reconnectTo(targetId) {
  if (client) {
    try { await client.close(); } catch { /* already gone */ }
    client = null;
    targetInfo = null;
  }
  return connect(targetId);
}

async function findChartTarget(timeoutMs) {
  const targets = await fetchTargets(timeoutMs);
  return selectActiveChartTarget(targets, { timeoutMs: Math.min(timeoutMs, CDP_TIMEOUTS.activeTarget) });
}

async function findTargetById(id, timeoutMs) {
  const targets = await fetchTargets(timeoutMs);
  return targets.find(t => t.id === id) || null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const timeoutMs = opts.timeout_ms || CDP_TIMEOUTS.command;
  const { timeout_ms: _ignored, ...cdpOpts } = opts;
  const result = await withTimeout(c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: cdpOpts.awaitPromise ?? false,
    ...cdpOpts,
  }), timeoutMs, { stage: 'runtime_evaluate', target_id: targetInfo?.id });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

/**
 * Execute a self-contained function in the TradingView page context.
 * Arguments are passed through CDP CallArgument values instead of being
 * interpolated into source code. The function must not close over Node-side
 * module variables because only its source is available in the page.
 */
export async function callPageFunction(fn, args = []) {
  if (typeof fn !== 'function') throw new TypeError('callPageFunction requires a function');
  if (!Array.isArray(args)) throw new TypeError('callPageFunction args must be an array');

  const c = await getClient();
  const globalResult = await withTimeout(c.Runtime.evaluate({
    expression: 'globalThis',
    returnByValue: false,
  }), CDP_TIMEOUTS.command, { stage: 'runtime_evaluate_global', target_id: targetInfo?.id });
  if (globalResult.exceptionDetails) {
    const msg = globalResult.exceptionDetails.exception?.description
      || globalResult.exceptionDetails.text
      || 'Cannot resolve page global object';
    throw new Error(`JS evaluation error: ${msg}`);
  }

  const objectId = globalResult.result?.objectId;
  if (!objectId) throw new Error('CDP did not return a page global object ID');

  try {
    const result = await withTimeout(c.Runtime.callFunctionOn({
      objectId,
      functionDeclaration: fn.toString(),
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    }), CDP_TIMEOUTS.command, { stage: 'runtime_call_function', target_id: targetInfo?.id });
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception?.description
        || result.exceptionDetails.text
        || 'Unknown function execution error';
      throw new Error(`JS function execution error: ${msg}`);
    }
    return result.result?.value;
  } finally {
    try { await c.Runtime.releaseObject({ objectId }); } catch {}
  }
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
