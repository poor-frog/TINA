import hashlib
import hmac
import json
import time
from types import SimpleNamespace

import pytest

from llm.ports import CompletionResult
from shared.units import MEETING_STATE_PREFIX, is_private_transcript_job, make_dispatch, entrypoint
from worker.live_assist import run
from control_plane import live_assist as control


class Stream:
    def __init__(self):
        self.rows = []

    def xadd(self, key, value, **kwargs):
        self.rows.append((key, json.loads(value['payload'])))


def job(text='Should we test retries?'):
    return {'role': 'fast', 'generation': 'abc', 'meeting_id': 1, 'user_id': 7, 'model': 'fast-model',
            'attempts': 1, 'queued_at': time.time(), 'segments': [{'segment_id': 's1', 'revision': 0,
            'speaker_revision': 0, 'speaker_name': 'A', 'start_ms': 0, 'text': text}], 'context': {}, 'policy': {}, 'config': {}}


def test_fast_worker_is_toolless_and_preserves_usage(monkeypatch):
    monkeypatch.setenv('TINA_OWNER', '7')
    stream = Stream()
    class Completion:
        name = 'fake'
        def complete(self, prompt, *, system, model):
            assert model == 'fast-model' and 'Do not call tools' in system
            return CompletionResult(text='{"items":[],"links":[]}', model=model, usage={'input_tokens': 100})
    output = run(stream, MEETING_STATE_PREFIX + json.dumps(job()), completion=Completion())
    assert not output.get('error') and output['output']['items'] == []
    assert any(row.get('input_tokens') == 100 for key, row in stream.rows if key == 'meeting_state_spans')
    assert all('prompt' not in row for key, row in stream.rows if key == 'meeting_state_spans')


def test_oversized_segment_is_atomic_on_second_chunk_failure(monkeypatch):
    monkeypatch.setenv('TINA_OWNER', '7')
    stream = Stream()
    class Completion:
        name = 'fake'
        n = 0
        def complete(self, *args, **kwargs):
            self.n += 1
            if self.n > 1:
                raise RuntimeError('private provider failure body')
            return CompletionResult(text='{"items":[],"links":[]}', model='fast')
    output = run(stream, MEETING_STATE_PREFIX + json.dumps(job('x' * 15000)), completion=Completion())
    assert output.get('error') == 'RuntimeError' and 'output' not in output
    assert len([r for key, r in stream.rows if key == 'meeting_state_results' and not r.get('heartbeat')]) == 1
    assert 'private provider' not in json.dumps(stream.rows)


@pytest.mark.parametrize(('reply', 'fields'), [
    ('{"items":\nprivate response}', {'error_kind': 'invalid_json', 'json_line': 2, 'json_column': 1}),
    ('{"items":[{"type":"private response","text":"private response","evidence":[]}]}',
     {'error_kind': 'schema_invalid', 'schema_keyword': 'enum', 'schema_path': 'properties/items/items/properties/type/enum'}),
    ('["private response"]', {'error_kind': 'non_object'}),
])
def test_invalid_reply_produces_only_scrubbed_diagnostics(monkeypatch, reply, fields):
    monkeypatch.setenv('TINA_OWNER', '7')
    stream = Stream()

    class Completion:
        name = 'fake'

        def complete(self, *args, **kwargs):
            return CompletionResult(text=reply, model='fast-model')

    result = run(stream, MEETING_STATE_PREFIX + json.dumps(job()), completion=Completion())
    assert 'output' not in result
    span = next(row for key, row in stream.rows if key == 'meeting_state_spans' and row['stage'] == 'parse_and_schema')
    assert span['status'] == 'error'
    span['meeting_id'] = 9002
    control.record(span)
    exported = control.traces(9002)['spans'][-1]
    assert {key: exported[key] for key in fields} == fields
    assert 'private response' not in json.dumps([stream.rows, exported])


def test_owner_check_before_completion(monkeypatch):
    monkeypatch.setenv('TINA_OWNER', '8')
    with pytest.raises(ValueError, match='owner mismatch'):
        run(Stream(), MEETING_STATE_PREFIX + json.dumps(job()))


def test_unsigned_dispatch_rejected_before_network():
    dispatcher = SimpleNamespace(settings=SimpleNamespace(internal_api_secret=SimpleNamespace(get_secret_value=lambda: 'secret')))
    with pytest.raises(ValueError, match='Unsigned'):
        control.dispatch_request(dispatcher, job())


