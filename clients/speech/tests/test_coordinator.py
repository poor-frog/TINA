import asyncio
import io
from uuid import uuid4
import wave

import httpx
from fastapi.testclient import TestClient
import pytest

from tina_speech.coordinator import Coordinator, Room, create_app, question_text, spoken_answer


def room():
    return Room(42, 'google_meet', 'synthetic', 7, [8], ['wiki/speech-pilot.md'], True,
                'http://gateway.test', 'http://stt.test')


def answer():
    return {'id': 'a' * 32, 'stale': False, 'meeting_ids': [],
            'claims': [{'text': 'The synthetic review is Friday.', 'source_ids': ['s0']}],
            'sources': [{'id': 's0', 'kind': 'document', 'path': 'wiki/speech-pilot.md', 'meeting_id': 42}]}


class FakeServices:
    def __init__(self):
        self.calls = []
        self.reply = answer()
        self.state = 'completed'
        self.transcription = 'Hey Tina. When is the synthetic review?'

    def handle(self, request):
        self.calls.append(request)
        path = request.url.path
        if path == '/auth/me':
            user = {'operator': 7, 'participant': 8, 'stranger': 9}.get(request.headers.get('x-api-key'))
            return httpx.Response(200, json={'user_id': user}) if user else httpx.Response(401)
        if path == '/meetings/42':
            return httpx.Response(200, json={'user_id': 7, 'platform': 'google_meet',
                'native_meeting_id': 'synthetic', 'status': 'active', 'data': {'voice_agent_enabled': True}})
        if path == '/agent/workspace/meeting-knowledge/42':
            return httpx.Response(200, json={'documents': [{'path': 'wiki/speech-pilot.md'}]})
        if path == '/v1/audio/transcriptions':
            return httpx.Response(200, json={'text': self.transcription})
        if '/meeting-knowledge/' in path:
            return httpx.Response(200, json=self.reply)
        if path.endswith('/speak'):
            import json
            self.identifier = json.loads(request.content)['command_id'] if request.method == 'POST' else request.url.params['command_id']
            return httpx.Response(200, json={'accepted': True, 'meeting_id': 42, 'command_id': self.identifier})
        if '/speak/' in path:
            return httpx.Response(200, json={'meeting_id': 42, 'command_id': path.rsplit('/', 1)[-1], 'state': self.state})
        return httpx.Response(404)


def wav():
    output = io.BytesIO()
    with wave.open(output, 'wb') as out:
        out.setnchannels(1); out.setsampwidth(2); out.setframerate(16000)
        out.writeframes(b'\1\0' * 16000)
    return output.getvalue()


@pytest.fixture
def pilot():
    services = FakeServices()
    http = httpx.AsyncClient(transport=httpx.MockTransport(services.handle))
    app = create_app(room(), 'operator', 'test-stt-secret', http=http)
    with TestClient(app) as client:
        client.headers['X-Tina-Speech-Epoch'] = app.state.coordinator.epoch
        client.headers['X-Tina-Speech-Revision'] = '0'
        yield client, services


def wait(client, identifier):
    import time
    for _ in range(100):
        result = client.get('/turns/' + identifier, headers={'x-api-key': 'participant'}).json()
        if result['state'] in ('COMPLETED', 'FAILED', 'STOPPED', 'ERROR'): return result
        time.sleep(.01)
    raise AssertionError('Turn did not finish')


