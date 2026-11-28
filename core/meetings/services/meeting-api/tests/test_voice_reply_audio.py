"""Unit tests for GET /meetings/{meeting_id}/voice-assistant/audio/{request_id} (VieNeu replay + S3 cache + erasure)."""
import asyncio
import io
import json
import wave
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fakeredis.aioredis import FakeRedis
from fastapi import FastAPI

from meeting_api.lifecycle.speech_profile import room_profile, voice_reply_storage_prefix
from meeting_api.lifecycle.voice import build_voice_router, delete_voice_reply_objects
from meeting_api.recordings.fakes import InMemoryStorage


class VoiceAudioRepo:
    def __init__(self, reply_id: str, *, text='Bạn đã nói về việc cung cấp tính năng linh hoạt.',
                 state='completed', played_text=None, session_uid='sess-1', deleted=False):
        record = {
            'request_id': reply_id,
            'text': text,
            'state': state,
            'created_at_ms': 1700000000000,
            'updated_at_ms': 1700000001000,
            'session_uid': session_uid,
        }
        if played_text is not None:
            record['played_text'] = played_text
        self.row = {
            'id': 42,
            'user_id': 7,
            'platform': 'google_meet',
            'status': 'completed',
            'data': {
                'voice_replies': {reply_id: record},
                **({'artifact_deletion': {'state': 'completed'}} if deleted else {}),
            },
        }

    async def get_meeting(self, mid):
        return deepcopy(self.row) if mid == 42 else None

    async def list_sessions(self, **kwargs):
        return ['sess-1']


def _make_pcm(frames=2400):
    return b'\x02\x00' * frames


async def test_reply_audio_synthesizes_with_meeting_profile_and_caches_wav_in_storage(monkeypatch):
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    monkeypatch.setenv('TTS_API_TOKEN', 'secret-tts-token-12345678901234567890')
    monkeypatch.setenv('ADMIN_API_URL', 'http://identity.test')
    monkeypatch.setenv('INTERNAL_API_SECRET', 'secret-internal')
    monkeypatch.setenv('TINA_TTS_PROFILE_KEY', 'profile-secret-key-' + 'k' * 32)

    rid = str(uuid4())
    repo = VoiceAudioRepo(rid)
    redis = FakeRedis(decode_responses=True)
    storage = InMemoryStorage()
    tts_requests = []
    prefs = {'speech_voice': 'Mai Anh', 'pronunciations': {'TINA': 'ti na'}}

    async def upstream(request):
        if request.url.host == 'identity.test':
            return httpx.Response(200, json={'voice': prefs})
        tts_requests.append(request)
        return httpx.Response(
            200,
            content=_make_pcm(4800),
            headers={'X-Audio-Sample-Rate': '24000', 'X-Audio-Channels': '1'},
        )

    def factory(**kw):
        return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kw)

    # Pin the meeting session speech profile (as happens during the meeting)
    pinned = await room_profile(repo.row, 'sess-1', redis, factory, storage=storage)
    assert pinned
    # Simulate user later switching settings and Redis expiring
    await redis.flushall()
    prefs['speech_voice'] = 'Hải Đăng'

    app = FastAPI()
    app.include_router(build_voice_router(repo, redis, redis, client_factory=factory, storage=storage))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            # Auth & ownership checks
            assert (await client.get(f'/meetings/42/voice-assistant/audio/{rid}')).status_code == 401
            assert (await client.get(f'/meetings/42/voice-assistant/audio/{rid}', headers={'X-User-Id': '8'})).status_code == 404

            # First play: synthesizes via VieNeu with pinned meeting profile + caches in storage
            r1 = await client.get(f'/meetings/42/voice-assistant/audio/{rid}', headers={'X-User-Id': '7'})
            assert r1.status_code == 200
            assert r1.headers['content-type'] == 'audio/wav'
            assert r1.headers['cache-control'] == 'no-store'
            assert r1.headers['x-voice-audio-cache'] == 'miss'
            with wave.open(io.BytesIO(r1.content)) as wav:
                assert wav.getframerate() == 24000 and wav.getnchannels() == 1 and wav.getnframes() == 4800

            assert len(tts_requests) == 1
            body = json.loads(tts_requests[0].content)
            assert body['input'] == 'Bạn đã nói về việc cung cấp tính năng linh hoạt.'
            assert body['voice'] == 'auto'
            assert body['profile'] == pinned
            assert body['meeting_id'] == 42
            assert tts_requests[0].headers['X-API-Key'] == 'secret-tts-token-12345678901234567890'
            assert tts_requests[0].headers['X-TTS-Priority'] == 'low'

            # Second play: served directly from storage cache with ZERO additional VieNeu calls
            r2 = await client.get(f'/meetings/42/voice-assistant/audio/{rid}', headers={'X-User-Id': '7'})
            assert r2.status_code == 200
            assert r2.headers['x-voice-audio-cache'] == 'hit'
            assert r2.content == r1.content
            assert len(tts_requests) == 1

            # Artifact erasure removes both cached WAV and persisted profile
            prefix = voice_reply_storage_prefix(7, 42)
            assert len(await storage.list(prefix)) == 2
            deleted = await delete_voice_reply_objects(storage, 7, 42)
            assert len(deleted) == 2
            assert await storage.list(prefix) == []
    finally:
        await redis.aclose()


