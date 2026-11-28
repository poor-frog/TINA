"""meeting.py — the live MEETING copilot of the in-container agent harness.

Consumes the meeting's ``transcript.v1`` Stream, gates cheaply, cleans the transcript + surfaces
proactive cards via a DIRECT ``CompletionPort`` call (a card beat is a pure prompt→text turn — no
tools, no subprocess, no workspace memory), and (on ``session_end``) writes one schema-validated
meeting entity through a constrained local writer; the completion model never receives file tools.

Imports the GENERIC helpers it needs from ``worker.engine`` (one direction); the engine imports the
meeting entry functions only inside ``main()`` (function-local) to avoid an import cycle.
"""
from __future__ import annotations

import json
import html
import logging
import re
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Callable, Iterator

import contracts
import yaml
from llm import (
    LLMAuthError,
    auth_error_event,
    completion_from_env,
    looks_like_auth_failure,
    model_error_event,
)
from llm.ports import CompletionPort, commit_workspace_paths
from shared.agent_config import (
    DEFAULT_CARD_KINDS,
    DEFAULT_POLISH_RULES,
    DEFAULT_TAG_RULES,
)
from shared.adapters import workspace_write_lock
from worker.engine import _Stream, _ensure_repo, _principal_author

log = logging.getLogger("agent_api.worker")
_SAFE_MEETING_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_auth_error_event = auth_error_event
_model_error_event = model_error_event


def safe_meeting_document_id(value: str) -> str:
    """Return a meeting identifier safe to use as one workspace filename."""
    if not isinstance(value, str) or not _SAFE_MEETING_ID.fullmatch(value) or value in (".", ".."):
        raise ValueError("meeting id is not a safe workspace document name")
    return value


# ── meeting mode: consume the transcript Stream, gate, emit proactive cards ───────────────────────

# build_card_prompt is a THIN COMPOSER: the MECHANISM (the transcript-window framing + the strict JSON
# shape the parser depends on) lives here in code; the POLICY (how to polish each line, and what to tag)
# is INJECTED from the workspace-governed MeetingConfig.polish_rules / .tag_rules — so a user can change
# copilot behavior by prompting the agent to edit agents/meeting.md, no redeploy.

# The fixed frame around the workspace policy. `{polish}` / `{tags}` are the governed rules; `{kinds}` is
# the wanted card kinds; `{steering}` is the (optional) free-text steering section.
_CARD_FRAME = (
    "You are a live meeting copilot watching a conversation in real time. Here is the mutable transcript "
    "processing window. Each line is sent through at most three passes; pass 1 is fresh, pass 2 should "
    "repair obvious ASR/name/entity errors, and pass 3 should be the final clean version before the line "
    "freezes and leaves this window.\n\n{lines}\n\n"
    "Return a processed transcript plus tag cards. For each input line, emit one note with the SAME id "
    "and speaker, following the POLISH RULES below.\n\n"
    "## Polish rules (governed by this workspace)\n{polish}\n\n"
    "Do not create topic headings. Set chapter to an empty string unless the source text itself gives a "
    "literal section title.\n\n"
    "## Tag rules (governed by this workspace)\n{tags}\n\n"
    "Emit tags ONLY as cards of these kinds: {kinds}. Do not use any other kind.\n\n"
    "Respond with ONLY this JSON object (no prose, no markdown fence, and do NOT write any files):\n"
    "{{\"notes\":[{{\"id\":\"<input id>\",\"speaker\":\"<speaker>\",\"chapter\":\"\",\"text\":\"<clean one-line note>\"}}],"
    "\"cards\":[{{\"kind\":\"<one of {kinds}>\",\"title\":\"<short>\",\"body\":\"<one line>\",\"actionable\":true}}]}}\n"
    "Use an empty cards array if these specific lines add no tags.{steering}"
)

# Appended to the frame only when the workspace config carries non-empty steering.
_STEERING_SECTION = (
    "\n\n## Standing instructions from this workspace\n"
    "Follow these workspace-set instructions about what to watch / ignore / tone:\n\n{steering}\n"
)


