#!/usr/bin/env bash
# TINA AWS Staging power manager (sleep / sleep-heavy / wake / wake-lite / status)
# Cuts Fargate + RDS compute costs by ~70-85% when not actively developing or demoing.
set -euo pipefail

PROFILE="${AWS_PROFILE:-tina}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${TINA_ECS_CLUSTER:-tina-foundation-ecs}"
RDS_ID="${TINA_RDS_ID:-tina-staging-datastores-postgres-spq5zinq2xpt}"
STAGE_URL="${TINA_STAGE_URL:-https://d2eanx74y89uq2.cloudfront.net}"

CORE_SERVICES=(
  "tina-staging-workspace-s3-EgressProxyService-s0ihtPvdiwuy"
  "tina-staging-runtime-RuntimeService-Kr54KSaE2MBt"
  "tina-staging-core-CoreService-T35xZMVtCjVY"
)

APP_SERVICES=(
  "tina-staging-agent-api-AgentApi-oonumHoasGVD"
  "tina-staging-terminal-TerminalService-H2dZpi6pYvyl"
  "tina-staging-agent-reach-AgentReach-MUL0sRjnrIdD"
  "tina-staging-flows-Service-WQRXwCLllb5T"
  "tina-staging-flows-MailboxService-ufA7pkpOokDE"
  "tina-staging-mcp-Mcp-UgUIUOWAvf0V"
)

HEAVY_SPEECH_SERVICES=(
  "tina-staging-viegem-Worker-nut0O2V84HHi"
  "tina-staging-voice-Voice-EupmDBNUiPdR"
)

ALL_SERVICES=("${CORE_SERVICES[@]}" "${APP_SERVICES[@]}" "${HEAVY_SPEECH_SERVICES[@]}")

aws_cmd() {
  aws --profile "$PROFILE" --region "$REGION" "$@"
}

usage() {
  cat <<'EOF'
Usage: deploy/aws/staging-power.sh <command> [--keep-rds]

Commands:
  status       Show running/desired counts for all 11 ECS services, ephemeral tasks, and RDS state.
  sleep        Scale all 11 ECS services to 0, stop idle ephemeral tasks, and stop RDS (unless --keep-rds).
  sleep-heavy  Scale only heavy speech services (VieGem + Voice, 4 vCPU / 16 GiB) to 0; keep web/chat/wiki live.
  wake         Start RDS (if stopped), scale all 11 ECS services back to 1, and verify CloudFront health.
  wake-lite    Start RDS (if stopped) and wake 9 web/agent services (leave VieGem + Voice at 0).
EOF
}

scale_list() {
  local count="$1"
  shift
  for svc in "$@"; do
    printf "  %-62s -> desired=%s\n" "$svc" "$count"
    aws_cmd ecs update-service --cluster "$CLUSTER" --service "$svc" --desired-count "$count" >/dev/null
  done
}

show_status() {
  echo "== ECS Services ($CLUSTER, $REGION) =="
  aws_cmd ecs describe-services --cluster "$CLUSTER" --services "${CORE_SERVICES[@]}" "${APP_SERVICES[@]}" \
    --query "services[].{Service:serviceName,Desired:desiredCount,Running:runningCount,Pending:pendingCount,Status:status}" \
    --output table
  aws_cmd ecs describe-services --cluster "$CLUSTER" --services "${HEAVY_SPEECH_SERVICES[@]}" \
    --query "services[].{Service:serviceName,Desired:desiredCount,Running:runningCount,Pending:pendingCount,Status:status}" \
    --output table

  echo "== Active Ephemeral Workspace Tasks =="
  local ws_tasks
  ws_tasks="$(aws_cmd ecs list-tasks --cluster "$CLUSTER" --family tina-staging-ws-ephemeral --desired-status RUNNING --query "length(taskArns)" --output text)"
  local nova_tasks
  nova_tasks="$(aws_cmd ecs list-tasks --cluster "$CLUSTER" --family tina-staging-ws-nova --desired-status RUNNING --query "length(taskArns)" --output text)"
  echo "  ws-ephemeral running: ${ws_tasks} | ws-nova running: ${nova_tasks}"

  echo "== RDS PostgreSQL ($RDS_ID) =="
  aws_cmd rds describe-db-instances --db-instance-identifier "$RDS_ID" \
    --query "DBInstances[0].{Id:DBInstanceIdentifier,Class:DBInstanceClass,Status:DBInstanceStatus}" \
    --output table
}

