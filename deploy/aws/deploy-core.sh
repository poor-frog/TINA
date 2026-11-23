#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root'; exit 1; fi
SOURCE=/opt/tina/source
SECRETS=/opt/tina/secrets
ENV_FILE="$SECRETS/core.env"
BASE="$SOURCE/deploy/compose/docker-compose.yml"
OVERLAY="$SOURCE/deploy/aws/core.override.yml"
CADDY="$SOURCE/deploy/aws/caddy.compose.yml"
mkdir -p "$SECRETS"
chmod 0700 "$SECRETS"
umask 077
aws ssm get-parameter --region us-east-1 --name /tina/demo/core-env --with-decryption \
  --query Parameter.Value --output text > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
if grep -q -e REPLACE_ -e '10.20.2.X' "$ENV_FILE"; then
  echo 'ERROR: Set actual secure env values and Speech private IP before deployment'; exit 1
fi
# Compose reads this file through --env-file; do NOT source untrusted secrets as shell code.
export TINA_COMPOSE_ENV_FILE="$ENV_FILE"
DOCKER_CONFIG=$(mktemp -d /run/tina-docker-XXXXXX)
export DOCKER_CONFIG
cleanup() { docker logout ghcr.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"; }; trap cleanup EXIT
# GHCR packages can stay private. Set Parameter Store /tina/demo/ghcr-user (String)
# and /tina/demo/ghcr-token (SecureString, classic PAT read:packages).
if aws ssm get-parameter --region us-east-1 --name /tina/demo/ghcr-token \
  --with-decryption --query Parameter.Value --output text > /dev/null 2>&1; then
  GHCR_USER=$(aws ssm get-parameter --region us-east-1 --name /tina/demo/ghcr-user --query Parameter.Value --output text)
  GHCR_PAT=$(aws ssm get-parameter --region us-east-1 --name /tina/demo/ghcr-token --with-decryption --query Parameter.Value --output text)
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
  unset GHCR_PAT
fi
# Runtime starts these containers on demand; pre-pull so runtime needn't authenticate.
docker pull ghcr.io/poor-frog/tina-bot:prod
docker pull ghcr.io/poor-frog/tina-agent-worker:prod
# Validate before launching anything. Do not output config (contains passwords).
docker compose --env-file "$ENV_FILE" -f "$BASE" -f "$OVERLAY" config --quiet
# Compose original has build: definitions. --no-build is essential on small EC2.
docker compose --env-file "$ENV_FILE" -f "$BASE" -f "$OVERLAY" up \
  -d --no-build --pull always --wait \
  agent-reach admin-api runtime agent-api meeting-api gateway flows-api mcp terminal
# Caddy host networking reaches Terminal loopback bind 127.0.0.1:13000.
docker compose -f "$CADDY" up -d --wait
printf '\nCORE CONTAINERS\n'; docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
printf '\nLOCAL TERMINAL\n'; curl --fail --silent --show-error -I --max-time 10 http://127.0.0.1:13000 || true
printf '\nHTTPS\n'; curl -I --max-time 12 https://tinabot.duckdns.org || true
