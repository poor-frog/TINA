"""Settings → Models "Test" buttons — the on-demand credential tests (control_plane.config_test).

Grades the exact failure modes observed live on 2026-07-09: stale Keychain export (expired
subscription file), zero-balance external transcription token (402 per segment), rejected
token, unreachable backend, and the happy paths.
"""
import json
import pytest

from control_plane import config_test as ct


# ── subscription file ─────────────────────────────────────────────────────────────────────────

def _write_creds(tmp_path, expires_ms):
    p = tmp_path / "creds.json"
    p.write_text(json.dumps({"claudeAiOauth": {"expiresAt": expires_ms}}))
    return str(p)


def test_subscription_missing_file(tmp_path):
    out = ct.test_subscription_credentials(str(tmp_path / "absent"))
    assert not out["ok"] and "HOST_CLAUDE_CREDENTIALS" in out["summary"]


def test_subscription_expired_carries_remedy(tmp_path):
    out = ct.test_subscription_credentials(_write_creds(tmp_path, 1_000_000), now=2_000.0)
    assert not out["ok"] and out.get("expired") is True
    assert ct.KEYCHAIN_REFRESH in out["summary"]  # the fix ships WITH the failure


def test_subscription_valid_reports_hours_left(tmp_path):
    out = ct.test_subscription_credentials(_write_creds(tmp_path, 10 * 3600 * 1000), now=0.0)
    assert out["ok"] and out["expires_in_hours"] == 10.0


def test_subscription_garbage_file(tmp_path):
    p = tmp_path / "creds.json"
    p.write_text("not json")
    out = ct.test_subscription_credentials(str(p))
    assert not out["ok"] and ct.KEYCHAIN_REFRESH in out["summary"]


# ── custom endpoint ───────────────────────────────────────────────────────────────────────────

def test_custom_endpoint_auth_failure():
    out = ct.test_custom_endpoint("https://gw.example", "bad-key",
                                  post=lambda u, p, h: (401, "{}"))
    assert not out["ok"] and "Authentication FAILED" in out["summary"]


def test_custom_endpoint_ok_anthropic_dialect():
    calls = []
    def post(url, payload, headers):
        calls.append(url)
        return 200, "{}"
    out = ct.test_custom_endpoint("https://gw.example/", "k", "m1", post=post)
    assert out["ok"] and calls == ["https://gw.example/v1/messages"]


def test_custom_endpoint_falls_back_to_openai_dialect():
    def post(url, payload, headers):
        return (404, "") if url.endswith("/v1/messages") else (200, "{}")
    out = ct.test_custom_endpoint("https://gw.example", "k", post=post)
    assert out["ok"]


def test_custom_endpoint_unreachable():
    def post(url, payload, headers):
        raise OSError("connection refused")
    out = ct.test_custom_endpoint("https://gw.example", "k", post=post)
    assert not out["ok"] and "unreachable" in out["summary"]


def test_run_models_test_routes_custom_vs_subscription(tmp_path):
    out = ct.run_models_test({"mode": "custom", "base_url": "https://gw", "api_key": "k"},
                             env={}, post=lambda u, p, h: (200, "{}"))
    assert out["mode"] == "custom" and out["ok"]
    out = ct.run_models_test({}, env={}, creds_path=str(tmp_path / "absent"))
    assert out["mode"] == "subscription" and not out["ok"]
    # secrets never echo in provenance
    out = ct.run_models_test({"mode": "custom", "base_url": "https://gw", "api_key": "SECRET"},
                             env={}, post=lambda u, p, h: (200, "{}"))
    assert "api_key" not in out["config"] and "SECRET" not in json.dumps(out)


def test_run_models_test_does_not_claim_antigravity_auth_was_checked():
    out = ct.run_models_test(
        {"mode": "antigravity", "api_key": "SECRET", "model": "gemini-3.1-pro"},
        env={},
    )

    assert out["mode"] == "antigravity"
    assert out["ok"] is False
    assert "agent-worker" in out["summary"]
    assert "SECRET" not in json.dumps(out)


