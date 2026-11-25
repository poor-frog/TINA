"""Tests for S3 ephemeral workspace STS Session Policy scoping and ECSBackend dual env-file isolation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
from unittest.mock import Mock

from runtime_kernel.ecs_backend import ECSBackend
from runtime_kernel.profiles import Runnable
from runtime_kernel.s3_workspace import (
    S3WorkspaceConfig,
    S3WorkspaceLauncher,
    build_scoped_s3_session_policy,
)

WORKER_IMAGE = "example.invalid/tina/worker@sha256:" + "c" * 64
BOT_IMAGE = "example.invalid/tina/bot@sha256:" + "a" * 64
BOT_DEF = "arn:aws:ecs:us-east-1:123456789012:task-definition/tina-bot:4"
EPH_DEF = "arn:aws:ecs:us-east-1:123456789012:task-definition/tina-staging-ws-ephemeral:3"
TASK_ARN = "arn:aws:ecs:us-east-1:123456789012:task/tina/eph-1"


def test_session_policy_scopes_prefixes_and_readonly_shared_wikis():
    mounts = {
        "/workspaces/_system/42": True,
        "/workspaces/42": True,
        "/workspaces/_attached/42/workspace-1": True,
        "/workspaces/wiki-rw": True,
        "/workspaces/wiki-ro": False,
    }
    raw = build_scoped_s3_session_policy(
        bucket="tina-ws-bucket",
        kms_key_arn="arn:aws:kms:us-east-1:123456789012:key/data-key",
        owner="42",
        mounts=mounts,
    )
    assert len(raw.encode("utf-8")) <= 2048
    policy = json.loads(raw)
    stmts = {s["Sid"]: s for s in policy["Statement"]}
    assert stmts["RW"]["Resource"] == [
        "arn:aws:s3:::tina-ws-bucket/shared/wiki-rw/*",
        "arn:aws:s3:::tina-ws-bucket/users/42/*",
    ]
    assert stmts["RO"]["Action"] == "s3:GetObject"
    assert stmts["RO"]["Resource"] == ["arn:aws:s3:::tina-ws-bucket/shared/wiki-ro/*"]
    assert "secrets" not in raw
    assert "DeleteObject" not in raw


def test_ecs_backend_s3_ephemeral_isolates_sts_creds_to_sync_sidecar():
    ecs = Mock()

    def describe_td(taskDefinition):
        if taskDefinition == BOT_DEF:
            return {"taskDefinition": {
                "requiresCompatibilities": ["FARGATE"], "networkMode": "awsvpc",
                "cpu": "2048", "memory": "4096",
                "containerDefinitions": [{"name": "bot", "image": BOT_IMAGE}],
            }}
        return {"taskDefinition": {
            "requiresCompatibilities": ["FARGATE"], "networkMode": "awsvpc",
            "cpu": "1024", "memory": "2048",
            "containerDefinitions": [
                {"name": "init-perms", "image": WORKER_IMAGE, "essential": False},
                {"name": "worker", "image": WORKER_IMAGE},
                {"name": "sync", "image": WORKER_IMAGE},
                {"name": "stream", "image": WORKER_IMAGE},
            ],
        }}

    ecs.describe_task_definition.side_effect = describe_td
    ecs.run_task.return_value = {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "PROVISIONING"}]}

    sts = Mock()
    sts.assume_role.return_value = {"Credentials": {
        "AccessKeyId": "ASIA_TEMP_KEY",
        "SecretAccessKey": "SECRET_TEMP_KEY",
        "SessionToken": "SESSION_TEMP_TOKEN",
        "Expiration": datetime.now(timezone.utc) + timedelta(minutes=15),
    }}
    s3 = Mock()
    cfg = S3WorkspaceConfig(
        task_definition=EPH_DEF,
        security_group="sg-0123456789abcdef0",
        broker_role_arn="arn:aws:iam::123456789012:role/BrokerRole",
        bucket="tina-ws-bucket",
        kms_key_arn="arn:aws:kms:us-east-1:123456789012:key/data-key",
    )
    launcher = S3WorkspaceLauncher(ecs=ecs, sts=sts, config=cfg)
    backend = ECSBackend(
        ecs=ecs, s3=s3, cluster="tina", task_definition=BOT_DEF,
        subnets=["subnet-1"], security_groups=["sg-app"], bucket="inv-bucket",
        s3_workspace=launcher,
    )

    uid = "agent-42-chat-main"
    mounts = [
        {"path": "/workspaces/_system/42", "write": True},
        {"path": "/workspaces/_attached/42/workspace-1", "write": True},
        {"path": "/workspaces/team-wiki", "write": False},
    ]
    env = {
        "TINA_WORKSPACE_ATTEMPT": "d" * 32,
        "TINA_WORKSPACE_STORAGE": "s3",
        "TINA_OWNER": "42",
        "TINA_UNIT_ID": uid,
        "TINA_CHAT_SESSION": "main",
        "TINA_UNIT_TRIGGER": "message",
        "TINA_UNIT_IN_TOPIC": f"unit:{uid}:in",
        "TINA_UNIT_OUT_TOPIC": f"unit:{uid}:out",
        "TINA_WORKSPACE_PATH": "/workspaces/_attached/42/workspace-1",
        "TINA_MOUNTS": json.dumps(mounts),
        "TINA_RUNNER": "claude-code",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "AWS_REGION": "us-east-1",
        "TINA_AGENT_MODEL": "us.anthropic.claude-sonnet-4-6",
        "REDIS_URL": "rediss://must-not-leak",
    }

    handle = backend.start(uid, Runnable(image=WORKER_IMAGE, command=["python", "-m", "worker"]), env)
    assert handle._impl == TASK_ARN

    # Separate env files uploaded: worker.env has ZERO AWS credentials; sync.env carries STS creds
    puts = {c.kwargs["Key"]: c.kwargs["Body"].decode() for c in s3.put_object.call_args_list}
    worker_keys = [k for k in puts if "/workspace/42/" in k]
    sync_keys = [k for k in puts if "/workspace-sync/42/" in k]
    assert len(worker_keys) == 1 and len(sync_keys) == 1
    worker_env = puts[worker_keys[0]]
    sync_env = puts[sync_keys[0]]
    assert "AWS_ACCESS_KEY_ID" not in worker_env
    assert "AWS_SECRET_ACCESS_KEY" not in worker_env
    assert "AWS_SESSION_TOKEN" not in worker_env
    assert "REDIS_URL" not in worker_env
    assert "TINA_WORKSPACE_SYNC_SIDECAR=1" in worker_env
    assert "TINA_IDLE_TIMEOUT_SEC=300" in worker_env
    assert "AWS_ACCESS_KEY_ID=ASIA_TEMP_KEY" in sync_env
    assert "AWS_SESSION_TOKEN=SESSION_TEMP_TOKEN" in sync_env
    assert "TINA_S3_BUCKET=tina-ws-bucket" in sync_env


def test_ecs_backend_honors_workspace_idle_timeout_env(monkeypatch):
    monkeypatch.setenv("RUNTIME_WORKSPACE_IDLE_TIMEOUT_SEC", "600")
    from runtime_kernel.ecs_backend import _workspace_idle_timeout_sec
    assert _workspace_idle_timeout_sec() == "600"
    monkeypatch.setenv("RUNTIME_WORKSPACE_IDLE_TIMEOUT_SEC", "invalid")
    assert _workspace_idle_timeout_sec() == "300"


def test_ecs_backend_filters_safe_agent_reach_tools():
    from runtime_kernel.ecs_backend import _allowed_workspace_unit_tools

    # Without Agent Reach URL or on Nova Lite, toolbelt stays empty.
    assert _allowed_workspace_unit_tools(
        {"TINA_UNIT_TOOLS": '["reach.web.search","calendar.write"]'}, native_nova=False,
    ) == "[]"
    assert _allowed_workspace_unit_tools(
        {"TINA_AGENT_REACH_URL": "http://agent-reach.tina-staging.local:8080",
         "TINA_UNIT_TOOLS": '["reach.web.search"]'}, native_nova=True,
    ) == "[]"

    # With Agent Reach URL on general S3 worker, only safe public reach.* tools pass through.
    granted = json.loads(_allowed_workspace_unit_tools(
        {"TINA_AGENT_REACH_URL": "http://agent-reach.tina-staging.local:8080",
         "TINA_UNIT_TOOLS": '["reach.web.search","calendar.create","reach.github.read","reach.web.search"]'},
        native_nova=False,
    ))
    assert granted == ["reach.web.search", "reach.github.read"]


def test_ecs_backend_launches_live_meeting_copilot_on_s3_ephemeral_worker():
    ecs = Mock()

    def describe_td(taskDefinition):
        if taskDefinition == BOT_DEF:
            return {"taskDefinition": {
                "requiresCompatibilities": ["FARGATE"], "networkMode": "awsvpc",
                "cpu": "2048", "memory": "4096",
                "containerDefinitions": [{"name": "bot", "image": BOT_IMAGE}],
            }}
        return {"taskDefinition": {
            "requiresCompatibilities": ["FARGATE"], "networkMode": "awsvpc",
            "cpu": "1024", "memory": "2048",
            "containerDefinitions": [
                {"name": "init-perms", "image": WORKER_IMAGE, "essential": False},
                {"name": "worker", "image": WORKER_IMAGE},
                {"name": "sync", "image": WORKER_IMAGE},
                {"name": "stream", "image": WORKER_IMAGE},
            ],
        }}

    ecs.describe_task_definition.side_effect = describe_td
    ecs.run_task.return_value = {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "PROVISIONING"}]}
    sts = Mock()
    sts.assume_role.return_value = {"Credentials": {
        "AccessKeyId": "ASIA_TEMP_KEY", "SecretAccessKey": "SECRET_TEMP_KEY",
        "SessionToken": "SESSION_TEMP_TOKEN", "Expiration": datetime.now(timezone.utc) + timedelta(minutes=15),
    }}
    s3 = Mock()
    cfg = S3WorkspaceConfig(
        task_definition=EPH_DEF, security_group="sg-0123456789abcdef0",
        broker_role_arn="arn:aws:iam::123456789012:role/BrokerRole",
        bucket="tina-ws-bucket", kms_key_arn="arn:aws:kms:us-east-1:123456789012:key/data-key",
    )
    backend = ECSBackend(
        ecs=ecs, s3=s3, cluster="tina", task_definition=BOT_DEF,
        subnets=["subnet-1"], security_groups=["sg-app"], bucket="inv-bucket",
        s3_workspace=S3WorkspaceLauncher(ecs=ecs, sts=sts, config=cfg),
    )

    uid = "agent-meet-42"
    mounts = [
        {"path": "/workspaces/_system/7", "write": True},
        {"path": "/workspaces/7", "write": True},
    ]
    env = {
        "TINA_WORKSPACE_ATTEMPT": "e" * 32,
        "TINA_WORKSPACE_STORAGE": "s3",
        "TINA_OWNER": "7",
        "TINA_UNIT_ID": uid,
        "TINA_UNIT_TRIGGER": "transcription",
        "TINA_UNIT_IN_TOPIC": f"unit:{uid}:in",
        "TINA_UNIT_OUT_TOPIC": f"unit:{uid}:out",
        "TINA_WORKSPACE_PATH": "/workspaces/7",
        "TINA_MOUNTS": json.dumps(mounts),
        "TINA_RUNNER": "claude-code",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "TINA_LLM_PROVIDER": "bedrock-converse",
        "TINA_LLM_MODEL": "us.anthropic.claude-sonnet-4-6",
        "TINA_TRANSCRIPT_STREAM": "tc:meeting:42",
        "TINA_MEETING_NUMERIC_ID": "42",
        "TINA_MEETING_ID": "abc-defg-hij",
        "TINA_MEETING_PLATFORM": "google_meet",
    }
    handle = backend.start(uid, Runnable(image=WORKER_IMAGE, command=["python", "-m", "worker"]), env)
    assert handle._impl == TASK_ARN
    overrides = ecs.run_task.call_args.kwargs["overrides"]["containerOverrides"]
    stream_override = next(o for o in overrides if o["name"] == "stream")
    stream_env = {item["name"]: item["value"] for item in stream_override["environment"]}
    assert stream_env["TINA_TRANSCRIPT_STREAM"] == "tc:meeting:42"
    assert stream_env["TINA_MEETING_NUMERIC_ID"] == "42"
    puts = {c.kwargs["Key"]: c.kwargs["Body"].decode() for c in s3.put_object.call_args_list}
    worker_env = next(v for k, v in puts.items() if "/workspace/7/" in k)
    assert "TINA_TRANSCRIPT_STREAM=tc:meeting:42" in worker_env
    assert "TINA_LLM_PROVIDER=bedrock-converse" in worker_env
