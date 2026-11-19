"""Three real local Agents rooms + VieNeu PCM; meeting/LLM/receipt authority is synthetic."""
import asyncio
import hashlib
import json
import math
import os
import socket
import time
from uuid import uuid4

import httpx
import uvicorn
from livekit import api

from server import create_app


class Authority(httpx.AsyncBaseTransport):
    def __init__(self, real):
        self.real = real
        self.current = {}
        self.planned = set()
        self.held = None
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.quota = None
        self.tts_calls = 0
        self.answers = {900001: 'Trong phiên thử một, Lan phụ trách bản demo.',
                        900002: 'Trong phiên thử hai, Minh phụ trách phần kiểm thử.',
                        900003: 'Trong phiên thử ba, Huy chuẩn bị tài liệu hướng dẫn.'}
        self.heard = {mid: [{'question': f'Câu hỏi thử trước trong phòng {mid}.', 'answer': f'Câu trả lời fixture của phòng {mid}.',
                            'created_at_ms': int(time.time() * 1000) - 1000}] for mid in self.answers}

    async def handle_async_request(self, request):
        if request.url.host != 'meeting-api':
            if request.url.path.endswith('/v1/audio/speech'): self.tts_calls += 1
            return await self.real.handle_async_request(request)
        if request.url.path == '/health': return httpx.Response(200, json={'status': 'ok'})
        parts = request.url.path.split('/')
        mid, session = int(parts[3]), parts[4]
        expected = f'Bearer synthetic-{mid}-{session}'
        if request.headers.get('Authorization') != expected: return httpx.Response(401)
        if parts[-1] == 'config':
            return httpx.Response(200, json={'enabled': True, 'engine': 'livekit', 'revision': 1})
        if 'turn' in parts:
            return httpx.Response(200, json={'current': self.current.get((mid, session)) == parts[-1]})
        body = json.loads(request.content)
        rid = body.get('request_id')
        if parts[-1] == 'state':
            if self.current.get((mid, session)) == rid: self.current.pop((mid, session), None)
            return httpx.Response(200, json={'accepted': True})
        operation = body.get('operation')
        if operation == 'context':
            self.current[(mid, session)] = rid
            return httpx.Response(200, json={'history': self.heard.get(mid, [])})
        if operation == 'plan':
            if rid == self.quota: return httpx.Response(429)
            calls = [] if rid in self.planned else [{'name': 'search_meeting', 'query': 'synthetic'}]
            self.planned.add(rid)
            return httpx.Response(200, json={'tool_calls': calls})
        if operation == 'lookup':
            return httpx.Response(200, json={'tool': 'search_meeting', 'source_count': 1,
                                            'sources': [{'id': 's0', 'quote': 'Synthetic evidence.'}]})
        assert body['agent_context'] == self.heard.get(mid, []), 'Cross-room context contamination'
        if rid == self.held:
            self.entered.set()
            await self.release.wait()
        return httpx.Response(200, json={'text': self.answers.get(mid, 'Synthetic reply.'),
                                        'reason': 'answered', 'sources': [{'id': 's0'}]})


async def serve(app):
    # Bind first so another local process cannot take the qualification port.
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0)); listener.listen()
    server = uvicorn.Server(uvicorn.Config(app, access_log=False, log_level='critical',
                                          lifespan='on', timeout_graceful_shutdown=1))
    task = asyncio.create_task(server.serve(sockets=[listener]))
    deadline = time.monotonic() + 10
    while not server.started:
        if task.done(): await task
        assert time.monotonic() < deadline, 'Qualification server did not start'
        await asyncio.sleep(.02)
    return server, task, f'http://127.0.0.1:{listener.getsockname()[1]}'


