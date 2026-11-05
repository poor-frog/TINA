"""Bounded PCM diagnostics for owner-triggered recording review; never rewrites text."""
from array import array
import io
import math
import sys
import wave


def assess_audio(content: bytes, text: str) -> dict:
    with wave.open(io.BytesIO(content), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or not 0 < wav.getnframes() <= 480000:
            raise ValueError("Expected at most 30 seconds of mono PCM16 at 16 kHz")
        count = wav.getnframes()
        pcm = array("h", wav.readframes(count))
    if len(pcm) != count:
        raise ValueError("Incomplete audio")
    if sys.byteorder != "little":
        pcm.byteswap()
    rms = math.sqrt(sum(x * x for x in pcm) / count) / 32768
    clipping = sum(abs(x) >= 32700 for x in pcm) / count
    # 20 ms energy frames. This is an energy estimate, not a speech detector.
    quiet = sum(sum(x * x for x in pcm[i:i + 320]) / len(pcm[i:i + 320]) < (32768 * .001) ** 2
                for i in range(0, count, 320))
    quiet_ratio = quiet / math.ceil(count / 320)
    reasons = []
    if rms < .003:
        reasons.append("low_volume")
    if clipping >= .01:
        reasons.append("clipping")
    if quiet_ratio >= .8:
        reasons.append("mostly_quiet")
    # Preserve Vietnamese diacritics. Repetition flags are advisory, including real repeated speech.
    words = text.casefold().split()
    repeated = any(words[i:i + size] * 4 == words[i:i + size * 4]
                   for size in range(1, min(10, len(words) // 4) + 1)
                   for i in range(len(words) - size * 4 + 1))
    if repeated:
        reasons.append("repetition")
    return {"needs_review": bool(reasons), "reasons": reasons, "rms": round(rms, 6),
            "clipping_ratio": round(clipping, 6), "quiet_ratio": round(quiet_ratio, 4)}
