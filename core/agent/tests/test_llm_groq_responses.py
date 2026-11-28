"""Codex request compatibility and authenticated streaming over the local Groq hop."""
from __future__ import annotations

import json
import http.client
import threading

import httpx
import pytest

from llm.errors import LLMConfigError
from llm.groq_responses import GROQ_RESPONSES_URL, groq_responses_proxy, sanitize_responses_request


KEY = "groq-test-credential-not-real"
AUTH = {"Authorization": "Bearer " + KEY}


def test_sanitizes_captured_codex_fields_without_expanding_tools_or_mutation():
    function = {"type": "function", "name": "read_transcript", "parameters": {"type": "object"}}
    payload = {
        "model": "openai/gpt-oss-20b", "instructions": "workspace rules",
        "input": [{"role": "user", "content": "hello"}],
        "tools": [function, {"type": "namespace", "name": "multi_agent_v1", "tools": []},
                  {"type": "web_search"}, {"type": "custom", "name": "apply_patch"}],
        "tool_choice": "auto", "parallel_tool_calls": True,
        "reasoning": {"summary": "auto", "effort": "low"},
        "stream": True, "store": False, "include": ["reasoning.encrypted_content"],
        "prompt_cache_key": "cache", "client_metadata": {"client": "codex"},
        "previous_response_id": "response-old", "truncation": "auto",
        "safety_identifier": "local-user", "prompt": {"id": "saved-prompt"},
    }
    original = json.loads(json.dumps(payload))
    clean = sanitize_responses_request(payload)
    assert clean == {
        "model": "openai/gpt-oss-20b", "instructions": "workspace rules",
        "input": [{"role": "user", "content": "hello"}], "tools": [function],
        "tool_choice": "auto", "parallel_tool_calls": False,
        "stream": True,
    }
    assert payload == original


@pytest.mark.parametrize("reasoning", [{"summary": "auto"}, {"effort": "xhigh"}, None, "low"])
def test_reasoning_omits_unsupported_effort_and_summary(reasoning):
    assert "reasoning" not in sanitize_responses_request({"reasoning": reasoning})


@pytest.mark.parametrize("model", ["qwen/qwen3.8-27b", "qwen/qwen3.6-27b", "llama-3.3-70b-versatile"])
def test_non_gpt_oss_preserves_instructions_and_tool_history_with_supported_roles(model):
    payload = {"model": model, "input": [
        {"type": "message", "role": "developer", "content": [{"type": "input_text", "text": "workspace rules"}]},
        {"role": "user", "content": "read the transcript"},
        {"type": "function_call", "name": "read_transcript", "call_id": "call-1", "arguments": "{}"},
        {"type": "function_call_output", "call_id": "call-1", "output": "meeting text"},
        {"role": "developer", "content": "follow-up instructions"},
        {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "summary"}]},
    ]}
    original = json.loads(json.dumps(payload))
    cleaned = sanitize_responses_request(payload)
    assert cleaned["input"] == [
        {**payload["input"][0], "role": "system"}, *payload["input"][1:4],
        {**payload["input"][4], "role": "system"}, payload["input"][5],
    ]
    assert payload == original


@pytest.mark.parametrize("model", ["openai/gpt-oss-20b", "openai/gpt-oss-120b"])
def test_gpt_oss_keeps_native_developer_role(model):
    payload = {"model": model, "input": [{"role": "developer", "content": "workspace rules"}]}
    assert sanitize_responses_request(payload)["input"] == payload["input"]


@pytest.mark.parametrize("key", ["", "contains space", "key\nheader", "non-ascii-\N{SNOWMAN}"])
def test_invalid_credential_fails_before_starting_proxy(key):
    with pytest.raises(LLMConfigError, match="valid Groq API key"):
        with groq_responses_proxy(key):
            pytest.fail("invalid key must not create a listener")


def test_streaming_passes_sse_before_completion_and_uses_fixed_upstream():
    release = threading.Event()
    seen = []
    first = b'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Xin chao"}\n\n'
    last = b'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n'

    class Chunks(httpx.SyncByteStream):
        def __iter__(self):
            yield first
            assert release.wait(timeout=5), "client should receive the first event without buffering"
            yield last

    def upstream(request):
        seen.append(request)
        assert request.url == GROQ_RESPONSES_URL
        assert request.headers["Authorization"] == AUTH["Authorization"]
        assert "X-Api-Key" not in request.headers
        assert json.loads(request.content)["tools"] == []
        return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, stream=Chunks())

    with groq_responses_proxy(KEY, transport=httpx.MockTransport(upstream)) as base:
        assert base.startswith("http://127.0.0.1:") and base.endswith("/v1")
        try:
            with httpx.Client(trust_env=False, timeout=10) as client:
                with client.stream("POST", base + "/responses", headers={**AUTH, "X-Api-Key": "ignore"},
                                   json={"model": "openai/gpt-oss-20b", "input": "hello", "stream": True,
                                         "tools": [{"type": "namespace", "name": "multi_agent_v1"}]}) as response:
                    lines = response.iter_lines()
                    assert next(lines) == "event: response.output_text.delta"
                    assert not release.is_set()
                    release.set()
                    rest = "\n".join(lines)
                    assert '"delta":"Xin chao"' in rest
                    assert "response.completed" in rest
        finally:
            release.set()
    assert len(seen) == 1
    with httpx.Client(trust_env=False, timeout=1) as client:
        with pytest.raises((httpx.ConnectError, httpx.ConnectTimeout)):
            client.post(base + "/responses", headers=AUTH, json={})


