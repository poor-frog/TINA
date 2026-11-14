"""Pinned WebRTC 0.3.1 NS Low. No AEC/HPF/AGC; exact source sample counts and delay compensation."""
import ctypes
from collections import deque

import numpy as np

FRAME = 160
# Measured impulse latency of the pinned 16 kHz NS-only library; guarded by the native test.
DELAY = 96
LIBRARY = '/opt/tina-voice/lib/libtina_ns.so'


class NativeNs:
    def __init__(self, library=LIBRARY):
        self.lib = ctypes.CDLL(str(library))
        self.lib.tina_ns_create.restype = ctypes.c_void_p
        self.lib.tina_ns_process.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_float), ctypes.POINTER(ctypes.c_float)]
        self.lib.tina_ns_destroy.argtypes = [ctypes.c_void_p]
        self.lib.tina_ns_flags.argtypes = [ctypes.c_void_p]
        self.state = self.lib.tina_ns_create()
        if not self.state: raise RuntimeError('NS initialization failed')
        if self.lib.tina_ns_flags(self.state) != 1:
            self.close(); raise RuntimeError('Unexpected NS processing configuration')

    def process(self, pcm):
        if not self.state or len(pcm) != FRAME: raise ValueError('NS needs 160 samples')
        pcm = np.ascontiguousarray(pcm, dtype=np.float32)
        out = np.empty(FRAME, dtype=np.float32)
        ptr = ctypes.POINTER(ctypes.c_float)
        if self.lib.tina_ns_process(self.state, pcm.ctypes.data_as(ptr), out.ctypes.data_as(ptr)) != 0 or not np.isfinite(out).all():
            raise RuntimeError('NS processing failed')
        return out

    def close(self):
        if self.state: self.lib.tina_ns_destroy(self.state); self.state = None


class NsStream:
    def __init__(self, emit, factory=NativeNs, delay=DELAY, frame_size=FRAME):
        self.frame_size=frame_size
        self.native, self.emit, self.skip = factory(), emit, delay
        self.raw = np.array([], dtype=np.float32)
        self.clean = np.array([], dtype=np.float32)
        self.frames = deque()
        self.received, self.processed, self.delay = 0, 0, delay

    def _process(self):
        chunks = []
        while len(self.raw) >= self.frame_size:
            out = self.native.process(self.raw[:self.frame_size]); self.raw = self.raw[self.frame_size:]
            self.processed += self.frame_size
            skip = min(self.skip, len(out)); self.skip -= skip
            chunks.append(out[skip:])
        if chunks: self.clean = np.concatenate([self.clean, *chunks])
        while self.frames and len(self.clean) >= self.frames[0][1]:
            seq, count = self.frames.popleft()
            self.emit(seq, self.clean[:count].copy()); self.clean = self.clean[count:]

    def feed(self, seq, pcm):
        pcm = np.asarray(pcm, dtype=np.float32)
        if pcm.ndim != 1 or not 0 < len(pcm) <= 16000 or not np.isfinite(pcm).all(): raise ValueError('Invalid NS audio')
        self.frames.append((seq, len(pcm))); self.received += len(pcm)
        self.raw = np.concatenate([self.raw, pcm]); self._process()

    def close(self):
        try:
            if self.frames:
                extra = max(0, self.received + self.delay - self.processed)
                pad = ((extra + self.frame_size - 1) // self.frame_size) * self.frame_size - len(self.raw)
                self.raw = np.pad(self.raw, (0, pad)); self._process()
                if self.frames: raise RuntimeError('NS tail not drained')
        finally:
            self.native.close()
