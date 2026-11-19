import asyncio
import json
from types import SimpleNamespace
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from fakeredis.aioredis import FakeRedis
import pytest

from meeting_api.lifecycle.speak_router import build_speak_router
from meeting_api.lifecycle.speech_status import PlaybackStore


@pytest.fixture
def speech(monkeypatch):
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    monkeypatch.setenv('INTERNAL_API_SECRET', 'test-only-internal-speech-secret')
    messages = []
    meeting = {'id': 42, 'status': 'active', 'data': {'voice_agent_enabled': True}}
    async def active(user, platform, native):
        return meeting if user == 7 and meeting['status'] == 'active' else None
    async def latest(user, platform, native):
        return meeting if user == 7 else None
    async def sessions(**kwargs): return ['old-session', 'current-session']
    async def publish(channel, body):
        messages.append(json.loads(body))
        return 1
    store = PlaybackStore(FakeRedis(decode_responses=True))
    app = FastAPI()
    app.state.meeting = meeting
    app.include_router(build_speak_router(SimpleNamespace(find_active=active, find_latest=latest, list_sessions=sessions),
                                        SimpleNamespace(publish=publish), store))
    with TestClient(app) as client:
        yield client, messages


HEADERS = {'X-User-Id': '7'}
PATH = '/bots/google_meet/synthetic/speak'


def test_legacy_commands_are_unchanged(speech):
    client, messages = speech
    assert client.post(PATH, headers=HEADERS, json={'text': 'hello'}).json() == {'accepted': True, 'meeting_id': 42}
    assert messages == [{'action': 'speak', 'text': 'hello', 'voice': 'auto'}]
    assert client.delete(PATH, headers=HEADERS).status_code == 200
    assert messages[-1] == {'action': 'speak_stop'}


def test_tracked_speak_deduplicates_and_rejects_changed_input(speech):
    client, messages = speech
    identifier = str(uuid4())
    body = {'text': 'synthetic answer', 'command_id': identifier}
    first = client.post(PATH, headers=HEADERS, json=body)
    assert first.status_code == 200 and first.json()['state'] == 'queued'
    assert client.post(PATH, headers=HEADERS, json=body).status_code == 200
    assert len(messages) == 1 and messages[0]['action'] == 'speech_speak'
    assert client.post(PATH, headers=HEADERS, json=body | {'text': 'changed'}).status_code == 409
    assert client.post(PATH, headers=HEADERS, json=body | {'command_id': str(uuid4())}).status_code == 409
    assert client.get(PATH + '/' + identifier, headers={'X-User-Id': '8'}).status_code == 404
    assert client.get(PATH + '/' + identifier).status_code == 401


def report(client, identifier, state, **extra):
    return client.post('/bots/internal/callback/speech',
        headers={'x-internal-secret': 'test-only-internal-speech-secret'},
        json={'meeting_id': 42, 'command_id': identifier, 'session_uid': 'current-session', 'state': state} | extra)


def test_only_real_ordered_authenticated_receipts_can_complete(speech):
    client, _ = speech
    identifier = str(uuid4())
    client.post(PATH, headers=HEADERS, json={'text': 'hello', 'command_id': identifier})
    assert client.post('/bots/internal/callback/speech', json={'meeting_id': 42, 'command_id': identifier,
        'session_uid': 'current-session', 'state': 'started'}).status_code == 401
    assert report(client, identifier, 'started', session_uid='old-session').status_code == 409
    assert report(client, identifier, 'completed').status_code == 409
    assert report(client, identifier, 'started').status_code == 200
    assert report(client, identifier, 'completed').json()['state'] == 'completed'
    assert report(client, identifier, 'failed').json()['state'] == 'completed'
    assert report(client, identifier, 'started').json()['state'] == 'completed'
    public = client.get(PATH + '/' + identifier, headers=HEADERS).json()
    assert set(public) == {'meeting_id', 'command_id', 'state'}


def test_manual_playback_cannot_invent_voice_history_progress(speech):
    client,_=speech;identifier=str(uuid4())
    client.post(PATH,headers=HEADERS,json={'text':'manual','command_id':identifier})
    assert report(client,identifier,'started').status_code==200
    assert report(client,identifier,'started',played_text='manual').status_code==409
    assert report(client,identifier,'started',played_text='x'*4001).status_code==422


def test_stop_before_publication_blocks_late_speak(speech):
    client, messages = speech
    identifier = str(uuid4())
    response = client.delete(PATH, headers=HEADERS, params={'command_id': identifier})
    assert response.status_code == 200 and response.json()['state'] == 'queued'
    assert messages == [{'action': 'speech_stop', 'command_id': identifier}]
    assert client.post(PATH, headers=HEADERS, json={'text': 'late result', 'command_id': identifier}).status_code == 409
    assert report(client, identifier, 'stopped').json()['state'] == 'stopped'
    assert report(client, identifier, 'completed').json()['state'] == 'stopped'


def test_owner_can_read_terminal_receipt_after_bot_leaves(speech):
    client, _ = speech
    identifier = str(uuid4())
    assert client.post(PATH, headers=HEADERS, json={'text': 'hello', 'command_id': identifier}).status_code == 200
    assert report(client, identifier, 'started').status_code == 200
    assert report(client, identifier, 'completed').status_code == 200
    client.app.state.meeting['status'] = 'completed'
    response = client.get(PATH + '/' + identifier, headers=HEADERS)
    assert response.status_code == 200 and response.json()['state'] == 'completed'
    assert client.get(PATH + '/' + identifier, headers={'X-User-Id': '8'}).status_code == 404
    assert client.post(PATH, headers=HEADERS, json={'text': 'late'}).status_code == 404


@pytest.mark.asyncio
async def test_concurrent_identical_claim_has_one_publisher_and_terminal_releases_room():
    redis = FakeRedis(decode_responses=True)
    store = PlaybackStore(redis)
    identifier = str(uuid4())
    claims = await asyncio.gather(*(store.begin(42, identifier, 'session', 'hello', 'auto') for _ in range(8)))
    assert sum(created for _, created in claims) == 1
    assert await redis.ttl(store.key(42, identifier)) <= 600
    await store.report(42, identifier, 'session', 'failed')
    assert not await redis.exists('speech:active:42')
    assert await store.get(42, identifier)


async def test_retiring_old_playback_cannot_clear_a_replacement_command(monkeypatch):
    redis = FakeRedis(decode_responses=True)
    store = PlaybackStore(redis)
    old, new = str(uuid4()), str(uuid4())
    await store.begin(42, old, 'retired', 'old', 'auto')
    await store.report(42, old, 'retired', 'started')
    get = store.get
    async def replaced(mid, command):
        snapshot = await get(mid, command)
        await store.report(42, old, 'retired', 'completed')
        await store.begin(42, new, 'current', 'new', 'auto')
        return snapshot
    monkeypatch.setattr(store, 'get', replaced)
    await store.retire_previous_sessions(42, ['retired'])
    assert await redis.get('speech:active:42') == new
    assert (await get(42, new))['state'] == 'queued'
    await redis.aclose()