def _groq_tool_response(payload):
    if payload.get("tool_choice") == "required":
        return json.dumps({"status": "completed", "output": [{
            "type": "function_call", "name": "tina_connection_check", "call_id": "probe-call-1",
            "arguments": '{"nonce":"tina_probe"}',
        }]})
    return json.dumps({"status": "completed", "output": [{"type": "message", "role": "assistant",
                      "content": [{"type": "output_text", "text": "OK"}]}]})


@pytest.mark.parametrize("model,role", [("openai/gpt-oss-20b", "developer"), ("qwen/qwen3.8-27b", "system")])
def test_groq_checks_chat_tool_round_trip_and_summary_models_using_their_actual_dialects(model, role):
    calls = []
    def post(url, payload, headers):
        calls.append((url, payload, headers))
        return 200, _groq_tool_response(payload)

    result = ct.run_models_test({"mode": "groq", "api_key": "groq-secret",
                                 "model": model,
                                 "meeting_model": "summary-model"}, env={}, post=post)

    assert result["ok"] and result["mode"] == "groq"
    assert [call[0] for call in calls] == [
        "https://api.groq.com/openai/v1/responses",
        "https://api.groq.com/openai/v1/responses",
        "https://api.groq.com/openai/v1/chat/completions",
    ]
    assert calls[0][1]["model"] == model
    assert calls[0][1]["input"][0]["role"] == role
    assert calls[0][1]["tools"][0]["name"] == "tina_connection_check"
    assert calls[0][1]["tool_choice"] == "required"
    assert calls[1][1]["input"][-1] == {
        "type": "function_call_output", "call_id": "probe-call-1", "output": "OK",
    }
    assert calls[2][1]["model"] == "summary-model"
    assert "input" in calls[0][1] and "messages" in calls[2][1]
    assert not {"store", "include", "previous_response_id", "truncation"}.intersection(calls[0][1])
    assert all(call[2] == {"Authorization": "Bearer groq-secret"} for call in calls)
    assert "groq-secret" not in json.dumps(result)


def test_groq_rejects_a_known_non_tool_chat_model_before_network_but_allows_it_for_summaries():
    def forbidden(*_args):
        pytest.fail("a text-only chat model must fail before inference")
    result = ct.test_groq("groq-secret", "allam-2-7b", post=forbidden)
    assert not result["ok"] and "does not support tool calling" in result["summary"]

    seen = []
    def post(url, payload, headers):
        seen.append(payload)
        return 200, _groq_tool_response(payload)
    result = ct.test_groq("groq-secret", "openai/gpt-oss-20b", "allam-2-7b", post=post)
    assert result["ok"] and seen[-1]["model"] == "allam-2-7b"
    assert "tools" not in seen[-1]


@pytest.mark.parametrize("output", [
    [], [{"type": "message", "content": [{"type": "output_text", "text": "OK"}]}],
    [{"type": "function_call", "name": "wrong_tool", "call_id": "1", "arguments": '{"nonce":"tina_probe"}'}],
    [{"type": "function_call", "name": "tina_connection_check", "call_id": "1", "arguments": "not-json"}],
    [{"type": "function_call", "name": "tina_connection_check", "call_id": "1", "arguments": '{"nonce":"wrong"}'}],
])
def test_groq_never_passes_a_text_ping_or_malformed_tool_call(output):
    result = ct.test_groq("groq-secret", "new-model", post=lambda *_:
                          (200, json.dumps({"status": "completed", "output": output})))
    assert not result["ok"] and "did not return a valid tool call" in result["summary"]


def test_groq_fails_when_the_model_cannot_consume_a_tool_result():
    def post(url, payload, headers):
        if payload.get("tool_choice") == "required":
            return 200, _groq_tool_response(payload)
        return 400, "invalid tool role groq-secret"
    result = ct.test_groq("groq-secret", "new-model", post=post)
    assert not result["ok"] and "chat tool results" in result["summary"]
    assert "groq-secret" not in json.dumps(result)


