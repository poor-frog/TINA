"""Two participant boundaries share the real coordinator; upstream services are simulated."""
import asyncio
from dataclasses import replace
import threading
import time
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from fastapi import HTTPException
from fastapi.testclient import TestClient
import httpx
import pytest

from tina_speech.coordinator import Coordinator, create_app
from tina_speech.session import RoomClient, RoomMonitor, SpeechSession
from tina_meeting_voice.wakeword import WakeDetector
from test_capture import Client, QUIET, VOICE, Vad
from test_coordinator import FakeServices, room, wav, wait


class Monitor:
    def __init__(self, busy=False):
        self.value = {'epoch': str(uuid4()), 'revision': 0, 'busy': busy}
    def snapshot(self): return self.value
    def close(self): pass


def session(client, monitor):
    kws = SimpleNamespace(accept=Mock(return_value=True), reset=Mock())
    return SpeechSession(None, client, lambda event: None, monitor=monitor,
                         detector=WakeDetector(kws), vad_factory=Vad)


def until(predicate, *sessions):
    deadline = time.monotonic() + 2
    while not predicate() and time.monotonic() < deadline:
        for instance in sessions: instance.tick()
        time.sleep(.001)
    assert predicate()


def test_all_other_clients_suppress_room_audio_and_require_quiet_after_release():
    monitor = Monitor(busy=True)
    instances = [session(Client(), monitor) for _ in range(2)]
    try:
        for instance in instances:
            for _ in range(100): instance.feed(VOICE)
            assert instance.state == 'BUSY'
            assert instance.detector.kws.accept.call_count == 0
            assert not instance.client.uploads
        monitor.value = monitor.value | {'busy': False}
        for instance in instances:
            for _ in range(50): instance.feed(VOICE)
            assert instance.state == 'QUIET'
            for _ in range(39): instance.feed(QUIET)
            assert instance.state == 'QUIET'
            instance.feed(QUIET)
            assert instance.state == 'ARMED'
            assert instance.detector.kws.accept.call_count == 0
    finally:
        for instance in instances: instance.close()


@pytest.mark.parametrize('restart', [False, True])
def test_disconnect_or_epoch_change_discards_capture_and_never_rearms_automatically(restart):
    client, monitor = Client(), Monitor()
    instance = session(client, monitor)
    try:
        instance.feed(VOICE)
        instance.future.result(timeout=1)
        monitor.value = {'epoch': str(uuid4()), 'revision': 0, 'busy': False} if restart else None
        instance.tick()
        assert instance.state == 'ERROR' and instance.capture is None
        monitor.value = {'epoch': instance.epoch, 'revision': 0, 'busy': False}
        for _ in range(100): instance.feed(QUIET)
        until(lambda: bool(client.cancelled))
        assert instance.state == 'ERROR' and not client.uploads
    finally: instance.close()


def test_monitor_unavailable_and_stale_status_are_fail_closed():
    client = Client()
    monitor = RoomMonitor(client)
    try:
        assert monitor.snapshot()['busy'] is False
        with monitor.lock: monitor.updated -= 2
        assert monitor.snapshot() is None
        failed = threading.Event()
        def unavailable():
            failed.set()
            raise httpx.ConnectError('disconnected')
        client.room = unavailable
        assert failed.wait(1)
        until(lambda: monitor.snapshot() is None)
    finally: monitor.close()


def test_missed_short_busy_interval_still_clears_acoustic_history():
    monitor = Monitor()
    instance = session(Client(), monitor)
    try:
        monitor.value = monitor.value | {'revision': 1}
        instance.feed(VOICE)
        assert instance.state == 'QUIET'
        assert instance.detector.kws.accept.call_count == 0
        assert not instance.detector.ring
    finally: instance.close()








@pytest.mark.asyncio
async def test_simultaneous_different_identities_one_grant_and_owned_dedup():
    async with httpx.AsyncClient() as http:
        coordinator = Coordinator(replace(room(), participants=[8, 9]), 'operator', '', http)
        ids = [str(uuid4()), str(uuid4())]
        results = await asyncio.gather(coordinator.reserve(ids[0], 8),
                                       coordinator.reserve(ids[1], 9), return_exceptions=True)
        assert sum(isinstance(result, HTTPException) and result.status_code == 409 for result in results) == 1
        winner = next(result for result in results if not isinstance(result, Exception))
        assert await coordinator.reserve(winner.request_id, winner.user_id) is winner
        with pytest.raises(HTTPException) as denied:
            await coordinator.reserve(winner.request_id, 17 - winner.user_id)
        assert denied.value.status_code == 404
        await coordinator.cancel(winner)
        assert (await coordinator.room_status())['busy'] is False


