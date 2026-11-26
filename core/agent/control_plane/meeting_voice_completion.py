"""Run lease-checked voice completions without provisioning a task per model call."""

import json
import logging
import os
import subprocess
import sys
import time
from threading import BoundedSemaphore
from uuid import UUID

from fastapi import HTTPException
from shared.voice_trace import log as voice_trace_log

log = logging.getLogger(__name__)
_slots = BoundedSemaphore(2)


def _log_worker_timings(stderr: str | bytes | None) -> None:
    if isinstance(stderr, bytes):
        stderr = stderr.decode('utf-8', errors='replace')
    for line in (stderr or '').splitlines():
        if not line.startswith('{"type": "voice_stage"') or len(line) > 1024:
            continue
        try:
            record = json.loads(line)
            request_id = UUID(record['request_id'])
            span_id = UUID(record['span_id'])
            stage, elapsed, status = (record[k] for k in ('stage', 'elapsed_ms', 'status'))
        except (ValueError, TypeError, KeyError, AttributeError):
            continue
        if (stage in ('source_selection', 'generation', 'format_repair', 'verify', 'repair', 'plan', 'intent', 'source_routing', 'rerank')
                and type(elapsed) is int and 0 <= elapsed <= 60000
                and status in ('started', 'ok', 'error', 'cancelled')):
            voice_trace_log.info('Voice worker request_id=%s span_id=%s stage=%s elapsed_ms=%d status=%s',
                                 request_id, span_id, stage, elapsed, status)


def _store_provider_issue(redis_url: str, turn: dict, issue: str | None) -> None:
    import redis

    mid, holder = turn["meeting_id"], turn["holder"]
    session, _, _ = holder.partition(":")
    try:
        with redis.Redis.from_url(redis_url, socket_timeout=1, socket_connect_timeout=1) as connection:
            connection.eval(
                "if redis.call('get',KEYS[1])~=ARGV[1] then return 0 end "
                "if ARGV[2]=='' then return redis.call('del',KEYS[2]) end "
                "return redis.call('set',KEYS[2],ARGV[2],'EX',300)",
                2, f"meeting:voice:{mid}:lock", f"meeting:voice:{mid}:provider-issue",
                holder, json.dumps({"session_uid": session, "code": issue}) if issue else "",
            )
    except redis.RedisError:
        log.warning("ChatGPT plan status could not be recorded")


_VOICE_MODEL_ENV_KEYS = (
    "TINA_LLM_PROVIDER",
    "TINA_LLM_MODEL",
    "TINA_LLM_BASE_URL",
    "TINA_LLM_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_BEARER_TOKEN_BEDROCK",
)


def resolve_voice_model_env(model_config: dict | None, *, allowlist: str = "", subject: str = "") -> dict[str, str]:
    """Translate a subject's Settings -> Models config into CompletionPort env vars for voice."""
    if not isinstance(model_config, dict):
        return {}
    mode = (model_config.get("mode") or "").strip()
    if not mode or mode in ("openai-subscription", "antigravity"):
        return {}
    from control_plane.dispatch import overlay_model_config
    staged: dict[str, str] = {}
    overlay_model_config(staged, model_config, allowlist=allowlist, subject=subject)
    chosen_model = (staged.get("TINA_MEETING_MODEL") or staged.get("TINA_LLM_MODEL") or "").strip()
    if mode == "bedrock" and not (staged.get("AWS_BEARER_TOKEN_BEDROCK") or "").strip():
        result: dict[str, str] = {"TINA_LLM_PROVIDER": "bedrock-converse"}
        if chosen_model:
            result["TINA_LLM_MODEL"] = chosen_model
        for region_key in ("AWS_REGION", "AWS_DEFAULT_REGION"):
            if staged.get(region_key):
                result[region_key] = staged[region_key]
        return result
    provider = (staged.get("TINA_LLM_PROVIDER") or "").strip()
    if not provider:
        return {}
    if mode in ("groq", "deepseek", "gemini", "openai-api") and not (staged.get("TINA_LLM_API_KEY") or "").strip():
        return {}
    if mode == "anthropic" and not any(
        (staged.get(k) or "").strip() for k in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "TINA_LLM_API_KEY")
    ):
        return {}
    if mode == "custom" and not (staged.get("TINA_LLM_BASE_URL") or "").strip():
        return {}
    result = {key: staged[key] for key in _VOICE_MODEL_ENV_KEYS if staged.get(key)}
    if chosen_model:
        result["TINA_LLM_MODEL"] = chosen_model
    return result


