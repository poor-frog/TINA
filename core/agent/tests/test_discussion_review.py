import json
from copy import deepcopy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from jsonschema import ValidationError

from control_plane import discussion_review as api
from control_plane.workspace_reader import WorkspaceReader
from shared.discussion_review import classification_schema, prepare, validate_classification, validate_report

ROOT = '/api/discussion-reviews/1'


def canonical():
    return {'revision': 1, 'segments': [
        {'segment_id': f'segment/{i}', 'revision': 0, 'speaker_name': speaker,
         'start_ms': start, 'end_ms': start + 2000, 'text': text, 'audio': []}
        for i, (speaker, start, text) in enumerate([
            ('Lan', 0, 'Em không đồng ý retry vì có thể double charge.'),
            ('Minh', 5000, 'Mình thử thêm idempotency key nhé.'),
            ('Lan', 70000, 'Chốt benchmark rồi review kết quả.'),
        ])]}


def prediction(prepared):
    return {'windows': [dict(id=window['id'],
        relevance={'label': 'relevant', 'reason': 'Đúng mục tiêu payment service.', 'source_ids': window['source_ids'][:1]},
        interaction={'labels': [], 'reason': 'Không có tín hiệu trong danh mục.', 'source_ids': window['source_ids'][:1]},
        progress={'label': 'advancing', 'reason': 'Làm rõ bước tiếp theo.', 'source_ids': window['source_ids'][:1]})
        for window in prepared['windows']]}


def alias_prediction(prepared):
    result = prediction(prepared)
    history = []
    for window, decision in zip(prepared['windows'], result['windows']):
        current_aliases = {sid: f't{index}' for index, sid in enumerate(window['source_ids'])}
        earlier_aliases = {sid: f'h{index}' for index, sid in enumerate(history)}
        aliases = {**earlier_aliases, **current_aliases}
        for task in ('relevance', 'interaction', 'progress'):
            decision[task]['source_ids'] = [aliases[sid] for sid in decision[task]['source_ids']]
        history.extend(window['source_ids'])
    return result


def single_alias_prediction(prompt):
    window = prompt['target_window']
    current = [s['id'] for s in window['current_turns']]
    source_ids = current[:1]
    return {'windows': [{'id': window['id'],
        'relevance': {'label': 'relevant', 'reason': 'Đúng mục tiêu payment service.', 'source_ids': source_ids},
        'interaction': {'labels': [], 'reason': 'Không có tín hiệu trong danh mục.', 'source_ids': source_ids},
        'progress': {'label': 'advancing', 'reason': 'Làm rõ bước tiếp theo.', 'source_ids': source_ids}}]}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    base = tmp_path / 'owner'; base.mkdir()
    source, row, calls = canonical(), {'status': 'completed'}, []
    def fetch(_base, subject, mid, path):
        if subject != 'owner' or mid != 1:
            raise HTTPException(404, 'Meeting unavailable')
        return deepcopy(source if path.endswith('/canonical') else row)
    def complete(_request, raw):
        prepared = json.loads(raw); calls.append(prepared)
        return json.dumps({'classification': prediction(prepared), 'model': 'test-model'})
    monkeypatch.setattr(api, 'meeting_get', fetch)
    app = FastAPI()
    api.register(app, lambda request: request.headers.get('x-user-id', 'owner'),
                 lambda _request, _slug: base, WorkspaceReader(str(tmp_path)), '', complete)
    return TestClient(app), source, row, base, calls


def test_complete_source_preserved_with_separate_windows_and_context():
    source = canonical(); original = deepcopy(source)
    prepared = prepare(source, 'Chọn retry cho payment service')
    assert source == original
    assert [w['source_ids'] for w in prepared['windows']] == [['s0', 's1'], ['s2']]
    assert [s['quote'] for s in prepared['sources']] == [s['text'] for s in source['segments']]
    result = prediction(prepared)
    result['windows'][1]['progress'] = {'label': 'repeating_unresolved_positions', 'reason': 'Lặp lại.', 'source_ids': ['s0', 's2']}
    assert validate_classification(result, prepared) == result


