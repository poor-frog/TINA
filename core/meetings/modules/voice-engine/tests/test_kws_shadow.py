import hashlib
import json
import runpy
from pathlib import Path
import numpy as np
import pytest
from tina_meeting_voice import kws_shadow


class Stream:
    def __init__(self): self.pending = np.zeros(0, np.float32); self.steps = []; self.score = 0
    def feed(self, samples):
        self.pending = np.concatenate([self.pending, samples])
        score = 0
        while len(self.pending) >= 1280:
            self.steps.append(self.pending[:1280].copy()); self.pending = self.pending[1280:]
            score = self.score
        return score


def fixture(monkeypatch):
    streams, events, now = [], [], [0.0]
    def factory():
        row = {'tina_oi': Stream()}; streams.append(row['tina_oi']); return row
    monkeypatch.setattr(kws_shadow, 'load_stream_factory', lambda _: factory)
    engine = kws_shadow.KwsMonitor(None, events.append, lambda: now[0])
    return engine, streams, events, now


def test_64ms_packets_assemble_into_80ms_without_loss_and_isolate_speakers(monkeypatch):
    engine, streams, events, _ = fixture(monkeypatch)
    source = np.arange(5120, dtype=np.float32)
    for i in range(5):
        engine.feed(1, 'a', source[i*1024:(i+1)*1024], 1000+i*64, i*1024)
        engine.feed(2, 'b', np.zeros(1024), 1000+i*64, i*1024)
    assert np.array_equal(np.concatenate(streams[0].steps), source)
    assert not np.any(np.concatenate(streams[1].steps))
    assert len(streams[0].steps) == 4 and len(streams[0].pending) == 0
    assert not any(e['status'] == 'wake' for e in events)
    engine.close(); assert not engine.channels and engine.factory is None


def test_wakes_are_content_free_cooldown_bounded_and_blocked_through_quiet(monkeypatch):
    engine, streams, events, now = fixture(monkeypatch)
    streams[0].score = .9
    engine.feed(3, 'PRIVATE-ID', np.zeros(1280), 1000, 0)
    engine.feed(3, 'PRIVATE-ID', np.zeros(1280), 1080, 1280)
    wakes = [e for e in events if e['status'] == 'wake']
    assert len(wakes) == 1 and wakes[0]['source_frame_end_ms'] == 1080
    assert 'PRIVATE-ID' not in json.dumps([{k:v for k,v in e.items() if k != 'participant'} for e in events])
    for state in ['THINKING', 'SPEAKING', 'QUIET', 'ERROR', 'OFF']:
        engine.control(state); now[0] += 2
        engine.feed(3, 'PRIVATE-ID', np.ones(1280), 1160)
        assert not engine.channels
    assert len([e for e in events if e['status'] == 'wake']) == 1
    engine.control('LISTENING'); engine.feed(3, None, np.zeros(1024), 20000, 0)
    assert len(streams) == 2 and len(streams[1].pending) == 1024


def test_identity_sample_gap_backwards_clock_and_idle_expiry_clear_history(monkeypatch):
    engine, streams, _, now = fixture(monkeypatch)
    engine.feed(1, 'a', np.ones(1024), 1000, 0)
    engine.feed(1, 'b', np.zeros(1024), 1064, 1024)
    engine.feed(1, 'b', np.zeros(1024), 1128, 4096)
    engine.feed(1, 'b', np.zeros(1024), 900, 5120)
    engine.feed(1, 'b', np.zeros(1024), 2001, 6144)
    assert len(streams) == 5 and all(not s.steps for s in streams)
    engine.control('CAPTURING'); assert not engine.channels
    engine.control('LISTENING'); engine.feed(1, 'b', np.zeros(1024), 2065, 7168)
    now[0] = 21; engine.tick(); assert not engine.channels


def test_channel_limit_and_invalid_frames_are_bounded(monkeypatch):
    engine, streams, _, _ = fixture(monkeypatch)
    for channel in range(40): engine.feed(channel, None, np.zeros(1024), 1000)
    assert len(engine.channels) == len(streams) == 32
    for channel, audio, stamp, sample in [(True, [0], 1000, None), (0, [np.nan], 1000, None),
                                         (0, [0], float('inf'), None), (0, [0], 1000, -1)]:
        with pytest.raises(ValueError): engine.feed(channel, None, audio, stamp, sample)


