"""On-demand EFS Access Points and Fargate task definitions for staging workspaces (EFS fallback)."""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import os
import re
import threading
import time
from typing import Any

from botocore.exceptions import ClientError

from .workspace_tasks import WorkspaceTask


_RESERVED_SHARED_SLUGS = frozenset({"_system", "_attached", "_global", "system", "global", "sys"})


def validate_dynamic_mounts(owner: str, mounts: dict[str, bool], cwd: str) -> None:
    """Enforce strict per-subject path boundaries before provisioning EFS or S3 workspace mounts."""
    if not re.fullmatch(r"[1-9][0-9]*", owner):
        raise ValueError("Invalid workspace owner")
    if not mounts:
        raise ValueError("Workspace mounts cannot be empty")
    system = f"/workspaces/_system/{owner}"
    home = f"/workspaces/{owner}"
    if mounts.get(system) is not True:
        raise ValueError("Writable private continuity mount is required")
    if cwd not in mounts:
        raise ValueError("Worker current directory is outside approved mounts")
    attached_re = re.compile(rf"/workspaces/_attached/{re.escape(owner)}/[A-Za-z0-9][A-Za-z0-9._-]{{0,120}}")
    shared_re = re.compile(r"/workspaces/([A-Za-z][A-Za-z0-9._-]{0,120})")
    for path, write in mounts.items():
        if type(write) is not bool:
            raise ValueError("Workspace mount write flag must be boolean")
        if not path.startswith("/workspaces/") or "//" in path or path.endswith("/"):
            raise ValueError("Invalid workspace mount path")
        parts = path.split("/")[1:]
        if any(not part or part.startswith(".") or part == ".." for part in parts):
            raise ValueError("Workspace mounts forbid dot-prefixed or traversal components")
        if path in (system, home):
            continue
        if attached_re.fullmatch(path):
            continue
        match = shared_re.fullmatch(path)
        if match and match.group(1) not in _RESERVED_SHARED_SLUGS:
            continue
        raise ValueError(f"Workspace mount path is outside subject {owner}'s allowed scope")


@dataclass(frozen=True)
class DynamicWorkspaceConfig:
    efs_id: str
    worker_image: str
    task_role_arn: str
    exec_role_arn: str
    security_group: str
    log_group: str
    valkey_host: str
    valkey_secret_arn: str
    region: str = "us-east-1"
    family_prefix: str = "tina-staging-ws"
    cpu: int = 1024
    memory: int = 2048

    @classmethod
    def from_env(cls) -> DynamicWorkspaceConfig | None:
        efs_id = (os.environ.get("RUNTIME_ECS_WORKSPACE_EFS_ID") or "").strip()
        if not efs_id:
            return None
        image = (os.environ.get("RUNTIME_ECS_WORKSPACE_IMAGE") or "").strip()
        task_role = (os.environ.get("RUNTIME_ECS_WORKSPACE_TASK_ROLE_ARN") or "").strip()
        exec_role = (os.environ.get("RUNTIME_ECS_WORKSPACE_EXEC_ROLE_ARN") or "").strip()
        sg = (os.environ.get("RUNTIME_ECS_WORKSPACE_SECURITY_GROUP") or "").strip()
        log_group = (os.environ.get("RUNTIME_ECS_WORKSPACE_LOG_GROUP") or "").strip()
        valkey_host = (os.environ.get("RUNTIME_ECS_WORKSPACE_VALKEY_HOST") or os.environ.get("VALKEY_HOST") or "").strip()
        valkey_secret = (os.environ.get("RUNTIME_ECS_WORKSPACE_VALKEY_SECRET_ARN") or "").strip()
        if not all((efs_id, image, task_role, exec_role, sg, log_group, valkey_host, valkey_secret)):
            raise ValueError("Incomplete dynamic ECS workspace configuration")
        if not re.fullmatch(r"fs-[a-f0-9]+", efs_id) or not re.fullmatch(r"sg-[a-f0-9]+", sg):
            raise ValueError("Invalid dynamic workspace EFS or security group ID")
        if not re.search(r"@sha256:[0-9a-f]{64}$", image):
            raise ValueError("Dynamic workspace worker requires an immutable image digest")
        region = (os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "").strip()
        if not region:
            parts = valkey_secret.split(":")
            region = parts[3] if len(parts) > 3 and parts[3] else "us-east-1"
        family_prefix = (os.environ.get("RUNTIME_ECS_WORKSPACE_FAMILY_PREFIX") or "tina-staging-ws").strip()
        return cls(
            efs_id=efs_id, worker_image=image, task_role_arn=task_role, exec_role_arn=exec_role,
            security_group=sg, log_group=log_group, valkey_host=valkey_host,
            valkey_secret_arn=valkey_secret, region=region, family_prefix=family_prefix,
        )