def test_model_schema_exposes_only_classifications_not_server_owned_report_metadata():
    schema = classification_schema()
    assert schema['type'] == 'object'
    assert schema['required'] == ['windows']
    assert set(schema['properties']) == {'windows'}
    assert 'meeting_id' not in schema['properties'] and 'sources' not in schema['properties']
    result = prediction(prepare(canonical(), 'Retry'))
    with pytest.raises(ValidationError):
        validate_classification(result | {'model': 'invented', 'meeting_id': 1234}, prepare(canonical(), 'Retry'))


def test_empty_interaction_label_uses_the_target_window_as_negative_evidence():
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    result['windows'][0]['interaction']['source_ids'] = []
    validated = validate_classification(result, prepared)
    assert validated['windows'][0]['interaction']['labels'] == []
    assert validated['windows'][0]['interaction']['source_ids'] == prepared['windows'][0]['source_ids']


def test_empty_interaction_label_gets_a_fixed_explanation_when_model_omits_it():
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    result['windows'][0]['interaction']['reason'] = ''
    validated = validate_classification(result, prepared)
    assert validated['windows'][0]['interaction']['reason'] == 'Không phát hiện tín hiệu tương tác trong các nhãn được đánh giá.'


def test_uncertain_interaction_without_citations_uses_the_target_window():
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    result['windows'][0]['interaction'] = {'labels': ['uncertain'], 'reason': 'Không đủ ngữ cảnh.', 'source_ids': []}
    validated = validate_classification(result, prepared)
    assert validated['windows'][0]['interaction']['source_ids'] == prepared['windows'][0]['source_ids']


def test_repeating_progress_with_only_prior_citations_adds_the_current_window():
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    result['windows'][1]['progress'] = {'label': 'repeating_unresolved_positions',
        'reason': 'Repeated the earlier position without new evidence.', 'source_ids': ['s0']}
    validated = validate_classification(result, prepared)
    assert set(validated['windows'][1]['progress']['source_ids']) == {'s0', 's2'}


def test_duplicate_model_labels_and_evidence_are_deduplicated():
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    result['windows'][0]['interaction'] = {'labels': ['sarcasm', 'sarcasm'],
        'reason': 'Có một dấu hiệu.', 'source_ids': ['s0', 's0']}
    validated = validate_classification(result, prepared)
    assert validated['windows'][0]['interaction']['labels'] == ['sarcasm']
    assert validated['windows'][0]['interaction']['source_ids'] == ['s0']


def test_non_vietnamese_cjk_explanations_are_rejected_for_model_correction():
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    result['windows'][0]['relevance']['reason'] = '讨论 payment retry strategy.'
    with pytest.raises(ValueError, match='explanation must be Vietnamese'):
        validate_classification(result, prepared)


@pytest.mark.parametrize('mutation', ['invented', 'future', 'outside_target', 'missing_window', 'duplicate_window', 'mixed_uncertainty', 'unsupported_label', 'one_turn_repetition', 'empty_reason'])
def test_rejects_invalid_evidence_taxonomy_and_coverage(mutation):
    prepared = prepare(canonical(), 'Retry')
    result = prediction(prepared)
    first = result['windows'][0]
    if mutation == 'invented': first['relevance']['source_ids'] = ['fake']
    if mutation == 'future': first['progress']['source_ids'] = ['s0', 's2']
    if mutation == 'outside_target': result['windows'][1]['interaction']['source_ids'] = ['s0']
    if mutation == 'missing_window': result['windows'].pop()
    if mutation == 'duplicate_window': result['windows'][1]['id'] = 'w0'
    if mutation == 'mixed_uncertainty': first['interaction']['labels'] = ['uncertain', 'sarcasm']
    if mutation == 'unsupported_label': first['relevance']['label'] = 'negative'
    if mutation == 'one_turn_repetition': first['progress']['label'] = 'repeating_unresolved_positions'
    if mutation == 'empty_reason': first['progress']['reason'] = '   '
    with pytest.raises((ValueError, ValidationError)):
        validate_classification(result, prepared)


def test_manual_generation_persists_valid_report_and_reuses_same_snapshot(setup):
    client, source, _, base, calls = setup
    assert client.get(ROOT).json()['report'] is None
    result = client.post(ROOT, json={'agenda': 'Chọn retry cho payment service'})
    assert result.status_code == 200, result.text
    report = result.json()['report']
    validate_report(report)
    assert report['sources'][0]['quote'] == source['segments'][0]['text']
    assert json.loads((base / '.discussion-reviews/1.json').read_text(encoding='utf-8')) == report
    assert client.post(ROOT, json={'agenda': report['agenda']}).json()['report']['id'] == report['id']
    assert len(calls) == 1
    assert client.get(ROOT, headers={'x-user-id': 'stranger'}).status_code == 404
    assert client.post(ROOT, json={'agenda': 'Other'}, headers={'x-user-id': 'stranger'}).status_code == 404


