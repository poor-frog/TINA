"""Isolated local subprocess pool for stateless non-voice CompletionPort tasks on staging."""
from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
from threading import BoundedSemaphore

from fastapi import HTTPException

from control_plane.meeting_voice_completion import _VOICE_MODEL_ENV_KEYS

log = logging.getLogger(__name__)
_pool_slots = BoundedSemaphore(4)
_SUPPORTED_TASKS = frozenset({"polish", "translate", "knowledge", "discussion"})
_MAX_OUTPUT_CHARS = 50_000


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
    env = {key: os.environ[key] for key in (
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_DEFAULT_REGION", "AWS_REGION",
        "PATH", "PYTHONPATH", "TINA_LLM_PROVIDER", "TINA_LLM_MODEL",
    ) if key in os.environ}
    env.update(HOME="/tmp", TINA_CHAT_SESSION=session_id)
    if model_env:
        for key, value in model_env.items():
            if key in _VOICE_MODEL_ENV_KEYS and value:
                env[key] = value
        if env.get("TINA_LLM_PROVIDER") != "bedrock-converse":
            env.pop("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", None)
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
