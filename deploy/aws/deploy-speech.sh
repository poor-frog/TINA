#!/usr/bin/env bash
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo 'Run as root'; exit 1; fi
SOURCE=/opt/tina/source
SECRETS=/opt/tina/secrets
ENV_FILE="$SECRETS/speech.env"
mkdir -p "$SECRETS"
chmod 0700 "$SECRETS"
umask 077
aws ssm get-parameter --region us-east-1 --name /tina/demo/speech-env --with-decryption \
  --query Parameter.Value --output text > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
if grep -q REPLACE_ "$ENV_FILE"; then echo 'ERROR: Set real ASR token'; exit 1; fi
DOCKER_CONFIG=$(mktemp -d /run/tina-docker-XXXXXX)
export DOCKER_CONFIG
cleanup() { docker logout ghcr.io >/dev/null 2>&1 || true; rm -rf "$DOCKER_CONFIG"; }; trap cleanup EXIT
if aws ssm get-parameter --region us-east-1 --name /tina/demo/ghcr-token \
  --with-decryption --query Parameter.Value --output text >/dev/null 2>&1; then
  GHCR_USER=$(aws ssm get-parameter --region us-east-1 --name /tina/demo/ghcr-user --query Parameter.Value --output text)
  GHCR_PAT=$(aws ssm get-parameter --region us-east-1 --name /tina/demo/ghcr-token --with-decryption --query Parameter.Value --output text)
  printf '%s' "$GHCR_PAT" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
  unset GHCR_PAT
fi
COMPOSE="$SOURCE/deploy/aws/speech.compose.yml"
compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE")
"${compose[@]}" config --quiet
"${compose[@]}" pull viegem viegem-models
"${compose[@]}" run --rm --no-deps viegem-models

# The retired service used the same private host port. Cut over only the Speech project.
legacy=$(docker ps -q --filter label=com.docker.compose.project=tina-speech \
  --filter label=com.docker.compose.service=gipformer)
if [[ -n "$legacy" && "$legacy" == *$'\n'* ]]; then
  echo 'ERROR: Multiple running legacy Speech workers. Resolve the port ownership before deploying.'
  exit 1
fi
if [[ -n "$legacy" ]]; then
  owner=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$legacy")
  if [[ "$owner" != "$COMPOSE" ]]; then
    echo 'ERROR: Legacy Speech worker belongs to a different Compose file.'
    exit 1
  fi
  docker stop "$legacy" >/dev/null
fi
if ! "${compose[@]}" up -d --no-build --pull never --wait viegem; then
  if [[ -n "$legacy" ]]; then
    "${compose[@]}" stop viegem
    docker start "$legacy" >/dev/null
  fi
  exit 1
fi
printf '\nASR STATUS\n'; docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
curl --fail --show-error --max-time 10 http://127.0.0.1:18002/health
