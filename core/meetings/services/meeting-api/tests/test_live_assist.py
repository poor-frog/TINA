"""Replay/fault tests drive the same pure state transitions used under the SQL row lock."""
import copy

import pytest

from meeting_api.collector import live_assist as a
from meeting_api.collector.transcript_document import CorrectionConflict


def segment(i=1, text='I will investigate the retry hypothesis.'):
    return {'segment_id': str(i), 'revision': 0, 'speaker_id': 's1', 'speaker_revision': 0,
            'speaker_name': 'A', 'start_ms': i*1000, 'end_ms': i*1000+900, 'text': text}


def setup():
    canon = {'meeting_id': 1, 'segments': [segment()]}
    data = {}
    a.transition(data, canon, 'active', 'configure', {'enabled': True}, 7, 7, [7, 8], now=100)
    return data, canon


def call(data, canon, action, payload=None, now=130, status='active', actor=7):
    return a.transition(data, canon, status, action, payload or {}, actor, 7, [7, 8], now=now)


def result(job, items=None):
    e = {k: segment()[k] for k in ('segment_id', 'revision', 'speaker_revision', 'speaker_name', 'start_ms')}
    e['quote'] = segment()['text']
    return {'role': job['role'], 'generation': job['generation'], 'output': {
        'items': items if items is not None else [{'type': 'task', 'text': 'Investigate retry hypothesis', 'evidence': [e]}]}}


def extracted():
    data, canon = setup()
    job = call(data, canon, 'claim', {'role': 'fast'})
    assert call(data, canon, 'result', result(job))['accepted']
    return data, canon, job


def reason_result(job):
    return {'role': 'reason', 'generation': job['generation'], 'output': {
        'patches': [{k: i[k] for k in ('id', 'text', 'evidence')} for i in job['context']['items']],
        'summaries': {'current': 'Discussing retries', 'meeting': 'Investigating a hypothesis'}}}


def test_timed_flush_no_new_frame_and_no_empty_calls():
    data, canon = setup()
    assert call(data, canon, 'claim', {'role': 'fast'}, now=129) is None
    job = call(data, canon, 'claim', {'role': 'fast'}, now=130)
    assert [{k: v for k, v in s.items() if k != 'speaker_status'} for s in job['segments']] == canon['segments']
    assert call(data, canon, 'claim', {'role': 'fast'}, now=131) is None
    call(data, canon, 'result', result(job), now=132)
    assert call(data, canon, 'claim', {'role': 'fast'}, now=200) is None


@pytest.mark.parametrize('match', ['host', 'missing', 'other', 'removed', 'multiple', 'omitted', 'malformed'])
def test_fast_groups_only_under_an_offered_current_host_agenda(match):
    data, canon = setup()
    call(data, canon, 'add', {'type': 'agenda', 'text': 'Retry testing'}, now=101)
    call(data, canon, 'add', {'type': 'agenda', 'text': 'Support schedule'}, now=102)
    state = data['live_assist']
    host, other = state['items'].values()
    job = call(data, canon, 'claim', {'role': 'fast'})
    assert job['context']['agenda'] == [{k: item[k] for k in ('id', 'text')} for item in (host, other)]
    candidate = result(job)['output']['items'][0]
    if match != 'omitted':
        candidate['details'] = {'agenda_ids': {
            'host': [host['id']], 'missing': [], 'other': ['invented'], 'removed': [host['id']],
            'multiple': [host['id'], other['id']], 'malformed': {'invalid': True},
        }[match]}
    if match == 'removed':
        state['items'][host['id']]['withdrawn'] = True
    assert call(data, canon, 'result', result(job, [candidate]), now=131)['accepted']
    item = next(value for value in state['items'].values() if value['type'] == 'task')
    assert item['details']['agenda_ids'] == ([host['id']] if match == 'host' else [])
    assert item['provisional'] and 'reason' not in state['jobs']
    assert len(state['covered']) == 1


