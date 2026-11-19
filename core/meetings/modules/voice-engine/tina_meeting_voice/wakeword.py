"""Bounded, local-only wake detector. Each input owns its own instance/state."""
from collections import deque
from dataclasses import dataclass, field
from queue import Full, Queue

import numpy as np

SAMPLE_RATE = 16000
BLOCK_SIZE = 320  # 20 ms


class CaptureQueue:
    """Native callbacks never wait for inference; overrun disarms the caller."""
    def __init__(self):
        self.blocks = Queue(maxsize=50)  # at most one second
        self.failed = False

    def push(self, samples, *, overflow=False):
        if overflow or self.failed:
            self.failed = True
            return False
        try:
            audio = np.asarray(samples, dtype=np.float32)
            if audio.ndim != 1 or not 0 < len(audio) <= BLOCK_SIZE:
                self.failed = True
                return False
            self.blocks.put_nowait(audio.copy())
            return True
        except Full:
            self.failed = True
            return False


class SherpaKws:
    def __init__(self, directory, *, spotter=None):
        if spotter is not None:
            self.spotter = spotter
        else:
            from .assets import verify
            verify(directory)
            import sherpa_onnx
            files = {name.split("-")[0]: str(directory / name) for name in (
                "encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                "decoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx",
                "joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx")}
            self.spotter = sherpa_onnx.KeywordSpotter(
                **files, tokens=str(directory / "tokens.txt"), keywords_file=str(directory / "keywords.txt"),
                sample_rate=SAMPLE_RATE, num_threads=1, provider="cpu", keywords_threshold=0.25)
        self.stream = self.spotter.create_stream()

    def accept(self, samples):
        self.stream.accept_waveform(SAMPLE_RATE, samples)
        detected = False
        while self.spotter.is_ready(self.stream):
            self.spotter.decode_stream(self.stream)
            if self.spotter.get_result(self.stream):
                detected = True
                self.spotter.reset_stream(self.stream)
        return detected

    def reset(self):
        # A new stream drops acoustic history across cooldown, gaps and Stop.
        self.stream = self.spotter.create_stream()


@dataclass
class WakeEvent:
    detected_sample: int
    buffer_start_sample: int
    pre_roll: np.ndarray = field(repr=False)

    def diagnostic(self):
        # Local CLI diagnostics only, not a shared/core event or dispatch contract.
        return {"event": "wake", "keyword": "HEY_TINA", "detected_sample": self.detected_sample,
                "detected_seconds": self.detected_sample / SAMPLE_RATE,
                "buffer_start_sample": self.buffer_start_sample}


class WakeDetector:
    def __init__(self, kws):
        self.kws = kws
        self.ring = deque(maxlen=100)  # <=2 seconds, no persisted audio
        self.samples = 0
        self.armed = True
        self.last_wake = 0
        self.quiet_samples = 0
        self.closed = False

    def feed(self, samples):
        if self.closed:
            raise ValueError("Detector is closed")
        audio = np.asarray(samples, dtype=np.float32)
        if audio.ndim != 1 or not 0 < len(audio) <= BLOCK_SIZE or not np.isfinite(audio).all():
            raise ValueError("Expected at most 320 finite mono float samples at 16 kHz")
        self.samples += len(audio)
        self.ring.append(audio.copy())
        if not self.armed:
            # Both a minimum 1.5 s cooldown AND 0.8 s continuous quiet are needed.
            # This energy gate only re-arms KWS; it never detects the wake phrase.
            self.quiet_samples = self.quiet_samples + len(audio) if np.sqrt(np.mean(audio ** 2)) < .01 else 0
            if self.samples - self.last_wake >= 24000 and self.quiet_samples >= 12800:
                self.kws.reset()
                self.armed = True
            return None
        if self.kws.accept(audio):
            self.armed = False
            self.last_wake = self.samples
            self.quiet_samples = 0
            retained = np.concatenate(self.ring)
            return WakeEvent(self.samples, self.samples - len(retained), retained)
        return None

    def close(self):
        self.closed = True
        self.armed = False
        self.ring.clear()
        self.kws.reset()
