from copy import deepcopy
from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from jsonschema import validate
import json

from control_plane import meeting_translation as api


@pytest.fixture
def setup(tmp_path, monkeypatch):
    canonical = {'segments': [{'segment_id': 's1', 'text': 'Xin chào.', 'revision': 0, 'speaker_id': 'original'},
                              {'segment_id': 'draft', 'text': 'Đang nói', 'completed': False}]}
    calls = []
    def fetch(base, owner, meeting, path):
        if owner != 'owner' or meeting != 6:
            raise HTTPException(404, 'Meeting unavailable')
        return deepcopy(canonical) if path.endswith('/canonical') else {'status': canonical.get('status', 'completed')}
    def complete(request, text):
        calls.append(text)
        return 'Hello.'
    monkeypatch.setattr(api, 'meeting_get', fetch)
    app = FastAPI()
    api.register(app, lambda request: request.headers.get('x-user-id', 'owner'), tmp_path, '', complete)
    return TestClient(app), canonical, calls, tmp_path


URL = '/api/meeting-translations/6'


def test_read_does_not_infer_and_completed_cache_is_shared_and_durable(setup):
    client, _, calls, root = setup
    state = client.get(URL).json()
    assert state['status'] == 'pending' and state['total'] == 1 and not calls
    state = client.post(URL, json={}).json()
    assert state['status'] == 'complete' and state['groups'][0]['translated_text'] == 'Hello.'
    assert client.post(URL, json={}).json() == state
    assert calls == ['Xin chào.']
    store = api.TranslationStore(root / '.meeting-translations/translations.sqlite3')
    assert store.snapshot('owner', 6, [{'segment_id': 's1', 'text': 'Xin chào.', 'speaker_id': 'original'}]) == state
    schema = Path(__file__).parents[1] / 'contracts/meeting-translation.v2/translation.schema.json'
    validate(state, json.loads(schema.read_text()))


def test_cached_translation_still_rechecks_access(setup):
    client, _, calls, _ = setup
    client.post(URL, json={})
    for method in ('get', 'post'):
        response = getattr(client, method)(URL, headers={'x-user-id': 'another'}, **({'json': {}} if method == 'post' else {}))
        assert response.status_code == 404
        assert 'Hello.' not in response.text
    assert len(calls) == 1


def test_edit_invalidates_only_changed_segment_and_new_live_segment_is_translated(setup):
    client, canonical, calls, _ = setup
    client.post(URL, json={})
    canonical['segments'][0]['text'] = 'Chào bạn.'
    assert client.get(URL).json()['groups'][0]['translated_text'] is None
    client.post(URL, json={})
    canonical['segments'].append({'segment_id': 's2', 'text': 'Tạm biệt.'})
    state = client.post(URL, json={}).json()
    assert state['completed'] == 2
    assert calls == ['Xin chào.', 'Chào bạn.', 'Tạm biệt.']


def test_refinement_apply_and_restore_invalidate_translation_without_reusing_stale_text(setup):
    client, canonical, calls, _ = setup
    client.post(URL, json={})
    canonical['segments'].append({'segment_id':'unchanged', 'text':'Tạm biệt.', 'revision':0})
    client.post(URL, json={})
    before = deepcopy(canonical['segments'][0])
    # The canonical endpoint reflects only explicit Apply, not a ready ASR proposal.
    canonical['segments'][0].update(text='Xin chào mọi người.', revision=1)
    state = client.get(URL).json()
    assert state['groups'][0]['translated_text'] is None
    assert state['groups'][1]['translated_text'] == 'Hello.'
    client.post(URL, json={})
    canonical['segments'][0].update(text=before['text'], revision=2)  # Restore original.
    assert client.get(URL).json()['groups'][0]['translated_text'] is None
    state = client.post(URL, json={}).json()
    assert state['completed'] == 2
    assert calls == ['Xin chào.', 'Tạm biệt.', 'Xin chào mọi người.', 'Xin chào.']


