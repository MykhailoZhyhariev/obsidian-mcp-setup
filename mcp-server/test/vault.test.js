import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openVault, VaultError } from '../src/vault.js';
import { makeVault } from './helpers.js';

let env, vault;
before(async () => {
  env = await makeVault();
  vault = await openVault(env.root);
});
after(() => env.cleanup());

const rejects = (p, re) => assert.rejects(p, (e) => e instanceof VaultError && re.test(e.message));

test('reads a note with or without extension', async () => {
  const a = await vault.readNote({ path: 'Projects/Plan.md' });
  const b = await vault.readNote({ path: 'Projects/Plan' });
  assert.equal(a.path, 'Projects/Plan.md');
  assert.equal(a.content, b.content);
  assert.match(a.content, /Ship the MCP server/);
});

test('bare name resolves when unique, errors when ambiguous', async () => {
  const n = await vault.readNote({ path: '2026-01-01' });
  assert.equal(n.path, 'Daily/2026-01-01.md');
  assert.equal((await vault.readNote({ path: 'old' })).path, 'Projects/Archive/Old.md');
  await rejects(vault.readNote({ path: 'Dup' }), /Ambiguous/);
  await rejects(vault.readNote({ path: 'Nope' }), /Not found/);
});

test('rejects traversal, absolute paths, NUL', async () => {
  await rejects(vault.readNote({ path: '../secret.md' }), /inside the vault/);
  await rejects(vault.readNote({ path: 'Projects/../../secret.md' }), /inside the vault/);
  await rejects(vault.readNote({ path: '..\\secret.md' }), /inside the vault/);
  await rejects(vault.readNote({ path: '/etc/passwd' }), /relative/);
  await rejects(vault.readNote({ path: 'C:\\Windows\\win.ini' }), /relative/);
  await rejects(vault.readNote({ path: 'Home.md\0.png' }), /Invalid/);
  await rejects(vault.list({ path: '../' }), /inside the vault/);
});

test('hidden paths (.obsidian, dotfolders) are not found', async () => {
  await rejects(vault.readNote({ path: '.obsidian/app.json' }), /Not found/);
  await rejects(vault.readNote({ path: '.trash/deleted.md' }), /Not found/);
  await rejects(vault.readNote({ path: 'Projects/.hidden/inner.md' }), /Not found/);
  await rejects(vault.list({ path: '.obsidian' }), /Not found/);
  await rejects(vault.search({ query: 'x', path: '.obsidian' }), /Not found/);
});

test('hidden entries never appear in list or search', async () => {
  const l = await vault.list({ recursive: true, limit: 1000 });
  assert.ok(l.entries.length > 0);
  assert.ok(!l.entries.some((e) => /(^|\/)\./.test(e.path)), 'no dot-paths in listing');
  const s = await vault.search({ query: 'banana' });
  const paths = s.results.map((r) => r.path);
  assert.ok(paths.includes('Home.md') && paths.includes('Projects/Plan.md'));
  assert.ok(!paths.some((p) => /(^|\/)\./.test(p)), 'no dot-paths in search');
  assert.ok(!paths.includes('secret.md'));
});

test('non-markdown files cannot be read', async () => {
  await rejects(vault.readNote({ path: 'attachments/pic.png' }), /Not found|Only \.md/);
});

test('symlinks cannot escape the vault or reach hidden dirs', async (t) => {
  const { file, outDir, toConfig } = env.links;
  if (!file && !outDir && !toConfig) return t.skip('symlinks unavailable');
  if (file) await rejects(vault.readNote({ path: 'escape.md' }), /Not found/);
  if (outDir) await rejects(vault.readNote({ path: 'escape-dir/secret.md' }), /Not found/);
  if (toConfig) await rejects(vault.readNote({ path: 'to-config/app.json' }), /Not found/);
  t.diagnostic(`links exercised: ${JSON.stringify(env.links)}`);
  const l = await vault.list({ recursive: true, limit: 1000 });
  assert.ok(!l.entries.some((e) => /escape|to-config/.test(e.path)));
  const s = await vault.search({ query: 'TOP SECRET' });
  assert.equal(s.results.length, 0);
});

test('list: folders first-level, notes typed', async () => {
  const l = await vault.list({});
  const byPath = Object.fromEntries(l.entries.map((e) => [e.path, e.type]));
  assert.equal(byPath['Projects'], 'dir');
  assert.equal(byPath['Home.md'], 'note');
  assert.equal(byPath['.obsidian'], undefined);
});

test('list: limit truncates', async () => {
  const l = await vault.list({ recursive: true, limit: 2 });
  assert.equal(l.entries.length, 2);
  assert.equal(l.truncated, true);
});

test('search: AND terms, phrase, path scope, case', async () => {
  assert.deepEqual((await vault.search({ query: 'banana codeword' })).results.map((r) => r.path), ['Projects/Plan.md']);
  assert.equal((await vault.search({ query: '"banana bread"' })).results[0].path, 'Home.md');
  assert.equal((await vault.search({ query: 'banana', path: 'Projects' })).results.length, 1);
  assert.equal((await vault.search({ query: 'BANANA', caseSensitive: true })).results.length, 0);
  assert.ok((await vault.search({ query: 'plan' })).results.some((r) => r.path === 'Plan.md'));
});

test('read: truncation and offset', async () => {
  const a = await vault.readNote({ path: 'Home', maxChars: 10 });
  assert.equal(a.content.length, 10);
  assert.equal(a.truncated, true);
  const b = await vault.readNote({ path: 'Home', offset: 10 });
  assert.equal(a.content + b.content, (await vault.readNote({ path: 'Home' })).content);
});
