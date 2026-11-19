from array import array
import hashlib
import io
import sys
import unicodedata
import wave

import pytest

from meeting_api.collector.audio_quality import assess_audio, assess_text, prepare_audio
from meeting_api.collector.refinement import _decode
from meeting_api.collector.refinement_eval import text_metrics
from test_bot_refinement import audio


@pytest.mark.parametrize("amplitude,text,check", [
    (0, "TINA, TINA. TINA! TINA?", "text_and_quiet_audio"),
    (70, "TINA, TINA. TINA! TINA?", "text_flag"),  # Low volume alone is not corroboration.
    (1000, "má, má. má! má?", "text_flag"),
    (1000, unicodedata.normalize("NFD", "má má má má"), "text_flag"),
    (0, "… !!!", "text_and_quiet_audio"),
    (1000, "… !!!", "text_flag"),
    (0, "Dạ", "no_text_flags"),
    (1000, "ma má mà mạ", "no_text_flags"),
    (1000, "7", "no_text_flags"),
    (1000, "OK", "no_text_flags"),
    (1000, "TINA dùng API-v2 và C++", "no_text_flags"),
])
def test_text_audio_evidence_keeps_accents_short_replies_and_numbers(amplitude, text, check):
    original = audio(amplitude)
    quality = assess_audio(original, text)
    assert quality["text_check"] == check
    assert ("repetition" in quality["reasons"]) == ("TINA," in text or "má," in text or "ma\u0301" in text)
    assert original == audio(amplitude)


def test_proposal_reuses_original_acoustics_without_carrying_source_text_flags():
    source = assess_audio(audio(0), "má má má má")
    corrected = assess_text(source, "Dạ")
    assert source["text_check"] == "text_and_quiet_audio"
    assert corrected["text_check"] == "no_text_flags"
    assert corrected["reasons"] == ["low_volume", "mostly_quiet"]
    assert all(corrected[key] == source[key] for key in ("rms", "clipping_ratio", "quiet_ratio"))


def test_quiet_frame_coincidence_can_include_real_audible_speech():
    samples = array("h", [0] * 44800 + [2000, -2000] * 1600)
    if sys.byteorder != "little":
        samples.byteswap()
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(samples.tobytes())
    quality = assess_audio(out.getvalue(), "Dạ, dạ. Dạ! Dạ?")
    assert quality["text_check"] == "text_and_quiet_audio"
    assert quality["quiet_ratio"] > .9
    assert quality["rms"] > .003  # Audio has a real nonzero burst; no absence-of-speech verdict.


def pcm(content):
    with wave.open(io.BytesIO(content), "rb") as wav:
        frames = wav.readframes(wav.getnframes())
    result = array("h", frames)
    if sys.byteorder != "little":
        result.byteswap()
    return result


def test_gain_is_bounded_and_preserves_every_sample_position():
    source = audio(70)
    before = pcm(source)
    prepared, info = prepare_audio(source)
    after = pcm(prepared)
    assert info["applied"] and info["gain_db"] == 12
    assert info["audio_sha256"] == hashlib.sha256(prepared).hexdigest()
    assert len(before) == len(after) == 48000
    assert all((a == 0) == (b == 0) and (a >= 0) == (b >= 0) for a, b in zip(before, after))
    assert all(abs(b - a * 10 ** .6) <= .5 for a, b in zip(before, after))
    assert assess_audio(prepared, "")["rms"] > assess_audio(source, "")["rms"]
    assert source == audio(70)  # The source bytes were never mutated.


@pytest.mark.parametrize("amplitude,reason", [(0, "low_signal"), (10, "mostly_quiet"),
                                             (1000, "not_low_volume"), (32767, "clipping")])
def test_unsuitable_inputs_are_returned_byte_for_byte(amplitude, reason):
    source = audio(amplitude)
    prepared, info = prepare_audio(source)
    assert prepared == source and not info["applied"] and info["gain_db"] == 0
    assert info["reason"] == reason


def test_a_single_peak_limits_gain_without_clipping():
    out = io.BytesIO()
    with wave.open(io.BytesIO(audio(70)), "rb") as wav:
        frames = wav.readframes(wav.getnframes())
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(frames * 10)
    source = bytearray(out.getvalue())
    # PCM16 WAV data starts at byte 44 in this fixture. A peak is not a clipping ratio.
    source[44:46] = (20000).to_bytes(2, "little", signed=True)
    prepared, info = prepare_audio(bytes(source))
    assert info["applied"] and 0 < info["gain_db"] < 12
    assert max(abs(x) for x in pcm(prepared)) <= round(.9 * 32768)
    source[44:46] = (32700).to_bytes(2, "little", signed=True)
    unchanged, info = prepare_audio(bytes(source))
    assert unchanged == source and info["reason"] == "peak_limited"


