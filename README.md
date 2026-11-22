# Obsidian vault → remote MCP server (claude.ai)

Read-only MCP server (streamable HTTP) over an Obsidian vault kept in sync by
[obsidian-headless](https://obsidian.md/help/sync/headless), on a Lightsail instance behind Caddy.

```
claude.ai ──443 (Anthropic IPs only)──▶ Caddy (auto-TLS) ──▶ 127.0.0.1:3000 MCP server ──reads──▶ /srv/vault
                                                                                                      ▲
Obsidian Sync ◀──── ob sync --continuous (systemd, user "vault") ─────────────────────────────────────┘
```

## Layout

| Path | What |
|---|---|
| `config.example.env` | Copy to `config.env` (git-ignored). All knobs; no secrets. |
| `infra/provision.sh` | Creates instance + static IP + firewall + daily auto-snapshots. **Prints a plan and waits for `yes`.** |
| `infra/firewall.sh` | `show` / `apply` the firewall (22 ← your IP, 443 ← Anthropic ranges, 80 ← anywhere for ACME). |
| `infra/anthropic-ips.txt` | Anthropic outbound ranges, with source and date. |
| `infra/deploy.sh` | Uploads `server/` + `mcp-server/` over SSH and runs `server/bootstrap.sh`. Re-run to update. |
| `infra/iam-policy.json` | Minimal IAM permissions the AWS scripts need. |
| `server/` | `bootstrap.sh`, systemd units, Caddyfile. |
| `mcp-server/` | The MCP server (Node 22, `search` / `read_note` / `list`) and its tests. |

## Runbook

Requires Git Bash (or any bash), `aws` CLI v2, `ssh`, `tar`, `curl` on your machine.

1. `cp config.example.env config.env` and set at least `DOMAIN`, `SSH_PUBLIC_KEY_FILE`, `SSH_PRIVATE_KEY_FILE`.
2. Make sure your IAM user can call Lightsail (see `infra/iam-policy.json`).
3. `infra/provision.sh` — review the plan, type `yes`. Note the static IP it prints.
4. Create a DNS **A record** `DOMAIN → static IP`.
5. `infra/deploy.sh` — installs everything; prints the **bearer token once** (also in `/etc/obsidian-mcp/env`).
6. SSH in and set up sync yourself:
   ```
   ssh -i <key> ubuntu@<ip>
   sudo -iu vault ob login
   sudo -iu vault ob sync-list-remote
   sudo -iu vault ob sync-setup --vault "<vault>" --path /srv/vault --device-name lightsail
   sudo systemctl enable --now obsidian-sync     # ob sync --continuous as user "vault"
   journalctl -fu obsidian-sync
   ```
   Don't run Obsidian desktop Sync on this machine — one sync client per device.
7. In claude.ai → Settings → Connectors → Add custom connector: URL `https://<DOMAIN>/mcp`; under
   **Request headers** add `Authorization` = `Bearer <token>` (include the word `Bearer` and the space).

If your public IP changes, SSH stops working: `infra/firewall.sh apply`.

## Security notes

- **Path confinement** (`mcp-server/src/vault.js`): relative paths only; `..`, absolute paths, NUL rejected; every
  path segment starting with `.` is hidden (so `.obsidian`, `.trash`, `.git`) and reported as "Not found";
  resolved real path must stay inside the vault and outside hidden dirs; directory walks never follow
  symlinks; only `.md` is readable; read/search/list outputs are size-capped.
- **No write tools.** Every tool is annotated `readOnlyHint`. The service runs as unprivileged user `mcp`
  with `ProtectSystem=strict`, no capabilities, and no write access to the vault.
- **Auth**: constant-time bearer check in the server; it listens on 127.0.0.1 only; Caddy proxies only `/mcp`.
- Sync user `vault` and server user `mcp` are separate; `mcp` reads via group `vault` (files 0640).
- `bootstrap.sh` makes SSH key-only with no root login; `unattended-upgrades` is enabled.

## Things you should know

- **Port 80 is open to the world** (default). Let's Encrypt validates from IPs that aren't published, so with 443
  restricted, HTTP-01 on 80 is the only way Caddy can issue/renew certs without DNS API credentials. Caddy answers
  only the ACME challenge plus a redirect there. To close it, set `OPEN_PORT_80_FOR_ACME=false` and switch Caddy to
  a DNS-01 challenge (needs a Caddy build with your DNS provider's plugin) before it matters.
- **First minutes**: Lightsail creates instances with 22/80 open to the world; `provision.sh` replaces the rules
  as soon as the instance exists. Login is key-only (only your key is installed).
- **Anthropic ranges** come from the [official page](https://platform.claude.com/docs/en/api/ip-addresses) and
  can change ("not without notice"). Re-check it now and then; edit `infra/anthropic-ips.txt`; `firewall.sh apply`.
  There's an [unconfirmed community report](https://github.com/anthropics/claude-ai-mcp/issues/422) of connector
  traffic not arriving from the published range. If the connector can't connect, look at
  `/var/log/caddy/access.log`; as a last resort, test with `HTTPS_SOURCE=any` briefly, then set it back.
- **Request headers** for static bearer tokens in claude.ai connectors are per the current
  [connector docs](https://claude.com/docs/connectors/custom); I could not test this against claude.ai itself.
- Snapshots: Lightsail keeps the last 7 daily; snapshot storage is billed. Auto-snapshots also contain your
  notes and `/etc/obsidian-mcp/env`.
- `ob` stores its login under `/home/vault` (not documented where); treat the instance as holding your Obsidian
  credentials.

## Develop / test the MCP server

```
cd mcp-server && npm ci && npm test
VAULT_PATH=/path/to/vault MCP_BEARER_TOKEN=$(openssl rand -hex 32) npm start
```