@pytest.mark.parametrize('locked', [False, True])
def test_later_fast_mention_fills_an_empty_agenda_unless_human_locked(locked):
    data, canon = setup()
    call(data, canon, 'add', {'type': 'agenda', 'text': 'Retry testing'}, now=101)
    state = data['live_assist']
    host_id = next(iter(state['items']))
    first = call(data, canon, 'claim', {'role': 'fast'})
    assert call(data, canon, 'result', result(first), now=131)['accepted']
    item = next(value for value in state['items'].values() if value['type'] == 'task')
    if locked:
        item['manual_fields'] = ['details.agenda_ids']
    second_source = segment(2)
    canon['segments'].append(second_source)
    call(data, canon, 'state', now=132)
    second = call(data, canon, 'claim', {'role': 'fast'}, now=162)
    candidate = result(second)['output']['items'][0]
    candidate['evidence'][0].update(segment_id='2', start_ms=second_source['start_ms'])
    candidate['details'] = {'agenda_ids': [host_id]}
    assert call(data, canon, 'result', result(second, [candidate]), now=163)['accepted']
    assert len(item['evidence']) == 2
    assert item['details']['agenda_ids'] == ([] if locked else [host_id])


def test_two_stages_can_overlap_and_duplicate_result_is_idempotent():
    data, canon, fast = extracted()
    reason = call(data, canon, 'claim', {'role': 'reason'}, now=131)
    assert reason
    canon['segments'].append(segment(2))
    call(data, canon, 'state', now=132)
    next_fast = call(data, canon, 'claim', {'role': 'fast'}, now=162)
    assert next_fast and reason['generation'] != next_fast['generation']
    before = copy.deepcopy(data['live_assist']['items'])
    assert call(data, canon, 'result', result(fast), now=163)['reason'] == 'stale_job'
    assert before == data['live_assist']['items']


def test_fabricated_quote_rejected_without_partial_commit():
    data, canon = setup()
    job = call(data, canon, 'claim', {'role': 'fast'})
    payload = result(job)
    payload['output']['items'][0]['evidence'][0]['quote'] = 'invented'
    assert not call(data, canon, 'result', payload)['accepted']
    assert not data['live_assist']['items'] and not data['live_assist']['covered']


def test_pause_revokes_result_and_reenable_replays():
    data, canon = setup()
    old = call(data, canon, 'claim', {'role': 'fast'})
    call(data, canon, 'configure', {'enabled': False}, now=131)
    assert not call(data, canon, 'result', result(old), now=132)['accepted']
    call(data, canon, 'configure', {'enabled': True}, now=133)
    new = call(data, canon, 'claim', {'role': 'fast'}, now=134)
    assert new and new['epoch'] != old['epoch']


def test_transcript_revision_revokes_only_affected_source():
    data, canon = setup()
    old = call(data, canon, 'claim', {'role': 'fast'})
    canon['segments'][0].update(text='I will not investigate it.', revision=1)
    assert call(data, canon, 'result', result(old))['reason'] == 'stale_job'
    assert not data['live_assist']['covered']
    assert 'fast' not in data['live_assist']['inflight']
    assert data['live_assist']['jobs']['fast']['status'] == 'pending'
    assert call(data, canon, 'claim', {'role': 'fast'}, now=131) is None


def test_stale_manual_edit_rejected_and_human_conflict_proposed():
    data, canon, _ = extracted()
    iid = next(iter(data['live_assist']['items']))
    call(data, canon, 'edit', {'id': iid, 'expected_revision': 1, 'patch': {'text': 'Human version'}})
    with pytest.raises(CorrectionConflict):
        call(data, canon, 'edit', {'id': iid, 'expected_revision': 1, 'patch': {'text': 'stale'}})
    job = call(data, canon, 'claim', {'role': 'reason'}, now=131)
    evidence = data['live_assist']['items'][iid]['evidence']
    payload = {'role': 'reason', 'generation': job['generation'], 'output': {'patches': [
        {'id': iid, 'text': 'AI conflict', 'status': 'proposed', 'evidence': evidence}], 'summaries': {'current': '', 'meeting': ''}}}
    assert call(data, canon, 'result', payload, now=132)['accepted']
    assert data['live_assist']['items'][iid]['text'] == 'Human version'
    proposal = next(iter(data['live_assist']['proposals']))
    with pytest.raises(PermissionError):
        call(data, canon, 'vote', {'id': proposal, 'approve': True}, actor=8)
    call(data, canon, 'vote', {'id': proposal, 'approve': True})
    assert data['live_assist']['items'][iid]['text'] == 'AI conflict'


