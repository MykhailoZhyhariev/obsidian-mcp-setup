#!/usr/bin/env bash
# Create the Lightsail instance, static IP, firewall and daily auto-snapshots.
#
# Nothing is created until you have reviewed the plan this script prints and typed "yes".
# Safe to re-run: resources that already exist are skipped, the firewall is re-applied.
set -euo pipefail
# shellcheck source=infra/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config

command -v aws >/dev/null  || die "aws CLI not found"
command -v curl >/dev/null || die "curl not found"

# ---- read-only preflight ---------------------------------------------------------------------
log "Preflight (read-only AWS calls)"
account="$(aws sts get-caller-identity ${AWS_PROFILE:+--profile "$AWS_PROFILE"} --query Account --output text | tr -d '\r')" \
  || die "AWS credentials not working (aws sts get-caller-identity failed)"
info "AWS account $account, region $AWS_REGION"

[[ -n "$(lsail get-blueprints --query "blueprints[?blueprintId=='$BLUEPRINT_ID' && isActive].blueprintId" --output text)" ]] \
  || die "Blueprint '$BLUEPRINT_ID' not available. Ubuntu blueprints: $(lsail get-blueprints --query "blueprints[?contains(blueprintId,'ubuntu') && isActive].blueprintId" --output text)"

bundle_info="$(lsail get-bundles --query "bundles[?bundleId=='$BUNDLE_ID' && isActive && contains(supportedPlatforms,'LINUX_UNIX')].[ramSizeInGb,cpuCount,diskSizeInGb,price]" --output text)"
[[ -n "$bundle_info" ]] \
  || die "Bundle '$BUNDLE_ID' not available. Active Linux bundles: $(lsail get-bundles --query "bundles[?isActive && contains(supportedPlatforms,'LINUX_UNIX')].bundleId" --output text)"
read -r b_ram b_cpu b_disk b_price <<<"$bundle_info"

# --output text separates list items with TABs; normalise all whitespace to single spaces before matching.
zones="$(lsail get-regions --include-availability-zones --query "regions[?name=='$AWS_REGION'].availabilityZones[].zoneName" --output text | tr -s '[:space:]' ' ')"
[[ " $zones " == *" $AWS_AZ "* ]] \
  || die "Availability zone $AWS_AZ not found in $AWS_REGION (available: ${zones:-none returned})"

[[ "$SNAPSHOT_TIME_UTC" =~ ^([01][0-9]|2[0-3]):00$ ]] || die "SNAPSHOT_TIME_UTC must be HH:00 (UTC)"

[[ -f "$SSH_PUBLIC_KEY_FILE" ]] || die "SSH public key not found: $SSH_PUBLIC_KEY_FILE"
ssh-keygen -l -f "$SSH_PUBLIC_KEY_FILE" >/dev/null 2>&1 || die "Not a valid SSH public key: $SSH_PUBLIC_KEY_FILE"
pubkey="$(head -n1 "$SSH_PUBLIC_KEY_FILE" | tr -d '\r')"
[[ "$pubkey" != *"'"* ]] || die "Unexpected quote character in public key"

ssh_cidr="$(resolve_ssh_cidr)"

have_instance=false; exists get-instance --instance-name "$INSTANCE_NAME" >/dev/null && have_instance=true
have_ip=false;       exists get-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null && have_ip=true

# ---- plan ------------------------------------------------------------------------------------
echo
log "Plan -- these AWS Lightsail resources would be created/changed in $AWS_REGION:"
if $have_instance; then
  info "[exists]  instance '$INSTANCE_NAME' -- will NOT be recreated"
else
  info "[CREATE]  instance '$INSTANCE_NAME' in $AWS_AZ: $BLUEPRINT_ID, bundle $BUNDLE_ID (${b_cpu} vCPU, ${b_ram} GB RAM, ${b_disk} GB disk, \$${b_price}/month), IPv4 only"
  info "          first boot installs ONLY your public key for '$SSH_USER' (replaces Lightsail's default key)"
  info "          add-on: AutoSnapshot daily at ${SNAPSHOT_TIME_UTC} UTC (last 7 kept; snapshot storage is billed separately)"
fi
if $have_ip; then
  info "[exists]  static IP '$STATIC_IP_NAME' -- will NOT be recreated"
else
  info "[CREATE]  static IP '$STATIC_IP_NAME' (free while attached to the instance)"
fi
info "[ATTACH]  static IP -> instance (if not already attached)"
info "[SET]     instance firewall (replaces ALL existing rules):"
describe_firewall "$ssh_cidr"
echo
warn "Lightsail opens SSH(22)/HTTP(80) to the world on a brand-new instance until the firewall is applied;"
warn "this script applies it as soon as the instance exists (typically under a minute). Login is key-only."
echo
confirm "Create/modify the resources listed above?"

# ---- create ----------------------------------------------------------------------------------
trap 'echo; warn "Provisioning interrupted. Re-run infra/provision.sh -- existing resources are skipped."' ERR

if ! $have_instance; then
  log "Creating instance $INSTANCE_NAME"
  user_data="#!/bin/bash
set -eu
install -d -m 700 -o $SSH_USER -g $SSH_USER /home/$SSH_USER/.ssh
printf '%s\\n' '$pubkey' > /home/$SSH_USER/.ssh/authorized_keys
chown $SSH_USER:$SSH_USER /home/$SSH_USER/.ssh/authorized_keys
chmod 600 /home/$SSH_USER/.ssh/authorized_keys
"
  lsail create-instances \
    --instance-names "$INSTANCE_NAME" \
    --availability-zone "$AWS_AZ" \
    --blueprint-id "$BLUEPRINT_ID" \
    --bundle-id "$BUNDLE_ID" \
    --ip-address-type ipv4 \
    --user-data "$user_data" \
    --add-ons "[{\"addOnType\":\"AutoSnapshot\",\"autoSnapshotAddOnRequest\":{\"snapshotTimeOfDay\":\"$SNAPSHOT_TIME_UTC\"}}]" \
    --tags key=project,value=obsidian-mcp >/dev/null
fi

log "Applying firewall"
for attempt in $(seq 1 24); do
  if apply_firewall "$ssh_cidr" 2>/dev/null; then fw_ok=true; break; fi
  fw_ok=false; sleep 5
done
$fw_ok || { apply_firewall "$ssh_cidr"; }   # run once more un-silenced to show the real error

log "Waiting for instance to be running"
for _ in $(seq 1 60); do
  state="$(lsail get-instance-state --instance-name "$INSTANCE_NAME" --query state.name --output text)"
  [[ "$state" == running ]] && break
  sleep 5
done
[[ "$state" == running ]] || die "Instance did not reach 'running' (state: $state)"

if ! $have_ip; then
  log "Allocating static IP $STATIC_IP_NAME"
  lsail allocate-static-ip --static-ip-name "$STATIC_IP_NAME" >/dev/null
fi
if [[ "$(lsail get-static-ip --static-ip-name "$STATIC_IP_NAME" --query staticIp.isAttached --output text)" != True ]]; then
  log "Attaching static IP"
  lsail attach-static-ip --static-ip-name "$STATIC_IP_NAME" --instance-name "$INSTANCE_NAME" >/dev/null
fi

trap - ERR
ip="$(static_ip)"
echo
log "Done."
info "Static IP: $ip"
info ""
info "Next:"
info "  1. Create a DNS A record:  ${DOMAIN:-<your domain>}  ->  $ip   (needed before Caddy can get a certificate)"
info "  2. Run infra/deploy.sh to install Node, obsidian-headless, Caddy and the MCP server."
