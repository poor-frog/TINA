"""CompletionPort using the AWS credential chain and Bedrock Converse."""

import json
import os
import re

from llm.errors import (
    LLMAuthError,
    LLMConfigError,
    LLMError,
    LLMResponseError,
    LLMStructuredOutputUnsupported,
)
from llm.ports import CompletionResult, schema_system

_STRUCTURED_TOOL_NAME = "tina_structured_output"


def _bedrock_structured_unsupported(exc: Exception) -> bool:
    response = getattr(exc, "response", None) or {}
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    err = response.get("Error") or {}
    code = str(err.get("Code") or "")
    msg = str(err.get("Message") or "").lower()
    if status != 400 or code != "ValidationException":
        return False
    return any(term in msg for term in (
        "toolchoice", "tool choice", "toolconfig", "tool config",
        "tool use", "tooluse", "inputschema", "input schema",
        "doesn't support tool", "does not support tool",
    ))


class BedrockConverseCompletion:
    name = "bedrock-converse"

    def __init__(self, *, model=None, timeout=120.0, client=None):
        if client is None:
            try:
                import boto3
                from botocore.config import Config
            except ImportError as exc:
                raise LLMConfigError("Bedrock Converse requires the AWS SDK") from exc
            client = boto3.client("bedrock-runtime", config=Config(
                connect_timeout=min(3, timeout), read_timeout=timeout,
                retries={"total_max_attempts": 1},
            ))
        self.client = client
        self.model = (model or "").strip() or os.environ.get("TINA_LLM_MODEL", "")

    def _target_model(self, model=None):
        target = (model or "").strip() or self.model
        if not target:
            raise LLMConfigError("Set TINA_LLM_MODEL to a Bedrock model ID")
        return target

    def complete_structured(self, prompt, *, system, schema, model=None):
        target = self._target_model(model)
        request = {
            "modelId": target,
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"maxTokens": 2048, "temperature": 0.0},
            "toolConfig": {
                "tools": [{
                    "toolSpec": {
                        "name": _STRUCTURED_TOOL_NAME,
                        "description": "Return the structured JSON response matching the required schema.",
                        "inputSchema": {"json": schema},
                    },
                }],
                "toolChoice": {"tool": {"name": _STRUCTURED_TOOL_NAME}},
            },
        }
        if system:
            request["system"] = [{"text": system}]
        try:
            response = self.client.converse(**request)
        except Exception as exc:
            if _bedrock_structured_unsupported(exc):
                raise LLMStructuredOutputUnsupported("Bedrock model does not support structured tool output") from exc
            status = getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
            error = LLMAuthError if status in (401, 403) else LLMError
            raise error("Bedrock Converse request failed", status_code=status) from exc
        try:
            content = response["output"]["message"]["content"]
            tool_input = next(
                (block["toolUse"]["input"] for block in content
                 if isinstance(block, dict) and isinstance(block.get("toolUse"), dict)
                 and block["toolUse"].get("name") == _STRUCTURED_TOOL_NAME),
                None,
            )
        except (KeyError, TypeError) as exc:
            raise LLMResponseError("Malformed Bedrock Converse structured response") from exc
        if not isinstance(tool_input, dict) or response.get("stopReason") not in ("tool_use", "end_turn"):
            raise LLMResponseError("Bedrock did not return the requested structured tool payload")
        usage = response.get("usage", {})
        return CompletionResult(text=json.dumps(tool_input, ensure_ascii=False), model=target, usage={
            "input_tokens": usage.get("inputTokens"),
            "output_tokens": usage.get("outputTokens"),
        })

    def complete(self, prompt, *, system=None, model=None, response_schema=None):
        target = self._target_model(model)
        system = schema_system(system, response_schema)
        request = {
            "modelId": target,
            "messages": [{"role": "user", "content": [{"text": prompt}]}],
            "inferenceConfig": {"maxTokens": 2048, "temperature": 0.0},
        }
        if system:
            request["system"] = [{"text": system}]
        try:
            response = self.client.converse(**request)
        except Exception as exc:
            status = getattr(exc, "response", {}).get("ResponseMetadata", {}).get("HTTPStatusCode")
            error = LLMAuthError if status in (401, 403) else LLMError
            raise error("Bedrock Converse request failed", status_code=status) from exc
        try:
            text = "".join(part["text"] for part in response["output"]["message"]["content"] if "text" in part)
        except (KeyError, TypeError) as exc:
            raise LLMResponseError("Malformed Bedrock Converse response") from exc
        if not text or response.get("stopReason") not in ("end_turn", "stop_sequence"):
            raise LLMResponseError("Bedrock did not finish a text completion")
        fence = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", text.strip(), re.DOTALL | re.IGNORECASE)
        if fence and system and "JSON" in system:
            try:
                value = json.loads(fence[1])
            except ValueError as exc:
                raise LLMResponseError("Invalid JSON in Bedrock completion") from exc
            if isinstance(value, dict):
                text = fence[1]
        usage = response.get("usage", {})
        return CompletionResult(text=text, model=target, usage={
            "input_tokens": usage.get("inputTokens"),
            "output_tokens": usage.get("outputTokens"),
        })
