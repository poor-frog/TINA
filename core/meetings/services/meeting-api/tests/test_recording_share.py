import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.collector import create_app
from meeting_api.collector.fakes import InMemoryTranscriptStore
from meeting_api.recordings import build_router, upload_chunk
from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage
from test_recordings import _wav


def _rig(include_recordings=True):
    transcripts = InMemoryTranscriptStore()
    mid = transcripts.seed_meeting(user_id=7, platform="google_meet", native_meeting_id="abc-defg-hij")
    collector = TestClient(create_app(transcripts, redis=None))
    minted = collector.post(f"/meetings/{mid}/share", headers={"x-user-id": "7"}, json={
        "mode": "restricted", "allowed_emails": ["guest@outside.test"],
        "include_recordings": include_recordings,
    })
    assert minted.status_code == 200
    recordings, storage = InMemoryRecordingRepo(), InMemoryStorage()
    recordings.seed(meeting_id=mid, user_id=7, session_uid="saved-audio", status="completed")
    recordings._meetings[mid]["share_grants"] = transcripts._meetings[mid]["data"]["share_grants"]
    receipt = asyncio.run(upload_chunk(
        recordings, storage, token_meeting_id=mid, session_uid="saved-audio",
        data=_wav(), media_format="wav", chunk_seq=0, is_final=True))
    app = FastAPI()
    app.include_router(build_router(recordings, storage, token_secret="test-key"))
    return collector, TestClient(app), receipt["recording_id"], minted.json()["token"], transcripts, mid


def _accept(collector, token, email="guest@outside.test", uid="8"):
    return collector.post("/transcripts/share/accept", json={"token": token},
                          headers={"x-user-id": uid, "x-user-email": email})


def test_recipient_redeems_their_email_before_playback_and_cannot_delete():
    collector, client, rid, token, _, _ = _rig()
    headers = {"x-user-id": "8"}
    assert client.get(f"/recordings/{rid}", headers=headers).status_code == 404
    assert _accept(collector, token, "wrong@outside.test").status_code == 403
    assert _accept(collector, token).status_code == 200
    assert client.get(f"/recordings/{rid}", headers=headers).status_code == 200
    master = client.get(f"/recordings/{rid}/master?type=audio", headers=headers)
    assert master.status_code == 200
    audio = client.get(master.json()["raw_url"], headers=headers)
    assert audio.status_code == 200 and audio.content == _wav()
    assert client.delete(f"/recordings/{rid}", headers=headers).status_code == 404
    assert client.get(f"/recordings/{rid}", headers={"x-user-id": "9"}).status_code == 404


def test_transcript_only_share_does_not_grant_recordings():
    collector, client, rid, token, _, _ = _rig(False)
    assert _accept(collector, token).status_code == 200
    assert client.get(f"/recordings/{rid}", headers={"x-user-id": "8"}).status_code == 404


@pytest.mark.parametrize("change", [
    {"revoked": True}, {"expires_at": (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()},
    {"expires_at": "invalid"},
])
def test_recording_reads_recheck_revocation_and_expiry(change):
    collector, client, rid, token, transcripts, mid = _rig()
    assert _accept(collector, token).status_code == 200
    transcripts._meetings[mid]["data"]["share_grants"][0].update(change)
    assert client.get(f"/recordings/{rid}/master", headers={"x-user-id": "8"}).status_code == 404
    assert client.get(f"/recordings/{rid}", headers={"x-user-id": "7"}).status_code == 200


@pytest.mark.parametrize("payload", [
    {"mode": "open", "include_recordings": True},
    {"mode": "restricted", "allowed_emails": ["guest@outside.test"], "include_recordings": "true"},
])
def test_recording_permission_is_explicit_and_recipient_restricted(payload):
    store = InMemoryTranscriptStore()
    mid = store.seed_meeting(user_id=7, platform="google_meet", native_meeting_id="abc-defg-hij")
    client = TestClient(create_app(store, redis=None))
    assert client.post(f"/meetings/{mid}/share", json=payload,
                       headers={"x-user-id": "7"}).status_code == 422
