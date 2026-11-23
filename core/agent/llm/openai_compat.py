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
import math
from typing import Optional

import httpx

from llm.errors import (LLMAuthError, LLMConfigError, LLMError, LLMResponseError,
                        LLMStructuredOutputUnsupported, structured_output_unsupported)
from llm.ports import CompletionResult


class OpenAICompatCompletion:
    name = "openai-compat"

    def __init__(self, *, base_url: Optional[str] = None, api_key: Optional[str] = None,
                 model: Optional[str] = None, timeout: float = 120.0,
                 transport: Optional[httpx.BaseTransport] = None,
                 client: Optional[httpx.Client] = None,
                 temperature: Optional[float] = None,
                 max_tokens: Optional[int] = None,
                 reasoning_effort: Optional[str] = None) -> None:
        self._base = (base_url or os.environ.get("TINA_LLM_BASE_URL")
                      or os.environ.get("ANTHROPIC_BASE_URL") or "").rstrip("/")
        self._key = (api_key or os.environ.get("TINA_LLM_API_KEY")
                     or os.environ.get("ANTHROPIC_AUTH_TOKEN")
                     or os.environ.get("ANTHROPIC_API_KEY") or "")
        self._model = model or os.environ.get("TINA_LLM_MODEL") or ""
        self._owns_client = client is None
        self._client = client if client is not None else httpx.Client(timeout=timeout, transport=transport)
        self._temperature = temperature
        self._max_tokens = max_tokens
        self._reasoning_effort = reasoning_effort

    def complete(self, prompt: str, *, system: Optional[str] = None,
                 model: Optional[str] = None, response_schema: Optional[dict] = None) -> CompletionResult:
        return self._complete(prompt, system=system, model=model, schema=response_schema,
                              schema_name="structured_completion")

    def complete_structured(self, prompt: str, *, system: str, schema: dict) -> CompletionResult:
        return self._complete(prompt, system=system, schema=schema)

    def _complete(self, prompt: str, *, system: Optional[str] = None,
                  model: Optional[str] = None, schema: dict | None = None, schema_name: str = "tina_voice") -> CompletionResult:
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
        if self._max_tokens is not None:
            max_tokens = self._max_tokens
        else:
            try:
                max_tokens = int(os.environ.get("TINA_LLM_MAX_TOKENS", "4096"))
            except ValueError:
                max_tokens = 4096
        payload: dict = {"model": target, "messages": messages, "max_tokens": max_tokens}
        if self._temperature is not None:
            payload["temperature"] = self._temperature
        if self._reasoning_effort:
            payload["reasoning_effort"] = self._reasoning_effort
        if schema is not None:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {
                'name': schema_name, 'strict': True, 'schema': schema}}
        try:
            r = self._client.post(f"{self._base}/chat/completions",
                                  json=payload, headers=headers)
        except httpx.HTTPError as exc:
            detail = str(exc).replace(self._key, "[redacted]") if self._key else str(exc)
            raise LLMError(f"completion transport failure against {self._base}: {detail}") from exc
        if schema is not None and structured_output_unsupported(r, 'response_format'):
            raise LLMStructuredOutputUnsupported('Structured output is unsupported')
        if r.status_code in (401, 403):
            detail = r.text.replace(self._key, "[redacted]") if self._key else r.text
            raise LLMAuthError(f"{r.status_code} from {self._base}: {detail[:300]}", status_code=r.status_code)
        if r.status_code >= 400:
            detail = r.text.replace(self._key, "[redacted]") if self._key else r.text
            raise LLMError(f"{r.status_code} from {self._base}: {detail[:300]}", status_code=r.status_code)
        try:
            body = r.json()
            content = body['choices'][0]['message'].get('content')
            if content is not None and not isinstance(content, str):
                raise TypeError('Expected completion text')
            text = content or ''
        except (ValueError, AttributeError, KeyError, IndexError, TypeError) as exc:
            raise LLMResponseError('Malformed completion payload') from exc
        usage = body.get('usage') or {}
        usage = usage if isinstance(usage, dict) else {}
        cached = usage.get('prompt_tokens_details') or {}
        cached = cached if isinstance(cached, dict) else {}
        count = lambda v: v if type(v) is int and v >= 0 else None
        # Compatible providers such as Groq report these usage durations in seconds.
        timings = {target: usage[key]*1000 for key, target in (('queue_time', 'queue_ms'),
            ('prompt_time', 'prefill_ms'), ('completion_time', 'generation_ms'))
            if type(usage.get(key)) in (int, float) and math.isfinite(usage[key]) and usage[key] >= 0}
        return CompletionResult(text=str(text), model=target, usage={
            'input_tokens': count(usage.get('prompt_tokens')), 'output_tokens': count(usage.get('completion_tokens')),
            'cache_read_tokens': count(cached.get('cached_tokens')), 'provider_timings': timings})
