"""Per-channel VAD activity for ASR voice turns; no keyword model or second ASR call."""
import math
from collections import deque
import numpy as np
from .capture import SileroVad


class VadMonitor:
    def __init__(self, directory, emit, clock, factory=None):
        self.directory, self.emit, self.clock = directory, emit, clock
        self.factory = factory or (lambda: SileroVad(directory))
        self.channels = {}
        self.state = 'LISTENING'
        self.last_loud = clock()
        # Check model readiness once before announcing LISTENING.
        self.spare = self.factory()
        emit({'event': 'state', 'state': self.state})

    def tick(self):
        pass  # Rearm requires actual received quiet frames, never a disconnected source.

    def control(self, state):
        if state not in ('THINKING', 'SPEAKING', 'QUIET', 'ERROR'):
            return
        self.state = state
        self.channels.clear()
        self.last_loud = self.clock()
        self.emit({'event': 'state', 'state': state})

    def feed(self, channel, participant, audio, stamp):
        if self.state == 'ERROR':
            return
        samples = np.asarray(audio, dtype=np.float32)
        if (not isinstance(channel, int) or isinstance(channel, bool) or not 0 <= channel < 65536
                or not isinstance(stamp, (int, float)) or not math.isfinite(stamp)
                or samples.ndim != 1 or not 0 < len(samples) <= 16000 or not np.isfinite(samples).all()):
            raise ValueError('Invalid VAD frame')
        now = self.clock()
        if self.state == 'QUIET':
            if float(np.sqrt(np.mean(samples ** 2))) >= .01:
                self.last_loud = now
            elif now - self.last_loud >= .8:
                self.state = 'LISTENING'
                self.emit({'event': 'state', 'state': self.state})
            # Continue tracking endpoints while wake acceptance stays gated by room quiet.
        for key, row in list(self.channels.items()):
            if now - row['seen'] > 20:
                del self.channels[key]
        row = self.channels.get(channel)
        if row and (stamp < row['stamp'] or stamp - row['stamp'] > 1000
                    or (participant and row['participant'] and participant != row['participant'])):
            del self.channels[channel]
            row = None
        if row is None:
            if len(self.channels) >= 32:
                return
            vad, self.spare = self.spare, None
            row = {'vad': vad or self.factory(), 'active': False, 'last_speech': None, 'samples': 0, 'frames': deque(maxlen=2000), 'reported': -math.inf}
            self.channels[channel] = row
        row.update(stamp=stamp, participant=participant, seen=now)
        row['frames'].append((row['samples'], len(samples), stamp))
        row['samples'] += len(samples)
        active, ended = row['vad'].feed(samples)
        boundary = getattr(row['vad'], 'last_end_sample', None)
        if ended and boundary is not None:
            for start, length, capture in row['frames']:
                if start <= boundary <= start + length:
                    row['last_speech'] = capture + (boundary - start) / 16
                    break
        if active:
            row['last_speech'] = stamp + len(samples) / 16
        if active != row['active'] or ended or (active and now - row['reported'] >= 1):
            row['active'] = active
            row['reported'] = now
            self.emit({'event': 'activity', 'channel': channel, 'speech': active,
                       'endMs': row['last_speech'], 'stamp': stamp + len(samples) / 16})

    def close(self):
        self.channels.clear()
        self.spare = None
