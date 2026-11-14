"""One KWS model per bot; channel-local streams, one bounded question per room."""
import base64
import json
import math
import os
import select
import sys
import time
from pathlib import Path

import numpy as np

from .assets import default_directory, install, install_vad, verify_vad
from .capture import QuestionCapture, SileroVad
from .wakeword import SherpaKws, WakeDetector, BLOCK_SIZE


class BotVoice:
    def __init__(self, detector_factory, vad_factory, emit, clock=time.monotonic):
        self.detector_factory, self.vad_factory = detector_factory, vad_factory
        self.emit, self.clock = emit, clock
        self.channels = {}
        self.state = 'LISTENING'
        self.capture = None
        self.speaker = None
        self.capture_started = None
        self.last_loud = clock()
        self.closed = False
        self.change('LISTENING')

    def change(self, state):
        self.state = state
        self.emit({'event': 'state', 'state': state})

    def clear(self):
        for row in self.channels.values():
            row['detector'].close()
        self.channels.clear()
        self.capture = None
        self.speaker = None

    def control(self, state):
        if self.closed or state not in ('THINKING', 'SPEAKING', 'QUIET', 'ERROR'):
            return
        self.clear()
        self.last_loud = self.clock()
        self.change(state)

    def tick(self):
        if self.state == 'CAPTURING' and self.capture_started is not None:
            limit = 20 if self.capture.started else 5
            if self.clock() - self.capture_started >= limit:
                self.emit({'event': 'discarded', 'reason': 'question_timeout'})
                self.control('QUIET')

    def feed(self, channel, participant, audio, stamp):
        self.tick()
        if self.closed or self.state in ('THINKING', 'SPEAKING', 'ERROR'):
            return
        if (not isinstance(channel, int) or isinstance(channel, bool) or not 0 <= channel < 65536
                or not isinstance(stamp, (int, float)) or not math.isfinite(stamp)):
            raise ValueError('Invalid capture identity/clock')
        samples = np.asarray(audio, dtype=np.float32)
        if samples.ndim != 1 or not 0 < len(samples) <= 16000 or not np.isfinite(samples).all():
            raise ValueError('Invalid PCM frame')
        now = self.clock()
        loud = float(np.sqrt(np.mean(samples ** 2))) >= .01
        if self.state == 'QUIET':
            if loud:
                self.last_loud = now
            elif now - self.last_loud >= .8:
                self.clear()
                self.change('LISTENING')
            return
        for key, row in list(self.channels.items()):
            if now - row['seen'] > 20 and key != self.speaker:
                row['detector'].close()
                del self.channels[key]
        row = self.channels.get(channel)
        if row and (row['participant'] != participant or stamp < row['stamp'] or stamp - row['stamp'] > 1000):
            row['detector'].close()
            del self.channels[channel]
            row = None
            if self.speaker == channel:
                self.control('QUIET')
                return
        if row is None:
            if len(self.channels) >= 32:
                return
            row = {'detector': self.detector_factory(), 'participant': participant, 'loud': -math.inf}
            self.channels[channel] = row
        row.update(seen=now, stamp=stamp)
        if loud:
            row['loud'] = now
        if self.state == 'CAPTURING' and channel != self.speaker:
            if loud:
                self.emit({'event': 'discarded', 'reason': 'overlapping_channels'})
                self.control('QUIET')
            return
        for offset in range(0, len(samples), BLOCK_SIZE):
            block = samples[offset:offset + BLOCK_SIZE]
            if self.state == 'LISTENING':
                wake = row['detector'].feed(block)
                if wake:
                    if any(key != channel and now - item['loud'] < .25 for key, item in self.channels.items()):
                        self.emit({'event': 'discarded', 'reason': 'ambiguous_wake'})
                        self.control('QUIET')
                        return
                    self.speaker = channel
                    self.capture_started = now
                    self.capture = QuestionCapture(wake, self.vad_factory())
                    self.change('CAPTURING')
            elif self.state == 'CAPTURING':
                try:
                    wav = self.capture.feed(block)
                except ValueError:
                    self.emit({'event': 'discarded', 'reason': 'question_timeout'})
                    self.control('QUIET')
                    return
                if wav:
                    self.control('THINKING')
                    self.emit({'event': 'question', 'audio': base64.b64encode(wav).decode('ascii')})
                    return

    def close(self):
        self.clear()
        self.closed = True


def main():
    directory = Path(sys.argv[1]) if len(sys.argv) > 1 else default_directory()
    if '--setup' in sys.argv:
        if '--vad-only' in sys.argv:
            directory.mkdir(parents=True, exist_ok=True)
            try: verify_vad(directory)
            except ValueError: install_vad(directory)
            # Public model weights are shared read-only with the non-root LiveKit observer.
            verify_vad(directory).chmod(0o644)
            from .turn_assets import install as install_turn_models
            install_turn_models(directory/'turn-models')
        else:
            install(directory)
        return
    generation = 0
    def emit(event):
        event = dict(event, generation=generation)
        print(json.dumps(event, separators=(',', ':')), flush=True)
    kws_only = '--kws' in sys.argv
    if kws_only:
        from .kws_shadow import KwsMonitor
        engine = KwsMonitor(directory, emit)
    elif '--vad-only' in sys.argv:
        from .vad_monitor import VadMonitor
        engine = VadMonitor(directory, emit, time.monotonic)
    else:
        loaded = SherpaKws(directory)
        def detector():
            return WakeDetector(SherpaKws(directory, spotter=loaded.spotter))
        vad = SileroVad(directory)
        def fresh_vad():
            vad.vad.reset()
            vad.pending = np.array([], dtype=np.float32)
            return vad
        engine = BotVoice(detector, fresh_vad, emit)
    pending = bytearray()
    try:
        while True:
            engine.tick()
            ready, _, _ = select.select([sys.stdin.buffer], [], [], .1)
            if not ready:
                continue
            chunk = os.read(sys.stdin.fileno(), 65536)
            if not chunk:
                break
            pending.extend(chunk)
            while b'\n' in pending:
                line, _, tail = pending.partition(b'\n')
                pending = bytearray(tail)
                if len(line) >= 100000:
                    raise ValueError('IPC frame exceeds bound')
                message = json.loads(line)
                if message.get('type') == 'control':
                    generation = message.get('generation', generation)
                    engine.control(message.get('state'))
                elif message.get('type') == 'audio':
                    raw = base64.b64decode(message['audio'], validate=True)
                    args = (message['channel'], message.get('participant'), np.frombuffer(raw, dtype='<f4'), message['stamp'])
                    if kws_only:
                        engine.feed(*args, start_sample=message.get('start_sample'))
                    else:
                        engine.feed(*args)
                else:
                    raise ValueError('Unknown IPC message')
            if len(pending) >= 100000:
                raise ValueError('IPC frame exceeds bound')
    finally:
        engine.close()


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('Meeting voice engine failed', file=sys.stderr)
        sys.exit(1)
