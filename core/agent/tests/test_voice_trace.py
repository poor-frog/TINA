"""Trace UUIDs cross stages; private content and arbitrary metadata never enter these logs."""
import json
import logging
from uuid import UUID

import pytest

from shared.voice_trace import voice_span, voice_trace_id


def test_nested_trace_records_only_allowlisted_metrics_and_restores_context(caplog):
    identifier = '00000000-0000-4000-8000-000000000123'
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        with voice_span('answer', identifier) as metrics:
            metrics.update(input_sources=10, output_sources=2, question='PRIVATE QUESTION', token='SECRET')
            with pytest.raises(ValueError), voice_span('generation'):
                raise ValueError('PRIVATE PROVIDER BODY')
    records = [json.loads(r.message) for r in caplog.records]
    assert len(records) == 2 and {r['request_id'] for r in records} == {identifier}
    assert records[0]['status'] == 'error' and records[1]['input_sources'] == 10
    assert all(r['elapsed_ms'] >= 0 for r in records)
    assert 'PRIVATE' not in caplog.text and 'SECRET' not in caplog.text
    assert voice_trace_id.get() is None


def test_untrusted_trace_header_is_replaced_with_a_uuid(caplog):
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'), voice_span('answer', 'SECRET\nheader'):
        pass
    record = json.loads(caplog.records[0].message)
    UUID(record['request_id'])
    assert 'SECRET' not in caplog.text


def test_rerank_empty_is_logged_separately_from_failure_without_untrusted_metadata(caplog):
    with voice_span('source_selection') as metrics:metrics.update(outcome='empty',output_sources=0,query='PRIVATE')
    with voice_span('source_selection') as metrics:metrics.update(outcome='PRIVATE OUTCOME')
    records=[json.loads(r.message) for r in caplog.records if r.name=='shared.voice_trace']
    assert records[0]['outcome']=='empty' and records[0]['output_sources']==0
    assert 'outcome' not in records[1] and 'PRIVATE' not in caplog.text


def test_round_and_cancelled_status_are_bounded_and_each_span_has_a_distinct_id(caplog):
    import asyncio
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        with pytest.raises(asyncio.CancelledError), voice_span('rag_plan') as metrics:
            metrics.update(round=2, tool_count=2, parallel=True, lookup_outcome='unavailable', query='PRIVATE QUESTION')
            raise asyncio.CancelledError()
        with voice_span('rag_plan') as metrics: metrics['round'] = True
    records = [json.loads(r.message) for r in caplog.records]
    assert records[0]['status'] == 'cancelled' and records[0]['round'] == 2
    assert records[0]['tool_count'] == 2 and records[0]['parallel'] is True
    assert records[0]['lookup_outcome'] == 'unavailable'
    assert 'round' not in records[1] and records[0]['span_id'] != records[1]['span_id']
    assert 'PRIVATE' not in caplog.text
