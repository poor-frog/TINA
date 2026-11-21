import json
import threading
from copy import deepcopy

import pytest

from llm.ports import CompletionResult
from shared.discussion_review import prepare
from worker.discussion_review import classify


def prepared():
    return prepare({'segments': [
        {'segment_id': f'segment/{i}', 'revision': 0, 'speaker_name': 'Lan',
         'start_ms': i * 70000, 'end_ms': i * 70000 + 2000,
         'text': f'Kiểm tra phương án retry số {i}.'} for i in range(4)]}, 'Chọn retry')


def prediction(prompt):
    targets = prompt.get('target_windows') or [prompt['target_window']]
    windows = []
    for target in targets:
        ids = target.get('current_source_ids') or [s['id'] for s in target['current_turns']]
        windows.append({'id': target['id'],
            'relevance': {'label': 'relevant', 'reason': 'Đúng mục tiêu.', 'source_ids': ids},
            'interaction': {'labels': [], 'reason': 'Không có công kích.', 'source_ids': ids},
            'progress': {'label': 'exploring', 'reason': 'Đang tìm phương án.', 'source_ids': ids}})
    return {'windows': windows}


@pytest.mark.parametrize('strategy,size,expected_calls', [('sequential', 2, 4), ('concurrent', 2, 4), ('batch', 2, 2), ('batch', 4, 1)])
def test_strategies_preserve_source_coverage_and_input(strategy, size, expected_calls):
    source = prepared(); original = deepcopy(source)
    calls = []
    class Completion:
        def complete(self, raw, **kwargs):
            prompt = json.loads(raw); calls.append(prompt)
            if 'target_window' in prompt:
                index = int(prompt['target_window']['id'][1:])
                assert len(prompt['target_window']['earlier_turns']) == index
                assert len(prompt['target_window']['current_turns']) == 1
                assert 'no future turns' in kwargs['system']
            else:
                final = int(prompt['target_windows'][-1]['id'][1:])
                assert len(prompt['sources']) == final + 1
                assert 'later target turns ARE visible' in kwargs['system']
                assert len({s['id'] for s in prompt['sources']}) == len(prompt['sources'])
            return CompletionResult(json.dumps(prediction(prompt)), 'test-model')
    result = classify(source, strategy=strategy, batch_size=size, completion_factory=Completion)
    assert len(calls) == expected_calls
    assert [w['id'] for w in result['classification']['windows']] == ['w0', 'w1', 'w2', 'w3']
    assert [w['progress']['source_ids'] for w in result['classification']['windows']] == [['s0'], ['s1'], ['s2'], ['s3']]
    assert source == original


def test_concurrency_is_bounded_and_results_are_chronological():
    barrier = threading.Barrier(2, timeout=3)
    lock = threading.Lock()
    first_released = threading.Event()
    active = peak = 0
    completed = []
    class Completion:
        def complete(self, raw, **kwargs):
            nonlocal active, peak
            prompt = json.loads(raw); wid = prompt['target_window']['id']
            with lock:
                active += 1; peak = max(peak, active)
            try:
                barrier.wait()
                if wid == 'w0':
                    assert first_released.wait(3)
                if wid == 'w1':
                    completed.append(wid); first_released.set()
                else:
                    completed.append(wid)
                return CompletionResult(json.dumps(prediction(prompt)), 'test-model')
            finally:
                with lock: active -= 1
    result = classify(prepared(), strategy='concurrent', completion_factory=Completion)
    assert peak == 2 and active == 0
    assert completed.index('w1') < completed.index('w0')
    assert [w['id'] for w in result['classification']['windows']] == ['w0', 'w1', 'w2', 'w3']


@pytest.mark.parametrize('mutation', ['future', 'outside_target', 'duplicate', 'missing', 'extra', 'cjk'])
def test_batches_retry_once_and_reject_invalid_results(mutation):
    calls = []
    class Completion:
        def complete(self, raw, **kwargs):
            prompt = json.loads(raw); calls.append(prompt)
            result = prediction(prompt)
            if mutation == 'future': result['windows'][0]['progress']['source_ids'] = ['w1_t0']
            if mutation == 'outside_target': result['windows'][1]['interaction']['source_ids'] = ['w0_t0']
            if mutation == 'duplicate': result['windows'][1] = deepcopy(result['windows'][0])
            if mutation == 'missing': result['windows'].pop()
            if mutation == 'extra': result['invented'] = True
            if mutation == 'cjk': result['windows'][0]['relevance']['reason'] = '讨论'
            return CompletionResult(json.dumps(result), 'test-model')
    with pytest.raises(ValueError):
        classify(prepared(), strategy='batch', completion_factory=Completion)
    assert len(calls) == 2
    assert calls[1]['validation_errors']
    if mutation == 'cjk': assert 'previous_invalid_output' not in calls[1]


def test_batch_repairs_whole_batch_and_normalizes_order():
    calls = []
    class Completion:
        def complete(self, raw, **kwargs):
            prompt = json.loads(raw); calls.append(prompt)
            result = prediction(prompt)
            if len(calls) == 1:
                result['windows'].pop()
            else:
                result['windows'].reverse()
            return CompletionResult(json.dumps(result), 'test-model')
    result = classify(prepared(), strategy='batch', completion_factory=Completion)
    assert len(calls) == 3
    assert [w['id'] for w in result['classification']['windows']] == ['w0', 'w1', 'w2', 'w3']


def test_exhausted_invalid_candidate_is_not_accepted():
    calls = []
    class Completion:
        def complete(self, raw, **kwargs):
            prompt = json.loads(raw); calls.append(prompt)
            result = prediction(prompt)
            result['windows'][0]['progress']['source_ids'] = ['fake']
            return CompletionResult(json.dumps(result) if len(calls) == 1 else 'x' * 10001, 'test-model')
    with pytest.raises(ValueError, match='too large'):
        classify(prepared(), completion_factory=Completion)
    assert len(calls) == 2


def test_concurrent_failure_drains_inflight_calls():
    barrier = threading.Barrier(2, timeout=3)
    finished = threading.Event()
    class Completion:
        def complete(self, raw, **kwargs):
            prompt = json.loads(raw)
            barrier.wait()
            if prompt['target_window']['id'] == 'w0': raise RuntimeError('provider failed')
            finished.set()
            return CompletionResult(json.dumps(prediction(prompt)), 'test-model')
    with pytest.raises(RuntimeError, match='provider failed'):
        classify(prepared(), strategy='concurrent', completion_factory=Completion)
    assert finished.is_set()


def test_batch_cannot_hide_extra_top_level_properties():
    class Completion:
        def complete(self, raw, **kwargs):
            result = prediction(json.loads(raw))
            result['meeting_id'] = 99
            return CompletionResult(json.dumps(result), 'test-model')
    with pytest.raises(ValueError, match='additionalProperties'):
        classify(prepared(), strategy='batch', completion_factory=Completion)


def test_batch_progress_can_cite_prior_batches_without_future_evidence():
    class Completion:
        def complete(self, raw, **kwargs):
            prompt = json.loads(raw)
            result = prediction(prompt)
            for target, window in zip(prompt['target_windows'], result['windows']):
                index = int(window['id'][1:])
                assert all(int(alias.split('_')[0][1:]) <= index for alias in target['allowed_progress_source_ids'])
                if index:
                    window['progress'].update(label='repeating_unresolved_positions', source_ids=['w0_t0', f'w{index}_t0'])
            return CompletionResult(json.dumps(result), 'test-model')
    result = classify(prepared(), strategy='batch', completion_factory=Completion)
    assert result['classification']['windows'][2]['progress']['source_ids'] == ['s0', 's2']
