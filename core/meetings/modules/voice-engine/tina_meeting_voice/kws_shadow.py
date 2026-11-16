"""Pinned local ONNX streaming detection; the bot controller owns turn dispatch."""
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np


def manifest():
    return json.loads(Path(__file__).with_name('livekit-models.json').read_text())


def verify(directory):
    for name, row in manifest()['models'].items():
        path = directory / (name + '.onnx')
        digest = hashlib.sha256()
        with path.open('rb') as source:
            while block := source.read(1024 * 1024):
                digest.update(block)
        if path.stat().st_size != row['bytes'] or digest.hexdigest() != row['sha256']:
            raise ValueError('Local wake model checksum mismatch')


def load_stream_factory(directory):
    verify(directory)
    from onnxruntime import InferenceSession, SessionOptions
    # Private streaming state is used only with the pinned LiveKit 2.1.1 runtime.
    from livekit.wakeword.model import _Stream, session_options
    options = SessionOptions()
    options.intra_op_num_threads = options.inter_op_num_threads = 1
    sessions = {name: InferenceSession(str(directory / (name + '.onnx')),
                sess_options=session_options(options), providers=['CPUExecutionProvider'])
                for name in manifest()['models']}
    return lambda: {name: _Stream(session) for name, session in sessions.items()}


class KwsMonitor:
    def __init__(self, directory, emit, clock=time.monotonic):
        self.emit, self.clock = emit, clock
        self.channels = {}
        self.health = {}
        self.state = 'LISTENING'
        self.closed = False
        self.factory = load_stream_factory(directory)
        # Warm and validate all models before readiness; reuse the first stream set.
        self.spare = self.factory()
        emit({'event': 'kws', 'status': 'ready', 'models': list(manifest()['models'])})

    def tick(self):
        now = self.clock()
        for channel, row in list(self.channels.items()):
            if now - row['seen'] > 20:
                del self.channels[channel]
                self.health.pop(channel, None)

    def control(self, state):
        if state not in ('LISTENING', 'CAPTURING', 'THINKING', 'SPEAKING', 'QUIET', 'ERROR', 'OFF'):
            return
        if state not in ('LISTENING',) or self.state not in ('LISTENING',):
            self.channels.clear()
            self.health.clear()
        self.state = state

    def feed(self, channel, participant, audio, stamp, start_sample=None):
        if self.closed or self.state not in ('LISTENING',):
            return
        samples = np.asarray(audio, dtype=np.float32)
        if (not isinstance(channel, int) or isinstance(channel, bool) or not 0 <= channel < 65536
                or not isinstance(stamp, (int, float)) or isinstance(stamp, bool) or not math.isfinite(stamp)
                or samples.ndim != 1 or not 0 < len(samples) <= 16000 or not np.isfinite(samples).all()
                or start_sample is not None and (not isinstance(start_sample, int)
                    or isinstance(start_sample, bool) or start_sample < 0)):
            raise ValueError('Invalid shadow PCM frame')
        started = self.clock()
        self.tick()
        row = self.channels.get(channel)
        reset = None
        identity_changed = row and row['participant'] is not None and participant is not None and row['participant'] != participant
        if row and (identity_changed or stamp < row['stamp'] or stamp - row['stamp'] > 1000
                    or start_sample is not None and row['next_sample'] is not None and start_sample != row['next_sample']):
            reset = 'identity' if identity_changed else 'source'
            del self.channels[channel]
            row = None
        if row is None:
            if len(self.channels) >= 32:
                return
            streams, self.spare = self.spare, None
            row = {'streams': streams if streams is not None else self.factory(), 'last_wake': {}, 'participant': None}
            self.channels[channel] = row
        health = self.health.setdefault(channel, {'frames': 0, 'identity_resets': 0, 'source_resets': 0,
                                                  'peaks': {}, 'reported': started})
        health['frames'] += 1
        if reset: health[reset + '_resets'] += 1
        row.setdefault('start_ms', stamp)
        # Meet's glow metadata can disappear within a word; only a conflicting known ID changes identity.
        row.update(participant=participant if participant is not None else row['participant'], stamp=stamp, seen=started,
                   next_sample=None if start_sample is None else start_sample + len(samples))
        if participant is not None:
            row['identified_ms'] = stamp
        # LiveKit keeps a bounded remainder, assembling unchanged 64 ms packets into 80 ms steps.
        for name, stream in row['streams'].items():
            score = stream.feed(samples)
            health['peaks'][name] = max(health['peaks'].get(name, 0), score)
            if not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError('Invalid shadow score')
            if score >= .5 and started - row['last_wake'].get(name, -math.inf) >= 1.5:
                row['last_wake'][name] = started
                self.emit({'event': 'kws', 'status': 'wake', 'model': name, 'channel': channel,
                           'score': round(score, 6), 'source_frame_end_ms': stamp + len(samples) / 16,
                           'source_start_ms': max(row['start_ms'], stamp + len(samples) / 16 - 2000),
                           'participant': row['participant'] if stamp - row.get('identified_ms', -math.inf) <= 1500 else None,
                           'processing_ms': round((self.clock() - started) * 1000, 3)})
        if started - health['reported'] >= 3:
            self.emit({'event': 'kws', 'status': 'metrics', 'channel': channel,
                       'frames': health['frames'], 'identity_resets': health['identity_resets'],
                       'source_resets': health['source_resets'], 'peak_scores': health['peaks'],
                       'source_frame_end_ms': stamp + len(samples) / 16})
            health['reported'] = started
            health['peaks'] = {}

    def close(self):
        self.closed = True
        self.channels.clear()
        self.health.clear()
        self.spare = self.factory = None
