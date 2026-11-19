import json

import httpx
import pytest

from llm.openai_responses import OpenAIResponsesCompletion
from llm.errors import LLMError


def test_web_requires_actual_search_and_preserves_only_provider_citation_urls(monkeypatch):
    monkeypatch.setenv('TINA_LLM_MAX_TOKENS', '')
    seen = []
    def handler(request):
        seen.append(json.loads(request.content))
        body = {'output': [{'type': 'web_search_call', 'status': 'completed'},
                           {'type': 'message', 'content': [{'type': 'output_text', 'text': 'Redis is a database.',
                            'annotations': [{'type': 'url_citation', 'url': 'https://redis.io/docs/', 'title': 'Redis'},
                                            {'type': 'url_citation', 'url': 'javascript:alert(1)', 'title': 'bad'}]}]}]}
        return httpx.Response(200, text='data: ' + json.dumps({'type': 'response.completed', 'response': body}) + '\n\n')
    adapter = OpenAIResponsesCompletion(api_key='test', model='configured-model', transport=httpx.MockTransport(handler))
    result = adapter.search('What is Redis?')
    assert result.text == 'Redis is a database.' and result.sources == ({'url': 'https://redis.io/docs/', 'title': 'Redis'},)
    assert seen[0]['tools'] == [{'type': 'web_search'}] and seen[0]['tool_choice'] == 'required'
    assert seen[0]['input'][0]['content'][0]['text'] == 'What is Redis?'
    adapter.complete('ordinary prompt')
    assert 'tools' not in seen[1]


@pytest.mark.parametrize('body', [{}, {'output': [{'type': 'web_search_call', 'status': 'completed'}]}])
def test_web_fails_closed_on_missing_citations_or_incomplete_stream(body):
    def handler(_):
        return httpx.Response(200, text='data: ' + json.dumps({'type': 'response.completed', 'response': body}) + '\n\n')
    adapter = OpenAIResponsesCompletion(api_key='test', model='configured-model', transport=httpx.MockTransport(handler))
    with pytest.raises(LLMError): adapter.search('Public question')


def test_stream_only_citations_and_search_receipt_work_with_an_empty_completed_envelope():
    def handler(_):
        events = [{'type': 'response.web_search_call.completed'},
                  {'type': 'response.output_text.delta', 'delta': 'Redis is a database.'},
                  {'type': 'response.output_text.annotation.added', 'annotation': {
                      'type': 'url_citation', 'url': 'https://redis.io/docs/', 'title': 'Redis'}},
                  {'type': 'response.completed', 'response': {}}]
        return httpx.Response(200, text=''.join('data: '+json.dumps(e)+'\n\n' for e in events))
    adapter = OpenAIResponsesCompletion(api_key='test', model='configured-model', transport=httpx.MockTransport(handler))
    assert adapter.search('Redis?').sources == ({'url': 'https://redis.io/docs/', 'title': 'Redis'},)


@pytest.mark.parametrize('text', ['{"claims":[{"text":"Lan phụ trách demo.","source_ids":["s0"]}]}',
                                  '{"approved":true}'])
@pytest.mark.parametrize('terminal', [None, '[DONE]', 'response.incomplete', 'response.failed', 'bad_completed_status'])
def test_generation_and_verifier_reject_valid_json_from_an_unfinished_response(text, terminal):
    events = [{'type': 'response.output_text.delta', 'delta': text}]
    if terminal == 'bad_completed_status':
        events.append({'type': 'response.completed', 'response': {'status': 'incomplete'}})
    elif terminal and terminal != '[DONE]':
        events.append({'type': terminal, 'response': {'incomplete_details': {'reason': 'max_output_tokens'}}})
    wire = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events)
    if terminal == '[DONE]': wire += 'data: [DONE]\n\n'
    adapter = OpenAIResponsesCompletion(api_key='test', model='configured-model',
        transport=httpx.MockTransport(lambda _: httpx.Response(200, text=wire)))
    with pytest.raises(LLMError): adapter.complete('Synthetic generation or verification')


@pytest.mark.parametrize('delta', [False, True])
def test_regular_completion_accepts_successful_terminal_envelope_with_or_without_deltas(delta):
    text = '{"approved":true}'
    events = [{'type': 'response.output_text.delta', 'delta': text}] if delta else []
    events.append({'type': 'response.completed', 'response': {'status': 'completed', 'output_text': text}})
    wire = ''.join('data: ' + json.dumps(event) + '\n\n' for event in events)
    adapter = OpenAIResponsesCompletion(api_key='test', model='configured-model',
        transport=httpx.MockTransport(lambda _: httpx.Response(200, text=wire)))
    assert adapter.complete('Synthetic verification').text == text
