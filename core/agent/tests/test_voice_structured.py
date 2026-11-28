"""Schema requests never bypass source checks or turn provider failures into retries."""
import json
from types import SimpleNamespace

import httpx
import pytest
from jsonschema import Draft202012Validator

from llm import LLMError, LLMStructuredOutputUnsupported
from llm.openai_compat import OpenAICompatCompletion
from llm.openai_responses import ChatGPTPlanCompletion, OpenAIResponsesCompletion
from shared.meeting_knowledge import PREFIX
from shared.voice_schema import voice_schema
from shared.voice_knowledge import validate_voice_answer, voice_tool_calls


def test_worker_timing_logging_keeps_allowlisted_fields_only(caplog):
    from uuid import uuid4
    from control_plane.meeting_voice_completion import _log_worker_timings

    started = {'type': 'voice_stage', 'request_id': str(uuid4()), 'span_id': str(uuid4()),
               'stage': 'verify', 'elapsed_ms': 0, 'status': 'started', 'detail': 'synthetic-private-text'}
    with caplog.at_level('INFO'):
        _log_worker_timings(('provider error synthetic-private-text\n' + json.dumps(started) + '\n' +
                            json.dumps(started | {'stage': 'synthetic-private-text'})).encode())
    assert 'stage=verify elapsed_ms=0 status=started' in caplog.text
    assert 'synthetic-private-text' not in caplog.text


def test_chatgpt_plan_uses_oauth_and_preserves_rate_limit(monkeypatch):
    monkeypatch.setenv("ACCESS_TOKEN", "test-plan-token")
    monkeypatch.setenv("TINA_LLM_MODEL", "plan-model")

    def handle(request):
        payload = json.loads(request.content)
        assert request.url == "https://api.openai.com/v1/responses"
        assert request.headers["Authorization"] == "Bearer test-plan-token"
        assert payload["store"] is False and payload["stream"] is True
        assert "max_output_tokens" not in payload and "tools" not in payload
        event = {"type": "response.failed", "response": {"error": {
            "code": "subscription_sharing_usage_limit_exceeded"}}}
        return httpx.Response(200, text=f"data: {json.dumps(event)}\n\n")

    with pytest.raises(LLMError) as error:
        ChatGPTPlanCompletion(transport=httpx.MockTransport(handle)).complete("Fixture")
    assert error.value.status_code == 429


@pytest.mark.parametrize('failure,marker,expected,http', [
    ('connection', '', 'reconnect_required', 503),
    ('provider', 'TINA_CHATGPT_PLAN_RECONNECT_REQUIRED', 'reconnect_required', 503),
    ('provider', 'TINA_CHATGPT_PLAN_USAGE_LIMIT', 'usage_limit', 429),
])
def test_voice_completion_marks_chatgpt_failure_without_switching_provider(monkeypatch, failure, marker, expected, http):
    from fastapi import HTTPException
    from control_plane import aws_voice_chatgpt, meeting_voice_completion
    from control_plane.openai_auth import ChatGPTAuthError

    seen = []

    def token(_):
        if failure == 'connection':
            raise ChatGPTAuthError('fixture')
        return 'placeholder'

    def run(*_, env, **kwargs):
        assert env['TINA_LLM_PROVIDER'] == 'chatgpt-plan'
        return SimpleNamespace(stderr=marker, stdout='', returncode=1)

    monkeypatch.setenv('TINA_CHATGPT_VOICE_MODEL', 'gpt-6-luna')
    monkeypatch.setattr(aws_voice_chatgpt, 'access_token', token)
    monkeypatch.setattr(meeting_voice_completion.subprocess, 'run', run)
    monkeypatch.setattr(meeting_voice_completion, '_store_provider_issue', lambda *args: seen.append(args[-1]))
    with pytest.raises(HTTPException) as error:
        meeting_voice_completion.complete({'request_id': 'fixture', 'voice_turn': {'meeting_id': 1, 'holder': 'session:fixture'}},
                                         {}, 'redis://fixture', chatgpt_plan=True)
    assert error.value.status_code == http and seen == [expected]


@pytest.mark.parametrize(('mode', 'expected_url'), [('voice_web', 'http://reach.test:8080'), ('voice', None)])
def test_completion_worker_receives_reach_url_only_for_public_lookup(monkeypatch, mode, expected_url):
    from control_plane import meeting_voice_completion

    monkeypatch.setenv('TINA_AGENT_REACH_URL', 'http://reach.test:8080')

    def run(*_, env, **kwargs):
        assert env.get('TINA_AGENT_REACH_URL') == expected_url
        return SimpleNamespace(stderr='', stdout='{}', returncode=0)

    monkeypatch.setattr(meeting_voice_completion.subprocess, 'run', run)
    payload = {'request_id': 'fixture', 'voice_turn': {'meeting_id': 1, 'holder': 'session:fixture'}}
    assert meeting_voice_completion.complete(payload, {'mode': mode}, 'redis://fixture') == '{}'


