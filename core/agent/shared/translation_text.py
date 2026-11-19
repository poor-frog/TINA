"""Visible translation text, excluding inline reasoning emitted by some compatible models."""
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


def visible_translation(text: str) -> str:
    for tag in ('think', 'analysis'):
        text = re.sub(rf'<{tag}>.*?</{tag}>', '', text, flags=re.DOTALL | re.IGNORECASE)
        if re.search(rf'</?{tag}>', text, re.IGNORECASE):
            raise ValueError('Incomplete translation reasoning block')
    text = text.strip()
    if not text or len(text) > 50000:
        raise ValueError('Empty or oversized translation')
    return text
