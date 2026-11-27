#!/usr/bin/env bash
# Apply a consistent, rollback-safe ECR lifecycle policy to all TINA repositories.
# Keeps the newest 20 tagged images per repository (enough headroom for both staging
# and prod pinned digests) and expires orphaned untagged manifests older than 7 days.
# Note: AWS ECR never deletes child manifests still referenced by a live tagged OCI index.
set -euo pipefail

PROFILE="${AWS_PROFILE:-tina}"
REGION="${AWS_REGION:-us-east-1}"
KEEP_TAGGED="${KEEP_TAGGED:-20}"
UNTAGGED_DAYS="${UNTAGGED_DAYS:-7}"

POLICY="$(cat <<EOF
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Expire orphaned untagged images after ${UNTAGGED_DAYS} days",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": ${UNTAGGED_DAYS}
      },
      "action": {
        "type": "expire"
      }
    },
    {
      "rulePriority": 2,
      "description": "Keep newest ${KEEP_TAGGED} tagged images per repository",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*"],
        "countType": "imageCountMoreThan",
        "countNumber": ${KEEP_TAGGED}
      },
      "action": {
        "type": "expire"
      }
    }
  ]
}
EOF
)"

repos="$(aws --profile "$PROFILE" --region "$REGION" ecr describe-repositories \
  --query "repositories[?starts_with(repositoryName, 'tina-')].repositoryName" \
  --output text)"

for repo in $repos; do
  aws --profile "$PROFILE" --region "$REGION" ecr put-lifecycle-policy \
    --repository-name "$repo" \
    --lifecycle-policy-text "$POLICY" >/dev/null
  printf "  applied lifecycle policy (keep=%s, untagged>%sd): %s\n" "$KEEP_TAGGED" "$UNTAGGED_DAYS" "$repo"
done