@pytest.mark.parametrize('expired', [False, True])
def test_public_source_worker_uses_only_question_and_respects_remaining_deadline(monkeypatch, expired):
    import time
    from worker import engine
    events, calls, timeouts = [], [], []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-source-route')
    def structured(prompt, *, system, schema):
        calls.append(json.loads(prompt))
        assert schema == voice_schema('source_intent')
        return SimpleNamespace(text='{"route":"web"}')
    def provider(**kwargs):
        timeouts.append(kwargs['timeout'])
        return SimpleNamespace(complete_structured=structured)
    monkeypatch.setattr(engine, 'completion_from_env', provider)
    payload={'mode':'voice_source_intent','question':'Latest React release?',
             'retrieval_deadline_ms':int(time.time()*1000)+(-1 if expired else 1500),
             'sources':[{'quote':'PRIVATE ROOM DATA'}], 'history':[{'answer':'PRIVATE HISTORY'}]}
    stream=SimpleNamespace(xadd=lambda _, e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps({
        'request_id':'source-route','text':json.dumps(payload)})}})
    if expired:
        assert not calls and not timeouts
    else:
        assert calls==[{'question':'Latest React release?'}] and 0 < timeouts[0] <= 1.5
        assert json.loads(events[0]['text'])=={'route':'web'}


@pytest.mark.parametrize('adapter_type,parameter', [
    (OpenAIResponsesCompletion, 'text.format'), (OpenAICompatCompletion, 'response_format')])
@pytest.mark.parametrize('mode', ['answer', 'plan', 'source_intent'])
def test_adapters_send_strict_schema_only_on_explicit_structured_calls(adapter_type, parameter, mode):
    schema = voice_schema(mode, [{'id': 's0'}], tools=['search_meeting', 'calculate', 'read_source_context'] if mode == 'plan' else ())
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        if adapter_type is OpenAICompatCompletion:
            return httpx.Response(200, json={'choices': [{'message': {'content': '{"claims":[]}'}}]})
        return httpx.Response(200, text='data: ' + json.dumps({'type': 'response.completed',
            'response': {'status': 'completed', 'output_text': '{"claims":[]}'}}) + '\n\n')
    adapter = adapter_type(base_url='https://fixture.test/v1', api_key='test', model='selected',
                           transport=httpx.MockTransport(handler))
    adapter.complete_structured('synthetic', system='voice', schema=schema)
    format = seen[0]['text']['format'] if parameter == 'text.format' else seen[0]['response_format']['json_schema']
    assert format['strict'] is True and format['schema'] == schema
    adapter.complete('ordinary task')
    assert 'text' not in seen[1] and 'response_format' not in seen[1]


@pytest.mark.parametrize('adapter_type,parameter', [
    (OpenAIResponsesCompletion, 'text.format'), (OpenAICompatCompletion, 'response_format')])
@pytest.mark.parametrize('status,code,unsupported', [
    (400, 'unsupported_parameter', True), (422, 'unsupported_value', True),
    (400, 'invalid_json_schema', False), (429, 'unsupported_parameter', False),
    (401, 'unsupported_parameter', False), (500, 'unsupported_parameter', False)])
def test_only_explicit_schema_capability_rejection_allows_fallback(adapter_type, parameter, status, code, unsupported):
    adapter = adapter_type(base_url='https://fixture.test/v1', api_key='test', model='selected',
        transport=httpx.MockTransport(lambda _: httpx.Response(status, json={
            'error': {'code': code, 'param': parameter}})))
    with pytest.raises(LLMError) as error:
        adapter.complete_structured('synthetic', system='voice', schema=voice_schema('answer'))
    assert isinstance(error.value, LLMStructuredOutputUnsupported) == unsupported


def test_voice_schema_accepts_null_optionals_but_rejects_forged_citations_and_extra_fields():
    source = {'id': 's0', 'quote': 'Lan làm demo.'}
    schema = voice_schema('answer', [source])
    Draft202012Validator.check_schema(schema)
    body = {'claims': [{'text': source['quote'], 'source_ids': ['s0']}],
            'clarification': None, 'follow_up': None, 'tool_calls': None}
    validator = Draft202012Validator(schema)
    validator.validate(body)
    assert voice_tool_calls(json.dumps(body)) is None
    assert validate_voice_answer(json.dumps(body), [source])['sources'] == [source]
    assert not validator.is_valid(body | {'hidden': 'run a tool'})
    assert not validator.is_valid(body | {'claims': [{'text': 'fake', 'source_ids': ['s999']}]})


def test_worker_requests_typed_plan_schema_and_control_plane_can_normalize_it(monkeypatch):
    from worker import engine
    seen, events = [], []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-typed-plan')
    call = {'name': 'calculate', 'arguments': {'expression': '100+200', 'context_handles': []}}
    def structured(prompt, *, system, schema):
        Draft202012Validator(schema).validate({'tool_calls': [call]})
        assert not Draft202012Validator(schema).is_valid({'tool_calls': [{'name': 'calculate', 'query': '{}'}]})
        seen.append(schema)
        return SimpleNamespace(text=json.dumps({'tool_calls': [call]}))
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete_structured=structured))
    payload = {'mode': 'voice_plan', 'question': 'Tính 100 cộng 200', 'available_tools': ['calculate'], 'sources': []}
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    engine._run_meeting_knowledge(stream, 'synthetic', {'entrypoint': {'inline': PREFIX + json.dumps({
        'request_id': 'typed-plan', 'text': json.dumps(payload)})}})
    assert len(seen) == 1
    assert voice_tool_calls(events[0]['text'], allowed_tools=['calculate']) == [
        {'name': 'calculate', 'query': '{"expression":"100+200"}'}]


