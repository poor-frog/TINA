"""Run lease-checked voice completions without provisioning a task per model call."""

import atexit
import hashlib
import json
import logging
import os
import re
import selectors
import subprocess
import sys
import threading
import time
from threading import BoundedSemaphore
from types import SimpleNamespace
from uuid import UUID

from fastapi import HTTPException
from shared.voice_trace import log as voice_trace_log

log = logging.getLogger(__name__)
_DEFAULT_SLOTS = 8
_SLOT_WAIT_SECONDS = 2.0
_FAST_AUX_VOICE_MODES = frozenset({"voice_source_intent", "voice_intent", "voice_plan"})
_ORIG_SUBPROCESS_RUN = subprocess.run
_WARM_WORKER_IDLE_TTL = 180.0
_WARM_RESPONSE_MAX_BYTES = 1_048_576


def _configured_slots() -> int:
    raw = os.environ.get("TINA_VOICE_COMPLETION_SLOTS", "").strip()
    if raw:
        try:
            value = int(raw)
            if 1 <= value <= 16:
                return value
        except ValueError:
            pass
    return _DEFAULT_SLOTS


_slots = BoundedSemaphore(_configured_slots())
_SAFE_ERROR_RE = re.compile(r"^([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b")
_LOG_ERROR_FIELD_RE = re.compile(r"\berror=([A-Z][A-Za-z0-9_]*(?:Error|Exception))\b")


