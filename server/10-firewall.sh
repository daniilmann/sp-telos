#!/usr/bin/env bash
# Enables the UFW firewall: inbound only 22 (SSH, rate-limited), 80 (HTTP for the certificate), 443 (HTTPS).
# Idempotent. Contains no server parameters.
set -euo pipefail
command -v ufw >/dev/null || { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ufw; }
sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw default deny incoming
ufw default allow outgoing
ufw limit 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'http (acme)'
ufw allow 443/tcp comment 'https'
ufw --force enable
ufw status verbose