def test_provider_error_keeps_source_and_backs_off_then_manual_retry(setup, monkeypatch):
    client, _, calls, _ = setup
    monkeypatch.setattr(api, 'time', type('Clock', (), {'time': staticmethod(lambda: 1000)})())
    # Re-register against the same store with a provider which recovers.
    def complete(request, text):
        calls.append(text)
        if len(calls) <= 3:
            raise RuntimeError('secret-provider-key and transcript must never leak')
        return 'Recovered'
    app = FastAPI()
    api.register(app, lambda request: 'owner', setup[3], '', complete)
    client = TestClient(app)
    state = client.post(URL, json={}).json()
    assert state['status'] == 'paused' and state['retry_after'] >= 15
    assert state['groups'][0]['source_text'] == 'Xin chào.'
    assert 'secret' not in json.dumps(state)
    client.post(URL, json={})
    assert len(calls) == 1
    client.post(URL, json={'retry': True})
    state = client.post(URL, json={'retry': True}).json()
    assert state['retry_after'] >= 300
    assert client.post(URL, json={'retry': True}).json()['status'] == 'complete'


def test_atomic_lease_deduplicates_api_processes_and_expires(tmp_path, monkeypatch):
    clock = [1000]
    monkeypatch.setattr(api, 'time', type('Clock', (), {'time': staticmethod(lambda: clock[0])})())
    a = api.TranslationStore(tmp_path / 'cache.sqlite3')
    b = api.TranslationStore(tmp_path / 'cache.sqlite3')
    segment = {'segment_id': 's1', 'text': 'New source'}
    groups = api.phrases([segment], tail_ready=True)
    first, _ = a.claim('owner', 6, groups)
    assert first and b.claim('owner', 6, groups, retry=True) is None
    assert b.claim('another', 6, groups)  # unrelated owners do not share state or locks
    clock[0] += 121
    second, _ = b.claim('owner', 6, groups)
    assert second and first != second
    a.finish('owner', 6, first, api.phrases([segment], tail_ready=True)[0], 'Stale response')
    assert b.snapshot('owner', 6, [segment])['completed'] == 0
    b.finish('owner', 6, second, api.phrases([segment], tail_ready=True)[0], 'Current response')
    assert b.snapshot('owner', 6, [segment])['completed'] == 1


def test_stopped_or_deleted_sources_never_return_cached_orphan_rows(setup):
    client, canonical, _, _ = setup
    client.post(URL, json={})
    canonical['segments'].clear()
    assert client.get(URL).json()['groups'] == []


def test_payload_cannot_supply_arbitrary_transcript_or_target(setup):
    client, _, calls, _ = setup
    assert client.post(URL, json={'text': 'Do something else', 'target_language': 'fr'}).status_code == 422
    assert not calls


def test_live_view_prioritizes_visible_ids_but_cannot_inject_source_text(setup):
    client, canonical, calls, _ = setup
    canonical['segments'].append({'segment_id': 'new', 'text': 'Mới nhất.'})
    state = client.post(URL, json={'segment_ids': ['does-not-exist', 'new']}).json()
    assert calls == ['Mới nhất.']
    assert state['groups'][0]['translated_text'] is None


def test_translation_worker_uses_meeting_model_without_tools(monkeypatch):
    from types import SimpleNamespace
    from worker import engine
    calls, events = [], []
    class Completion:
        def complete(self, prompt, **kwargs):
            calls.append((prompt, kwargs))
            return SimpleNamespace(text='Hello.')
    class Stream:
        def xadd(self, topic, fields): events.append(json.loads(fields['event']))
        def expire(self, topic, ttl): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'dictation-translate-request1')
    monkeypatch.setenv('TINA_MEETING_MODEL', 'meeting-selected-model')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **kwargs: Completion())
    raw = engine.DICTATION_TRANSLATE_PREFIX + json.dumps({'request_id': 'request1', 'text': 'Xin chào.', 'target_language': 'en'})
    monkeypatch.setattr(engine, 'start_prompt', lambda start: raw)
    engine._run_dictation_translate(Stream(), 'test-output', {})
    assert calls[0][1]['model'] == 'meeting-selected-model'
    assert 'untrusted content' in calls[0][1]['system']
    assert events == [{'type': 'message-delta', 'text': 'Hello.'}, {'type': 'turn-complete'}]