def test_reason_result_cannot_overwrite_concurrent_human_edit():
    data, canon, _ = extracted()
    job = call(data, canon, 'claim', {'role': 'reason'})
    iid = next(iter(data['live_assist']['items']))
    call(data, canon, 'edit', {'id': iid, 'expected_revision': 1, 'patch': {'text': 'New human value'}})
    payload = {'role': 'reason', 'generation': job['generation'], 'output': {'patches': [
        {'id': iid, 'text': 'Old AI value', 'evidence': data['live_assist']['items'][iid]['evidence']}], 'summaries': {'current': '', 'meeting': ''}}}
    assert call(data, canon, 'result', payload)['stale_patches']
    assert data['live_assist']['items'][iid]['text'] == 'New human value'


def test_unrelated_new_speech_does_not_stale_reasoning():
    data, canon, _ = extracted()
    job = call(data, canon, 'claim', {'role': 'reason'})
    canon['segments'].append(segment(2))
    payload = reason_result(job)
    assert call(data, canon, 'result', payload)['accepted']
    assert data['live_assist']['summaries']['current'] == 'Discussing retries'


def test_terminal_background_finalizes_but_human_edits_readonly():
    data, canon, _ = extracted()
    call(data, canon, 'state', now=150, status='completed')
    call(data, canon, 'drain', now=150, status='completed')
    assert call(data, canon, 'claim', {'role': 'reason'}, now=151, status='completed') is None
    job = call(data, canon, 'claim', {'role': 'reason'}, now=156, status='completed')
    payload = reason_result(job)
    assert call(data, canon, 'result', payload, now=157, status='completed')['accepted']
    assert data['live_assist']['final'] == 'complete'
    with pytest.raises(CorrectionConflict):
        call(data, canon, 'edit', {'id': 'goal', 'expected_revision': 0, 'patch': {'text': 'Later'}}, status='completed')


def test_projection_hides_internal_metadata_and_stale_quotes():
    data, canon, _ = extracted()
    canon['segments'][0]['revision'] += 1
    view = call(data, canon, 'state')
    assert 'jobs' not in view and 'covered' not in view and 'ended_at' not in view
    assert view['items'][0]['stale'] and view['items'][0]['evidence'] == []


def test_state_view_pages_recent_and_archived_item_history():
    data, canon = setup()
    state = data['live_assist']
    for n in range(205):
        iid = f'item-{n:03d}'
        state['items'][iid] = {'id': iid, 'type': 'question', 'text': f'Question {n}', 'status': 'open',
            'revision': 1, 'human': True, 'provisional': False, 'stale': False, 'withdrawn': False,
            'created_sequence': n, 'sequence': n, 'evidence': [], 'details': {}, 'manual_fields': ['text']}
    recent = a.view(state, 'active', owner=True)
    assert len(recent['items']) == 100 and len(recent['archive_items']) == 100
    assert recent['archive_count'] == 105 and recent['archive_more']
    next_page = a.view(state, 'active', owner=True, archive_offset=100)
    assert len(next_page['archive_items']) == 5 and not next_page['archive_more']
    assert all('jobs' not in view for view in (recent, next_page))


