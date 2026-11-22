import json
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader
from shared.meeting_knowledge import select_sources, sources_for, stale, validate_answer


@pytest.fixture
def setup(tmp_path, monkeypatch):
    base = tmp_path / 'owner'
    base.mkdir()
    (base / 'kg/entities/meeting').mkdir(parents=True)
    doc = base / 'kg/entities/meeting/abc.md'
    doc.write_text('# Demo\n\nNgày ra mắt là 15/11.')
    canonical = {'segments': [{'segment_id': 'seg-1', 'revision': 0, 'text': 'Minh sẽ gửi demo.',
                               'speaker_name': 'Lan', 'speaker_revision': 0, 'start_ms': 12000, 'end_ms': 15000}]}
    calls = []
    def fetch(_base, subject, mid, path):
        if subject != 'owner' or mid != 1:
            raise HTTPException(404, 'Meeting unavailable')
        if path.endswith('/canonical'): return deepcopy(canonical)
        if path.endswith('/memory'):
            seg = canonical['segments'][0] if canonical['segments'] else None
            return {'facts': [{'id': '00000000-0000-0000-0000-000000000001', 'type': 'action_item',
                              'text': seg['text'], 'evidence': [{k: seg[k] for k in ('segment_id', 'revision', 'speaker_name', 'start_ms', 'end_ms')} | {'quote': seg['text']}]}] if seg else []}
        return {'native_meeting_id': 'abc'}
    def complete(_request, raw):
        payload = json.loads(raw)
        calls.append(payload)
        return json.dumps({'claims': [{'text': 'Minh gửi demo.', 'source_ids': [payload['sources'][0]['id']]}]})
    monkeypatch.setattr(api, 'meeting_get', fetch)
    app = FastAPI()
    api.register(app, lambda request: request.headers.get('x-user-id', 'owner'),
                 lambda _request, _slug: base, WorkspaceReader(str(tmp_path)), '', complete)
    return TestClient(app), canonical, base, calls


ROOT = '/api/workspace/meeting-knowledge/1'

def test_meeting_assistant_receives_full_confirmed_context_and_keeps_follow_up_scoped(setup):
    client, canonical, _, calls = setup
    first = canonical['segments'][0]
    canonical['segments'] = [dict(first, segment_id=f'seg-{i}', start_ms=i*1000, end_ms=i*1000+500)
                             for i in range(70)]
    payload = {'question': 'Ai gửi demo?', 'assistant': True}
    assert client.post(ROOT + '/ask', json=payload, headers={'x-user-id': 'stranger'}).status_code == 404
    assert client.post(ROOT + '/ask', json=payload | {'meeting_ids': [2]}).status_code == 422
    result = client.post(ROOT + '/ask', json=payload)
    assert result.status_code == 200, result.text
    answer = result.json()
    assert answer['assistant'] is True
    assert answer['coverage'] == {'selected': 70, 'available': 70, 'bounded': False}
    assert calls[-1]['mode'] == 'meeting_assistant'
    assert calls[-1]['sources'][-1]['segment_id'] == 'seg-69'
    canonical['segments'].append(dict(first, segment_id='fresh', start_ms=71_000, end_ms=72_000))
    result = client.post(ROOT + '/ask', json=payload | {'question': 'Khi nào?', 'reply_to': answer['id']})
    assert result.status_code == 200
    assert calls[-1]['previous_turn']['question'] == 'Ai gửi demo?'
    assert calls[-1]['sources'][-1]['segment_id'] == 'fresh'


def test_notes_preview_uses_only_confirmed_sources_and_does_not_store_an_answer(setup):
    client, canonical, base, calls = setup
    source = canonical['segments'][0]
    canonical['segments'] = [
        dict(source, segment_id=f'seg-{i}', start_ms=i * 1000, end_ms=i * 1000 + 500)
        for i in range(45)
    ]
    payload = {'question': 'Tóm tắt cuộc họp', 'notes_preview': True}
    assert client.post(ROOT + '/ask', json=payload, headers={'x-user-id': 'stranger'}).status_code == 404
    assert client.post(ROOT + '/ask', json=payload | {'documents': ['kg/entities/meeting/abc.md']}).status_code == 422
    assert not calls
    result = client.post(ROOT + '/ask', json=payload)
    assert result.status_code == 200, result.text
    data = result.json()
    assert data['notes_preview'] and data['meeting_id'] == 1
    assert data['coverage'] == {'selected': 40, 'available': 45, 'bounded': True}
    assert calls[-1]['sources'][-1]['segment_id'] == 'seg-44'
    assert data['sources'][0]['segment_id'] == 'seg-0'
    assert not (base / '.meeting-knowledge').exists()
    canonical['segments'].clear()
    assert client.post(ROOT + '/ask', json=payload).status_code == 409


