"""Run meeting bots and source-only drafts from pinned Fargate task definitions."""
from __future__ import annotations

import hashlib
import json
import os
import re

from botocore.exceptions import ClientError

from .backend import WorkloadHandle
from .models import Resources
from .profiles import Runnable
from .workspace_tasks import WorkspaceTask, select_workspace


class ECSBackend:
    name = "ecs"
    stop_poll_interval = 1.0
    _managed = "tina:runtime-workload"
    _prefix = "runtime-invocations/"

    def __init__(self, *, ecs, s3, cluster, task_definition, subnets, security_groups, bucket,
                 draft_task_definition=None, draft_security_group=None, workspace_tasks=None):
        if not all((cluster, task_definition, subnets, security_groups, bucket)):
            raise ValueError("ECS Runtime needs a cluster, task revision, network and staging bucket")
        self.workspace_tasks = [WorkspaceTask.load(ecs, owner, spec)
                                for owner, specs in (workspace_tasks or {}).items() for spec in specs]
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

        return cls(
            ecs=boto3.client("ecs"), s3=boto3.client("s3"),
            cluster=os.environ["RUNTIME_ECS_CLUSTER"],
            task_definition=os.environ["RUNTIME_ECS_BOT_TASK_DEFINITION"],
            subnets=os.environ["RUNTIME_ECS_SUBNETS"].split(","),
            security_groups=os.environ["RUNTIME_ECS_SECURITY_GROUPS"].split(","),
            bucket=os.environ["RUNTIME_ECS_INVOCATION_BUCKET"],
            draft_task_definition=os.environ.get("RUNTIME_ECS_DRAFT_TASK_DEFINITION"),
            draft_security_group=os.environ.get("RUNTIME_ECS_DRAFT_SECURITY_GROUP"),
            workspace_tasks=json.loads(os.environ.get("RUNTIME_ECS_WORKSPACE_TASKS") or "{}"),
        )

    def _token(self, workload_id: str) -> str:
        return hashlib.sha256(f"{self.family}/{workload_id}".encode()).hexdigest()

    def _key(self, workload_id: str, *, draft=False) -> str:
        folder = "draft/" if draft else ""
        return f"{self._prefix}{folder}{self._token(workload_id)}.env"

    def start(self, workload_id: str, runnable: Runnable, env: dict[str, str],
              resources: Resources | None = None) -> WorkloadHandle:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", workload_id):
            raise ValueError("Invalid ECS workload ID")
        attempt_token = self._token(workload_id)
        sidecar = []
        if env.get("TINA_WORKSPACE_ATTEMPT"):
            task = select_workspace(self.workspace_tasks, workload_id, env)
            if runnable.image != task.image or runnable.command != ["python", "-m", "worker"]:
                raise ValueError("Unexpected workspace worker profile")
            if env.get("TINA_RUNNER") != "codex" or env.get("TINA_CODEX_AUTH_MODE") != "chatgpt-plan":
                raise ValueError("Staging workspace pilot requires the subject's ChatGPT connection")
            definition, container = task.definition, "worker"
            security_groups, cpu, memory = [task.group], task.cpu, task.memory
            attempt_token = hashlib.sha256((workload_id + "/" + env["TINA_WORKSPACE_ATTEMPT"]).encode()).hexdigest()
            key = f"{self._prefix}workspace/{task.owner}/{attempt_token}.env"
            sidecar = [{"name": "stream", "environment": [{"name": "TINA_UNIT_ID", "value": workload_id}]}]
            # Only the native harness's short-lived account token crosses into this worker.
            fields = {"TINA_OWNER", "TINA_UNIT_ID", "TINA_UNIT_TRIGGER", "TINA_UNIT_IN_TOPIC",
                      "TINA_UNIT_OUT_TOPIC", "TINA_START", "TINA_MOUNTS", "TINA_WORKSPACE_PATH",
                      "TINA_CHAT_SESSION", "TINA_RUNNER", "TINA_CODEX_AUTH_MODE",
                      "TINA_PRINCIPAL_NAME", "TINA_PRINCIPAL_EMAIL", "ACCESS_TOKEN"}
            env = {k: v for k, v in env.items() if k in fields}
            env.update(TINA_AGENT_MODEL="gpt-6-luna", TINA_IDLE_TIMEOUT_SEC="120",
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
        if any(
            not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name)
            or any(ch in value for ch in "\r\n\0")
            for name, value in env.items()
        ):
            raise ValueError("Fargate workload environment requires single-line dotenv values")
        payload = "".join(f"{name}={value}\n" for name, value in sorted(env.items())).encode()
        if container != "worker":
            key = self._key(workload_id, draft=container == "draft")
        checksum = hashlib.sha256(payload).hexdigest()
        # ECS gets a private S3 ARN, so invocation credentials stay out of task overrides.
        # Keep the object on ambiguous submission errors: ECS could already be pulling it.
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
            worker = next(c for c in overrides if c["name"] == "worker")
            [file] = worker["environmentFiles"]
            prefix = f"arn:{self.partition}:s3:::{self.bucket}/"
            key = file["value"].removeprefix(prefix)
            if file["value"].startswith(prefix) and re.fullmatch(r"runtime-invocations/workspace/[1-9][0-9]*/[0-9a-f]{64}\.env", key):
                self.s3.delete_object(Bucket=self.bucket, Key=key)
            return
        draft = any(container["name"] == "draft" for container in tasks[0]["containers"])
        self.s3.delete_object(Bucket=self.bucket, Key=self._key(handle.id, draft=draft))
