"""Typed tool input is restrictive; the normalized HTTP/Redis shape remains compatible."""
import json

import pytest
from jsonschema import Draft202012Validator

from shared.voice_schema import voice_schema
from shared.voice_tools import TOOL_NAMES, normalize_tool_call
from shared.voice_knowledge import voice_tool_calls

HANDLE = 'ctx-' + 'a' * 64
CASES = [
    ('get_recent_transcript', {}, ''),
    *[(name, {'query': 'demo'}, 'demo') for name in ('search_meeting', 'search_shared_meetings',
       'search_shared_documents', 'search_web', 'search_approved_actions')],
    ('read_source_context', {'context_handle': HANDLE}, HANDLE),
    ('open_source', {'source_id': HANDLE}, HANDLE),
    ('draft_task', {'request': 'Tạo bản nháp demo'}, 'Tạo bản nháp demo'),
    ('draft_decision', {'request': 'Ghi đề xuất backend'}, 'Ghi đề xuất backend'),
    ('calculate', {'expression': '100+200', 'context_handles': []}, '{"expression":"100+200"}'),
    ('calculate', {'start_date': 'today', 'end_date': '2026-11-20', 'context_handles': []},
     '{"end_date":"2026-11-20","start_date":"today"}'),
]


@pytest.mark.parametrize('name,arguments,query', CASES)
def test_typed_arguments_match_provider_schema_and_round_trip_existing_wire(name, arguments, query):
    schema = voice_schema('plan', tools=[name]); Draft202012Validator.check_schema(schema)
    call = {'name': name, 'arguments': arguments}
    Draft202012Validator(schema).validate({'tool_calls': [call]})
    expected = {'name': name, 'query': query}
    assert normalize_tool_call(call) == expected
    assert normalize_tool_call(expected) == expected
    assert voice_tool_calls(json.dumps({'tool_calls': [call]}), allowed_tools=[name]) == [expected]
    assert not Draft202012Validator(schema).is_valid({'tool_calls': [expected]})


@pytest.mark.parametrize('call', [
    {'name': 'search_meeting', 'arguments': {'query': 'demo', 'meeting_id': 999}},
    {'name': 'search_shared_documents', 'arguments': {'path': '/private'}},
    {'name': 'get_recent_transcript', 'arguments': {'query': 'private'}},
    {'name': 'read_source_context', 'arguments': {'context_handle': 'https://private.test'}},
    {'name': 'open_source', 'arguments': {'source_id': '/etc/passwd'}},
    {'name': 'search_web', 'arguments': {'query': ' ' * 3}},
    {'name': 'search_web', 'arguments': {'query': 'x' * 201}},
    {'name': 'search_meeting', 'arguments': {'query': True}},
    {'name': 'draft_task', 'arguments': {'request': 'demo', 'approved': True}},
    {'name': 'calculate', 'arguments': {'expression': '1+1'}},
    {'name': 'calculate', 'arguments': {'expression': '__import__("os")', 'context_handles': []}},
    {'name': 'calculate', 'arguments': {'expression': '1+1', 'start_date': 'today', 'context_handles': []}},
    {'name': 'calculate', 'arguments': {'start_date': 'today', 'end_date': '2026-02-30', 'context_handles': []}},
    {'name': 'calculate', 'arguments': {'start_date': 'today', 'end_date': 'thứ Sáu', 'context_handles': []}},
    {'name': 'calculate', 'arguments': {'expression': '1+1', 'context_handles': [HANDLE, HANDLE]}},
    {'name': 'search_meeting', 'arguments': {'query': 'demo'}, 'query': 'bypass'},
    {'name': [], 'arguments': {}}, {'name': 'approve_task', 'arguments': {}},
])
def test_wrong_fields_types_scope_handles_and_dates_are_rejected(call):
    with pytest.raises(ValueError): normalize_tool_call(call)


def test_tool_schema_and_normalizer_enforce_current_allowlist_and_wire_budget():
    call = {'name': 'calculate', 'arguments': {'expression': '100+200', 'context_handles': []}}
    assert not Draft202012Validator(voice_schema('plan', tools=['search_meeting'])).is_valid({'tool_calls': [call]})
    with pytest.raises(ValueError): normalize_tool_call(call, allowed_tools=['search_meeting'])
    with pytest.raises(ValueError): voice_tool_calls(json.dumps({'tool_calls': [call]}))
    long = {'name': 'calculate', 'arguments': {'expression': '1+' * 49 + '1',
                                             'context_handles': [HANDLE, 'ctx-' + 'b' * 64]}}
    with pytest.raises(ValueError, match='oversized'): normalize_tool_call(long)
    assert len(CASES) == 12 and {name for name, _, _ in CASES} == TOOL_NAMES
    schema = voice_schema('plan', tools=['search_meeting'])
    schema['properties']['tool_calls']['items']['anyOf'][0]['properties']['arguments']['anyOf'][0]['properties']['query']['maxLength'] = 1
    assert normalize_tool_call({'name': 'search_meeting', 'arguments': {'query': 'demo'}})['query'] == 'demo'
    assert Draft202012Validator(voice_schema('plan', tools=['search_meeting'])).is_valid(
        {'tool_calls': [{'name': 'search_meeting', 'arguments': {'query': 'demo'}}]})