def test_two_host_sessions_racing_one_wake_upload_only_winning_audio():
    services = FakeServices()
    # Keep the real coordinator occupied until both clients have processed the grant.
    services.state = 'started'
    original = services.handle
    event_loops = set()
    def handle(request):
        event_loops.add(asyncio.get_running_loop())
        if request.url.path == '/auth/me' and request.headers.get('x-api-key') == 'second':
            return httpx.Response(200, json={'user_id': 9})
        return original(request)
    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    app = create_app(replace(room(), participants=[8, 9]), 'operator', '', http=http)
    with TestClient(app) as server:
        # Two independent HTTP clients share one ASGI lifespan/event loop, as in
        # the single-process coordinator. A second TestClient context would drive
        # its asyncio lock/tasks from another loop and race during shutdown.
        monitors = [Monitor(), Monitor()]
        instances = []
        try:
            for key, monitor in zip(['participant', 'second'], monitors):
                transport = httpx.MockTransport(server.send)
                client = RoomClient('http://127.0.0.1', key, http=httpx.Client(transport=transport))
                client.epoch = monitor.value['epoch'] = app.state.coordinator.epoch
                instances.append(session(client, monitor))
            for instance in instances: instance.feed(VOICE)
            for instance in instances:
                # Wait for each network reservation without consuming the result.
                until(lambda: instance.future.done())
            for instance in instances: instance.tick()
            assert sorted(i.state for i in instances) == ['BUSY', 'CAPTURING']
            winner = next(i for i in instances if i.state == 'CAPTURING')
            loser = next(i for i in instances if i.state == 'BUSY')
            for monitor in monitors: monitor.value = monitor.value | {'busy': True}
            assert loser.capture is None and loser.audio is None
            for _ in range(60):
                for instance in instances: instance.feed(VOICE)
            for _ in range(40):
                for instance in instances: instance.feed(QUIET)
            until(lambda: winner.state == 'SPEAKING', *instances)
            assert len([r for r in services.calls if r.url.path == '/v1/audio/transcriptions']) == 1
            assert len([r for r in services.calls if r.method == 'POST' and r.url.path.endswith('/speak')]) == 1
            for instance in instances:
                for _ in range(30): instance.feed(VOICE)
                assert instance.detector.kws.accept.call_count == 1
            services.state = 'completed'
            until(lambda: winner.state in ('BUSY', 'QUIET'), *instances)
            for monitor in monitors:
                monitor.value = monitor.value | {'busy': False, 'revision': app.state.coordinator.revision}
            for instance in instances:
                for _ in range(40): instance.feed(QUIET)
                assert instance.state == 'ARMED'
                assert instance.detector.armed
            # The losing host can ask the next question after fresh idle/quiet.
            loser.feed(VOICE)
            until(lambda: loser.future.done())
            loser.tick()
            assert loser.state == 'CAPTURING'
            assert app.state.coordinator.active == loser.identifier
            assert {turn.user_id for turn in app.state.coordinator.turns.values()} == {8, 9}
        finally:
            services.state = 'stopped'
            for instance in instances: instance.close()
            # Session.close is intentionally non-blocking for the host UI. Drain
            # its queued HTTP cleanup here while the test server is still alive.
            for instance in instances: instance.pool.shutdown(wait=True)
        assert len(event_loops) == 1


@pytest.mark.parametrize('failure', ['stt', 'llm', 'tts', 'bot_disconnected'])
def test_upstream_failure_never_retries_shared_answer(failure):
    services = FakeServices()
    def handle(request):
        if (failure == 'stt' and request.url.path == '/v1/audio/transcriptions'
                or failure == 'llm' and request.url.path.endswith('/ask')
                or failure == 'bot_disconnected' and request.method == 'POST' and request.url.path.endswith('/speak')):
            services.calls.append(request)
            return httpx.Response(503)
        return services.handle(request)
    if failure == 'tts': services.state = 'failed'
    http = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    app = create_app(room(), 'operator', '', http=http)
    with TestClient(app) as client:
        client.headers.update({'x-api-key': 'participant', 'X-Tina-Speech-Epoch': app.state.coordinator.epoch,
                               'X-Tina-Speech-Revision': '0'})
        identifier = str(uuid4()); path = '/turns/' + identifier
        client.post(path)
        client.put(path + '/audio', content=wav(), headers={'Content-Type': 'audio/wav'})
        result = wait(client, identifier)
        assert result['state'] == ('ERROR' if failure == 'bot_disconnected' else 'FAILED')
        client.put(path + '/audio', content=wav(), headers={'Content-Type': 'audio/wav'})
        assert len([r for r in services.calls if r.method == 'POST' and r.url.path.endswith('/speak')]) <= 1
        assert client.get('/room').json()['busy'] is (failure == 'bot_disconnected')