def test_groq_fails_on_incomplete_reply_after_tool_execution():
    def post(url, payload, headers):
        if payload.get("tool_choice") == "required":
            return 200, _groq_tool_response(payload)
        return 200, '{"status":"incomplete","output":[]}'
    result = ct.test_groq("groq-secret", "new-model", post=post)
    assert not result["ok"] and "did not finish the reply" in result["summary"]


def test_groq_does_not_accept_a_foreign_deployment_key():
    def post(*_args):
        raise AssertionError("Groq must not be called without its own saved credential")

    result = ct.run_models_test({"mode": "groq"}, env={"ANTHROPIC_API_KEY": "foreign-secret",
                                "OPENAI_API_KEY": "another-secret"}, post=post)
    assert not result["ok"] and "Groq API key is missing" in result["summary"]


def test_groq_fails_if_summary_endpoint_rejects_the_key_and_redacts_provider_detail():
    def post(url, payload, headers):
        return (200, _groq_tool_response(payload)) if url.endswith("/responses") else (400, "bad groq-secret model")

    result = ct.run_models_test({"mode": "groq", "api_key": "groq-secret"}, env={}, post=post)
    assert not result["ok"] and "meeting summaries" in result["summary"]
    assert "groq-secret" not in json.dumps(result)
    assert "[redacted]" in result["summary"]
    result = ct.run_models_test({"mode": "groq", "api_key": "groq-secret"}, env={},
                               post=lambda *_args: (401, "bad groq-secret"))
    assert not result["ok"] and result["status"] == 401
    assert "groq-secret" not in json.dumps(result)


def test_groq_auth_failure_repeats_the_provider_reason_and_never_the_key():
    body = json.dumps({"error": {"message": "Invalid API Key groq-secret", "type": "invalid_request_error"}})

    result = ct.run_models_test({"mode": "groq", "api_key": "groq-secret"}, env={},
                                post=lambda *_args: (401, body))

    assert "Provider says: Invalid API Key [redacted]" in result["summary"]
    assert "groq-secret" not in json.dumps(result)


def test_deepseek_probes_its_anthropic_chat_and_compat_summary_dialects():
    calls = []
    def post(url, payload, headers):
        calls.append((url, payload, headers))
        return 200, _anthropic_tool_response(payload)
    result = ct.run_models_test({"mode": "deepseek", "api_key": "own-key",
                                 "meeting_model": "summary-model"}, env={}, post=post)
    assert result["ok"] and result["mode"] == "deepseek"
    assert calls[0][0] == "https://api.deepseek.com/anthropic/v1/messages"
    assert calls[0][1]["model"] == "deepseek-flash"
    assert calls[0][2] == {"Authorization": "Bearer own-key", "anthropic-version": "2023-06-01"}
    assert calls[1][0] == "https://api.deepseek.com/anthropic/v1/messages"
    assert calls[1][1]["messages"][-1]["content"][0]["tool_use_id"] == "probe-call-1"
    assert calls[2][0] == "https://api.deepseek.com/chat/completions"
    assert calls[2][1]["model"] == "summary-model"
    assert calls[2][2] == {"Authorization": "Bearer own-key"}
    assert "own-key" not in json.dumps(result)


def _anthropic_tool_response(payload):
    if len(payload.get("messages", [])) == 1:
        return json.dumps({"stop_reason": "tool_use", "content": [
            {"type": "thinking", "thinking": "connection check", "signature": "opaque-signature"},
            {"type": "tool_use", "id": "probe-call-1", "name": "tina_connection_check",
             "input": {"nonce": "tina_probe"}},
        ]})
    return json.dumps({"stop_reason": "end_turn", "content": [{"type": "text", "text": "OK"}]})


def _gemini_tool_response(payload):
    if payload.get("toolConfig", {}).get("functionCallingConfig", {}).get("mode") == "ANY":
        return json.dumps({"candidates": [{"content": {"role": "model", "parts": [{
            "functionCall": {"name": "tina_connection_check", "args": {"nonce": "tina_probe"}, "id": "probe-call-1"},
            "thoughtSignature": "opaque-signature",
        }]}, "finishReason": "STOP"}]})
    return json.dumps({"candidates": [{"content": {"role": "model", "parts": [{"text": "OK"}]}, "finishReason": "STOP"}]})