def build_card_prompt(
    lines: str,
    card_kinds: list[str],
    steering: str = "",
    *,
    polish_rules: str = DEFAULT_POLISH_RULES,
    tag_rules: str = DEFAULT_TAG_RULES,
) -> str:
    """Compose the copilot prompt: inject the workspace-governed ``polish_rules`` + ``tag_rules`` (the
    POLICY) and the wanted ``card_kinds`` around the transcript ``lines`` (the MECHANISM frame), plus the
    optional ``steering`` section. Changing a governed rule (via agents/meeting.md) changes the prompt."""
    section = _STEERING_SECTION.format(steering=steering.strip()) if steering.strip() else ""
    return _CARD_FRAME.format(
        lines=lines,
        kinds=", ".join(card_kinds),
        polish=(polish_rules or DEFAULT_POLISH_RULES).strip(),
        tags=(tag_rules or DEFAULT_TAG_RULES).strip(),
        steering=section,
    )


def _extract_json_value(reply: str | None):
    if not reply:
        return None
    text = reply.strip()
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        pass
    import re

    matches = []
    for pattern in (r"\{.*\}", r"\[.*\]"):
        m = re.search(pattern, reply, re.DOTALL)
        if m:
            matches.append((m.start(), m.group(0)))
    for _start, raw in sorted(matches, key=lambda item: item[0]):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError):
            continue
    return None


def parse_cards(reply: str | None, card_kinds: list[str] | None = None) -> list[dict]:
    """Tolerantly pull the JSON card array out of the agent's reply (it may wrap it in prose/fences).
    When ``card_kinds`` is given, only cards of those kinds are kept."""
    value = _extract_json_value(reply)
    if isinstance(value, dict):
        arr = value.get("cards") or []
    elif isinstance(value, list):
        arr = value
    else:
        return []
    allowed = {k.lower() for k in card_kinds} if card_kinds else None
    out = []
    for c in arr:
        if not (isinstance(c, dict) and c.get("title") and c.get("kind")):
            continue
        if allowed is not None and str(c.get("kind")).lower() not in allowed:
            continue
        out.append(c)
    return out


def parse_notes(
    reply: str | None,
    stage_by_id: dict[str, int] | None = None,
    segment_by_id: dict[str, dict] | None = None,
) -> list[dict]:
    """Pull processed transcript notes from the copilot JSON object."""
    value = _extract_json_value(reply)
    if not isinstance(value, dict):
        return []
    arr = value.get("notes") or []
    if not isinstance(arr, list):
        return []
    stages = stage_by_id or {}
    segments = segment_by_id or {}
    out = []
    for item in arr:
        if not isinstance(item, dict):
            continue
        note_id = str(item.get("id") or "").strip()
        if segments and note_id not in segments:
            continue
        text = _first_person_note_text(str(item.get("text") or ""))
        if not note_id or not text:
            continue
        stage = int(item.get("pass") or stages.get(note_id) or 1)
        source = segments.get(note_id) or {}
        note = {
            "id": note_id,
            "speaker": str(item.get("speaker") or "").strip() or "Speaker",
            "chapter": str(item.get("chapter") or item.get("chapter_title") or "").strip(),
            "text": text,
            "pass": max(1, min(3, stage)),
            "frozen": stage >= 3,
        }
        ts = item.get("t", item.get("ts", source.get("start")))
        if ts is not None:
            note["t"] = ts
        out.append(note)
    return out


def _first_person_note_text(text: str) -> str:
    out = " ".join(text.split()).strip()
    rewrites = [
        (re.compile(r"^Speaker\s+mentions\s+using\s+(.+?)\s+and\s+finding\s+(.+?)\s+appealing\.?$", re.I), r"I use \1 and find \2 appealing."),
        (re.compile(r"^Speaker\s+(?:describes|frames)\s+(.+?)\s+as\s+", re.I), r"\1 is "),
        (re.compile(r"^Speaker\s+read\s+more\s+about\s+", re.I), "I read more about "),
        (re.compile(r"^Speaker\s+(?:expresses|has)\s+fear\s+that\s+", re.I), "I'm afraid "),
        (re.compile(r"^Speaker\s+(?:initially\s+)?thought\s+", re.I), "I initially thought "),
        (re.compile(r"^Speaker\s+(?:believes|thinks)\s+(?:that\s+)?", re.I), ""),
        (re.compile(r"^Speaker\s+(?:announces|states|says|notes|reports|explains|emphasizes)\s+(?:that\s+)?", re.I), ""),
        (re.compile(r"^Speaker\s+will\s+", re.I), "I will "),
        (re.compile(r"^Speaker\s+wants\s+", re.I), "I want "),
        (re.compile(r"^Speaker\s+needs\s+", re.I), "I need "),
        (re.compile(r"^Speaker\s+plans\s+to\s+", re.I), "I plan to "),
        (re.compile(r"^Speaker\s+asks\s+", re.I), "I ask "),
        (re.compile(r"^Speaker\s+", re.I), ""),
    ]
    for pattern, replacement in rewrites:
        next_out = pattern.sub(replacement, out, count=1).strip()
        if next_out != out:
            out = next_out
            break
    return out[:1].upper() + out[1:] if out else out


