import asyncio
import io
import math
import wave

import httpx
import pytest
from fastapi import FastAPI

from meeting_api.collector.app import build_router
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.collector.refinement import BotRefiner, RefinementOptions
from meeting_api.collector.transcript_document import document
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,code", [
    (401, "asr_auth"), (403, "asr_auth"), (429, "asr_busy"), (503, "asr_busy"),
    (500, "asr_unavailable"), (400, "asr_rejected"), ("timeout", "asr_timeout"),
    ("connection", "asr_unavailable"), ("invalid", "asr_invalid_response"),
])
async def test_safe_failure_reason_and_manual_retry(monkeypatch, failure, code):
    client, store, _, worker, _ = await fixture(monkeypatch)
    async def clip(*args):
        return audio()
    monkeypatch.setattr(worker, "clip", clip)
    attempts = []
    def infer(request):
        attempts.append(request)
        if len(attempts) > 1:
            return httpx.Response(200, json={"text": "API thứ Sáu."})
        if failure == "timeout":
            raise httpx.ReadTimeout("private-token in upstream URL", request=request)
        if failure == "connection":
            raise httpx.ConnectError("private-token in upstream URL", request=request)
        if failure == "invalid":
            return httpx.Response(200, json={"text": {"credential": "private-token"}})
        return httpx.Response(failure, text="private-token in provider response")
    original = type(client)
    monkeypatch.setattr("meeting_api.collector.refinement.httpx.AsyncClient", lambda **kw: original(transport=httpx.MockTransport(infer), **kw))
    async with client:
        path = "/transcripts/by-id/1/refinement/start"
        await client.post(path, json={})
        await worker.task
        job = await worker.current(7, 1)
        assert job["items"][0]["error_code"] == code
        assert job["items"][0]["retryable"] is True
        assert "private-token" not in str(job)
        assert len(attempts) == 1  # No automatic retry.
        if failure == 401:
            async def refreshed_backend(user):
                return {"url":"http://asr.test","model":"custom","label":"funasr","token":"refreshed-private-token"}
            monkeypatch.setattr(worker, "backend", refreshed_backend)
        assert (await client.post(path, json={"retry_job_id": job["id"]}, headers={"x-user-id":"8"})).status_code == 404
        result = await client.post(path, json={"retry_job_id": job["id"]})
        assert result.status_code == 202, result.text
        await worker.task
        retried = await worker.current(7, 1)
        assert retried["id"] != job["id"] and retried["retry_of"] == job["id"]
        item = retried["items"][0]
        assert item["state"] == "ready" and item["attempts"] == 2
        assert "error_code" not in item and len(attempts) == 2
        if failure == 401:
            assert attempts[-1].headers["authorization"] == "Bearer refreshed-private-token"
            assert "refreshed-private-token" not in str(retried)
        assert (await store.get_transcript_document(7, 1))["segments"][0]["revision"] == 0


@pytest.mark.asyncio
async def test_retry_keeps_ready_applied_and_checked_items(monkeypatch):
    import copy
    client, store, _, worker, _ = await fixture(monkeypatch)
    segments = store._meetings[1]["segments"]
    segments["s/1"]["text"] = "má má má má"
    for sid in ("ready", "applied", "checked"):
        segments[sid] = {**segments["s/1"], "segment_id": sid, "text": "normal speech" if sid == "checked" else "má má má má"}
    async def clip(*args):
        return audio()
    monkeypatch.setattr(worker, "clip", clip)
    attempts = []
    def infer(request):
        attempts.append(request)
        return httpx.Response(503) if len(attempts) == 1 else httpx.Response(200, json={"text":"proposal"})
    original = type(client)
    monkeypatch.setattr("meeting_api.collector.refinement.httpx.AsyncClient", lambda **kw: original(transport=httpx.MockTransport(infer), **kw))
    async with client:
        base = "/transcripts/by-id/1/refinement"
        await client.post(base + "/start", json={"mode":"flagged"})
        await worker.task
        job = await worker.current(7, 1)
        assert (await client.post(base + "/apply", json={"job_id":job["id"],"segment_id":"applied","expected_revision":0})).status_code == 200
        job = await worker.current(7, 1)
        kept = copy.deepcopy(job["items"][1:])
        assert [i["state"] for i in kept] == ["ready","applied","checked"]
        assert (await client.post(base + "/start", json={"retry_job_id":job["id"]})).status_code == 202
        await worker.task
        retried = await worker.current(7, 1)
        assert retried["items"][1:] == kept
        assert retried["items"][0]["state"] == "ready" and len(attempts) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["revision", "audio", "backend", "job", "live", "options"])