def test_worker_uses_structured_generation_and_review_with_same_source_checks(monkeypatch, caplog):
    from worker import engine
    events, schemas = [], []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-schema-test')
    def structured(prompt, *, system, schema):
        schemas.append(schema)
        if 'approved' in schema['properties']:
            return SimpleNamespace(text='{"approved":true,"reason":null,"claim_indexes":null}')
        return SimpleNamespace(text=json.dumps({'claims': [{'text': 'Lan làm demo.', 'source_ids': ['s0']}],
            'clarification': None, 'follow_up': None, 'tool_calls': None}))
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete_structured=structured))
    source = {'mode': 'voice', 'question': 'Ai làm demo?', 'sources': [{'id': 's0', 'quote': 'Lan làm demo.'}]}
    identifier = '00000000-0000-4000-8000-000000000123'
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    engine._run_meeting_knowledge(stream, 'synthetic', {'entrypoint': {'inline': PREFIX + json.dumps({
        'request_id': 'schema-test', 'voice_trace_id': identifier, 'text': json.dumps(source)})}})
    result = json.loads(events[0]['text'])
    assert len(schemas) == 2 and result['verification'] == ['approved']
    records = [json.loads(r.message) for r in caplog.records if r.name == 'shared.voice_trace']
    assert {'generation', 'verify', 'source_selection'} <= {r['stage'] for r in records}
    assert {r['request_id'] for r in records} == {identifier}


@pytest.mark.parametrize('unsupported', [True, False])
def test_worker_only_falls_back_for_schema_capability_and_still_verifies(monkeypatch, unsupported):
    from worker import engine
    events, ordinary = [], []
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-fallback-test')
    def structured(*args, **kwargs):
        if unsupported: raise LLMStructuredOutputUnsupported('unsupported')
        raise LLMError('quota', status_code=429)
    def complete(prompt, *, system):
        ordinary.append(system)
        text = '{"approved":true}' if len(ordinary) == 2 else '{"claims":[{"text":"Lan làm demo.","source_ids":["s0"]}]}'
        return SimpleNamespace(text=text)
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(
        complete_structured=structured, complete=complete))
    source = {'mode': 'voice', 'question': 'Ai?', 'sources': [{'id': 's0', 'quote': 'Lan làm demo.'}]}
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    engine._run_meeting_knowledge(stream, 'synthetic', {'entrypoint': {'inline': PREFIX + json.dumps({
        'request_id': 'fallback-test', 'text': json.dumps(source)})}})
    answers = [json.loads(e['text']) for e in events if e['type'] == 'message-delta']
    if unsupported:
        assert len(ordinary) == 2 and answers[0]['verification'] == ['approved']
    else:
        assert not ordinary and not answers


@pytest.mark.parametrize('mode',['voice_plan','voice','voice_general'])
def test_voice_uses_completion_port_even_when_chat_runner_is_codex(monkeypatch,mode):
    from worker import engine
    from shared.voice_knowledge import VERIFY_SYSTEM
    calls=[];events=[]
    monkeypatch.setenv('TINA_RUNNER','codex');monkeypatch.setenv('TINA_CODEX_AUTH_MODE','chatgpt-plan')
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-api-only')
    def no_harness(*_args,**_kwargs):pytest.fail('Voice must not start a CLI harness')
    monkeypatch.setattr(engine,'harness_from_env',no_harness)
    def complete(prompt,*,system):
        calls.append(system)
        if system==VERIFY_SYSTEM:value={'approved':True}
        elif mode=='voice_plan':value={'tool_calls':[]}
        elif mode=='voice_general':value={'text':'A direct API answer.'}
        else:value={'claims':[{'text':'Lan làm demo.','source_ids':['s0']}]}
        return SimpleNamespace(text=json.dumps(value))
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete=complete))
    source={'mode':mode,'question':'Ai làm demo?','available_tools':[],
        'sources':[{'id':'s0','quote':'Lan làm demo.'}] if mode=='voice' else []}
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps({
        'request_id':'api-only','text':json.dumps(source)})}})
    assert calls and events[0]['type']=='message-delta' and events[-1]['type']=='turn-complete'
    if mode=='voice':assert VERIFY_SYSTEM in calls and json.loads(events[0]['text'])['verification']==['approved']


