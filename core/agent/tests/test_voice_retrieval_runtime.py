"""Semantic failures retain lexical fallback and recover without a process restart."""
import threading

import pytest

from control_plane import voice_retrieval as retrieval


@pytest.mark.parametrize('stage', ['initialization', 'inference'])
def test_semantic_failure_retries_after_cooldown_and_reuses_a_healthy_encoder(monkeypatch, caplog, stage):
    clock, attempts, ranks = [100.0], [], []
    class Encoder:
        def __init__(self, directory):
            attempts.append(directory)
            if stage == 'initialization' and len(attempts) == 1:
                raise OSError('PRIVATE ARTIFACT PATH')

        def rank(self, scope, question, sources):
            ranks.append(scope)
            if stage == 'inference' and len(ranks) == 1:
                raise RuntimeError('PRIVATE SOURCE OR PROVIDER MESSAGE')
            return [0]

    monkeypatch.setattr(retrieval, '_encoder', None)
    monkeypatch.setattr(retrieval, '_failed', False)
    monkeypatch.setattr(retrieval, '_retry_at', 0.0, raising=False)
    monkeypatch.setattr(retrieval, '_lock', threading.Lock())
    monkeypatch.setattr(retrieval, 'Encoder', Encoder)
    monkeypatch.setattr(retrieval.time, 'monotonic', lambda: clock[0])
    rows = [{'key':'a', 'fingerprint':'a', 'quote':'Demo.'}]
    assert retrieval.semantic_rank('scope1', 'demo', rows) == []
    assert retrieval._failed is True
    retry_at = retrieval._retry_at
    assert retry_at > clock[0]
    clock[0] = retry_at - .001
    assert retrieval.semantic_rank('scope2', 'demo', rows) == []
    assert len(attempts) == 1 and len(ranks) == (stage == 'inference')
    clock[0] = retry_at
    assert retrieval.semantic_rank('scope2', 'demo', rows) == [0]
    assert retrieval._failed is False
    attempts_after_recovery = len(attempts)
    assert retrieval.semantic_rank('scope3', 'demo', rows) == [0]
    assert len(attempts) == attempts_after_recovery
    assert 'PRIVATE' not in caplog.text


def test_repeated_semantic_failure_cannot_retry_on_every_request(monkeypatch):
    clock, attempts = [100.0], []
    def unavailable(directory):
        attempts.append(directory)
        raise ValueError('Synthetic checksum mismatch')
    monkeypatch.setattr(retrieval, '_encoder', None)
    monkeypatch.setattr(retrieval, '_failed', False)
    monkeypatch.setattr(retrieval, '_retry_at', 0.0, raising=False)
    monkeypatch.setattr(retrieval, '_lock', threading.Lock())
    monkeypatch.setattr(retrieval, 'Encoder', unavailable)
    monkeypatch.setattr(retrieval.time, 'monotonic', lambda: clock[0])
    rows = [{'key':'a', 'fingerprint':'a', 'quote':'Demo.'}]
    for _ in range(3): assert retrieval.semantic_rank('scope', 'demo', rows) == []
    assert len(attempts) == 1
    clock[0] = retrieval._retry_at
    for _ in range(3): assert retrieval.semantic_rank('scope', 'demo', rows) == []
    assert len(attempts) == 2 and retrieval._retry_at > clock[0]


def test_semantic_rank_logs_warning_when_lock_is_busy(monkeypatch, caplog):
    import logging
    busy_lock = threading.Lock()
    busy_lock.acquire()
    monkeypatch.setattr(retrieval, '_lock', busy_lock)
    monkeypatch.setattr(retrieval, '_LOCK_TIMEOUT', 0.02)
    rows = [{'key': 'a', 'fingerprint': 'a', 'quote': 'Demo.'}]
    try:
        with caplog.at_level(logging.WARNING, logger='control_plane.voice_retrieval'):
            assert retrieval.semantic_rank('scope', 'demo', rows) == []
        assert 'lock_busy=true' in caplog.text
    finally:
        busy_lock.release()
