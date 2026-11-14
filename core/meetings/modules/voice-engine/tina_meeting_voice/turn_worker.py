"""Isolated CPU shadow inference; no turn control, network, audio or text logging."""
import base64
import json
from pathlib import Path
import sys
import time
from uuid import UUID

import numpy as np

from .turn_assets import verify


class TurnModels:
    def __init__(self, directory):
        import onnxruntime as ort
        from tokenizers import Tokenizer
        from transformers import WhisperFeatureExtractor
        verify(directory)
        options = ort.SessionOptions()
        options.intra_op_num_threads = options.inter_op_num_threads = 1
        self.smart = ort.InferenceSession(str(directory/'smart-turn-v3.2-cpu.onnx'), options,
                                         providers=['CPUExecutionProvider'])
        self.namo = ort.InferenceSession(str(directory/'namo-multilingual.onnx'), options,
                                        providers=['CPUExecutionProvider'])
        self.tokenizer = Tokenizer.from_file(str(directory/'namo-tokenizer.json'))
        # Voice questions are <=20s; retain their final text if pathological tokenization exceeds this cap.
        self.tokenizer.enable_truncation(max_length=512, direction='left')
        self.extractor = WhisperFeatureExtractor(chunk_length=8)

    def predict(self, audio, text):
        started = time.monotonic()
        audio = np.pad(audio[-128000:], (max(0,128000-len(audio)),0))
        features = self.extractor(audio, sampling_rate=16000, return_tensors='np',
            padding='max_length', max_length=128000, truncation=True, do_normalize=True).input_features
        smart = float(np.asarray(self.smart.run(None, {'input_features':features.astype(np.float32)})[0]).item())
        smart_ms = round((time.monotonic()-started)*1000, 2)
        started = time.monotonic()
        encoded = self.tokenizer.encode(text)
        logits = np.asarray(self.namo.run(None, {'input_ids':np.array([encoded.ids],dtype=np.int64),
            'attention_mask':np.array([encoded.attention_mask],dtype=np.int64)})[0]).reshape(-1)
        if len(logits) != 2: raise ValueError('Unexpected turn model output')
        probs = np.exp(logits-logits.max()); namo = float(probs[1]/probs.sum())
        if not all(np.isfinite(p) and 0<=p<=1 for p in (smart,namo)):
            raise ValueError('Invalid turn model probability')
        return {'smart_probability':smart,'namo_probability':namo,
                'smart_ms':smart_ms,'namo_ms':round((time.monotonic()-started)*1000,2)}


def evaluate(models, message):
    if not isinstance(message, dict): raise ValueError('Invalid turn request')
    identifier = str(UUID(message['id']))
    text = message['text']
    if not isinstance(text,str) or not 1<=len(text)<=2000: raise ValueError('Invalid turn text')
    raw = base64.b64decode(message['audio'], validate=True)
    if not raw or len(raw)>512000 or len(raw)%4: raise ValueError('Invalid turn audio')
    audio = np.frombuffer(raw,dtype='<f4')
    if not np.isfinite(audio).all(): raise ValueError('Invalid turn samples')
    return {'event':'turn-result','id':identifier,**models.predict(audio,text)}


def main():
    models = TurnModels(Path(sys.argv[1]))
    print(json.dumps({'event':'turn-ready','mode':'shadow'}),flush=True)
    while line := sys.stdin.buffer.readline(720001):
        if len(line)>720000: raise ValueError('Turn request exceeds bound')
        result = evaluate(models,json.loads(line))
        print(json.dumps(result,separators=(',',':')),flush=True)


if __name__ == '__main__':
    try: main()
    except Exception:
        print('Turn shadow worker failed',file=sys.stderr)
        sys.exit(1)
