"""Isolated local subprocess pool for stateless non-voice CompletionPort tasks on staging."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading
from threading import BoundedSemaphore
from typing import Callable

from fastapi import HTTPException

from control_plane.meeting_voice_completion import _VOICE_MODEL_ENV_KEYS

log = logging.getLogger(__name__)
_pool_slots = BoundedSemaphore(4)
_background_slots = BoundedSemaphore(4)
_SUPPORTED_TASKS = frozenset({"polish", "translate", "knowledge", "discussion"})
_BACKGROUND_TASKS = frozenset({"canonical_notes", "meeting_state"})
_MAX_OUTPUT_CHARS = 50_000


def _build_subprocess_env(model_env: dict[str, str] | None, *, extra: dict[str, str]) -> dict[str, str]:
    env = {key: os.environ[key] for key in (
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_DEFAULT_REGION", "AWS_REGION",
        "PATH", "PYTHONPATH", "TINA_LLM_PROVIDER", "TINA_LLM_MODEL",
    ) if key in os.environ}
    env.update(HOME="/tmp", **extra)
    if model_env:
        for key, value in model_env.items():
            if key in _VOICE_MODEL_ENV_KEYS and value:
                env[key] = value
        if env.get("TINA_LLM_PROVIDER") != "bedrock-converse":
            env.pop("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", None)
    return env


def dispatch_background_meeting_job(
    *,
    task: str,
    unit_id: str,
    owner: str,
    inline: str,
    redis_url: str,
    workspace_path: str,
    out_topic: str,
    model_env: dict[str, str] | None = None,
    s3_sync_owner: Callable[[], None] | None = None,
    timeout_seconds: float = 120.0,
) -> str:
    """Run a trusted tool-less background meeting job (canonical_notes / meeting_state) asynchronously."""
    if task not in _BACKGROUND_TASKS:
        raise ValueError(f"Unsupported background meeting task: {task}")
    env = _build_subprocess_env(model_env, extra={
        "REDIS_URL": redis_url,
        "TINA_OWNER": owner,
        "TINA_WORKSPACE_PATH": workspace_path,
        "TINA_UNIT_OUT_TOPIC": out_topic,
    })

    def _run() -> None:
        if not _background_slots.acquire(timeout=30.0):
            log.warning("background meeting completion busy; dropping task=%s unit=%s", task, unit_id)
            return
        try:
            if s3_sync_owner is not None:
                try:
                    s3_sync_owner()
                except Exception:  # noqa: BLE001 — fall soft to default meeting config
                    log.warning("background S3 workspace hydration skipped for owner=%s", owner)
            result = subprocess.run(
                [sys.executable, "-m", "worker.local_completion"],
                input=json.dumps({"task": task, "inline": inline}, ensure_ascii=False),
                text=True, encoding="utf-8",
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                cwd="/tmp", env=env,
                timeout=max(5.0, float(timeout_seconds)),
            )
            if result.returncode:
                log.warning("background meeting job failed task=%s unit=%s rc=%s", task, unit_id, result.returncode)
        except subprocess.TimeoutExpired:
            log.warning("background meeting job timed out task=%s unit=%s", task, unit_id)
        except Exception:  # noqa: BLE001
            log.exception("background meeting job crashed task=%s unit=%s", task, unit_id)
        finally:
            _background_slots.release()

    threading.Thread(target=_run, daemon=True, name=f"bg-{task}-{unit_id[:24]}").start()
    return unit_id


def complete(
    *,
    task: str,
    inline: str,
    session_id: str,
    label: str,
    timeout_seconds: float = 60.0,
    model_env: dict[str, str] | None = None,
) -> str:
    if task not in _SUPPORTED_TASKS:
        raise HTTPException(400, f"Unsupported completion task: {task}")
    if not _pool_slots.acquire(blocking=False):
        raise HTTPException(429, f"{label} is busy; retry shortly")
    env = _build_subprocess_env(model_env, extra={"TINA_CHAT_SESSION": session_id})
    try:
        result = subprocess.run(
            [sys.executable, "-m", "worker.local_completion"],
            input=json.dumps({"task": task, "inline": inline}, ensure_ascii=False),
            text=True, encoding="utf-8",
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd="/tmp", env=env,
            timeout=max(1.0, float(timeout_seconds)),
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(504, f"{label} timed out") from exc
    finally:
        _pool_slots.release()
    if result.returncode or not result.stdout:
        log.warning("local completion failed task=%s returncode=%s", task, result.returncode)
        raise HTTPException(502, f"{label} is unavailable")
    try:
        envelope = json.loads(result.stdout)
    except ValueError as exc:
        log.warning("local completion emitted invalid envelope task=%s", task)
        raise HTTPException(502, f"{label} is unavailable") from exc
    if not isinstance(envelope, dict):
        raise HTTPException(502, f"{label} is unavailable")
    if task == "translate" and envelope.get("translation_error"):
        from shared.translation_text import TRANSLATION_FAILURE_STATUS
        code = envelope["translation_error"]
        status = TRANSLATION_FAILURE_STATUS.get(code, 503) if isinstance(code, str) else 503
        raise HTTPException(status_code=status, detail="Live translation could not complete")
    text = envelope.get("text")
    if not isinstance(text, str):
        raise HTTPException(502, f"{label} is unavailable")
    if len(text) > _MAX_OUTPUT_CHARS:
        raise HTTPException(502, f"{label} returned too much text")
    if task == "translate" and not envelope.get("complete"):
        raise HTTPException(502, "Live translation could not complete")
    if not text.strip():
        raise HTTPException(502, f"{label} returned no usable text")
    return text
