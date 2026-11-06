"""OpenAI Responses API completion adapter.

Used for both ordinary OpenAI API keys and Sign in with ChatGPT plan access tokens.
The credential is supplied by the deployment/model-config boundary, never by a prompt.
"""
from __future__ import annotations

import json
import os
from typing import Optional

import httpx

from llm.errors import LLMAuthError, LLMConfigError, LLMError
from llm.ports import CompletionResult


class OpenAIResponsesCompletion:
    name = "openai-responses"

    def __init__(self, *, base_url: Optional[str] = None, api_key: Optional[str] = None,
                 model: Optional[str] = None, timeout: float = 120.0,
                 transport: Optional[httpx.BaseTransport] = None) -> None:
        self._base = (base_url or os.environ.get("TINA_LLM_BASE_URL")
                      or "https://api.openai.com/v1").rstrip("/")
        self._key = (api_key or os.environ.get("TINA_LLM_API_KEY")
                     or os.environ.get("OPENAI_API_KEY")
                     or os.environ.get("ACCESS_TOKEN") or "")
        self._model = model or os.environ.get("TINA_LLM_MODEL") or ""
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def complete(self, prompt: str, *, system: Optional[str] = None,
                  model: Optional[str] = None, response_schema: Optional[dict] = None) -> CompletionResult:
        target = (model or "").strip() or self._model
        if not self._key:
            raise LLMConfigError("OpenAI Responses credential is missing")
        if not target:
            raise LLMConfigError("set TINA_LLM_MODEL or choose a model in Settings → Models")
        payload: dict = {
            "model": target,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "store": False,
            "stream": True,
            "max_output_tokens": int(os.environ.get("TINA_LLM_MAX_TOKENS", "4096")),
        }
        if system:
            payload["instructions"] = system
        if response_schema is not None:
            payload['text'] = {'format': {'type': 'json_schema', 'name': 'structured_completion',
                                         'strict': True, 'schema': response_schema}}
        try:
            text_parts: list[str] = []
            with self._client.stream(
                "POST", f"{self._base}/responses", json=payload,
                headers={"Authorization": f"Bearer {self._key}"},
            ) as response:
                if response.status_code in (401, 403):
                    detail = response.read().decode("utf-8", errors="replace")[:300]
                    raise LLMAuthError(f"{response.status_code} from {self._base}: {detail}")
                if response.status_code >= 400:
                    detail = response.read().decode("utf-8", errors="replace")[:300]
                    raise LLMError(f"{response.status_code} from {self._base}: {detail}")
                for line in response.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    event_type = event.get("type")
                    if event_type == "response.output_text.delta":
                        delta = event.get("delta")
                        if isinstance(delta, str):
                            text_parts.append(delta)
                    elif event_type in ("response.failed", "error"):
                        detail = event.get("error") or event.get("message") or "Responses stream failed"
                        raise LLMError(f"OpenAI Responses stream failed: {str(detail)[:300]}")
                    elif event_type == "response.completed" and not text_parts:
                        body = event.get("response") or {}
                        output_text = body.get("output_text")
                        if isinstance(output_text, str):
                            text_parts.append(output_text)
                        else:
                            for item in body.get("output", []) or []:
                                if item.get("type") == "message":
                                    text_parts.extend(
                                        part.get("text", "") for part in item.get("content", []) or []
                                        if part.get("type") == "output_text"
                                    )
        except httpx.HTTPError as exc:
            raise LLMError(f"OpenAI Responses transport failure against {self._base}: {exc}") from exc
        return CompletionResult(text="".join(text_parts), model=target)