@pytest.mark.parametrize("auth", [None, "Bearer wrong-key", "Basic arbitrary"])
def test_missing_or_wrong_local_auth_cannot_make_upstream_requests(auth):
    def forbidden(request):
        pytest.fail("unauthenticated local request reached Groq")

    with groq_responses_proxy(KEY, transport=httpx.MockTransport(forbidden)) as base:
        with httpx.Client(trust_env=False) as client:
            response = client.post(base + "/responses", json={},
                                   headers={"Authorization": auth} if auth else {})
    assert response.status_code == 401


def test_rejects_arbitrary_paths_bad_json_and_oversized_body(monkeypatch):
    monkeypatch.setattr("llm.groq_responses.MAX_REQUEST_BYTES", 128)

    def forbidden(request):
        pytest.fail("invalid request reached Groq")

    with groq_responses_proxy(KEY, transport=httpx.MockTransport(forbidden)) as base:
        with httpx.Client(trust_env=False) as client:
            assert client.post(base + "/other", headers=AUTH, json={}).status_code == 404
            assert client.post(base + "/responses?upstream=https://example.test", headers=AUTH, json={}).status_code == 404
            assert client.post(base + "/responses", headers=AUTH, content=b"invalid").status_code == 400
            assert client.post(base + "/responses", headers=AUTH, json=[]).status_code == 400
        # Reject the length before reading a body. Sending no oversized payload
        # also avoids OS-dependent TCP resets when a server closes unread data.
        url = httpx.URL(base)
        connection = http.client.HTTPConnection(url.host, url.port, timeout=5)
        try:
            connection.putrequest("POST", "/v1/responses")
            connection.putheader("Authorization", AUTH["Authorization"])
            connection.putheader("Content-Length", "129")
            connection.endheaders()
            response = connection.getresponse()
            assert response.status == 413
            assert "size limit" in response.read().decode()
        finally:
            connection.close()


@pytest.mark.parametrize("status", [401, 403, 429, 500])
def test_preserves_upstream_error_status_retry_and_redacts_credential(status, capsys):
    def upstream(request):
        return httpx.Response(status, json={"error": {"message": "rejected " + KEY}},
                              headers={"Retry-After": "2"})

    with groq_responses_proxy(KEY, transport=httpx.MockTransport(upstream)) as base:
        with httpx.Client(trust_env=False) as client:
            response = client.post(base + "/responses", headers=AUTH, json={})
    assert response.status_code == status
    assert response.headers["Retry-After"] == "2"
    assert response.json()["error"]["message"] == "rejected [REDACTED]"
    assert KEY not in str(response.headers)
    assert KEY not in capsys.readouterr().err


def test_oversized_upstream_errors_are_bounded_without_changing_status(monkeypatch):
    monkeypatch.setattr("llm.groq_responses.MAX_ERROR_BYTES", 32)

    def upstream(request):
        return httpx.Response(429, text="x" * 200)

    with groq_responses_proxy(KEY, transport=httpx.MockTransport(upstream)) as base:
        with httpx.Client(trust_env=False) as client:
            response = client.post(base + "/responses", headers=AUTH, json={})
    assert response.status_code == 429
    assert "oversized error response" in response.json()["error"]["message"]
    assert len(response.content) < 200


@pytest.mark.parametrize("error,status", [(httpx.ConnectError, 502), (httpx.ReadTimeout, 504)])
def test_transport_error_hides_exception_details_and_key(error, status, capsys):
    def upstream(request):
        raise error("private transport detail " + KEY)

    with groq_responses_proxy(KEY, transport=httpx.MockTransport(upstream)) as base:
        with httpx.Client(trust_env=False) as client:
            response = client.post(base + "/responses", headers=AUTH, json={})
    assert response.status_code == status
    assert KEY not in response.text
    assert "private transport detail" not in response.text
    assert KEY not in capsys.readouterr().err


def test_groq_proxy_honors_configured_https_proxy_only_for_http_schemes(monkeypatch):
    from llm import groq_responses

    monkeypatch.delenv("HTTPS_PROXY", raising=False)
    monkeypatch.delenv("https_proxy", raising=False)
    assert groq_responses._configured_https_proxy() is None

    monkeypatch.setenv("HTTPS_PROXY", "http://egress-proxy.tina-staging.local:3128")
    assert groq_responses._configured_https_proxy() == "http://egress-proxy.tina-staging.local:3128"

    seen_kwargs = []
    real_client = httpx.Client

    def capture_client(*args, **kwargs):
        seen_kwargs.append(kwargs)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(groq_responses.httpx, "Client", capture_client)
    with groq_responses_proxy(KEY):
        pass
    assert seen_kwargs and seen_kwargs[0]["proxy"] == "http://egress-proxy.tina-staging.local:3128"
    assert seen_kwargs[0]["trust_env"] is False
    assert seen_kwargs[0]["follow_redirects"] is False

    monkeypatch.setenv("HTTPS_PROXY", "socks5://127.0.0.1:1080")
    assert groq_responses._configured_https_proxy() is None
    monkeypatch.setenv("HTTPS_PROXY", "file:///etc/passwd")
    assert groq_responses._configured_https_proxy() is None

