import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { openVault } from '../src/vault.js';
import { makeVault } from './helpers.js';

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
let env, httpServer, url;

before(async () => {
  env = await makeVault();
  const app = createApp({ vault: await openVault(env.root), token: TOKEN });
  await new Promise((r) => (httpServer = app.listen(0, '127.0.0.1', r)));
  url = new URL(`http://127.0.0.1:${httpServer.address().port}/mcp`);
});
after(async () => {
  await new Promise((r) => httpServer.close(r));
  await env.cleanup();
});

async function connect(token = TOKEN) {
  const client = new Client({ name: 'test', version: '0' });
  const requestInit = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
  await client.connect(new StreamableHTTPClientTransport(url, { requestInit }));
  return client;
}

test('401 without or with wrong token', async () => {
  for (const headers of [{}, { Authorization: 'Bearer nope' }, { Authorization: 'Basic abc' }]) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(r.status, 401);
    assert.match(r.headers.get('www-authenticate'), /Bearer/);
  }
});

test('GET /mcp is 405 (stateless)', async () => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(r.status, 405);
});

test('lists exactly the three read-only tools', async () => {
  const c = await connect();
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['list', 'read_note', 'search']);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, true);
  await c.close();
});

test('tools work end to end', async () => {
  const c = await connect();
  const call = async (name, args) => (await c.callTool({ name, arguments: args })).content[0].text;

  assert.match(await call('list', {}), /Projects\//);
  assert.match(await call('read_note', { path: 'Projects/Plan' }), /Ship the MCP server/);
  assert.match(await call('search', { query: 'codeword' }), /Projects\/Plan\.md/);

  const bad = await c.callTool({ name: 'read_note', arguments: { path: '../secret.md' } });
  assert.equal(bad.isError, true);
  const hidden = await c.callTool({ name: 'read_note', arguments: { path: '.obsidian/app.json' } });
  assert.equal(hidden.isError, true);
  assert.doesNotMatch(hidden.content[0].text, /secret|obsidian-config/);
  await c.close();
});

test('server refuses to start with a short token', () => {
  assert.throws(() => createApp({ vault: {}, token: 'short' }), /at least 32/);
});
