import { createHash, timingSafeEqual } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest();

/** Express middleware: require `Authorization: Bearer <token>` (constant-time compare). */
export function bearerAuth(expectedToken) {
  if (typeof expectedToken !== 'string' || expectedToken.length < 32) {
    throw new Error('MCP_BEARER_TOKEN must be set and at least 32 characters');
  }
  const expected = sha256(expectedToken);
  return (req, res, next) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    if (m && timingSafeEqual(sha256(m[1]), expected)) return next();
    res
      .status(401)
      .set('WWW-Authenticate', 'Bearer realm="obsidian-mcp"')
      .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
  };
}