def fallback_processed_notes(segments: list[dict], stage_by_id: dict[str, int] | None = None) -> list[dict]:
    stages = stage_by_id or {}
    notes: list[dict] = []
    for index, segment in enumerate(segments):
        note_id = str(segment.get("segment_id") or segment.get("id") or f"segment-{index + 1}").strip()
        text = _first_person_note_text(str(segment.get("text") or ""))
        if not note_id or not text:
            continue
        stage = max(1, min(3, int(segment.get("rewrite_pass") or stages.get(note_id) or 1)))
        note = {
            "id": note_id,
            "speaker": str(segment.get("speaker") or "").strip() or "Speaker",
            "chapter": "Live Transcript",
            "text": text,
            "pass": stage,
            "frozen": stage >= 3,
        }
        ts = segment.get("start")
        if ts is not None:
            note["t"] = ts
        notes.append(note)
    return notes


def meeting_card_turn(
    work: Path, segments: list[dict], *, model: str | None = None,
    card_kinds: list[str] | None = None, steering: str = "",
    polish_rules: str = DEFAULT_POLISH_RULES, tag_rules: str = DEFAULT_TAG_RULES,
    completion=None,
    raise_on_fallback_error: bool = False,
) -> Iterator[dict]:
    """One copilot beat: polish the recent transcript window + emit a proactive card per salient
    finding, via ONE direct ``CompletionPort`` call. A beat is a pure prompt→text turn — everything
    it needs is already in the prompt window, so there is no harness, no subprocess, and no
    workspace memory (the old tool-granted turn let the model explore the KG every beat — the
    dominant per-beat latency; a direct completion also never auto-loads workspace conventions, so
    steering lives EXCLUSIVELY in agents/meeting.md). The wanted ``card_kinds`` + workspace
    ``steering`` shape the prompt, and cards are filtered to the allowed kinds.

    ``completion`` is injectable; by default it resolves through the ``worker.worker``
    ``completion_factory`` seam (env-selected adapter, ``TINA_LLM_PROVIDER``)."""
    kinds = card_kinds or list(DEFAULT_CARD_KINDS)
    segment_by_id = {str(s.get("segment_id") or s.get("id") or ""): s for s in segments}
    stage_by_id = {seg_id: int(s.get("rewrite_pass") or 1) for seg_id, s in segment_by_id.items()}
    lines = "\n".join(
        f"[pass {int(s.get('rewrite_pass') or 1)}/3 id={s.get('segment_id') or s.get('id') or '?'} "
        f"speaker={s.get('speaker', '?')}] {s.get('text', '')}"
        for s in segments
    )
    prompt = build_card_prompt(lines, kinds, steering, polish_rules=polish_rules, tag_rules=tag_rules)
    # We DON'T forward raw model output as turn events — the JSON reply would leak into the UI as a
    # "note"; the meeting feed wants only the parsed notes/cards.
    try:
        if completion is None:
            import worker.worker as _w
            completion = getattr(_w, "completion_factory", completion_from_env)()
        reply = completion.complete(prompt, model=model).text
    except LLMAuthError as exc:
        # Fail LOUD on a 401/auth mismatch: a distinct auth-error (provider host + the
        # BASE_URL-vs-KEY fix) instead of the opaque generic model-error (WS1b).
        from llm.errors import emit_provider_fallback_marker
        emit_provider_fallback_marker(exc)
        if raise_on_fallback_error:
            raise
        yield auth_error_event(exc, model=model, stage="meeting-card")
        return
    except Exception as exc:
        from llm.errors import emit_provider_fallback_marker, provider_fallback_reason
        if provider_fallback_reason(exc):
            emit_provider_fallback_marker(exc)
            if raise_on_fallback_error:
                raise
        if looks_like_auth_failure(exc):
            yield auth_error_event(exc, model=model, stage="meeting-card")
            return
        yield model_error_event(exc, model=model, stage="meeting-card")
        return
    notes = parse_notes(reply, stage_by_id, segment_by_id)
    cards = parse_cards(reply, kinds)
    if segments and not notes:
        yield _model_error_event("model response did not include processed transcript notes", model=model, stage="meeting-card")
        notes = fallback_processed_notes(segments, stage_by_id)
    for note in notes:
        yield {"type": "note", "note": note}
    for card in cards:
        yield {"type": "card", "card": card}


