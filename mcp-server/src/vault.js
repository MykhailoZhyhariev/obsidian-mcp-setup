// Read-only access to an Obsidian vault directory.
//
// Security properties enforced here (not in the HTTP layer):
//   * every user-supplied path is relative to the vault root; absolute paths,
//     "..", NUL bytes and drive letters are rejected
//   * any path segment starting with "." is hidden (covers .obsidian, .trash, .git ...)
//     -- hidden paths are reported as "not found", never as "forbidden"
//   * the *resolved* (symlink-free) path must still be inside the real vault root
//   * directory walks never follow symlinks
//   * only .md files can be read; sizes and result counts are capped

import fs from 'node:fs/promises';
import path from 'node:path';

export class VaultError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VaultError';
  }
}

const NOT_FOUND = 'Not found';
const READ_EXT = '.md';

const isHidden = (name) => name.startsWith('.');

/** Split and validate a user-supplied relative path into safe segments. */
export function parseRelPath(input) {
  if (typeof input !== 'string') throw new VaultError('Path must be a string');
  if (input.includes('\0')) throw new VaultError('Invalid path');
  const s = input.replaceAll('\\', '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) {
    throw new VaultError('Path must be relative to the vault root');
  }
  const segs = s.split('/').filter((x) => x !== '' && x !== '.');
  if (segs.includes('..')) throw new VaultError('Path must stay inside the vault');
  if (segs.some(isHidden)) throw new VaultError(NOT_FOUND);
  return segs;
}

