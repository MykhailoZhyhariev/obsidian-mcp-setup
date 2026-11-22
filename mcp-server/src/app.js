import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { bearerAuth } from './auth.js';
import { VaultError } from './vault.js';

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (err) => {
  // Only VaultError messages are safe to show; never leak internal paths/errors.
  const msg = err instanceof VaultError ? err.message : 'Internal error';
  if (!(err instanceof VaultError)) console.error('tool error:', err);
  return { content: [{ type: 'text', text: msg }], isError: true };
};

// Sent to the client at initialize; claude.ai puts it in the model's context so it knows
// when this connector is the right place to look.
export const SERVER_INSTRUCTIONS = [
  "This is the user's personal Obsidian vault: his own knowledge base, kept as an LLM-maintained wiki",
  '(Karpathy "LLM wiki" pattern). Treat it as the first place to look whenever the user asks about a topic',
  'he has researched, saved, read or watched, or refers to "my notes", "my wiki", "my vault" or',
  'something he "saved" or "looked into" -- check it alongside past chats and memory, not instead of them.',
  '',
  'Layout:',
  '- wiki/ -- curated, synthesised pages. Start here. wiki/index and wiki/overview map the content;',
  '  wiki/syntheses/ holds conclusions and decision guides; wiki/concepts/, wiki/entities/ and',
  '  wiki/sources/ hold topic, entity and per-source pages. wiki/log records what was added and when.',
  '- raw/ -- unedited source material (articles, YouTube transcripts, social posts, inbox). Use it to',
  '  verify or quote details behind a wiki page, not as the first stop.',
  '- notes/ -- the user\'s own free-form notes.',
  '- CLAUDE.md at the root describes the wiki\'s conventions (frontmatter, linking, page types).',
  '',
  'How to use it: search with a few distinctive terms (all terms must match; fewer terms find more),',
  'then read_note the best wiki/ hit before answering. Follow [[wikilinks]] and the `sources` frontmatter',
  'with read_note when you need detail. Name the notes you relied on (by path) in your answer.',
  'Wiki pages summarise outside sources: do not present their content as decisions the user made unless',
  'the note says so.',
].join('\n');

export function buildMcpServer(vault) {
  const server = new McpServer(
    { name: 'obsidian-vault', version: '0.1.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'search',
    {
      title: 'Search notes',
      description:
        'Full-text search over markdown notes in the vault. All whitespace-separated terms must match ' +
        '(in the file path or body); wrap the query in double quotes for an exact phrase. ' +
        'Returns the best matches with line snippets. Use read_note to open one.',
      inputSchema: {
        query: z.string().min(1).max(500).describe('Search terms'),
        path: z.string().max(1000).optional().describe('Only search inside this folder (relative to vault root)'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
        case_sensitive: z.boolean().optional().describe('Default false'),
      },
      annotations: { title: 'Search notes', ...READ_ONLY },
    },
    async ({ query, path, limit, case_sensitive }) => {
      try {
        const r = await vault.search({ query, path, limit, caseSensitive: case_sensitive });
        if (r.results.length === 0) return text(`No notes matched "${query}" (scanned ${r.scanned} notes).`);
        const lines = [
          `${r.total} matching notes (showing ${r.results.length}; scanned ${r.scanned})` +
            (r.timedOut ? ' — search timed out, results may be incomplete' : '') +
            ':',
        ];
        r.results.forEach((m, i) => {
          lines.push(`\n${i + 1}. ${m.path}  (modified ${m.modified.slice(0, 10)})`);
          for (const s of m.matches) lines.push(`   L${s.line}: ${s.text}`);
        });
        return text(lines.join('\n'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'read_note',
    {
      title: 'Read note',
      description:
        'Read a markdown note, including its frontmatter. `path` is relative to the vault root; the ".md" ' +
        'extension is optional. A bare note name (as in [[wikilinks]]) also works when it is unique. ' +
        'Long notes are truncated; pass `offset` to continue.',
      inputSchema: {
        path: z.string().min(1).max(1000).describe('e.g. "Projects/Plan.md" or "Plan"'),
        offset: z.number().int().min(0).optional().describe('Character offset to start from (default 0)'),
        max_chars: z.number().int().min(1).max(100000).optional().describe('Max characters to return'),
      },
      annotations: { title: 'Read note', ...READ_ONLY },
    },
    async ({ path, offset, max_chars }) => {
      try {
        const n = await vault.readNote({ path, offset, maxChars: max_chars });
        let out = `# ${n.path}\n(modified ${n.modified}, ${n.totalChars} chars)\n\n${n.content}`;
        if (n.truncated) {
          out += `\n\n[truncated — showing chars ${n.offset}–${n.offset + n.content.length} of ${n.totalChars}; call again with offset=${n.offset + n.content.length}]`;
        }
        return text(out);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'list',
    {
      title: 'List folder',
      description:
        'List folders, notes and other files in a vault folder (default: vault root). ' +
        'Hidden entries (starting with ".") such as .obsidian are never shown.',
      inputSchema: {
        path: z.string().max(1000).optional().describe('Folder relative to vault root (default: root)'),
        recursive: z.boolean().optional().describe('Include all nested entries (default false)'),
        limit: z.number().int().min(1).max(1000).optional().describe('Max entries (default 200)'),
      },
      annotations: { title: 'List folder', ...READ_ONLY },
    },
    async ({ path, recursive, limit }) => {
      try {
        const r = await vault.list({ path, recursive, limit });
        if (r.entries.length === 0) return text('(empty)');
        const lines = r.entries.map((e) =>
          e.type === 'dir' ? `${e.path}/` : `${e.path}  [${e.type}, ${e.size} B, ${e.modified.slice(0, 10)}]`,
        );
        if (r.truncated) lines.push('… more entries not shown (raise limit or narrow path)');
        return text(lines.join('\n'));
      } catch (e) {
        return fail(e);
      }
    },
  );

  return server;
}

export function createApp({ vault, token }) {
  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('finish', () => console.log(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ${Date.now() - t0}ms`));
    next();
  });

  // Local liveness probe (Caddy does not expose this path).
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use('/mcp', bearerAuth(token));

  // Stateless streamable HTTP: a fresh server+transport per request.
  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildMcpServer(vault);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
      }
    }
  });

  app.all('/mcp', (_req, res) => {
    res
      .status(405)
      .set('Allow', 'POST')
      .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status && err.status < 500 ? err.status : 500;
    res.status(status).json({ jsonrpc: '2.0', error: { code: status === 400 ? -32700 : -32603, message: 'Bad request' }, id: null });
  });

  return app;
}