# ── Auth-B/#3(a): persist the processed transcript to the workspace, INCREMENTALLY ────────────────
# As the worker emits 1:1 cleaned `proc:meeting` notes, it ALSO upserts a per-meeting workspace file at
# kg/entities/meeting/<native>.md so a chat agent focused on the meeting can `Read` it and answer "what's
# the meeting about" — WITHOUT waiting for the post-meeting doc turn. The write is idempotent: each line
# is keyed by its note id (== segment_id) with an HTML-comment marker, so a refining pass UPDATES the
# line in place rather than duplicating it. This reuses the same VISIBLE, git-tracked kg/entities/meeting
# path the post-meeting doc turn authors (the doc turn later distills a summary into the SAME tree).

_PROC_LINE_RE = re.compile(r"^<!-- id:(?P<id>.*?) -->", )


def render_meeting_transcript(meta: dict, notes: list[dict]) -> str:
    """Render the per-meeting transcript file: YAML frontmatter (type/id/title/… from ``meta``), a
    Speakers list, and a Transcript section with one id-keyed line per note. Pure + deterministic so the
    upsert is testable offline."""
    contracts.validate_entity_frontmatter(meta)
    speakers: list[str] = []
    for n in notes:
        sp = str(n.get("speaker") or "Speaker").strip() or "Speaker"
        if sp not in speakers:
            speakers.append(sp)
    frontmatter = yaml.safe_dump(meta, sort_keys=False, allow_unicode=True).strip()
    parts = ["---", frontmatter, "---", "", "## Speakers", ""]
    parts += [f"- {sp}" for sp in speakers] or ["- (none yet)"]
    parts += ["", "## Transcript", ""]
    for n in notes:
        nid = str(n.get("id") or "").strip()
        sp = str(n.get("speaker") or "Speaker").strip() or "Speaker"
        text = " ".join(str(n.get("text") or "").split())
        tags = n.get("tags") or []
        suffix = f"  _[tags: {', '.join(str(t) for t in tags)}]_" if tags else ""
        parts.append(f"<!-- id:{nid} --> **{sp}:** {text}{suffix}")
    return "\n".join(parts) + "\n"


def _workspace_meeting_target(workspace: Path, path: Path) -> Path:
    """Resolve a meeting output path lexically and reject symlinked path components."""
    root = Path(workspace).absolute()
    target = Path(path)
    if not target.is_absolute():
        target = root / target
    try:
        relative = target.relative_to(root)
    except ValueError as exc:
        raise ValueError("meeting output path is outside the workspace") from exc
    if ".." in relative.parts:
        raise ValueError("meeting output path is outside the workspace")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("meeting output path cannot traverse a symlink")
    return target


def persist_envelope(path: Path, envelope: dict, *, workspace: Path) -> None:
    """Persist the SERIALIZED ENVELOPE (the same notes/cards shape redis carries) as the durable render
    source — NOT the prose markdown ``render_meeting_transcript`` produces.

    This is the deterministic dual-source seam: live folds the redis stream, finished reads THIS file,
    and one renderer renders both identically. The serialization is DETERMINISTIC (``indent=2``,
    ``sort_keys=True``) so the persisted file is byte-stable and == the folded live stream."""
    path = _workspace_meeting_target(workspace, path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(envelope, indent=2, sort_keys=True))


def _seed_dir() -> Path:
    """The mounted seed template dir (the envelope SSOT schema lives under ``agents/``). Resolves the
    selected template out of the registry root (env override wins)."""
    from shared.seeding import resolve_seed_dir

    return resolve_seed_dir()


def load_meeting_schema(seed_dir: Path) -> dict | None:
    """Load the envelope SSOT schema at ``{seed_dir}/agents/meeting.schema.json``. Tolerant: a missing
    (or unreadable / malformed) file → None, so behavior is unchanged when the schema is absent."""
    path = Path(seed_dir) / "agents" / "meeting.schema.json"
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def validate_envelope(envelope: dict, seed_dir: Path) -> list[str]:
    """Validate ``envelope`` against the SSOT schema; return a list of error messages (empty == valid).
    Tolerant: a missing schema → ``[]`` (nothing to validate against, so behavior is unchanged)."""
    schema = load_meeting_schema(seed_dir)
    if schema is None:
        return []
    import jsonschema

    validator = jsonschema.Draft202012Validator(schema)
    return [e.message for e in sorted(validator.iter_errors(envelope), key=lambda e: list(e.path))]


