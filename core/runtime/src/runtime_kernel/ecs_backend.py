"""Run meeting bots and source-only drafts from pinned Fargate task definitions."""
from __future__ import annotations

from dataclasses import replace
import hashlib
import json
import os
import re

from botocore.exceptions import ClientError

from .backend import WorkloadHandle
from .dynamic_workspace import DynamicWorkspaceConfig, DynamicWorkspaceProvisioner
from .models import Resources
from .profiles import Runnable
from .s3_workspace import S3WorkspaceConfig, S3WorkspaceLauncher
from .workspace_tasks import WorkspaceTask, parse_workspace_request, select_workspace


_WORKSPACE_ALLOWED_ENV_FIELDS = frozenset({
    "HOME", "TINA_OWNER", "TINA_UNIT_ID", "TINA_UNIT_TRIGGER", "TINA_UNIT_IN_TOPIC",
    "TINA_UNIT_OUT_TOPIC", "TINA_START", "TINA_MOUNTS", "TINA_WORKSPACE_PATH",
    "TINA_CHAT_SESSION", "TINA_RUNNER", "TINA_CODEX_AUTH_MODE",
    "TINA_AGENT_MODEL", "TINA_AGENT_EFFORT",
    "TINA_LLM_PROVIDER", "TINA_LLM_MODEL", "TINA_LLM_BASE_URL", "TINA_LLM_API_KEY",
    "TINA_PRINCIPAL_NAME", "TINA_PRINCIPAL_EMAIL", "TINA_AGENT_REACH_URL", "TINA_UNIT_TOOLS",
    "TINA_TRANSCRIPT_STREAM", "TINA_TRANSCRIPT_START_ID", "TINA_MEETING_ID",
    "TINA_MEETING_NUMERIC_ID", "TINA_MEETING_SESSION_UID", "TINA_MEETING_PLATFORM",
    "TINA_MEETING_MODEL",
    "ACCESS_TOKEN", "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_DEFAULT_REGION", "AWS_BEARER_TOKEN_BEDROCK",
    "GEMINI_API_KEY", "TINA_ANTIGRAVITY_AUTH_MODE", "TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED",
})


_NOVA_FIELDS = frozenset({
    "TINA_OWNER", "TINA_UNIT_ID", "TINA_UNIT_TRIGGER", "TINA_UNIT_IN_TOPIC",
    "TINA_UNIT_OUT_TOPIC", "TINA_START", "TINA_MOUNTS", "TINA_WORKSPACE_PATH",
    "TINA_CHAT_SESSION", "TINA_RUNNER", "TINA_PRINCIPAL_NAME", "TINA_PRINCIPAL_EMAIL",
    "TINA_AGENT_REACH_URL", "TINA_UNIT_TOOLS",
})
_NOVA_MODEL = "amazon.nova-lite-v1:0"


def _validate_workspace_runner(env: dict[str, str], *, allow_multi_provider: bool) -> None:
    runner = env.get("TINA_RUNNER", "")
    codex_mode = env.get("TINA_CODEX_AUTH_MODE", "")
    if runner == "codex" and codex_mode == "chatgpt-plan":
        return
    if not allow_multi_provider:
        raise ValueError("Staging workspace pilot requires the subject's ChatGPT connection")
    if runner == "codex":
        if codex_mode == "api-key" and env.get("OPENAI_API_KEY"):
            return
        if codex_mode == "groq" and env.get("TINA_LLM_API_KEY"):
            return
        raise ValueError("Staging workspace Codex runner requires valid credentials")
    if runner == "claude-code":
        if (env.get("CLAUDE_CODE_USE_BEDROCK") == "1"
                or env.get("ANTHROPIC_API_KEY")
                or env.get("ANTHROPIC_AUTH_TOKEN")
                or env.get("CLAUDE_CODE_OAUTH_TOKEN")
                or (env.get("ANTHROPIC_BASE_URL") or "").startswith("https://")):
            return
        raise ValueError("Staging workspace Claude runner requires Bedrock, API credentials, or HTTPS custom endpoint")
    if runner == "antigravity":
        if env.get("GEMINI_API_KEY"):
            return
        raise ValueError("Staging workspace Antigravity runner requires a Gemini API key")
    raise ValueError("Unsupported staging workspace runner")


