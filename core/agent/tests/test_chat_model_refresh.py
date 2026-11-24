"""A warm chat must adopt Settings changes without mixing provider environments."""
import json

import fakeredis
import pytest
from fastapi.testclient import TestClient

from control_plane.api import create_app
from control_plane.dispatch import Dispatcher, ModelConfigRefreshError
from shared.config import load_settings
from shared.units import input_topic, output_topic

INVOCATION = {
    "identity": {"subject": "u_jane", "launcher": "user:u_jane"},
    "runner": "claude-code", "workspaces": [{"id": "u_jane", "mode": "rw"}],
    "trigger": "message", "context": {"kind": "none", "session": "same-chat"},
    "start": {"entrypoint": {"inline": "hello"}},
}


class Runtime:
    def __init__(self):
        self.state = "unknown"
        self.worker_env = None
        self.stops = 0
        self.spawns = 0

    def spawn(self, uid, profile, env):
        self.spawns += 1
        if self.state not in ("starting", "running"):
            self.worker_env = dict(env)
            self.state = "running"
        return uid

    def await_done(self, uid, timeout_sec=0.0):
        return self.state

    def stop(self, uid):
        self.stops += 1
        self.state = "stopped"


class Identity:
    def mint(self, *args):
        return "dummy-dispatch-token"


class Config:
    def __init__(self):
        self.value = {"mode": "gemini", "api_key": "gemini-secret", "model": "gemini-3.8-flash"}

    def resolve(self, subject):
        return self.value


@pytest.fixture
def stack(tmp_path):
    client = fakeredis.FakeRedis(decode_responses=True)
    runtime, config = Runtime(), Config()
    original_xadd = client.xadd
    def xadd(name, fields, *args, **kwargs):
        entry = original_xadd(name, fields, *args, **kwargs)
        if "turn" in fields and json.loads(fields["turn"]).get("type") == "stop":
            runtime.state = "stopped"  # the worker's existing serve() stop-input behavior
        return entry
    client.xadd = xadd
    dispatcher = Dispatcher(load_settings(workspaces_dir=str(tmp_path)), runtime, Identity(),
                            model_config=config, warm_stream=client)
    dispatcher._watch_delivery = lambda *args, **kwargs: None
    return dispatcher, runtime, config, client


def complete(client, uid):
    client.xadd(output_topic(uid), {"event": json.dumps({"type": "turn-complete"})})


def test_provider_changes_replace_idle_worker_before_predelivery_in_same_chat(stack):
    dispatcher, runtime, config, client = stack
    uid = dispatcher.dispatch(INVOCATION)
    assert runtime.worker_env["TINA_RUNNER"] == "antigravity"
    complete(client, uid)
    config.value = {"mode": "groq", "api_key": "groq-secret", "model": "openai/gpt-oss-20b", "effort": "high"}
    original_stop = runtime.stop

    def stop_before_new_message(workload_id):
        messages = [json.loads(fields['turn']) for _, fields in client.xrange(input_topic(uid))]
        assert sum(message.get('type') == 'message' for message in messages) == 1
        original_stop(workload_id)

    runtime.stop = stop_before_new_message
    assert dispatcher.dispatch(INVOCATION) == uid
    assert runtime.stops == 1
    assert runtime.worker_env["TINA_RUNNER"] == "codex"
    assert runtime.worker_env["TINA_AGENT_EFFORT"] == ""
    assert runtime.worker_env["GEMINI_API_KEY"] == ""
    assert runtime.worker_env["TINA_LLM_API_KEY"] == "groq-secret"
    stored = client.get(f"agent:chat-config:{uid}")
    assert len(stored) == 64 and "secret" not in stored


def test_unchanged_configuration_keeps_warm_worker_across_api_restart(stack):
    dispatcher, runtime, config, client = stack
    uid = dispatcher.dispatch(INVOCATION)
    complete(client, uid)
    restarted = Dispatcher(dispatcher.settings, runtime, Identity(), model_config=config, warm_stream=client)
    restarted._watch_delivery = lambda *args, **kwargs: None
    assert restarted.dispatch(INVOCATION) == uid
    assert runtime.stops == 0


def test_adapter_update_refreshes_warm_worker_even_when_settings_are_unchanged(stack, monkeypatch):
    dispatcher, runtime, config, client = stack
    monkeypatch.setattr("llm.model_capabilities.model_runtime_revision", lambda: "old-adapter")
    uid = dispatcher.dispatch(INVOCATION)
    complete(client, uid)
    monkeypatch.setattr("llm.model_capabilities.model_runtime_revision", lambda: "fixed-adapter")
    dispatcher.dispatch(INVOCATION)
    assert runtime.stops == 1


@pytest.mark.parametrize("changed,stops", [({"api_key": "rotated-secret"}, 1), ({"model": "gemini-3.7-flash"}, 1), ({"effort": "high"}, 0)])
def test_key_or_model_change_replaces_worker_but_ignored_effort_does_not(stack, changed, stops):
    dispatcher, runtime, config, client = stack
    uid = dispatcher.dispatch(INVOCATION)
    complete(client, uid)
    config.value.update(changed)
    dispatcher.dispatch(INVOCATION)
    assert runtime.stops == stops