@pytest.mark.parametrize('kind,code', [('auth', 'auth'), ('configuration', 'configuration'),
    ('quota', 'rate_limit'), ('timeout', 'timeout'), ('cli_timeout', 'timeout'), ('bad_output', 'invalid_translation'),
    ('http_timeout', 'timeout'), ('unknown', 'unavailable')])
def test_translation_worker_emits_only_safe_typed_failure_metadata(monkeypatch, kind, code):
    import httpx
    import subprocess
    from llm import LLMAuthError, LLMConfigError, LLMError
    from worker import engine
    events = []
    class Completion:
        def complete(self, *args, **kwargs):
            secret = 'private provider key and transcript'
            if kind in ('timeout', 'cli_timeout'):
                try:
                    raise httpx.ReadTimeout(secret) if kind == 'timeout' else subprocess.TimeoutExpired('test-cli', 30)
                except (httpx.TimeoutException, subprocess.TimeoutExpired) as exc:
                    raise LLMError(secret) from exc
            raise {'auth': LLMAuthError(secret), 'configuration': LLMConfigError(secret),
                   'quota': LLMError(secret, status_code=429), 'bad_output': ValueError(secret),
                   'http_timeout': LLMError(secret, status_code=504), 'unknown': RuntimeError(secret)}[kind]
    class Stream:
        def xadd(self, topic, fields): events.append(json.loads(fields['event']))
        def expire(self, topic, ttl): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'dictation-translate-request1')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **kwargs: Completion())
    raw = engine.DICTATION_TRANSLATE_PREFIX + json.dumps({'request_id': 'request1', 'text': 'Xin chào.', 'target_language': 'en'})
    monkeypatch.setattr(engine, 'start_prompt', lambda start: raw)
    engine._run_dictation_translate(Stream(), 'test-output', {})
    assert events == [{'type': 'turn-complete', 'translation_error': code}]
    schema = json.loads((Path(__file__).parents[1] / 'contracts/meeting-translation.v2/translation.schema.json').read_text())
    validate(events[0], {'$ref': '#/$defs/worker_completion', '$defs': schema['$defs']})


def test_inline_reasoning_is_never_displayed_or_accepted_as_a_translation(tmp_path):
    from shared.translation_text import visible_translation
    assert visible_translation('<think>Private reasoning</think>\nHello.') == 'Hello.'
    with pytest.raises(ValueError):
        visible_translation('<think>Incomplete reasoning')
    store = api.TranslationStore(tmp_path / 'cache.sqlite3')
    segment = {'segment_id': 's1', 'text': 'Xin chào.'}
    # Older provider results already in the cache are filtered on reads too.
    group = api.phrases([segment], tail_ready=True)[0]
    token, _ = store.claim('owner', 6, [group])
    store.finish('owner', 6, token, group, '<think>Private reasoning</think>\nHello.')
    assert store.snapshot('owner', 6, [segment])['groups'][0]['translated_text'] == 'Hello.'


def test_live_tail_waits_for_observed_quiet_and_resets_when_new_words_arrive(setup, monkeypatch):
    client, canonical, calls, _ = setup
    clock = [1000]
    monkeypatch.setattr(api, 'time', type('Clock', (), {'time': staticmethod(lambda: clock[0])})())
    canonical['status'] = 'active'
    assert not client.post(URL, json={}).json()['groups'][0]['ready']
    assert not calls
    clock[0] += 4
    canonical['segments'].append({'segment_id': 's2', 'text': 'mọi người', 'speaker_id': 'original'})
    client.get(URL)
    clock[0] += 4
    client.post(URL, json={})
    assert not calls
    clock[0] += 1
    state = client.post(URL, json={}).json()
    assert state['status'] == 'complete' and calls == ['Xin chào. mọi người']


def test_stop_flushes_a_short_live_tail_without_waiting(setup):
    client, canonical, calls, _ = setup
    canonical['status'] = 'active'
    client.post(URL, json={})
    assert not calls
    canonical['status'] = 'completed'
    assert client.post(URL, json={}).json()['status'] == 'complete'
    assert calls == ['Xin chào.']