async def test_retry_refuses_stale_source_or_changed_configuration(monkeypatch, change):
    client, store, _, worker, _ = await fixture(monkeypatch)
    sample = audio()
    async def clip(*args):
        return sample
    monkeypatch.setattr(worker, "clip", clip)
    calls = []
    def infer(request):
        calls.append(request)
        return httpx.Response(503)
    original = type(client)
    monkeypatch.setattr("meeting_api.collector.refinement.httpx.AsyncClient", lambda **kw: original(transport=httpx.MockTransport(infer), **kw))
    async with client:
        path = "/transcripts/by-id/1/refinement/start"
        await client.post(path, json={})
        await worker.task
        job = await worker.current(7, 1)
        payload = {"retry_job_id": job["id"]}
        if change == "revision":
            await client.patch("/transcripts/by-id/1/segments/s%2F1", json={"expected_revision":0,"text":"manual edit"})
        elif change == "audio":
            sample = audio(20)
        elif change == "backend":
            async def backend(user):
                return {"url":"http://different.test","model":"custom","label":"funasr","token":"private"}
            monkeypatch.setattr(worker, "backend", backend)
        elif change == "job":
            payload["retry_job_id"] = "outdated-job"
        elif change == "live":
            store.seed_meeting(user_id=8,platform="google_meet",native_meeting_id="live",meeting_id=2,status="active")
        elif change == "options":
            payload["glossary"] = ["override"]
        result = await client.post(path, json=payload)
        if change in ("revision", "audio"):
            assert result.status_code == 202
            await worker.task
            item = (await worker.current(7, 1))["items"][0]
            assert item["state"] == "skipped" and item["error_code"] == "source_changed" and not item["retryable"]
        else:
            assert result.status_code == (422 if change == "options" else 409), result.text
        assert len(calls) == 1


@pytest.mark.asyncio
async def test_retry_does_not_resume_unattempted_items_and_rejects_duplicate_click(monkeypatch):
    client, store, _, worker, _ = await fixture(monkeypatch)
    async def clip(*args):
        return audio()
    monkeypatch.setattr(worker, "clip", clip)
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []
    async def infer(request):
        calls.append(request)
        if len(calls) == 1:
            return httpx.Response(503)
        entered.set()
        await release.wait()
        return httpx.Response(200, json={"text":"recovered"})
    original = type(client)
    monkeypatch.setattr("meeting_api.collector.refinement.httpx.AsyncClient", lambda **kw: original(transport=httpx.MockTransport(infer), **kw))
    async with client:
        path = "/transcripts/by-id/1/refinement/start"
        await client.post(path, json={})
        await worker.task
        job = await worker.current(7, 1)
        # A cancelled/crashed job can have items that were never submitted.
        job["status"] = "interrupted"
        job["items"].append({"segment_id":"unattempted","expected_revision":0,"state":"pending"})
        store._meetings[1]["data"]["transcript_refinement"] = job
        payload = {"retry_job_id":job["id"]}
        assert (await client.post(path, json=payload)).status_code == 202
        try:
            await asyncio.wait_for(entered.wait(), 2)
            assert (await client.post(path, json=payload)).status_code == 409
        finally:
            release.set()
            await worker.task
        retried = await worker.current(7, 1)
        assert len(calls) == 2 and retried["items"][1]["state"] == "skipped"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,amplitude,expected_calls,state", [
    ("check", 1000, 0, "checked"), ("flagged", 1000, 0, "checked"),
    ("flagged", 10, 1, "ready"), ("all", 1000, 1, "ready"),
])
async def test_quality_modes_preserve_original(monkeypatch, mode, amplitude, expected_calls, state):
    client, store, _, worker, calls = await fixture(monkeypatch)
    async def clip(*args):
        return audio(amplitude)
    monkeypatch.setattr(worker, "clip", clip)
    if mode == "check":
        async def unavailable_backend(user):
            raise AssertionError("Audio checks must not resolve ASR credentials")
        monkeypatch.setattr(worker, "backend", unavailable_backend)
    async with client:
        assert (await client.post("/transcripts/by-id/1/refinement/start", json={"mode": mode})).status_code == 202
        await worker.task
        job = await worker.current(7, 1)
        assert job["status"] == "completed", job
        item = job["items"][0]
        assert item["state"] == state
        assert item["quality"]["needs_review"] == (amplitude == 10)
        assert len(calls) == expected_calls
        assert (await store.get_transcript_document(7, 1))["segments"][0]["revision"] == 0
        if state == "checked":
            result = await client.post("/transcripts/by-id/1/refinement/apply", json={"job_id": job["id"], "segment_id": "s/1", "expected_revision": 0})
            assert result.status_code == 409


