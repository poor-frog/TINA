"""Content-free voice stage timings correlated with the bot's existing request UUID."""
from contextlib import contextmanager
from contextvars import ContextVar
from functools import wraps
import asyncio
import json
import logging
import os
import time
from uuid import UUID, uuid4

log = logging.getLogger('shared.voice_trace')
log.setLevel(logging.INFO)
if not log.hasHandlers(): log.addHandler(logging.StreamHandler())
voice_trace_id = ContextVar('voice_trace_id', default=None)


@contextmanager
def voice_span(stage, request_id=None):
    current = voice_trace_id.get()
    try:
        identifier = str(UUID(str(request_id))) if request_id else current or str(uuid4())
    except (ValueError, AttributeError):
        identifier = current or str(uuid4())
    token = voice_trace_id.set(identifier)
    started = time.monotonic()
    span_id = str(uuid4())
    if os.environ.get('TINA_CHATGPT_VOICE_PILOT') == '1':
        log.info('%s', json.dumps({'type': 'voice_stage', 'request_id': identifier,
            'span_id': span_id, 'stage': stage, 'elapsed_ms': 0, 'status': 'started'}))
    metrics = {}
    status = 'ok'
    try:
        yield metrics
    except BaseException as exc:
        status = 'cancelled' if isinstance(exc, asyncio.CancelledError) else 'error'
        raise
    finally:
        voice_trace_id.reset(token)
        record = {'type': 'voice_stage', 'request_id': identifier, 'span_id': span_id, 'stage': stage,
                  'elapsed_ms': round((time.monotonic() - started) * 1000), 'status': status}
        for key in ('input_sources', 'output_sources'):
            if type(metrics.get(key)) is int: record[key] = metrics[key]
        if type(metrics.get('round')) is int and metrics['round'] in (1, 2): record['round'] = metrics['round']
        if type(metrics.get('tool_count')) is int and metrics['tool_count'] in (1, 2): record['tool_count'] = metrics['tool_count']
        if type(metrics.get('parallel')) is bool: record['parallel'] = metrics['parallel']
        if metrics.get('lookup_outcome') in ('found', 'empty', 'unavailable', 'partial', 'access_changed'):
            record['lookup_outcome'] = metrics['lookup_outcome']
        if metrics.get('outcome') in ('applied', 'empty', 'fallback', 'skipped'): record['outcome'] = metrics['outcome']
        log.info('%s', json.dumps(record))


def trace_voice_request(stage):
    def decorate(function):
        @wraps(function)
        def traced(*args, **kwargs):
            request = kwargs.get('request') if 'request' in kwargs else args[0]
            with voice_span(stage, request.headers.get('x-tina-voice-request-id')):
                return function(*args, **kwargs)
        return traced
    return decorate