class _WarmVoiceWorker:
    """Persistent subprocess running worker.meeting_voice_local --daemon for one credential fingerprint."""

    def __init__(self, env_key: str, worker_env: dict[str, str]):
        self.env_key = env_key
        self.last_used = time.monotonic()
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "worker.meeting_voice_local", "--daemon"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd="/tmp",
            env=worker_env,
            bufsize=0,
        )
        self._buf = bytearray()

    def alive(self) -> bool:
        return self.proc.poll() is None

    def close(self) -> None:
        proc = self.proc
        try:
            if proc.stdin is not None:
                proc.stdin.close()
        except OSError:
            pass
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=1.0)
        except OSError:
            pass
        try:
            if proc.stdout is not None:
                proc.stdout.close()
        except OSError:
            pass

    def kill(self) -> None:
        proc = self.proc
        try:
            proc.kill()
            proc.wait(timeout=1.0)
        except (OSError, subprocess.TimeoutExpired):
            pass
        for stream in (proc.stdin, proc.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def request(self, payload: dict, session: str, *, timeout: float) -> SimpleNamespace:
        if self.proc.stdin is None or self.proc.stdout is None or not self.alive():
            raise BrokenPipeError("Warm voice worker is not running")
        line = (json.dumps({"payload": payload, "session": session}, ensure_ascii=False) + "\n").encode("utf-8")
        self.proc.stdin.write(line)
        self.proc.stdin.flush()
        deadline = time.monotonic() + max(0.05, float(timeout))
        fd = self.proc.stdout.fileno()
        with selectors.DefaultSelector() as sel:
            sel.register(fd, selectors.EVENT_READ)
            while True:
                nl = self._buf.find(b"\n")
                if nl != -1:
                    raw = bytes(self._buf[:nl])
                    del self._buf[:nl + 1]
                    break
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise subprocess.TimeoutExpired(cmd="worker.meeting_voice_local", timeout=timeout)
                events = sel.select(timeout=remaining)
                if not events:
                    raise subprocess.TimeoutExpired(cmd="worker.meeting_voice_local", timeout=timeout)
                chunk = os.read(fd, 65536)
                if not chunk:
                    raise EOFError("Warm voice worker exited before replying")
                self._buf.extend(chunk)
                if len(self._buf) > _WARM_RESPONSE_MAX_BYTES:
                    raise ValueError("Warm voice worker response exceeded bound")
        self.last_used = time.monotonic()
        body = json.loads(raw.decode("utf-8"))
        return SimpleNamespace(
            returncode=int(body.get("returncode", 1)),
            stdout=str(body.get("stdout") or ""),
            stderr=str(body.get("stderr") or ""),
        )


class _WarmVoicePool:
    """Credential-isolated pool of warm voice completion worker processes."""

    def __init__(self, *, max_idle: int | None = None, idle_ttl: float = _WARM_WORKER_IDLE_TTL):
        self._lock = threading.Lock()
        self._idle: dict[str, list[_WarmVoiceWorker]] = {}
        self._max_idle = max_idle or max(_configured_slots() * 2, 8)
        self._idle_ttl = idle_ttl

    @staticmethod
    def _env_key(worker_env: dict[str, str]) -> str:
        return hashlib.sha256(
            json.dumps(sorted(worker_env.items()), ensure_ascii=False).encode("utf-8")
        ).hexdigest()

    def _evict_locked(self, now: float) -> list[_WarmVoiceWorker]:
        stale: list[_WarmVoiceWorker] = []
        for key in list(self._idle):
            kept: list[_WarmVoiceWorker] = []
            for worker in self._idle[key]:
                if not worker.alive() or now - worker.last_used > self._idle_ttl:
                    stale.append(worker)
                else:
                    kept.append(worker)
            if kept:
                self._idle[key] = kept
            else:
                self._idle.pop(key, None)
        total = sum(len(items) for items in self._idle.values())
        while total > self._max_idle:
            oldest_key = min(self._idle, key=lambda k: self._idle[k][0].last_used)
            stale.append(self._idle[oldest_key].pop(0))
            if not self._idle[oldest_key]:
                self._idle.pop(oldest_key, None)
            total -= 1
        return stale

    def _checkout(self, env_key: str, worker_env: dict[str, str]) -> tuple[_WarmVoiceWorker, bool]:
        with self._lock:
            stale = self._evict_locked(time.monotonic())
            bucket = self._idle.get(env_key)
            worker = bucket.pop() if bucket else None
            if bucket is not None and not bucket:
                self._idle.pop(env_key, None)
        for old in stale:
            old.close()
        if worker is not None and worker.alive():
            return worker, True
        if worker is not None:
            worker.close()
        return _WarmVoiceWorker(env_key, worker_env), False

    def _checkin(self, worker: _WarmVoiceWorker) -> None:
        if not worker.alive():
            worker.close()
            return
        with self._lock:
            self._idle.setdefault(worker.env_key, []).append(worker)
            stale = self._evict_locked(time.monotonic())
        for old in stale:
            old.close()

    def run(self, payload: dict, env: dict[str, str], *, timeout: float) -> SimpleNamespace:
        session = env["TINA_CHAT_SESSION"]
        worker_env = {k: v for k, v in env.items() if k != "TINA_CHAT_SESSION"}
        env_key = self._env_key(worker_env)
        deadline = time.monotonic() + max(0.05, float(timeout))
        for attempt in range(2):
            worker, reused = self._checkout(env_key, worker_env)
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                worker.kill()
                raise subprocess.TimeoutExpired(cmd="worker.meeting_voice_local", timeout=timeout)
            try:
                result = worker.request(payload, session, timeout=remaining)
            except subprocess.TimeoutExpired:
                worker.kill()
                raise
            except (BrokenPipeError, EOFError, OSError, ValueError):
                worker.kill()
                if reused and attempt == 0 and deadline - time.monotonic() > 0.5:
                    continue
                return SimpleNamespace(returncode=1, stdout="", stderr="RuntimeError: warm worker unavailable\n")
            self._checkin(worker)
            return result
        return SimpleNamespace(returncode=1, stdout="", stderr="RuntimeError: warm worker unavailable\n")

    def shutdown(self) -> None:
        with self._lock:
            workers = [w for items in self._idle.values() for w in items]
            self._idle.clear()
        for worker in workers:
            worker.close()


_warm_pool = _WarmVoicePool()
_WARM_POOL_ENABLED = True
atexit.register(_warm_pool.shutdown)


def _exec_worker(payload: dict, env: dict[str, str], *, timeout: float):
    """Execute one voice completion, using warm credential-isolated workers unless patched/disabled."""
    if not _WARM_POOL_ENABLED or subprocess.run is not _ORIG_SUBPROCESS_RUN:
        return subprocess.run(
            [sys.executable, "-m", "worker.meeting_voice_local"],
            input=json.dumps(payload, ensure_ascii=False), text=True, encoding="utf-8",
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            cwd="/tmp", env=env,
            timeout=timeout,
        )
    return _warm_pool.run(payload, env, timeout=timeout)


def _stderr_error_kind(stderr: str | bytes | None) -> str:
    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    found = "unknown"
    for line in (stderr or "").splitlines():
        stripped = line.strip()
        match = _SAFE_ERROR_RE.match(stripped) or _LOG_ERROR_FIELD_RE.search(stripped)
        if match:
            found = match.group(1)
    return found


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
    if str(model_config.get("meeting_use_default") or "").strip().lower() == "true":
        return {}
    mode = (model_config.get("mode") or "").strip()
    if not mode:
        from control_plane.dispatch import BUILTIN_BEDROCK_MODELS, _allowlisted, builtin_bedrock_model
        chosen = builtin_bedrock_model(model_config)
        if not chosen:
            meeting_choice = (model_config.get("meeting_model") or "").strip()
            if meeting_choice in BUILTIN_BEDROCK_MODELS:
                chosen = meeting_choice
        if (
            chosen
            and (os.environ.get("TINA_LLM_PROVIDER") or "").strip() == "bedrock-converse"
            and _allowlisted(chosen, allowlist)
        ):
            return {"TINA_LLM_PROVIDER": "bedrock-converse", "TINA_LLM_MODEL": chosen}
        return {}
    if mode in ("openai-subscription", "antigravity"):
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


def fallback_reason_from_stderr(stderr: str | bytes | None) -> str | None:
    """Detect the secret-free fallback marker emitted on external provider 401/403/429."""
    from llm.errors import PROVIDER_FALLBACK_MARKER

    if isinstance(stderr, bytes):
        stderr = stderr.decode("utf-8", errors="replace")
    for line in (stderr or "").splitlines():
        trimmed = line.strip()
        if trimmed.startswith(PROVIDER_FALLBACK_MARKER):
            reason = trimmed[len(PROVIDER_FALLBACK_MARKER):].strip()
            if reason in ("auth", "rate_limit"):
                return reason
    return None


def can_fallback_to_bedrock(model_env: dict[str, str] | None) -> bool:
    """True when an external/custom model_env (or non-default Bedrock model like Sonnet 4.6)
    can fall back to deployment-default Amazon Bedrock (e.g. Nova Lite) on 401/403/429."""
    if not model_env:
        return False
    if (os.environ.get("TINA_LLM_PROVIDER") or "").strip() != "bedrock-converse":
        return False
    provider = (model_env.get("TINA_LLM_PROVIDER") or "").strip()
    if provider != "bedrock-converse" or bool((model_env.get("AWS_BEARER_TOKEN_BEDROCK") or "").strip()):
        return True
    selected_model = (model_env.get("TINA_LLM_MODEL") or "").strip()
    default_model = (os.environ.get("TINA_LLM_MODEL") or "").strip()
    return bool(selected_model and default_model and selected_model != default_model)


def is_heavy_builtin_bedrock(model_env: dict[str, str] | None) -> bool:
    """True when selecting a non-default built-in Bedrock model (e.g. Claude Sonnet 4.6 over Nova Lite)."""
    if not model_env:
        return False
    if (os.environ.get("TINA_LLM_PROVIDER") or "").strip() != "bedrock-converse":
        return False
    if (model_env.get("TINA_LLM_PROVIDER") or "").strip() != "bedrock-converse":
        return False
    if (model_env.get("AWS_BEARER_TOKEN_BEDROCK") or "").strip():
        return False
    selected_model = (model_env.get("TINA_LLM_MODEL") or "").strip()
    default_model = (os.environ.get("TINA_LLM_MODEL") or "").strip()
    return bool(selected_model and default_model and selected_model != default_model)


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
    remaining_wait = min(_SLOT_WAIT_SECONDS, max(0.0, deadline - time.time()))
    if not _slots.acquire(timeout=remaining_wait):
        if deadline <= time.time():
            raise HTTPException(504, "Voice retrieval timed out")
        raise HTTPException(429, "Voice completion is busy")
    base_env = {key: os.environ[key] for key in (
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_DEFAULT_REGION", "AWS_REGION",
        "PATH", "PYTHONPATH", "TINA_LLM_PROVIDER", "TINA_LLM_MODEL",
    ) if key in os.environ}
    base_env.update(REDIS_URL=redis_url, HOME="/tmp",
                    TINA_CHAT_SESSION="meeting-knowledge-" + payload["request_id"])
    if source.get("mode") == "voice_web" and not chatgpt_plan and os.environ.get("TINA_AGENT_REACH_URL"):
        base_env["TINA_AGENT_REACH_URL"] = os.environ["TINA_AGENT_REACH_URL"]
    env = dict(base_env)
    heavy_bedrock = not chatgpt_plan and is_heavy_builtin_bedrock(model_env)
    use_fast_aux = heavy_bedrock and source.get("mode") in _FAST_AUX_VOICE_MODES
    effective_model_env = None if use_fast_aux else model_env
    fallback_eligible = not chatgpt_plan and can_fallback_to_bedrock(effective_model_env)
    run_payload = payload
    if heavy_bedrock and source.get("mode") == "voice" and base_env.get("TINA_LLM_MODEL"):
        run_payload = {**payload, "voice_fast_model": base_env["TINA_LLM_MODEL"]}
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
        elif effective_model_env:
            for key, value in effective_model_env.items():
                if key in _VOICE_MODEL_ENV_KEYS and value:
                    env[key] = value
            if env.get("TINA_LLM_PROVIDER") != "bedrock-converse":
                env.pop("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", None)
            if fallback_eligible:
                env["TINA_ALLOW_FALLBACK_RETRY"] = "1"
        remaining = deadline - time.time()
        if remaining <= 0:
            raise HTTPException(504, "Voice retrieval timed out")
        result = _exec_worker(run_payload, env, timeout=remaining)
        if fallback_eligible and (result.returncode or not result.stdout):
            reason = fallback_reason_from_stderr(result.stderr)
            if reason is not None:
                _log_worker_timings(result.stderr)
                fallback_remaining = deadline - time.time()
                if fallback_remaining > 1.0:
                    log.warning(
                        "Voice completion external provider failed reason=%s; falling back to Amazon Bedrock",
                        reason,
                    )
                    result = _exec_worker(payload, dict(base_env), timeout=fallback_remaining)
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
        log.warning(
            "Voice completion returned no usable text returncode=%s stdout_len=%d error=%s",
            result.returncode,
            len(result.stdout or ""),
            _stderr_error_kind(result.stderr),
        )
        raise HTTPException(502, "Voice completion is unavailable")
    if chatgpt_plan:
        _store_provider_issue(redis_url, payload["voice_turn"], None)
    return result.stdout
