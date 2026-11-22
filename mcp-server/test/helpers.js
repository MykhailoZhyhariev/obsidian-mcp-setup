import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Create a throwaway vault (and a secret file outside it) for tests. */
export async function makeVault() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-test-'));
  const root = path.join(base, 'vault');
  const w = async (rel, body) => {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, body);
  };
  await w('Home.md', '---\ntags: [index]\n---\n# Home\nWelcome to the vault. Banana bread recipe lives here.\n');
  await w('Projects/Plan.md', '# Plan\nShip the MCP server.\nBanana is a codeword.\n');
  await w('Projects/Archive/Old.md', 'old stuff about apples');
  await w('Daily/2026-01-01.md', 'New year note');
  await w('Projects/Dup.md', 'dup one');
  await w('Projects/Archive/Dup.md', 'dup two');
  await w('Plan.md', 'root-level Plan (duplicate name)');
  await w('attachments/pic.png', 'not really a png');
  await w('.obsidian/app.json', '{"secret":"obsidian-config"}');
  await w('.trash/deleted.md', 'trashed banana');
  await w('Projects/.hidden/inner.md', 'hidden banana');
  await fs.writeFile(path.join(base, 'secret.md'), 'TOP SECRET outside vault banana');

  // 'junction' works for directories on Windows without special privileges (ignored on POSIX).
  const tryLink = (target, link, type) =>
    fs.symlink(target, path.join(root, link), type).then(() => true, () => false);
  const links = {
    file: await tryLink(path.join(base, 'secret.md'), 'escape.md', 'file'),
    outDir: await tryLink(base, 'escape-dir', 'junction'),
    toConfig: await tryLink(path.join(root, '.obsidian'), 'to-config', 'junction'),
  };
  return { base, root, links, cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}