def upsert_meeting_transcript_file(path: Path, meta: dict, note: dict, *, workspace: Path) -> None:
    """Idempotently UPSERT one cleaned ``note`` (keyed by ``note['id']``) into the per-meeting transcript
    file at ``path``. Reads the current id-keyed lines, replaces the matching id (or appends a new one),
    preserves order, and rewrites the whole file. Re-running with the same note id never duplicates a
    line; a refining note for an existing id overwrites its text."""
    nid = str(note.get("id") or "").strip()
    if not nid:
        return
    path = _workspace_meeting_target(workspace, path)
    notes: list[dict] = []
    if path.exists():
        try:
            for line in path.read_text().splitlines():
                m = _PROC_LINE_RE.match(line)
                if not m:
                    continue
                rest = line[m.end():].strip()
                # parse "**Speaker:** text"
                sp = "Speaker"
                body = rest
                if rest.startswith("**") and ":**" in rest:
                    sp = rest[2:rest.index(":**")].strip() or "Speaker"
                    body = rest[rest.index(":**") + 3:].strip()
                notes.append({"id": m.group("id"), "speaker": sp, "text": body})
        except OSError:
            notes = []
    replaced = False
    for existing in notes:
        if existing.get("id") == nid:
            existing["speaker"] = note.get("speaker") or existing.get("speaker")
            existing["text"] = note.get("text") or existing.get("text")
            replaced = True
            break
    if not replaced:
        notes.append({"id": nid, "speaker": note.get("speaker") or "Speaker", "text": note.get("text") or ""})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(render_meeting_transcript(meta, notes))


def _set_cursor(stream: _Stream, cursor_key: str | None, raw_id: str) -> None:
    """Freeze the per-meeting processed CURSOR = the last raw transcript stream-id cleaned. Best-effort:
    a fake stream without ``set`` (or a transient redis error) must never break the live beat."""
    if not cursor_key:
        return
    setter = getattr(stream, "set", None)
    if setter is None:
        return
    try:
        setter(cursor_key, str(raw_id))
    except Exception:  # noqa: BLE001 — the cursor is an optimization; never crash the meeting loop
        pass


def _proc_note(segment: dict) -> dict | None:
    """The baseline 1:1 cleaned note for ONE segment — id == segment_id, the speaker, and the cleaned
    text (same first-person cleanup the fallback uses). None when there's nothing to emit (empty text)."""
    notes = fallback_processed_notes([segment])
    return notes[0] if notes else None