def test_follow_up_ranks_current_transcript_with_verified_parent_context(setup):
    client, canonical, _, calls = setup
    parent = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    canonical['segments'].insert(0, dict(canonical['segments'][0], segment_id='other', text='Chốt ngân sách.'))
    payload = {'question': 'Người đó là ai?', 'reply_to': parent['id']}
    assert client.post(ROOT + '/ask', json=payload, headers={'x-user-id': 'stranger'}).status_code == 404
    assert client.post(ROOT + '/ask', json=payload | {'reply_to': 'a' * 32}).json()['detail']['code'] == 'reply_to_unavailable'
    assert client.post(ROOT + '/ask', json=payload | {'documents': ['kg/entities/meeting/abc.md']}).status_code == 422
    assert client.post(ROOT + '/ask', json=payload | {'catch_up': True}).status_code == 422
    assert len(calls) == 1

    result = client.post(ROOT + '/ask', json=payload)
    assert result.status_code == 200, result.text
    answer = result.json()
    assert answer['question'] == payload['question'] and answer['reply_to'] == parent['id']
    assert calls[-1]['previous_turn'] == {'question': 'Ai gửi demo?', 'claims': ['Minh gửi demo.']}
    assert [source['segment_id'] for source in calls[-1]['sources']] == ['seg-1', 'other']
    assert answer['sources'][0]['segment_id'] == 'seg-1'
    assert client.get(ROOT + f'/answers/{answer["id"]}').json()['reply_to'] == parent['id']

    canonical['segments'][1]['revision'] = 1
    assert client.post(ROOT + '/ask', json=payload).json()['detail']['code'] == 'reply_to_stale'
    assert len(calls) == 2


def test_follow_up_refuses_to_save_if_parent_changes_during_inference(setup, monkeypatch):
    client, canonical, base, _ = setup
    parent = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    validate = api.validate_answer

    def validate_after_edit(raw, sources):
        canonical['segments'][0]['revision'] += 1
        return validate(raw, sources)

    monkeypatch.setattr(api, 'validate_answer', validate_after_edit)
    failed = client.post(ROOT + '/ask', json={'question': 'Người đó là ai?', 'reply_to': parent['id']})
    assert failed.status_code == 409 and failed.json()['detail']['code'] == 'reply_to_stale'
    assert len(list((base / '.meeting-knowledge/1').glob('*.json'))) == 1


@pytest.mark.parametrize('ended', [False, True])
def test_catch_up_uses_only_confirmed_segments_inside_the_requested_minute(setup, monkeypatch, ended):
    client, canonical, _, calls = setup
    start = 1_800_000_000_000
    cutoff = start + 120_000
    original = api.meeting_get

    def fetch(base, subject, mid, path):
        row = original(base, subject, mid, path)
        if path == '/meetings/1':
            row.update(start_time='2027-01-15T08:00:00Z', status='active')
            if ended:
                row.update(end_time='2027-01-15T08:02:00Z', status='completed')
        return row

    monkeypatch.setattr(api, 'meeting_get', fetch)
    monkeypatch.setattr(api, 'time', SimpleNamespace(time=lambda: (cutoff + 300_000 * ended) / 1000))
    canonical['segments'] = [
        dict(canonical['segments'][0], segment_id=sid, text=sid, start_ms=left, end_ms=right)
        for sid, left, right in [
            ('old', 10_000, 20_000),
            ('crosses-start', 59_000, 61_000),
            ('latest', cutoff - 9_000, cutoff - 4_000),
            ('at-start', 60_000, 61_000),
            ('crosses-end', cutoff - 500, cutoff + 500),
        ]
    ]
    body = {'question': 'Bắt kịp 60 giây', 'catch_up': True}
    assert client.post(ROOT + '/ask', json=body | {'meeting_ids': [2]}).status_code == 422
    assert client.post(ROOT + '/ask', json=body, headers={'x-user-id': 'stranger'}).status_code == 404
    result = client.post(ROOT + '/ask', json=body)
    assert result.status_code == 200, result.text
    answer = result.json()
    assert len(calls) == 1
    assert [source['segment_id'] for source in calls[0]['sources']] == ['at-start', 'latest']
    assert answer['sources'][0]['segment_id'] == 'at-start'
    assert answer['catch_up_window'] == {
        'start_ms': cutoff - 60_000, 'end_ms': cutoff, 'confirmed_through_ms': cutoff - 4_000,
        'boundary_omitted': True,
    }
    assert client.get(ROOT).json()['answers'][0]['catch_up_window'] == answer['catch_up_window']
    canonical['segments'][3]['revision'] = 1
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409

    canonical['segments'] = canonical['segments'][:1]
    empty = client.post(ROOT + '/ask', json=body)
    assert empty.status_code == 409
    assert empty.json()['detail']['window']['confirmed_through_ms'] == start + 20_000
    assert len(calls) == 1


