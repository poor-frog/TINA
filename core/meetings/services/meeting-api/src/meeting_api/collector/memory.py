"""Durable canonical projection and conservative, evidence-backed conversation windows."""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from uuid import NAMESPACE_URL, uuid5

from .alignment import attribute_alignment, _phrases
from .speakers import observe, overlay, view
from .transcript_document import document


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False).encode()).hexdigest()


def canonical(meeting, data, rows):
    """Only durable finalized rows enter memory; temporary captions never become evidence."""
    if len(rows) > 2000 or sum(len(s.get("text", "")) for s in rows) > 500_000:
        raise ValueError("Meeting memory is limited to 2000 segments and 500000 source characters")
    rows = sorted(rows, key=lambda s: str(s.get("segment_id", "")))
    source = {"version": 1, "meeting": meeting, "rows": rows,
              **{key: data.get(key) for key in ("transcript_edits", "speaker_registry", "recordings", "transcript_alignment", "transcript_diarization")}}
    source_revision = digest(source)
    previous = data.get("canonical_transcript") or {}
    if previous.get("source_revision") == source_revision:
        return previous
    rows = sorted((s for s in rows if s.get("segment_id") and s.get("completed", True)
                   and all(type(s.get(k)) in (int, float) and math.isfinite(s[k]) for k in ("start", "end"))
                   and s["end"] > s["start"]), key=lambda s: (s["start"], s["segment_id"]))
    segments = overlay(rows, data)
    doc = document({"id": meeting["id"], "status": meeting["status"], "segments": segments,
                    "recordings": data.get("recordings") or []}, data.get("transcript_edits") or {},
                   {s["segment_id"]: s.get("session_uid") for s in rows})
    aligned = copy.deepcopy(data.get("transcript_alignment") or {})
    entries = {s["speaker_id"]: s for s in view(data, meeting["id"])["speakers"]}
    if aligned.get("status") == "completed":
        attribute_alignment(meeting["id"], doc,
                            {s["segment_id"]: s for s in segments}, entries,
                            data.get("transcript_diarization"), aligned)
    items = {s["segment_id"]: s for s in aligned.get("items", [])}
    live = {s["segment_id"]: s for s in segments}
    result = []
    for segment in doc["segments"]:
        sid = segment["segment_id"]
        binding = live[sid]
        item = items.get(sid, {})
        usable = aligned.get("status") == "completed" and item.get("state") == "aligned" and segment["text"] == segment["raw_text"]
        words = copy.deepcopy(item.get("words") or []) if usable else []
        # Stored word offsets are relative to the audio clip; canonical times use the source clock.
        for word in words:
            for key in ("start_ms", "end_ms"):
                if word.get(key) is not None:
                    word[key] += segment["start_ms"]
        result.append({key: segment[key] for key in ("segment_id", "start_ms", "end_ms", "raw_text", "text", "revision", "audio")}
                      | {"speaker_id": binding.get("speaker_id"), "speaker_name": binding.get("speaker") or "Unknown speaker",
                         "speaker_revision": binding.get("speaker_revision", 0), "words": words, "phrases": _phrases(words),
                         "alignment": {"status": "aligned" if usable else "segment_fallback",
                                       "job_id": aligned.get("id") if usable else None,
                                       "model": item.get("model") if usable else None,
                                       "audio_sha256": item.get("audio_sha256") if usable else None,
                                       "text_sha256": item.get("text_sha256") if usable else None}})
    return {"version": "canonical-transcript.v1", "meeting_id": meeting["id"],
            "revision": previous.get("revision", 0) + 1, "source_revision": source_revision,
            "updated_at": datetime.now(timezone.utc).isoformat(), "segments": result}


# shortcut: extract explicit VI/EN cues as candidates; add a measured semantic extractor for implicit commitments.
CUES = {
    "action_item": r"\b(?:tôi sẽ|mình sẽ|em sẽ|anh sẽ|chị sẽ|chúng ta cần|cần phải|i will|i'll|we will|we need to|action item|phụ trách)\b",
    "decision": r"\b(?:thống nhất|quyết định|chốt là|we agree|we agreed|we decided|decision is)\b",
    "fact": r"\b(?:hiện tại|thực tế là|the current|currently|the status is)\b",
}
NEGATED = re.compile(r"\b(?:chưa|không|not|never|haven't|hasn't|didn't)\b", re.I)
DEADLINE = re.compile(r"\b(?:deadline|hạn chót|trước|by|due)\s+([^.!?;]{1,80})", re.I)