def serve_meeting(
    stream: _Stream, *, transcript_stream: str, out_topic: str,
    card_turn: Callable[[list[dict]], Iterator[dict]], idle_ms: int,
    beat_segments: int = 4,
    doc_turn: Callable[[list[dict]], Iterator[dict]] | None = None,
    enabled: bool = True,
    start_id: str = "0",
    proc_stream: str | None = None,
    cursor_key: str | None = None,
    on_proc_note: Callable[[dict], None] | None = None,
    on_envelope: Callable[[dict], None] | None = None,
    proc_params: dict | None = None,
) -> None:
    """Consume the meeting's ``transcript.v1`` Stream (the meetings⊥agent seam — read by schema), gate
    cheaply (a NEW speaker, or ``beat_segments`` segments), and run a copilot beat that XADDs proactive
    cards to ``out_topic``. Live drafts (``completed:false``) are included and upserted by ``segment_id``
    — a refining draft updates its line in place rather than piling up a duplicate. The transcript keeps
    it non-idle; ``session_end`` (or an idle gap) reaps it.

    Cards surfaced across the meeting are accumulated (de-duped by title) and, on ``session_end``,
    handed to ``doc_turn`` — the post-meeting WRITE turn that authors/updates the kg meeting entity.
    """
    seen_speakers: set[str] = set()
    buffer: list[dict] = []
    processing_window: list[dict] = []
    window_by_id: dict[str, dict] = {}  # segment_id → its window item, so a refining draft upserts
    cards: list[dict] = []          # running, de-duped (by title) list of every surfaced card
    seen_titles: set[str] = set()
    notes: list[dict] = []          # running 1:1 cleaned notes (by id), the envelope render source
    notes_by_id: dict[str, dict] = {}
    last = start_id
    n = 0

    def _persist_envelope() -> None:
        """DURABLE RENDER SOURCE (deterministic dual-source): persist the SAME running notes/cards the
        worker already tracks as the envelope, alongside (not replacing) the markdown. Best-effort —
        the render-source mirror is an optimization and must never crash the live loop."""
        if on_envelope is None:
            return
        try:
            on_envelope({"notes": notes, "cards": cards})
        except Exception:  # noqa: BLE001 — render-source mirror is an optimization; never crash the loop
            log.warning("serve_meeting: on_envelope persist failed", exc_info=True)

    mirror_dirty: dict[str, dict] = {}  # note id → latest merged note, awaiting a mirror flush

    def _emit_proc_note(note: dict) -> None:
        """XADD ONE cleaned note (id == segment_id) onto the per-meeting processed STREAM — the ONE
        live carrier of cleaned notes (processed-notes.v1; the SSE tails it, the db-writer persists
        it) — and accumulate it into the running envelope + the mirror batch. The workspace-file and
        envelope mirrors are DERIVED views flushed per beat / at session_end (ADR 0027) — writing
        them per note was an O(n²) rewrite in the hot loop."""
        if not note:
            return
        if proc_stream:
            fields = {"note": json.dumps(note)}
            if proc_params:
                # The processing metadata APPLIED (provider/model/pipeline) rides every entry so the
                # durable consumer (meeting-api db-writer → meeting.data processed views) records
                # reproducible provenance for the view it persists.
                fields["params"] = json.dumps(proc_params)
            stream.xadd(proc_stream, fields)
        # Accumulate the SAME 1:1 cleaned note (keyed by id) into the running envelope notes — a refining
        # pass UPDATES its line in place rather than duplicating, exactly like the markdown upsert.
        nid = str(note.get("id") or "").strip()
        if nid:
            existing = notes_by_id.get(nid)
            if existing is None:
                notes_by_id[nid] = note
                notes.append(note)
            else:
                existing.update(note)
            mirror_dirty[nid] = notes_by_id[nid]

    def _flush_mirror() -> None:
        """Flush the DERIVED views (per beat + session_end): upsert each dirty note into the
        per-meeting workspace file (Auth-B/#3a — a chat agent can Read the meeting mid-flight) and
        re-persist the envelope render source. Best-effort — mirrors never crash the live loop."""
        if on_proc_note is not None:
            for note in mirror_dirty.values():
                try:
                    on_proc_note(note)
                except Exception:  # noqa: BLE001 — the workspace mirror is an optimization
                    log.warning("serve_meeting: on_proc_note upsert failed", exc_info=True)
        if mirror_dirty:
            _persist_envelope()
        mirror_dirty.clear()

    def _run_beat(segs: list[dict], idx: int) -> None:
        tid = f"beat{idx}"
        staged = [{**seg, "rewrite_pass": int(seg.get("_rewrite_passes", 0)) + 1} for seg in segs]
        for ev in card_turn(staged):
            if ev.get("type") == "card":
                _accumulate_card(cards, seen_titles, ev.get("card") or {})
            elif ev.get("type") == "note":
                # The LLM rewrite returned a valid note for this id → UPGRADE the cleaned-stream text
                # (baseline already emitted at ingest; this is the richer pass, still 1:1 by segment_id).
                # Notes ride ONLY processed-notes.v1 — the out-stream is cards + agent activity, per
                # its name (ADR 0027 carrier collapse; the SSE tails the proc stream directly).
                _emit_proc_note(ev.get("note") or {})
                continue
            stream.xadd(out_topic, {"event": json.dumps({**ev, "turn_id": tid})})
        stream.xadd(out_topic, {"event": json.dumps({"type": "turn-complete", "turn_id": tid})})
        sent_ids = {id(seg) for seg in segs}
        for seg in processing_window:
            if id(seg) in sent_ids:
                seg["_rewrite_passes"] = int(seg.get("_rewrite_passes", 0)) + 1
        _flush_mirror()

    while True:
        resp = stream.xread({transcript_stream: last}, count=50, block=idle_ms)
        if not resp:
            return  # transcript idle/ended → reap
        new_speaker = False
        for _name, entries in resp:
            for entry_id, fields in entries:
                last = entry_id
                payload = json.loads(fields.get("payload", "{}"))
                if payload.get("type") == "session_end":
                    mutable = [seg for seg in processing_window if int(seg.get("_rewrite_passes", 0)) < 3]
                    if mutable and enabled:
                        n += 1
                        _run_beat(mutable, n)
                    _flush_mirror()      # ingest-only notes (no beat ran) reach the mirrors too
                    _persist_envelope()  # final durable render source (notes + accumulated cards)
                    # processed-notes.v1 ``view_end`` (ADR 0027): the stream is COMPLETE here — the
                    # final beat has run and every note is emitted. The db-writer flushes the durable
                    # view ON this marker (its bounded deadline covers a worker that dies without one);
                    # the live SSE closes on it. Emitted BEFORE the doc turn (30s+ of LLM the durable
                    # flush must not wait on) and regardless of ``enabled`` (baseline notes flow even
                    # with live beats off — the emit gate is proc_stream, same as _emit_proc_note's).
                    if proc_stream:
                        end_marker: dict = {"type": "view_end"}
                        if last and last != "0":
                            end_marker["cursor"] = str(last)
                        stream.xadd(proc_stream, end_marker)
                    if doc_turn is not None:  # post-meeting WRITE: author/update the kg meeting entity
                        _emit_turn(stream, out_topic, lambda: doc_turn(cards), "meeting-doc")
                    return  # meeting ended → reap
                for seg_index, seg in enumerate(payload.get("segments", [])):
                    sid = seg.get("segment_id") or f"{entry_id}:{seg_index}"
                    existing = window_by_id.get(sid)
                    if existing is not None:
                        # A live draft refining (or finalizing) a segment already in the window: update
                        # it IN PLACE so the next beat reads the latest text, never a duplicate line.
                        # Identity is preserved, so the rewrite-pass bookkeeping still holds.
                        existing["text"] = seg.get("text", existing.get("text"))
                        existing["completed"] = seg.get("completed", True)
                        continue
                    item = dict(seg)
                    item["segment_id"] = sid
                    item["_rewrite_passes"] = 0
                    window_by_id[sid] = item
                    buffer.append(item)
                    processing_window.append(item)
                    # Baseline 1:1 cleaned note onto the processed stream — ALWAYS present per segment,
                    # so the cleaned channel never has a gap even before/without an LLM upgrade beat.
                    base = _proc_note(item)
                    if base is not None:
                        _emit_proc_note(base)
                    sp = seg.get("speaker")
                    if sp and sp not in seen_speakers:
                        seen_speakers.add(sp)
                        new_speaker = True
                # Advance the per-meeting CURSOR to the last raw stream-id we've now cleaned (gap-fill
                # picks up from here on re-enable; OFF freezes it at the last processed entry).
                _set_cursor(stream, cursor_key, entry_id)
        if enabled and buffer and (new_speaker or len(buffer) >= beat_segments):
            n += 1
            mutable = [seg for seg in processing_window if int(seg.get("_rewrite_passes", 0)) < 3]
            if mutable:
                _run_beat(mutable, n)
            processing_window = [seg for seg in processing_window if int(seg.get("_rewrite_passes", 0)) < 3]
            window_by_id = {seg["segment_id"]: seg for seg in processing_window}
            buffer = []