def test_retries_bounded_and_operator_retry_resets():
    data, canon = setup()
    for n in range(3):
        job = call(data, canon, 'claim', {'role': 'fast'}, now=130+n*40)
        assert job
        call(data, canon, 'result', {'role': 'fast', 'generation': job['generation'], 'error': 'timeout'}, now=131+n*40)
    assert call(data, canon, 'claim', {'role': 'fast'}, now=300) is None
    call(data, canon, 'retry', now=301)
    assert call(data, canon, 'claim', {'role': 'fast'}, now=302)


@pytest.mark.asyncio
async def test_routes_reject_external_job_publication_and_shared_edits_work(monkeypatch):
    from httpx import AsyncClient, ASGITransport
    from meeting_api.collector.app import create_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore, FakeRedisBus
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=7, meeting_id=1, platform='google_meet', native_meeting_id='abc', status='active',
                       segments=[dict(segment(), start=1, end=2, speaker='A', completed=True)])
    from fakeredis.aioredis import FakeRedis
    app = create_app(store=store, redis=FakeRedisBus(FakeRedis(decode_responses=True)))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/transcripts/by-id/1/state', headers={'X-User-Id': '99'})).status_code == 404
        assert (await client.post('/transcripts/by-id/1/state/configure', headers={'X-User-Id': '7'}, json={'enabled': True})).status_code == 200
        assert (await client.post('/transcripts/by-id/1/state/result', headers={'X-User-Id': '7'}, json={})).status_code == 403


def test_targeted_replay_withdraws_old_inferred_item_and_can_finalize():
    data, canon, _ = extracted()
    old_id = next(iter(data['live_assist']['items']))
    canon['segments'][0]['revision'] = 1
    call(data, canon, 'state', now=140)
    job = call(data, canon, 'claim', {'role': 'fast'}, now=170)
    payload = result(job)
    payload['output']['items'][0]['evidence'][0]['revision'] = 1
    assert call(data, canon, 'result', payload, now=171)['accepted']
    assert data['live_assist']['items'][old_id]['withdrawn']
    assert len([i for i in data['live_assist']['items'].values() if not i['withdrawn']]) == 1


def test_exact_repeated_mention_keeps_id_and_adds_evidence():
    data, canon, _ = extracted()
    iid = next(iter(data['live_assist']['items']))
    canon['segments'].append(segment(2))
    call(data, canon, 'state', now=140)
    job = call(data, canon, 'claim', {'role': 'fast'}, now=170)
    payload = result(job)
    payload['output']['items'][0]['evidence'][0]['segment_id'] = '2'
    assert call(data, canon, 'result', payload, now=171)['accepted']
    assert list(data['live_assist']['items']) == [iid]
    assert len(data['live_assist']['items'][iid]['evidence']) == 2


def test_policy_restricts_edits_and_revokes_inflight_work():
    data, canon = setup()
    job = call(data, canon, 'claim', {'role': 'fast'})
    call(data, canon, 'policy', {'version': 1, 'editors': [7], 'approval_modes': ['host'], 'audit_days': 30})
    with pytest.raises(PermissionError):
        call(data, canon, 'edit', {'id': 'goal', 'expected_revision': 0, 'patch': {'text': 'Forbidden'}}, actor=8)
    with pytest.raises(PermissionError):
        call(data, canon, 'configure', {'approval': 'any'})
    assert not call(data, canon, 'result', result(job))['accepted']
    with pytest.raises(CorrectionConflict):
        call(data, canon, 'policy', {'version': 1})


def test_source_attribution_is_server_owned():
    data, canon = setup()
    job = call(data, canon, 'claim', {'role': 'fast'})
    payload = result(job)
    payload['output']['items'][0]['evidence'][0].update(speaker_name='Fabricated name', start_ms=900000)
    call(data, canon, 'result', payload)
    e = next(iter(data['live_assist']['items'].values()))['evidence'][0]
    assert e['speaker_name'] == 'A' and e['start_ms'] == 1000