def document_client(base):
    from control_plane.workspace_documents import register
    app = FastAPI()
    reader = WorkspaceReader(str(base.parent))
    def target(request, slug):
        if request.headers.get('x-user-id', 'owner') != 'owner' or slug not in (None, 'owner'):
            raise HTTPException(403, 'Not yours')
        return base
    register(app, lambda request: 'owner', target, target, reader)
    return TestClient(app)


def reviewed_move(client, path, destination):
    loaded = client.get('/api/workspace/document', params={'path': path}).json()
    body = {'path': path, 'destination': destination, 'expected_sha256': loaded['sha256']}
    plan = client.post('/api/workspace/document/move/preview', json=body)
    assert plan.status_code == 200, plan.text
    result = client.post('/api/workspace/document/move', json=body | {'update_links': True, 'expected_plan': plan.json()['fingerprint']})
    assert result.status_code == 200, result.text


def test_reviewed_move_keeps_aliased_document_available_to_meeting_questions(setup):
    client, _, base, calls = setup
    folder = base / 'kg/entities/project'; folder.mkdir(parents=True)
    (folder / 'budget.md').write_text('---\ntype: project\nid: budget\ntitle: Budget\n---\n\nBudget was approved.')
    meeting = base / 'kg/entities/meeting/abc.md'
    meeting.write_text('---\ntype: meeting\nid: abc\ntitle: Meeting\n---\n\n[[Budget|Budget plan]]')
    before = client.get(ROOT).json()['documents']
    assert any(doc['path'] == 'kg/entities/project/budget.md' for doc in before)
    reviewed_move(document_client(base), 'kg/entities/project/budget.md', 'notes/new budget.md')
    assert '[[notes/new%20budget.md|Budget plan]]' in meeting.read_text()
    assert any(doc['path'] == 'notes/new budget.md' for doc in client.get(ROOT).json()['documents'])
    response = client.post(ROOT + '/ask', json={'question': 'Budget approved?', 'documents': ['notes/new budget.md']})
    assert response.status_code == 200
    assert any(source.get('path') == 'notes/new budget.md' for source in calls[-1]['sources'])


def test_moved_saved_page_is_found_and_reapply_does_not_duplicate_it(setup):
    client, canonical, base, _ = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    url = ROOT + f'/answers/{answer["id"]}/apply'
    original = client.post(url).json()['path']
    moved = 'notes/reviewed answer.md'
    reviewed_move(document_client(base), original, moved)
    state = client.get(ROOT + f'/answers/{answer["id"]}').json()
    assert state['saved_path'] == moved
    assert client.post(url).json()['path'] == moved
    assert not (base / original).exists()
    (base / moved).write_text((base / moved).read_text() + '\nUser correction\n')
    assert client.post(url).status_code == 409
    assert not (base / original).exists()
    assert (base / moved).read_text().endswith('User correction\n')
    canonical['segments'][0]['revision'] = 1
    assert client.get(ROOT + f'/answers/{answer["id"]}').json()['stale'] is True


