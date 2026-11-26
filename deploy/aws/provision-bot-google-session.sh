#!/usr/bin/env bash
# Provision a signed-in Google Chrome profile locally and upload ONLY the auth-essential subset
# (~200 KB) to the AWS Staging S3 bucket so ECS Fargate bots can join Google Meet signed-in
# using their least-privilege BotTaskRole (zero static AWS keys in invocation payloads).
#
# Usage:
#   ./deploy/aws/provision-bot-google-session.sh
#
# Optional overrides:
#   AWS_PROFILE=tina AWS_REGION=us-east-1 \
#   BOT_S3_BUCKET=tina-foundation-stagingrecordings-susispk8fjdt \
#   BOT_USERDATA_S3_PATH=userdata/staging-bot-1 \
#   ./deploy/aws/provision-bot-google-session.sh
set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-tina}"
AWS_REGION="${AWS_REGION:-us-east-1}"
BOT_S3_BUCKET="${BOT_S3_BUCKET:-tina-foundation-stagingrecordings-susispk8fjdt}"
BOT_USERDATA_S3_PATH="${BOT_USERDATA_S3_PATH:-userdata/staging-bot-1}"
BOT_S3_ENDPOINT="${BOT_S3_ENDPOINT:-https://s3.${AWS_REGION}.amazonaws.com}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REMOTE_BROWSER_DIR="${REPO_ROOT}/core/meetings/modules/remote-browser"

TSX_BIN=""
for candidate in \
  "${REMOTE_BROWSER_DIR}/node_modules/.bin/tsx" \
  "${REPO_ROOT}/../TINA/core/meetings/modules/remote-browser/node_modules/.bin/tsx"; do
  if [ -x "${candidate}" ]; then
    TSX_BIN="${candidate}"
    break
  fi
done
if [ -z "${TSX_BIN}" ]; then
  echo "ERROR: tsx binary not found. Run pnpm install first." >&2
  exit 1
fi

export AWS_PROFILE AWS_REGION
export AUTH_PLATFORM="google"
export BOT_USERDATA_S3_PATH
export BOT_S3_BUCKET
export BOT_S3_ENDPOINT
export LOGIN_PROFILE_DIR="${LOGIN_PROFILE_DIR:-$(mktemp -d /tmp/tina-staging-google-login-XXXXXX)}"

trap 'rm -rf "${LOGIN_PROFILE_DIR}"' EXIT

echo "==> Opening Chromium to sign into the dedicated Google bot account..."
echo "==> Target S3 prefix: s3://${BOT_S3_BUCKET}/${BOT_USERDATA_S3_PATH}/browser-data"
(cd "${REMOTE_BROWSER_DIR}" && "${TSX_BIN}" src/provision-cli.ts google)

echo ""
echo "==> Profile uploaded! Enable Authenticated Bot Mode on Staging Core with:"
echo "  aws --profile ${AWS_PROFILE} --region ${AWS_REGION} cloudformation update-stack \\"
echo "    --stack-name tina-staging-core \\"
echo "    --use-previous-template \\"
echo "    --capabilities CAPABILITY_IAM \\"
echo "    --parameters ParameterKey=BotAuthenticated,ParameterValue=true ParameterKey=BotUserdataS3Path,ParameterValue=${BOT_USERDATA_S3_PATH} ..."