def test_signed_dispatch_is_private_and_independent(monkeypatch):
    settings = SimpleNamespace(internal_api_secret=SimpleNamespace(get_secret_value=lambda: 'secret'),
                               state_fast_model='fast', state_reason_model='reason', model_allowlist='fast,reason')
    calls = []
    dispatcher = SimpleNamespace(settings=settings, dispatch=lambda inv, **kwargs: calls.append((inv, kwargs)))
    monkeypatch.setattr(control, 'meeting_post', lambda *args: {'valid': True})
    value = job()
    value.update(epoch=1, fingerprint='a' * 64, lease_until=time.time() + 180)
    value['proof'] = hmac.new(b'secret', json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    control.dispatch_request(dispatcher, value)
    invocation, trusted = calls[0]
    assert trusted == {'trusted_meeting_state': True}
    assert is_private_transcript_job(invocation)
    assert 'tools' not in invocation


def test_ordinary_transcript_job_cannot_select_trusted_worker():
    from control_plane.dispatch import build_unit_env
    from shared.config import Settings
    inv = make_dispatch(subject='7', trigger='transcription', start=entrypoint(inline='not trusted'))
    with pytest.raises(ValueError, match='Invalid meeting-state dispatch'):
        build_unit_env(Settings(), inv, unit_id='test', token='t', trusted_meeting_state=True)


def test_profile_cache_scrubs_unknown_fields_and_reports_best_effort():
    control.record({'meeting_id': 9001, 'stage': 'model', 'duration_ms': 10, 'prompt': 'secret text', 'key': 'secret'})
    view = control.traces(9001)
    assert view['best_effort'] and 'secret' not in json.dumps(view)
    assert view['timings']['model']['p95_ms'] == 10


def test_profile_keeps_only_known_commit_rejection_codes():
    for reason in ('invalid_citation_or_item', 'private response'):
        control.record({'meeting_id': 9003, 'stage': 'validate_and_commit', 'status': 'rejected', 'rejection_reason': reason})
    known, unknown = control.traces(9003)['spans']
    assert known['rejection_reason'] == 'invalid_citation_or_item'
    assert 'rejection_reason' not in unknown


def test_final_wiki_publication_is_shared_create_only_and_idempotent(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from control_plane import workspace_membership as membership
    monkeypatch.setattr('shared.adapters.workspace_write_lock', lambda *args: nullcontext())
    monkeypatch.setattr('llm.ports.commit_workspace_paths', lambda *args, **kwargs: 'sha')
    monkeypatch.setattr(control, 'meeting_post', lambda *args, **kwargs: {'valid': True})
    (tmp_path / '.git').mkdir()
    (tmp_path / 'policy').mkdir()
    (tmp_path / 'policy' / 'members.json').write_text(json.dumps([{'subject': '7', 'role': 'owner'}]), encoding='utf-8')
    monkeypatch.setattr(membership, 'require_role', lambda *args: 'contributor')
    monkeypatch.setattr(membership, '_ws_dir', lambda *args: tmp_path)
    settings = SimpleNamespace(workspaces_dir=str(tmp_path))
    value = {'meeting_id': 1, 'user_id': 7, 'workspace_id': 'team', 'markdown': '# Final state\n',
             'generation': '00000000-0000-0000-0000-000000000001', 'audience_stamp': 'a'*64,
             'publication_revision': 3, 'source_keys': {}}
    assert control.publish_snapshot(settings, value) == 'published'
    assert control.publish_snapshot(settings, value) == 'published'
    target = tmp_path / 'wiki' / 'meetings' / '1' / 'state.md'
    target.write_text('Human Wiki edits', encoding='utf-8')
    assert control.publish_snapshot(settings, value) == 'conflict'
    assert target.read_text(encoding='utf-8') == 'Human Wiki edits'
    assert control.publish_snapshot(settings, dict(value, workspace_id=None)) == 'export_only'


def test_worker_fetches_only_owner_bound_payload_reference(monkeypatch):
    monkeypatch.setenv('TINA_OWNER', '7')
    key = 'meeting_state_job:1:00000000-0000-0000-0000-000000000001'
    class PayloadStream(Stream):
        def get(self, requested):
            assert requested == key
            return json.dumps(job())
        def delete(self, requested):
            assert requested == key
    completion = SimpleNamespace(name='fake', complete=lambda *args, **kwargs: CompletionResult(text='{"items":[]}'))
    value = run(PayloadStream(), MEETING_STATE_PREFIX + json.dumps({'user_id': 7, 'meeting_id': 1, 'job_key': key}), completion=completion)
    assert value.get('output') == {'items': [], 'links': [], 'explicit_transition': False}


def test_worker_aborts_before_call_when_cancellation_signal_is_revoked(monkeypatch):
    monkeypatch.setenv('TINA_OWNER', '7')
    job_value = job(); job_value['execution_key'] = 'meeting_state_lease:1:fast:00000000-0000-0000-0000-000000000001'
    job_key = 'meeting_state_job:1:00000000-0000-0000-0000-000000000001'
    class PayloadStream(Stream):
        def get(self, requested):
            return json.dumps(job_value) if requested == job_key else None
        def delete(self, _requested):
            pass
    called = []
    completion = SimpleNamespace(name='fake', complete=lambda *args, **kwargs: called.append(True))
    value = run(PayloadStream(), MEETING_STATE_PREFIX + json.dumps({'user_id': 7, 'meeting_id': 1, 'job_key': job_key}), completion=completion)
    assert value.get('error') == 'InterruptedError' and not called


def test_internal_roster_requires_secret_and_rejects_corrupt_authority(tmp_path):
    from fastapi.testclient import TestClient
    from control_plane.api import create_app
    from control_plane.dispatch import Dispatcher
    from shared.config import load_settings
    from .test_api import _FakeIdentity, _FakeRuntime
    folder = tmp_path / 'team' / 'policy'
    folder.mkdir(parents=True)
    path = folder / 'members.json'
    path.write_text(json.dumps([{'subject': '7', 'role': 'owner'}, {'subject': '8', 'role': 'contributor'}]), encoding='utf-8')
    settings = load_settings(internal_api_secret='test-roster-secret', workspaces_dir=str(tmp_path))
    client = TestClient(create_app(Dispatcher(settings, _FakeRuntime(), _FakeIdentity())))
    route = '/api/internal/meeting-state-roster?workspace_id=team'
    assert client.get(route).status_code == 403
    headers = {'X-Internal-Secret': 'test-roster-secret'}
    assert client.get(route, headers=headers).json() == {'subjects': [7, 8]}
    path.write_text('not JSON', encoding='utf-8')
    assert client.get(route, headers=headers).status_code == 503


def test_document_research_is_shared_bounded_and_revalidates_hashes(tmp_path):
    from control_plane.live_assist_documents import retrieve, validate_sources, document_file
    policy = tmp_path / 'team' / 'policy'
    wiki = tmp_path / 'team' / 'wiki'
    private = tmp_path / 'private' / 'wiki'
    policy.mkdir(parents=True); wiki.mkdir(); private.mkdir(parents=True)
    (policy / 'members.json').write_text(json.dumps([{'subject': '7', 'role': 'owner'}, {'subject': '8', 'role': 'contributor'}]), encoding='utf-8')
    (private / 'secret.md').write_text('retry budget PRIVATE_WORKSPACE_TEXT', encoding='utf-8')
    for i in range(8):
        (wiki / f'retry-{i}.md').write_text(f'Retry budget for service {i}: use exponential backoff.', encoding='utf-8')
    settings = SimpleNamespace(workspaces_dir=str(tmp_path))
    docs = retrieve(settings, 'team', 'retry budget', [7, 8])
    assert len(docs) == 5
    assert 'PRIVATE_WORKSPACE_TEXT' not in json.dumps(docs)
    body = {'workspace_id': 'team', 'viewers': [7, 8], 'documents': [{k: d[k] for k in ('document_id', 'path', 'sha256', 'workspace_id')} for d in docs]}
    assert len(validate_sources(settings, body)['valid_ids']) == 5
    (tmp_path / 'team' / docs[0]['path']).write_text('Changed document', encoding='utf-8')
    assert docs[0]['document_id'] not in validate_sources(settings, body)['valid_ids']
    assert validate_sources(settings, dict(body, viewers=[7, 8, 9]))['valid_ids'] == []
    with pytest.raises(PermissionError):
        retrieve(settings, 'team', 'retry', [7, 9])
    with pytest.raises(ValueError):
        document_file(settings, 'team', '../private/wiki/secret.md')
    with pytest.raises(ValueError):
        document_file(settings, 'team', '.git/config.md')


def test_operator_profile_and_retry_routes_are_internal(monkeypatch):
    from fastapi.testclient import TestClient
    from control_plane.api import create_app
    from control_plane.dispatch import Dispatcher
    from shared.config import load_settings
    from .test_api import _FakeIdentity, _FakeRuntime
    called = []
    monkeypatch.setattr(control, 'meeting_post', lambda settings, job, action, payload: called.append((job, action)) or {'retried': True})
    settings = load_settings(internal_api_secret='ops-secret')
    client = TestClient(create_app(Dispatcher(settings, _FakeRuntime(), _FakeIdentity())))
    path = '/api/admin/meeting-state/42'
    assert client.get(path).status_code == 403
    headers = {'X-Internal-Secret': 'ops-secret'}
    assert client.get(path, headers=headers).json()['best_effort'] is True
    assert client.post(path, headers=headers).json() == {'retried': True}
    assert called == [({'user_id': 0, 'meeting_id': 42}, 'retry')]


def test_reason_worker_accepts_document_citations_without_fabricated_speakers(monkeypatch):
    monkeypatch.setenv('TINA_OWNER', '7')
    source = {'document_id': 'd'*64, 'sha256': 'a'*64, 'workspace_id': 'team', 'path': 'wiki/retries.md', 'text': 'Retry budget is three attempts.'}
    value = job(); value.update(role='reason', segments=[source])
    class Completion:
        name = 'fake'
        def complete(self, prompt, **kwargs):
            assert 'wiki/retries.md' in prompt
            return CompletionResult(text=json.dumps({'patches': [{'id': 'item1', 'text': source['text'],
                'evidence': [{k: source[k] for k in ('document_id', 'sha256')} | {'quote': source['text']}]}],
                'summaries': {'current': source['text'], 'meeting': source['text']}}))
    output = run(Stream(), MEETING_STATE_PREFIX + json.dumps(value), completion=Completion())
    assert not output.get('error')
    assert 'speaker_name' not in output['output']['patches'][0]['evidence'][0]
