"""Per-tool LLM arguments, normalized once to the existing bounded TINA wire format."""
from datetime import date
from copy import deepcopy
import json

from jsonschema import Draft202012Validator, ValidationError


def object_schema(properties):
    return {'type': 'object', 'properties': properties, 'required': list(properties),
            'additionalProperties': False}


QUERY = {'type': 'string', 'minLength': 1, 'maxLength': 200}
HANDLE = {'type': 'string', 'pattern': r'^ctx-[0-9a-f]{64}$'}
HANDLES = {'type': 'array', 'maxItems': 2, 'items': HANDLE}
DATE = {'type': 'string', 'pattern': r'^(?:today|\d{4}-\d{2}-\d{2})$'}
SEARCH_TOOLS = frozenset(('search_meeting', 'search_shared_meetings', 'search_shared_documents', 'search_approved_actions'))
FILTERS = object_schema({
    'speaker_id': {'type': ['string', 'null'], 'minLength': 1, 'maxLength': 80},
    'start_ms': {'type': ['integer', 'null'], 'minimum': 0},
    'end_ms': {'type': ['integer', 'null'], 'minimum': 0},
    'entities': {'type': 'array', 'maxItems': 3, 'items': {'type': 'string', 'minLength': 1, 'maxLength': 40}}})
TOOL_ARGUMENTS = {
    'get_recent_transcript': object_schema({}),
    'search_meeting': object_schema({'query': QUERY}),
    'search_shared_meetings': object_schema({'query': QUERY}),
    'search_shared_documents': object_schema({'query': QUERY}),
    'search_web': object_schema({'query': QUERY}),
    'read_source_context': object_schema({'context_handle': HANDLE}),
    'draft_task': object_schema({'request': QUERY}),
    'draft_decision': object_schema({'request': QUERY}),
    'search_approved_actions': object_schema({'query': QUERY}),
    'calculate': {'anyOf': [
        object_schema({'expression': {'type': 'string', 'minLength': 1, 'maxLength': 100,
                                      'pattern': r'^[\d. +*/%()\-]+$'}, 'context_handles': HANDLES}),
        object_schema({'start_date': DATE, 'end_date': DATE, 'context_handles': HANDLES})]},
    'open_source': object_schema({'source_id': HANDLE}),
}
TOOL_NAMES = frozenset(TOOL_ARGUMENTS)
for _name in SEARCH_TOOLS:
    TOOL_ARGUMENTS[_name] = {'anyOf': [object_schema({'query': QUERY}),
        object_schema({'query': QUERY, 'filters': FILTERS})]}
_VALIDATORS = {name: Draft202012Validator(schema) for name, schema in TOOL_ARGUMENTS.items()}


def parse_search_query(value):
    if value.lstrip().startswith('{'):
        try: body = json.loads(value)
        except ValueError:
            if '"filters"' in value: raise ValueError('Invalid serialized search filters') from None
            body = None
        if isinstance(body, dict) and 'filters' in body:
            try: Draft202012Validator(object_schema({'query': QUERY, 'filters': FILTERS})).validate(body)
            except ValidationError: raise ValueError('Invalid search filters') from None
            filters = body['filters']
            if (filters['start_ms'] is not None and filters['end_ms'] is not None
                    and filters['start_ms'] > filters['end_ms']): raise ValueError('Invalid search interval')
            if not body['query'].strip(): raise ValueError('Empty search query')
            return body['query'], filters
    return value, {}


def tool_call_schema(tools):
    branches = []
    for name in dict.fromkeys(tools):
        if name not in TOOL_NAMES: raise ValueError('Unknown voice tool')
        branches.append(object_schema({'name': {'type': 'string', 'enum': [name]},
                                       'arguments': deepcopy(TOOL_ARGUMENTS[name])}))
    return {'anyOf': branches} if branches else object_schema({})


def normalize_tool_call(call, *, allowed_tools=TOOL_NAMES):
    if not isinstance(call, dict) or not isinstance(call.get('name'), str):
        raise ValueError('Invalid voice tool call')
    name = call['name']
    if name not in TOOL_NAMES or name not in allowed_tools: raise ValueError('Voice tool is not allowed')
    if set(call) == {'name', 'query'}:
        query = call['query']
    elif set(call) == {'name', 'arguments'}:
        arguments = call['arguments']
        try: _VALIDATORS[name].validate(arguments)
        except ValidationError: raise ValueError('Invalid voice tool arguments') from None
        if name == 'get_recent_transcript': query = ''
        elif name == 'read_source_context': query = arguments['context_handle']
        elif name == 'open_source': query = arguments['source_id']
        elif name in ('draft_task', 'draft_decision'): query = arguments['request']
        elif name == 'calculate':
            handles = arguments['context_handles']
            if len(set(handles)) != len(handles): raise ValueError('Repeated calculation source')
            for field in ('start_date', 'end_date'):
                value = arguments.get(field)
                if value is not None and value != 'today':
                    try: date.fromisoformat(value)
                    except ValueError: raise ValueError('Invalid calculation date') from None
            body = {k: v for k, v in arguments.items() if k != 'context_handles' or v}
            query = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False)
        elif name in SEARCH_TOOLS and 'filters' in arguments:
            filters = arguments['filters']
            # Keep the existing bounded transport; no caller identity or meeting scope is accepted.
            query = json.dumps({'query': arguments['query'], 'filters': filters}, separators=(',', ':'), ensure_ascii=False)
            parse_search_query(query)
        else: query = arguments['query']
    else:
        raise ValueError('Invalid voice tool fields')
    if (not isinstance(query, str) or len(query) > 200
            or name != 'get_recent_transcript' and not query.strip()):
        raise ValueError('Invalid or oversized voice tool query')
    if name in SEARCH_TOOLS: parse_search_query(query)
    return {'name': name, 'query': query}
