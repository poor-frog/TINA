#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root: sudo bash ...'; exit 1; fi
if [[ $(uname -m) != x86_64 ]]; then echo 'This bundle targets linux/amd64 (x86_64)'; exit 1; fi
if [[ ! -f /etc/os-release ]] || ! grep -q '^ID="\?amzn' /etc/os-release; then
  echo 'This bootstrap expects Amazon Linux 2023/2. Adapt package manager for other OS.'; exit 1
fi
if command -v dnf >/dev/null 2>&1; then
  dnf install -y docker git curl jq iptables-nft
  if ! command -v aws >/dev/null 2>&1; then dnf install -y awscli-2; fi
else
  yum install -y docker git curl jq iptables
  if ! command -v aws >/dev/null 2>&1; then yum install -y awscli; fi
fi
systemctl enable --now docker
if ! docker compose version >/dev/null 2>&1; then
  mkdir -p /usr/local/lib/docker/cli-plugins
  curl -fsSL 'https://github.com/docker/compose/releases/download/v2.39.4/docker-compose-linux-x86_64' \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose
fi
docker version --format 'Docker Engine: {{.Server.Version}}'
docker compose version
aws --version
