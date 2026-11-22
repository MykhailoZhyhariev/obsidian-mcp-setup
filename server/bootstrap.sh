#!/usr/bin/env bash
# Runs ON the instance (Ubuntu 24.04) as root, via infra/deploy.sh. Idempotent.
#
# Installs Node 22, obsidian-headless, Caddy; creates users `vault` (runs sync) and `mcp`
# (runs the read-only MCP server); installs systemd units and the Caddyfile.
# It does NOT log in to Obsidian or enable the sync unit -- you do that over SSH (see README).
set -euo pipefail

: "${DOMAIN:?DOMAIN must be set}"
ACME_EMAIL="${ACME_EMAIL:-}"
OBSIDIAN_HEADLESS_VERSION="${OBSIDIAN_HEADLESS_VERSION:-latest}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # unpacked deploy dir containing server/ and mcp-server/

VAULT_DIR=/srv/vault
APP_DIR=/opt/obsidian-mcp
ENV_DIR=/etc/obsidian-mcp

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
[[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || { echo "invalid DOMAIN: $DOMAIN" >&2; exit 1; }
[[ -z "$ACME_EMAIL" || "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$ ]] || { echo "invalid ACME_EMAIL" >&2; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || echo "WARNING: tested on Ubuntu 24.04, found $PRETTY_NAME" >&2

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

# --------------------------------------------------------------------------------------------
log "Base packages, unattended security upgrades"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg apt-transport-https debian-keyring debian-archive-keyring unattended-upgrades
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# --------------------------------------------------------------------------------------------
log "SSH hardening (key-only, no root login)"
cat >/etc/ssh/sshd_config.d/10-hardening.conf <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t
# Ubuntu 24.04 starts sshd via ssh.socket; new connections read the drop-in anyway, reload is best-effort.
systemctl reload ssh 2>/dev/null || true

# --------------------------------------------------------------------------------------------
log "Node.js 22 (NodeSource apt repo)"
install -d -m 755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
  >/etc/apt/sources.list.d/nodesource.list
apt-get update -qq
apt-get install -y -qq nodejs
node -v | grep -q '^v22\.' || { echo "expected Node 22, got $(node -v)" >&2; exit 1; }

# --------------------------------------------------------------------------------------------
log "obsidian-headless ($OBSIDIAN_HEADLESS_VERSION)"
npm install -g --no-fund --no-audit "obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}"
OB_BIN="$(command -v ob)" || { echo "'ob' not found after install" >&2; exit 1; }
echo "ob at $OB_BIN"

# --------------------------------------------------------------------------------------------
log "Caddy (official apt repo)"
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

# --------------------------------------------------------------------------------------------
log "Users and vault directory"
id vault >/dev/null 2>&1 || useradd --create-home --shell /bin/bash --comment "Obsidian sync" vault
passwd -l vault >/dev/null
id mcp >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin --comment "Obsidian MCP server" mcp
install -d -m 0750 -o vault -g vault "$VAULT_DIR"

# --------------------------------------------------------------------------------------------
log "MCP server -> $APP_DIR"
install -d -m 0755 "$APP_DIR"
# Replace code but keep nothing else there; node_modules is rebuilt from the lockfile.
rm -rf "$APP_DIR/src" "$APP_DIR/test"
cp -r "$SRC/mcp-server/src" "$APP_DIR/src"
cp "$SRC/mcp-server/package.json" "$SRC/mcp-server/package-lock.json" "$APP_DIR/"
(cd "$APP_DIR" && npm ci --omit=dev --ignore-scripts --no-fund --no-audit)
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

install -d -m 0750 "$ENV_DIR"
NEW_TOKEN=""
if [[ ! -s "$ENV_DIR/env" ]]; then
  NEW_TOKEN="$(openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_')"
  umask 077
  cat >"$ENV_DIR/env" <<EOF
MCP_BEARER_TOKEN=$NEW_TOKEN
VAULT_PATH=$VAULT_DIR
HOST=127.0.0.1
PORT=3000
EOF
fi
chmod 600 "$ENV_DIR/env"; chown root:root "$ENV_DIR/env"

# --------------------------------------------------------------------------------------------
log "systemd units"
sed "s|__OB_BIN__|$OB_BIN|" "$SRC/server/systemd/obsidian-sync.service" >/etc/systemd/system/obsidian-sync.service
install -m 644 "$SRC/server/systemd/obsidian-mcp.service" /etc/systemd/system/obsidian-mcp.service
systemctl daemon-reload
systemctl enable obsidian-mcp.service >/dev/null
systemctl restart obsidian-mcp.service
# obsidian-sync is intentionally NOT enabled/started: it needs `ob login` + `ob sync-setup` first.

# --------------------------------------------------------------------------------------------
log "Caddy config for $DOMAIN"
if [[ -n "$ACME_EMAIL" ]]; then
  sed -e "s|# __ACME_EMAIL_LINE__|email $ACME_EMAIL|" -e "s|__DOMAIN__|$DOMAIN|" "$SRC/server/Caddyfile" >/etc/caddy/Caddyfile
else
  sed -e "/__ACME_EMAIL_LINE__/d" -e "s|__DOMAIN__|$DOMAIN|" "$SRC/server/Caddyfile" >/etc/caddy/Caddyfile
fi
install -d -o caddy -g caddy /var/log/caddy
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
# validate runs as root and creates access.log owned by root -- hand it back to caddy.
chown -R caddy:caddy /var/log/caddy
systemctl enable caddy >/dev/null
systemctl reload-or-restart caddy

# --------------------------------------------------------------------------------------------
log "Checks"
sleep 2
systemctl is-active --quiet obsidian-mcp && echo "obsidian-mcp: active" || { journalctl -u obsidian-mcp -n 20 --no-pager; exit 1; }
curl -fsS http://127.0.0.1:3000/healthz && echo
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:3000/mcp)"
[[ "$code" == 401 ]] && echo "unauthenticated request correctly rejected (401)" || echo "WARNING: expected 401, got $code"

PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ -n "$PUBLIC_IP" && "$DNS_IP" != "$PUBLIC_IP" ]]; then
  echo "WARNING: $DOMAIN resolves to '${DNS_IP:-nothing}', this host is $PUBLIC_IP -- Caddy cannot get a certificate until the A record matches." >&2
fi

cat <<EOF

================================================================================
Bootstrap complete.

Next steps (SSH in as your normal user):
  sudo -iu vault ob login
  sudo -iu vault ob sync-list-remote
  sudo -iu vault ob sync-setup --vault "<your vault>" --path $VAULT_DIR --device-name lightsail
  sudo -iu vault ob sync --path $VAULT_DIR          # one-off initial sync, then Ctrl-C if it keeps running
  sudo systemctl enable --now obsidian-sync
  journalctl -fu obsidian-sync

MCP endpoint: https://$DOMAIN/mcp
EOF
if [[ -n "$NEW_TOKEN" ]]; then
  cat <<EOF

Bearer token (generated now, shown once; stored in $ENV_DIR/env, root-only):
  $NEW_TOKEN
Use header:  Authorization: Bearer <token>
EOF
else
  echo "Bearer token unchanged; read it with: sudo grep MCP_BEARER_TOKEN $ENV_DIR/env"
fi
echo "================================================================================"