class DynamicWorkspaceProvisioner:
    """Caches and provisions per-mount EFS Access Points and Fargate task definitions."""

    def __init__(self, *, ecs: Any, efs: Any, config: DynamicWorkspaceConfig, sleep=time.sleep) -> None:
        self.ecs = ecs
        self.efs = efs
        self.config = config
        self._sleep = sleep
        self._lock = threading.Lock()
        self._ap_cache: dict[str, str] = {}
        self._task_cache: dict[str, WorkspaceTask] = {}

    def _family_for(self, owner: str, mounts: dict[str, bool]) -> str:
        payload = json.dumps({
            "owner": owner, "mounts": sorted(mounts.items()),
            "image": self.config.worker_image, "task_role": self.config.task_role_arn,
            "exec_role": self.config.exec_role_arn, "log_group": self.config.log_group,
            "valkey_host": self.config.valkey_host, "valkey_secret": self.config.valkey_secret_arn,
            "cpu": self.config.cpu, "memory": self.config.memory,
        }, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(payload.encode()).hexdigest()[:12]
        return f"{self.config.family_prefix}-u{owner}-{digest}"

    def _refresh_access_points(self) -> None:
        token: str | None = None
        while True:
            kwargs: dict[str, Any] = {"FileSystemId": self.config.efs_id}
            if token:
                kwargs["NextToken"] = token
            page = self.efs.describe_access_points(**kwargs)
            for ap in page.get("AccessPoints", []):
                if ap.get("LifeCycleState") != "available":
                    continue
                posix = ap.get("PosixUser") or {}
                root = (ap.get("RootDirectory") or {}).get("Path")
                if posix.get("Uid") == 1000 and posix.get("Gid") == 1000 and isinstance(root, str):
                    self._ap_cache[root] = ap["AccessPointId"]
            token = page.get("NextToken")
            if not token:
                break

    def _ensure_access_point(self, path: str) -> str:
        if path in self._ap_cache:
            return self._ap_cache[path]
        self._refresh_access_points()
        if path in self._ap_cache:
            return self._ap_cache[path]
        client_token = hashlib.sha256(f"{self.config.efs_id}:1000:1000:{path}".encode()).hexdigest()[:64]
        try:
            created = self.efs.create_access_point(
                ClientToken=client_token,
                FileSystemId=self.config.efs_id,
                PosixUser={"Uid": 1000, "Gid": 1000},
                RootDirectory={
                    "Path": path,
                    "CreationInfo": {"OwnerUid": 1000, "OwnerGid": 1000, "Permissions": "0700"},
                },
                Tags=[
                    {"Key": "Name", "Value": f"tina-ws-{hashlib.sha256(path.encode()).hexdigest()[:12]}"},
                    {"Key": "tina:managed", "Value": "dynamic-workspace"},
                ],
            )
            ap_id = created["AccessPointId"]
            state = created.get("LifeCycleState")
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") != "AccessPointAlreadyExists":
                raise
            ap_id = exc.response.get("AccessPointId")
            if not ap_id:
                self._refresh_access_points()
                if path in self._ap_cache:
                    return self._ap_cache[path]
                raise
            state = None
        for _ in range(40):
            if state == "available":
                break
            self._sleep(0.5)
            resp = self.efs.describe_access_points(AccessPointId=ap_id)
            aps = resp.get("AccessPoints") or []
            state = aps[0].get("LifeCycleState") if aps else None
        if state != "available":
            raise RuntimeError(f"EFS access point {ap_id} for {path} did not become available")
        self._ap_cache[path] = ap_id
        return ap_id

    def _try_existing_definition(self, family: str, owner: str, mounts: dict[str, bool]) -> WorkspaceTask | None:
        try:
            td = self.ecs.describe_task_definition(taskDefinition=family)["taskDefinition"]
        except ClientError:
            return None
        if td.get("status") != "ACTIVE":
            return None
        if td.get("taskRoleArn") != self.config.task_role_arn or td.get("executionRoleArn") != self.config.exec_role_arn:
            return None
        containers = {c["name"]: c for c in td.get("containerDefinitions", [])}
        if set(containers) != {"worker", "stream"}:
            return None
        if containers["worker"].get("image") != self.config.worker_image or containers["stream"].get("image") != self.config.worker_image:
            return None
        actual_mounts = {mp["containerPath"]: not mp.get("readOnly", False) for mp in containers["worker"].get("mountPoints", [])}
        if actual_mounts != mounts:
            return None
        return WorkspaceTask(owner, td["taskDefinitionArn"], self.config.security_group,
                             self.config.worker_image, int(td["cpu"]), int(td["memory"]), dict(mounts))

    def ensure_task(self, owner: str, mounts: dict[str, bool], cwd: str) -> WorkspaceTask:
        validate_dynamic_mounts(owner, mounts, cwd)
        family = self._family_for(owner, mounts)
        with self._lock:
            cached = self._task_cache.get(family)
            if cached is not None:
                return cached
            existing = self._try_existing_definition(family, owner, mounts)
            if existing is not None:
                self._task_cache[family] = existing
                return existing
            volumes, mount_points = [], []
            for idx, (path, write) in enumerate(sorted(mounts.items())):
                ap_id = self._ensure_access_point(path)
                vol_name = f"m{idx}"
                volumes.append({
                    "name": vol_name,
                    "efsVolumeConfiguration": {
                        "fileSystemId": self.config.efs_id, "rootDirectory": "/",
                        "transitEncryption": "ENABLED",
                        "authorizationConfig": {"accessPointId": ap_id, "iam": "ENABLED"},
                    },
                })
                mount_points.append({"sourceVolume": vol_name, "containerPath": path, "readOnly": not write})
            log_config = {
                "logDriver": "awslogs",
                "options": {
                    "awslogs-group": self.config.log_group,
                    "awslogs-region": self.config.region,
                    "awslogs-stream-prefix": "ecs",
                },
            }
            resp = self.ecs.register_task_definition(
                family=family, networkMode="awsvpc", requiresCompatibilities=["FARGATE"],
                cpu=str(self.config.cpu), memory=str(self.config.memory),
                runtimePlatform={"cpuArchitecture": "ARM64", "operatingSystemFamily": "LINUX"},
                executionRoleArn=self.config.exec_role_arn, taskRoleArn=self.config.task_role_arn,
                volumes=volumes,
                containerDefinitions=[
                    {
                        "name": "worker", "image": self.config.worker_image, "essential": True,
                        "user": "1000:1000", "linuxParameters": {"initProcessEnabled": True},
                        "environment": [
                            {"name": "TINA_OWNER", "value": owner},
                            {"name": "HOME", "value": f"/workspaces/_system/{owner}"},
                            {"name": "TINA_WORKSPACE_PATH", "value": cwd},
                        ],
                        "dependsOn": [{"containerName": "stream", "condition": "HEALTHY"}],
                        "mountPoints": mount_points, "logConfiguration": log_config,
                    },
                    {
                        "name": "stream", "image": self.config.worker_image, "essential": True,
                        "user": "1000:1000", "readonlyRootFilesystem": True,
                        "entryPoint": ["python", "-m", "worker.workspace_stream"],
                        "environment": [
                            {"name": "TINA_OWNER", "value": owner},
                            {"name": "VALKEY_HOST", "value": self.config.valkey_host},
                        ],
                        "secrets": [{"name": "VALKEY_PASSWORD", "valueFrom": self.config.valkey_secret_arn}],
                        "healthCheck": {
                            "command": ["CMD", "python", "-c", "import socket; socket.create_connection(('127.0.0.1',8721),2).close()"],
                            "interval": 5, "timeout": 3, "retries": 5, "startPeriod": 5,
                        },
                        "logConfiguration": log_config,
                    },
                ],
            )
            td_arn = resp["taskDefinition"]["taskDefinitionArn"]
            task = WorkspaceTask(owner, td_arn, self.config.security_group,
                                 self.config.worker_image, self.config.cpu, self.config.memory, dict(mounts))
            self._task_cache[family] = task
            return task

    def list_families(self) -> list[str]:
        families = list(self._task_cache.keys())
        try:
            token: str | None = None
            prefix = f"{self.config.family_prefix}-"
            while True:
                kwargs: dict[str, Any] = {"familyPrefix": prefix, "status": "ACTIVE"}
                if token:
                    kwargs["nextToken"] = token
                page = self.ecs.list_task_definition_families(**kwargs)
                families.extend(page.get("families", []))
                token = page.get("nextToken")
                if not token:
                    break
        except Exception:
            pass
        return list(dict.fromkeys(families))
