import json
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from runtime_kernel.ecs_backend import ECSBackend
from runtime_kernel.models import Resources
from runtime_kernel.profiles import Runnable


IMAGE = "example.invalid/tina/bot@sha256:" + "a" * 64
DEFINITION = "arn:aws:ecs:us-east-1:123456789012:task-definition/tina-bot:4"
TASK = "arn:aws:ecs:us-east-1:123456789012:task/tina/test"
ENV = {"TINA_BOT_CONFIG": '{"token":"private-invocation"}'}


@pytest.fixture
def backend():
    ecs = Mock()
    ecs.describe_task_definition.return_value = {"taskDefinition": {
        "requiresCompatibilities": ["FARGATE"], "networkMode": "awsvpc",
        "cpu": "2048", "memory": "4096",
        "containerDefinitions": [{"name": "bot", "image": IMAGE}],
    }}
    ecs.run_task.return_value = {"tasks": [{"taskArn": TASK, "lastStatus": "PROVISIONING"}]}
    return ECSBackend(ecs=ecs, s3=Mock(), cluster="tina", task_definition=DEFINITION,
                      subnets=["subnet-test"], security_groups=["sg-test"], bucket="private-test")


def test_spawn_keeps_invocation_out_of_ecs_and_is_idempotent(backend):
    assert backend.start("mtg-test", Runnable(image=IMAGE), ENV)._impl == TASK
    stored = backend.s3.put_object.call_args.kwargs
    assert stored["Body"] == b'TINA_BOT_CONFIG={"token":"private-invocation"}\n'
    assert stored["IfNoneMatch"] == "*" and stored["ServerSideEncryption"] == "AES256"
    request = backend.ecs.run_task.call_args.kwargs
    assert "private-invocation" not in json.dumps(request)
    assert request["networkConfiguration"]["awsvpcConfiguration"]["assignPublicIp"] == "DISABLED"
    assert request["overrides"]["containerOverrides"][0]["environmentFiles"] == [
        {"type": "s3", "value": f'arn:aws:s3:::private-test/{stored["Key"]}'},
    ]
    backend.s3.put_object.side_effect = ClientError({"Error": {"Code": "412"}}, "PutObject")
    backend.s3.head_object.return_value = {"Metadata": stored["Metadata"]}
    assert backend.start("mtg-test", Runnable(image=IMAGE), ENV)._impl == TASK
    assert backend.ecs.run_task.call_args.kwargs == request
    with pytest.raises(ValueError, match="different invocation"):
        backend.start("mtg-test", Runnable(image=IMAGE), {"TINA_BOT_CONFIG": "{}"})
    assert backend.ecs.run_task.call_count == 2


def test_reject_out_of_scope_before_write(backend):
    for runnable, env, resources in (
        (Runnable(image=IMAGE, command=["python"]), ENV, None),
        (Runnable(image="other"), ENV, None),
        (Runnable(image=IMAGE), ENV, Resources(gpu=1)),
        (Runnable(image=IMAGE), {"TINA_BOT_CONFIG": "x\nUNEXPECTED=1"}, None),
    ):
        with pytest.raises(ValueError):
            backend.start("mtg-test", runnable, env, resources)
    backend.s3.put_object.assert_not_called()