_SAFE_ECS_UNIT_TOOLS = frozenset({
    "reach.web.search",
    "reach.web.read",
    "reach.github.search",
    "reach.github.read",
})


def _allowed_workspace_unit_tools(env: dict[str, str], *, native_nova: bool) -> str:
    if not (env.get("TINA_AGENT_REACH_URL") or "").strip():
        return "[]"
    try:
        requested = json.loads(env.get("TINA_UNIT_TOOLS") or "[]")
    except (TypeError, ValueError):
        return "[]"
    if not isinstance(requested, list):
        return "[]"
    granted = list(dict.fromkeys(
        name for name in requested if isinstance(name, str) and name in _SAFE_ECS_UNIT_TOOLS
    ))
    return json.dumps(granted)


def _workspace_idle_timeout_sec() -> str:
    raw = (os.environ.get("RUNTIME_WORKSPACE_IDLE_TIMEOUT_SEC") or "").strip()
    if raw.isdigit() and 60 <= int(raw) <= 3600:
        return raw
    return "300"


def _encode_dotenv(env: dict[str, str]) -> bytes:
    if any(
        not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
        or any(ch in value for ch in "\r\n\0")
        for name, value in env.items()
    ):
        raise ValueError("Fargate workload environment requires single-line dotenv values")
    return "".join(f"{name}={value}\n" for name, value in sorted(env.items())).encode()


