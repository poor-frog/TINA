"""Paired 64/256 ms capture replay: native VAD, sample integrity and optional local ASR.

Manifest rows contain private path/id/kind. The report never stores text, audio or source paths.
CPU covers replay/IPC encoding/native VAD, not browser scheduling or end-to-end meeting CPU.
"""
import argparse
import base64
import hashlib
import io
import json
import math
from pathlib import Path
import re
import statistics
import sys
import time
import wave

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'core/meetings/modules/voice-engine'))
from tina_meeting_voice.vad_monitor import VadMonitor


def replay(pcm, block, directory):
    now, events = [0.0], []
    monitor = VadMonitor(directory, events.append, lambda: now[0])
    events.clear()
    start = time.process_time()
    restored, ends, activity = [], [], []
    for offset in range(0, len(pcm), block):
        frame = pcm[offset:offset + block]
        # Exercise the bot's encoded native IPC representation, without launching a meeting.
        wire = json.loads(json.dumps({'audio': base64.b64encode(frame.tobytes()).decode()}))
        frame = np.frombuffer(base64.b64decode(wire['audio']), dtype='<f4')
        restored.append(frame)
        now[0] = (offset + len(frame)) / 16000
        monitor.feed(0, None, frame, offset / 16)
        for event in events:
            if event.get('event') == 'activity':
                if event['speech']: activity.append(now[0] * 1000)
                elif event.get('endMs') is not None:
                    ends.append({'received_ms': now[0] * 1000, 'speech_end_ms': event['endMs'],
                                 'dispatch_samples': offset + len(frame)})
        events.clear()
    cpu_ms = (time.process_time() - start) * 1000
    monitor.close()
    restored = np.concatenate(restored)
    assert np.array_equal(restored, pcm), 'PCM samples changed, disappeared or duplicated'
    return {'frames': len(restored) // block, 'missing_samples': 0, 'duplicated_samples': 0,
            'cpu_ms': cpu_ms, 'first_activity_ms': activity[0] if activity else None,
            'endpoints': ends, 'pcm_sha256': hashlib.sha256(restored.tobytes()).hexdigest()}


def wav_bytes(pcm):
    audio = io.BytesIO()
    with wave.open(audio, 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        values = np.clip(pcm.astype(np.float64), -1, 1)
        # Match TranscriptionClient's asymmetric PCM16 scale and JavaScript Math.round.
        wav.writeframes(np.floor(values * np.where(values < 0, 32768, 32767) + .5).astype('<i2').tobytes())
    return audio.getvalue()


def asr(pcm, engine):
    audio = wav_bytes(pcm)
    start = time.perf_counter()
    result = engine.transcribe(audio)
    text = result['text'].strip()
    return {'request_ms': (time.perf_counter() - start) * 1000,
            'text_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'name_prefix': bool(re.match(r'^(?:tina(?:\s+ơi)?|ti na ơi|tiên na ơi|tinh anh ơi)(?=$|[^\w])', text.casefold()))}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--vad-directory', type=Path, required=True)
    parser.add_argument('--asr-engine', choices=['viegem', 'gipformer'])
    args = parser.parse_args()
    rows = json.loads(args.manifest.read_text())
    if not isinstance(rows, list) or not 1 <= len(rows) <= 32: raise ValueError('Use 1–32 clips')
    engine = None
    if args.asr_engine:
        sys.path.insert(0, str(ROOT / 'deploy/transcription'))
        if args.asr_engine == 'viegem':
            from viegem.engine import VieGemEngine
            engine = VieGemEngine.load(ROOT / 'deploy/transcription/models/viegem-fsmn')
        else:
            from gipformer.engine import GipformerEngine
            engine = GipformerEngine.load(ROOT / 'deploy/transcription/models/gipformer-fsmn')
    results = []
    # Warm the native runtime before measured passes. Each pass still gets independent VAD state.
    replay(np.zeros(16384, dtype=np.float32), 1024, args.vad_directory)
    for index, row in enumerate(rows):
        original, rate = sf.read(row['path'], dtype='float32', always_2d=True)
        if rate != 16000 or original.shape[1] != 1 or not 0 < len(original) <= 12 * rate: raise ValueError('Use mono 16 kHz clips up to 12 seconds')
        pcm = original[:, 0]
        if not np.isfinite(pcm).all(): raise ValueError('Invalid samples')
        pcm = np.pad(pcm, (0, math.ceil((len(pcm) + 24000) / 4096) * 4096 - len(pcm)))
        variants = {}
        for block in ([4096, 1024] if index % 2 == 0 else [1024, 4096]):
            runs = [replay(pcm, block, args.vad_directory) for _ in range(3)]
            assert all(r['endpoints'] == runs[0]['endpoints'] for r in runs)
            value = runs[0] | {'cpu_ms': statistics.median(r['cpu_ms'] for r in runs)}
            value['cpu_realtime_percent'] = value['cpu_ms'] / (len(pcm) / 16000 * 1000) * 100
            if engine is not None and value['endpoints']:
                cut = value['endpoints'][0]['dispatch_samples']
                value['asr'] = asr(pcm[:cut], engine)
            variants[str(block)] = value
        assert variants['4096']['pcm_sha256'] == variants['1024']['pcm_sha256']
        results.append({'clip': index, 'kind': row.get('kind', 'unlabeled'), 'input_sha256': hashlib.sha256(original.tobytes()).hexdigest(),
                        'original_samples': len(original), 'replayed_samples': len(pcm), 'variants': variants})
        print(json.dumps({'completed_clips': index + 1, 'total_clips': len(rows)}), flush=True)
    paired = [r for r in results if all(r['variants'][b]['endpoints'] for b in ['4096', '1024'])]
    gains = [r['variants']['4096']['endpoints'][0]['received_ms'] - r['variants']['1024']['endpoints'][0]['received_ms'] for r in paired]
    summary = {'clips': len(results), 'paired_endpoints': len(paired), 'endpoint_arrival_gain_ms_median': statistics.median(gains) if gains else None,
               'endpoint_arrival_gain_ms_min': min(gains) if gains else None,
               'endpoint_arrival_gain_ms_max': max(gains) if gains else None,
               'missing_or_duplicated_samples': 0, 'web_audio_or_real_meeting_tested': False,
               'accuracy_ground_truth_available': False, 'asr_endpoint_tested': False, 'asr_engine': args.asr_engine}
    for block in ['4096', '1024']:
        summary[block] = {'total_frames': sum(r['variants'][block]['frames'] for r in results),
                          'cpu_realtime_percent_median': statistics.median(r['variants'][block]['cpu_realtime_percent'] for r in results),
                          'observed_name_prefixes': sum(r['variants'][block].get('asr', {}).get('name_prefix', False) for r in results)}
    compared = [r for r in results if all('asr' in r['variants'][b] for b in ['4096', '1024'])]
    summary['paired_asr_outputs'] = len(compared)
    summary['changed_asr_outputs'] = sum(r['variants']['4096']['asr']['text_sha256'] != r['variants']['1024']['asr']['text_sha256'] for r in compared)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'summary': summary, 'clips': results}, indent=2) + '\n')
    args.output.chmod(0o600)
    print(json.dumps(summary), flush=True)


if __name__ == '__main__': main()