def test_quality_is_advisory_and_preserves_vietnamese_accents():
    from meeting_api.collector.audio_quality import assess_audio
    assert assess_audio(audio(0), "hello")["reasons"] == ["low_volume", "mostly_quiet"]
    assert not assess_audio(audio(), "ma má mà mạ")["needs_review"]
    assert "repetition" in assess_audio(audio(), "má má má má")["reasons"]
    assert "clipping" in assess_audio(audio(32767), "speech")["reasons"]
    with pytest.raises((ValueError, EOFError, wave.Error)):
        assess_audio(b"not audio", "")

ORIGIN = 1792522376000
HEADERS = {"x-user-id": "7"}


def audio(amplitude=1000):
    out = io.BytesIO()
    import struct
    with wave.open(out, "wb") as wav:
        wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(16000)
        wav.writeframes(b"".join(struct.pack("<h", int(amplitude * math.sin(i * .1))) for i in range(16000 * 3)))
    return out.getvalue()


async def fixture(monkeypatch):
    store = InMemoryTranscriptStore()
    store.seed_meeting(user_id=7, platform="google_meet", native_meeting_id="abc", meeting_id=1, status="completed", segments=[
        {"segment_id": "s/1", "speaker": "You", "text": "api thu sau", "start": ORIGIN / 1000 + .5,
         "end": ORIGIN / 1000 + 1.5, "session_uid": "session", "completed": True}])
    recording = {"id": 9, "session_uid": "session", "status": "completed", "audio_start_ms": ORIGIN,
                 "media_files": [{"id": 8, "type": "audio", "format": "wav", "is_final": True,
                                  "storage_path": "r/audio/master.wav"}], "playback_url": {"audio": "/recordings/9/master"}}
    store._meetings[1]["data"]["recordings"] = [recording]
    repo, storage = InMemoryRecordingRepo(), InMemoryStorage()
    repo.seed(meeting_id=1, user_id=7, session_uid="session", status="completed")
    await repo.put_recordings(1, [recording])
    await storage.upload("r/audio/master.wav", audio(), content_type="audio/wav")
    async def backend(user):
        return {"url": "http://asr.test", "model": "custom", "label": "funasr", "token": "private"}
    calls = []
    def infer(request):
        calls.append(request)
        assert request.headers["authorization"] == "Bearer private"
        return httpx.Response(200, json={"text": "API thứ Sáu."})
    original = httpx.AsyncClient
    # Only the ASR worker gets this transport; the API client below uses the captured constructor.
    monkeypatch.setattr("meeting_api.collector.refinement.httpx.AsyncClient", lambda **kw: original(transport=httpx.MockTransport(infer), **kw))
    refiner = BotRefiner(store, repo, storage, backend)
    app = FastAPI(); app.include_router(build_router(store, None, refiner=refiner))
    return original(transport=httpx.ASGITransport(app=app), base_url="http://api.test", headers=HEADERS), store, storage, refiner, calls