def test_one_api_call_translates_a_whole_phrase_and_an_edit_retranslates_only_that_phrase(setup):
    client, canonical, calls, _ = setup
    canonical['segments'] = [
        {'segment_id': 'a', 'text': 'Mục tiêu', 'speaker_id': 'p1', 'start_ms': 0, 'end_ms': 500},
        {'segment_id': 'b', 'text': 'là tối ưu mô hình.', 'speaker_id': 'p1', 'start_ms': 600, 'end_ms': 1600},
        {'segment_id': 'c', 'text': 'Tôi đồng ý.', 'speaker_id': 'p2', 'start_ms': 1700, 'end_ms': 2200},
    ]
    client.post(URL, json={})
    state = client.post(URL, json={}).json()
    assert state['total'] == 2 and calls == ['Mục tiêu là tối ưu mô hình.', 'Tôi đồng ý.']
    canonical['segments'][1]['text'] = 'là đánh giá mô hình.'
    state = client.get(URL).json()
    assert state['groups'][0]['translated_text'] is None and state['groups'][1]['translated_text'] == 'Hello.'
    client.post(URL, json={})
    assert calls[-1] == 'Mục tiêu là đánh giá mô hình.' and len(calls) == 3


def test_legacy_fragment_cache_is_not_reused_for_grouped_translation(setup):
    client, _, calls, root = setup
    store = api.TranslationStore(root / '.meeting-translations/translations.sqlite3')
    with store.connect() as db:
        db.execute('CREATE TABLE translations(owner, meeting, segment, source_hash, translated)')
        db.execute('INSERT INTO translations VALUES (?,?,?,?,?)', ('owner', 6, 's1', 'old-hash', 'Fragment result'))
    assert client.get(URL).json()['groups'][0]['translated_text'] is None
    assert client.post(URL, json={}).json()['groups'][0]['translated_text'] == 'Hello.'
    assert len(calls) == 1


def use_provider(setup, complete, subject=lambda request: 'owner'):
    app = FastAPI()
    api.register(app, subject, setup[3], '', complete)
    return TestClient(app)


def two_phrases(canonical):
    canonical['segments'] = [
        {'segment_id': 'bad', 'text': 'Cụm bị lỗi.', 'revision': 0, 'speaker_id': 'a'},
        {'segment_id': 'good', 'text': 'Câu mới tiếp tục.', 'revision': 0, 'speaker_id': 'b'},
    ]


def test_phrase_failure_does_not_block_new_phrases_and_retries_only_the_missing_one(setup, monkeypatch):
    _, canonical, calls, _ = setup
    two_phrases(canonical)
    clock = [1000]
    monkeypatch.setattr(api.time, 'time', lambda: clock[0])
    recovered = False
    def complete(request, text):
        calls.append(text)
        if text == 'Cụm bị lỗi.' and not recovered:
            raise HTTPException(504, 'private provider error')
        return 'Translated ' + text
    client = use_provider(setup, complete)
    state = client.post(URL, json={}).json()
    assert state['status'] == 'pending' and state['can_advance'] is True
    assert state['retry_after'] == 0 and 'service_error' not in state
    assert state['groups'][0]['status'] == 'retrying'
    assert state['groups'][0]['error_code'] == 'timeout'
    assert 'private' not in json.dumps(state)
    state = client.post(URL, json={}).json()
    assert state['groups'][1]['translated_text'] == 'Translated Câu mới tiếp tục.'
    client.post(URL, json={})
    assert calls == ['Cụm bị lỗi.', 'Câu mới tiếp tục.']
    recovered = True
    clock[0] += 16
    state = client.post(URL, json={}).json()
    assert state['status'] == 'complete'
    assert calls == ['Cụm bị lỗi.', 'Câu mới tiếp tục.', 'Cụm bị lỗi.']
    assert state['groups'][0]['attempts'] == 2


