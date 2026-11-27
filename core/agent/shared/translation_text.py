"""Visible translation text, excluding inline reasoning or leaked prompt envelopes."""
from __future__ import annotations

import json
import re


# Fixed error codes cross the translation worker boundary, never provider messages.
TRANSLATION_FAILURE_STATUS = {
    'auth': 401,
    'configuration': 404,
    'rate_limit': 429,
    'unavailable': 503,
    'timeout': 504,
    'request_rejected': 400,
    'invalid_translation': 422,
    'interrupted': 503,
}

_ENVELOPE_VALUE_KEYS = ('translated', 'translation', 'translated_text', 'subtitle', 'output')
_ENVELOPE_ALL_KEYS = frozenset({
    *_ENVELOPE_VALUE_KEYS,
    'source_transcript',
    'source_transcripts',
    'source',
    'speaker',
    'recent_context',
    'error',
})
_TRUNCATED_ENVELOPE_RE = re.compile(
    r'^\s*\{\s*"(?:source_transcript|source_transcripts|translated|translation|translated_text|recent_context|speaker)"\s*:',
    re.IGNORECASE,
)
_XML_WRAPPER_RE = re.compile(r'^\s*<(translation|translated|subtitle)>\s*(.*?)\s*</\1>\s*$', re.DOTALL | re.IGNORECASE)
_LEAKED_PROMPT_TAG_RE = re.compile(r'</?(?:recent_context|speaker|transcript)\b[^>]*>', re.IGNORECASE)


def _strip_code_fence(text: str) -> str:
    lines = text.splitlines()
    if len(lines) >= 3 and lines[0].strip().startswith('```') and lines[-1].strip() == '```':
        return '\n'.join(lines[1:-1]).strip()
    return text


def _visible_translation(text: str, depth: int) -> str:
    for tag in ('think', 'analysis'):
        text = re.sub(rf'<{tag}>.*?</{tag}>', '', text, flags=re.DOTALL | re.IGNORECASE)
        if re.search(rf'</?{tag}>', text, re.IGNORECASE):
            raise ValueError('Incomplete translation reasoning block')
    text = _strip_code_fence(text.strip())
    xml_match = _XML_WRAPPER_RE.match(text)
    if xml_match and depth < 2:
        return _visible_translation(xml_match.group(2), depth + 1)
    if _LEAKED_PROMPT_TAG_RE.search(text):
        raise ValueError('Leaked translation prompt tag')
    if text.startswith('{') and text.endswith('}'):
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            parsed = None
        if isinstance(parsed, dict) and (_ENVELOPE_ALL_KEYS & set(parsed.keys())):
            for key in _ENVELOPE_VALUE_KEYS:
                val = parsed.get(key)
                if isinstance(val, str) and val.strip() and depth < 2:
                    return _visible_translation(val, depth + 1)
            raise ValueError('Malformed structured translation envelope')
    if _TRUNCATED_ENVELOPE_RE.match(text):
        raise ValueError('Truncated structured translation envelope')
    text = text.strip()
    if not text or len(text) > 50000:
        raise ValueError('Empty or oversized translation')
    return text


def visible_translation(text: str) -> str:
    return _visible_translation(text, 0)
