import io
from types import SimpleNamespace
import threading
import time
from unittest.mock import Mock
import wave

import numpy as np
import pytest

from tina_meeting_voice.capture import QuestionCapture
from tina_speech.session import SpeechSession
from tina_meeting_voice.wakeword import WakeDetector, WakeEvent

VOICE = np.ones(320, dtype=np.float32) * .2
QUIET = np.zeros(320, dtype=np.float32)


class Vad:
    def __init__(self): self.quiet = 0; self.spoken = False
    def feed(self, audio):
        active = bool(np.max(np.abs(audio)) >= .01)
        self.spoken = self.spoken or active
        self.quiet = 0 if active else self.quiet + len(audio)
        return active, self.spoken and self.quiet >= 12800


def event():
    return WakeEvent(32000, 0, np.concatenate([np.zeros(30000, dtype=np.float32), np.ones(2000, dtype=np.float32) * .1]))


def test_capture_keeps_immediate_question_pre_roll_and_ends_on_vad():
    wake = event()
    capture = QuestionCapture(wake, Vad())
    for _ in range(50): assert capture.feed(VOICE) is None
    for _ in range(39): assert capture.feed(QUIET) is None
    result = capture.feed(QUIET)
    assert result is not None
    with wave.open(io.BytesIO(result)) as wav:
        pcm = np.frombuffer(wav.readframes(wav.getnframes()), dtype='<i2')
    assert len(pcm) == 32000 + 50 * 320 + 40 * 320
    np.testing.assert_array_equal(pcm[:32000], np.rint(wake.pre_roll * 32767).astype('<i2'))


def test_capture_no_speech_and_duration_are_bounded():
    silent = WakeEvent(32000, 0, np.zeros(32000, dtype=np.float32))
    capture = QuestionCapture(silent, Vad())
    with pytest.raises(ValueError, match='No question'):
        for _ in range(250): capture.feed(QUIET)
    capture = QuestionCapture(event(), Vad())
    with pytest.raises(ValueError, match='20 seconds'):
        for _ in range(1001): capture.feed(VOICE)
    assert capture.samples <= 32000 + 320000 + 320


def test_question_entirely_in_pre_roll_is_not_lost_when_kws_reports_late():
    capture = QuestionCapture(event(), Vad())
    for _ in range(59): assert capture.feed(QUIET) is None
    assert capture.feed(QUIET) is not None


def test_question_already_endpointed_in_pre_roll_waits_for_possible_continuation():
    vad = SimpleNamespace(feed=Mock(side_effect=[(False, True)] + [(False, False)] * 60))
    capture = QuestionCapture(event(), vad)
    for _ in range(59): assert capture.feed(QUIET) is None
    assert capture.feed(QUIET) is not None


def test_pause_after_wake_does_not_upload_the_wake_without_its_question():
    vad = SimpleNamespace(feed=Mock(side_effect=[(False, True)] + [(False, False)] * 10
        + [(True, False)] * 20 + [(False, False)] * 39 + [(False, True)]))
    capture = QuestionCapture(event(), vad)
    for _ in range(10): assert capture.feed(QUIET) is None
    for _ in range(20): assert capture.feed(VOICE) is None
    for _ in range(39): assert capture.feed(QUIET) is None
    assert capture.feed(QUIET) is not None


def test_wake_endpoint_just_after_detection_waits_for_the_question():
    vad = SimpleNamespace(feed=Mock(side_effect=[(True, False), (False, True)]
        + [(False, False)] * 9 + [(True, False)] * 20
        + [(False, False)] * 39 + [(False, True)]))
    capture = QuestionCapture(event(), vad)
    for _ in range(10): assert capture.feed(QUIET) is None
    for _ in range(20): assert capture.feed(VOICE) is None
    for _ in range(39): assert capture.feed(QUIET) is None
    assert capture.feed(QUIET) is not None


class Client:
    def __init__(self):
        self.http = Mock()
        self.uploads = []
        self.release = threading.Event()
        self.cancelled = []
    def room(self): return {'epoch': '00000000-0000-4000-8000-000000000000', 'revision': 0, 'busy': False}
    def reserve(self, identifier, revision): return {'request_id': identifier, 'state': 'CAPTURING'}
    def submit(self, identifier, audio, stopped, notify):
        self.uploads.append((identifier, audio))
        notify('SPEAKING')
        self.release.wait(2)
        return 'COMPLETED'
    def cancel(self, identifier):
        self.cancelled.append(identifier)
        return {'state': 'STOPPED'}


def test_session_suppresses_new_wakes_until_confirmed_completion_and_stop_closes():
    kws = SimpleNamespace(accept=Mock(return_value=True), reset=Mock())
    client = Client(); messages = []
    session = SpeechSession(None, client, messages.append, detector=WakeDetector(kws), vad_factory=Vad)
    try:
        session.feed(VOICE)
        session.future.result(timeout=1)
        for _ in range(60): session.feed(VOICE)
        for _ in range(40): session.feed(QUIET)
        deadline = time.monotonic() + 1
        while not client.uploads and time.monotonic() < deadline:
            session.tick(); time.sleep(.001)
        assert len(client.uploads) == 1
        for _ in range(100): session.feed(VOICE)
        assert kws.accept.call_count == 1
        client.release.set()
        deadline = time.monotonic() + 1
        while session.state != 'QUIET' and time.monotonic() < deadline:
            session.tick(); time.sleep(.001)
        for _ in range(40): session.feed(QUIET)
        assert session.state == 'ARMED'
    finally:
        client.release.set(); session.close()
    assert session.state == 'OFF' and not session.detector.ring


def test_session_stop_during_pending_grant_never_uploads():
    client = Client(); entered = threading.Event(); release = threading.Event()
    def reserve(identifier, revision):
        entered.set(); release.wait(2)
        return {'state': 'CAPTURING'}
    client.reserve = reserve
    session = SpeechSession(None, client, lambda value: None,
        detector=WakeDetector(SimpleNamespace(accept=lambda audio: True, reset=lambda: None)), vad_factory=Vad)
    try:
        session.feed(VOICE)
        assert entered.wait(1)
        session.close()
        release.set()
        deadline = time.monotonic() + 1
        while not client.cancelled and time.monotonic() < deadline: time.sleep(.001)
        assert client.cancelled and not client.uploads
    finally:
        release.set()