def complete(payload: dict, source: dict, redis_url: str, *, chatgpt_plan=False,
             model_env: dict[str, str] | None = None) -> str:
    if not payload.get("voice_turn"):
        raise HTTPException(409, "The staging voice completion requires a current live voice turn")
    if source.get("use_sandbox_agent"):
        raise HTTPException(409, "Sandbox voice agent is unavailable on local completion workers; use Direct LLM")
    deadline = time.time() + 45
    if type(source.get("retrieval_deadline_ms")) is int:
        deadline = min(deadline, source["retrieval_deadline_ms"] / 1000)
    if deadline <= time.time():
        raise HTTPException(504, "Voice retrieval timed out")
    if not _slots.acquire(blocking=False):
        raise HTTPException(429, "Voice completion is busy")
    env = {key: os.environ[key] for key in (
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_DEFAULT_REGION", "AWS_REGION",
        "PATH", "PYTHONPATH", "TINA_LLM_PROVIDER", "TINA_LLM_MODEL",
    ) if key in os.environ}
    env.update(REDIS_URL=redis_url, HOME="/tmp",
               TINA_CHAT_SESSION="meeting-knowledge-" + payload["request_id"])
    if source.get("mode") == "voice_web" and not chatgpt_plan and os.environ.get("TINA_AGENT_REACH_URL"):
        env["TINA_AGENT_REACH_URL"] = os.environ["TINA_AGENT_REACH_URL"]
    try:
        if chatgpt_plan:
            from control_plane.aws_voice_chatgpt import access_token
            from control_plane.openai_auth import ChatGPTAuthError
            try:
                token = access_token(redis_url)
            except ChatGPTAuthError as exc:
                log.warning("ChatGPT plan connection is unavailable")
                _store_provider_issue(redis_url, payload["voice_turn"], "reconnect_required")
                raise HTTPException(503, "Reconnect ChatGPT for the staging voice pilot") from exc
            env.update(ACCESS_TOKEN=token, TINA_LLM_PROVIDER="chatgpt-plan", TINA_CHATGPT_VOICE_PILOT="1",
                       TINA_LLM_MODEL=os.environ["TINA_CHATGPT_VOICE_MODEL"])
            env.pop("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", None)
        elif model_env:
            for key, value in model_env.items():
                if key in _VOICE_MODEL_ENV_KEYS and value:
                    env[key] = value
            if env.get("TINA_LLM_PROVIDER") != "bedrock-converse":
                env.pop("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", None)
        remaining = deadline - time.time()
        if remaining <= 0:
            raise HTTPException(504, "Voice retrieval timed out")
        result = subprocess.run(
            [sys.executable, "-m", "worker.meeting_voice_local"],
            input=json.dumps(payload, ensure_ascii=False), text=True, encoding="utf-8",
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd="/tmp", env=env,
            timeout=remaining,
        )
    except subprocess.TimeoutExpired as exc:
        _log_worker_timings(exc.stderr)
        raise HTTPException(504, "Voice completion timed out") from exc
    finally:
        _slots.release()
    _log_worker_timings(result.stderr)
    if chatgpt_plan and "TINA_CHATGPT_PLAN_USAGE_LIMIT" in result.stderr.splitlines():
        log.warning("ChatGPT plan usage limit reached for the staging voice pilot")
        _store_provider_issue(redis_url, payload["voice_turn"], "usage_limit")
        raise HTTPException(429, "ChatGPT plan usage limit reached")
    if chatgpt_plan and "TINA_CHATGPT_PLAN_RECONNECT_REQUIRED" in result.stderr.splitlines():
        _store_provider_issue(redis_url, payload["voice_turn"], "reconnect_required")
        raise HTTPException(503, "Reconnect ChatGPT for the staging voice pilot")
    if result.returncode or not result.stdout or len(result.stdout) > 50_000:
        log.warning("Voice completion returned no usable text")
        raise HTTPException(502, "Voice completion is unavailable")
    if chatgpt_plan:
        _store_provider_issue(redis_url, payload["voice_turn"], None)
    return result.stdout
