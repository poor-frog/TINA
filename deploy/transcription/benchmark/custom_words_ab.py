"""Paired VieGem custom-word sweep; audio/CTC probabilities are shared across decoder weights.

Input rows are private {id, path, kind, reference} records. Reports contain scores, hashes,
and counts only; they never contain transcript text or source paths.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import time
import unicodedata

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'deploy/transcription/viegem'))
from engine import VieGemEngine, contextual_biased_decoder, load_custom_words
from gipformer.engine import RATE, read_audio, speech_ranges


def normalize(text):
    text = unicodedata.normalize('NFC', text).casefold().replace('’', "'")
    chars = []
    for i, char in enumerate(text):
        apostrophe = char == "'" and i > 0 and i + 1 < len(text) and text[i - 1].isalpha() and text[i + 1].isalpha()
        chars.append(char if apostrophe or unicodedata.category(char)[0] not in 'PS' else ' ')
    return ' '.join(''.join(chars).split())


def edit_errors(reference, hypothesis):
    if len(reference) < len(hypothesis):
        reference, hypothesis = hypothesis, reference
    previous = list(range(len(hypothesis) + 1))
    for i, left in enumerate(reference, 1):
        current = [i]
        for j, right in enumerate(hypothesis, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (left != right)))
        previous = current
    return previous[-1]


def score(reference, hypothesis):
    ref, hyp = normalize(reference), normalize(hypothesis)
    return {
        'reference_words': len(ref.split()),
        'word_errors': edit_errors(ref.split(), hyp.split()),
        'reference_characters': len(ref.replace(' ', '')),
        'char_errors': edit_errors(ref.replace(' ', ''), hyp.replace(' ', '')),
    }


def target_alignment(reference, hypothesis, words):
    ref, hyp = normalize(reference).split(), normalize(hypothesis).split()
    rows, columns = len(ref) + 1, len(hyp) + 1
    distance = [[0] * columns for _ in range(rows)]
    for i in range(rows):
        distance[i][0] = i
    for j in range(columns):
        distance[0][j] = j
    for i in range(1, rows):
        for j in range(1, columns):
            distance[i][j] = min(distance[i - 1][j] + 1, distance[i][j - 1] + 1,
                                 distance[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]))

    terms = {word: {'reference': 0, 'matched': 0, 'missed': 0, 'false_insertions': 0}
             for word in words}
    i, j = len(ref), len(hyp)
    while i or j:
        if i and j:
            same = ref[i - 1] == hyp[j - 1]
            cost = 0 if same else 1
            if distance[i][j] == distance[i - 1][j - 1] + cost:
                if ref[i - 1] in terms:
                    terms[ref[i - 1]]['reference'] += 1
                    if same:
                        terms[ref[i - 1]]['matched'] += 1
                    else:
                        terms[ref[i - 1]]['missed'] += 1
                if not same and hyp[j - 1] in terms:
                    terms[hyp[j - 1]]['false_insertions'] += 1
                i -= 1
                j -= 1
                continue
        if i and distance[i][j] == distance[i - 1][j] + 1:
            if ref[i - 1] in terms:
                terms[ref[i - 1]]['reference'] += 1
                terms[ref[i - 1]]['missed'] += 1
            i -= 1
        else:
            if hyp[j - 1] in terms:
                terms[hyp[j - 1]]['false_insertions'] += 1
            j -= 1
    return {word: value for word, value in terms.items()
            if value['reference'] or value['matched'] or value['false_insertions']}


def summarize(rows, words):
    reference_words = sum(row['score']['reference_words'] for row in rows)
    reference_characters = sum(row['score']['reference_characters'] for row in rows)
    target_reference = sum(row['target']['reference_occurrences'] for row in rows)
    target_matched = sum(row['target']['matched_occurrences'] for row in rows)
    target_false = sum(row['target']['false_insertions'] for row in rows)
    elapsed = sorted(row['decoder_seconds'] for row in rows)
    return {
        'clips': len(rows),
        'wer': sum(row['score']['word_errors'] for row in rows) / reference_words if reference_words else None,
        'cer': sum(row['score']['char_errors'] for row in rows) / reference_characters if reference_characters else None,
        'target_reference_occurrences': target_reference,
        'target_matched_occurrences': target_matched,
        'target_missed_occurrences': target_reference - target_matched,
        'target_false_insertions': target_false,
        'target_recall': target_matched / target_reference if target_reference else None,
        'target_precision': target_matched / (target_matched + target_false) if target_matched + target_false else None,
        'decoder_seconds_p50': elapsed[(len(elapsed) - 1) // 2] if elapsed else None,
        'decoder_seconds_p95': elapsed[math.ceil(len(elapsed) * .95) - 1] if elapsed else None,
        'terms_with_reference': {
            word: sum(row['target']['per_term'].get(word, {}).get('reference', 0) for row in rows)
            for word in words
            if any(row['target']['per_term'].get(word, {}).get('reference', 0) for row in rows)
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--custom-words-file', type=Path,
                        default=ROOT / 'deploy/transcription/viegem/custom_words.txt')
    parser.add_argument('--weights', default='0,0.25,0.5,1.0')
    args = parser.parse_args()
    os.umask(0o077)
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TRANSFORMERS_OFFLINE', '1')
    os.environ['TINA_VIEGEM_NAME_BIAS'] = '0'
    os.environ['TINA_VIEGEM_CUSTOM_WEIGHT'] = '0'

    rows = json.loads(args.manifest.read_text(encoding='utf-8'))
    if not isinstance(rows, list) or not 1 <= len(rows) <= 32:
        raise ValueError('Use a bounded manifest of 1-32 clips')
    if any(not isinstance(row, dict) or not isinstance(row.get('reference'), str)
           or not isinstance(row.get('path'), str) or 'id' not in row for row in rows):
        raise ValueError('Every row needs id, path, and a labeled reference')
    if len({str(row['id']) for row in rows}) != len(rows):
        raise ValueError('Clip ids must be unique')

    words = [word for word in load_custom_words(args.custom_words_file) if word != 'tina']
    if not words:
        raise ValueError('Custom word list is empty')
    parsed_weights = [float(value) for value in args.weights.split(',')]
    if not parsed_weights or parsed_weights[0] != 0 or len(set(parsed_weights)) != len(parsed_weights):
        raise ValueError('Weights must be unique and start with 0 for the unmodified baseline')
    if any(not math.isfinite(value) or not 0 <= value <= 2 for value in parsed_weights):
        raise ValueError('Weights must be finite values from 0 to 2')

    engine = VieGemEngine.load(ROOT / 'deploy/transcription/models/viegem-fsmn')
    decoders = {
        str(weight): contextual_biased_decoder(engine.lm, words, name_weight=0, custom_weight=weight)
        for weight in parsed_weights
    }
    results = []
    for row in rows:
        path = Path(row['path'])
        if not path.is_absolute():
            path = args.manifest.parent / path
        content = path.read_bytes()
        pcm, duration = read_audio(content)
        if duration > 12:
            raise ValueError('Each test clip must be at most 12 seconds')

        started = time.perf_counter()
        ranges = engine.vad.generate(input=np.pad(pcm, (0, max(0, 3200 - len(pcm)))), cache={},
                                     is_final=True, fs=RATE, max_end_silence_time=1200, disable_pbar=True)
        probabilities = [engine.probabilities(pcm[start:end]) for start, end in speech_ranges(ranges, len(pcm))] if np.any(pcm) else []
        acoustic_seconds = time.perf_counter() - started
        variants = {}
        for label, decoder in decoders.items():
            started = time.perf_counter()
            text = ' '.join(engine.decode_probabilities(probability, decoder).strip() for probability in probabilities).strip()
            decoder_seconds = time.perf_counter() - started
            per_term = target_alignment(row['reference'], text, words)
            variants[label] = {
                'score': score(row['reference'], text),
                'target': {
                    'reference_occurrences': sum(item['reference'] for item in per_term.values()),
                    'matched_occurrences': sum(item['matched'] for item in per_term.values()),
                    'false_insertions': sum(item['false_insertions'] for item in per_term.values()),
                    'per_term': per_term,
                },
                'decoder_seconds': decoder_seconds,
                'text_sha256': hashlib.sha256(text.encode()).hexdigest(),
            }
        results.append({
            'id': row['id'],
            'kind': row.get('kind', 'labeled'),
            'audio_sha256': hashlib.sha256(content).hexdigest(),
            'reference_sha256': hashlib.sha256(normalize(row['reference']).encode()).hexdigest(),
            'duration_s': duration,
            'acoustic_seconds': acoustic_seconds,
            'variants': variants,
        })
        print(json.dumps({'event': 'clip_complete', 'index': len(results), 'total': len(rows)}), flush=True)

    summary = {
        'device': engine.device,
        'vad': 'FSMN-VAD',
        'silence_ms': 1200,
        'alpha': .35,
        'beta': 1.5,
        'beam_width': 32,
        'same_audio_and_acoustic_probabilities': True,
        'custom_word_count': len(words),
        'weights': {label: summarize([row['variants'][label] for row in results], words) for label in decoders},
    }
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    args.output.write_text(json.dumps({'summary': summary, 'clips': results}, ensure_ascii=False, indent=2) + '\n',
                           encoding='utf-8')
    args.output.chmod(0o600)
    print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
    main()
