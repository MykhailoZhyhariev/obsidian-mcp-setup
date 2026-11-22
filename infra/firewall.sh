#!/usr/bin/env bash
# Show or (re)apply the Lightsail firewall for the instance.
#
#   infra/firewall.sh show
#   infra/firewall.sh apply [--ssh-cidr 203.0.113.7/32]
#
# `apply` replaces ALL rules with: 22 <- your IP, 443 <- Anthropic ranges (infra/anthropic-ips.txt),
# and 80 <- anywhere for ACME (unless OPEN_PORT_80_FOR_ACME=false). Use it after your IP changes or
# after editing anthropic-ips.txt. It changes an existing resource only after you type "yes".
set -euo pipefail
# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

cmd="${1:-}"; shift || true
case "$cmd" in
  show)
    lsail get-instance-port-states --instance-name "$INSTANCE_NAME" \
      --query 'portStates[].[protocol,fromPort,toPort,join(`, `,cidrs)]' --output text
    ;;
  apply)
    cidr_arg=""
    if [[ "${1:-}" == --ssh-cidr ]]; then cidr_arg="${2:?--ssh-cidr needs a value}"; fi
    ssh_cidr="$(resolve_ssh_cidr "$cidr_arg")"
    log "Firewall for '$INSTANCE_NAME' would become:"
    describe_firewall "$ssh_cidr"
    [[ "$HTTPS_SOURCE" == any ]] && warn "HTTPS_SOURCE=any: port 443 would be open to the whole internet."
    confirm "Replace ALL firewall rules on '$INSTANCE_NAME'?"
    apply_firewall "$ssh_cidr"
    log "Applied. Current rules:"
    "$0" show
    ;;
  *)
    echo "usage: $0 show | apply [--ssh-cidr CIDR]" >&2
    exit 2
    ;;
esac
