"""Provider-side voice shapes; source and entailment checks remain mandatory after generation."""
from shared.voice_tools import object_schema, tool_call_schema


class VoiceOutputFormatError(ValueError):
    """A voice candidate still has an invalid shape after its one format repair."""


def voice_schema(mode, sources=(), *, tools=()):
    if mode == 'general':
        return object_schema({'text': {'type': 'string', 'minLength': 1, 'maxLength': 2000}})
    if mode == 'source_intent':
        return object_schema({'route': {'type':'string','enum':['meeting','general','web']}})
    if mode == 'intent':
        return object_schema({'intent': {'type':'string',
            'enum':['greeting','thanks','identity','capabilities','meeting']}})
    ids = list(dict.fromkeys(s['id'] for s in sources))
    source_id = {'type': 'string', **({'enum': ids} if ids else {})}
    if mode == 'verify':
        return object_schema({'approved': {'type': 'boolean'},
            'reason': {'type': ['string', 'null'], 'enum': [None, 'unsupported_claim', 'contradiction', 'ambiguous']},
            'claim_indexes': {'type': ['array', 'null'], 'maxItems': 3, 'items': {'type': 'integer', 'minimum': 0}}})
    if mode == 'rerank':
        return object_schema({'source_ids': {'type': 'array', 'maxItems': 12, 'items': source_id}})
    calls = {'type': 'array', 'maxItems': 2 if tools else 0, 'items': tool_call_schema(tools)}
    if mode == 'plan':
        return object_schema({'tool_calls': calls})
    return object_schema({
        'claims': {'type': 'array', 'maxItems': 3 if ids else 0, 'items': object_schema({
            'text': {'type': 'string', 'maxLength': 800},
            'source_ids': {'type': 'array', 'minItems': 1, 'maxItems': 6, 'items': source_id}})},
        'clarification': {'type': ['string', 'null'], 'maxLength': 200},
        'follow_up': {'type': ['string', 'null'], 'maxLength': 200},
        'tool_calls': calls | {'type': ['array', 'null']} if tools else {'type': 'null'},
    })