def test_final_publish_waits_for_ingestion_drain_and_cannot_overwrite_after_pause():
    data, canon, _ = extracted()
    call(data, canon, 'state', status='completed', now=150)
    assert call(data, canon, 'claim', {'role': 'reason'}, status='completed', now=160) is None
    call(data, canon, 'drain', status='completed', now=160)
    reason = call(data, canon, 'claim', {'role': 'reason'}, status='completed', now=161)
    call(data, canon, 'result', reason_result(reason), status='completed', now=162)
    publish = call(data, canon, 'claim', {'role': 'publish'}, status='completed', now=163)
    assert publish and '# Meeting state' in publish['markdown']
    call(data, canon, 'drain', {'ready': False}, status='completed', now=164)
    payload = {'role': 'publish', 'generation': publish['generation'], 'outcome': 'published',
               'audience_stamp': publish['audience_stamp'], 'publication_revision': publish['publication_revision'], 'source_keys': publish['source_keys']}
    assert not call(data, canon, 'result', payload, status='completed', now=165)['accepted']


@pytest.mark.asyncio
async def test_scheduler_survives_silence_and_acks_results_after_commit(monkeypatch):
    import json
    from fakeredis.aioredis import FakeRedis
    from meeting_api.collector.fakes import InMemoryTranscriptStore
    from meeting_api.collector.live_assist_queue import tick
    monkeypatch.setenv('INTERNAL_API_SECRET', 'test-signing-secret')
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=7, meeting_id=1, platform='google_meet', native_meeting_id='abc',
        segments=[dict(segment(), start=1, end=2, speaker='A', completed=True)])
    await store.live_assist(7, 1, action='configure', payload={'enabled': True})
    live = store._meetings[1]['data']['live_assist']
    live['source_seen']['1']['at'] -= 31
    live['window_at'] -= 31
    redis = FakeRedis(decode_responses=True)
    await tick(redis, store)
    requests = await redis.xrange(a.REQUESTS)
    assert len(requests) == 1, store._meetings[1]['data']['live_assist']
    request = json.loads(requests[0][1]['payload'])
    assert request['proof'] and request['role'] == 'fast'
    payload = result(request, items=[])
    payload.update(meeting_id=1, user_id=7)
    await redis.xadd(a.RESULTS, {'payload': json.dumps(payload)})
    await tick(redis, store)
    assert await redis.xlen(a.RESULTS) == 0
    assert store._meetings[1]['data']['live_assist']['covered']
    await redis.aclose()


def test_replay_long_meeting_no_lost_segments():
    data, canon = setup()
    for n in range(1, 101):
        if n > 1:
            canon['segments'].append(segment(n, f'Question {n}: should we test scenario {n}?'))
        now = 100 + n * 8
        call(data, canon, 'state', now=now)
        fast = call(data, canon, 'claim', {'role': 'fast'}, now=now)
        if fast:
            # Deterministic fixture extractor emits one grounded question per finalized segment.
            items = [{'type': 'question', 'text': s['text'], 'evidence': [{k: s[k] for k in ('segment_id', 'revision', 'speaker_revision', 'speaker_name', 'start_ms')} | {'quote': s['text']}]} for s in fast['segments']]
            assert call(data, canon, 'result', result(fast, items), now=now)['accepted']
        reason = call(data, canon, 'claim', {'role': 'reason'}, now=now)
        if reason:
            assert call(data, canon, 'result', reason_result(reason), now=now)['accepted']
    call(data, canon, 'state', now=1000, status='completed')
    call(data, canon, 'drain', now=1000, status='completed')
    for now in range(1006, 1100):
        fast = call(data, canon, 'claim', {'role': 'fast'}, now=now, status='completed')
        if fast:
            assert call(data, canon, 'result', result(fast, []), now=now, status='completed')['accepted']
        reason = call(data, canon, 'claim', {'role': 'reason'}, now=now, status='completed')
        if reason:
            assert call(data, canon, 'result', reason_result(reason), now=now, status='completed')['accepted']
        if data['live_assist']['final'] == 'complete':
            break
    assert set(data['live_assist']['covered']) == {s['segment_id'] for s in canon['segments']}
    assert data['live_assist']['final'] == 'complete'