def test_busy_previous_turn_is_not_killed_or_given_the_new_message(stack):
    dispatcher, runtime, config, client = stack
    uid = dispatcher.dispatch(INVOCATION)
    client.xadd(output_topic(uid), {"event": json.dumps({"type": "turn-accepted"})})
    config.value = {"mode": "groq", "api_key": "new-secret"}
    dispatcher._CONFIG_WAIT_SEC = 0
    with pytest.raises(ModelConfigRefreshError) as error:
        dispatcher.dispatch(INVOCATION)
    assert error.value.status == 409
    assert runtime.stops == 0 and client.xlen(input_topic(uid)) == 1
    assert client.get(f"agent:chat-config-lock:{uid}") is None
    complete(client, uid)
    dispatcher.dispatch(INVOCATION)
    assert runtime.stops == 1 and runtime.worker_env["TINA_RUNNER"] == "codex"


@pytest.mark.parametrize("change", ["demote", "revoke"])
def test_shared_mount_change_replaces_worker_before_next_turn(stack, monkeypatch, change):
    dispatcher, runtime, config, client = stack
    grants = [{"slug": "private", "path": "/workspaces/u_jane", "role": "private",
               "write": True, "primary": True},
              {"slug": "team", "path": "/workspaces/team", "role": "shared",
               "write": True, "primary": False}]
    monkeypatch.setattr("control_plane.dispatch.build_mount_set",
                        lambda *_: [dict(grant) for grant in grants])
    uid = dispatcher.dispatch(INVOCATION)
    complete(client, uid)
    if change == "revoke":
        grants.pop()
    else:
        grants[-1]["write"] = False
    dispatcher.dispatch(INVOCATION)
    assert runtime.stops == 1
    assert json.loads(runtime.worker_env["TINA_MOUNTS"]) == grants


def test_pre_upgrade_idle_worker_without_metadata_is_refreshed(stack):
    dispatcher, runtime, config, client = stack
    uid = "agent-u_jane-chat-same-chat"
    runtime.state = "running"
    runtime.worker_env = {"TINA_RUNNER": "old-provider"}
    complete(client, uid)
    assert dispatcher.dispatch(INVOCATION) == uid
    assert runtime.stops == 1


def test_worker_that_has_not_drained_queued_turns_is_not_force_killed(stack):
    dispatcher, runtime, config, client = stack
    uid = dispatcher.dispatch(INVOCATION)
    complete(client, uid)
    # A stop input can sit behind an earlier queued message. Keep the old worker alive;
    # the new-model prompt must not be delivered until cooperative exit is confirmed.
    client.xadd = fakeredis.FakeRedis.xadd.__get__(client)
    dispatcher._STOP_WAIT_SEC = 0
    config.value = {"mode": "groq", "api_key": "new-key"}
    with pytest.raises(ModelConfigRefreshError) as error:
        dispatcher.dispatch(INVOCATION)
    assert error.value.status == 409
    assert runtime.stops == 0 and runtime.worker_env["TINA_RUNNER"] == "antigravity"
    messages = [json.loads(fields["turn"]) for _, fields in client.xrange(input_topic(uid))]
    assert sum(message.get("type") == "message" for message in messages) == 1


def test_failed_settings_lookup_never_dispatches_another_provider(stack):
    dispatcher, runtime, config, client = stack
    def unavailable(subject):
        raise ConnectionError("identity unavailable")
    config.resolve = unavailable
    with pytest.raises(ModelConfigRefreshError):
        dispatcher.dispatch(INVOCATION)
    assert runtime.spawns == 0


def test_chat_route_surfaces_configuration_refresh_error_as_actionable_409(stack, monkeypatch):
    dispatcher, runtime, config, client = stack
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy-key")
    def busy(*args, **kwargs):
        raise ModelConfigRefreshError("The previous response is still finishing.", 409)
    dispatcher.dispatch = busy
    app = TestClient(create_app(dispatcher, stream_reader=object()))
    response = app.post("/api/chat", json={"prompt": "hi"}, headers={"X-User-Id": "u_jane"})
    assert response.status_code == 409
    assert "previous response" in response.json()["detail"]


def test_workspace_pilot_requires_separate_subject_consent(stack, monkeypatch):
    dispatcher, runtime, config, client = stack
    monkeypatch.setenv("TINA_WORKSPACE_PILOT_USER_IDS", "11,12")
    monkeypatch.setenv("TINA_CHATGPT_WORKSPACE_OWNER", "11")
    monkeypatch.setenv("TINA_CHATGPT_WORKSPACE_SECRET_ARN", "private-workspace-profile")
    monkeypatch.setenv("ACCESS_TOKEN", "ambient-test-token")
    monkeypatch.setenv("TINA_CODEX_AUTH_MODE", "chatgpt-plan")
    monkeypatch.setenv("TINA_AGENT_MODEL", "gpt-6-luna")
    def broker(*args, **kwargs):
        assert kwargs["scope"] == "workspace-agent"
        assert args[1:3] == ("private-workspace-profile", "11")
        return "workspace-test-token"
    monkeypatch.setattr("control_plane.aws_voice_chatgpt._access_token", broker)
    def invocation(owner):
        return INVOCATION | {"identity": {"subject": owner, "launcher": "user:" + owner},
                             "workspaces": [{"id": owner, "mode": "rw"}]}
    for owner, status in [("12", 409), ("13", 403)]:
        with pytest.raises(ModelConfigRefreshError) as exc:
            dispatcher.dispatch(invocation(owner))
        assert exc.value.status == status
    assert runtime.spawns == 0
    dispatcher.dispatch(invocation("11"))
    assert runtime.worker_env["ACCESS_TOKEN"] == "workspace-test-token"
    assert runtime.worker_env["TINA_AGENT_MODEL"] == "gpt-6-luna"
