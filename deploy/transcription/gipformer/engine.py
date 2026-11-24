"""Gipformer decodes each FSMN speech interval on its original sample clock."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from asr_audio import RATE, read_audio, speech_ranges, verify_assets

MODEL = 'g-group-ai-lab/gipformer1.5-68M-rnnt'


class GipformerEngine:
    def __init__(self, vad, recognizer):
        self.vad, self.recognizer = vad, recognizer

    @classmethod
    def load(cls, directory):
        import torch
        import sherpa_onnx
        from funasr import AutoModel

        directory = Path(directory)
        manifest = json.loads((HERE / 'model-assets.json').read_text())
        verify_assets(directory, manifest['files'])
        vad = json.loads((HERE.parent / 'fsmn-assets.json').read_text())
        verify_assets(directory / 'fsmn-vad', vad['files'])
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        vad = AutoModel(model=str(directory / 'fsmn-vad'), device='cpu', disable_update=True,
                        disable_pbar=True, disable_log=True)
        recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=str(directory / 'encoder.int8.onnx'), decoder=str(directory / 'decoder.int8.onnx'),
            joiner=str(directory / 'joiner.int8.onnx'), tokens=str(directory / 'tokens.txt'),
            num_threads=2, sample_rate=RATE, feature_dim=80, decoding_method='greedy_search', provider='cpu',
        )
        return cls(vad, recognizer)

    def transcribe(self, content, silence_ms=800):
        pcm, duration = read_audio(content)
        if not np.any(pcm):
            return {'text': '', 'duration': duration, 'segments': []}
        # Match the existing FSMN wrapper's minimum analysis frame, without changing source time.
        temporary = np.pad(pcm, (0, max(0, 3200 - len(pcm))))
        result = self.vad.generate(input=temporary, cache={}, is_final=True, fs=RATE,
                                   max_end_silence_time=silence_ms, disable_pbar=True)
        segments = []
        for start, end in speech_ranges(result, len(pcm)):
            stream = self.recognizer.create_stream()
            stream.accept_waveform(RATE, pcm[start:end])
            self.recognizer.decode_streams([stream])
            text = stream.result.text.strip()
            if not text:
                continue
            if len(text) > 10000:
                raise ValueError('ASR output exceeds limit')
            segments.append({'start': start / RATE, 'end': min(duration, end / RATE), 'text': text})
        text = ' '.join(s['text'] for s in segments)
        if len(text) > 100000:
            raise RuntimeError('ASR response exceeds limit')
        return {'text': text, 'duration': duration, 'segments': segments}
