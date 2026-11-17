#!/usr/bin/env bash
# Base server setup: updates, 2 GB swap, fail2ban for SSH, Docker Engine + Compose from the
# official Docker repository, container log rotation, application directory.
# Idempotent. Contains no server parameters (domain, IP, addresses).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get -y -qq upgrade
apt-get install -y -qq ca-certificates curl gnupg fail2ban jq

# 2 GB swap (headroom for PostgreSQL peaks and upgrades)
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q -w vm.swappiness=10; echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf

# fail2ban for SSH (password login stays enabled)
cat > /etc/fail2ban/jail.d/sshd.local <<'J'
[sshd]
enabled = true
backend = systemd
maxretry = 5
findtime = 10m
bantime = 1h
J
systemctl enable --now fail2ban >/dev/null; systemctl restart fail2ban

# Docker Engine from the official repository
install -m 0755 -d /etc/apt/keyrings
[ -f /etc/apt/keyrings/docker.asc ] || curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
# shellcheck source=/dev/null
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Container log rotation
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'D'
{ "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "5" } }
D
systemctl enable --now docker >/dev/null; systemctl restart docker

# Application directory
install -d -m 0750 /opt/supersync

echo "--- summary"
docker --version; docker compose version
swapon --show --noheadings
fail2ban-client status sshd | sed -n '1,4p'
ufw status | head -1
