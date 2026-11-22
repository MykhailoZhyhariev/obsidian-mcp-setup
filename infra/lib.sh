#!/usr/bin/env bash
# Shared helpers for infra/*.sh -- source this file, do not execute it.
# shellcheck shell=bash

set -euo pipefail

# Git Bash on Windows rewrites arguments that look like POSIX paths (e.g. "10.0.0.0/8" in JSON).
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
export AWS_PAGER=""

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="${CONFIG_FILE:-$REPO_ROOT/config.env}"

log()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

load_config() {
  [[ -f "$CONFIG_FILE" ]] || die "Missing $CONFIG_FILE -- copy config.example.env to config.env and edit it."
  set -a
  # shellcheck disable=SC1090
  source "$CONFIG_FILE"
  set +a
  : "${AWS_REGION:?}" "${AWS_AZ:?}" "${INSTANCE_NAME:?}" "${STATIC_IP_NAME:?}"
  : "${BLUEPRINT_ID:?}" "${BUNDLE_ID:?}" "${SNAPSHOT_TIME_UTC:?}" "${SSH_USER:?}"
  : "${HTTPS_SOURCE:=anthropic}" "${OPEN_PORT_80_FOR_ACME:=true}"
  SSH_PUBLIC_KEY_FILE="${SSH_PUBLIC_KEY_FILE/#\~/$HOME}"
  SSH_PRIVATE_KEY_FILE="${SSH_PRIVATE_KEY_FILE/#\~/$HOME}"
  [[ "$AWS_AZ" == "$AWS_REGION"* ]] || die "AWS_AZ ($AWS_AZ) is not in AWS_REGION ($AWS_REGION)"
  [[ "$HTTPS_SOURCE" == anthropic || "$HTTPS_SOURCE" == any ]] || die "HTTPS_SOURCE must be 'anthropic' or 'any'"
}

# aws lightsail pinned to the configured region/profile; strips CR from Windows aws.exe output.
lsail() {
  aws lightsail --region "$AWS_REGION" ${AWS_PROFILE:+--profile "$AWS_PROFILE"} "$@" | tr -d '\r'
  return "${PIPESTATUS[0]}"
}

# exists <lightsail get-* args...>: 0 = exists, 1 = NotFoundException, anything else dies (e.g. AccessDenied).
exists() {
  local out
  if out="$(lsail "$@" 2>&1)"; then return 0; fi
  grep -q 'NotFoundException' <<<"$out" && return 1
  die "AWS call failed: lightsail $1: $out"
}

# Interactive gate before anything that creates or changes AWS resources. There is no bypass flag.
confirm() {
  local ans
  [[ -t 0 ]] || die "Refusing to continue without an interactive terminal to confirm on."
  read -r -p "$1 Type 'yes' to proceed: " ans
  [[ "$ans" == yes ]] || die "Aborted; nothing was changed."
}

valid_cidr() { [[ "$1" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; }

# SSH source CIDR: explicit config, else the caller's current public IPv4.
resolve_ssh_cidr() {
  local cidr="${1:-${SSH_ALLOWED_CIDR:-}}" ip
  if [[ -z "$cidr" ]]; then
    ip="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')" \
      || die "Could not detect your public IP; set SSH_ALLOWED_CIDR in config.env"
    cidr="$ip/32"
  fi
  valid_cidr "$cidr" || die "Invalid SSH CIDR: $cidr"
  [[ "$cidr" != 0.0.0.0/* ]] || die "Refusing to open SSH to the world"
  echo "$cidr"
}

anthropic_cidrs() {
  local f="$REPO_ROOT/infra/anthropic-ips.txt" c
  [[ -f "$f" ]] || die "Missing $f"
  while IFS= read -r c; do
    c="${c%%#*}"; c="${c//[[:space:]]/}"
    [[ -z "$c" ]] && continue
    valid_cidr "$c" || die "Bad CIDR in anthropic-ips.txt: $c"
    echo "$c"
  done <"$f"
}

# Space-separated CIDRs allowed to reach 443 (single "0.0.0.0/0" when HTTPS_SOURCE=any).
https_cidrs() {
  if [[ "$HTTPS_SOURCE" == any ]]; then echo "0.0.0.0/0"; else anthropic_cidrs | tr '\n' ' '; fi
}

json_cidrs() { # args: cidrs... -> "a","b"
  local out="" c
  for c in "$@"; do out+="${out:+,}\"$c\""; done
  echo "$out"
}

# Prints the rule table that would be applied (human readable).
describe_firewall() {
  local ssh_cidr="$1"
  info "tcp 22   <- $ssh_cidr"
  # shellcheck disable=SC2046
  info "tcp 443  <- $(https_cidrs)"
  if [[ "$OPEN_PORT_80_FOR_ACME" == true ]]; then
    info "tcp 80   <- 0.0.0.0/0  (Let's Encrypt HTTP-01; Caddy serves only ACME + https redirect)"
  fi
  info "everything else: closed (no UDP, no ICMP, no IPv6 -- instance is IPv4-only)"
}

# Replaces the instance's entire public-port rule set. Caller must have confirmed.
apply_firewall() {
  local ssh_cidr="$1" rules
  # shellcheck disable=SC2046
  rules="{\"fromPort\":22,\"toPort\":22,\"protocol\":\"tcp\",\"cidrs\":[\"$ssh_cidr\"]},"
  # shellcheck disable=SC2046
  rules+="{\"fromPort\":443,\"toPort\":443,\"protocol\":\"tcp\",\"cidrs\":[$(json_cidrs $(https_cidrs))]}"
  if [[ "$OPEN_PORT_80_FOR_ACME" == true ]]; then
    rules+=",{\"fromPort\":80,\"toPort\":80,\"protocol\":\"tcp\",\"cidrs\":[\"0.0.0.0/0\"]}"
  fi
  lsail put-instance-public-ports --instance-name "$INSTANCE_NAME" --port-infos "[$rules]" >/dev/null
}

static_ip() {
  lsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --query 'staticIp.ipAddress' --output text
}
