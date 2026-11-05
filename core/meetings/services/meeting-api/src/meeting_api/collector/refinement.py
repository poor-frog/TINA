"""Owner-only second-pass ASR on explicitly clocked bot recordings. One worker per API process."""
from __future__ import annotations

import asyncio
import copy
import hashlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone
from uuid import uuid4
from typing import Literal
import wave

import httpx
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from .audio_quality import assess_audio
from .transcript_document import Correction, CorrectionConflict, normalize

ACTIVE = ("running", "paused", "cancelling")
TERMINAL = ("completed", "failed")


class RefinementOptions(BaseModel):
    mode: Literal["all", "check", "flagged"] = "all"
    glossary: list[str] = Field(default_factory=list, max_length=40)
    model_config = ConfigDict(extra="forbid")

    @field_validator("glossary")
    @classmethod
    def terms(cls, values):
        terms = list(dict.fromkeys(normalize(v) for v in values))
        if any(not v or len(v) > 80 or any(ord(c) < 32 for c in v) for v in terms) or len(", ".join(terms)) > 700:
            raise ValueError("Use up to 40 vocabulary terms, 80 characters each, 700 characters total")
        return terms


class RefinementApply(BaseModel):
    job_id: str = Field(min_length=1, max_length=128)
    segment_id: str = Field(min_length=1, max_length=512)
    expected_revision: StrictInt = Field(ge=0)
    model_config = ConfigDict(extra="forbid")


def apply_proposal(data, job, sid, correction):
    """Called under the same meeting row lock as the revision write."""
    current = copy.deepcopy(data.get("transcript_refinement"))
    item = next((i for i in (current or {}).get("items", []) if i["segment_id"] == sid), None)
    if not current or current["id"] != job["id"] or current["status"] in ACTIVE or not item or item["state"] != "ready" or item["expected_revision"] != correction.expected_revision or item.get("text") != correction.text:
        raise CorrectionConflict("Suggestion changed; reload before applying")
    item["state"] = "applied"
    data["transcript_refinement"] = current
    return {"kind": "refinement", "job_id": job["id"], "model": job["model"], "audio_sha256": item["audio_sha256"]}


async def selected_backend(user):
    from ..bot_spawn.service import _fetch_bot_context, _transcription_from_context
    selected = _transcription_from_context(await _fetch_bot_context(user))
    if selected.get("disabled"):
        raise ValueError("Transcription is stopped for this account; start it in Settings")
    if selected.get("backend") in ("apple", "nvidia", "funasr", "sherpa", "gipformer", "viegem", "custom") and not selected.get("url"):
        raise ValueError("Selected transcription backend is not configured")
    if selected.get("url"):
        return {"url": selected["url"], "token": selected.get("token") or "", "model": selected.get("model") or "whisper-1", "label": selected.get("backend") or "custom"}
    return {"url": os.getenv("TRANSCRIPTION_SERVICE_URL", ""), "token": os.getenv("TRANSCRIPTION_SERVICE_TOKEN", ""), "model": os.getenv("TRANSCRIPTION_MODEL", "whisper-1"), "label": "deployment"}


def _decode(path, start, duration):
    try:
        proc = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-ss", str(start), "-i", str(path),
                               "-t", str(duration), "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"],
                              capture_output=True, timeout=30, check=True)
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError("Recording cannot be decoded") from exc
    pcm = proc.stdout
    if len(pcm) < int(duration * 16000 * 2) - 640:
        raise ValueError("Recording does not cover the segment")
    out = io.BytesIO()
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000); wav.writeframes(pcm)
    return out.getvalue()