@pytest.mark.parametrize('field,value', [('text', 'Sửa câu chữ.'), ('speaker_name', 'Unknown speaker'), ('start_ms', 100), ('revision', 1)])
def test_source_changes_mark_report_stale_and_new_generation_uses_cas(setup, field, value):
    client, source, _, _, calls = setup
    first = client.post(ROOT, json={'agenda': 'Retry'}).json()['report']
    source['segments'][0][field] = value
    assert client.get(ROOT).json()['stale'] is True
    assert client.post(ROOT, json={'agenda': 'Retry'}).status_code == 409
    response = client.post(ROOT, json={'agenda': 'Retry', 'expected_id': first['id']})
    assert response.status_code == 200, response.text
    assert response.json()['stale'] is False
    assert len(calls) == 2


def test_invalid_requests_and_oversized_input_never_call_model(setup):
    client, source, row, _, calls = setup
    assert client.post(ROOT, json={'agenda': ' '}).status_code == 422
    assert client.post(ROOT, json={'agenda': 'Retry', 'model': 'override'}).status_code == 422
    row['status'] = 'active'
    assert client.post(ROOT, json={'agenda': 'Retry'}).status_code == 409
    row['status'] = 'completed'
    source['segments'][0]['text'] = 'x' * 24001
    assert client.post(ROOT, json={'agenda': 'Retry'}).status_code == 422
    source['segments'] = []
    assert client.post(ROOT, json={'agenda': 'Retry'}).status_code == 422
    assert not calls


@pytest.mark.parametrize('change', ['edit', 'delete', 'concurrent', 'invalid'])
def test_delayed_or_invalid_results_do_not_overwrite_existing_report(setup, monkeypatch, change):
    client, source, row, base, _ = setup
    previous = client.post(ROOT, json={'agenda': 'Retry'}).json()['report']
    stored = base / '.discussion-reviews/1.json'
    app = FastAPI()
    def complete(_request, raw):
        prepared = json.loads(raw)
        if change == 'edit': source['segments'][0]['text'] = 'Changed during inference'
        if change == 'delete': row['status'] = 'deleted'
        if change == 'concurrent':
            stored.write_text(json.dumps(previous | {'id': 'b' * 32}), encoding='utf-8')
        result = prediction(prepared)
        if change == 'invalid': result['windows'][0]['relevance']['source_ids'] = ['invented']
        return json.dumps({'classification': result, 'model': 'test-model'})
    api.register(app, lambda _request: 'owner', lambda *_args: base, WorkspaceReader(str(base.parent)), '', complete)
    response = TestClient(app).post(ROOT, json={'agenda': 'Updated objective', 'expected_id': previous['id']})
    assert response.status_code == (502 if change == 'invalid' else 409), response.text
    assert json.loads(stored.read_text(encoding='utf-8'))['id'] == ('b' * 32 if change == 'concurrent' else previous['id'])


