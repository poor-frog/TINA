#!/usr/bin/env bash
# Provision a signed-in Google Chrome profile inside the EXACT Linux ARM64 bot image
# (via local loopback noVNC at http://127.0.0.1:6080/vnc.html?autoconnect=1) and upload
# ONLY the auth-essential subset (~200 KB) to the AWS Staging S3 bucket.
#
# Running inside the Linux bot image guarantees:
#   1. Linux Chromium `--password-store=basic` cookie encryption (byte-compatible with
#      ECS Fargate bots — macOS Keychain cookies cannot be decrypted on Linux).
#   2. Zero host Node/Playwright setup required (Playwright, Chromium, noVNC, and AWS CLI
#      v2 are already prebaked in the bot image).
#
# Usage:
#   ./deploy/aws/provision-bot-google-session.sh
#
# Optional overrides:
#   AWS_PROFILE=tina AWS_REGION=us-east-1 \
#   BOT_IMAGE=283904064998.dkr.ecr.us-east-1.amazonaws.com/tina-foundation/bot:hardened-8eabec10 \
#   BOT_S3_BUCKET=tina-foundation-stagingrecordings-susispk8fjdt \
#   BOT_USERDATA_S3_PATH=userdata/staging-bot-1 \
#   NOVNC_PORT=6080 \
#   ./deploy/aws/provision-bot-google-session.sh
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-tina}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BOT_S3_BUCKET="${BOT_S3_BUCKET:-tina-foundation-stagingrecordings-susispk8fjdt}"
BOT_USERDATA_S3_PATH="${BOT_USERDATA_S3_PATH:-userdata/staging-bot-1}"
BOT_S3_ENDPOINT="${BOT_S3_ENDPOINT:-https://s3.${AWS_REGION}.amazonaws.com}"
BOT_IMAGE="${BOT_IMAGE:-283904064998.dkr.ecr.us-east-1.amazonaws.com/tina-foundation/bot:hardened-8eabec10}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
LOGIN_TIMEOUT_MS="${LOGIN_TIMEOUT_MS:-600000}"

# Auto-select OrbStack context if the default Docker daemon is paused (common on macOS).
if ! docker info >/dev/null 2>&1; then
  if docker context inspect orbstack >/dev/null 2>&1; then
    export DOCKER_CONTEXT=orbstack
  fi
fi

if ! docker info >/dev/null 2>&1; then
  echo "ERROR: Docker daemon is not reachable (checked default context and orbstack)." >&2
  exit 1
fi

if [ ! -d "${HOME}/.aws" ]; then
  echo "ERROR: ${HOME}/.aws not found. Configure AWS profile '${AWS_PROFILE}' first." >&2
  exit 1
fi

if ! docker image inspect "${BOT_IMAGE}" >/dev/null 2>&1; then
  echo "==> Image ${BOT_IMAGE} not cached locally; logging into ECR and pulling..."
  REGISTRY="${BOT_IMAGE%%/*}"
  aws --profile "${AWS_PROFILE}" --region "${AWS_REGION}" ecr get-login-password \
    | docker login --username AWS --password-stdin "${REGISTRY}"
  docker pull --platform linux/arm64 "${BOT_IMAGE}"
fi

echo "==> Starting Linux Chromium login container (bound strictly to 127.0.0.1:${NOVNC_PORT})"
echo "==> Target S3 prefix: s3://${BOT_S3_BUCKET}/${BOT_USERDATA_S3_PATH}/browser-data"
echo ""
echo ">>> Open in your browser to sign into the dedicated Google bot account:"
echo ">>>   http://127.0.0.1:${NOVNC_PORT}/vnc.html?autoconnect=1&resize=scale"
echo ""

docker run --rm -it \
  --platform linux/arm64 \
  --shm-size=1g \
  -p "127.0.0.1:${NOVNC_PORT}:6080" \
  -v "${HOME}/.aws:/root/.aws:ro" \
  -e "AWS_PROFILE=${AWS_PROFILE}" \
  -e "AWS_REGION=${AWS_REGION}" \
  -e "AUTH_PLATFORM=google" \
  -e "BOT_USERDATA_S3_PATH=${BOT_USERDATA_S3_PATH}" \
  -e "BOT_S3_BUCKET=${BOT_S3_BUCKET}" \
  -e "BOT_S3_ENDPOINT=${BOT_S3_ENDPOINT}" \
  -e "LOGIN_PROFILE_DIR=/tmp/tina-login-profile" \
  -e "LOGIN_TIMEOUT_MS=${LOGIN_TIMEOUT_MS}" \
  --entrypoint /bin/bash \
  "${BOT_IMAGE}" -c '
    set -euo pipefail
    export DISPLAY=:99
    Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -e /tmp/.X11-unix/X99 ] && break
      sleep 0.3
    done
    fluxbox >/tmp/fluxbox.log 2>&1 &
    x11vnc -display :99 -rfbport 5900 -forever -shared -nopw -localhost >/tmp/x11vnc.log 2>&1 &
    websockify --web /usr/share/novnc 0.0.0.0:6080 localhost:5900 >/tmp/websockify.log 2>&1 &
    cd /app/core/meetings/modules/remote-browser
    ./node_modules/.bin/tsx src/provision-cli.ts google
  '

echo ""
echo "==> Profile uploaded! Tell your assistant or enable BotAuthenticated=true on tina-staging-core."
