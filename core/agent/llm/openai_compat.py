"""openai_compat.py — the DEFAULT CompletionPort adapter: any OpenAI-compatible endpoint.

One dialect covers nearly every provider — OpenRouter, Ollama, vLLM, LM Studio, OpenAI itself, and
most gateways all speak ``POST {base}/chat/completions``. Raw httpx, no vendor SDK: the request is
~10 lines and a pinned SDK would be a heavier supply-chain surface than the protocol itself.

Config (constructor args win over env): ``TINA_LLM_BASE_URL`` (required — e.g.
``https://openrouter.ai/api/v1``, ``http://ollama:11434/v1``; falls back to ``ANTHROPIC_BASE_URL``
for deployments that already point one at a multi-protocol gateway), ``TINA_LLM_API_KEY`` (falls
back ``ANTHROPIC_AUTH_TOKEN`` → ``ANTHROPIC_API_KEY``; optional — local runtimes need none),
``TINA_LLM_MODEL`` (the deployment-default model).
"""
from __future__ import annotations

import os
from typing import Optional

import httpx

from llm.errors import LLMAuthError, LLMConfigError, LLMError
from llm.ports import CompletionResult


class OpenAICompatCompletion:
    name = "openai-compat"

    def __init__(self, *, base_url: Optional[str] = None, api_key: Optional[str] = None,
                 model: Optional[str] = None, timeout: float = 120.0,
                 transport: Optional[httpx.BaseTransport] = None) -> None:
        self._base = (base_url or os.environ.get("TINA_LLM_BASE_URL")
                      or os.environ.get("ANTHROPIC_BASE_URL") or "").rstrip("/")
        self._key = (api_key or os.environ.get("TINA_LLM_API_KEY")
                     or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                     or os.environ.get("ANTHROPIC_API_KEY") or "")
        self._model = model or os.environ.get("TINA_LLM_MODEL") or ""
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def complete(self, prompt: str, *, system: Optional[str] = None,
                  model: Optional[str] = None, response_schema: Optional[dict] = None) -> CompletionResult:
        target = (model or "").strip() or self._model
        if not self._base:
            raise LLMConfigError(
                "no completion endpoint: set TINA_LLM_BASE_URL (e.g. https://openrouter.ai/api/v1, "
                "http://ollama:11434/v1) — the openai-compat provider has no default host"
            )
        if not target:
            raise LLMConfigError(
                "no model: set TINA_LLM_MODEL (deployment default) or a model in the workspace's "
                "agents/meeting.md"
            )
        messages = ([{"role": "system", "content": system}] if system else [])
        messages.append({"role": "user", "content": prompt})
        headers = {"Authorization": f"Bearer {self._key}"} if self._key else {}
        try:
            max_tokens = int(os.environ.get("TINA_LLM_MAX_TOKENS", "4096"))
        except ValueError:
            max_tokens = 4096
        payload = {"model": target, "messages": messages, "max_tokens": max_tokens}
        if response_schema is not None:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {
                'name': 'structured_completion', 'strict': True, 'schema': response_schema}}
        try:
            r = self._client.post(f"{self._base}/chat/completions",
                                  json=payload, headers=headers)
        except httpx.HTTPError as exc:
            detail = str(exc).replace(self._key, "[redacted]") if self._key else str(exc)
            raise LLMError(f"completion transport failure against {self._base}: {detail}") from exc
        if r.status_code in (401, 403):
            detail = r.text.replace(self._key, "[redacted]") if self._key else r.text
            raise LLMAuthError(f"{r.status_code} from {self._base}: {detail[:300]}")
        if r.status_code >= 400:
            detail = r.text.replace(self._key, "[redacted]") if self._key else r.text
            raise LLMError(f"{r.status_code} from {self._base}: {detail[:300]}")
        try:
            choice = (r.json().get("choices") or [{}])[0]
            text = (choice.get("message") or {}).get("content") or ""
        except (ValueError, AttributeError, IndexError, TypeError) as exc:
            raise LLMError(f"malformed completion payload from {self._base}: {exc}") from exc
        return CompletionResult(text=str(text), model=target)