def test_draft_uses_separate_task_and_never_accepts_mounts(backend):
    backend.draft_task_definition = DEFINITION.replace("tina-bot", "tina-draft")
    backend.draft_security_group = "sg-draft"
    backend.draft_image = IMAGE.replace("/bot@", "/draft@")
    backend.draft_cpu, backend.draft_memory = 512, 1024
    session = "meeting-knowledge-" + "a" * 32
    workload_id = f"agent-1-chat-{session}"
    runnable = Runnable(image=backend.draft_image, command=["python", "-m", "worker"])
    env = {
        "TINA_POST_MEETING_DRAFT": "1", "TINA_START": '{"entrypoint":{"inline":"fixture"}}',
        "TINA_CHAT_SESSION": session, "TINA_UNIT_OUT_TOPIC": f"unit:{workload_id}:out",
    }
    with pytest.raises(ValueError, match="source-only"):
        backend.start(workload_id, runnable, env | {"TINA_MOUNTS": "[]"})
    backend.s3.put_object.assert_not_called()
    assert backend.start(workload_id, runnable, env)._impl == TASK
    request = backend.ecs.run_task.call_args.kwargs
    assert request["taskDefinition"] == backend.draft_task_definition
    assert request["networkConfiguration"]["awsvpcConfiguration"]["securityGroups"] == ["sg-draft"]
    assert request["overrides"]["containerOverrides"][0]["name"] == "draft"
    assert backend.s3.put_object.call_args.kwargs["Key"].startswith("runtime-invocations/draft/")


def test_recovers_managed_task_and_removes_env_only_after_stop(backend):
    task = {"taskArn": TASK, "lastStatus": "RUNNING", "containers": [],
            "tags": [{"key": "tina:runtime-workload", "value": "mtg-test"}]}
    backend.ecs.get_paginator.return_value.paginate.return_value = [{"taskArns": [TASK]}]
    backend.ecs.describe_tasks.return_value = {"tasks": [task]}
    handle = backend.find("mtg-test")
    assert handle and handle._impl == TASK
    assert backend.list_workload_containers() == [
        {"workload_id": "mtg-test", "name": TASK, "running": True, "exit_code": None},
    ]
    with pytest.raises(RuntimeError, match="stopping"):
        backend.cleanup(handle)
    backend.s3.delete_object.assert_not_called()
    backend.ecs.stop_task.assert_called_once()
    task.update(lastStatus="STOPPED", containers=[{"name": "bot", "exitCode": 0}])
    assert backend.exit_code(handle) == 0
    backend.cleanup(handle)
    backend.s3.delete_object.assert_called_once_with(Bucket="private-test", Key=backend._key("mtg-test"))


def test_workspace_placement_failure_cleans_only_the_declined_invocation(backend):
    from runtime_kernel.workspace_tasks import WorkspaceTask

    uid = "agent-11-chat-smoke"
    mounts = {"/workspaces/11": True, "/workspaces/_system/11": True}
    backend.workspace_tasks = [WorkspaceTask("11", DEFINITION, "sg-test", IMAGE, 1024, 2048, mounts)]
    runnable = Runnable(image=IMAGE, command=["python", "-m", "worker"])
    env = {
        "TINA_WORKSPACE_ATTEMPT": "a" * 32, "TINA_OWNER": "11", "TINA_UNIT_ID": uid,
        "TINA_CHAT_SESSION": "smoke", "TINA_UNIT_TRIGGER": "message",
        "TINA_UNIT_IN_TOPIC": f"unit:{uid}:in", "TINA_UNIT_OUT_TOPIC": f"unit:{uid}:out",
        "TINA_WORKSPACE_PATH": "/workspaces/11", "TINA_RUNNER": "codex",
        "TINA_CODEX_AUTH_MODE": "chatgpt-plan",
        "TINA_MOUNTS": json.dumps([{"path": p, "write": w} for p, w in mounts.items()]),
    }
    backend.ecs.run_task.return_value = {"failures": [{"reason": "RESOURCE:CPU"}], "tasks": []}
    with pytest.raises(RuntimeError, match="did not accept"):
        backend.start(uid, runnable, env)
    key = backend.s3.put_object.call_args.kwargs["Key"]
    assert key.startswith("runtime-invocations/workspace/11/")
    backend.s3.delete_object.assert_called_once_with(Bucket="private-test", Key=key)
    backend.s3.delete_object.reset_mock()
    backend.ecs.run_task.side_effect = TimeoutError
    with pytest.raises(TimeoutError):
        backend.start(uid, runnable, env)
    backend.s3.delete_object.assert_not_called()
