import { compatibilityError, configuredEndpoint, implementationIdentity, normalizeEndpoint } from './identity.js';
export const VERSION_RESPONSE_LIMIT = 64 * 1024;
const token = (ua, name) => ua.match(new RegExp(`(?:^|\\s)${name}/([^\\s]+)`))?.[1] || null;
export function parseDesktopVersionResponse(info, { desktop_version } = {}) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw compatibilityError('COMPATIBILITY_VERSION_INVALID', 'CDP version response must be an object.');
  const ua = typeof info['User-Agent'] === 'string' ? info['User-Agent'] : '';
  const desktop = token(ua, 'TVDesktop'), tradingview = token(ua, 'TradingView');
  if (desktop && tradingview && desktop !== tradingview) throw compatibilityError('COMPATIBILITY_VERSION_CONFLICT', 'Desktop version tokens disagree.');
  const live = desktop || tradingview;
  if (desktop_version != null && !/^[0-9][A-Za-z0-9.+_-]{0,99}$/.test(desktop_version)) throw compatibilityError('COMPATIBILITY_VERSION_INVALID', 'Invalid explicit Desktop version.');
  if (live && desktop_version && live !== desktop_version) throw compatibilityError('COMPATIBILITY_VERSION_CONFLICT', 'Explicit Desktop version differs from the running Desktop.');
  const version = live || desktop_version;
  if (!version || !/^[0-9][A-Za-z0-9.+_-]{0,99}$/.test(version)) throw compatibilityError('COMPATIBILITY_VERSION_UNAVAILABLE', 'Cannot identify the running Desktop version; supply --desktop-version for a manual check.');
  return {
    desktop_version: version,
    desktop_version_source: desktop ? 'cdp_user_agent_tvdesktop' : tradingview ? 'cdp_user_agent_tradingview' : 'explicit_cli',
    electron_version: token(ua, 'Electron'),
    chromium_version: typeof info.Browser === 'string' ? info.Browser.match(/(?:Chrome|Chromium)\/([^\s]+)/)?.[1] || null : null,
    protocol_version: typeof info['Protocol-Version'] === 'string' ? info['Protocol-Version'].slice(0, 100) : null,
  };
}
export async function observeDesktopVersion({ endpoint = configuredEndpoint(), timeout_ms = 2000, desktop_version, _deps = {} } = {}) {
  const ep = normalizeEndpoint(endpoint);
  const controller = new AbortController();
  let timer;
  // Race covers a transport which ignores abort, including injected test transports.
  try {
    const response = await Promise.race([
      (async () => {
        const res = await (_deps.fetch || fetch)(`${ep.url}/json/version`, { signal: controller.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const reader = res.body?.getReader();
        if (!reader) throw new Error('Missing response body');
        const chunks = []; let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > VERSION_RESPONSE_LIMIT) throw new Error('Version response exceeds 64 KiB');
            chunks.push(Buffer.from(value));
          }
          return JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } finally { await reader.cancel().catch(() => {}); }
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('Version query timed out')); }, timeout_ms); }),
    ]);
    return { ...parseDesktopVersionResponse(response, { desktop_version }), ...implementationIdentity(), observed_at: new Date().toISOString() };
  } catch (err) {
    if (err?.code?.startsWith('COMPATIBILITY_')) throw err;
    throw compatibilityError('COMPATIBILITY_ENVIRONMENT_BLOCKED', 'Unable to read the CDP version response.', 'cdp', err);
  } finally { clearTimeout(timer); controller.abort(); }
}
