"""config_test.py — on-demand credential tests behind Settings → Models "Test" buttons.

The two silent-failure modes this surface exists to catch (both bit the owner on 2026-07-09):
  * subscription mode: the mounted ``~/.claude/.credentials.json`` is a STALE export (macOS
    Keychain holds the live token; the file expires ~8-12h) → every turn dies with
    "401 Invalid authentication credentials" and nothing in the UI says why.
  * transcription: a Settings-level override silently outranks ``.env`` (user > global > env)
    and a zero-balance external token 402s every segment while the bot logs stay in docker.

Tests are HONEST about depth: a custom endpoint gets a real 1-token completion; the
subscription file gets an existence + expiry check (the CLI lives only in worker images, so a
live inference test would need a dispatch — the expiry check catches 100% of the observed
failures); transcription sends a real audio probe, with auth optional for local FunASR.

Pure functions over injected fetchers — the routes in api.py are thin wrappers.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Callable, Optional

# The compose-mounted subscription credential file (same :ro mount the runtime probes; the
# docker backend mounts the same host path into workers at /root/.claude/.credentials.json).
CREDS_PATH = "/var/lib/tina/host-claude-credentials"

# The macOS remedy, verbatim — the error message must carry the fix (fail loud AND helpful).
KEYCHAIN_REFRESH = ('security find-generic-password -s "Claude Code-credentials" -w '
                    "> ~/.claude/.credentials.json")

_TIMEOUT = 8.0
_MODEL_PROBE_TIMEOUT = 20.0
# The audio round-trip probe transcribes a real ~1s clip — give the model time to answer.
_STT_PROBE_TIMEOUT = 20.0

# Groq sits behind Cloudflare, which answers the default `Python-urllib/x.y` User-Agent with HTTP
# 403 "error code: 1010" even for a valid key — the exact trap where the key works in curl but the
# Settings test says it is rejected. Identify the product on every provider call.
_USER_AGENT = "TINA/0.12"

# (status, body_text) — injectable for tests; None body on network failure.
HttpPost = Callable[[str, dict, dict], tuple[int, str]]
HttpGet = Callable[[str, dict], tuple[int, str]]
# (endpoint, token) → (status, body_text) for the STT audio round-trip — injectable for tests.
TranscribeProbe = Callable[[str, str], tuple[int, str]]


def _post(url: str, payload: dict, headers: dict) -> tuple[int, str]:
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json",
                                          "User-Agent": _USER_AGENT, **headers},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=_MODEL_PROBE_TIMEOUT) as r:
            if r.headers.get("Content-Type", "").split(";", 1)[0] == "application/vnd.amazon.eventstream":
                from llm.bedrock_stream import decode_anthropic_stream
                raw = r.read(2 * 1024 * 1024 + 1)
                if len(raw) > 2 * 1024 * 1024:
                    raise ValueError("Bedrock probe stream exceeds the size limit.")
                return r.status, json.dumps(decode_anthropic_stream(raw))
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _get(url: str, headers: dict) -> tuple[int, str]:
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT, **headers}, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _result(ok: bool, summary: str, **extra) -> dict:
    return {"ok": ok, "summary": summary, **extra}


def _reason(body: str, secret: str = "") -> str:
    """The provider's own one-line explanation (``error.message`` / ``detail`` / plain text).

    A bare 403 hides the difference between "invalid key", "model access denied" and Cloudflare's
    "error code: 1010"; repeating the provider's line is the only honest verdict. The credential is
    stripped in case a provider echoes it."""
    try:
        payload = json.loads(body)
    except (ValueError, TypeError):
        text = (body or "").strip().splitlines()
        reason = text[0][:160] if text else ""
    else:
        reason = ""
        if isinstance(payload, dict):
            error = payload.get("error")
            if isinstance(error, dict) and isinstance(error.get("message"), str):
                reason = error["message"].strip()[:160]
            elif isinstance(error, str):
                reason = error.strip()[:160]
            elif isinstance(payload.get("detail"), str):
                reason = payload["detail"].strip()[:160]
            elif isinstance(payload.get("message") or payload.get("Message"), str):
                reason = (payload.get("message") or payload.get("Message")).strip()
    return (reason.replace(secret, "[redacted]") if secret else reason)[:400]


# ── models ────────────────────────────────────────────────────────────────────────────────────

def test_subscription_credentials(creds_path: str = CREDS_PATH, *, now: Optional[float] = None) -> dict:
    """The mounted credentials file: present → parseable → unexpired. Expiry IS the recurring
    local failure (stale Keychain export), so the failure message ships the exact remedy."""
    if not os.path.isfile(creds_path):
        # docker turns a MISSING host path into an empty dir — same failure, same message.
        return _result(False, "No subscription credentials mounted "
                              "(HOST_CLAUDE_CREDENTIALS unset, or the host file is missing) — "
                              "all setup options: /configuration")
    try:
        with open(creds_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return _result(False, "Credentials file is unreadable or not JSON — re-export it: "
                              + KEYCHAIN_REFRESH)
    oauth = data.get("claudeAiOauth") if isinstance(data, dict) else None
    expires_ms = (oauth or data or {}).get("expiresAt") if isinstance(oauth or data, dict) else None
    if not isinstance(expires_ms, (int, float)):
        return _result(False, "Credentials file has no expiresAt — not a Claude Code "
                              "credential export? Re-export it: " + KEYCHAIN_REFRESH)
    left_h = (expires_ms / 1000.0 - (now if now is not None else time.time())) / 3600.0
    if left_h <= 0:
        return _result(False, "Subscription token EXPIRED (stale Keychain export — the known "
                              "macOS gotcha). Refresh with: " + KEYCHAIN_REFRESH,
                       expired=True)
    return _result(True, f"Subscription credentials valid — token expires in {left_h:.1f} h. "
                         "(File check; inference itself runs in workers.)",
                   expires_in_hours=round(left_h, 1))


def test_custom_endpoint(base_url: str, api_key: str, model: str = "",
                         post: HttpPost = _post) -> dict:
    """A REAL 1-token completion against the configured endpoint. Anthropic-style first
    (``/v1/messages``), OpenAI-compat fallback (``/v1/chat/completions``) on 404/405 — the two
    dialects the dispatch overlay brokers (ANTHROPIC_* vs TINA_LLM_*)."""
    base = base_url.rstrip("/")
    if not base:
        return _result(False, "Custom mode but no Base URL set.")
    model = model or "claude-haiku-4-5-20251001"
    auth = {"x-api-key": api_key, "Authorization": f"Bearer {api_key}",
            "anthropic-version": "2023-06-01"}
    try:
        status, body = post(f"{base}/v1/messages",
                            {"model": model, "max_tokens": 1,
                             "messages": [{"role": "user", "content": "ping"}]}, auth)
        if status in (404, 405):  # not an anthropic dialect — try openai-compat
            status, body = post(f"{base}/v1/chat/completions",
                                {"model": model, "max_tokens": 1,
                                 "messages": [{"role": "user", "content": "ping"}]}, auth)
    except Exception as exc:  # DNS, refused, TLS, timeout — the endpoint itself is the problem
        return _result(False, f"Endpoint unreachable: {exc}")
    if status in (401, 403):
        return _result(False, f"Authentication FAILED at {base} (HTTP {status}) — bad or "
                              "expired API key.", status=status)
    if 200 <= status < 300:
        return _result(True, f"Live completion OK against {base} (model {model}).",
                       status=status)
    detail = body[:200] if body else ""
    return _result(False, f"Endpoint answered HTTP {status}: {detail}", status=status)


def test_openai_responses(api_key: str, model: str, *, base_url: str = "https://api.openai.com/v1",
                          post: HttpPost = _post) -> dict:
    """Probe the Responses endpoint used by Codex app-server and ChatGPT plan tokens."""
    if not api_key:
        return _result(False, "OpenAI credential is missing.")
    if not model.strip():
        return _result(False, "Choose an OpenAI model ID before testing.")
    base = base_url.rstrip("/")
    try:
        status, body = post(
            f"{base}/responses",
            {"model": model.strip(),
             "input": [{"role": "user", "content": [{"type": "input_text", "text": "Reply with OK."}]}],
             "max_output_tokens": 16, "store": False, "stream": True},
            {"Authorization": f"Bearer {api_key}"},
        )
    except Exception as exc:  # DNS, refused connection, TLS, timeout
        return _result(False, f"OpenAI endpoint unreachable: {exc}")
    if status in (401, 403):
        reason = _reason(body, api_key)
        detail = f" Provider says: {reason}" if reason else " Check the key or reconnect ChatGPT."
        return _result(False, f"OpenAI authentication failed (HTTP {status}).{detail}", status=status)
    if 200 <= status < 300:
        return _result(True, f"Responses API inference OK (model {model.strip()}).", status=status)
    detail = body[:200] if body else ""
    return _result(False, f"OpenAI endpoint answered HTTP {status}: {detail}", status=status)


def test_groq(api_key: str, model: str = "", meeting_model: str = "", *,
              post: HttpPost = _post) -> dict:
    """Check the chat tool-call/result round trip, then the summary completion endpoint.

    A text-only ping can pass for models that reject the agent's roles or tools.
    Use the worker's request adapter and a harmless local no-op tool instead.
    """
    from llm.groq_responses import sanitize_responses_request
    from llm.model_capabilities import groq_chat_model_error

    if not api_key:
        return _result(False, "Groq API key is missing. Add it in Settings → Models.")
    target = model.strip() or "openai/gpt-oss-20b"
    summary_model = meeting_model.strip() or target
    if problem := groq_chat_model_error(target):
        return _result(False, problem)
    headers = {"Authorization": f"Bearer {api_key}"}

    def probe(capability: str, path: str, payload: dict) -> tuple[str, Optional[dict]]:
        try:
            status, body = post(f"https://api.groq.com/openai/v1/{path}", payload, headers)
        except Exception as exc:  # DNS, TLS, timeout; never echo credentials from transports
            detail = str(exc).replace(api_key, "[redacted]")[:200]
            return "", _result(False, f"Groq {capability} endpoint unreachable: {detail}")
        if status in (401, 403):
            reason = _reason(body, api_key)
            detail = f" Provider says: {reason}" if reason else " Check the Groq API key and selected model."
            return "", _result(False, f"Groq authentication or model access failed (HTTP {status}).{detail}",
                               status=status)
        if not 200 <= status < 300:
            detail = (body or "").replace(api_key, "[redacted]")[:200]
            return "", _result(False, f"Groq {capability} endpoint answered HTTP {status}: {detail}",
                               status=status)
        return body, None

    tool_name = "tina_connection_check"
    nonce = "tina_probe"
    request = sanitize_responses_request({
        "model": target,
        "input": [
            {"role": "developer", "content": [{"type": "input_text", "text":
                "Call tina_connection_check with nonce tina_probe exactly once. "
                "After it returns, reply only OK. This tool has no side effects."}]},
            {"role": "user", "content": "Check the connection using the tool."},
        ],
        "tools": [{"type": "function", "name": tool_name, "description": "No-op connection check.",
                   "parameters": {"type": "object", "properties": {"nonce": {"type": "string"}},
                                  "required": ["nonce"], "additionalProperties": False}}],
        "tool_choice": "required", "max_output_tokens": 1024,
    })
    raw, error = probe("chat tool calling", "responses", request)
    if error:
        return error
    try:
        output = json.loads(raw)["output"]
        calls = [item for item in output if item.get("type") == "function_call"]
        call, = calls
        valid = (call.get("name") == tool_name and isinstance(call.get("call_id"), str)
                 and bool(call["call_id"]) and json.loads(call["arguments"]) == {"nonce": nonce})
    except (ValueError, KeyError, TypeError, AttributeError):
        valid = False
    if not valid:
        return _result(False, f"Groq chat model {target} did not return a valid tool call. "
                       "TINA chat requires function tools; choose a tool-capable model. "
                       "A successful text completion alone does not verify agent chat.")
    followup = {**request, "tool_choice": "auto", "input": request["input"] + output + [
        {"type": "function_call_output", "call_id": call["call_id"], "output": "OK"},
    ]}
    raw, error = probe("chat tool results", "responses", sanitize_responses_request(followup))
    if error:
        return error
    try:
        response = json.loads(raw)
        text = "".join(part.get("text", "") for item in response.get("output", [])
                       if item.get("type") == "message" for part in item.get("content", [])
                       if part.get("type") == "output_text")
        completed = response.get("status") == "completed" and bool(text.strip())
    except (ValueError, TypeError, AttributeError):
        completed = False
    if not completed:
        return _result(False, f"Groq chat model {target} did not finish the reply after receiving "
                       "a tool result. The agent tool round trip was not verified.")
    _, error = probe("meeting summaries", "chat/completions", {
        "model": summary_model,
        "messages": [{"role": "system", "content": "Answer briefly."},
                     {"role": "user", "content": "Reply with OK."}],
        "max_completion_tokens": 16,
    })
    if error:
        return error
    return _result(True, f"Groq chat tool round trip OK ({target}); meeting summaries "
                         f"inference OK ({summary_model}).", status=200)


def test_deepseek(api_key: str, model: str = "", meeting_model: str = "", *,
                  post: HttpPost = _post) -> dict:
    """Exercise a native Anthropic tool round trip and the summary completion dialect."""
    if not api_key:
        return _result(False, "DeepSeek API key is missing. Add it in Settings → Models.")
    target = model.strip() or "deepseek-flash"
    summary_model = meeting_model.strip() or target
    from control_plane.model_probe import anthropic_tools
    chat = anthropic_tools("DeepSeek", target, api_key, post, lambda payload: (
        "https://api.deepseek.com/anthropic/v1/messages", payload,
        {"Authorization": f"Bearer {api_key}", "anthropic-version": "2023-06-01"},
    ))
    if not chat["ok"]:
        return chat
    requests = (
        ("meeting summaries", "https://api.deepseek.com/chat/completions", {
            "model": summary_model, "max_tokens": 16,
            "messages": [{"role": "user", "content": "Reply with OK."}],
        }, {"Authorization": f"Bearer {api_key}"}),
    )
    for capability, url, payload, headers in requests:
        try:
            status, body = post(url, payload, headers)
        except Exception as exc:
            detail = str(exc).replace(api_key, "[redacted]")[:200]
            return _result(False, f"DeepSeek {capability} endpoint unreachable: {detail}")
        if status in (401, 403):
            reason = _reason(body, api_key)
            detail = f" Provider says: {reason}" if reason else " Check the DeepSeek API key and selected model."
            return _result(False, f"DeepSeek authentication or model access failed (HTTP {status}).{detail}",
                           status=status)
        if not 200 <= status < 300:
            detail = (body or "").replace(api_key, "[redacted]")[:200]
            return _result(False, f"DeepSeek {capability} endpoint answered HTTP {status}: {detail}",
                           status=status)
    return _result(True, f"DeepSeek native chat tool round trip OK ({target}); meeting summaries inference OK "
                         f"({summary_model}).", status=200)


def test_gemini(api_key: str, model: str = "", meeting_model: str = "", *,
                post: HttpPost = _post) -> dict:
    """Probe the native tool round trip and summary API; do not claim CLI execution."""
    if not api_key:
        return _result(False, "Gemini API key is missing. Add a Gemini API key in Settings → Models.")
    from control_plane.model_probe import gemini_tools
    chat_model = model.strip() or "gemini-3.5-flash"
    summary_model = meeting_model.strip() or chat_model
    chat = gemini_tools(chat_model, api_key, post)
    if not chat["ok"]:
        return chat
    try:
        status, body = post(
            "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
            {"model": summary_model, "messages": [{"role": "user", "content": "Reply with OK."}],
             "max_tokens": 16},
            {"Authorization": f"Bearer {api_key}"},
        )
    except Exception as exc:
        detail = str(exc).replace(api_key, "[redacted]")[:200]
        return _result(False, f"Gemini completion endpoint unreachable: {detail}")
    if status in (401, 403):
        reason = _reason(body, api_key)
        detail = f" Provider says: {reason}" if reason else " Check the Gemini API key and selected model."
        return _result(False, f"Gemini authentication or model access failed (HTTP {status}).{detail}",
                       status=status)
    if not 200 <= status < 300:
        detail = (body or "").replace(api_key, "[redacted]")[:200]
        return _result(False, f"Gemini completion endpoint answered HTTP {status}: {detail}", status=status)
    return _result(True, f"Gemini native chat tool round trip OK ({chat_model}); meeting API OK ({summary_model}). "
                         "The full CLI workflow is exercised by sending a chat message.",
                   status=200)


def test_bedrock(api_key: str, model: str, region: str, *, post: HttpPost = _post,
                 require_tools: bool = True) -> dict:
    """Probe the same native Bedrock InvokeModel route used by Claude Code and summaries."""
    if not api_key:
        return _result(False, "AWS Bedrock API key is missing.")
    if not model.strip():
        return _result(False, "Choose a Bedrock model ID before testing.")
    region = region.strip()
    if (not region or len(region) > 32 or not region.islower()
            or not region.replace("-", "").isalnum()):
        return _result(False, "Enter a valid AWS region such as us-east-1.")
    base = f"https://bedrock-runtime.{region}.amazonaws.com/anthropic"
    from llm.anthropic_api import bedrock_request
    if require_tools:
        from control_plane.model_probe import anthropic_tools
        def streaming_request(payload):
            url, body, headers = bedrock_request(base, api_key, model.strip(), payload)
            return url.removesuffix("/invoke") + "/invoke-with-response-stream", body, headers
        result = anthropic_tools("Bedrock", model.strip(), api_key, post,
                                 streaming_request)
        if result["ok"]:
            result["summary"] += f" Streaming API; region: {region}."
        return result
    url, payload, headers = bedrock_request(base, api_key, model.strip(), {
        "max_tokens": 16, "messages": [{"role": "user", "content": "Reply with OK."}],
    })
    try:
        status, body = post(url, payload, headers)
    except Exception as exc:  # DNS, refused connection, TLS, timeout
        return _result(False, f"Bedrock endpoint unreachable: {str(exc).replace(api_key, '[redacted]')}")
    reason = _reason(body, api_key)
    if status in (401, 403):
        return _result(False, f"Bedrock denied model {model.strip()} in {region} (HTTP {status}). "
                       + (reason or "Check the key's region, expiry and this model's access permissions."), status=status)
    if 200 <= status < 300:
        return _result(True, f"Bedrock inference OK (model {model.strip()}, region {region}).", status=status)
    detail = reason
    return _result(False, f"Bedrock answered HTTP {status}: {detail}", status=status)


def run_models_test(config: dict, env: Optional[dict] = None,
                    creds_path: str = CREDS_PATH, post: HttpPost = _post,
                    subject: str = "") -> dict:
    """The EFFECTIVE model credential test — same resolution the dispatch overlay applies
    (Settings user > global config already collapsed by admin-api; env is the floor)."""
    env = env if env is not None else dict(os.environ)
    mode = (config.get("mode") or "").strip()
    base_url = (config.get("base_url") or "").strip() or env.get("ANTHROPIC_BASE_URL", "")
    api_key = (config.get("api_key") or "").strip() or env.get("ANTHROPIC_AUTH_TOKEN", "") \
        or env.get("ANTHROPIC_API_KEY", "")
    if mode in ("groq", "deepseek", "gemini"):
        # Never use an Anthropic/OpenAI env credential as a Groq fallback.
        probe = {"groq": test_groq, "deepseek": test_deepseek, "gemini": test_gemini}[mode]
        out = probe((config.get("api_key") or "").strip(),
                    (config.get("model") or "").strip(),
                    (config.get("meeting_model") or "").strip(), post=post)
        out["mode"] = mode
    elif mode == "custom" or (not mode and base_url and api_key):
        out = test_custom_endpoint(base_url, api_key, (config.get("model") or "").strip(),
                                   post=post)
        out["mode"] = "custom"
    elif mode == "bedrock":
        bedrock_key = (config.get("api_key") or "").strip() or env.get("AWS_BEARER_TOKEN_BEDROCK", "")
        out = test_bedrock(bedrock_key,
                           (config.get("model") or "").strip(),
                           (config.get("region") or env.get("AWS_REGION") or "").strip(), post=post)
        meeting_model = (config.get("meeting_model") or "").strip()
        if out["ok"] and meeting_model and meeting_model != (config.get("model") or "").strip():
            out = test_bedrock(bedrock_key, meeting_model,
                               (config.get("region") or env.get("AWS_REGION") or "").strip(), post=post,
                               require_tools=False)
            out["summary"] = "Meeting model: " + out["summary"]
        out["mode"] = "bedrock"
    elif mode == "openai-api":
        out = test_openai_responses(api_key, (config.get("model") or "").strip(), post=post)
        out["mode"] = "openai-api"
    elif mode == "openai-subscription":
        try:
            from control_plane.openai_auth import access_token
            token = access_token(subject)
            out = test_openai_responses(token, (config.get("model") or "").strip(), post=post)
        except Exception as exc:  # noqa: BLE001 — expose a remedy, never token contents
            out = _result(False, str(exc))
        out["mode"] = "openai-subscription"
    elif mode == "antigravity":
        out = _result(
            False,
            "Antigravity runs in agent-worker, so this API cannot verify its CLI login or model "
            "access. The first agent turn will report authentication and model errors.",
        )
        out["mode"] = "antigravity"
    else:
        out = test_subscription_credentials(creds_path)
        out["mode"] = "subscription"
    translation_model = (config.get("translation_model") or "").strip()
    if out["ok"] and mode in ("groq", "deepseek", "gemini", "bedrock", "openai-api", "openai-subscription", "custom") and translation_model and translation_model not in {config.get("model"), config.get("meeting_model")}:
        if mode in ("groq", "deepseek", "gemini"):
            out = {"groq": test_groq, "deepseek": test_deepseek, "gemini": test_gemini}[mode](
                (config.get("api_key") or "").strip(), (config.get("model") or "").strip(), translation_model, post=post)
        elif mode == "bedrock":
            out = test_bedrock(bedrock_key, translation_model,
                              (config.get("region") or env.get("AWS_REGION") or "").strip(), post=post, require_tools=False)
        elif mode == "openai-api":
            out = test_openai_responses(api_key, translation_model, post=post)
        elif mode == "openai-subscription":
            out = test_openai_responses(token, translation_model, post=post)
        elif mode == "custom":
            out = test_custom_endpoint(base_url, api_key, translation_model, post=post)
        out["mode"] = mode
        out["summary"] = "Translation model: " + out["summary"]
    # Non-secret provenance so the UI can say WHAT was tested.
    out["config"] = {k: v for k, v in config.items() if k in ("mode", "model", "meeting_model", "translation_model",
                                                              "base_url") and v}
    return out


# ── transcription ─────────────────────────────────────────────────────────────────────────────

# The OpenAI-compatible transcriptions path every consumer agrees on. Appended only when the
# configured URL does not already carry it — the one rule shared with the config.v1 probe
# (deploy/contracts/config.v1/preflight.py:probe_url), the bot's client, and the dictation route.
_STT_PATH = "/v1/audio/transcriptions"

def _transcribe_probe(endpoint: str, token: str, model: str = "whisper-1") -> tuple:
    """POST the shared audio probe body — the same request the boot preflight makes."""
    from control_plane.config_preflight import audio_probe_body

    content_type, body = audio_probe_body(model)
    headers = {"Content-Type": content_type, "User-Agent": _USER_AGENT}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(
        endpoint, data=body, method="POST",
        headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=_STT_PROBE_TIMEOUT) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def _verify_transcribes(base: str, token: str, source: str, probe: TranscribeProbe,
                        account: str = "") -> dict:
    """Grade the backend by the ONE question the operator is actually asking: will a bot get a
    transcript out of this? Answered by sending real audio — the same request a bot's first chunk
    makes, and the same body the boot preflight sends.

    An EMPTY body cannot answer it: a metered backend answers an empty POST the same way whether
    the credential is funded or worthless, which is how a token that 402s every segment of every
    meeting used to test green here. Nor can the account's balance answer it — a billing-exempt
    account reports 0.0 minutes and transcribes perfectly, so a balance threshold condemns the
    working credential and clears nothing. Sending audio makes the verdict independent of whose
    token it is, so no account identity is named anywhere in this codebase."""
    endpoint = base if base.endswith(_STT_PATH) else base + _STT_PATH
    who = f" ({account})" if account else ""
    try:
        status, body = probe(endpoint, token)
    except Exception as exc:
        return _result(False, f"Backend unreachable: {exc}", source=source)
    if status in (401, 403):
        return _result(False, f"Token REJECTED by {endpoint} (HTTP {status}).", source=source,
                       status=status)
    if status == 402:
        detail = (body or "").strip()[:160]
        return _result(False, f"Token is valid{who} but cannot pay for transcription (HTTP 402) — "
                              f"every segment will fail and meetings will complete with NO "
                              f"transcript. Top up the account or use a token that can transcribe."
                              + (f" Backend said: {detail}" if detail else ""),
                       source=source, status=status, account=account or None)
    if status == 404:
        return _result(False, f"No transcriptions endpoint at {endpoint} (HTTP 404) — check the "
                              "URL shape; some gateways also answer 404 for a rejected key.",
                       source=source, status=status)
    if status >= 500:
        return _result(False, f"Backend error at {endpoint} (HTTP {status}).", source=source,
                       status=status)
    if not 200 <= status < 300:
        return _result(False, f"Transcription request rejected by {endpoint} (HTTP {status}).",
                       source=source, status=status)
    try:
        transcript = json.loads(body)
    except (ValueError, TypeError):
        transcript = None
    if not isinstance(transcript, dict) or not isinstance(transcript.get("text"), str):
        return _result(False, f"Invalid transcription response from {endpoint} (HTTP {status}): "
                              "expected a JSON object with a text string.", source=source, status=status)
    return _result(True, f"OK — {endpoint} transcribed the probe clip{who} (HTTP {status}).",
                   source=source, status=status, account=account or None)


def run_transcription_test(url: str, token: str, source: str, get: HttpGet = _get,
                           probe: TranscribeProbe = _transcribe_probe,
                           model: str = "whisper-1", require_token: bool = True) -> dict:
    """A real round-trip test of the effective STT backend: transcribe a ~1s probe clip with the
    configured credentials — the same request (and the same probe body) a bot's first chunk and the boot
    preflight make, so the wizard can never green what the deployment refuses.

    The endpoint's own answer is the verdict. Neither of the two indirect oracles survives contact
    with reality: an empty-body POST is answered identically for a funded and a worthless
    credential, and ``balance_minutes`` reads 0.0 for a billing-exempt account that transcribes
    perfectly — the 2026-07-19 recurrence was exactly a zero-balance token probing green while a
    zero-balance *exempt* token did the actual work. Sending audio asks the real question and keeps
    every account identity out of this codebase. ``/balance`` is still consulted first, but only to
    NAME the account in the verdict (a courtesy, never the oracle)."""
    base = (url or "").strip().rstrip("/")
    if not base:
        return _result(False, "No transcription backend configured at any level "
                              "(user, global, or deployment env).", source=source)
    # Bots post to {url}/v1/audio/transcriptions — strip the path for the account lookup.
    probe_base = base
    for suffix in ("/v1/audio/transcriptions", "/v1/audio", "/v1"):
        if probe_base.endswith(suffix):
            probe_base = probe_base[: -len(suffix)]
            break
    if require_token and not token:
        return _result(False, f"Backend {probe_base} configured but NO token set ({source}).",
                       source=source)
    account = ""
    try:
        status, body = get(f"{probe_base}/balance", {"X-API-Key": token})
        if status == 200:
            try:
                account = (json.loads(body) or {}).get("email") or ""
            except ValueError:
                account = ""
    except Exception:
        pass  # no /balance ⇒ not a TINA gateway; the round-trip below is the oracle either way
    selected_probe = probe
    if probe is _transcribe_probe and model != "whisper-1":
        selected_probe = lambda endpoint, auth: _transcribe_probe(endpoint, auth, model)
    return _verify_transcribes(base, token, source, selected_probe, account)
