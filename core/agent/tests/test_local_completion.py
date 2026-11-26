"""Tests for the stateless local completion pool (P2a: polish, translate, knowledge, discussion)."""
from __future__ import annotations

import json
import subprocess
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from control_plane import local_completion, meeting_voice_completion
from shared.units import DICTATION_POLISH_PREFIX, DICTATION_TRANSLATE_PREFIX
from worker.local_completion import run_job


def test_worker_local_completion_runs_polish_and_translate_preserving_error_metadata(monkeypatch):
    from worker import engine

    monkeypatch.setenv("TINA_CHAT_SESSION", "dictation-polish-req1")
    monkeypatch.setattr(
        engine, "completion_from_env",
        lambda **_: SimpleNamespace(complete=lambda prompt, **kw: SimpleNamespace(text="Edited text.")),
    )
    inline_polish = DICTATION_POLISH_PREFIX + json.dumps({"request_id": "req1", "text": "uh edited text"})
    result = run_job("polish", inline_polish)
    assert result == {"text": "Edited text.", "complete": True}

    monkeypatch.setenv("TINA_CHAT_SESSION", "dictation-translate-req2")
    monkeypatch.setattr(
        engine, "completion_from_env",
        lambda **_: SimpleNamespace(complete=lambda prompt, **kw: SimpleNamespace(text="Hello world")),
    )
    inline_tx = DICTATION_TRANSLATE_PREFIX + json.dumps({
        "request_id": "req2", "text": "Xin chào thế giới", "target_language": "en",
    })
    tx_result = run_job("translate", inline_tx)
    assert tx_result == {"text": "Hello world", "complete": True}

    # Failure metadata is preserved in the envelope for HTTP status mapping.
    from llm.errors import LLMError
    def fail(*_args, **_kwargs):
        raise LLMError("rate limited", status_code=429)
    monkeypatch.setattr(engine, "completion_from_env", lambda **_: SimpleNamespace(complete=fail))
    failed_tx = run_job("translate", inline_tx)
    assert failed_tx["complete"] is True and failed_tx["translation_error"] == "rate_limit"


