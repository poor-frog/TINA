"""anthropic_api.py — CompletionPort adapter for the Anthropic Messages API (and compatibles).

For deployments that point completions directly at ``api.anthropic.com`` — or at any endpoint
speaking the Messages dialect (LiteLLM proxies, DeepSeek/GLM/Kimi Anthropic-compatible endpoints).
Raw httpx, no vendor SDK (same doctrine as ``openai_compat``). Named ``anthropic_api`` to never
shadow the ``anthropic`` pip package.

Config (constructor args win over env): ``TINA_LLM_BASE_URL`` (default ``https://api.anthropic.com``),
``TINA_LLM_API_KEY`` (falls back ``ANTHROPIC_AUTH_TOKEN`` → ``ANTHROPIC_API_KEY``),
``TINA_LLM_MODEL``, ``TINA_LLM_MAX_TOKENS`` (the Messages API requires max_tokens; default 4096).
"""
from __future__ import annotations

import os
from urllib.parse import quote, urlparse
from typing import Optional

import httpx

from llm.errors import LLMAuthError, LLMConfigError, LLMError
from llm.ports import CompletionResult, schema_system

_DEFAULT_BASE = "https://api.anthropic.com"
_API_VERSION = "2023-06-01"


def bedrock_request(base: str, key: str, model: str, payload: dict) -> tuple[str, dict, dict] | None:
    """Adapt the Messages body to Bedrock InvokeModel, including older Claude models."""
    parsed = urlparse(base)
    if (parsed.scheme != "https" or not (parsed.hostname or "").startswith("bedrock-runtime.")
            or not (parsed.hostname or "").endswith(".amazonaws.com") or parsed.path != "/anthropic"):
        return None
    body = {k: v for k, v in payload.items() if k != "model"}
    body["anthropic_version"] = "bedrock-2023-05-31"
    return (f"https://{parsed.netloc}/model/{quote(model, safe='')}/invoke", body,
            {"Authorization": f"Bearer {key}"})


def _max_tokens() -> int:
    try:
        return int(os.environ.get("TINA_LLM_MAX_TOKENS", "4096"))
    except ValueError:
        return 4096


class AnthropicCompletion:
    name = "anthropic"

    def __init__(self, *, base_url: Optional[str] = None, api_key: Optional[str] = None,
                 model: Optional[str] = None, timeout: float = 120.0,
                 transport: Optional[httpx.BaseTransport] = None) -> None:
        self._base = (base_url or os.environ.get("TINA_LLM_BASE_URL")
                      or _DEFAULT_BASE).rstrip("/")
        self._key = (api_key or os.environ.get("TINA_LLM_API_KEY")
                     or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                     or os.environ.get("ANTHROPIC_API_KEY") or "")
        self._model = model or os.environ.get("TINA_LLM_MODEL") or ""
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def complete(self, prompt: str, *, system: Optional[str] = None,
                  model: Optional[str] = None, response_schema: Optional[dict] = None) -> CompletionResult:
        system = schema_system(system, response_schema)
        target = (model or "").strip() or self._model
        if not target:
            raise LLMConfigError(
                "no model: set TINA_LLM_MODEL (deployment default) or a model in the workspace's "
                "agents/meeting.md"
            )
        payload: dict = {
            "model": target,
            "max_tokens": _max_tokens(),
            "messages": [{"role": "user", "content": prompt}],
        }
        if system:
            payload["system"] = system
        headers = {"x-api-key": self._key, "anthropic-version": _API_VERSION}
        url = f"{self._base}/v1/messages"
        native = bedrock_request(self._base, self._key, target, payload)
        if native:
            url, payload, headers = native
        try:
            r = self._client.post(url, json=payload, headers=headers)
        except httpx.HTTPError as exc:
            raise LLMError(f"completion transport failure against {self._base}: {exc}") from exc
        if r.status_code in (401, 403):
            raise LLMAuthError(f"{r.status_code} from {self._base}: {r.text[:300]}")
        if r.status_code >= 400:
            raise LLMError(f"{r.status_code} from {self._base}: {r.text[:300]}")
        try:
            blocks = r.json().get("content") or []
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
        except (ValueError, AttributeError, TypeError) as exc:
            raise LLMError(f"malformed completion payload from {self._base}: {exc}") from exc
        return CompletionResult(text=text, model=target)
