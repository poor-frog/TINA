"""L2: the openai-compat completion adapter against a fake transport — request shape (URL, auth
header, messages), response parsing, and the error taxonomy (401→LLMAuthError, 5xx→LLMError,
missing config→LLMConfigError). No network."""
import json

import httpx
import pytest

from llm import LLMAuthError, LLMConfigError, LLMError
from llm.openai_compat import OpenAICompatCompletion


def _adapter(handler, **kw):
    kw.setdefault("base_url", "https://llm.example/v1")
    kw.setdefault("api_key", "sk-test")
    kw.setdefault("model", "some-model")
    return OpenAICompatCompletion(transport=httpx.MockTransport(handler), **kw)


@pytest.mark.parametrize("status", [401, 500])
def test_provider_error_body_cannot_echo_the_api_key(status):
    adapter = _adapter(lambda _request: httpx.Response(status, text="rejected own-key"),
                       api_key="own-key")
    with pytest.raises(LLMError) as error:
        adapter.complete("hello")
    assert "own-key" not in str(error.value)
    assert "[redacted]" in str(error.value)


def test_request_shape_and_parse():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers.get("authorization")
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": "polished"}}]})

    result = _adapter(handler).complete("clean these lines", system="you are a copilot")
    assert result.text == "polished"
    assert result.model == "some-model"
    assert seen["url"] == "https://llm.example/v1/chat/completions"
    assert seen["auth"] == "Bearer sk-test"
    assert seen["body"]["model"] == "some-model"
    assert seen["body"]["messages"][0] == {"role": "system", "content": "you are a copilot"}
    assert seen["body"]["messages"][1] == {"role": "user", "content": "clean these lines"}


def test_per_call_model_overrides_default():
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)["model"] == "beat-model"
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    assert _adapter(handler).complete("p", model="beat-model").model == "beat-model"


def test_structured_completion_sends_native_schema_without_changing_plain_calls():
    import os
    schema = {'type': 'object', 'properties': {'label': {'enum': ['relevant', 'uncertain']}},
              'required': ['label'], 'additionalProperties': False}
    calls = []
    def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={'choices': [{'message': {'content': '{"label":"relevant"}'}}]})
    adapter = _adapter(handler)
    assert adapter.complete('classify', response_schema=schema).text == '{"label":"relevant"}'
    assert calls[0]['response_format'] == {'type': 'json_schema', 'json_schema': {
        'name': 'structured_completion', 'strict': True, 'schema': schema}}
    assert calls[0]['max_tokens'] == 4096
    adapter.complete('plain')
    assert 'response_format' not in calls[1]


def test_output_token_limit_is_configurable_for_local_structured_calls(monkeypatch):
    monkeypatch.setenv('TINA_LLM_MAX_TOKENS', '1200')
    def handler(request: httpx.Request) -> httpx.Response:
        assert json.loads(request.content)['max_tokens'] == 1200
        return httpx.Response(200, json={'choices': [{'message': {'content': '{"label":"relevant"}'}}]})
    assert _adapter(handler).complete('classify').text == '{"label":"relevant"}'


def test_no_key_means_no_auth_header(monkeypatch):
    for var in ("TINA_LLM_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
        monkeypatch.delenv(var, raising=False)

    def handler(request: httpx.Request) -> httpx.Response:
        assert "authorization" not in request.headers  # local runtimes (ollama) need no key
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    adapter = OpenAICompatCompletion(base_url="http://ollama:11434/v1", api_key="",
                                     model="local", transport=httpx.MockTransport(handler))
    assert adapter.complete("p").text == "ok"


def test_401_raises_auth_error():
    handler = lambda request: httpx.Response(401, text="User not found.")  # noqa: E731
    with pytest.raises(LLMAuthError) as exc:
        _adapter(handler).complete("p")
    assert "401" in str(exc.value)


def test_5xx_raises_llm_error():
    handler = lambda request: httpx.Response(503, text="overloaded")  # noqa: E731
    with pytest.raises(LLMError):
        _adapter(handler).complete("p")


def test_missing_base_url_fails_loud(monkeypatch):
    for var in ("TINA_LLM_BASE_URL", "ANTHROPIC_BASE_URL"):
        monkeypatch.delenv(var, raising=False)
    adapter = OpenAICompatCompletion(base_url="", model="m")
    with pytest.raises(LLMConfigError) as exc:
        adapter.complete("p")
    assert "TINA_LLM_BASE_URL" in str(exc.value)


def test_missing_model_fails_loud(monkeypatch):
    monkeypatch.delenv("TINA_LLM_MODEL", raising=False)
    adapter = OpenAICompatCompletion(base_url="https://llm.example/v1", model="")
    with pytest.raises(LLMConfigError) as exc:
        adapter.complete("p")
    assert "TINA_LLM_MODEL" in str(exc.value)
