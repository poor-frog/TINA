import io
import unittest
from unittest.mock import patch
import wave

import numpy as np
from capture_frames import replay, wav_bytes


class FramesTests(unittest.TestCase):
    def test_encoded_replay_preserves_samples_and_reports_delivery_not_source_end(self):
        class Monitor:
            def __init__(self, directory, emit, clock): self.emit = emit
            def feed(self, channel, participant, pcm, stamp):
                self.emit({'event': 'activity', 'speech': False, 'endMs': stamp})
            def close(self): pass
        pcm = np.linspace(-.1, .1, 16384, dtype=np.float32)
        with patch('capture_frames.VadMonitor', Monitor):
            a, b = replay(pcm, 4096, None), replay(pcm, 1024, None)
        self.assertEqual(a['pcm_sha256'], b['pcm_sha256'])
        self.assertEqual(b['frames'], 4 * a['frames'])
        self.assertEqual(a['endpoints'][0]['received_ms'] - b['endpoints'][0]['received_ms'], 192)
        self.assertEqual(a['endpoints'][0]['speech_end_ms'], b['endpoints'][0]['speech_end_ms'])

    def test_asr_wav_matches_production_signed_scale_and_rounding(self):
        with wave.open(io.BytesIO(wav_bytes(np.array([-1, -.5, 0, .5, 1], dtype=np.float32)))) as wav:
            self.assertEqual(wav.getframerate(), 16000)
            self.assertEqual(np.frombuffer(wav.readframes(5), dtype='<i2').tolist(), [-32768, -16384, 0, 16384, 32767])