def _accumulate_card(cards: list[dict], seen_titles: set[str], card: dict) -> None:
    """Retain a surfaced card, de-duped by (case-folded) title so re-surfacing across beats doesn't
    duplicate it in the final meeting doc."""
    title = (card.get("title") or "").strip()
    if not title:
        return
    key = title.casefold()
    if key in seen_titles:
        return
    seen_titles.add(key)
    cards.append(card)


def _emit_turn(stream: _Stream, out_topic: str, turn: Callable[[], Iterator[dict]], tid: str) -> None:
    for ev in turn():
        stream.xadd(out_topic, {"event": json.dumps({**ev, "turn_id": tid})})
    stream.xadd(out_topic, {"event": json.dumps({"type": "turn-complete", "turn_id": tid})})


def _emit_beat(stream: _Stream, out_topic: str, card_turn, segments: list[dict], n: int) -> None:
    _emit_turn(stream, out_topic, lambda: card_turn(segments), f"beat{n}")


# ── post-meeting WRITE turn: distill the surfaced cards into the kg meeting entity ────────────────

_CARD_GROUP = {  # card kind → the section it lands under in the doc
    "person": "Attendees", "company": "Companies", "product": "Products",
    "topic": "Topics", "decision": "Decisions", "action": "Actions",
}

MEETING_SUMMARY_PROMPT = (
    "Summarize the ended meeting in 2-4 concise plain-English lines using only these surfaced "
    "entities. Do not invent facts, include raw transcript, or return markdown headings. Return only "
    "the summary text.\n\nEntities (JSON):\n{cards}"
)