export async function openVault(rootDir, limits = {}) {
  const cfg = {
    maxReadBytes: 5 * 1024 * 1024,
    maxReadChars: 100_000,
    maxSearchFileBytes: 2 * 1024 * 1024,
    searchTimeoutMs: 10_000,
    ...limits,
  };
  const root = await fs.realpath(rootDir);
  const inside = (p) => p === root || p.startsWith(root + path.sep);

  /** Resolve segments to a real path that is confined to the vault. */
  async function resolve(segs) {
    let real;
    try {
      real = await fs.realpath(path.join(root, ...segs));
    } catch {
      throw new VaultError(NOT_FOUND);
    }
    if (!inside(real)) throw new VaultError(NOT_FOUND);
    const relSegs = path.relative(root, real).split(path.sep).filter(Boolean);
    if (relSegs.some(isHidden)) throw new VaultError(NOT_FOUND);
    return real;
  }

  const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/');

  /** Yield non-hidden, non-symlink entries under `dirAbs` (depth-first, sorted). */
  async function* walk(dirAbs, recursive) {
    let entries;
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (isHidden(e.name) || e.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) {
        yield { abs, dir: true };
        if (recursive) yield* walk(abs, true);
      } else if (e.isFile()) {
        yield { abs, dir: false };
      }
    }
  }

  async function list({ path: p = '', recursive = false, limit = 200 } = {}) {
    const dirAbs = await resolve(parseRelPath(p));
    const st = await fs.stat(dirAbs);
    if (!st.isDirectory()) throw new VaultError('Not a directory');
    const max = Math.min(Math.max(1, limit), 1000);
    const entries = [];
    let truncated = false;
    for await (const e of walk(dirAbs, recursive)) {
      if (entries.length >= max) {
        truncated = true;
        break;
      }
      const s = await fs.stat(e.abs).catch(() => null);
      if (!s) continue;
      entries.push({
        path: relOf(e.abs),
        type: e.dir ? 'dir' : e.abs.toLowerCase().endsWith(READ_EXT) ? 'note' : 'file',
        size: e.dir ? undefined : s.size,
        modified: s.mtime.toISOString(),
      });
    }
    return { entries, truncated };
  }

  /** Find a note by bare name (Obsidian-style link), e.g. "Meeting notes". */
  async function findByName(name) {
    const want = name.toLowerCase().replace(/\.md$/, '');
    const hits = [];
    for await (const e of walk(root, true)) {
      if (e.dir) continue;
      const base = path.basename(e.abs);
      if (base.toLowerCase().endsWith(READ_EXT) && base.slice(0, -3).toLowerCase() === want) {
        hits.push(relOf(e.abs));
      }
    }
    return hits;
  }

  async function readNote({ path: p, offset = 0, maxChars } = {}) {
    const segs = parseRelPath(p);
    if (segs.length === 0) throw new VaultError('Path is required');
    const withExt = (s) => (s.at(-1).toLowerCase().endsWith(READ_EXT) ? s : [...s.slice(0, -1), s.at(-1) + READ_EXT]);

    let abs;
    try {
      abs = await resolve(withExt(segs));
    } catch (err) {
      if (!(err instanceof VaultError) || err.message !== NOT_FOUND || segs.length > 1) throw err;
      // bare name: try to resolve like an Obsidian [[wikilink]]
      const hits = await findByName(segs[0]);
      if (hits.length === 1) abs = await resolve(parseRelPath(hits[0]));
      else if (hits.length > 1) {
        throw new VaultError(`Ambiguous name; matches: ${hits.slice(0, 10).join(', ')}`);
      } else throw err;
    }

    if (!abs.toLowerCase().endsWith(READ_EXT)) throw new VaultError('Only .md notes can be read');
    const st = await fs.stat(abs);
    if (!st.isFile()) throw new VaultError('Not a file');
    if (st.size > cfg.maxReadBytes) throw new VaultError('Note is too large to read');

    const text = await fs.readFile(abs, 'utf8');
    const len = Math.min(maxChars ?? cfg.maxReadChars, cfg.maxReadChars);
    const start = Math.max(0, offset);
    const slice = text.slice(start, start + len);
    return {
      path: relOf(abs),
      modified: st.mtime.toISOString(),
      totalChars: text.length,
      offset: start,
      content: slice,
      truncated: start + slice.length < text.length,
    };
  }

  async function search({ query, path: p = '', limit = 20, caseSensitive = false } = {}) {
    if (typeof query !== 'string' || !query.trim()) throw new VaultError('Query is required');
    const base = await resolve(parseRelPath(p));
    const quoted = query.trim().match(/^"(.+)"$/);
    const terms = (quoted ? [quoted[1]] : query.trim().split(/\s+/)).map((t) => (caseSensitive ? t : t.toLowerCase()));
    const max = Math.min(Math.max(1, limit), 100);
    const deadline = Date.now() + cfg.searchTimeoutMs;

    const files = [];
    for await (const e of walk(base, true)) if (!e.dir && e.abs.toLowerCase().endsWith(READ_EXT)) files.push(e.abs);

    const results = [];
    let timedOut = false;
    let scanned = 0;

    const scan = async (abs) => {
      const st = await fs.stat(abs).catch(() => null);
      if (!st || st.size > cfg.maxSearchFileBytes) return;
      const raw = await fs.readFile(abs, 'utf8').catch(() => null);
      if (raw === null) return;
      scanned++;
      const rel = relOf(abs);
      const hay = caseSensitive ? raw : raw.toLowerCase();
      const name = caseSensitive ? rel : rel.toLowerCase();
      let score = 0;
      for (const t of terms) {
        const inName = name.includes(t);
        const inBody = hay.includes(t);
        if (!inName && !inBody) return; // AND semantics
        if (inName) score += 5;
        if (inBody) score += Math.min(10, hay.split(t).length - 1);
      }
      const lines = raw.split('\n');
      const matches = [];
      for (let i = 0; i < lines.length && matches.length < 3; i++) {
        const l = caseSensitive ? lines[i] : lines[i].toLowerCase();
        if (terms.some((t) => l.includes(t))) matches.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
      }
      results.push({ path: rel, score, modified: st.mtime.toISOString(), matches });
    };

    for (let i = 0; i < files.length; i += 16) {
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await Promise.all(files.slice(i, i + 16).map(scan));
    }

    results.sort((a, b) => b.score - a.score || b.modified.localeCompare(a.modified));
    return { total: results.length, results: results.slice(0, max), scanned, timedOut };
  }

  return { root, list, readNote, search };
}
