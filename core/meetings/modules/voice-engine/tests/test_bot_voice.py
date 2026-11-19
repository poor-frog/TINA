"""Room arbitration/quiet gate without microphone or native inference."""
import numpy as np
from tina_meeting_voice.bot import BotVoice
from tina_meeting_voice.wakeword import WakeDetector


class Kws:
    def __init__(self): self.trigger = False
    def accept(self, audio): return self.trigger
    def reset(self): self.trigger = False


class Vad:
    def feed(self, audio): return True, False


def fixture():
    now = [0.0]
    detectors, events = [], []
    def detector():
        value = WakeDetector(Kws()); detectors.append(value); return value
    engine = BotVoice(detector, Vad, events.append, lambda: now[0])
    return engine, now, detectors, events


def test_channel_streams_are_independent_and_identity_changes_reset():
    engine, now, detectors, events = fixture()
    engine.feed(1, 'a', np.ones(320), 1000)
    engine.feed(2, 'b', np.ones(320), 1000)
    assert len(detectors) == 2 and detectors[0] is not detectors[1]
    engine.feed(1, 'c', np.zeros(320), 1020)
    assert detectors[0].closed and len(detectors) == 3
    engine.close()
    assert all(d.closed for d in detectors)


def test_overlapping_wake_does_not_pick_an_arbitrary_speaker():
    engine, now, detectors, events = fixture()
    engine.feed(1, 'a', np.ones(320), 1000)
    engine.feed(2, 'b', np.ones(320), 1000)
    detectors[0].kws.trigger = True
    engine.feed(1, 'a', np.ones(320), 1020)
    assert engine.state == 'QUIET'
    assert any(e.get('reason') == 'ambiguous_wake' for e in events)
    assert not any(e['event'] == 'question' for e in events)


def test_overlap_during_capture_discards_question():
    engine, now, detectors, events = fixture()
    engine.feed(1, 'a', np.ones(320), 1000)
    detectors[0].kws.trigger = True
    engine.feed(1, 'a', np.ones(320), 1020)
    assert engine.state == 'CAPTURING'
    engine.feed(2, 'b', np.ones(320), 1020)
    assert engine.state == 'QUIET'
    assert engine.capture is None


def test_quiet_wait_uses_room_time_not_sum_of_silent_channels():
    engine, now, detectors, events = fixture()
    engine.control('SPEAKING')
    engine.feed(1, 'a', np.ones(320), 1000)
    assert engine.state == 'SPEAKING' and not detectors
    engine.control('QUIET')
    for channel in range(32): engine.feed(channel, str(channel), np.zeros(320), 1000)
    assert engine.state == 'QUIET'
    now[0] = .79
    engine.feed(0, '0', np.zeros(320), 1020)
    assert engine.state == 'QUIET'
    now[0] = .81
    engine.feed(0, '0', np.zeros(320), 1040)
    assert engine.state == 'LISTENING'


def test_missing_source_audio_still_expires_capture_on_wall_clock():
    engine, now, detectors, events = fixture()
    engine.feed(1, 'a', np.ones(320), 1000)
    detectors[0].kws.trigger = True
    engine.feed(1, 'a', np.ones(320), 1020)
    assert engine.state == 'CAPTURING'
    now[0] = 21
    engine.tick()
    assert engine.state == 'QUIET' and engine.capture is None


def test_batched_callbacks_may_share_capture_timestamp_without_resetting_stream():
    engine, _, detectors, _ = fixture()
    engine.feed(1, 'a', np.zeros(320), 1000)
    engine.feed(1, 'a', np.zeros(320), 1000)
    assert len(detectors) == 1 and not detectors[0].closed