def test_unanimous_vote_rechecks_current_electorate_and_warns():
    data, canon, _ = extracted()
    call(data, canon, 'configure', {'approval': 'unanimous'})
    iid = next(iter(data['live_assist']['items']))
    call(data, canon, 'edit', {'id': iid, 'expected_revision': 1, 'patch': {'text': 'Human version'}})
    job = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(job)
    payload['output']['patches'][0]['text'] = 'Proposed version'
    a.transition(data, canon, 'active', 'result', payload, 7, 7, [7, 8, 9], now=131)
    pid = next(iter(data['live_assist']['proposals']))
    for actor in (9, 7):
        a.transition(data, canon, 'active', 'vote', {'id': pid, 'approve': True}, actor, 7, [7, 8, 9], now=132)
    assert data['live_assist']['proposals']
    a.transition(data, canon, 'active', 'vote', {'id': pid, 'approve': True}, 8, 7, [7, 8], now=133)
    assert not data['live_assist']['proposals']
    assert data['live_assist']['items'][iid]['text'] == 'Proposed version'
    assert a.public_event(data['live_assist']['_events'][-1])['authorization_changed']


@pytest.mark.asyncio
async def test_roster_transport_is_internal_and_fails_closed(monkeypatch):
    import httpx
    from meeting_api.collector import live_assist_roster
    monkeypatch.setenv('INTERNAL_API_SECRET', 'roster-secret')
    original = httpx.AsyncClient
    def response(request):
        assert request.headers['x-internal-secret'] == 'roster-secret'
        assert request.url.params['workspace_id'] == 'team'
        return httpx.Response(200, json={'subjects': [7, 8, 9]})
    monkeypatch.setattr(live_assist_roster.httpx, 'AsyncClient', lambda **kw: original(transport=httpx.MockTransport(response), **kw))
    assert await live_assist_roster.fetch_roster('team') == [7, 8, 9]
    monkeypatch.delenv('INTERNAL_API_SECRET')
    with pytest.raises(RuntimeError):
        await live_assist_roster.fetch_roster('team')


def research_doc(key='d', text='PRIVATE_DOCUMENT_FINDING: retry budget is three attempts.'):
    return {'document_id': key*64, 'sha256': 'a'*64, 'path': 'wiki/retries.md', 'workspace_id': 'team', 'text': text}


def test_document_reconciliation_and_revocation_hide_all_derived_content():
    import json
    data, canon, _ = extracted()
    doc = research_doc()
    call(data, canon, 'ingest-documents', {'documents': [doc]})
    job = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(job)
    # Even an output citing only transcript text must retain the document read-set dependency.
    native_patch = next(p for p in payload['output']['patches'] if p['evidence'][0].get('segment_id'))
    native_patch['text'] = 'PRIVATE_DOCUMENT_FINDING derived task'
    payload['output']['summaries'] = {'current': doc['text'], 'meeting': doc['text']}
    payload['output']['goal'] = {'text': doc['text'], 'evidence': [{'document_id': doc['document_id'], 'sha256': doc['sha256'], 'quote': doc['text']}]}
    assert call(data, canon, 'result', payload)['accepted']
    assert doc['document_id'] in data['live_assist']['items'][native_patch['id']]['document_dependencies']
    data['live_assist']['documents'][doc['document_id']]['active'] = False
    view = call(data, canon, 'state')
    assert view['source_notice'] and 'PRIVATE_DOCUMENT_FINDING' not in json.dumps(view)
    assert 'PRIVATE_DOCUMENT_FINDING' not in a.render_markdown(data['live_assist'])
    assert all('PRIVATE_DOCUMENT_FINDING' not in json.dumps(a.public_event(e, data['live_assist'])) for e in data['live_assist']['_events'])
    assert '1' not in data['live_assist']['covered']  # targeted safe re-extraction, not full transcript loss
    fast = call(data, canon, 'claim', {'role': 'fast'}, now=200)
    assert fast and 'PRIVATE_DOCUMENT_FINDING' not in json.dumps(fast['context'])