def test_gemini_tests_native_chat_tool_round_trip_and_summary_without_claiming_cli_execution():
    calls = []
    def post(url, payload, headers):
        calls.append((url, payload, headers))
        return 200, _gemini_tool_response(payload)
    result = ct.run_models_test({"mode": "gemini", "api_key": "own-key"}, env={}, post=post)
    assert result["ok"] and result["mode"] == "gemini"
    assert calls[0][0] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
    assert calls[0][1]["tools"][0]["functionDeclarations"][0]["name"] == "tina_connection_check"
    assert calls[0][2] == {"x-goog-api-key": "own-key"}
    assert calls[1][1]["contents"][1]["parts"][0]["thoughtSignature"] == "opaque-signature"
    assert calls[1][1]["contents"][2]["parts"][0]["functionResponse"]["id"] == "probe-call-1"
    assert calls[2] == ("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
        "model": "gemini-3.5-flash", "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 16,
    }, {"Authorization": "Bearer own-key"})
    assert len(calls) == 3
    assert "full CLI workflow" in result["summary"]


@pytest.mark.parametrize("mode", ["deepseek", "gemini", "bedrock"])
def test_native_text_only_ping_cannot_pass_the_chat_tool_test(mode):
    cfg = {"mode": mode, "api_key": "own-key", "model": "test-model", "region": "us-east-1"}
    result = ct.run_models_test(cfg, env={}, post=lambda *_: (200, '{"content":[{"type":"text","text":"OK"}]}'))
    assert not result["ok"] and "function" in result["summary"]


def test_anthropic_probe_preserves_thinking_signature_and_tool_id():
    calls = []
    def post(url, payload, headers):
        calls.append(payload)
        return 200, _anthropic_tool_response(payload)
    assert ct.test_deepseek("own-key", post=post)["ok"]
    assert calls[1]["messages"][1]["content"][0]["signature"] == "opaque-signature"
    assert calls[1]["messages"][2]["content"][0]["tool_use_id"] == "probe-call-1"


@pytest.mark.parametrize("mode", ["deepseek", "gemini"])
def test_native_probe_rejects_incomplete_tool_followup(mode):
    def post(url, payload, headers):
        if mode == "gemini":
            first = len(payload.get("contents", [])) == 1
            return 200, _gemini_tool_response(payload) if first else '{"candidates":[]}'
        first = len(payload.get("messages", [])) == 1
        return 200, _anthropic_tool_response(payload) if first else '{"stop_reason":"max_tokens","content":[]}'
    result = ct.run_models_test({"mode": mode, "api_key": "own-key"}, env={}, post=post)
    assert not result["ok"] and "after a tool result" in result["summary"]


def test_gemini_native_chat_failure_cannot_be_hidden_by_working_summary_api():
    calls = []
    def post(url, payload, headers):
        calls.append(url)
        return 404, '{"error":{"message":"Model not found"}}'
    result = ct.test_gemini("own-key", "gemini-3.5-flash", post=post)
    assert result["ok"] is False and result["status"] == 404
    assert "native chat" in result["summary"] and "Model not found" in result["summary"]
    assert len(calls) == 1 and calls[0].endswith("gemini-3.5-flash:generateContent")


@pytest.mark.parametrize("mode", ["deepseek", "gemini"])
def test_api_provider_tests_require_own_keys_and_redact_errors(mode):
    def no_post(*_args):
        raise AssertionError("must not use a deployment credential")
    result = ct.run_models_test({"mode": mode}, env={"ANTHROPIC_API_KEY": "foreign"}, post=no_post)
    assert not result["ok"] and "API key is missing" in result["summary"]
    for status in (400, 401):
        result = ct.run_models_test({"mode": mode, "api_key": "own-key"}, env={},
                                   post=lambda *_args: (status, "rejected own-key"))
        assert not result["ok"] and result["status"] == status
        assert "own-key" not in json.dumps(result)