stop_ephemeral_tasks() {
  for fam in tina-staging-ws-ephemeral tina-staging-ws-nova; do
    local arns
    arns="$(aws_cmd ecs list-tasks --cluster "$CLUSTER" --family "$fam" --desired-status RUNNING --query "taskArns[]" --output text)"
    for arn in $arns; do
      if [[ -n "$arn" && "$arn" != "None" ]]; then
        echo "  Stopping ephemeral task $arn"
        aws_cmd ecs stop-task --cluster "$CLUSTER" --task "$arn" --reason "staging-power sleep" >/dev/null
      fi
    done
  done
}

ensure_rds_started() {
  local status
  status="$(aws_cmd rds describe-db-instances --db-instance-identifier "$RDS_ID" --query "DBInstances[0].DBInstanceStatus" --output text)"
  echo "== RDS status: $status =="
  if [[ "$status" == "stopped" ]]; then
    echo "  Starting RDS $RDS_ID..."
    aws_cmd rds start-db-instance --db-instance-identifier "$RDS_ID" >/dev/null
    echo "  Waiting for RDS to become available (usually 2-4 min)..."
    aws_cmd rds wait db-instance-available --db-instance-identifier "$RDS_ID"
  elif [[ "$status" == "starting" ]]; then
    echo "  Waiting for RDS to finish starting..."
    aws_cmd rds wait db-instance-available --db-instance-identifier "$RDS_ID"
  elif [[ "$status" != "available" ]]; then
    echo "  WARNING: RDS is currently '$status' — wait until available before waking services." >&2
    exit 1
  fi
}

stop_rds_if_available() {
  local status
  status="$(aws_cmd rds describe-db-instances --db-instance-identifier "$RDS_ID" --query "DBInstances[0].DBInstanceStatus" --output text)"
  if [[ "$status" == "available" ]]; then
    echo "== Stopping RDS $RDS_ID (AWS auto-restarts after 7 days) =="
    aws_cmd rds stop-db-instance --db-instance-identifier "$RDS_ID" >/dev/null
  else
    echo "== RDS $RDS_ID is '$status' — skipping stop =="
  fi
}

verify_edge() {
  echo "== Waiting for Terminal + Core services to stabilize =="
  aws_cmd ecs wait services-stable --cluster "$CLUSTER" --services \
    "tina-staging-core-CoreService-T35xZMVtCjVY" \
    "tina-staging-terminal-TerminalService-H2dZpi6pYvyl" \
    "tina-staging-runtime-RuntimeService-Kr54KSaE2MBt" \
    "tina-staging-workspace-s3-EgressProxyService-s0ihtPvdiwuy"
  local root_code auth_code
  root_code="$(curl -sS -o /dev/null -w '%{http_code}' "${STAGE_URL}/")"
  auth_code="$(curl -sS -o /dev/null -w '%{http_code}' "${STAGE_URL}/api/auth/me")"
  echo "== Health check: GET ${STAGE_URL}/ -> ${root_code} | /api/auth/me -> ${auth_code} =="
}

cmd="${1:-}"
keep_rds="false"
if [[ "${2:-}" == "--keep-rds" ]]; then
  keep_rds="true"
fi

case "$cmd" in
  status)
    show_status
    ;;
  sleep)
    echo "== Scaling all 11 ECS services to 0 =="
    scale_list 0 "${ALL_SERVICES[@]}"
    stop_ephemeral_tasks
    if [[ "$keep_rds" == "false" ]]; then
      stop_rds_if_available
    else
      echo "== Keeping RDS running (--keep-rds) =="
    fi
    echo "Staging is now sleeping. Run '$0 wake' ~3 minutes before demo."
    ;;
  sleep-heavy)
    echo "== Scaling heavy speech services (VieGem + Voice) to 0 =="
    scale_list 0 "${HEAVY_SPEECH_SERVICES[@]}"
    echo "Heavy speech services stopped (saves ~50% Fargate cost). Web/Agent/Wiki remain online."
    ;;
  wake)
    ensure_rds_started
    echo "== Waking core services =="
    scale_list 1 "${CORE_SERVICES[@]}"
    echo "== Waking app + heavy speech services =="
    scale_list 1 "${APP_SERVICES[@]}" "${HEAVY_SPEECH_SERVICES[@]}"
    verify_edge
    show_status
    ;;
  wake-lite)
    ensure_rds_started
    echo "== Waking core + app services (leaving VieGem + Voice at 0) =="
    scale_list 1 "${CORE_SERVICES[@]}" "${APP_SERVICES[@]}"
    verify_edge
    show_status
    ;;
  *)
    usage
    exit 1
    ;;
esac
