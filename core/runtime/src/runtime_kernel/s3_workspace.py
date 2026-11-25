"""S3-backed ephemeral Fargate workspace launcher using per-turn STS Session Policies.

Eliminates EFS Access Points, EFS FileSystemPolicy churn, and dynamic ECS TaskDefinition
registration by launching ONE static Fargate TaskDefinition (``tina-staging-ws-ephemeral``)
with three containers:
  - ``stream``: Valkey loopback bridge (127.0.0.1:8721)
  - ``sync``:   S3 pull/commit sidecar (127.0.0.1:8722) holding turn-scoped STS credentials
  - ``worker``: Untrusted harness container with ZERO AWS/S3 credentials
"""
from __future__ import annotations

from dataclasses import dataclass
import json
import os
import re
import time
from typing import Any

from .dynamic_workspace import validate_dynamic_mounts
from .workspace_tasks import WorkspaceTask


def build_scoped_s3_session_policy(
    *,
    bucket: str,
    kms_key_arn: str,
    owner: str,
    mounts: dict[str, bool],
) -> str:
    """Build a compact (<2048 bytes) IAM inline STS Session Policy for ONE workspace turn.

    - Own prefixes (home, system, attached slots): grouped cleanly under ``users/<owner>/*``
      (GitHub tokens live outside under ``secrets/users/<owner>/*`` and are explicitly denied
      on the broker role).
    - Shared wikis: granted explicitly per workspace_id, with ``PutObject`` ONLY when ``write=True``.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    list_prefixes: list[str] = [f"users/{owner}/*"]
    rw_resources: list[str] = [f"{bucket_arn}/users/{owner}/*"]
    ro_resources: list[str] = []

    for path, write in sorted(mounts.items()):
        if path == "/workspaces/_global":
            if write:
                raise ValueError("Global system workspace mount must be read-only")
            list_prefixes.append("_global/*")
            ro_resources.append(f"{bucket_arn}/_global/*")
            continue
        if path in (f"/workspaces/{owner}", f"/workspaces/_system/{owner}"):
            continue
        if path.startswith(f"/workspaces/_attached/{owner}/"):
            continue
        # Shared workspace at /workspaces/<workspace_id>
        wid = path.removeprefix("/workspaces/")
        list_prefixes.append(f"shared/{wid}/*")
        if write:
            rw_resources.append(f"{bucket_arn}/shared/{wid}/*")
        else:
            ro_resources.append(f"{bucket_arn}/shared/{wid}/*")

    statements: list[dict[str, Any]] = [
        {
            "Sid": "List",
            "Effect": "Allow",
            "Action": "s3:ListBucket",
            "Resource": bucket_arn,
            "Condition": {"StringLike": {"s3:prefix": sorted(set(list_prefixes))}},
        },
        {
            "Sid": "RW",
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject"],
            "Resource": sorted(set(rw_resources)),
        },
    ]
    if ro_resources:
        statements.append({
            "Sid": "RO",
            "Effect": "Allow",
            "Action": "s3:GetObject",
            "Resource": sorted(set(ro_resources)),
        })
    if kms_key_arn:
        statements.append({
            "Sid": "Kms",
            "Effect": "Allow",
            "Action": ["kms:Decrypt", "kms:GenerateDataKey"],
            "Resource": kms_key_arn,
        })
    policy = json.dumps({"Version": "2012-10-17", "Statement": statements}, separators=(",", ":"))
    if len(policy.encode("utf-8")) > 2048:
        raise ValueError("Scoped S3 session policy exceeds AWS STS 2048-byte limit")
    return policy


@dataclass(frozen=True)
class S3WorkspaceConfig:
    task_definition: str
    security_group: str
    broker_role_arn: str
    bucket: str
    kms_key_arn: str
    region: str = "us-east-1"
    session_duration_sec: int = 900

    @classmethod
    def from_env(cls) -> S3WorkspaceConfig | None:
        td = (os.environ.get("RUNTIME_ECS_EPHEMERAL_TASK_DEFINITION") or "").strip()
        if not td:
            return None
        sg = (os.environ.get("RUNTIME_ECS_EPHEMERAL_SECURITY_GROUP") or "").strip()
        broker = (os.environ.get("RUNTIME_ECS_WORKSPACE_S3_BROKER_ROLE_ARN") or "").strip()
        bucket = (os.environ.get("RUNTIME_ECS_WORKSPACE_S3_BUCKET") or "").strip()
        kms = (os.environ.get("RUNTIME_ECS_WORKSPACE_S3_KMS_KEY_ARN") or "").strip()
        if not all((td, sg, broker, bucket, kms)):
            raise ValueError("Incomplete S3 ephemeral workspace runtime configuration")
        if not re.fullmatch(r"arn:[^:]+:ecs:[^:]+:[0-9]{12}:task-definition/[^:]+:[0-9]+", td):
            raise ValueError("Ephemeral workspace requires a pinned task definition ARN")
        if not re.fullmatch(r"sg-[a-f0-9]+", sg):
            raise ValueError("Invalid ephemeral workspace security group")
        region = (os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1").strip()
        return cls(
            task_definition=td, security_group=sg, broker_role_arn=broker,
            bucket=bucket, kms_key_arn=kms, region=region,
        )


class S3WorkspaceLauncher:
    """Validates static ephemeral task definition and mints turn-scoped STS credentials."""

    def __init__(self, *, ecs: Any, sts: Any, config: S3WorkspaceConfig) -> None:
        self.ecs = ecs
        self.sts = sts
        self.config = config
        td = ecs.describe_task_definition(taskDefinition=config.task_definition)["taskDefinition"]
        containers = {c["name"]: c for c in td["containerDefinitions"]}
        allowed_sets = [{"worker", "sync", "stream"}, {"init-perms", "worker", "sync", "stream"}]
        if (set(containers) not in allowed_sets
                or td["networkMode"] != "awsvpc"
                or "FARGATE" not in td["requiresCompatibilities"]):
            raise ValueError("Ephemeral workspace task definition must define worker, sync, and stream on Fargate")
        image = containers["worker"]["image"]
        if (not re.search(r"@sha256:[0-9a-f]{64}$", image)
                or containers["sync"]["image"] != image
                or containers["stream"]["image"] != image
                or containers["worker"].get("secrets")
                or containers["sync"].get("secrets")
                or ("init-perms" in containers and (
                    containers["init-perms"]["image"] != image
                    or containers["init-perms"].get("secrets")
                    or containers["init-perms"].get("essential", True) is not False
                ))):
            raise ValueError("Invalid ephemeral workspace container isolation")
        self.image = image
        self.cpu = int(td["cpu"])
        self.memory = int(td["memory"])
        self.family = config.task_definition.rsplit("/", 1)[1].split(":")[0]

    def prepare(
        self,
        *,
        owner: str,
        mounts: dict[str, bool],
        cwd: str,
        workload_id: str,
        attempt_hex: str,
        mounts_json: str,
    ) -> tuple[WorkspaceTask, dict[str, str]]:
        validate_dynamic_mounts(owner, mounts, cwd)
        policy = build_scoped_s3_session_policy(
            bucket=self.config.bucket,
            kms_key_arn=self.config.kms_key_arn,
            owner=owner,
            mounts=mounts,
        )
        assumed = self.sts.assume_role(
            RoleArn=self.config.broker_role_arn,
            RoleSessionName=f"tina-u{owner}-{attempt_hex[:12]}",
            Policy=policy,
            DurationSeconds=self.config.session_duration_sec,
        )
        creds = assumed["Credentials"]
        exp = creds.get("Expiration")
        expires_at = exp.timestamp() if hasattr(exp, "timestamp") else (time.time() + self.config.session_duration_sec)
        sync_env = {
            "AWS_ACCESS_KEY_ID": creds["AccessKeyId"],
            "AWS_SECRET_ACCESS_KEY": creds["SecretAccessKey"],
            "AWS_SESSION_TOKEN": creds["SessionToken"],
            "TINA_S3_BUCKET": self.config.bucket,
            "TINA_S3_REGION": self.config.region,
            "TINA_S3_KMS_KEY_ID": self.config.kms_key_arn,
            "TINA_OWNER": owner,
            "TINA_UNIT_ID": workload_id,
            "TINA_MOUNTS": mounts_json,
            "TINA_SYNC_TOKEN_EXPIRES_AT": str(int(expires_at)),
        }
        task = WorkspaceTask(
            owner=owner,
            definition=self.config.task_definition,
            group=self.config.security_group,
            image=self.image,
            cpu=self.cpu,
            memory=self.memory,
            mounts=dict(mounts),
        )
        return task, sync_env