def test_bedrock_converse_complete_structured_enforces_tool_choice_and_keeps_complete_plain(monkeypatch):
    from llm.bedrock_converse import BedrockConverseCompletion, _STRUCTURED_TOOL_NAME
    from llm.errors import LLMAuthError, LLMResponseError

    seen = []

    class FakeClient:
        def converse(self, **request):
            seen.append(request)
            if 'toolConfig' in request:
                return {
                    'stopReason': 'tool_use',
                    'output': {'message': {'content': [
                        {'toolUse': {'toolUseId': 't1', 'name': _STRUCTURED_TOOL_NAME,
                                     'input': {'claims': [{'text': 'Lan làm demo.', 'source_ids': ['s0']}],
                                               'clarification': None, 'follow_up': None, 'tool_calls': None}}},
                    ]}},
                    'usage': {'inputTokens': 12, 'outputTokens': 18},
                }
            return {
                'stopReason': 'end_turn',
                'output': {'message': {'content': [{'text': 'plain reply'}]}},
                'usage': {'inputTokens': 5, 'outputTokens': 3},
            }

    monkeypatch.setenv('TINA_LLM_MODEL', 'amazon.nova-lite-v1:0')
    adapter = BedrockConverseCompletion(client=FakeClient())
    schema = voice_schema('answer', [{'id': 's0'}])
    structured = adapter.complete_structured('Ai làm demo?', system='voice', schema=schema)
    assert json.loads(structured.text)['claims'][0]['source_ids'] == ['s0']
    assert structured.usage == {'input_tokens': 12, 'output_tokens': 18}
    assert seen[0]['toolConfig']['toolChoice'] == {'tool': {'name': _STRUCTURED_TOOL_NAME}}
    assert seen[0]['toolConfig']['tools'][0]['toolSpec']['inputSchema'] == {'json': schema}

    plain = adapter.complete('ordinary task')
    assert plain.text == 'plain reply' and 'toolConfig' not in seen[1]

    class UnsupportedClient:
        def converse(self, **request):
            exc = RuntimeError('validation failed')
            exc.response = {
                'ResponseMetadata': {'HTTPStatusCode': 400},
                'Error': {'Code': 'ValidationException', 'Message': 'This model does not support toolChoice.'},
            }
            raise exc

    with pytest.raises(LLMStructuredOutputUnsupported):
        BedrockConverseCompletion(client=UnsupportedClient()).complete_structured('synthetic', system='voice', schema=schema)

    class AuthErrorClient:
        def converse(self, **request):
            exc = RuntimeError('denied')
            exc.response = {
                'ResponseMetadata': {'HTTPStatusCode': 403},
                'Error': {'Code': 'AccessDeniedException', 'Message': 'Access denied'},
            }
            raise exc

    with pytest.raises(LLMAuthError):
        BedrockConverseCompletion(client=AuthErrorClient()).complete_structured('synthetic', system='voice', schema=schema)

    class MissingToolClient:
        def converse(self, **request):
            return {'stopReason': 'end_turn', 'output': {'message': {'content': [{'text': 'unstructured'}]}}}

    with pytest.raises(LLMResponseError):
        BedrockConverseCompletion(client=MissingToolClient()).complete_structured('synthetic', system='voice', schema=schema)


def test_resolve_voice_model_env_and_local_completion_model_isolation(monkeypatch):
    from control_plane import meeting_voice_completion

    # OpenAI API BYO model -> openai-responses, strips AWS IAM credentials from subprocess
    openai_env = meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'openai-api', 'api_key': 'sk-test-key', 'model': 'gpt-5', 'meeting_model': 'gpt-5-mini'},
    )
    assert openai_env['TINA_LLM_PROVIDER'] == 'openai-responses'
    assert openai_env['TINA_LLM_MODEL'] == 'gpt-5-mini'
    assert openai_env['TINA_LLM_API_KEY'] == 'sk-test-key'

    # Groq BYO model -> openai-compat
    groq_env = meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'groq', 'api_key': 'gsk-test-key', 'model': 'openai/gpt-oss-20b'},
    )
    assert groq_env['TINA_LLM_PROVIDER'] == 'openai-compat'
    assert groq_env['TINA_LLM_MODEL'] == 'openai/gpt-oss-20b'

    # Bedrock IAM role (no bearer api_key) -> bedrock-converse, keeps AWS IAM credentials
    monkeypatch.setenv('TINA_WORKSPACE_PILOT_USER_IDS', '*')
    bedrock_iam = meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'bedrock', 'region': 'us-east-1', 'model': 'us.anthropic.claude-sonnet-4-6'},
    )
    assert bedrock_iam == {
        'TINA_LLM_PROVIDER': 'bedrock-converse',
        'TINA_LLM_MODEL': 'us.anthropic.claude-sonnet-4-6',
        'AWS_REGION': 'us-east-1',
        'AWS_DEFAULT_REGION': 'us-east-1',
    }

    # Bedrock Bearer token -> anthropic, strips AWS IAM credentials
    bedrock_bearer = meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'bedrock', 'region': 'us-east-1', 'api_key': 'bearer-tok', 'model': 'anthropic.claude-3-5-sonnet'},
    )
    assert bedrock_bearer['TINA_LLM_PROVIDER'] == 'anthropic'
    assert bedrock_bearer['AWS_BEARER_TOKEN_BEDROCK'] == 'bearer-tok'

    # Subscription mode without Secrets Manager pilot falls back to deployment default ({})
    assert meeting_voice_completion.resolve_voice_model_env({'mode': 'openai-subscription'}) == {}

    # Verify subprocess credential isolation in complete()
    monkeypatch.setenv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/test')
    monkeypatch.setenv('TINA_LLM_PROVIDER', 'bedrock-converse')
    monkeypatch.setenv('TINA_LLM_MODEL', 'amazon.nova-lite-v1:0')
    seen_envs = []

    def fake_run(*_, env, **kwargs):
        seen_envs.append(dict(env))
        return SimpleNamespace(stderr='', stdout='{"claims":[]}', returncode=0)

    monkeypatch.setattr(meeting_voice_completion.subprocess, 'run', fake_run)
    payload = {'request_id': 'voice-model-test', 'voice_turn': {'meeting_id': 1, 'holder': 's:1'}}
    meeting_voice_completion.complete(payload, {'mode': 'voice'}, 'redis://fixture', model_env=openai_env)
    assert seen_envs[0]['TINA_LLM_PROVIDER'] == 'openai-responses'
    assert seen_envs[0]['TINA_LLM_MODEL'] == 'gpt-5-mini'
    assert 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI' not in seen_envs[0]

    meeting_voice_completion.complete(payload, {'mode': 'voice'}, 'redis://fixture', model_env=bedrock_iam)
    assert seen_envs[1]['TINA_LLM_PROVIDER'] == 'bedrock-converse'
    assert seen_envs[1]['TINA_LLM_MODEL'] == 'us.anthropic.claude-sonnet-4-6'
    assert seen_envs[1]['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] == '/v2/credentials/test'

    # meeting_use_default="true" forces Voice/Meeting tasks back to deployment default ({})
    assert meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'openai-api', 'api_key': 'sk-test', 'model': 'gpt-5', 'meeting_use_default': 'true'},
    ) == {}
    # Gemini BYO resolves to Google's OpenAI-compatible endpoint with default gemini-3.8-flash
    gemini_env = meeting_voice_completion.resolve_voice_model_env({'mode': 'gemini', 'api_key': 'AIza-test'})
    assert gemini_env['TINA_LLM_PROVIDER'] == 'openai-compat'
    assert gemini_env['TINA_LLM_BASE_URL'] == 'https://generativelanguage.googleapis.com/v1beta/openai'
    assert gemini_env['TINA_LLM_MODEL'] == 'gemini-3.8-flash'

    # OpenAI API with blank models defaults Chat to gpt-5 and Voice/Meeting to gpt-5-mini
    openai_default_env = meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'openai-api', 'api_key': 'sk-test-key'},
    )
    assert openai_default_env['TINA_LLM_PROVIDER'] == 'openai-responses'
    assert openai_default_env['TINA_LLM_MODEL'] == 'gpt-5-mini'