def test_invalid_phrase_reaches_a_bounded_manual_retry_state(setup, monkeypatch):
    _, canonical, calls, _ = setup
    two_phrases(canonical)
    clock = [1000]
    monkeypatch.setattr(api.time, 'time', lambda: clock[0])
    recovered = False
    def complete(request, text):
        calls.append(text)
        return '' if text == 'Cụm bị lỗi.' and not recovered else 'Good translation'
    client = use_provider(setup, complete)
    for delay in (0, 16, 61):
        clock[0] += delay
        client.post(URL, json={'segment_ids': ['bad']})
    state = client.get(URL).json()
    assert state['groups'][0]['status'] == 'failed'
    assert state['groups'][0]['error_code'] == 'invalid_translation'
    assert state['can_advance'] is True  # New phrase can still proceed.
    state = client.post(URL, json={}).json()
    assert state['completed'] == 1 and state['can_advance'] is False
    clock[0] += 1000
    client.post(URL, json={})
    assert len(calls) == 4
    recovered = True
    state = client.post(URL, json={'retry': True}).json()
    assert state['status'] == 'complete' and state['groups'][0]['attempts'] == 4
    assert len(calls) == 5


@pytest.mark.parametrize('status,code', [(401, 'auth'), (403, 'auth'), (404, 'configuration'),
                                       (429, 'rate_limit'), (503, 'unavailable')])
def test_service_failure_pauses_other_phrases_and_same_owner_meetings(setup, monkeypatch, status, code):
    _, canonical, calls, root = setup
    two_phrases(canonical)
    monkeypatch.setattr(api.time, 'time', lambda: 1000)
    recovered = False
    def complete(request, text):
        calls.append(text)
        if not recovered:
            raise HTTPException(status, 'secret credential and transcript')
        return 'Recovered'
    client = use_provider(setup, complete)
    state = client.post(URL, json={}).json()
    assert state['service_error'] == code and state['status'] == 'paused'
    assert state['retry_after'] >= 15 and state['can_advance'] is False
    assert 'secret' not in json.dumps(state)
    client.post(URL, json={'segment_ids': ['good']})
    assert len(calls) == 1
    store = api.TranslationStore(root / '.meeting-translations/translations.sqlite3')
    groups = api.phrases(canonical['segments'], tail_ready=True)
    assert store.claim('owner', 7, groups) is None
    assert store.claim('another-owner', 7, groups) is not None
    recovered = True
    state = client.post(URL, json={'retry': True}).json()
    assert 'service_error' not in state
    assert state['groups'][0]['status'] == 'complete'


def test_later_service_failure_survives_an_older_success_in_another_meeting(tmp_path):
    store = api.TranslationStore(tmp_path / 'translation.sqlite3')
    group = api.phrases([{'segment_id': 'a', 'text': 'Hello.'}], tail_ready=True)[0]
    first, _ = store.claim('owner', 6, [group])
    second, _ = store.claim('owner', 7, [group])
    store.finish('owner', 7, second, group, None, 'rate_limit')
    store.finish('owner', 6, first, group, 'Translated')
    assert store.snapshot('owner', 7, [{'segment_id': 'a', 'text': 'Hello.'}])['service_error'] == 'rate_limit'


def test_claim_rechecks_cache_after_a_stale_snapshot(tmp_path):
    a = api.TranslationStore(tmp_path / 'translation.sqlite3')
    b = api.TranslationStore(tmp_path / 'translation.sqlite3')
    groups = api.phrases([{'segment_id': 'a', 'text': 'Hello.'}], tail_ready=True)
    token, _ = a.claim('owner', 6, groups)
    a.finish('owner', 6, token, groups[0], 'Done')
    assert b.claim('owner', 6, groups, retry=True) is None


def test_concurrent_web_and_extension_requests_share_one_inflight_completion(setup):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    entered, release = Event(), Event()
    calls = []
    def complete(request, text):
        calls.append(text)
        entered.set()
        assert release.wait(5)
        return 'Shared result'
    web = use_provider(setup, complete)
    extension = use_provider(setup, complete)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(web.post, URL, json={})
        try:
            assert entered.wait(5)
            second = extension.post(URL, json={'retry': True}).json()
            assert second['status'] == 'running' and second['can_advance'] is False
            assert second['groups'][0]['attempts'] == 1
            assert second['groups'][0]['status'] == 'running'
        finally:
            release.set()
        assert first.result().json()['groups'][0]['translated_text'] == 'Shared result'
    assert extension.post(URL, json={}).json()['completed'] == 1
    assert calls == ['Xin chào.']