def test_one_authorized_voice_turn_reuses_public_seams_and_never_applies_wiki(pilot):
    client, services = pilot
    identifier = str(uuid4()); path = '/turns/' + identifier
    headers = {'x-api-key': 'participant'}
    assert client.post(path, headers=headers).status_code == 201
    assert client.post('/turns/' + str(uuid4()), headers=headers).status_code == 409
    assert client.put(path + '/audio', headers=headers | {'Content-Type': 'audio/wav'}, content=wav()).status_code == 202
    assert wait(client, identifier)['state'] == 'COMPLETED'
    assert client.put(path + '/audio', headers=headers | {'Content-Type': 'audio/wav'}, content=wav()).status_code == 202
    import json
    speaks = [r for r in services.calls if r.method == 'POST' and r.url.path.endswith('/speak')]
    assert len(speaks) == 1 and json.loads(speaks[0].content)['text'] == 'The synthetic review is Friday.'
    assert not any('/apply' in r.url.path for r in services.calls)
    assert all(r.headers.get('x-api-key') == 'operator' for r in services.calls if '/meeting-knowledge/' in r.url.path)


def test_identity_enrollment_and_audio_bounds(pilot):
    client, services = pilot
    path = '/turns/' + str(uuid4())
    assert client.post(path).status_code == 401
    assert client.post(path, headers={'x-api-key': 'stranger'}).status_code == 403
    assert client.post(path, headers={'x-api-key': 'participant'}).status_code == 201
    assert client.get(path, headers={'x-api-key': 'operator'}).status_code == 403
    assert client.put(path + '/audio', headers={'x-api-key': 'participant', 'Content-Type': 'audio/wav'}, content=b'x' * 800001).status_code == 413
    assert client.put(path + '/audio', headers={'x-api-key': 'participant', 'Content-Type': 'audio/wav'}, content=b'bad WAV').status_code == 422
    assert not any(r.url.path == '/v1/audio/transcriptions' for r in services.calls)


@pytest.mark.parametrize('change', [
    {'stale': True}, {'meeting_ids': [99]}, {'claims': [{'text': 'bad', 'source_ids': ['missing']}]},
    {'sources': [{'id': 's0', 'kind': 'document', 'path': 'wiki/private.md', 'meeting_id': 42}]},
    {'sources': [{'id': 's0', 'kind': 'transcript', 'meeting_id': 99}]}, {'claims': 'raw tool output'}])
def test_bad_or_unapproved_sources_never_reach_speak(pilot, change):
    client, services = pilot
    services.reply.update(change)
    identifier = str(uuid4()); headers = {'x-api-key': 'participant'}
    client.post('/turns/' + identifier, headers=headers)
    client.put('/turns/' + identifier + '/audio', headers=headers | {'Content-Type': 'audio/wav'}, content=wav())
    assert wait(client, identifier)['state'] == 'FAILED'
    assert not any(r.method == 'POST' and r.url.path.endswith('/speak') for r in services.calls)


def test_empty_claims_get_only_fixed_insufficient_information_reply():
    value = answer() | {'claims': [], 'sources': []}
    text, ids = spoken_answer(value, room())
    assert text.startswith('Mình chưa có đủ thông tin') and ids == []


def test_older_single_meeting_sources_are_bound_to_the_fixed_endpoint():
    value = answer()
    del value['sources'][0]['meeting_id']
    assert spoken_answer(value, room())[0] == 'The synthetic review is Friday.'
    value['sources'][0]['meeting_id'] = 99
    with pytest.raises(ValueError): spoken_answer(value, room())


def test_wake_removal_is_anchored_and_empty_transcript_never_dispatches():
    assert question_text('Hey Tina, is Tina ready?') == 'is Tina ready?'
    assert question_text('hay tina when is the review') == 'when is the review'
    for invalid in ('', 'ordinary speech Hey Tina', 'ordinary speech hay tina', 'Hey Tina.', 'hay tina'):
        with pytest.raises(ValueError): question_text(invalid)


def test_empty_stt_never_reaches_llm_or_speak(pilot):
    client, services = pilot
    services.transcription = ''
    identifier = str(uuid4()); headers = {'x-api-key': 'participant'}
    client.post('/turns/' + identifier, headers=headers)
    client.put('/turns/' + identifier + '/audio', headers=headers | {'Content-Type': 'audio/wav'}, content=wav())
    assert wait(client, identifier)['state'] == 'FAILED'
    assert not any(r.url.path.endswith(('/ask', '/speak')) for r in services.calls)