@pytest.mark.parametrize('fenced', [False, True])
def test_private_worker_calls_completion_with_rubric_and_suppresses_mismatched_requests(monkeypatch, caplog, fenced):
    from llm.ports import CompletionResult
    from shared import units
    from worker import discussion_review as worker
    prepared = prepare(canonical(), 'Retry')
    call_count = []
    class Completion:
        def complete(self, prompt, **kwargs):
            value = json.loads(prompt)
            assert value['agenda'] == prepared['agenda']
            target = value['target_window']; call_count.append(target['id'])
            index = int(target['id'][1:])
            expected = prepared['windows'][index]
            assert [s['text'] for s in target['current_turns']] == [
                next(source['quote'] for source in prepared['sources'] if source['id'] == sid)
                for sid in expected['source_ids']]
            assert [source['id'] for source in target['current_turns']] == [f't{i}' for i in range(len(expected['source_ids']))]
            assert [source['id'] for source in target['earlier_turns']] == [f'h{i}' for i in range(sum(len(w['source_ids']) for w in prepared['windows'][:index]))]
            assert 'untrusted DATA' in kwargs['system']
            assert f'Classify only target window {target["id"]}' in kwargs['system']
            windows_schema = kwargs['response_schema']['properties']['windows']
            assert windows_schema['type'] == 'array'
            assert windows_schema['minItems'] == windows_schema['maxItems'] == 1
            assert windows_schema['items']['properties']['id']['enum'] == [target['id']]
            assert 'label' in windows_schema['items']['properties']['relevance']['required']
            assert 'labels' in windows_schema['items']['properties']['interaction']['required']
            for task in ('relevance', 'interaction', 'progress'):
                source_ids = windows_schema['items']['properties'][task]['properties']['source_ids']
                assert source_ids['minItems'] == 1
            expected_progress_ids = ['t0', 't1'] if index == 0 else ['h0', 'h1', 't0']
            assert windows_schema['items']['properties']['progress']['properties']['source_ids']['items']['enum'] == expected_progress_ids
            assert 'Schema:' in kwargs['system']
            assert 'Return only the target window' not in kwargs['system']
            text = json.dumps(single_alias_prediction(value))
            return CompletionResult(text='```json\n' + text + '\n```' if fenced else text, model='test-model')
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_args): pass
    start = units.entrypoint(inline=units.DISCUSSION_REVIEW_PREFIX + json.dumps({'request_id': 'r1', 'text': json.dumps(prepared)}))
    invocation = units.make_dispatch(subject='owner', trigger='message', start=start,
        workspaces=[{'id': 'owner', 'mode': 'ro'}], context={'kind': 'none', 'session': 'discussion-review-r1'})
    assert units.is_discussion_review(invocation) and units.is_private_transcript_job(invocation)
    monkeypatch.setenv('TINA_CHAT_SESSION', 'discussion-review-r1')
    monkeypatch.setattr(worker, 'completion_from_env', lambda **kwargs: Completion())
    stream = Stream(); worker.run(stream, 'private-output', start)
    assert json.loads(stream.events[0]['text'])['model'] == 'test-model'
    assert call_count == ['w0', 'w1']
    monkeypatch.setenv('TINA_CHAT_SESSION', 'wrong-request')
    stream.events.clear(); worker.run(stream, 'private-output', start)
    assert stream.events == [{'type': 'turn-complete'}]
    assert prepared['sources'][0]['quote'] not in caplog.text


def test_worker_repairs_one_invalid_evidence_response_without_publishing_it(monkeypatch):
    from llm.ports import CompletionResult
    from shared.units import DISCUSSION_REVIEW_PREFIX, entrypoint
    from worker import discussion_review as worker
    prepared = prepare(canonical(), 'Retry')
    calls = []
    class Completion:
        def complete(self, prompt, **kwargs):
            body = json.loads(prompt); calls.append(body)
            result = single_alias_prediction(body)
            if len(calls) == 1:
                result['windows'][0]['progress']['source_ids'] = ['t0', 'not-an-alias']
            else:
                if len(calls) == 2:
                    assert body['validation_errors']
                    assert body['previous_invalid_output']
            return CompletionResult(text=json.dumps(result), model='test-model')
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_args): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'discussion-review-repair')
    monkeypatch.setattr(worker, 'completion_from_env', lambda **kwargs: Completion())
    start = entrypoint(inline=DISCUSSION_REVIEW_PREFIX + json.dumps({'request_id': 'repair', 'text': json.dumps(prepared)}))
    stream = Stream()
    worker.run(stream, 'private-output', start)
    assert len(calls) == len(prepared['windows']) + 1
    assert json.loads(stream.events[0]['text'])['classification'] == prediction(prepared)