def test_source_selection_covers_all_meetings_under_both_limits():
    candidates = []
    for meeting in range(1, 6):
        candidates.extend({'meeting_id': meeting, 'key': f'{meeting}:{i}', 'quote': 'same evidence ' * 300}
                          for i in range(60 if meeting == 1 else 10))
    selected = select_sources(candidates, 'Compare the meetings')
    assert {source['meeting_id'] for source in selected} == {1, 2, 3, 4, 5}
    assert len(selected) <= 40 and sum(len(source['quote']) for source in selected) <= 48000
    counts = [sum(source['meeting_id'] == meeting for source in selected) for meeting in range(1, 6)]
    assert max(counts) - min(counts) <= 1
    for source in candidates:
        source['quote'] = 'short evidence'
    selected = select_sources(candidates, 'Compare the meetings')
    assert len(selected) == 40
    assert all(sum(source['meeting_id'] == meeting for source in selected) == 8 for meeting in range(1, 6))


def test_single_meeting_keeps_relevance_order_and_empty_source_sets():
    candidates = [{'meeting_id': 1, 'quote': text} for text in ['Other discussion', 'Budget approved', 'Budget decision approved']]
    selected = select_sources(candidates, 'Budget decision')
    assert [source['quote'] for source in selected] == ['Budget decision approved', 'Budget approved', 'Other discussion']
    assert select_sources([], 'Anything') == []


def test_aliased_related_paths_cannot_escape_workspace_or_read_hidden_symlinks(setup, tmp_path):
    client, _, base, _ = setup
    (base / '.private').mkdir()
    (base / '.private/secret.md').write_text('Private content')
    (tmp_path / 'outside.md').write_text('Outside content')
    (base / 'notes').mkdir()
    (base / 'notes/hidden.md').symlink_to(base / '.private/secret.md')
    (base / 'notes/outside.md').symlink_to(tmp_path / 'outside.md')
    (base / 'notes/allowed.md').write_text('Allowed content')
    (base / 'kg/entities/meeting/abc.md').write_text('[[../../../notes/allowed.md|OK]] [[notes/hidden.md|Hidden]] [[notes/outside.md|Outside]] [[../../../../outside.md|Escape]] [[https://example.test/secret.md|Remote]]')
    documents = client.get(ROOT).json()['documents']
    assert {doc['path'] for doc in documents} == {'kg/entities/meeting/abc.md', 'notes/allowed.md'}
    assert client.get(ROOT, headers={'x-user-id': 'stranger'}).status_code == 404


def test_saved_page_discovery_handles_crlf_and_refuses_ambiguous_copies(setup):
    client, _, base, _ = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    url = ROOT + f'/answers/{answer["id"]}/apply'
    original = base / client.post(url).json()['path']
    moved = base / 'docs/moved.md'; moved.parent.mkdir()
    (base / 'docs/unrelated.md').write_bytes(b'Not a text document \xff')
    content = original.read_text()
    original.unlink(); moved.write_bytes(content.replace('\n', '\r\n').encode())
    assert client.get(ROOT + f'/answers/{answer["id"]}').json()['saved_path'] == 'docs/moved.md'
    assert client.post(url).json()['path'] == 'docs/moved.md'
    duplicate = base / 'docs/copy.md'; duplicate.write_text(content)
    response = client.post(url)
    assert response.status_code == 409
    assert not original.exists()
    assert duplicate.read_text() == content


def test_apply_refreshes_page_locations_after_acquiring_the_move_lock(setup, monkeypatch):
    from contextlib import contextmanager
    client, _, base, _ = setup
    (base / 'notes').mkdir()
    (base / 'notes/budget.md').write_text('Budget')
    (base / 'kg/entities/meeting/abc.md').write_text('[[notes/budget.md|Budget]]')
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    url = ROOT + f'/answers/{answer["id"]}/apply'
    original = base / client.post(url).json()['path']
    moved = base / 'notes/moved.md'
    actual_lock = api.workspace_write_lock
    @contextmanager
    def move_before_lock(base):
        with actual_lock(base):
            if original.exists():
                original.rename(moved)
            yield
    monkeypatch.setattr(api, 'workspace_write_lock', move_before_lock)
    result = client.post(url)
    assert result.status_code == 200 and result.json()['path'] == 'notes/moved.md'
    assert not original.exists()


