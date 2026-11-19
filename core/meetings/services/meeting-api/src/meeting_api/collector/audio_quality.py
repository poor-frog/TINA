"""Bounded PCM diagnostics for owner-triggered recording review; never rewrites text."""
from array import array
import hashlib
import io
import math
import sys
import unicodedata
import wave


def _read_pcm(content: bytes) -> array:
    with wave.open(io.BytesIO(content), "rb") as wav:
        if wav.getnchannels() != 1 or wav.getsampwidth() != 2 or wav.getframerate() != 16000 or not 0 < wav.getnframes() <= 480000:
            raise ValueError("Expected at most 30 seconds of mono PCM16 at 16 kHz")
        count = wav.getnframes()
        pcm = array("h", wav.readframes(count))
    if len(pcm) != count:
        raise ValueError("Incomplete audio")
    if sys.byteorder != "little":
        pcm.byteswap()
    return pcm


def assess_text(acoustics: dict, text: str) -> dict:
    """Compare text cues with original-clip energy, never classify or delete speech.

    A quiet-frame coincidence is advisory, not independent proof of non-speech.
    No length/language/phrase blacklist: short replies, names and numbers are valid.
    """
    reasons = [r for r in acoustics["reasons"] if r in ("low_volume", "clipping", "mostly_quiet")]
    # NFC keeps Vietnamese accents intact, including decomposed input. Punctuation
    # must not hide a loop; retain symbols inside words (e.g. API-v2, R&D).
    tokens = []
    for token in unicodedata.normalize("NFC", text).casefold().split():
        first, last = 0, len(token)
        while first < last and not token[first].isalnum():
            first += 1
        while last > first and not token[last - 1].isalnum():
            last -= 1
        if first < last:
            tokens.append(token[first:last])
    repeated = any(tokens[i:i + size] * 4 == tokens[i:i + size * 4]
                   for size in range(1, min(10, len(tokens) // 4) + 1)
                   for i in range(len(tokens) - size * 4 + 1))
    if repeated:
        reasons.append("repetition")
    if text.strip() and not tokens:
        reasons.append("non_lexical")
    text_flag = repeated or "non_lexical" in reasons
    text_check = ("text_and_quiet_audio" if "mostly_quiet" in reasons else "text_flag") if text_flag else "no_text_flags"
    return {**acoustics, "needs_review": bool(reasons), "reasons": reasons, "text_check": text_check}


def assess_audio(content: bytes, text: str) -> dict:
    pcm = _read_pcm(content)
    count = len(pcm)
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
    return assess_text({"rms": round(rms, 6), "reasons": reasons,
                        "clipping_ratio": round(clipping, 6), "quiet_ratio": round(quiet_ratio, 4)}, text)


def prepare_audio(content: bytes) -> tuple[bytes, dict]:
    """Opt-in bounded-gain.v1. Preserve every sample position; never infer speech presence."""
    pcm = _read_pcm(content)
    quality = assess_audio(content, "")
    rms = math.sqrt(sum(x * x for x in pcm) / len(pcm)) / 32768
    peak = max(abs(x) for x in pcm) / 32768
    gain, reason = 1.0, "not_low_volume"
    if "clipping" in quality["reasons"]:
        reason = "clipping"
    elif rms < .0001:
        reason = "low_signal"
    elif quality["quiet_ratio"] >= .8:
        reason = "mostly_quiet"
    elif rms < .003:
        # At most +12 dB, with 10% PCM headroom; this cannot restore clipped/missing speech.
        gain = min(10 ** (12 / 20), .01 / rms, .9 / peak)
        if gain < 1.05:
            gain, reason = 1.0, "peak_limited"
        else:
            reason = "gain_applied"
    prepared = content
    if gain > 1:
        samples = array("h", (round(x * gain) for x in pcm))
        if sys.byteorder != "little":
            samples.byteswap()
        out = io.BytesIO()
        with wave.open(out, "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
            wav.writeframes(samples.tobytes())
        prepared = out.getvalue()
    return prepared, {"method": "bounded-gain.v1", "applied": gain > 1,
                      "gain_db": round(20 * math.log10(gain), 3), "reason": reason,
                      "audio_sha256": hashlib.sha256(prepared).hexdigest()}