def test_control_plane_local_completion_isolates_credentials_and_maps_errors(monkeypatch):
    monkeypatch.setenv("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "/v2/creds/staging")
    monkeypatch.setenv("TINA_LLM_PROVIDER", "bedrock-converse")
    monkeypatch.setenv("TINA_LLM_MODEL", "amazon.nova-lite-v1:0")

    # Separate semaphore from voice completion
    assert local_completion._pool_slots is not meeting_voice_completion._slots

    seen_envs = []

    def fake_run(*_, env, **kwargs):
        seen_envs.append(dict(env))
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"text": "Translated line", "complete": True}),
        )

    monkeypatch.setattr(local_completion.subprocess, "run", fake_run)
    out = local_completion.complete(
        task="translate",
        inline="inline",
        session_id="dictation-translate-1",
        label="Live translation",
        model_env={"TINA_LLM_PROVIDER": "openai-responses", "TINA_LLM_API_KEY": "sk-test", "TINA_LLM_MODEL": "gpt-5"},
    )
    assert out == "Translated line"
    assert seen_envs[0]["TINA_LLM_PROVIDER"] == "openai-responses"
    assert "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI" not in seen_envs[0]

    # Bedrock IAM preserves container credentials
    local_completion.complete(
        task="polish",
        inline="inline",
        session_id="dictation-polish-2",
        label="Text polish",
        model_env={"TINA_LLM_PROVIDER": "bedrock-converse", "TINA_LLM_MODEL": "us.anthropic.claude-sonnet-4-6"},
    )
    assert seen_envs[1]["AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"] == "/v2/creds/staging"

    # Translation failure maps cleanly to 429
    monkeypatch.setattr(
        local_completion.subprocess, "run",
        lambda *_, **__: SimpleNamespace(
            returncode=0,
            stdout=json.dumps({"text": "", "complete": True, "translation_error": "rate_limit"}),
        ),
    )
    with pytest.raises(HTTPException) as err:
        local_completion.complete(
            task="translate", inline="inline", session_id="dictation-translate-3", label="Live translation",
        )
    assert err.value.status_code == 429

    # Timeout maps to 504
    def timed_out(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(cmd="python", timeout=1)
    monkeypatch.setattr(local_completion.subprocess, "run", timed_out)
    with pytest.raises(HTTPException) as err:
        local_completion.complete(
            task="polish", inline="inline", session_id="dictation-polish-4", label="Text polish",
        )
    assert err.value.status_code == 504


def test_api_routes_dictation_polish_to_local_completion_pool_when_enabled(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient
    from control_plane.api import create_app
    from control_plane.workspace_reader import WorkspaceReader

    monkeypatch.setenv("TINA_LOCAL_COMPLETION_POOL", "1")
    calls = []

    class FakeDispatcher:
        settings = None

        def resolve_model_config(self, subject):
            return {"mode": "groq", "api_key": "gsk-test", "model": "openai/gpt-oss-20b"}

        def dispatch(self, *args, **kwargs):
            raise AssertionError("ECS dispatch must not be called when TINA_LOCAL_COMPLETION_POOL=1")

    monkeypatch.setattr(
        local_completion, "complete",
        lambda **kw: (calls.append(kw), "Clean polished text.")[1],
    )
    app = create_app(FakeDispatcher(), stream_reader=object(), reader=WorkspaceReader(tmp_path))
    client = TestClient(app)
    resp = client.post(
        "/api/dictation/polish",
        headers={"X-User-Id": "7", "X-Gateway-Verified": "test"},
        json={"text": "um clean polished text"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"polished_text": "Clean polished text."}
    assert calls[0]["task"] == "polish"
    assert calls[0]["model_env"]["TINA_LLM_PROVIDER"] == "openai-compat"


def test_dispatcher_routes_canonical_notes_and_live_assist_to_background_pool_and_live_meeting_to_s3(tmp_path, monkeypatch):
    from control_plane.dispatch import Dispatcher
    from shared import units
    from shared.config import Settings

    monkeypatch.setenv("TINA_LOCAL_COMPLETION_POOL", "1")
    monkeypatch.setenv("TINA_WORKSPACE_PILOT_USER_IDS", "*")
    monkeypatch.setenv("TINA_WORKSPACE_STORAGE", "s3")
    monkeypatch.setenv("TINA_WORKSPACE_BEDROCK_MODEL", "us.anthropic.claude-sonnet-4-6")

    settings = Settings(
        workspaces_dir=str(tmp_path),
        redis_url="redis://127.0.0.1:6379/0",
        dispatch_signing_key="a" * 32,
        agent_profile="agent",
    )

    spawned = []
    bg_calls = []

    class FakeRuntime:
        def spawn(self, uid, profile, env):
            spawned.append((uid, profile, dict(env)))
            return uid

    class FakeIdentity:
        def mint(self, *args, **kwargs):
            return "tok"

    class FakeModelResolver:
        def resolve(self, subject):
            return {}

    monkeypatch.setattr(
        local_completion, "dispatch_background_meeting_job",
        lambda **kw: (bg_calls.append(kw), kw["unit_id"])[1],
    )
    dispatcher = Dispatcher(settings, FakeRuntime(), FakeIdentity(), model_config=FakeModelResolver())

    # 1. Canonical processed notes -> background local completion pool (not Fargate)
    inv_notes = units.make_dispatch(
        subject="7", trigger="transcription",
        start=units.entrypoint(inline=units.CANONICAL_NOTES_PREFIX + '{"meeting_id":42}'),
        context={"kind": "meeting", "meeting": {"meeting_id": "42", "session_uid": "canonical-1", "platform": "google_meet"}},
    )
    uid_notes = dispatcher.dispatch(inv_notes, trusted_canonical_notes=True)
    assert uid_notes == "agent-meet-canonical-1"
    assert bg_calls[-1]["task"] == "canonical_notes"
    assert not spawned

    # 2. Live Assist meeting state -> background local completion pool (not Fargate)
    inv_state = units.make_dispatch(
        subject="7", trigger="transcription",
        start=units.entrypoint(inline=units.MEETING_STATE_PREFIX + '{"meeting_id":42}'),
        context={"kind": "meeting", "meeting": {"meeting_id": "42", "session_uid": "state-fast-1", "platform": "google_meet"}},
    )
    uid_state = dispatcher.dispatch(inv_state, trusted_meeting_state=True)
    assert uid_state == "agent-meet-state-fast-1"
    assert bg_calls[-1]["task"] == "meeting_state"
    assert not spawned

    # 3. Live Meeting Copilot -> S3 ephemeral workspace-agent on Fargate with bedrock-converse
    inv_live = units.make_dispatch(
        subject="7", trigger="transcription",
        start=units.entrypoint(inline="Live copilot brief"),
        context={"kind": "meeting", "meeting": {
            "meeting_id": "42", "session_uid": "42", "numeric_meeting_id": "42",
            "native_id": "abc-defg-hij", "platform": "google_meet",
        }},
    )
    uid_live = dispatcher.dispatch(inv_live, trusted_live_meeting=True)
    assert uid_live == "agent-meet-42"
    assert len(spawned) == 1
    _, profile, env = spawned[0]
    assert profile == "workspace-agent"
    assert env["TINA_WORKSPACE_STORAGE"] == "s3"
    assert env["TINA_TRANSCRIPT_STREAM"] == "tc:meeting:42"
    assert env["TINA_MEETING_NUMERIC_ID"] == "42"
    assert env["TINA_LLM_PROVIDER"] == "bedrock-converse"
    assert env["TINA_WORKSPACE_ATTEMPT"]


def test_meeting_state_keeps_platform_provider_and_anthropic_without_key_falls_back(tmp_path, monkeypatch):
    from control_plane.dispatch import Dispatcher
    from shared import units
    from shared.config import Settings

    monkeypatch.setenv("TINA_LOCAL_COMPLETION_POOL", "1")
    monkeypatch.setenv("TINA_WORKSPACE_PILOT_USER_IDS", "*")
    monkeypatch.setenv("TINA_WORKSPACE_STORAGE", "s3")
    monkeypatch.setenv("TINA_WORKSPACE_BEDROCK_OWNER", "5")
    monkeypatch.setenv("TINA_S3_WORKSPACE_USERS", "*")

    assert meeting_voice_completion.resolve_voice_model_env(
        {"mode": "anthropic", "model": "claude-sonnet-4-6"}
    ) == {}

    settings = Settings(
        workspaces_dir=str(tmp_path),
        redis_url="redis://127.0.0.1:6379/0",
        dispatch_signing_key="a" * 32,
        agent_profile="agent",
    )
    spawned = []
    bg_calls = []

    class FakeRuntime:
        def spawn(self, uid, profile, env):
            spawned.append((uid, profile, dict(env)))
            return uid

    class FakeIdentity:
        def mint(self, *args, **kwargs):
            return "tok"

    class FakeGroqResolver:
        def resolve(self, subject):
            if subject == "5":
                return {}
            return {"mode": "groq", "api_key": "gsk-test", "model": "openai/gpt-oss-20b"}

    monkeypatch.setattr(
        local_completion, "dispatch_background_meeting_job",
        lambda **kw: (bg_calls.append(kw), kw["unit_id"])[1],
    )
    dispatcher = Dispatcher(settings, FakeRuntime(), FakeIdentity(), model_config=FakeGroqResolver())

    inv_notes = units.make_dispatch(
        subject="7", trigger="transcription",
        start=units.entrypoint(inline=units.CANONICAL_NOTES_PREFIX + '{"meeting_id":42}'),
        context={"kind": "meeting", "meeting": {"meeting_id": "42", "session_uid": "canonical-2", "platform": "google_meet"}},
    )
    dispatcher.dispatch(inv_notes, trusted_canonical_notes=True)
    assert bg_calls[-1]["model_env"]["TINA_LLM_PROVIDER"] == "openai-compat"

    inv_state = units.make_dispatch(
        subject="7", trigger="transcription",
        start=units.entrypoint(inline=units.MEETING_STATE_PREFIX + '{"meeting_id":42}'),
        context={"kind": "meeting", "meeting": {"meeting_id": "42", "session_uid": "state-fast-2", "platform": "google_meet"}},
    )
    dispatcher.dispatch(inv_state, trusted_meeting_state=True)
    assert bg_calls[-1]["model_env"] is None

    inv_nova = units.make_dispatch(
        subject="5", trigger="message",
        start=units.entrypoint(inline="Hello Nova"),
        context={"kind": "none", "session": "nova-chat-1"},
    )
    dispatcher.dispatch(inv_nova)
    assert spawned[-1][2]["TINA_RUNNER"] == "bedrock-workspace"
    assert spawned[-1][2]["TINA_LLM_PROVIDER"] == "bedrock-converse"
    assert spawned[-1][2]["TINA_LLM_MODEL"] == spawned[-1][2]["TINA_AGENT_MODEL"]

    # Wildcard TINA_WORKSPACE_BEDROCK_OWNER="*" routes any numeric user without BYO/ChatGPT to Nova Lite
    monkeypatch.setenv("TINA_WORKSPACE_BEDROCK_OWNER", "*")
    from control_plane.dispatch import workspace_uses_nova
    assert workspace_uses_nova("99", {}) is True
    assert workspace_uses_nova("not-a-user", {}) is False


def test_meeting_assistant_runs_via_local_completion_pool_with_strict_citations(monkeypatch):
    from shared.units import MEETING_KNOWLEDGE_PREFIX
    from worker import engine

    monkeypatch.setenv("TINA_LOCAL_COMPLETION_POOL", "1")
    monkeypatch.setenv("TINA_CHAT_SESSION", "meeting-knowledge-req-asst")
    seen = []

    class FakeStructuredProvider:
        def complete_structured(self, prompt, *, system="", schema=None):
            seen.append({"prompt": prompt, "system": system, "schema": schema})
            return SimpleNamespace(text=json.dumps({
                "claims": [{"text": "Lan phụ trách phần demo.", "source_ids": ["s0"]}],
            }))

    monkeypatch.setattr(engine, "completion_from_env", lambda **_: FakeStructuredProvider())
    inline = MEETING_KNOWLEDGE_PREFIX + json.dumps({
        "request_id": "req-asst",
        "text": json.dumps({
            "mode": "meeting_assistant",
            "bounded": False,
            "question": "Ai phụ trách demo?",
            "sources": [{"id": "s0", "kind": "transcript", "quote": "Lan phụ trách demo."}],
        }),
    })
    result = run_job("knowledge", inline)
    assert result["complete"] is True
    parsed = json.loads(result["text"])
    assert parsed["claims"][0]["source_ids"] == ["s0"]
    assert seen and seen[0]["schema"]["required"] == ["claims"]