@pytest.mark.asyncio
async def test_bot_recording_review_apply_restore_and_owner_boundaries(monkeypatch):
    client, store, storage, worker, calls = await fixture(monkeypatch)
    path = "/transcripts/by-id/1"
    async with client:
        doc = (await client.get(path + "/document")).json()
        span = doc["segments"][0]["audio"][0]
        assert span == {"kind": "recording-span", "recording_id": 9, "session_id": "session", "start_ms": 500, "end_ms": 1500}
        assert (await client.get(path + "/document", headers={"x-user-id": "8"})).status_code == 404
        for suffix in ["/refinement", "/segments/s%2F1/audio"]:
            assert (await client.get(path + suffix, headers={"x-user-id": "8"})).status_code == 404
        clip = await client.get(path + "/segments/s%2F1/audio")
        assert clip.status_code == 200 and clip.headers["content-type"] == "audio/wav"
        with wave.open(io.BytesIO(clip.content)) as wav:
            assert wav.getnframes() == 16000
        result = await client.post(path + "/refinement/start", json={"glossary": ["TINA", "API"]})
        assert result.status_code == 202, result.text
        await worker.task
        job = (await client.get(path + "/refinement")).json()
        assert job["status"] == "completed", job
        assert job["glossary"] == ["TINA", "API"]
        assert b"Vocabulary: TINA, API" in calls[0].content
        assert b'name="language"' not in calls[0].content
        assert (await client.get(path + "/document")).json()["segments"][0]["revision"] == 0
        update = {"job_id": job["id"], "segment_id": "s/1", "expected_revision": 0}
        assert (await client.post(path + "/refinement/apply", json=update, headers={"x-user-id": "8"})).status_code == 404
        applied = await client.post(path + "/refinement/apply", json=update)
        assert applied.status_code == 200, applied.text
        segment = applied.json()["segments"][0]
        assert segment["text"] == "API thứ Sáu." and segment["raw_text"] == "api thu sau"
        assert segment["history"][0]["kind"] == "refinement"
        assert len(segment["history"][0]["audio_sha256"]) == 64
        assert (await client.post(path + "/refinement/apply", json=update)).status_code == 409
        restored = await client.patch(path + "/segments/s%2F1", json={"expected_revision": 1, "text": None})
        assert restored.json()["segments"][0]["text"] == "api thu sau"
        assert "transcript_refinement" not in (await client.get(path)).json()["data"]
        # CAS must reject a manual edit made since the proposal, even with the right source hash.
        await client.post(path + "/refinement/start", json={})
        await worker.task
        job = await worker.current(7, 1)
        await client.patch(path + "/segments/s%2F1", json={"expected_revision": 2, "text": "manual"})
        update.update(job_id=job["id"], expected_revision=2)
        assert (await client.post(path + "/refinement/apply", json=update)).status_code == 409
        assert (await client.get(path + "/document")).json()["segments"][0]["text"] == "manual"
        assert (await worker.current(7, 1))["items"][0]["state"] == "ready"


@pytest.mark.asyncio
async def test_missing_ambiguous_changed_source_and_restarts(monkeypatch):
    client, store, storage, worker, _ = await fixture(monkeypatch)
    path = "/transcripts/by-id/1"
    async with client:
        await client.post(path + "/refinement/start", json={})
        await worker.task
        job = await worker.current(7, 1)
        await storage.upload("r/audio/master.wav", audio(2000), content_type="audio/wav")
        response = await client.post(path + "/refinement/apply", json={"job_id": job["id"], "segment_id": "s/1", "expected_revision": 0})
        assert response.status_code == 409
        store._meetings[1]["data"]["recordings"][0].pop("audio_start_ms")
        await client.post(path + "/refinement/start", json={})
        await worker.task
        assert (await worker.current(7, 1))["items"][0]["state"] == "skipped"
        assert (await client.get(path + "/segments/s%2F1/audio")).status_code == 404
        job["status"] = "running"
        store._meetings[1]["data"]["transcript_refinement"] = job  # Simulate persisted state left by a crashed process.
        restarted = BotRefiner(store, worker.repo, storage)
        assert (await restarted.current(7, 1))["status"] == "interrupted"
        store._meetings[1]["status"] = "active"
        assert (await client.post(path + "/refinement/start", json={})).status_code == 409
        for invalid in [{"glossary": ["x" * 81]}, {"glossary": [""]}, {"glossary": "TINA"}, {"url": "http://untrusted"}]:
            assert (await client.post(path + "/refinement/start", json=invalid)).status_code == 422


def test_legacy_and_ambiguous_recordings_are_not_guessed():
    rec = {"id": 1, "status": "completed", "session_uid": "a", "audio_start_ms": ORIGIN, "media_files": [{"type": "audio"}]}
    seg = {"segment_id": "s", "text": "x", "start": ORIGIN / 1000 + 1, "end": ORIGIN / 1000 + 2}
    assert len(document({"id": 1, "segments": [seg], "recordings": [rec, {**rec, "id": 2}]}, {})["segments"][0]["audio"]) == 2
    assert document({"id": 1, "segments": [{**seg, "start": 1, "end": 2}], "recordings": [rec]}, {})["segments"][0]["audio"] == []


