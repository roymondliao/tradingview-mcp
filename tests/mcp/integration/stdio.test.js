import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real MCP stdio transport preserves tool discovery and input validation', { timeout: 15000 }, async t => {
  const client = new Client({ name: 'stdio-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../../src/server.js', import.meta.url))],
    stderr: 'pipe',
  });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, 'tradingview');

  const { tools } = await client.listTools();
  const names = tools.map(tool => tool.name);
  assert.equal(new Set(names).size, names.length, 'tool names remain unique');
  for (const name of ['pine_analyze', 'study_list', 'strategy_get_active', 'tv_health_check']) {
    assert.ok(names.includes(name), `${name} is discoverable`);
  }
  const analyze = tools.find(tool => tool.name === 'pine_analyze');
  assert.equal(analyze.inputSchema.properties.source.type, 'string');
  assert.ok(analyze.inputSchema.required.includes('source'));

  const result = await client.callTool({
    name: 'pine_analyze',
    arguments: { source: '//@version=6\nindicator("Smoke test")\nplot(close)' },
  });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).success, true);

  for (const args of [{}, { source: 42 }, { source: ['plot(close)'] }]) {
    const invalid = await client.callTool({ name: 'pine_analyze', arguments: args });
    assert.equal(invalid.isError, true, 'invalid source must be rejected by the SDK');
    assert.match(invalid.content[0].text, /source/);
  }
});