def test_document_bound_proposal_expires_without_hiding_independent_human_value():
    import json
    data, canon, _ = extracted()
    iid = next(iter(data['live_assist']['items']))
    call(data, canon, 'edit', {'id': iid, 'expected_revision': 1, 'patch': {'text': 'Independent human value'}})
    doc = research_doc()
    call(data, canon, 'ingest-documents', {'documents': [doc]})
    job = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(job)
    next(p for p in payload['output']['patches'] if p['id'] == iid)['text'] = doc['text']
    call(data, canon, 'result', payload)
    assert data['live_assist']['proposals']
    data['live_assist']['documents'][doc['document_id']]['active'] = False
    view = call(data, canon, 'state')
    assert not view['proposals'] and 'PRIVATE_DOCUMENT_FINDING' not in json.dumps(view)
    assert view['items'][0]['text'] == 'Independent human value'


def test_losing_one_document_reextracts_other_authorized_document_evidence():
    import json
    data, canon = setup()
    first = research_doc('d', 'SAFE_FINDING: backoff is exponential.')
    second = research_doc('e', 'PRIVATE_DOCUMENT_FINDING: project detail.')
    call(data, canon, 'ingest-documents', {'documents': [first, second]})
    job = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(job)
    payload['output']['patches'][0]['text'] = second['text']
    call(data, canon, 'result', payload)
    data['live_assist']['documents'][second['document_id']]['active'] = False
    view = call(data, canon, 'state')
    assert any(i['text'] == first['text'] for i in view['items'])
    assert 'PRIVATE_DOCUMENT_FINDING' not in json.dumps(view)


def test_raw_speech_reaches_summary_even_when_fast_extractor_emits_nothing():
    data, canon = setup()
    fast = call(data, canon, 'claim', {'role': 'fast'})
    assert call(data, canon, 'result', result(fast, []))['accepted']
    reason = call(data, canon, 'claim', {'role': 'reason'})
    assert reason and reason['segments'][0]['text'] == canon['segments'][0]['text']
    payload = reason_result(reason)
    assert payload['output']['patches'] == []
    payload['output']['summaries'] = {'current': 'A speaker offered to investigate retries.', 'meeting': 'Retry investigation was discussed.'}
    assert call(data, canon, 'result', payload)['accepted']
    assert data['live_assist']['reason_covered']['1'] == a.source_key(canon['segments'][0])


def test_planning_edits_do_not_invoke_models_and_empty_end_is_deterministic():
    data, canon = setup(); canon['segments'] = []
    call(data, canon, 'edit', {'id': 'goal', 'expected_revision': 0, 'patch': {'text': 'Plan retries'}})
    call(data, canon, 'add', {'type': 'agenda', 'text': 'Discuss retry policy'})
    assert call(data, canon, 'claim', {'role': 'reason'}) is None
    call(data, canon, 'state', status='completed', now=150)
    call(data, canon, 'drain', status='completed', now=150)
    assert call(data, canon, 'claim', {'role': 'reason'}, status='completed', now=156) is None
    assert data['live_assist']['final'] == 'complete'
    assert not data['live_assist']['jobs']


def test_human_agenda_text_does_not_lock_inferred_progress():
    data, canon, _ = extracted()
    call(data, canon, 'add', {'type': 'agenda', 'text': 'Investigate retry hypothesis'})
    agenda = next(i for i in data['live_assist']['items'].values() if i['type'] == 'agenda')
    reason = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(reason)
    evidence = next(i for i in data['live_assist']['items'].values() if i['type'] == 'task')['evidence']
    payload['output']['patches'].append({'id': agenda['id'], 'status': 'in_progress', 'evidence': evidence})
    assert call(data, canon, 'result', payload)['accepted']
    assert agenda['status'] == 'in_progress' and not data['live_assist']['proposals']
    call(data, canon, 'edit', {'id': agenda['id'], 'expected_revision': agenda['revision'], 'patch': {'status': 'deferred'}})
    assert 'status' in agenda['manual_fields']


