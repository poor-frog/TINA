"""CompletionPort using the AWS credential chain and Bedrock Converse."""

import json
import os
import re

from llm.errors import LLMAuthError, LLMConfigError, LLMError, LLMResponseError
from llm.ports import CompletionResult, schema_system


class BedrockConverseCompletion:
    name = "bedrock-converse"

    def __init__(self, *, timeout=120.0, client=None):
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
        self.model = os.environ.get("TINA_LLM_MODEL", "")

    def complete(self, prompt, *, system=None, model=None, response_schema=None):
        target = model or self.model
        if not target:
            raise LLMConfigError("Set TINA_LLM_MODEL to a Bedrock model ID")
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