def test_decode_adjacent_boundaries_retains_onset_tail_and_pause_samples(tmp_path):
    # Non-periodic PCM makes even a one-sample shift/drop observable at every cut.
    expected = array("h", ((i * 7919) % 16001 - 8000 for i in range(48000)))
    source = io.BytesIO()
    with wave.open(source, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        samples = array("h", expected)
        if sys.byteorder != "little":
            samples.byteswap()
        wav.writeframes(samples.tobytes())
    path = tmp_path / "boundary.wav"
    path.write_bytes(source.getvalue())
    cuts = [0, .125, .75, 1.875, 3]
    joined = array("h")
    for start, end in zip(cuts, cuts[1:]):
        actual = pcm(_decode(path, start, end - start))
        assert actual == expected[round(start * 16000):round(end * 16000)]
        joined.extend(actual)
    assert joined == expected
    assert path.read_bytes() == source.getvalue()
    with pytest.raises(ValueError, match="does not cover"):
        _decode(path, 2.99, .02)  # A missing 10 ms tail must not become a successful short clip.


def test_opus_seek_keeps_boundary_timing_against_the_full_decode(tmp_path):
    import subprocess
    from random import Random
    path = tmp_path / "source.wav"
    out = io.BytesIO()
    noise = Random(7)
    values = [noise.randint(-10000, 10000) for _ in range(144004)]
    samples = array("h", (sum(values[i:i + 5]) // 5 for i in range(144000)))
    if sys.byteorder != "little":
        samples.byteswap()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(samples.tobytes())
    path.write_bytes(out.getvalue())
    encoded = tmp_path / "source.webm"
    subprocess.run(["ffmpeg","-v","error","-nostdin","-i",str(path),"-c:a","libopus",str(encoded)],
                   capture_output=True, timeout=30, check=True)
    complete = pcm(_decode(encoded, 0, 9))
    assert abs(len(complete) - 144000) <= 16
    for start, duration in ((.125, .625), (.75, 1.125), (1.875, 1.125), (4.75, 1.125), (7.875, 1.125)):
        clip = pcm(_decode(encoded, start, duration))
        assert abs(len(clip) - round(duration * 16000)) <= 16
        # Lossy PCM need not match bit-for-bit. Compare onset/tail alignment to a full decode.
        for probe in (256, len(clip) - 1280):
            anchor = round(start * 16000) + probe
            offsets = range(-160, 161, 8)
            best = max(offsets, key=lambda offset: sum(clip[probe + i] * complete[anchor + offset + i] for i in range(1024)))
            assert abs(best) <= 16, "Compressed seek shifted an onset or tail beyond the 1 ms source clock"


def test_metrics_keep_vietnamese_accents_and_reveal_boundary_and_repetition_errors():
    assert text_metrics("Thứ Sáu, API!", "THỨ SÁU API")["cer"] == 0
    assert text_metrics("má", "ma")["character_errors"] == 1
    assert text_metrics("m\u00e1", "ma\u0301")["cer"] == 0
    result = text_metrics("Xin chào mọi người hôm nay", "chào mọi người người hôm")
    assert result["token_deletions"] == 2 and result["token_insertions"] == 1
    assert not result["prefix_matches"] and not result["suffix_matches"]
    assert result["adjacent_repeats"] == 1
    assert text_metrics("Xin chào", "")["cer"] == 1
    with pytest.raises(ValueError):
        text_metrics("", "anything")


def test_bounded_ab_probe_reports_metrics_without_text_or_credentials(tmp_path, monkeypatch):
    import json
    import httpx
    from meeting_api.collector import refinement_eval
    (tmp_path / "quiet.wav").write_bytes(audio(70))
    (tmp_path / "normal.wav").write_bytes(audio())
    manifest = tmp_path / "cases.json"
    manifest.write_text(json.dumps([{"audio":"quiet.wav","reference":"Xin chào"},
                                    {"audio":"normal.wav","reference":"Xin chào"}]), encoding="utf8")
    calls = []
    def infer(request):
        calls.append(request)
        return httpx.Response(200, json={"text":"Xin trao" if len(calls) == 1 else "Xin chào"})
    original = httpx.Client
    monkeypatch.setattr(refinement_eval.httpx, "Client", lambda **kw: original(transport=httpx.MockTransport(infer), **kw))
    result = refinement_eval.evaluate(manifest, "http://asr.test/v1/audio/transcriptions", "private-token", "custom")
    assert result["asr_requests"] == len(calls) == 3
    assert result["original_cer"] > result["prepared_cer"] == 0  # Mocked responses, not an accuracy claim.
    assert result["clips"][1]["same_input_reused"]
    assert result["clips"][0]["preparation_ms"] >= 0
    assert all(secret not in json.dumps(result) for secret in ("private-token", "asr.test", "Xin chào", "Xin trao"))