def test_unknown_playback_does_not_unlock_or_retry_speak(pilot):
    client, services = pilot
    services.state = 'unknown'
    identifier = str(uuid4()); headers = {'x-api-key': 'participant'}
    client.post('/turns/' + identifier, headers=headers)
    client.put('/turns/' + identifier + '/audio', headers=headers | {'Content-Type': 'audio/wav'}, content=wav())
    assert wait(client, identifier)['state'] == 'ERROR'
    assert client.post('/turns/' + str(uuid4()), headers=headers).status_code == 409
    assert len([r for r in services.calls if r.method == 'POST' and r.url.path.endswith('/speak')]) == 1


@pytest.mark.asyncio
async def test_cancel_during_llm_discards_late_result():
    services = FakeServices(); entered, release = asyncio.Event(), asyncio.Event()
    async def handle(request):
        if request.url.path.endswith('/ask'):
            entered.set()
            # Simulate an upstream operation that ignores cancellation.
            try: await release.wait()
            except asyncio.CancelledError: await release.wait()
        return services.handle(request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as http:
        c = Coordinator(room(), 'operator', '', http)
        turn = await c.reserve(str(uuid4()), 8)
        await c.upload(turn, wav())
        await asyncio.wait_for(entered.wait(), 2)
        await c.cancel(turn)
        release.set()
        await asyncio.wait_for(turn.task, 2)
        assert turn.state == 'STOPPED'
        assert not any(r.url.path.endswith('/speak') for r in services.calls)


def test_delayed_capture_request_after_release_needs_fresh_revision(pilot):
    client, _ = pilot
    headers = {'x-api-key': 'participant'}
    identifier = str(uuid4())
    path = '/turns/' + identifier
    assert client.post(path, headers=headers).status_code == 201
    client.delete(path, headers=headers)
    # Receipt retries retain identity, but an old snapshot cannot start another turn.
    assert client.post(path, headers=headers).json()['state'] == 'STOPPED'
    next_path = '/turns/' + str(uuid4())
    assert client.post(next_path, headers=headers).status_code == 409
    status = client.get('/room', headers=headers).json()
    assert client.post(next_path, headers=headers | {'X-Tina-Speech-Revision': str(status['revision'])}).status_code == 201



def test_room_status_is_private_and_old_epoch_cannot_reserve_or_upload(pilot):
    client, _ = pilot
    assert client.get('/room').status_code == 401
    assert client.get('/room', headers={'x-api-key': 'stranger'}).status_code == 403
    headers = {'x-api-key': 'participant'}
    status = client.get('/room', headers=headers).json()
    assert set(status) == {'epoch', 'revision', 'busy'} and status['busy'] is False
    identifier = str(uuid4()); path = '/turns/' + identifier
    assert client.post(path, headers=headers).status_code == 201
    assert client.get('/room', headers=headers).json()['busy'] is True
    old = status['epoch']
    coordinator = client.app.state.coordinator
    coordinator.epoch = str(uuid4())  # simulate a new boot's protocol boundary
    for method, suffix in [('POST', ''), ('PUT', '/audio'), ('GET', ''), ('DELETE', '')]:
        assert client.request(method, path + suffix,
            headers=headers | {'X-Tina-Speech-Epoch': old}).status_code == 409
    assert coordinator.turns[identifier].digest is None



def test_disconnected_capture_lease_expires_on_room_poll(pilot):
    client, _ = pilot
    headers = {'x-api-key': 'participant'}
    identifier = str(uuid4())
    client.post('/turns/' + identifier, headers=headers)
    turn = client.app.state.coordinator.turns[identifier]
    turn.created -= 36
    assert client.get('/room', headers=headers).json()['busy'] is False
    assert turn.state == 'FAILED' and turn.reason == 'capture_expired'