# ── transcription backend ─────────────────────────────────────────────────────────────────────

def _balance(email, minutes):
    return 200, json.dumps({"email": email, "balance_minutes": minutes})


# The 2026-07-19 recurrence, as a permanent pair: two tokens, both reporting balance 0.0 —
# one exhausted (every request 402s), one billing-exempt (transcribes fine). NO balance
# threshold and NO account name can tell them apart; only the endpoint's answer to real audio
# can. Neither row names any specific account: identity must never be the oracle.

def test_transcription_exhausted_token_fails_loud_despite_valid_auth():
    out = ct.run_transcription_test(
        "http://localhost:8083", "tok", "settings",
        get=lambda u, h: _balance("someone@gmail.com", 0.0),
        probe=lambda e, t: (402, '{"detail":"Insufficient balance"}'))
    assert not out["ok"] and "402" in out["summary"] and out["source"] == "settings"
    assert "NO transcript" in out["summary"], "the verdict must name the consequence"


def test_transcription_zero_balance_but_transcribing_token_is_green():
    """A billing-exempt account reports 0.0 minutes and transcribes perfectly — the round-trip
    must green it where a balance threshold would condemn it."""
    out = ct.run_transcription_test(
        "http://localhost:8083", "tok", "env",
        get=lambda u, h: _balance("svc-account@example.com", 0.0),
        probe=lambda e, t: (200, '{"text":"probe"}'))
    assert out["ok"], "zero balance alone must never fail a token that transcribes"
    assert "svc-account@example.com" in out["summary"]


def test_transcription_funded_external_ok():
    out = ct.run_transcription_test(
        "http://localhost:8083", "tok", "env",
        get=lambda u, h: _balance("someone@gmail.com", 42.5),
        probe=lambda e, t: (200, '{"text":"probe"}'))
    assert out["ok"] and "someone@gmail.com" in out["summary"]


def test_transcription_rejected_token():
    out = ct.run_transcription_test("https://x", "bad", "env", get=lambda u, h: (403, ""),
                                    probe=lambda e, t: (403, ""))
    assert not out["ok"] and "REJECTED" in out["summary"]


def test_transcription_backend_5xx_is_red():
    out = ct.run_transcription_test("https://t", "tok", "env", get=lambda u, h: (404, ""),
                                    probe=lambda e, t: (503, ""))
    assert not out["ok"] and "503" in out["summary"]


def test_transcription_strips_v1_path_for_balance_probe():
    seen = []
    def get(url, headers):
        seen.append(url)
        return _balance("someone@example.com", 5.0)
    ct.run_transcription_test("http://localhost:8083/v1/audio/transcriptions", "tok", "env", get=get,
                              probe=lambda e, t: (200, '{"text":""}'))
    assert seen == ["http://localhost:8083/balance"]


def test_transcription_no_backend_and_no_token():
    out = ct.run_transcription_test("", "", "env")
    assert not out["ok"] and "No transcription backend" in out["summary"]
    out = ct.run_transcription_test("https://t", "", "env")
    assert not out["ok"] and "NO token" in out["summary"]


def test_transcription_unreachable():
    def boom(endpoint, token):
        raise OSError("timeout")
    out = ct.run_transcription_test("https://t", "tok", "env", get=lambda u, h: (404, ""),
                                    probe=boom)
    assert not out["ok"] and "unreachable" in out["summary"]


def test_transcription_balance_failure_never_blocks_the_verdict():
    """/balance is a courtesy account lookup, never the oracle — a gateway without it (or one
    that errors) must not stop the round-trip from grading the backend."""
    def boom(url, headers):
        raise OSError("no /balance here")
    out = ct.run_transcription_test("https://t", "tok", "env", get=boom,
                                    probe=lambda e, t: (200, '{"text":""}'))
    assert out["ok"]