async def main():
    # No real meeting/LLM endpoint is contacted, regardless of the operator's core URL.
    os.environ['MEETING_API_URL'] = 'http://meeting-api:8080'
    authority = Authority(httpx.AsyncHTTPTransport())
    sessions = {mid: str(uuid4()) for mid in authority.answers}
    headers = lambda mid: {'Authorization': f'Bearer synthetic-{mid}-{sessions[mid]}',
                           'X-Voice-Speaker-Key': 'a' * 64}
    body = lambda: {'question': 'Synthetic source-grounded meeting question.',
                    'request_id': str(uuid4()), 'revision': 1}
    samples = []
    report = {'live_google_meet': False, 'meeting_api_and_llm_are_synthetic': True,
              'playback_receipts_are_synthetic': True, 'real_asr': False}
    async with httpx.AsyncClient(transport=authority, timeout=150) as upstream:
        app = create_app(client=upstream)
        worker, task, url = await serve(app)
        try:
            async with httpx.AsyncClient(base_url=url, timeout=175) as client:
                ready = await client.get('/ready')
                assert ready.status_code == 200 and ready.json()['capacity'] == 3
                async def ask(mid, request):
                    started = time.monotonic()
                    response = await client.post(f'/bots/{mid}/{sessions[mid]}/answer', headers=headers(mid), json=request)
                    assert response.status_code == 200, 'Synthetic answer failed'
                    assert response.json()['text'] == authority.answers[mid]
                    return round((time.monotonic() - started) * 1000)
                async def speak(mid, request):
                    started = time.monotonic(); first = None; count = 0; checksum = hashlib.sha256()
                    async with client.stream('POST', f'/bots/{mid}/{sessions[mid]}/v1/audio/speech',
                        headers=headers(mid) | {'X-Voice-Revision': '1', 'X-Voice-Request-Id': request['request_id']},
                        json={'input': authority.answers[mid], 'meeting_id': mid, 'voice': 'auto', 'response_format': 'pcm'}) as response:
                        assert response.status_code == 200 and response.headers['x-audio-sample-rate'] == '24000'
                        async for chunk in response.aiter_bytes():
                            if chunk and first is None: first = time.monotonic()
                            count += len(chunk); checksum.update(chunk)
                    assert count >= 4800 and count % 2 == 0 and first is not None
                    samples.append({'first_pcm_ms': round((first - started) * 1000),
                                    'total_ms': round((time.monotonic() - started) * 1000),
                                    'pcm_bytes': count, 'sha256': checksum.hexdigest()})
                for _ in range(5):
                    requests = {mid: body() for mid in sessions}
                    await asyncio.gather(*(ask(mid, request) for mid, request in requests.items()))
                    await asyncio.gather(*(speak(mid, request) for mid, request in requests.items()))
                fourth_session = str(uuid4())
                full = await client.post(f'/bots/900004/{fourth_session}/answer',
                    headers={'Authorization': f'Bearer synthetic-900004-{fourth_session}'}, json=body())
                assert full.status_code == 503
                first_mid = next(iter(sessions)); held = body(); authority.held = held['request_id']
                pending = asyncio.create_task(client.post(f'/bots/{first_mid}/{sessions[first_mid]}/answer', headers=headers(first_mid), json=held))
                await asyncio.wait_for(authority.entered.wait(), 10)
                stopped = await client.request('DELETE', f'/bots/{first_mid}/{sessions[first_mid]}/turn',
                                               headers=headers(first_mid), json={'request_id': held['request_id']})
                assert stopped.status_code == 200
                authority.release.set()
                assert (await pending).status_code in (409, 503)
                await asyncio.gather(*(ask(mid, body()) for mid in sessions))
                quota_mid = list(sessions)[-1]; quota = body(); authority.quota = quota['request_id']
                response = await client.post(f'/bots/{quota_mid}/{sessions[quota_mid]}/answer', headers=headers(quota_mid), json=quota)
                assert response.status_code == 503
                authority.quota = None
                await ask(quota_mid, body())
                report.update(real_livekit_rooms=True, actual_agent_sessions=3, langgraph_rag=True,
                              separate_room_context=True, concurrent_pcm_streams=3, streams_verified=len(samples),
                              fourth_room_rejected=True, stop_isolated=True, quota_failure_recovered=True)
        finally:
            authority.release.set(); worker.should_exit = True
            await asyncio.wait_for(task, 15)
        # Recreate an empty Agents runtime: the persisted core authority still refuses stopped audio.
        app = create_app(client=upstream)
        worker, task, url = await serve(app)
        try:
            async with httpx.AsyncClient(base_url=url, timeout=30) as client:
                before = authority.tts_calls
                response = await client.post(f'/bots/{first_mid}/{sessions[first_mid]}/v1/audio/speech',
                    headers=headers(first_mid) | {'X-Voice-Revision': '1', 'X-Voice-Request-Id': held['request_id']},
                    json={'input': 'Discard this stopped answer.', 'meeting_id': first_mid})
                assert response.status_code == 409 and authority.tts_calls == before
                report['runtime_recreation_refuses_old_audio'] = True
        finally:
            worker.should_exit = True; await asyncio.wait_for(task, 15)
    await authority.real.aclose()
    async with api.LiveKitAPI() as livekit:
        rooms = await livekit.room.list_rooms(api.ListRoomsRequest())
        assert not any(room.name.startswith(tuple(f'tina-meeting-{mid}-{session}-' for mid, session in sessions.items())) for room in rooms.rooms)
    times = sorted(row['first_pcm_ms'] for row in samples)
    report.update(rooms_removed=True, local_vieneu_tts=True, sample_rate=24000,
                  first_pcm_p50_ms=times[len(times)//2], first_pcm_p95_ms=times[math.ceil(.95*len(times))-1], samples=samples)
    print(json.dumps(report), flush=True)


if __name__ == '__main__': asyncio.run(main())
