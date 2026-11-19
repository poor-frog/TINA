"""Manual, bounded A/B probe for recording refinement. No application/database writes.

Run with PYTHONPATH=src and -m meeting_api.collector.refinement_eval. References must
be human-checked; a previous ASR result is not ground truth. Reports omit all text.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import time
import unicodedata
import wave

import httpx

from .audio_quality import prepare_audio


def _distance(reference, hypothesis):
    row = list(range(len(hypothesis) + 1))
    for i, expected in enumerate(reference, 1):
        following = [i]
        for j, actual in enumerate(hypothesis, 1):
            following.append(min(row[j] + 1, following[-1] + 1, row[j - 1] + (expected != actual)))
        row = following
    return row[-1]


def text_metrics(reference: str, hypothesis: str) -> dict:
    """NFC/casefold; ignore punctuation/whitespace for CER, retain Vietnamese accents."""
    if not isinstance(reference, str) or not isinstance(hypothesis, str) or max(len(reference), len(hypothesis)) > 2000:
        raise ValueError("Expected reference/hypothesis text of at most 2000 characters")
    expected, actual = (unicodedata.normalize("NFC", text).casefold() for text in (reference, hypothesis))
    chars, recognized = ("".join(c for c in text if c.isalnum()) for text in (expected, actual))
    if not chars:
        raise ValueError("A nonempty human-checked reference is required")
    words, found = re.findall(r"\w+", expected), re.findall(r"\w+", actual)
    # Stable Levenshtein alignment of whitespace tokens, reported separately from CER.
    row = [(i, 0, 0, i) for i in range(len(found) + 1)]
    for i, word in enumerate(words, 1):
        following = [(i, 0, i, 0)]
        for j, candidate in enumerate(found, 1):
            cost, substitutions, deletions, insertions = row[j - 1]
            substitute = (cost + (word != candidate), substitutions + (word != candidate), deletions, insertions)
            cost, substitutions, deletions, insertions = row[j]
            delete = (cost + 1, substitutions, deletions + 1, insertions)
            cost, substitutions, deletions, insertions = following[-1]
            insert = (cost + 1, substitutions, deletions, insertions + 1)
            following.append(min(substitute, delete, insert))
        row = following
    errors, substitutions, deletions, insertions = row[-1]
    edge = min(2, len(words))
    character_errors = _distance(chars, recognized)
    return {"reference_characters": len(chars), "character_errors": character_errors,
            "cer": character_errors / len(chars), "reference_tokens": len(words),
            "token_errors": errors, "token_substitutions": substitutions,
            "token_deletions": deletions, "token_insertions": insertions,
            "prefix_matches": found[:edge] == words[:edge], "suffix_matches": found[-edge:] == words[-edge:],
            "adjacent_repeats": sum(a == b for a, b in zip(found, found[1:]))}


def evaluate(manifest: Path, endpoint: str, token: str, model: str) -> dict:
    cases = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(cases, list) or not 1 <= len(cases) <= 20:
        raise ValueError("Use 1-20 local clips with human-checked references")
    headers = {"Authorization": "Bearer " + token} if token else {}
    results, requests = [], 0
    with httpx.Client(timeout=30, follow_redirects=False, headers=headers) as client:
        for index, case in enumerate(cases):
            if not isinstance(case, dict) or not isinstance(case.get("reference"), str):
                raise ValueError("Each clip needs audio and reference fields")
            text_metrics(case["reference"], "")  # Validate before spending inference.
            path = manifest.parent / case["audio"]
            if path.stat().st_size > 2 * 1024 ** 2:
                raise ValueError("Each clip must be at most 2 MiB / 30 seconds of mono PCM16 at 16 kHz")
            audio = path.read_bytes()
            start = time.perf_counter()
            prepared, preparation = prepare_audio(audio)
            preparation_ms = round((time.perf_counter() - start) * 1000)

            def infer(content):
                nonlocal requests
                start = time.perf_counter()
                requests += 1
                response = client.post(endpoint, data={"model": model, "response_format": "json"},
                                       files={"file": ("segment.wav", content, "audio/wav")})
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or not isinstance(payload.get("text"), str) or not payload["text"].strip():
                    raise ValueError("Invalid ASR response")
                return payload["text"], round((time.perf_counter() - start) * 1000)

            original, original_ms = infer(audio)
            same_input = prepared == audio
            candidate, candidate_ms = (original, original_ms) if same_input else infer(prepared)
            results.append({"index": index, "preparation": preparation, "preparation_ms": preparation_ms,
                            "same_input_reused": same_input, "original_asr_ms": original_ms,
                            "prepared_asr_ms": candidate_ms, "original": text_metrics(case["reference"], original),
                            "prepared": text_metrics(case["reference"], candidate)})
    totals = {}
    for variant in ("original", "prepared"):
        errors = sum(row[variant]["character_errors"] for row in results)
        count = sum(row[variant]["reference_characters"] for row in results)
        totals[variant + "_cer"] = errors / count
    return {"version": "refinement-eval.v1", "clips": results, "asr_requests": requests, **totals,
            "notes": "Single-pass measurements, including possible warm-up. Edge text mismatches do not prove audio loss. No text, audio, endpoint or credential is stored in this report."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    endpoint = os.getenv("TRANSCRIPTION_SERVICE_URL", "").rstrip("/")
    if not endpoint.startswith(("http://", "https://")):
        parser.error("Set TRANSCRIPTION_SERVICE_URL to the chosen ASR endpoint")
    if not endpoint.endswith("/audio/transcriptions"):
        endpoint += "/audio/transcriptions" if endpoint.endswith("/v1") else "/v1/audio/transcriptions"
    try:
        report = evaluate(args.manifest, endpoint, os.getenv("TRANSCRIPTION_SERVICE_TOKEN", ""),
                          os.getenv("TRANSCRIPTION_MODEL", "whisper-1"))
    except (ValueError, OSError, KeyError, TypeError, EOFError, wave.Error, httpx.HTTPError):
        parser.exit(1, "Evaluation failed. Check local WAV/reference inputs and ASR availability; provider details were omitted.\n")
    args.output.write_bytes((json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode())
    print(f"{len(report['clips'])} clips; {report['asr_requests']} ASR requests; CER {report['original_cer']:.3f} -> {report['prepared_cer']:.3f}")


if __name__ == "__main__":
    main()