async def test_reply_audio_coalesces_concurrent_requests_and_respects_stopped_played_prefix(monkeypatch):
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    monkeypatch.setenv('TTS_API_TOKEN', 'secret-tts-token-12345678901234567890')
    monkeypatch.delenv('ADMIN_API_URL', raising=False)

    rid = str(uuid4())
    repo = VoiceAudioRepo(rid, text='Câu một. Câu hai chưa kịp đọc.', state='stopped', played_text='Câu một.')
    redis = FakeRedis(decode_responses=True)
    storage = InMemoryStorage()
    entered, release = asyncio.Event(), asyncio.Event()
    tts_calls = []

    async def upstream(request):
        tts_calls.append(json.loads(request.content))
        entered.set()
        await release.wait()
        return httpx.Response(200, content=_make_pcm(2400), headers={'X-Audio-Sample-Rate': '24000', 'X-Audio-Channels': '1'})

    def factory(**kw):
        return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kw)

    app = FastAPI()
    app.include_router(build_voice_router(repo, redis, redis, client_factory=factory, storage=storage))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            t1 = asyncio.create_task(client.get(f'/meetings/42/voice-assistant/audio/{rid}', headers={'X-User-Id': '7'}))
            await asyncio.wait_for(entered.wait(), 2)
            t2 = asyncio.create_task(client.get(f'/meetings/42/voice-assistant/audio/{rid}', headers={'X-User-Id': '7'}))
            await asyncio.sleep(0.05)
            release.set()
            r1, r2 = await asyncio.gather(t1, t2)
            assert r1.status_code == 200 and r2.status_code == 200
            assert r1.content == r2.content
            assert len(tts_calls) == 1
            assert tts_calls[0]['input'] == 'Câu một.'
    finally:
        await redis.aclose()


async def test_reply_audio_handles_empty_stopped_reply_deleted_artifacts_and_busy_tts(monkeypatch):
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    monkeypatch.setenv('TTS_API_TOKEN', 'secret-tts-token-12345678901234567890')
    monkeypatch.delenv('ADMIN_API_URL', raising=False)

    rid_empty = str(uuid4())
    rid_busy = str(uuid4())
    repo = VoiceAudioRepo(rid_busy, text='Nội dung bí mật')
    repo.row['data']['voice_replies'][rid_empty] = {
        'request_id': rid_empty,
        'text': 'Chưa phát',
        'played_text': '',
        'state': 'stopped',
        'created_at_ms': 1700000000000,
        'updated_at_ms': 1700000001000,
        'session_uid': 'sess-1',
    }
    redis = FakeRedis(decode_responses=True)
    storage = InMemoryStorage()

    async def upstream(request):
        return httpx.Response(503, json={'detail': 'Speech queue is full, cancelled or timed out'})

    def factory(**kw):
        return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kw)

    app = FastAPI()
    app.include_router(build_voice_router(repo, redis, redis, client_factory=factory, storage=storage))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            r_empty = await client.get(f'/meetings/42/voice-assistant/audio/{rid_empty}', headers={'X-User-Id': '7'})
            assert r_empty.status_code == 404

            r_busy = await client.get(f'/meetings/42/voice-assistant/audio/{rid_busy}', headers={'X-User-Id': '7'})
            assert r_busy.status_code == 503
            assert 'đang bận' in r_busy.json()['detail']
            assert 'secret-tts-token' not in r_busy.text and 'Nội dung bí mật' not in r_busy.text

            repo.row['data']['artifact_deletion'] = {'state': 'completed'}
            r_del = await client.get(f'/meetings/42/voice-assistant/audio/{rid_busy}', headers={'X-User-Id': '7'})
            assert r_del.status_code == 404
    finally:
        await redis.aclose()


async def test_completed_meeting_artifact_deletion_cleans_up_cached_voice_audio(monkeypatch):
    from meeting_api import create_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore

    storage = InMemoryStorage()
    store = InMemoryTranscriptStore()
    store._meetings[99] = {
        'id': 99,
        'user_id': 7,
        'platform': 'google_meet',
        'native_meeting_id': 'abc-defg-hij',
        'status': 'completed',
        'data': {'voice_replies': {}, 'recordings': []},
    }
    prefix = voice_reply_storage_prefix(7, 99)
    await storage.upload(f'{prefix}req-1/abc.wav', b'RIFF' + b'\x00' * 80, content_type='audio/wav')
    await storage.upload(f'{prefix}profiles/sess.profile', b'auto', content_type='text/plain')

    app = create_app(transcript_store=store, storage=storage)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        res = await client.delete('/meetings/99', headers={'X-User-Id': '7'})
        assert res.status_code == 204
        assert await storage.list(prefix) == []