def meeting_doc_turn(
    work: Path, cards: list[dict], *, native: str, meeting_id: str, session_uid: str,
    platform: str, date: str, title: str, model: str | None = None,
    completion: CompletionPort | None = None,
) -> Iterator[dict]:
    """Write one schema-validated meeting entity; the model supplies summary text, never file edits."""
    try:
        document_id = safe_meeting_document_id(native)
        workspace = Path(work).resolve()
        target = _workspace_meeting_target(workspace, workspace / 'kg/entities/meeting' / f'{document_id}.md')
        stamp = _workspace_meeting_target(workspace, workspace / '.meeting-generated' / f'{document_id}.sha256')
        with workspace_write_lock(workspace):
            expected = target.read_bytes() if target.exists() else None
            if expected is not None and (not stamp.is_file() or stamp.read_text() != hashlib.sha256(expected).hexdigest()):
                raise FileExistsError('Meeting document contains user edits. Existing content was kept.')
        if completion is None:
            import worker.worker as _w
            completion = getattr(_w, "completion_factory", completion_from_env)()
        summary_result = completion.complete(
            MEETING_SUMMARY_PROMPT.format(cards=json.dumps(cards, ensure_ascii=False)),
            model=model,
        )
    except FileExistsError as exc:
        yield {'type': 'done', 'ok': False, 'reply': str(exc)}
        return
    except LLMAuthError as exc:
        yield auth_error_event(exc, model=model, stage="meeting-doc")
        return
    except Exception as exc:
        if looks_like_auth_failure(exc):
            yield auth_error_event(exc, model=model, stage="meeting-doc")
            return
        yield model_error_event(exc, model=model, stage="meeting-doc")
        return

    summary = html.escape(" ".join(str(summary_result.text or "").split()), quote=False)
    summary = summary.replace("[", "&#91;").replace("]", "&#93;")
    groups: dict[str, list[str]] = {heading: [] for heading in dict.fromkeys(_CARD_GROUP.values())}
    for card in cards:
        if not isinstance(card, dict):
            continue
        heading = _CARD_GROUP.get(str(card.get("kind") or "").lower())
        title_text = " ".join(str(card.get("title") or "").replace("[", "").replace("]", "").split())
        if heading and title_text:
            link_title = html.escape(title_text, quote=False)
            if link_title not in groups[heading]:
                groups[heading].append(link_title)

    sections = [f"## Summary\n\n{summary}"] if summary else []
    for heading, entries in groups.items():
        if entries:
            sections.append(f"## {heading}\n\n" + "\n".join(f"- [[{entry}]]" for entry in entries))
    body = "\n\n".join(sections)
    frontmatter = {
        "type": "meeting",
        "id": document_id,
        "title": title,
        "meeting_id": meeting_id,
        "session_uid": session_uid,
        "platform": platform,
        "date": date,
    }
    try:
        contracts.validate_entity_frontmatter(frontmatter)
        serialized_frontmatter = yaml.safe_dump(frontmatter, sort_keys=False, allow_unicode=True).strip()
        content = f"---\n{serialized_frontmatter}\n---\n\n{body}\n"
        work = Path(work)
        _ensure_repo(work)
        workspace = work.resolve()
        target = _workspace_meeting_target(
            workspace, workspace / "kg" / "entities" / "meeting" / f"{document_id}.md",
        )
        with workspace_write_lock(workspace):
            if (target.read_bytes() if target.exists() else None) != expected:
                raise FileExistsError('Meeting document changed during generation. Existing content was kept.')
            stamp = _workspace_meeting_target(workspace, stamp)
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as out:
                temporary = Path(out.name)
                out.write(content.encode('utf-8'))
            try:
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            stamp.parent.mkdir(parents=True, exist_ok=True)
            stamp.write_text(hashlib.sha256(content.encode('utf-8')).hexdigest())
            relative = target.relative_to(workspace).as_posix()
            sha = commit_workspace_paths(
                workspace, [relative], message=f"meeting summary: {document_id}", author=_principal_author(),
            )
    except FileExistsError as exc:
        yield {'type': 'done', 'ok': False, 'reply': str(exc)}
        return
    except Exception as exc:
        log.warning("meeting document write failed for %s", document_id, exc_info=True)
        yield model_error_event(exc, model=model, stage="meeting-doc")
        return

    yield {"type": "done", "reply": "Meeting document updated.", "ok": True}
    if sha:
        yield {"type": "commit", "sha": sha}
