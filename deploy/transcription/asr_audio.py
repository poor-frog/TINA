"""Shared input decoding, original sample offsets, and model asset verification."""
from __future__ import annotations

import hashlib
import io
import math
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

RATE = 16000
MAX_SECONDS = 90


class AudioInputError(ValueError):
    pass


def read_audio(content):
    with sf.SoundFile(io.BytesIO(content)) as file:
        if not 1 <= file.channels <= 8 or not 8000 <= file.samplerate <= 192000 or not 0 < file.frames <= MAX_SECONDS * file.samplerate or file.frames * file.channels > 16_000_000:
            raise AudioInputError('Expected 0–90 seconds of audio, 1–8 channels, 8–192 kHz')
        rate, duration = file.samplerate, file.frames / file.samplerate
        pcm = file.read(dtype='float32', always_2d=True).mean(axis=1)
    if not np.isfinite(pcm).all():
        raise AudioInputError('Audio contains non-finite samples')
    if rate != RATE:
        factor = math.gcd(rate, RATE)
        pcm = resample_poly(pcm, RATE // factor, rate // factor).astype(np.float32)
    return np.ascontiguousarray(pcm), duration


def speech_ranges(result, count):
    if not isinstance(result, list) or len(result) != 1 or not isinstance(result[0], dict) or not isinstance(result[0].get('value'), list):
        raise RuntimeError('FSMN returned invalid speech ranges')
    intervals, previous_end = [], 0
    for pair in result[0]['value']:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2 or any(type(v) not in (int, float) or not math.isfinite(v) for v in pair) or pair[0] < 0 or pair[1] <= pair[0] or pair[1] > max(count, 3200) / 16 + 50:
            raise RuntimeError('FSMN returned invalid speech times')
        start, end = math.floor(pair[0] * 16), min(count, math.ceil(pair[1] * 16))
        if start >= count:
            continue  # Discard speech belonging only to temporary short-input padding.
        if start < previous_end:
            raise RuntimeError('FSMN returned overlapping speech ranges')
        for offset in range(start, end, 30 * RATE):
            # shortcut: bound long speech to 30-second windows; add validated overlap decoding before raising the cap.
            intervals.append((offset, min(end, offset + 30 * RATE)))
        previous_end = end
    if len(intervals) > 512:
        raise RuntimeError('Too many speech intervals')
    return intervals


def verify_assets(directory, files):
    for name, expected in files.items():
        with (Path(directory) / name).open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != expected:
                raise ValueError(f'Model asset checksum mismatch: {name}')