def test_worker_retries_cjk_explanations_without_echoing_the_invalid_text(monkeypatch):
    from llm.ports import CompletionResult
    from shared.units import DISCUSSION_REVIEW_PREFIX, entrypoint
    from worker import discussion_review as worker
    prepared = prepare(canonical(), 'Retry')
    calls = []
    class Completion:
        def complete(self, prompt, **_kwargs):
            body = json.loads(prompt); calls.append(body)
            result = single_alias_prediction(body)
            if len(calls) == 1:
                result['windows'][0]['relevance']['reason'] = '需要支付API的重试策略。'
            elif len(calls) == 2:
                assert any('CJK text' in issue for issue in body['validation_errors'])
                assert 'previous_invalid_output' not in body
                assert 'Vietnamese' in body['correction_instruction']
            return CompletionResult(json.dumps(result), 'test-model')
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_args): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'discussion-review-language')
    monkeypatch.setattr(worker, 'completion_from_env', lambda **kwargs: Completion())
    start = entrypoint(inline=DISCUSSION_REVIEW_PREFIX + json.dumps({'request_id': 'language', 'text': json.dumps(prepared)}))
    stream = Stream(); worker.run(stream, 'private-output', start)
    result = json.loads(stream.events[0]['text'])['classification']
    assert result['windows'][0]['relevance']['reason'] == 'Đúng mục tiêu payment service.'
    assert len(calls) == len(prepared['windows']) + 1


@pytest.mark.parametrize('failure', ['invalid_json', 'invented_evidence', 'fenced_invented_evidence', 'provider_failure'])
def test_worker_failures_publish_no_classifications_or_private_provider_details(monkeypatch, caplog, failure):
    from llm.ports import CompletionResult
    from shared.units import DISCUSSION_REVIEW_PREFIX, entrypoint
    from worker import discussion_review as worker
    prepared = prepare(canonical(), 'Retry')
    class Completion:
        def complete(self, prompt, **_kwargs):
            if failure == 'provider_failure': raise RuntimeError('private-provider-detail')
            result = single_alias_prediction(json.loads(prompt))
            result['windows'][0]['relevance']['source_ids'] = ['fake']
            text = json.dumps(result)
            if failure == 'fenced_invented_evidence': text = '```json\n' + text + '\n```'
            return CompletionResult(text='private-provider-detail' if failure == 'invalid_json' else text)
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_args): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'discussion-review-r1')
    monkeypatch.setattr(worker, 'completion_from_env', lambda **kwargs: Completion())
    stream = Stream()
    worker.run(stream, 'private-output', entrypoint(inline=DISCUSSION_REVIEW_PREFIX + json.dumps({'request_id': 'r1', 'text': json.dumps(prepared)})))
    assert stream.events == [{'type': 'turn-complete'}]
    assert 'private-provider-detail' not in caplog.text


def test_front_door_dispatches_an_isolated_read_only_private_job(tmp_path, monkeypatch):
    from control_plane.api import create_app
    from control_plane.dispatch import Dispatcher
    from shared.config import load_settings
    from shared.units import is_private_transcript_job
    class Runtime:
        def __init__(self): self.spawned = []
        def spawn(self, workload_id, profile, env):
            self.spawned.append((workload_id, profile, env))
            return workload_id
    class Identity:
        def mint(self, *_args, **_kwargs): return 'test-token'
    source = canonical()
    def fetch(_base, subject, mid, path):
        assert subject == 'u_jane' and mid == 1
        return deepcopy(source if path.endswith('/canonical') else {'status': 'completed'})
    monkeypatch.setattr(api, 'meeting_get', fetch)
    root = tmp_path / 'workspaces'; (root / 'u_jane').mkdir(parents=True)
    runtime = Runtime()
    settings = load_settings(workspaces_dir=str(root), redis_url='')
    dispatcher = Dispatcher(settings, runtime, Identity())
    class Reader:
        def read(self, unit_id, **kwargs):
            env = runtime.spawned[-1][2]
            assert env['TINA_DISCUSSION_REVIEW'] == '1'
            assert all(not mount['write'] for mount in json.loads(env['TINA_MOUNTS']))
            start = json.loads(env['TINA_START'])
            assert is_private_transcript_job({'trigger': 'message', 'start': start, 'context': {'session': env['TINA_CHAT_SESSION']}})
            payload = json.loads(start['entrypoint']['inline'].split(':', 1)[1])
            prepared = json.loads(payload['text'])
            yield {'type': 'message-delta', 'text': json.dumps({'classification': prediction(prepared), 'model': 'test-model'})}
            yield {'type': 'turn-complete'}
    client = TestClient(create_app(dispatcher, stream_reader=Reader(), reader=WorkspaceReader(str(root))))
    result = client.post(ROOT, json={'agenda': 'Retry'})
    assert result.status_code == 200, result.text
