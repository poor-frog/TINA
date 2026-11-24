"""registry.py — env-driven adapter selection (the ``RUNTIME_BACKEND`` factory pattern).

Two independent dials:
- ``TINA_LLM_PROVIDER`` picks the CompletionPort adapter (card beats). Default ``openai-compat``.
- ``TINA_RUNNER`` picks the HarnessPort adapter (workspace turns). Default ``claude-code`` — the
  ONLY place that default string lives; worker/ code never names a runner.

Unknown keys fail LOUD with the known set — a typo'd provider must never limp into a confusing
downstream error. To add a provider: implement the port, add one line to the table, done.
"""
from __future__ import annotations

import os

from llm.anthropic_api import AnthropicCompletion
from llm.antigravity import AntigravityHarness
from llm.bedrock_converse import BedrockConverseCompletion
from llm.claude_cli import ClaudeCliCompletion
from llm.claude_code import ClaudeCodeHarness
from llm.codex import CodexHarness
from llm.errors import LLMConfigError
from llm.openai_compat import OpenAICompatCompletion
from llm.openai_responses import ChatGPTPlanCompletion, OpenAIResponsesCompletion
from llm.ports import CompletionPort, HarnessPort

COMPLETION_PROVIDERS: dict[str, type] = {
    "openai-compat": OpenAICompatCompletion,
    "openai-responses": OpenAIResponsesCompletion,
    "chatgpt-plan": ChatGPTPlanCompletion,
    "anthropic": AnthropicCompletion,
    "bedrock-converse": BedrockConverseCompletion,
    # Subscription-credential deployments: beats ride the claude CLI (no API key needed).
    "claude-cli": ClaudeCliCompletion,
}

HARNESS_RUNNERS: dict[str, type] = {
    "antigravity": AntigravityHarness,
    "claude-code": ClaudeCodeHarness,
    "codex": CodexHarness,
}


def completion_from_env(*, timeout: float | None = None) -> CompletionPort:
    key = (os.environ.get("TINA_LLM_PROVIDER") or "").strip() or "openai-compat"
    cls = COMPLETION_PROVIDERS.get(key)
    if cls is None:
        raise LLMConfigError(
            f"unknown TINA_LLM_PROVIDER {key!r} — known providers: {sorted(COMPLETION_PROVIDERS)}"
        )
    return cls(timeout=timeout) if timeout is not None else cls()


def harness_from_env() -> HarnessPort:
    key = (os.environ.get("TINA_RUNNER") or "").strip() or "claude-code"
    cls = HARNESS_RUNNERS.get(key)
    if cls is None:
        raise LLMConfigError(
            f"unknown TINA_RUNNER {key!r} — known runners: {sorted(HARNESS_RUNNERS)}"
        )
    return cls()