def conversation_memory(canon, previous=None):
    previous = previous or {}
    if previous.get("canonical_revision") == canon["revision"] and previous.get("extractor") == "rules.vi-en.v1":
        return previous
    # Keep a long source segment intact; limits otherwise bound each window at segment boundaries.
    groups = []
    for segment in canon["segments"]:
        if not groups or segment["end_ms"] - groups[-1][0]["start_ms"] > 60_000 or sum(len(s["text"]) for s in groups[-1]) + len(segment["text"]) > 6000:
            groups.append([])
        groups[-1].append(segment)
    old = {w["id"]: w for w in previous.get("windows", [])}
    windows, facts = [], []
    for group in groups:
        evidence = [{key: s[key] for key in ("segment_id", "revision", "start_ms", "end_ms", "speaker_id", "speaker_name")}
                    | {"quote": s["text"]} for s in group]
        wid = str(uuid5(NAMESPACE_URL, f'tina:memory:{canon["meeting_id"]}:{group[0]["segment_id"]}'))
        fingerprint = digest(evidence)
        prior = old.get(wid, {})
        extracted = prior.get("facts", []) if prior.get("source_revision") == fingerprint else []
        if prior.get("source_revision") != fingerprint:
            for item in evidence:
                for kind, pattern in CUES.items():
                    match = re.search(pattern, item["quote"], re.I)
                    if not match or "?" in item["quote"] or NEGATED.search(item["quote"][:match.end()]):
                        continue
                    deadline = DEADLINE.search(item["quote"]) if kind == "action_item" else None
                    extracted.append({"id": str(uuid5(NAMESPACE_URL, f'tina:fact:{canon["meeting_id"]}:{kind}:{item["segment_id"]}:{digest(item)}')),
                                      "type": kind, "text": item["quote"], "status": "candidate",
                                      "assignee_id": None, "deadline_text": deadline[1].strip() if deadline else None,
                                      "deadline_date": None, "evidence": [item]})
        windows.append({"id": wid, "source_revision": fingerprint, "start_ms": group[0]["start_ms"],
                        "end_ms": max(s["end_ms"] for s in group), "evidence": evidence, "facts": extracted})
        facts.extend(extracted)
    return {"version": "meeting-memory.v1", "meeting_id": canon["meeting_id"], "canonical_revision": canon["revision"],
            "extractor": "rules.vi-en.v1", "windows": windows, "facts": facts}


def project(meeting, data, rows):
    canon = canonical(meeting, data, rows)
    memory = conversation_memory(canon, data.get("meeting_memory"))
    return {"canonical": canon, "memory": memory}


def persist(meeting, data, rows):
    """Called under the meeting lock; publish projection metadata in the same transaction."""
    from uuid import uuid4
    from .diarization import apply_assignments
    rows = copy.deepcopy([s for s in rows if s.get("completed", True)])
    observe(data, meeting, rows)
    job = data.get("transcript_diarization") or {}
    if job.get("status") == "completed" and job.get("applied_at"):
        apply_assignments(data, meeting, job, None)
    result = project(meeting, data, rows)
    if data.get("canonical_transcript", {}).get("source_revision") != result["canonical"]["source_revision"]:
        data["canonical_transcript"] = result["canonical"]
        data["transcript_outbox"] = [*(data.get("transcript_outbox") or []), {
            "version": "meeting-memory-revision.v1", "type": "meeting.memory.updated", "event_id": str(uuid4()),
            "meeting_id": meeting["id"], "revision": result["canonical"]["revision"],
            "at": result["canonical"]["updated_at"]}]
    data["meeting_memory"] = result["memory"]
    from .processed_notes import reconcile
    reconcile(data, result['canonical'], result['memory'])
    if data.get('live_assist') is not None:
        from .live_assist import reconcile as reconcile_state
        import time
        reconcile_state(data['live_assist'], result['canonical'], meeting['status'], time.time())
    return result
