import { createApp } from './app.js';
import { openVault } from './vault.js';

const vaultPath = process.env.VAULT_PATH;
const token = process.env.MCP_BEARER_TOKEN;
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);

if (!vaultPath) {
  console.error('VAULT_PATH is required');
  process.exit(1);
}

const vault = await openVault(vaultPath);
const app = createApp({ vault, token }); // throws if token is missing/short

const httpServer = app.listen(port, host, () => {
  console.log(`obsidian-vault MCP listening on http://${host}:${port}/mcp (vault: ${vault.root})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => httpServer.close(() => process.exit(0)));
}
