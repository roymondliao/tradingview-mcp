import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDesktopVersionResponse, observeDesktopVersion } from '../src/core/compatibility/version.js';
import { sameIdentity, implementationIdentity, normalizeEndpoint } from '../src/core/compatibility/identity.js';
const response = { Browser: 'Chrome/146.1', 'Protocol-Version': '1.3', 'User-Agent': 'TradingView/3.4.1 TVDesktop/3.4.1 Electron/41.7.1' };
test('version tokens identify Desktop, not Chromium, preserving exact suffixes', () => {
  const info = parseDesktopVersionResponse(response);
  assert.equal(info.desktop_version, '3.4.1'); assert.equal(info.chromium_version, '146.1');
  assert.equal(parseDesktopVersionResponse({ 'User-Agent': 'TradingView/3.5.0-beta.1' }).desktop_version, '3.5.0-beta.1');
  assert.throws(() => parseDesktopVersionResponse({ ...response, 'User-Agent': 'TradingView/3.3 TVDesktop/3.4' }), { code: 'COMPATIBILITY_VERSION_CONFLICT' });
  assert.throws(() => parseDesktopVersionResponse({ Browser: 'Chrome/146' }), { code: 'COMPATIBILITY_VERSION_UNAVAILABLE' });
  assert.throws(() => parseDesktopVersionResponse(response, { desktop_version: '3.3' }), { code: 'COMPATIBILITY_VERSION_CONFLICT' });
  assert.equal(parseDesktopVersionResponse({}, { desktop_version: '3.4.1' }).desktop_version_source, 'explicit_cli');
});
test('bounded observer rejects HTTP, malformed, oversized and never-settling transports', async () => {
  const observe = fetch => observeDesktopVersion({ timeout_ms: 20, _deps: { fetch } });
  assert.equal((await observe(async () => new Response(JSON.stringify(response)))).desktop_version, '3.4.1');
  for (const fn of [async () => new Response('{}', { status: 401 }), async () => new Response('no'), async () => new Response('x'.repeat(65537)), () => new Promise(() => {})]) {
    await assert.rejects(observe(fn), { code: 'COMPATIBILITY_ENVIRONMENT_BLOCKED' });
  }
});
test('identity checks all revisions and known metadata, endpoint is normalized without DNS', () => {
  const a = { ...parseDesktopVersionResponse(response), ...implementationIdentity() };
  assert.equal(sameIdentity(a, { ...a }), true);
  for (const k of ['desktop_version', 'protocol_version', 'node_major', 'checker_revision', 'adapter_revision']) assert.equal(sameIdentity(a, { ...a, [k]: null }), false);
  assert.equal(normalizeEndpoint({ host: 'EXAMPLE.COM', port: '9222' }).key, 'example.com:9222');
  assert.equal(normalizeEndpoint({ host: '::1' }).url, 'http://[::1]:9222');
  assert.throws(() => normalizeEndpoint({ host: 'host/path' }));
});