# ── C2 (#511): a non-TINA backend is graded by the endpoint BOTS use, never "reachable" ──────────
# No /balance means "not a TINA gateway", which is not a verdict on the operator's question. The
# round-trip runs the bot's own first-chunk request (same probe body as the boot preflight), so
# the wizard's green means "a bot will transcribe" on ANY OpenAI-compatible endpoint.

_NO_BALANCE = lambda u, h: (404, "")  # noqa: E731 — the non-TINA signature, reused by every row


def test_transcription_openai_wrong_key_is_red():
    """A1/A2: a rejected key on an OpenAI-compatible endpoint is RED at the click — it used to
    return green-unverified and fail mid-meeting."""
    out = ct.run_transcription_test("https://api.openai.com", "sk-wrong", "settings",
                                    get=_NO_BALANCE, probe=lambda e, t: (401, ""))
    assert not out["ok"], "a rejected key must never test green"
    assert "REJECTED" in out["summary"] and out["status"] == 401
    assert out.get("unverified") is None, "there is no longer an unverified green"


def test_transcription_openai_good_key_is_green_and_names_the_endpoint():
    out = ct.run_transcription_test("https://api.openai.com", "sk-good", "settings",
                                    get=_NO_BALANCE, probe=lambda e, t: (200, '{"text":""}'))
    assert out["ok"]
    assert "/v1/audio/transcriptions" in out["summary"]


def test_transcription_openai_wrong_url_is_red():
    out = ct.run_transcription_test("https://api.openai.com/wrong", "sk-good", "env",
                                    get=_NO_BALANCE, probe=lambda e, t: (404, ""))
    assert not out["ok"] and "URL shape" in out["summary"]


def test_transcription_probe_hits_the_transcriptions_path_once():
    """C4 (A5) at this consumer: base URL and full-path URL must hit the SAME endpoint once with
    the configured token (the /balance lookup's X-API-Key is TINA-gateway-only)."""
    for configured in ("https://api.openai.com", "https://api.openai.com/v1/audio/transcriptions"):
        seen = []
        def probe(endpoint, token):
            seen.append((endpoint, token))
            return 200, '{"text":""}'
        out = ct.run_transcription_test(configured, "sk-good", "env", get=_NO_BALANCE, probe=probe)
        assert out["ok"], f"{configured} must verify green"
        assert seen == [("https://api.openai.com/v1/audio/transcriptions", "sk-good")], (
            f"{configured} → {seen}"
        )


def test_transcription_rejects_every_non_success_status():
    for status in (302, 400, 405, 408, 413, 422, 429):
        out = ct.run_transcription_test(
            "http://local-asr", "", "settings", get=_NO_BALANCE,
            probe=lambda e, t, status=status: (status, '{"detail":"rejected"}'),
            require_token=False,
        )
        assert not out["ok"], f"HTTP {status} must not test green"
        assert out["status"] == status


def test_transcription_rejects_invalid_success_payload():
    for body in ('<html>OK</html>', '{}', '[]', '{"text":null}', '{"text":42}', '{"error":"failed"}'):
        out = ct.run_transcription_test(
            "http://local-asr", "", "settings", get=_NO_BALANCE,
            probe=lambda e, t, body=body: (200, body), require_token=False,
        )
        assert not out["ok"], f"Invalid transcript must not test green: {body}"


def test_transcription_accepts_silence_from_tokenless_funasr():
    out = ct.run_transcription_test(
        "http://local-asr", "", "settings", get=_NO_BALANCE,
        probe=lambda e, t: (200, '{"text":""}'), model="custom", require_token=False,
    )
    assert out["ok"]


def test_separate_translation_model_is_probed(monkeypatch):
    from control_plane import config_test
    calls = []
    def probe(key, model, meeting_model, **kwargs):
        calls.append((model, meeting_model))
        return {"ok": True, "summary": "inference OK"}
    monkeypatch.setattr(config_test, "test_groq", probe)
    result = config_test.run_models_test({"mode": "groq", "model": "chat", "meeting_model": "meeting", "translation_model": "translate"}, env={})
    assert calls == [("chat", "meeting"), ("chat", "translate")]
    assert result["ok"] and result["config"]["translation_model"] == "translate"