def test_assets_must_match_trusted_hash_and_size(monkeypatch, tmp_path):
    asset = tmp_path/'tina.onnx'; asset.write_bytes(b'fixture')
    monkeypatch.setattr(kws_shadow, 'manifest', lambda: {'models': {'tina': {
        'bytes': 7, 'sha256': hashlib.sha256(b'fixture').hexdigest()}}})
    kws_shadow.verify(tmp_path)
    asset.write_bytes(b'changed')
    with pytest.raises(ValueError, match='checksum'): kws_shadow.verify(tmp_path)


def test_installer_is_atomic_repeatable_and_preserves_the_vad_cache(monkeypatch, tmp_path):
    installer = runpy.run_path(str(Path(__file__).resolve().parents[5] / 'deploy/wakeword/install_local.py'))['install']
    source = tmp_path/'source'; source.mkdir(); (source/'tina_oi.onnx').write_bytes(b'fixture')
    cache = tmp_path/'cache'; cache.mkdir(); (cache/'silero_vad.onnx').write_bytes(b'existing')
    monkeypatch.setattr(kws_shadow, 'manifest', lambda: {'models': {'tina_oi': {
        'bytes': 7, 'sha256': hashlib.sha256(b'fixture').hexdigest()}}})
    target = installer(source, cache)
    for name in ('tina', 'e_tina'): (target / (name + '.onnx')).write_bytes(b'retired')
    assert installer(source, cache) == target and (cache/'silero_vad.onnx').read_bytes() == b'existing'
    assert not (target/'tina.onnx').exists() and not (target/'e_tina.onnx').exists()
    assert (target/'LICENSE').is_file() and (target/'NOTICE').is_file()
    (target/'tina_oi.onnx').write_bytes(b'bad')
    with pytest.raises(ValueError): installer(source, cache)
    assert (target/'tina_oi.onnx').read_bytes() == b'bad', 'never silently replace an existing model directory'


def test_only_the_two_retained_detectors_can_be_loaded_or_retrained():
    expected = {'hey_tina', 'tina_oi'}
    assert set(kws_shadow.manifest()['models']) == expected
    recipe = Path(__file__).resolve().parents[5] / 'deploy/wakeword/training/phrases.json'
    assert {row['name'] for row in json.loads(recipe.read_text())['phrases']} == expected


def test_score_metrics_survive_stream_resets_and_never_include_identity_or_audio(monkeypatch):
    engine, streams, events, now = fixture(monkeypatch)
    streams[0].score = .4
    engine.feed(1, 'private-person', np.zeros(1280), 1000)
    now[0] = 1; engine.feed(1, 'another-private-person', np.zeros(1280), 1080)
    now[0] = 3.1; engine.feed(1, 'private-person', np.zeros(1280), 1160)
    metrics = [e for e in events if e['status'] == 'metrics']
    assert len(metrics) == 1 and metrics[0]['identity_resets'] == 2
    assert metrics[0]['frames'] == 3 and metrics[0]['peak_scores']['tina_oi'] == .4
    assert 'private-person' not in json.dumps(metrics) and 'audio' not in json.dumps(metrics)


def test_intermittent_identity_metadata_keeps_the_same_audio_stream_until_a_known_conflict(monkeypatch):
    engine, streams, _, _ = fixture(monkeypatch)
    for i, participant in enumerate([None, 'a', None, 'a']):
        engine.feed(1, participant, np.zeros(1024), 1000+i*64, i*1024)
    assert len(streams) == 1 and len(streams[0].steps) == 3
    assert engine.health[1]['identity_resets'] == 0
    engine.feed(1, 'b', np.zeros(1024), 1256, 4096)
    assert len(streams) == 2 and engine.health[1]['identity_resets'] == 1


def test_wake_keeps_only_recent_continuous_transport_identity(monkeypatch):
    engine, streams, events, now = fixture(monkeypatch)
    engine.feed(1, 'a', np.zeros(1024), 1000, 0)
    streams[0].score = .9
    engine.feed(1, None, np.zeros(1024), 1064, 1024)
    assert [e for e in events if e['status'] == 'wake'][-1]['participant'] == 'a'
    now[0] = 2
    for i in range(2, 28):
        engine.feed(1, None, np.zeros(1024), 1000+i*64, i*1024)
    now[0] = 4
    engine.feed(1, None, np.zeros(1280), 2792, 28*1024)
    assert [e for e in events if e['status'] == 'wake'][-1]['participant'] is None
    engine.feed(1, None, np.zeros(1280), 4000, 0)
    streams[-1].score = .9
    engine.feed(1, None, np.zeros(1280), 4080, 1280)
    assert [e for e in events if e['status'] == 'wake'][-1]['participant'] is None
