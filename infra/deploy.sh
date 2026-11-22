#!/usr/bin/env bash
# Copy server/ and mcp-server/ to the instance over SSH and run server/bootstrap.sh there.
# Idempotent: re-run it to roll out MCP server or config changes. Creates no AWS resources.
#
#   infra/deploy.sh            # host = the static IP from AWS
#   HOST=203.0.113.9 infra/deploy.sh   # skip the AWS lookup
set -euo pipefail
# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
: "${DOMAIN:?Set DOMAIN in config.env}"
[[ "$DOMAIN" != *example.com ]] || die "DOMAIN in config.env is still the placeholder ($DOMAIN)"
[[ -f "$SSH_PRIVATE_KEY_FILE" ]] || die "SSH private key not found: $SSH_PRIVATE_KEY_FILE"

HOST="${HOST:-$(static_ip)}"
SSH_OPTS=(-i "$SSH_PRIVATE_KEY_FILE" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)
remote() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "$@"; }

log "Waiting for SSH on $HOST (your IP must match the firewall's SSH rule)"
for _ in $(seq 1 36); do remote true 2>/dev/null && break; sleep 5; done
remote true || die "Cannot SSH to $SSH_USER@$HOST. Has your IP changed? Run: infra/firewall.sh apply"

log "Uploading"
tar -C "$REPO_ROOT" --exclude=node_modules -czf - server mcp-server \
  | remote 'rm -rf /tmp/omcp-deploy && mkdir -p /tmp/omcp-deploy && tar -xzf - -C /tmp/omcp-deploy'

log "Running bootstrap"
env_args="$(printf 'DOMAIN=%q ACME_EMAIL=%q OBSIDIAN_HEADLESS_VERSION=%q' \
  "$DOMAIN" "${ACME_EMAIL:-}" "${OBSIDIAN_HEADLESS_VERSION:-latest}")"
ssh -t "${SSH_OPTS[@]}" "$SSH_USER@$HOST" "sudo env $env_args bash /tmp/omcp-deploy/server/bootstrap.sh"