class ECSBackend:
    name = "ecs"
    stop_poll_interval = 1.0
    _managed = "tina:runtime-workload"
    _prefix = "runtime-invocations/"

    def __init__(self, *, ecs, s3, cluster, task_definition, subnets, security_groups, bucket,
                 draft_task_definition=None, draft_security_group=None, workspace_tasks=None,
                 dynamic_workspace: DynamicWorkspaceProvisioner | None = None,
                 s3_workspace: S3WorkspaceLauncher | None = None,
                 nova_workspace: S3WorkspaceLauncher | None = None,
                 nova_owners: frozenset[str] = frozenset()):
        if not all((cluster, task_definition, subnets, security_groups, bucket)):
            raise ValueError("ECS Runtime needs a cluster, task revision, network and staging bucket")
        self.workspace_tasks = [WorkspaceTask.load(ecs, owner, spec)
                                for owner, specs in (workspace_tasks or {}).items() for spec in specs]
        self.dynamic_workspace = dynamic_workspace
        self.s3_workspace = s3_workspace
        self.nova_workspace = nova_workspace
        self.nova_owners = nova_owners
        self.ecs = ecs
        self.s3 = s3
        self.cluster = cluster
        self.task_definition = task_definition
        self.subnets = subnets
        self.security_groups = security_groups
        self.bucket = bucket
        self.image, self.cpu, self.memory = self._load_definition(task_definition, "bot")
        self.family = task_definition.split("/")[-1].split(":")[0]
        self.partition = task_definition.split(":")[1]
        self.draft_task_definition = draft_task_definition
        self.draft_security_group = draft_security_group
        if draft_task_definition:
            if not draft_security_group:
                raise ValueError("ECS draft tasks require a dedicated security group")
            self.draft_image, self.draft_cpu, self.draft_memory = self._load_definition(
                draft_task_definition, "draft",
            )

    def _load_definition(self, task_definition: str, container: str) -> tuple[str, int, int]:
        if not re.fullmatch(r"arn:[^:]+:ecs:[^:]+:[0-9]{12}:task-definition/[^:]+:[0-9]+", task_definition):
            raise ValueError("ECS Runtime needs a pinned task definition ARN")
        definition = self.ecs.describe_task_definition(taskDefinition=task_definition)["taskDefinition"]
        if "FARGATE" not in definition["requiresCompatibilities"] or definition["networkMode"] != "awsvpc":
            raise ValueError("ECS task definition must support Fargate with awsvpc")
        [entry] = definition["containerDefinitions"]
        if entry["name"] != container or not re.search(r"@sha256:[0-9a-f]{64}$", entry["image"]):
            raise ValueError("ECS Runtime needs one named container with an immutable image digest")
        if container == "draft" and (definition.get("volumes") or entry.get("mountPoints")):
            raise ValueError("ECS draft workers cannot mount a workspace")
        return entry["image"], int(definition["cpu"]), int(definition["memory"])

    @classmethod
    def from_env(cls):
        import boto3

        ecs = boto3.client("ecs")
        dyn_cfg = DynamicWorkspaceConfig.from_env()
        dynamic_workspace = (
            DynamicWorkspaceProvisioner(ecs=ecs, efs=boto3.client("efs"), config=dyn_cfg)
            if dyn_cfg is not None else None
        )
        s3_cfg = S3WorkspaceConfig.from_env()
        s3_workspace = (
            S3WorkspaceLauncher(ecs=ecs, sts=boto3.client("sts"), config=s3_cfg)
            if s3_cfg is not None else None
        )
        nova_task = os.environ.get("RUNTIME_ECS_NOVA_WORKSPACE_TASK_DEFINITION", "")
        nova_users = os.environ.get("RUNTIME_ECS_NOVA_WORKSPACE_OWNERS", "")
        nova_workspace = None
        nova_owners = frozenset()
        if nova_task or nova_users:
            if (s3_cfg is None or not re.fullmatch(r"arn:[^:]+:ecs:[^:]+:[0-9]{12}:task-definition/[^:]+:[0-9]+", nova_task)
                    or nova_task.rsplit(":", 1)[0] == s3_cfg.task_definition.rsplit(":", 1)[0]
                    or not re.fullmatch(r"[1-9][0-9]*(?:,[1-9][0-9]*)*", nova_users)):
                raise ValueError("Invalid Nova S3 workspace configuration")
            nova_owners = frozenset(nova_users.split(","))
            nova_workspace = S3WorkspaceLauncher(
                ecs=ecs, sts=boto3.client("sts"), config=replace(s3_cfg, task_definition=nova_task),
            )
        return cls(
            ecs=ecs, s3=boto3.client("s3"),
            cluster=os.environ["RUNTIME_ECS_CLUSTER"],
            task_definition=os.environ["RUNTIME_ECS_BOT_TASK_DEFINITION"],
            subnets=os.environ["RUNTIME_ECS_SUBNETS"].split(","),
            security_groups=os.environ["RUNTIME_ECS_SECURITY_GROUPS"].split(","),
            bucket=os.environ["RUNTIME_ECS_INVOCATION_BUCKET"],
            draft_task_definition=os.environ.get("RUNTIME_ECS_DRAFT_TASK_DEFINITION"),
            draft_security_group=os.environ.get("RUNTIME_ECS_DRAFT_SECURITY_GROUP"),
            workspace_tasks=json.loads(os.environ.get("RUNTIME_ECS_WORKSPACE_TASKS") or "{}"),
            dynamic_workspace=dynamic_workspace,
            s3_workspace=s3_workspace,
            nova_workspace=nova_workspace,
            nova_owners=nova_owners,
        )

    def _token(self, workload_id: str) -> str:
        return hashlib.sha256(f"{self.family}/{workload_id}".encode()).hexdigest()

    def _key(self, workload_id: str, *, draft=False) -> str:
        folder = "draft/" if draft else ""
        return f"{self._prefix}{folder}{self._token(workload_id)}.env"

    def _put_env_file(self, key: str, payload: bytes) -> None:
        checksum = hashlib.sha256(payload).hexdigest()
        try:
            self.s3.put_object(
                Bucket=self.bucket, Key=key, Body=payload, ServerSideEncryption="AES256",
                IfNoneMatch="*", Metadata={"sha256": checksum},
            )
        except ClientError as error:
            if error.response["Error"]["Code"] not in {"PreconditionFailed", "412"}:
                raise
            metadata = self.s3.head_object(Bucket=self.bucket, Key=key)["Metadata"]
            if metadata.get("sha256") != checksum:
                raise ValueError("ECS workload ID already has a different invocation") from error

    def start(self, workload_id: str, runnable: Runnable, env: dict[str, str],
              resources: Resources | None = None) -> WorkloadHandle:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", workload_id):
            raise ValueError("Invalid ECS workload ID")
        attempt_token = self._token(workload_id)
        sidecar = []
        sync_key: str | None = None
        sync_payload: bytes | None = None
        if env.get("TINA_WORKSPACE_ATTEMPT"):
            allow_multi = self.dynamic_workspace is not None or self.s3_workspace is not None
            native_nova = env.get("TINA_RUNNER") == "bedrock-workspace"
            if not native_nova:
                _validate_workspace_runner(env, allow_multi_provider=allow_multi)
            use_s3 = (
                self.s3_workspace is not None
                and (env.get("TINA_WORKSPACE_STORAGE") == "s3"
                     or os.environ.get("RUNTIME_ECS_WORKSPACE_STORAGE") == "s3")
            )
            launcher = self.s3_workspace
            if native_nova:
                if (not use_s3 or self.nova_workspace is None or env.get("TINA_OWNER") not in self.nova_owners
                        or env.get("TINA_UNIT_TRIGGER") != "message" or env.get("TINA_AGENT_MODEL") != _NOVA_MODEL):
                    raise ValueError("Nova is not authorized for this S3 workspace chat")
                launcher = self.nova_workspace
            attempt_hex = env["TINA_WORKSPACE_ATTEMPT"]
            attempt_token = hashlib.sha256((workload_id + "/" + attempt_hex).encode()).hexdigest()
            if use_s3:
                owner, mounts, cwd = parse_workspace_request(workload_id, env)
                task, sync_env = launcher.prepare(
                    owner=owner, mounts=mounts, cwd=cwd, workload_id=workload_id,
                    attempt_hex=attempt_hex, mounts_json=env["TINA_MOUNTS"],
                )
                if (not native_nova and runnable.image != task.image) or runnable.command != ["python", "-m", "worker"]:
                    raise ValueError("Unexpected workspace worker profile")
                definition, container = task.definition, "worker"
                security_groups, cpu, memory = [task.group], task.cpu, task.memory
                key = f"{self._prefix}workspace/{task.owner}/{attempt_token}.env"
                sync_key = f"{self._prefix}workspace-sync/{task.owner}/{attempt_token}.env"
                sync_payload = _encode_dotenv(sync_env)
                stream_env = [
                    {"name": "TINA_OWNER", "value": task.owner},
                    {"name": "TINA_UNIT_ID", "value": workload_id},
                ]
                if env.get("TINA_UNIT_TRIGGER") == "transcription":
                    stream_env.extend([
                        {"name": "TINA_TRANSCRIPT_STREAM", "value": env["TINA_TRANSCRIPT_STREAM"]},
                        {"name": "TINA_MEETING_NUMERIC_ID", "value": env["TINA_MEETING_NUMERIC_ID"]},
                    ])
                sidecar = [
                    {"name": "stream", "environment": stream_env},
                    {"name": "sync", "environmentFiles": [
                        {"type": "s3", "value": f"arn:{self.partition}:s3:::{self.bucket}/{sync_key}"},
                    ]},
                ]
                env = {k: v for k, v in env.items() if k in _WORKSPACE_ALLOWED_ENV_FIELDS and v != ""}
                if native_nova:
                    env = {k: v for k, v in env.items() if k in _NOVA_FIELDS}
                    env["TINA_AGENT_MODEL"] = _NOVA_MODEL
                env.setdefault("HOME", f"/workspaces/_system/{task.owner}")
                if env.get("TINA_RUNNER") == "codex" and env.get("TINA_CODEX_AUTH_MODE") == "chatgpt-plan":
                    env.setdefault("TINA_AGENT_MODEL", "gpt-6-luna")
                unit_tools = _allowed_workspace_unit_tools(env, native_nova=native_nova)
                env.update(TINA_IDLE_TIMEOUT_SEC=_workspace_idle_timeout_sec(), TINA_WORKSPACE_STREAM_SIDECAR="1",
                           TINA_WORKSPACE_SYNC_SIDECAR="1", TINA_UNIT_TOOLS=unit_tools)
            else:
                if env.get("TINA_UNIT_TRIGGER") == "transcription":
                    raise ValueError("Live meeting workspace tasks require S3 ephemeral storage")
                use_pinned = env.get("CLAUDE_CODE_USE_BEDROCK") != "1"
                task = None
                if use_pinned:
                    try:
                        task = select_workspace(self.workspace_tasks, workload_id, env)
                    except ValueError:
                        if self.dynamic_workspace is None:
                            raise
                if task is None:
                    owner, mounts, cwd = parse_workspace_request(workload_id, env)
                    if self.dynamic_workspace is None:
                        raise ValueError("No pinned workspace task matches the current grants")
                    task = self.dynamic_workspace.ensure_task(owner, mounts, cwd)
                if runnable.image != task.image or runnable.command != ["python", "-m", "worker"]:
                    raise ValueError("Unexpected workspace worker profile")
                definition, container = task.definition, "worker"
                security_groups, cpu, memory = [task.group], task.cpu, task.memory
                key = f"{self._prefix}workspace/{task.owner}/{attempt_token}.env"
                sidecar = [{"name": "stream", "environment": [{"name": "TINA_UNIT_ID", "value": workload_id}]}]
                env = {k: v for k, v in env.items() if k in _WORKSPACE_ALLOWED_ENV_FIELDS and v != ""}
                if env.get("TINA_RUNNER") == "codex" and env.get("TINA_CODEX_AUTH_MODE") == "chatgpt-plan":
                    env.setdefault("TINA_AGENT_MODEL", "gpt-6-luna")
                env.update(TINA_IDLE_TIMEOUT_SEC=_workspace_idle_timeout_sec(),
                           TINA_WORKSPACE_STREAM_SIDECAR="1", TINA_UNIT_TOOLS="[]")
        elif env.get("TINA_POST_MEETING_DRAFT") == "1":
            required = {"TINA_POST_MEETING_DRAFT", "TINA_START", "TINA_CHAT_SESSION", "TINA_UNIT_OUT_TOPIC"}
            if (not self.draft_task_definition or runnable.image != self.draft_image
                    or runnable.command != ["python", "-m", "worker"] or env.keys() != required
                    or env["TINA_UNIT_OUT_TOPIC"] != f"unit:{workload_id}:out"
                    or not re.fullmatch(r"meeting-knowledge-[0-9a-f]{32}", env["TINA_CHAT_SESSION"])
                    or not workload_id.endswith("-chat-" + env["TINA_CHAT_SESSION"])
                    or len(env["TINA_START"].encode()) > 120_000):
                raise ValueError("ECS Runtime requires a bounded source-only draft invocation")
            definition, container = self.draft_task_definition, "draft"
            security_groups = [self.draft_security_group]
            cpu, memory = self.draft_cpu, self.draft_memory
        else:
            if runnable.image != self.image or runnable.command or "TINA_BOT_CONFIG" not in env:
                raise ValueError("ECS Runtime supports the provisioned meeting-bot image only")
            definition, container = self.task_definition, "bot"
            security_groups = self.security_groups
            cpu, memory = self.cpu, self.memory
        if resources and (resources.gpu or (resources.cpu or 0) * 1024 > cpu
                          or (resources.memoryMb or 0) > memory):
            raise ValueError("Requested resources exceed the pinned Fargate task size")
        payload = _encode_dotenv(env)
        if container != "worker":
            key = self._key(workload_id, draft=container == "draft")
        self._put_env_file(key, payload)
        if sync_key and sync_payload is not None:
            self._put_env_file(sync_key, sync_payload)
        response = self.ecs.run_task(
            cluster=self.cluster, taskDefinition=definition,
            launchType="FARGATE", platformVersion="1.4.0", count=1,
            clientToken=attempt_token, startedBy=self._token(workload_id)[:32],
            networkConfiguration={"awsvpcConfiguration": {
                "subnets": self.subnets, "securityGroups": security_groups, "assignPublicIp": "DISABLED",
            }},
            overrides={"containerOverrides": [{"name": container, "environmentFiles": [
                {"type": "s3", "value": f"arn:{self.partition}:s3:::{self.bucket}/{key}"},
            ]}, *sidecar]},
            tags=[{"key": self._managed, "value": workload_id}],
        )
        if container == "worker" and response.get("failures") and not response.get("tasks"):
            self.s3.delete_object(Bucket=self.bucket, Key=key)
            if sync_key:
                self.s3.delete_object(Bucket=self.bucket, Key=sync_key)
        if response.get("failures") or len(response.get("tasks", [])) != 1:
            raise RuntimeError(f"ECS did not accept the {container} task")
        task = response["tasks"][0]
        if task["lastStatus"] == "STOPPED":
            raise RuntimeError("ECS workload has finished; use a new workload ID")
        return WorkloadHandle(workload_id, task["taskArn"])

    def _describe(self, names: list[str], *, tags=False):
        if names:
            options = {"include": ["TAGS"]} if tags else {}
            response = self.ecs.describe_tasks(cluster=self.cluster, tasks=names, **options)
            if any(failure.get("reason") != "MISSING" for failure in response.get("failures", [])):
                raise RuntimeError("ECS could not describe the workload")
            return response["tasks"]
        return []

    @staticmethod
    def _exit_code(task):
        if task["lastStatus"] != "STOPPED":
            return None
        return next((c.get("exitCode", 1) for c in task["containers"] if c["name"] in {"bot", "draft", "worker"}), 1)

    def exit_code(self, handle: WorkloadHandle) -> int | None:
        tasks = self._describe([handle._impl])
        return self._exit_code(tasks[0]) if tasks else None

    def _discover(self, **filters):
        paginator = self.ecs.get_paginator("list_tasks")
        for page in paginator.paginate(cluster=self.cluster, **filters):
            yield from self._describe(page["taskArns"], tags=True)

    def find(self, workload_id: str) -> WorkloadHandle | None:
        for item in self._discover(startedBy=self._token(workload_id)[:32]):
            if {"key": self._managed, "value": workload_id} in item.get("tags", []):
                return WorkloadHandle(workload_id, item["taskArn"])
        return None

    def list_workload_containers(self) -> list[dict]:
        workloads = []
        families = [self.family]
        if self.draft_task_definition:
            families.append(self.draft_task_definition.rsplit("/", 1)[1].split(":")[0])
        families.extend(task.definition.rsplit("/", 1)[1].split(":")[0] for task in self.workspace_tasks)
        if self.dynamic_workspace is not None:
            families.extend(self.dynamic_workspace.list_families())
        if self.s3_workspace is not None:
            families.append(self.s3_workspace.family)
        if self.nova_workspace is not None:
            families.append(self.nova_workspace.family)
        for task in (item for family in dict.fromkeys(families) for item in self._discover(family=family)):
            tags = {tag["key"]: tag["value"] for tag in task.get("tags", [])}
            if self._managed in tags:
                code = self._exit_code(task)
                workloads.append({
                    "workload_id": tags[self._managed], "name": task["taskArn"],
                    "running": code is None, "exit_code": code,
                })
        return workloads

    def terminate(self, handle: WorkloadHandle) -> None:
        self.ecs.stop_task(cluster=self.cluster, task=handle._impl, reason="TINA workload stop")

    def kill(self, handle: WorkloadHandle) -> None:
        # StopTask sends SIGTERM and ECS enforces the task definition's stopTimeout.
        self.terminate(handle)
        if self.exit_code(handle) is None:
            raise RuntimeError("ECS has not confirmed task termination yet")

    def cleanup(self, handle: WorkloadHandle) -> None:
        tasks = self._describe([handle._impl])
        if not tasks or self._exit_code(tasks[0]) is None:
            self.terminate(handle)
            raise RuntimeError("ECS task is stopping; retry cleanup after it has stopped")
        if any(c["name"] == "worker" for c in tasks[0]["containers"]):
            overrides = tasks[0].get("overrides", {}).get("containerOverrides", [])
            prefix = f"arn:{self.partition}:s3:::{self.bucket}/"
            for entry in overrides:
                if entry.get("name") not in ("worker", "sync"):
                    continue
                for env_file in entry.get("environmentFiles", []):
                    val = env_file.get("value", "")
                    key = val.removeprefix(prefix)
                    if val.startswith(prefix) and re.fullmatch(
                        r"runtime-invocations/workspace(?:-sync)?/[1-9][0-9]*/[0-9a-f]{64}\.env", key,
                    ):
                        self.s3.delete_object(Bucket=self.bucket, Key=key)
            return
        draft = any(container["name"] == "draft" for container in tasks[0]["containers"])
        self.s3.delete_object(Bucket=self.bucket, Key=self._key(handle.id, draft=draft))