@pytest.mark.parametrize('change', ['text', 'revision', 'delete', 'regroup'])
def test_inflight_results_are_discarded_when_the_canonical_source_changes(setup, change):
    _, canonical, _, root = setup
    def complete(request, text):
        if change == 'text':
            canonical['segments'][0]['text'] = 'Đã sửa.'
        elif change == 'revision':
            canonical['segments'][0]['revision'] = 1  # Same words, new accepted revision.
        elif change == 'delete':
            canonical['segments'].clear()
        else:
            canonical['segments'].append({'segment_id': 'tail', 'text': 'mọi người', 'speaker_id': 'original'})
        return 'Old response must never be published'
    state = use_provider(setup, complete).post(URL, json={}).json()
    assert all(g['translated_text'] is None for g in state['groups'])
    store = api.TranslationStore(root / '.meeting-translations/translations.sqlite3')
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM phrase_translations').fetchone()[0] == 0
        assert db.execute('SELECT lease FROM translation_jobs').fetchone()[0] == 0


def test_inflight_response_rechecks_owner_access_before_saving(setup, monkeypatch):
    original = api.meeting_get
    denied = False
    def fetch(*args):
        if denied:
            raise HTTPException(404, 'Meeting unavailable')
        return original(*args)
    monkeypatch.setattr(api, 'meeting_get', fetch)
    def complete(request, text):
        nonlocal denied
        denied = True
        return 'Private result'
    response = use_provider(setup, complete).post(URL, json={})
    assert response.status_code == 404 and 'Private result' not in response.text
    store = api.TranslationStore(setup[3] / '.meeting-translations/translations.sqlite3')
    with store.connect() as db:
        assert db.execute('SELECT COUNT(*) FROM phrase_translations').fetchone()[0] == 0
        assert db.execute('SELECT lease FROM translation_jobs').fetchone()[0] == 0


def test_legacy_sqlite_migration_keeps_cache_cooldown_and_live_lease(tmp_path, monkeypatch):
    import sqlite3
    clock = [1000]
    monkeypatch.setattr(api.time, 'time', lambda: clock[0])
    path = tmp_path / 'old.sqlite3'
    group = api.phrases([{'segment_id':'a','text':'Hello.'}], tail_ready=True)[0]
    legacy = {**group, 'members': [{'segment_id':'a','source_text':'Hello.'}]}
    with sqlite3.connect(path) as db:
        db.executescript('CREATE TABLE translation_jobs(owner,meeting,token,lease,failures,retry_at,PRIMARY KEY(owner,meeting)); CREATE TABLE phrase_translations(owner,meeting,phrase,source_hash,translated,PRIMARY KEY(owner,meeting,phrase));')
        db.execute('INSERT INTO translation_jobs VALUES (?,?,?,?,?,?)', ('owner',6,'legacy-active',1100,2,1200))
        db.execute('INSERT INTO phrase_translations VALUES (?,?,?,?,?)', ('owner',9,group['group_id'],api.source_fingerprint(legacy),'Cached before upgrade'))
    store = api.TranslationStore(path)
    assert store.claim('owner',6,[group],retry=True) is None
    assert store.snapshot('owner',9,[{'segment_id':'a','text':'Hello.'}])['completed'] == 1
    assert store.snapshot('owner',9,[{'segment_id':'a','text':'Hello.','revision':1}])['completed'] == 0
    clock[0] = 1101
    assert store.claim('owner',6,[group]) is None
    assert store.claim('owner',6,[group],retry=True) is not None


def test_phrase_backoff_is_revision_bound_and_resumes_after_process_recreation(setup, monkeypatch):
    _, canonical, _, root = setup
    monkeypatch.setattr(api.time, 'time', lambda: 1000)
    def bad(request, text):
        raise ValueError('invalid output')
    use_provider(setup,bad).post(URL,json={})
    reopened = use_provider(setup, lambda request,text: 'New result')
    assert reopened.get(URL).json()['groups'][0]['status'] == 'retrying'
    assert reopened.post(URL,json={}).json()['completed'] == 0
    canonical['segments'][0]['revision'] = 1
    state = reopened.post(URL,json={}).json()
    assert state['status'] == 'complete' and state['groups'][0]['attempts'] == 1
