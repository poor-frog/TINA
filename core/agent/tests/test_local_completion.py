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
