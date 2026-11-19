"""Paired local VieGem decoder sweep; acoustic inference/VAD identical across weights.

Input: private JSON rows {id,path,kind,reference?}. Real meeting rows remain unlabeled;
only explicitly synthetic controls with known text are treated as labeled negatives.
No audio or hypothesis text is printed or written to the public summary.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'deploy/transcription/viegem'))
from engine import VieGemEngine, name_biased_decoder
from gipformer.engine import read_audio, speech_ranges, RATE


def wake(text):
    return bool(re.match(r'^(?:tina|ti\s+na)(?:\s+ơi)?(?=$|[^\w])', text.strip().casefold()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    os.environ['TINA_VIEGEM_NAME_BIAS'] = '0'
    os.environ['TINA_VIEGEM_CUSTOM_WEIGHT'] = '0'
    rows = json.loads(args.manifest.read_text())
    if not isinstance(rows, list) or not 1 <= len(rows) <= 32:
        raise ValueError('Use a bounded manifest of 1-32 clips')
    directory = ROOT / 'deploy/transcription/models/viegem-fsmn'
    engine = VieGemEngine.load(directory)
    weights = [0, .25, .5, 1.0]
    decoders = {str(w): name_biased_decoder(engine.lm, w) for w in weights}
    results = []
    for row in rows:
        path = Path(row['path'])
        content = path.read_bytes()
        pcm, duration = read_audio(content)
        if duration > 12:
            raise ValueError('Each test clip must be at most 12 seconds')
        started = time.perf_counter()
        ranges = engine.vad.generate(input=np.pad(pcm, (0, max(0, 3200-len(pcm)))), cache={},
            is_final=True, fs=RATE, max_end_silence_time=800, disable_pbar=True)
        probabilities = [engine.probabilities(pcm[a:b]) for a,b in speech_ranges(ranges,len(pcm))] if np.any(pcm) else []
        acoustic_seconds = time.perf_counter()-started
        variants = {}
        for label, decoder in decoders.items():
            started = time.perf_counter()
            text = ' '.join(engine.decode_probabilities(probs, decoder).strip() for probs in probabilities).strip()
            variants[label] = {'wake':wake(text), 'decoder_seconds':time.perf_counter()-started,
                               'approved_alias_prefix': bool(re.match(r'^(?:tina(?:\s+ơi)?|ti na ơi|tiên na ơi|tinh anh ơi)(?=$|[^\w])', text.strip().casefold())),
                               'matches_baseline':None, 'text_hash':hashlib.sha256(text.encode()).hexdigest()}
            if label == '0': baseline=text
            variants[label]['matches_baseline'] = text == baseline
        results.append({'id':row['id'],'kind':row['kind'],'audio_sha256':hashlib.sha256(content).hexdigest(),
                        'duration_s':duration,'acoustic_seconds':acoustic_seconds,'variants':variants})
        print(json.dumps({'event':'clip_complete','index':len(results),'total':len(rows)}),flush=True)
    summary = {'device':engine.device,'vad':'FSMN-VAD','alpha':.35,'beta':1.5,'beam_width':32,
               'same_acoustic_probabilities':True,'human_labeled_positive_audio':False,'weights':{}}
    for label in decoders:
        group={}
        for kind in sorted({r['kind'] for r in results}):
            subset=[r for r in results if r['kind']==kind]
            group[kind]={'clips':len(subset),'name_prefixes':sum(r['variants'][label]['wake'] for r in subset),
                         'approved_alias_prefixes':sum(r['variants'][label]['approved_alias_prefix'] for r in subset),
                         'changed_from_baseline':sum(not r['variants'][label]['matches_baseline'] for r in subset)}
        summary['weights'][label]=group
    summary['selection']='Do not enable globally from unlabeled real candidates; review human positive/negative audio first.'
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps({'summary':summary,'clips':results},ensure_ascii=False,indent=2)+'\n')
    args.output.chmod(0o600)
    print(json.dumps(summary,ensure_ascii=False))


if __name__ == '__main__': main()