def test_structured_output_unsupported_handles_gemini_array_and_groq_model_rejection():
    # Bug #2: Gemini OpenAI-compat wraps 400 INVALID_ARGUMENT schema rejections in a JSON list
    gemini_adapter = OpenAICompatCompletion(
        base_url='https://generativelanguage.googleapis.com/v1beta/openai',
        api_key='AIza-test',
        model='gemini-3.8-flash',
        transport=httpx.MockTransport(lambda _: httpx.Response(400, json=[{
            'error': {
                'code': 400,
                'status': 'INVALID_ARGUMENT',
                'message': 'Invalid JSON payload received. Unknown name "additionalProperties" in response_format schema.',
            },
        }])),
    )
    with pytest.raises(LLMStructuredOutputUnsupported):
        gemini_adapter.complete_structured('synthetic', system='voice', schema=voice_schema('answer'))

    # Bug #2: Groq returns invalid_request_error when a model does not support json_schema strict mode
    groq_adapter = OpenAICompatCompletion(
        base_url='https://api.groq.com/openai/v1',
        api_key='gsk-test',
        model='llama-3.3-70b-versatile',
        transport=httpx.MockTransport(lambda _: httpx.Response(400, json={
            'error': {
                'type': 'invalid_request_error',
                'message': 'This model does not support response format `json_schema`.',
            },
        })),
    )
    with pytest.raises(LLMStructuredOutputUnsupported):
        groq_adapter.complete_structured('synthetic', system='voice', schema=voice_schema('answer'))


@pytest.mark.parametrize('code,expected_status,expected_auth', [
    ('rate_limit_exceeded', 429, False),
    ('insufficient_quota', 429, False),
    ('invalid_api_key', 401, True),
])
def test_openai_responses_stream_failure_preserves_rate_limit_and_auth_codes(code, expected_status, expected_auth):
    # Bug #3: SSE response.failed / error events carry typed status codes so Bedrock fallback triggers
    from llm.errors import LLMAuthError, provider_fallback_reason

    event = {'type': 'response.failed', 'response': {'error': {'code': code, 'message': 'rejected'}}}
    adapter = OpenAIResponsesCompletion(
        base_url='https://api.openai.com/v1',
        api_key='sk-test',
        model='gpt-5-mini',
        transport=httpx.MockTransport(lambda _: httpx.Response(200, text=f'data: {json.dumps(event)}\n\n')),
    )
    with pytest.raises(LLMError) as err:
        adapter.complete('synthetic')
    assert err.value.status_code == expected_status
    assert isinstance(err.value, LLMAuthError) == expected_auth
    assert provider_fallback_reason(err.value) == ('auth' if expected_auth else 'rate_limit')