def test_multi_meeting_scope_is_authorized_namespaced_and_revalidated(setup, monkeypatch):
    client, _, _, calls = setup
    original = api.meeting_get
    extra = {'segments': [{'segment_id': 'seg-1', 'revision': 0, 'text': 'Second meeting budget',
                          'speaker_name': 'Minh', 'start_ms': 0, 'end_ms': 1000}]}
    def fetch(base, subject, mid, path):
        if mid == 2 and subject == 'owner':
            return deepcopy(extra) if path.endswith('/canonical') else {'native_meeting_id': 'second'}
        return original(base, subject, mid, path)
    monkeypatch.setattr(api, 'meeting_get', fetch)
    answer = client.post(ROOT + '/ask', json={'question': 'Second budget?', 'meeting_ids': [2]}).json()
    assert answer['sources'][0]['meeting_id'] == 2
    assert answer['sources'][0]['key'] == 'meeting:2:segment:seg-1'
    assert answer['meeting_ids'] == [2]
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 200
    extra['segments'][0]['revision'] = 1
    assert client.get(ROOT).json()['answers'][0]['stale'] is True
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409
    count = len(calls)
    assert client.post(ROOT + '/ask', json={'question': 'Private?', 'meeting_ids': [3]}).status_code == 404
    assert len(calls) == count
    monkeypatch.setattr(api, 'meeting_get', original)
    unavailable = client.get(ROOT).json()['answers'][0]
    assert unavailable['stale'] is True and unavailable['sources'] == [] and unavailable['claims'] == []


def test_question_citations_and_explicit_create_only_apply(setup):
    client, _, base, calls = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    assert answer['sources'][0]['quote'] == 'Minh sẽ gửi demo.'
    assert calls[0]['sources'][0]['segment_id'] == 'seg-1'
    assert not (base / 'wiki').exists()
    url = ROOT + f'/answers/{answer["id"]}/apply'
    response = client.post(url)
    assert response.status_code == 200
    page = base / response.json()['path']
    assert 'revision 0' in page.read_text()
    assert 'Fingerprint:' in page.read_text()
    assert client.post(url).status_code == 200
    page.write_text('User edit')
    assert client.post(url).status_code == 409
    assert page.read_text() == 'User edit'


@pytest.mark.parametrize('field,value', [('text', 'Restored original'), ('revision', 1),
                                        ('speaker_name', 'Minh'), ('start_ms', 13000)])
def test_edits_restore_rename_and_timing_invalidate_answer(setup, field, value):
    client, canonical, _, _ = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    canonical['segments'][0][field] = value
    assert client.get(ROOT).json()['answers'][0]['stale'] is True
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409


def test_missing_source_is_stale_but_unrelated_new_segment_is_not(setup):
    client, canonical, _, _ = setup
    client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'})
    canonical['segments'].append(dict(canonical['segments'][0], segment_id='new'))
    assert client.get(ROOT).json()['answers'][0]['stale'] is False
    canonical['segments'] = []
    assert client.get(ROOT).json()['answers'][0]['stale'] is True


def test_owner_check_and_document_allowlist(setup):
    client, _, _, calls = setup
    assert client.get(ROOT, headers={'x-user-id': 'stranger'}).status_code == 404
    assert client.post(ROOT + '/ask', json={'question': 'x', 'documents': ['../../secret']}).status_code == 422
    assert client.post(ROOT + '/ask', json={'question': '  '}).status_code == 422
    assert not calls


def test_document_edits_and_symlink_escape(setup, tmp_path):
    client, _, base, _ = setup
    answer = client.post(ROOT + '/ask', json={'question': 'Ngày ra mắt?', 'documents': ['kg/entities/meeting/abc.md']}).json()
    (base / 'kg/entities/meeting/abc.md').write_text('Ngày khác')
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409
    (base / 'wiki').symlink_to(tmp_path)
    answer = client.post(ROOT + '/ask', json={'question': 'Ai gửi demo?'}).json()
    assert client.post(ROOT + f'/answers/{answer["id"]}/apply').status_code == 409