def test_nested_manual_detail_lock_preserves_other_inferred_details():
    data, canon, _ = extracted()
    item = next(iter(data['live_assist']['items'].values()))
    call(data, canon, 'edit', {'id': item['id'], 'expected_revision': item['revision'], 'patch': {'details': {'deadline_text': 'Friday'}}})
    reason = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(reason)
    payload['output']['patches'][0]['details'] = {'definition_of_done': 'A documented experiment'}
    assert call(data, canon, 'result', payload)['accepted']
    assert item['details'] == {'agenda_ids': [], 'deadline_text': 'Friday', 'definition_of_done': 'A documented experiment'}
    assert not data['live_assist']['proposals']


def test_summary_revision_replay_repairs_raw_even_without_extraction_candidates():
    data, canon = setup()
    fast = call(data, canon, 'claim', {'role': 'fast'})
    call(data, canon, 'result', result(fast, []))
    reason = call(data, canon, 'claim', {'role': 'reason'})
    call(data, canon, 'result', reason_result(reason))
    canon['segments'][0].update(revision=1, text='We are not investigating retries.')
    assert call(data, canon, 'state', now=140)['summaries']['stale']
    assert call(data, canon, 'claim', {'role': 'reason'}, now=141) is None
    fast = call(data, canon, 'claim', {'role': 'fast'}, now=170)
    call(data, canon, 'result', result(fast, []), now=171)
    reason = call(data, canon, 'claim', {'role': 'reason'}, now=172)
    assert reason['context']['revised_sources'] == ['1']
    payload = reason_result(reason)
    payload['output']['summaries'] = {'current': 'No retry investigation.', 'meeting': 'The transcript correction rules out the task.'}
    assert call(data, canon, 'result', payload, now=173)['accepted']
    assert not data['live_assist']['summaries']['stale']


def test_manual_summary_is_versioned_and_conflicting_reasoning_waits_for_approval():
    data, canon, _ = extracted()
    job = call(data, canon, 'claim', {'role': 'reason'})
    payload = reason_result(job)
    payload['output']['summaries'] = {'current': 'Retry action is under investigation.', 'meeting': 'A retry investigation was assigned.'}
    assert call(data, canon, 'result', payload)['accepted']
    summary_id = a.SUMMARY_IDS['current']
    current = data['live_assist']['items'][summary_id]
    call(data, canon, 'edit', {'id': summary_id, 'expected_revision': current['revision'], 'patch': {'text': 'Human-authored summary'}})
    assert data['live_assist']['summaries']['current'] == 'Human-authored summary'
    canon['segments'].append(segment(2, 'I will also test the timeout path.'))
    call(data, canon, 'state', now=170)
    fast = call(data, canon, 'claim', {'role': 'fast'}, now=200)
    source = canon['segments'][1]
    evidence = {k: source[k] for k in ('segment_id', 'revision', 'speaker_revision', 'speaker_name', 'start_ms')} | {'quote': source['text']}
    fast_output = result(fast, [{'type': 'claim', 'text': source['text'], 'evidence': [evidence]}])
    assert call(data, canon, 'result', fast_output, now=201)['accepted']
    reason = call(data, canon, 'claim', {'role': 'reason'}, now=252)
    payload = reason_result(reason)
    payload['output']['summaries'] = {'current': 'The retry and timeout tests are underway.', 'meeting': 'Both retry and timeout tests are assigned.'}
    assert call(data, canon, 'result', payload, now=173)['accepted']
    assert data['live_assist']['items'][summary_id]['text'] == 'Human-authored summary'
    assert any(p['item_id'] == summary_id for p in data['live_assist']['proposals'].values())