class BotRefiner:
    def __init__(self, store, repo, storage, backend=selected_backend):
        self.store, self.repo, self.storage, self.backend = store, repo, storage, backend
        self.active = None
        self.task = None
        self.lock = asyncio.Lock()

    async def current(self, user, mid):
        if self.active and self.active[0:2] == (user, mid):
            return copy.deepcopy(self.active[2])
        job = await self.store.get_refinement(user, mid)
        if job and job["status"] in ACTIVE:
            job["status"] = "interrupted"
            job["error"] = "Worker restarted; start refinement again for unfinished segments."
            await self.store.save_refinement(user, mid, job)
        return job

    async def clip(self, user, mid, sid, cache=None):
        doc = await self.store.get_transcript_document(user, mid)
        segment = next((s for s in (doc or {}).get("segments", []) if s["segment_id"] == sid), None)
        spans = (segment or {}).get("audio", [])
        if len(spans) != 1 or spans[0]["kind"] != "recording-span":
            raise ValueError("No unambiguous clocked recording for this segment")
        span = spans[0]
        duration = (span["end_ms"] - span["start_ms"]) / 1000
        if not 0 < duration <= 30:
            raise ValueError("Segments longer than 30 seconds need alignment before refinement")
        if await self.repo.owner_of(mid) != user:
            raise ValueError("Recording not found")
        from ..recordings.service import finalize_master
        rid = span["recording_id"]
        recordings = await self.repo.get_recordings(mid)
        recording = next((r for r in recordings if r["id"] == rid and r.get("status") == "completed" and r.get("session_uid") == span["session_id"]), None)
        if not recording:
            raise ValueError("Recording is no longer available")
        media = next((m for m in recording.get("media_files", []) if m.get("type") == "audio"), {})
        if media.get("chunk_seq") is not None:
            prefix = (media.get("storage_path") or "").rsplit("/", 1)[0]
            keys = [k for k in await self.storage.list(prefix) if not k.rsplit("/", 1)[-1].startswith("master.")]
            sequences = sorted(int(Path(k).stem) for k in keys if Path(k).stem.isdecimal())
            if sequences != list(range(int(media["chunk_seq"]) + 1)):
                raise ValueError("Recording has missing chunks; audio timing is not safe for refinement")
        key = await finalize_master(self.repo, self.storage, meeting_id=mid, recording_id=rid)
        if not key:
            raise ValueError("Recording master is unavailable")
        # shortcut: bounded master download per recording, add ranged decoding for recordings >256 MiB.
        size = await self.storage.size(key)
        if size > 256 * 1024 ** 2:
            raise ValueError("Recording exceeds the 256 MiB refinement limit")
        if cache is not None and key not in cache and size + sum(p.stat().st_size for p in cache.values() if isinstance(p, Path)) > 512 * 1024 ** 2:
            raise ValueError("Recording cache exceeds the 512 MiB job limit")
        with tempfile.TemporaryDirectory(prefix="tina-refinement-") as directory:
            path = Path(directory) / "source"
            if cache is not None and key in cache:
                path = cache[key]
            else:
                target = Path(cache["directory"]) / str(rid) if cache is not None else path
                target.write_bytes(await self.storage.get(key))
                path = target
                if cache is not None:
                    cache[key] = path
            return await asyncio.to_thread(_decode, path, span["start_ms"] / 1000, duration)

    async def start(self, user, mid, options):
        async with self.lock:
            if (self.active or getattr(getattr(self, "diarizer", None), "active", None)
                    or getattr(getattr(self, "aligner", None), "active", None) or await self.store.refinement_live()):
                raise CorrectionConflict("Wait for live meetings and the current refinement to stop")
            doc = await self.store.get_transcript_document(user, mid)
            if not doc or doc["status"] not in TERMINAL:
                raise CorrectionConflict("Stop the meeting before refinement")
            if not doc["segments"]:
                raise ValueError("No confirmed transcript to refine")
            if len(doc["segments"]) > 2000:
                raise ValueError("Refinement is limited to 2000 segments per meeting")
            config = {"model": "", "label": "audio-check", "url": "", "token": ""} if options.mode == "check" else await self.backend(user)
            if options.mode != "check" and not config.get("url"):
                raise ValueError("No transcription backend configured")
            await self.current(user, mid)
            job = {"version": "transcript-refinement.v1", "id": str(uuid4()), "meeting": str(mid), "status": "running",
                   "model": config["model"], "backend": config["label"], "created_at": datetime.now(timezone.utc).isoformat(),
                   "glossary": options.glossary, "mode": options.mode,
                   "items": [{"segment_id": s["segment_id"], "expected_revision": s["revision"], "state": "pending"} for s in doc["segments"]]}
            source_texts = {s["segment_id"]: s["text"] for s in doc["segments"]}
            previous_job = await self.store.get_refinement(user, mid)
            await self.store.save_refinement(user, mid, job, expected_job_id=previous_job["id"] if previous_job else None)
            self.active = (user, mid, job)
            self.task = asyncio.create_task(self.run(user, mid, job, config, source_texts))
            return copy.deepcopy(job)

    async def run(self, user, mid, job, config, source_texts=None):
        try:
            url = config["url"].rstrip("/")
            if not url.endswith("/audio/transcriptions"):
                url += "/audio/transcriptions" if url.endswith("/v1") else "/v1/audio/transcriptions"
            headers = {"Authorization": "Bearer " + config["token"]} if config["token"] else {}
            with tempfile.TemporaryDirectory(prefix="tina-refinement-job-") as directory:
                cache = {"directory": directory}
                async with httpx.AsyncClient(timeout=30, follow_redirects=False) as client:
                    for item in job["items"]:
                        while await self.store.refinement_live() and job["status"] != "cancelling":
                            job["status"] = "paused"; await self.store.save_refinement(user, mid, job)
                            await asyncio.sleep(.5)
                        if job["status"] == "cancelling":
                            break
                        job["status"] = "running"
                        try:
                            audio = await self.clip(user, mid, item["segment_id"], cache)
                            item["quality"] = await asyncio.to_thread(assess_audio, audio, (source_texts or {}).get(item["segment_id"], ""))
                            item["audio_sha256"] = hashlib.sha256(audio).hexdigest()
                        except (ValueError, FileNotFoundError, KeyError):
                            item.update(state="skipped", reason="Audio is missing, ambiguous, unclocked, beyond the recording, longer than 30 seconds or exceeds size limits.")
                        else:
                            if job.get("mode") == "check" or (job.get("mode") == "flagged" and not item["quality"]["needs_review"]):
                                item.update(state="checked", reason="Audio checked; no ASR requested." if job.get("mode") == "check" else "No configured review flags; ASR skipped.")
                                await self.store.save_refinement(user, mid, job)
                                continue
                            try:
                                # Preparing saved audio can outlast a cancel or the start of a live meeting.
                                while await self.store.refinement_live() and job["status"] != "cancelling":
                                    job["status"] = "paused"; await self.store.save_refinement(user, mid, job)
                                    await asyncio.sleep(.5)
                                if job["status"] == "cancelling":
                                    break
                                job["status"] = "running"
                                fields = {"model": config["model"], "response_format": "json"}
                                if job["glossary"]:
                                    fields["prompt"] = "Vocabulary: " + ", ".join(job["glossary"])
                                response = await client.post(url, headers=headers, data=fields, files={"file": ("segment.wav", audio, "audio/wav")})
                                response.raise_for_status()
                                text = normalize(response.json().get("text") or "")
                                if not text or len(text) > 10000:
                                    raise ValueError("Invalid ASR result")
                                if job["status"] == "cancelling":
                                    break
                                item.update(state="ready", text=text, audio_sha256=hashlib.sha256(audio).hexdigest())
                            except Exception:
                                item.update(state="failed", reason="ASR failed or returned empty text; original transcript is unchanged.")
                        await self.store.save_refinement(user, mid, job)
            job["status"] = "cancelled" if job["status"] == "cancelling" else "completed" if any(i["state"] in ("ready", "checked") for i in job["items"]) else "failed"
        except asyncio.CancelledError:
            job["status"] = "interrupted"
        except Exception:
            job["status"] = "failed"; job["error"] = "Refinement stopped; original transcript is unchanged."
        finally:
            try:
                await self.store.save_refinement(user, mid, job)
            finally:
                self.active = None

    async def cancel(self, user, mid):
        if self.active and self.active[0:2] == (user, mid):
            self.active[2]["status"] = "cancelling"
            await self.store.save_refinement(user, mid, self.active[2])
        return await self.current(user, mid)

    async def apply(self, user, mid, update):
        doc = await self.store.get_transcript_document(user, mid)
        job = await self.current(user, mid)
        item = next((i for i in (job or {}).get("items", []) if i["segment_id"] == update.segment_id), None)
        if not doc or doc["status"] not in TERMINAL or not job or job["id"] != update.job_id or job["status"] in ACTIVE or not item or item["state"] != "ready" or item["expected_revision"] != update.expected_revision:
            raise CorrectionConflict("Suggestion is unavailable or changed; reload before applying")
        audio = await self.clip(user, mid, update.segment_id)
        if hashlib.sha256(audio).hexdigest() != item["audio_sha256"]:
            raise CorrectionConflict("Source audio changed; run refinement again")
        return await self.store.correct_transcript(user, mid, update.segment_id,
                                                  Correction(expected_revision=update.expected_revision, text=item["text"]), job)

    async def close(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await self.task