def test_builtin_bedrock_sonnet_resolves_and_falls_back_to_nova_lite_on_throttling(monkeypatch):
    from control_plane import meeting_voice_completion
    from llm.bedrock_converse import BedrockConverseCompletion
    from llm.errors import PROVIDER_FALLBACK_MARKER

    monkeypatch.setenv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/staging')
    monkeypatch.setenv('TINA_LLM_PROVIDER', 'bedrock-converse')
    monkeypatch.setenv('TINA_LLM_MODEL', 'amazon.nova-lite-v1:0')

    # BedrockConverseCompletion accepts explicit model= kwarg cleanly
    comp = BedrockConverseCompletion(model='us.anthropic.claude-sonnet-4-6', client=SimpleNamespace())
    assert comp.model == 'us.anthropic.claude-sonnet-4-6'

    sonnet_env = meeting_voice_completion.resolve_voice_model_env({'model': 'us.anthropic.claude-sonnet-4-6'})
    assert sonnet_env == {
        'TINA_LLM_PROVIDER': 'bedrock-converse',
        'TINA_LLM_MODEL': 'us.anthropic.claude-sonnet-4-6',
    }
    assert meeting_voice_completion.can_fallback_to_bedrock(sonnet_env) is True
    # Nova Lite (same as deployment default) does not retry onto itself
    nova_env = meeting_voice_completion.resolve_voice_model_env({'model': 'amazon.nova-lite-v1:0'})
    assert meeting_voice_completion.can_fallback_to_bedrock(nova_env) is False
    # Arbitrary non-allowlisted Bedrock model IDs under mode='' are ignored
    assert meeting_voice_completion.resolve_voice_model_env({'model': 'us.anthropic.claude-opus-4-6'}) == {}

    attempts = []

    def fake_run(*_, env, **kwargs):
        attempts.append(dict(env))
        if len(attempts) == 1:
            return SimpleNamespace(
                stderr=f'{PROVIDER_FALLBACK_MARKER}rate_limit\nLLMError: ThrottlingException\n',
                stdout='',
                returncode=1,
            )
        return SimpleNamespace(stderr='', stdout='{"claims":[{"text":"Nova fallback","source_ids":["s0"]}]}', returncode=0)

    monkeypatch.setattr(meeting_voice_completion.subprocess, 'run', fake_run)
    payload = {'request_id': 'sonnet-429-fallback', 'voice_turn': {'meeting_id': 1, 'holder': 's:1'}}
    out = meeting_voice_completion.complete(payload, {'mode': 'voice'}, 'redis://fixture', model_env=sonnet_env)
    assert 'Nova fallback' in out
    assert len(attempts) == 2
    assert attempts[0]['TINA_LLM_MODEL'] == 'us.anthropic.claude-sonnet-4-6'
    assert attempts[0]['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] == '/v2/credentials/staging'
    assert attempts[1]['TINA_LLM_MODEL'] == 'amazon.nova-lite-v1:0'
    assert attempts[1]['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] == '/v2/credentials/staging'



@pytest.mark.parametrize('reason', ['auth', 'rate_limit'])
def test_voice_completion_falls_back_to_bedrock_on_external_auth_or_rate_limit(monkeypatch, reason):
    from control_plane import meeting_voice_completion
    from llm.errors import PROVIDER_FALLBACK_MARKER

    monkeypatch.setenv('AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', '/v2/credentials/staging')
    monkeypatch.setenv('TINA_LLM_PROVIDER', 'bedrock-converse')
    monkeypatch.setenv('TINA_LLM_MODEL', 'amazon.nova-lite-v1:0')

    attempts = []

    def fake_run(*_, env, **kwargs):
        attempts.append(dict(env))
        if len(attempts) == 1:
            return SimpleNamespace(
                stderr=f'{PROVIDER_FALLBACK_MARKER}{reason}\nLLMError: rejected\n',
                stdout='',
                returncode=1,
            )
        return SimpleNamespace(stderr='', stdout='{"claims":[{"text":"Bedrock reply","source_ids":["s0"]}]}', returncode=0)

    monkeypatch.setattr(meeting_voice_completion.subprocess, 'run', fake_run)
    payload = {'request_id': 'fallback-test', 'voice_turn': {'meeting_id': 1, 'holder': 's:1'}}
    openai_env = meeting_voice_completion.resolve_voice_model_env(
        {'mode': 'openai-api', 'api_key': 'sk-bad', 'model': 'gpt-5'},
    )
    out = meeting_voice_completion.complete(payload, {'mode': 'voice'}, 'redis://fixture', model_env=openai_env)
    assert 'Bedrock reply' in out
    assert len(attempts) == 2
    assert attempts[0]['TINA_LLM_PROVIDER'] == 'openai-responses'
    assert attempts[0]['TINA_ALLOW_FALLBACK_RETRY'] == '1'
    assert 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI' not in attempts[0]
    assert attempts[1]['TINA_LLM_PROVIDER'] == 'bedrock-converse'
    assert 'TINA_ALLOW_FALLBACK_RETRY' not in attempts[1]
    assert attempts[1]['TINA_LLM_MODEL'] == 'amazon.nova-lite-v1:0'
    assert attempts[1]['AWS_CONTAINER_CREDENTIALS_RELATIVE_URI'] == '/v2/credentials/staging'


@pytest.mark.parametrize('allow_retry', [True, False])
def test_voice_verify_rerank_and_web_propagate_provider_fallback_only_when_retry_allowed(monkeypatch, allow_retry):
    from llm.errors import LLMAuthError, LLMError, PROVIDER_FALLBACK_MARKER
    from shared.voice_knowledge import VERIFY_SYSTEM
    from shared.voice_rerank import RERANK_SYSTEM
    from worker import engine

    class FakeStream:
        def __init__(self):
            self.events = []

        def xadd(self, _topic, fields):
            self.events.append(json.loads(fields['event']))

        def expire(self, _topic, _ttl):
            pass

    def run_knowledge(req_id: str, source_body: dict, provider_factory):
        stream = FakeStream()
        markers = []
        monkeypatch.setenv('TINA_CHAT_SESSION', f'meeting-knowledge-{req_id}')
        if allow_retry:
            monkeypatch.setenv('TINA_ALLOW_FALLBACK_RETRY', '1')
        else:
            monkeypatch.delenv('TINA_ALLOW_FALLBACK_RETRY', raising=False)
        monkeypatch.setattr(engine, 'completion_from_env', provider_factory)
        monkeypatch.setattr(
            'llm.errors.os.write',
            lambda fd, data: markers.append((fd, data.decode('ascii', errors='replace'))) or len(data),
        )
        inline = PREFIX + json.dumps({'request_id': req_id, 'text': json.dumps(source_body, ensure_ascii=False)})
        engine._run_meeting_knowledge(stream, 'out', {'entrypoint': {'inline': inline}})
        deltas = [e['text'] for e in stream.events if e.get('type') == 'message-delta']
        return deltas, [text for fd, text in markers if fd == 2]

    # 1. Rate-limit (429) during VERIFY_SYSTEM
    class VerifyRateLimitProvider:
        def complete_structured(self, prompt, *, system='', schema=None):
            if system == VERIFY_SYSTEM:
                raise LLMError('rate limited', status_code=429)
            return SimpleNamespace(text=json.dumps({'claims': [{'text': 'Lan phụ trách demo.', 'source_ids': ['s0']}]}))

        def complete(self, prompt, *, system=''):
            return self.complete_structured(prompt, system=system)

    deltas, markers = run_knowledge(
        'verify-429',
        {
            'mode': 'voice',
            'question': 'Ai phụ trách demo?',
            'sources': [{'id': 's0', 'kind': 'transcript', 'quote': 'Lan phụ trách demo.'}],
        },
        lambda **_: VerifyRateLimitProvider(),
    )
    if allow_retry:
        assert deltas == []
        assert f'{PROVIDER_FALLBACK_MARKER}rate_limit\n' in markers
    else:
        assert len(deltas) == 1
        assert json.loads(deltas[0])['reason'] == 'verification_unavailable'
        assert markers == []

    # 2. Rate-limit (429) during RERANK_SYSTEM (>8 sources)
    class RerankRateLimitProvider:
        def complete_structured(self, prompt, *, system='', schema=None):
            if system == RERANK_SYSTEM:
                raise LLMError('rate limited', status_code=429)
            if system == VERIFY_SYSTEM:
                return SimpleNamespace(text=json.dumps({'approved': True}))
            return SimpleNamespace(text=json.dumps({'claims': [{'text': 'Lan phụ trách demo.', 'source_ids': ['s0']}]}))

        def complete(self, prompt, *, system=''):
            return self.complete_structured(prompt, system=system)

    many_sources = [{'id': f's{i}', 'kind': 'transcript', 'quote': f'Lan phụ trách demo {i}.'} for i in range(9)]
    deltas, markers = run_knowledge(
        'rerank-429',
        {'mode': 'voice', 'question': 'Ai phụ trách demo?', 'sources': many_sources},
        lambda **_: RerankRateLimitProvider(),
    )
    if allow_retry:
        assert deltas == []
        assert f'{PROVIDER_FALLBACK_MARKER}rate_limit\n' in markers
    else:
        assert len(deltas) == 1
        assert json.loads(deltas[0])['claims'][0]['source_ids'] == ['s0']
        assert markers == []

    # 3. Auth failure (401) during voice_web completion
    monkeypatch.setenv('TINA_AGENT_REACH_URL', 'http://reach.test:8080')
    monkeypatch.setattr(
        'llm.agent_reach.query',
        lambda *_a, **_kw: {
            'ok': True,
            'items': [{'title': 'Public page', 'url': 'https://example.com/a', 'text': 'Public fact 42.'}],
        },
    )

    class WebAuthFailProvider:
        def complete_structured(self, prompt, *, system='', schema=None):
            raise LLMAuthError('invalid key', status_code=401)

        def complete(self, prompt, *, system=''):
            raise LLMAuthError('invalid key', status_code=401)

    deltas, markers = run_knowledge(
        'web-401',
        {'mode': 'voice_web', 'question': 'What is the public fact?'},
        lambda **_: WebAuthFailProvider(),
    )
    if allow_retry:
        assert deltas == []
        assert f'{PROVIDER_FALLBACK_MARKER}auth\n' in markers
    else:
        assert len(deltas) == 1
        assert json.loads(deltas[0])['reason'] == 'llm_unavailable'
        assert markers == []


def test_warm_voice_worker_pool_reuses_process_isolates_credentials_and_clears_session():
    import os
    from pathlib import Path
    from control_plane.meeting_voice_completion import _WarmVoicePool

    agent_root = str(Path(__file__).resolve().parents[1])
    pool = _WarmVoicePool(max_idle=4, idle_ttl=60.0)
    base_env = {
        'PATH': os.environ.get('PATH', ''),
        'PYTHONPATH': agent_root,
        'HOME': '/tmp',
        'TINA_LLM_PROVIDER': 'openai-compat',
        'TINA_LLM_MODEL': 'gpt-5-mini',
        'TINA_LLM_API_KEY': 'sk-user-a',
    }
    try:
        # 1. Two calls with the same credential fingerprint reuse the exact same warm worker PID.
        r1 = pool.run(
            {'request_id': 'warm-1', 'text': json.dumps({'mode': 'voice_web', 'question': 'Ping 1'})},
            base_env | {'TINA_CHAT_SESSION': 'meeting-knowledge-warm-1'},
            timeout=10.0,
        )
        assert r1.returncode == 0 and json.loads(r1.stdout) == {'reason': 'web_unavailable'}
        assert len(pool._idle) == 1
        key_a = next(iter(pool._idle))
        pid_a = pool._idle[key_a][0].proc.pid

        r2 = pool.run(
            {'request_id': 'warm-2', 'text': json.dumps({'mode': 'voice_web', 'question': 'Ping 2'})},
            base_env | {'TINA_CHAT_SESSION': 'meeting-knowledge-warm-2'},
            timeout=10.0,
        )
        assert r2.returncode == 0 and json.loads(r2.stdout) == {'reason': 'web_unavailable'}
        assert pool._idle[key_a][0].proc.pid == pid_a

        # 2. A different API key spawns a separate isolated process (never shares credential env).
        r3 = pool.run(
            {'request_id': 'warm-3', 'text': json.dumps({'mode': 'voice_web', 'question': 'Ping 3'})},
            base_env | {'TINA_LLM_API_KEY': 'sk-user-b', 'TINA_CHAT_SESSION': 'meeting-knowledge-warm-3'},
            timeout=10.0,
        )
        assert r3.returncode == 0 and json.loads(r3.stdout) == {'reason': 'web_unavailable'}
        assert len(pool._idle) == 2
        key_b = next(k for k in pool._idle if k != key_a)
        assert pool._idle[key_b][0].proc.pid != pid_a

        # 3. Session mismatch error captures stderr for that request without poisoning the next request.
        r_err = pool.run(
            {'request_id': 'warm-bad', 'text': json.dumps({'mode': 'voice_web', 'question': 'Bad'})},
            base_env | {'TINA_CHAT_SESSION': 'meeting-knowledge-other'},
            timeout=10.0,
        )
        assert r_err.stdout == '' and 'ValueError' in r_err.stderr
        r4 = pool.run(
            {'request_id': 'warm-4', 'text': json.dumps({'mode': 'voice_web', 'question': 'Ping 4'})},
            base_env | {'TINA_CHAT_SESSION': 'meeting-knowledge-warm-4'},
            timeout=10.0,
        )
        assert r4.returncode == 0 and json.loads(r4.stdout) == {'reason': 'web_unavailable'}
        assert 'ValueError' not in r4.stderr
    finally:
        pool.shutdown()


def test_bedrock_client_cache_reuses_same_key_and_isolates_credentials(monkeypatch):
    import sys
    from types import ModuleType
    from llm import bedrock_converse

    created = []
    fake_boto3 = ModuleType('boto3')
    fake_boto3.client = lambda service, **kw: (created.append((service, kw)), object())[1]
    fake_botocore_cfg = ModuleType('botocore.config')
    fake_botocore_cfg.Config = lambda **kw: kw
    monkeypatch.setitem(sys.modules, 'boto3', fake_boto3)
    monkeypatch.setitem(sys.modules, 'botocore.config', fake_botocore_cfg)
    bedrock_converse._CLIENT_CACHE.clear()
    try:
        monkeypatch.setenv('AWS_REGION', 'us-east-1')
        monkeypatch.delenv('AWS_BEARER_TOKEN_BEDROCK', raising=False)
        c1 = bedrock_converse._cached_bedrock_client(10.0)
        c2 = bedrock_converse._cached_bedrock_client(10.0)
        assert c1 is c2 and len(created) == 1

        # Changing bearer token or region creates a separate client
        monkeypatch.setenv('AWS_BEARER_TOKEN_BEDROCK', 'bearer-user-a')
        c3 = bedrock_converse._cached_bedrock_client(10.0)
        assert c3 is not c1 and len(created) == 2

        monkeypatch.setenv('AWS_REGION', 'us-west-2')
        c4 = bedrock_converse._cached_bedrock_client(10.0)
        assert c4 is not c3 and len(created) == 3
    finally:
        bedrock_converse._CLIENT_CACHE.clear()