@pytest.mark.asyncio
async def test_recording_upload_preserves_origin_and_rejects_clock_changes_before_overwrite():
    from meeting_api.recordings.service import upload_chunk
    repo, storage = InMemoryRecordingRepo(), InMemoryStorage()
    repo.seed(meeting_id=1, user_id=7, session_uid="session", status="completed")
    await upload_chunk(repo, storage, token_meeting_id=1, session_uid="session", data=b"first", chunk_seq=0, is_final=False, audio_start_ms=ORIGIN)
    recordings = await repo.get_recordings(1)
    assert recordings[0]["audio_start_ms"] == ORIGIN
    before = dict(storage.blobs)
    with pytest.raises(ValueError):
        await upload_chunk(repo, storage, token_meeting_id=1, session_uid="session", data=b"bad", chunk_seq=0, is_final=False, audio_start_ms=ORIGIN + 100)
    assert storage.blobs == before
    for invalid in [True, "clock", float("nan"), -1]:
        with pytest.raises(ValueError):
            await upload_chunk(repo, storage, token_meeting_id=1, session_uid="session", data=b"bad", chunk_seq=1, is_final=False, audio_start_ms=invalid)
    assert storage.blobs == before


def test_proposals_are_private_on_lists_shared_responses_and_webhooks():
    from meeting_api.webhooks.delivery import clean_meeting_data, is_event_enabled
    from meeting_api.collector.projection import project_response_data, project_list_data
    data = {"title": "meeting", "transcript_refinement": {"items": [{"text": "private suggestion"}]}}
    assert "transcript_refinement" not in clean_meeting_data(data)
    assert "transcript_refinement" not in project_response_data(data, viewer_is_owner=True)
    assert "transcript_refinement" not in project_response_data(data, viewer_is_owner=False)
    assert "transcript_refinement" not in project_list_data(data)
    assert not is_event_enabled(None, "transcript_refinement")


def test_long_provider_language_labels_do_not_block_durable_segment_storage():
    from meeting_api.collector.adapters import _storage_language
    assert _storage_language("vi") == "vi"
    assert _storage_language("Vietnamese") == "Vietnamese"
    assert _storage_language("EnglishChinese") is None
    assert _storage_language("VietnameseEnglish") is None
    assert _storage_language(None) is None


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["cancel", "live_resume", "live_cancel", "cancel_during_live_check"])
async def test_recheck_cancel_and_live_meetings_after_audio_preparation(monkeypatch, action):
    client, store, _, worker, calls = await fixture(monkeypatch)
    prepared, release, paused = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original_clip, original_save, original_live = worker.clip, store.save_refinement, store.refinement_live
    clip_calls = 0

    async def clip(*args):
        nonlocal clip_calls
        clip_calls += 1
        result = await original_clip(*args)
        prepared.set()
        await release.wait()
        return result

    async def save(*args, **kwargs):
        await original_save(*args, **kwargs)
        if args[2]["status"] == "paused":
            paused.set()

    async def live():
        if action == "cancel_during_live_check" and release.is_set():
            worker.active[2]["status"] = "cancelling"
        return await original_live()

    monkeypatch.setattr(worker, "clip", clip)
    monkeypatch.setattr(store, "save_refinement", save)
    monkeypatch.setattr(store, "refinement_live", live)
    try:
        response = await client.post("/transcripts/by-id/1/refinement/start", json={})
        assert response.status_code == 202
        await asyncio.wait_for(prepared.wait(), 5)
        if action == "cancel":
            await worker.cancel(7, 1)
        elif action.startswith("live_"):
            store.seed_meeting(user_id=8, meeting_id=2, platform="google_meet",
                               native_meeting_id="live", status="active")
        release.set()
        if action.startswith("live_"):
            await asyncio.wait_for(paused.wait(), 2)
            assert calls == []
            if action == "live_resume":
                store._meetings[2]["status"] = "completed"
            else:
                await worker.cancel(7, 1)
        await asyncio.wait_for(worker.task, 5)
        job = await worker.current(7, 1)
        assert job["status"] == ("completed" if action == "live_resume" else "cancelled")
        assert len(calls) == (1 if action == "live_resume" else 0)
        assert clip_calls == 1
    finally:
        release.set()
        if worker.task and not worker.task.done():
            worker.task.cancel()
            await worker.task
        await client.aclose()
