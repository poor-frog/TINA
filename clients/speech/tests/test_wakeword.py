"""Offline behavior proofs. Real model + synthetic audio are a separate smoke."""
import io
import json
import sys
import wave
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import numpy as np
import pytest

from tina_meeting_voice.assets import install, verify
from tina_speech.cli import main, wav_blocks
from tina_meeting_voice.wakeword import BLOCK_SIZE, CaptureQueue, WakeDetector

QUIET = np.zeros(BLOCK_SIZE, dtype=np.float32)
SPEECH = np.ones(BLOCK_SIZE, dtype=np.float32) * .1


class FakeKws:
    def __init__(self, trigger=False):
        self.trigger = trigger
        self.calls = 0
        self.resets = 0

    def accept(self, audio):
        self.calls += 1
        return self.trigger

    def reset(self):
        self.resets += 1


def test_no_keyword_never_emits_and_buffer_stays_bounded():
    detector = WakeDetector(FakeKws())
    for _ in range(2000):
        assert detector.feed(SPEECH) is None
    assert sum(map(len, detector.ring)) <= 32000


def test_one_wake_per_utterance_requires_both_cooldown_and_quiet():
    kws = FakeKws(trigger=True)
    detector = WakeDetector(kws)
    first = detector.feed(SPEECH)
    assert first is not None
    # Continued speech cannot re-arm, even beyond the minimum cooldown.
    for _ in range(200):
        assert detector.feed(SPEECH) is None
    assert kws.calls == 1
    for _ in range(39):
        assert detector.feed(QUIET) is None
    assert not detector.armed
    assert detector.feed(QUIET) is None
    assert detector.armed
    assert detector.feed(SPEECH) is not None
    assert kws.resets == 1


def test_short_quiet_does_not_skip_minimum_cooldown():
    detector = WakeDetector(FakeKws(trigger=True))
    detector.feed(SPEECH)
    for _ in range(40):
        assert detector.feed(QUIET) is None
    assert not detector.armed
    for _ in range(35):
        assert detector.feed(QUIET) is None
    assert detector.armed


def test_pre_roll_preserves_audio_through_detection_and_diagnostics_omit_audio():
    kws = FakeKws()
    detector = WakeDetector(kws)
    for _ in range(120):
        detector.feed(QUIET)
    kws.trigger = True
    event = detector.feed(SPEECH)
    assert len(event.pre_roll) == 32000
    assert event.buffer_start_sample == event.detected_sample - 32000
    np.testing.assert_array_equal(event.pre_roll[-BLOCK_SIZE:], SPEECH)
    assert "pre_roll" not in json.dumps(event.diagnostic())
    assert "array" not in repr(event)


def test_detector_state_is_private_to_each_microphone_and_stop_clears_audio():
    a, b = WakeDetector(FakeKws(trigger=True)), WakeDetector(FakeKws(trigger=True))
    assert a.feed(SPEECH) is not None
    assert b.armed
    assert b.feed(SPEECH) is not None
    a.close()
    assert not a.ring and not a.armed
    with pytest.raises(ValueError, match="closed"):
        a.feed(QUIET)


@pytest.mark.parametrize("audio", [np.array([]), np.zeros(321), np.zeros((2, 320)), np.array([float("nan")])])
def test_bad_frames_fail_before_native_inference(audio):
    kws = FakeKws()
    with pytest.raises(ValueError):
        WakeDetector(kws).feed(audio)
    assert kws.calls == 0


def test_callback_queue_is_nonblocking_bounded_and_fails_closed():
    capture = CaptureQueue()
    block = SPEECH.copy()
    assert capture.push(block)
    block[:] = 0
    np.testing.assert_array_equal(capture.blocks.get_nowait(), SPEECH)
    for _ in range(50):
        assert capture.push(SPEECH)
    assert not capture.push(SPEECH)
    assert capture.failed and capture.blocks.qsize() == 50
    assert not capture.push(QUIET)
    for bad in (np.zeros(321), np.zeros((320, 2))):
        assert not CaptureQueue().push(bad)
    assert not CaptureQueue().push(QUIET, overflow=True)


def write_wav(path, *, channels=1, rate=16000, width=2):
    with wave.open(str(path), "wb") as out:
        out.setnchannels(channels)
        out.setsampwidth(width)
        out.setframerate(rate)
        out.writeframes(b"\0" * channels * width * 800)


@pytest.mark.parametrize("settings", [{"channels": 2}, {"rate": 48000}, {"width": 1}])
def test_wav_format_must_match_normalized_input(tmp_path, settings):
    path = tmp_path / "bad.wav"
    write_wav(path, **settings)
    with pytest.raises(ValueError, match="mono PCM16"):
        list(wav_blocks(path))


def test_file_mode_is_local_only_and_closes_detector(tmp_path, capsys):
    path = tmp_path / "silence.wav"
    write_wav(path)
    kws = FakeKws()
    with patch("tina_speech.cli.SherpaKws", return_value=kws), patch(
        "urllib.request.urlopen", side_effect=AssertionError("Network forbidden during detection")
    ):
        assert main(["file", str(path)]) == 0
    output = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert len(output) == 1 and output[0]["detections"] == 0
    assert kws.resets == 1


def test_operator_stop_closes_detector_without_dispatch(capsys):
    kws = FakeKws()
    with patch("tina_speech.cli.SherpaKws", return_value=kws), patch(
        "tina_speech.cli.listen", side_effect=KeyboardInterrupt
    ):
        assert main(["listen", "--device", "1"]) == 0
    assert json.loads(capsys.readouterr().out) == {"event": "stopped", "reason": "operator"}
    assert kws.resets == 1


def test_capture_failure_disarms_and_returns_nonzero(capsys):
    kws = FakeKws()
    with patch("tina_speech.cli.SherpaKws", return_value=kws), patch(
        "tina_speech.cli.listen", side_effect=ValueError("Microphone overflow")
    ):
        assert main(["listen", "--device", "1"]) == 1
    output = capsys.readouterr()
    assert not output.out and "overflow" in output.err
    assert kws.resets == 1


def test_inactive_microphone_does_not_wait_forever(capsys):
    kws = FakeKws()
    sounddevice = SimpleNamespace(check_input_settings=Mock(), InputStream=MagicMock())
    sounddevice.InputStream.return_value.__enter__.return_value.active = False
    with patch("tina_speech.cli.SherpaKws", return_value=kws), patch.dict(
        sys.modules, {"sounddevice": sounddevice}
    ):
        assert main(["listen", "--device", "1"]) == 1
    assert "stream stopped" in capsys.readouterr().err
    assert kws.resets == 1


def test_setup_rejects_archive_digest_before_extraction(tmp_path):
    data = {"url": "https://example.test/model", "archive_bytes": 3, "archive_sha256": "bad"}
    with patch("tina_meeting_voice.assets.manifest", return_value=data), patch(
        "urllib.request.urlopen", return_value=io.BytesIO(b"abc")
    ), pytest.raises(ValueError, match="checksum"):
        install(tmp_path)
    assert not list(tmp_path.iterdir())


def test_missing_or_modified_asset_is_not_loaded(tmp_path):
    with patch("tina_meeting_voice.assets.manifest", return_value={"files": {"model.onnx": "pinned"}}):
        with pytest.raises(ValueError, match="Missing or modified"):
            verify(tmp_path)
        (tmp_path / "model.onnx").write_bytes(b"tampered")
        with pytest.raises(ValueError, match="Missing or modified"):
            verify(tmp_path)
