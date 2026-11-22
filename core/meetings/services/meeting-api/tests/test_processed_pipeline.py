import json

import fakeredis.aioredis
import pytest

from meeting_api.collector.processed_notes import REQUESTS, RESULTS, publish_request, drain_results
from meeting_api.collector.transcript_revisions import dispatch_revisions
from test_bot_refinement import fixture


def reply(job):
    return dict(job, notes=[{'id': e['segment_id'], 'text': e['quote']} for e in job['source']['evidence']], params={'model': 'fake'})


@pytest.mark.asyncio
async def test_revision_safe_pipeline_publish_and_replay(monkeypatch):
    monkeypatch.setenv('INTERNAL_API_SECRET', 'private-test')
    client, store, _, _, _ = await fixture(monkeypatch)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    async with client:
        path = '/transcripts/by-id/1/processed-notes'
        assert (await client.post(path, json={'enabled': True})).status_code == 200
        assert (await client.post(path, json={'enabled': True}, headers={'x-user-id': '8'})).status_code == 404
        job = await publish_request(redis, store, 7, 1)
        assert job and len(await redis.xrange(REQUESTS)) == 1
        lease = {k: job['source'][k] for k in ('window_id', 'generation', 'fingerprint')}
        assert (await client.post(path+'/validate', json=lease)).json() == {'valid': True}
        await redis.xadd(RESULTS, {'payload': json.dumps(reply(job))})
        await drain_results(redis, store)
        state = (await client.get(path)).json()
        assert state['view']['doc']['notes'][0]['stale'] is False
        await dispatch_revisions(store, redis)
        rows = await redis.xrange('proc:meeting:1')
        assert any('note' in fields for _, fields in rows)
        edit = await client.patch('/transcripts/by-id/1/segments/s%2F1', json={'expected_revision': 0, 'text': 'New manual wording.'})
        assert edit.status_code == 200
        # Invalidated in the edit transaction, before any periodic projection runs.
        assert store._meetings[1]['data']['processed']['views'][0]['doc']['notes'][0]['stale']
        assert (await client.post(path+'/validate', json=lease)).json() == {'valid': False}
        await redis.xadd(RESULTS, {'payload': json.dumps(reply(job))})
        await drain_results(redis, store)
        assert (await client.get(path)).json()['view']['doc']['notes'][0]['stale']
        newer = await publish_request(redis, store, 7, 1)
        assert newer['source']['evidence'][0]['quote'] == 'New manual wording.'
        await redis.xadd(RESULTS, {'payload': json.dumps(reply(newer))})
        await drain_results(redis, store)
        fresh = (await client.get(path)).json()['view']['doc']['notes'][0]
        assert not fresh['stale'] and fresh['evidence'][0]['revision'] == 1
        # Public-stream history is not allowed to overwrite the canonical-authorized result.
        await store.merge_processed_view(1, view_id='copilot-notes', kind='cleaned_transcript',
            notes=[{'id': fresh['id'], 'text': 'old unguarded text'}], source_cursor='999-0')
        assert (await client.get(path)).json()['view']['doc']['notes'][0]['text'] == fresh['text']
        before = len(store._meetings[1]['data']['transcript_outbox'])
        await redis.xadd(RESULTS, {'payload': json.dumps(reply(newer))})
        await drain_results(redis, store)
        assert len(store._meetings[1]['data']['transcript_outbox']) == before
        assert await redis.xlen(RESULTS) == 0


@pytest.mark.asyncio
async def test_claim_retry_after_publisher_crash_and_off_revokes_lease(monkeypatch):
    client, store, _, _, _ = await fixture(monkeypatch)
    async with client:
        await client.post('/transcripts/by-id/1/processed-notes', json={'enabled': True})
        job = await store.processed_notes(7, 1, action='claim')
        await client.post('/transcripts/by-id/1/processed-notes', json={'enabled': True})
        assert store._meetings[1]['data']['canonical_notes']['windows'][job['source']['window_id']]['generation'] == job['source']['generation']
        # Crash after durable claim, before queue delivery: lease expiry makes it retryable.
        store._meetings[1]['data']['canonical_notes']['windows'][job['source']['window_id']]['lease_until'] = 0
        newer = await store.processed_notes(7, 1, action='claim')
        assert newer['source']['generation'] != job['source']['generation']
        assert not (await store.processed_notes(7, 1, action='result', payload=reply(job)))['accepted']
        await client.post('/transcripts/by-id/1/processed-notes', json={'enabled': False})
        assert not (await store.processed_notes(7, 1, action='result', payload=reply(newer)))['accepted']


@pytest.mark.asyncio
async def test_processed_notes_wait_until_the_meeting_finishes(monkeypatch):
    monkeypatch.setenv('INTERNAL_API_SECRET', 'private-test')
    client, store, _, _, _ = await fixture(monkeypatch)
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    async with client:
        path = '/transcripts/by-id/1/processed-notes'
        row = store._meetings[1]
        row['status'] = 'active'
        first = row['segments']['s/1']
        row['segments']['later'] = dict(first, segment_id='later', start=first['start'] + 75, end=first['end'] + 75)
        await client.post(path, json={'enabled': True})
        for status in ('active', 'stopping'):
            row['status'] = status
            assert await publish_request(redis, store, 7, 1) is None
            assert await store.processed_notes(7, 1, action='claim') is None
        assert await redis.xlen(REQUESTS) == 0
        row['status'] = 'completed'
        job = await publish_request(redis, store, 7, 1)
        assert [e['segment_id'] for e in job['source']['evidence']] == ['s/1']
        result = reply(job)
        result['notes'][0]['text'] = 'Câu đã làm sạch.'
        await redis.xadd(RESULTS, {'payload': json.dumps(result)})
        await drain_results(redis, store)
        state = (await client.get(path)).json()
        assert state['finished'] is True
        assert state['view']['doc']['notes'][0]['text'] == 'Câu đã làm sạch.'
        assert row['segments']['s/1']['text'] != 'Câu đã làm sạch.'
        tail = await publish_request(redis, store, 7, 1)
        assert [e['segment_id'] for e in tail['source']['evidence']] == ['later']


@pytest.mark.asyncio
async def test_artifact_queue_purge_is_meeting_scoped():
    from meeting_api.collector.processed_notes import purge_queued
    redis = fakeredis.aioredis.FakeRedis(decode_responses=True)
    for stream in (REQUESTS, RESULTS):
        await redis.xadd(stream, {'payload': json.dumps({'meeting_id': 1, 'private_text': 'fixture'})})
        await redis.xadd(stream, {'payload': json.dumps({'meeting_id': 2, 'private_text': 'other fixture'})})
    await purge_queued(redis, 1)
    for stream in (REQUESTS, RESULTS):
        rows = await redis.xrange(stream)
        assert len(rows) == 1 and json.loads(rows[0][1]['payload'])['meeting_id'] == 2