def test_model_cannot_invent_source_ids_and_retrieval_is_bounded():
    selected = select_sources(sources_for({'segments': [dict(segment_id=str(i), text='demo ' * 600)
                                                     for i in range(100)]}, {}), 'demo')
    assert len(selected) <= 40 and sum(len(s['quote']) for s in selected) <= 48000
    with pytest.raises(ValueError):
        validate_answer('{"claims":[{"text":"invented","source_ids":["fake"]}]}', selected)
    assert validate_answer('{"claims":[]}', selected) == {'claims': [], 'sources': []}


def test_isolated_worker_and_private_dispatch_use_completion_only(monkeypatch):
    from llm.ports import CompletionResult
    from shared import units
    from worker import engine
    source = select_sources(sources_for({'segments': [dict(segment_id='a', text='Minh gửi demo.')]}, {}), 'demo')
    text = json.dumps({'question': 'Ai gửi demo?', 'sources': source})
    payload = json.dumps({'request_id': 'request', 'text': text})
    inv = units.make_dispatch(subject='owner', trigger='message',
                             start=units.entrypoint(inline=units.MEETING_KNOWLEDGE_PREFIX + payload),
                             workspaces=[{'id': 'owner', 'mode': 'ro'}],
                             context={'kind': 'none', 'session': 'meeting-knowledge-request'})
    assert units.is_meeting_knowledge(inv) and units.is_private_transcript_job(inv)
    assert inv['workspaces'] == [{'id': 'owner', 'mode': 'ro'}]
    class Completion:
        def complete(self, prompt, **kwargs):
            assert prompt == text and 'untrusted' in kwargs['system']
            return CompletionResult(text='{"claims":[{"text":"Minh","source_ids":["s0"]}]}')
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_args): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-request')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **kwargs: Completion())
    stream = Stream()
    engine._run_meeting_knowledge(stream, 'private-output', inv['start'])
    assert stream.events[0]['type'] == 'message-delta'
    assert stream.events[-1]['type'] == 'turn-complete'
    monkeypatch.setenv('TINA_CHAT_SESSION', 'different-request')
    stream.events.clear()
    engine._run_meeting_knowledge(stream, 'private-output', inv['start'])
    assert stream.events == [{'type': 'turn-complete'}]


def test_review_is_explicit_revision_safe_and_invalidated_by_evidence(setup):
    client, canonical, base, _ = setup
    item = client.get(ROOT).json()['facts'][0]
    body = {'fact_id': item['fact']['id'], 'expected_fingerprint': item['fingerprint'],
            'expected_revision': 0, 'status': 'approved', 'text': 'Minh gửi demo.'}
    result = client.post(ROOT + '/facts/review', json=body)
    assert result.status_code == 200 and result.json()['revision'] == 1
    assert canonical['segments'][0]['text'] == 'Minh sẽ gửi demo.'
    assert client.post(ROOT + '/facts/review', json=body).status_code == 409
    assert client.post(ROOT + '/facts/review', json=body | {'expected_revision': 1, 'status': 'discarded'}).json()['status'] == 'discarded'
    canonical['segments'][0]['speaker_name'] = 'Changed'
    assert client.get(ROOT).json()['facts'][0]['stale'] is True
    assert client.post(ROOT + '/facts/review', json=body | {'expected_revision': 2}).status_code == 409


def test_live_notes_projection_only_returns_owner_scoped_facts(setup):
    client, canonical, _, calls = setup
    path = ROOT + '?facts_only=true'
    assert client.get(path, headers={'x-user-id': 'stranger'}).status_code == 404
    result = client.get(path)
    assert result.status_code == 200
    assert set(result.json()) == {'facts'}
    item = result.json()['facts'][0]
    body = {'fact_id': item['fact']['id'], 'expected_fingerprint': item['fingerprint'],
            'expected_revision': 0, 'status': 'discarded', 'text': item['fact']['text']}
    assert client.post(ROOT + '/facts/review', json=body).status_code == 200
    assert client.get(path).json()['facts'][0]['review']['status'] == 'discarded'
    assert client.post(ROOT + '/facts/review', json=body | {'expected_revision': 1, 'status': 'pending'}).status_code == 200
    assert client.get(path).json()['facts'][0]['review']['status'] == 'pending'
    assert canonical['segments'][0]['text'] == body['text']
    assert calls == []
