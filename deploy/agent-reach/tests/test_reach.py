import asyncio
import json
import sys

from fastapi.testclient import TestClient
import httpx
import pytest

import runner
import server


@pytest.mark.parametrize('body', [
    {'channel':'reddit','action':'read','query':'https://example.com'},
    {'channel':'github','action':'delete','query':'redis/redis'},
    {'channel':'web','action':'read','query':'http://127.0.0.1/admin'},
    {'channel':'web','action':'read','query':'http://host.docker.internal/'},
    {'channel':'web','action':'read','query':'http://169.254.169.254/'},
    {'channel':'github','action':'read','query':'https://github.com.evil.test/redis/redis'},
    {'channel':'github','action':'read','query':'redis/redis; rm -rf /'},
    {'channel':'web','action':'search','query':'x','token':'private'},
    {'channel':'web','action':'search','query':'\n'},
])
def test_request_validation_precedes_subprocess(monkeypatch, body):
    def forbidden(*args, **kwargs): raise AssertionError('no subprocess allowed')
    monkeypatch.setattr(server.asyncio, 'create_subprocess_exec', forbidden)
    with TestClient(server.create_app()) as client:
        assert client.post('/query', json=body).status_code == 422
        assert client.post('/query', content=b'x'*4097).status_code == 413


def test_runner_uses_only_public_api_and_projects_bounded_sources(monkeypatch):
    seen = []
    def run(channel, action, params, **kwargs):
        seen.append((channel.name,action,params,kwargs))
        return {'ok':True,'backend':'github-api','items':[
            {'title':'Redis','url':'https://github.com/redis/redis','text':'x'*9000,'raw':{'private':'discard'}},
            {'url':'http://127.0.0.1','text':'discard'},
        ]}
    monkeypatch.setattr(runner, 'run_action', run)
    result = runner.execute({'channel':'github','action':'read','query':'redis/redis'})
    assert seen == [('github','read',{'target':'redis/redis'},{'timeout':20,'only_backend':'github-api'})]
    assert len(result['items']) == 1 and len(result['items'][0]['text']) == 5000
    assert 'raw' not in result['items'][0]


@pytest.mark.asyncio
async def test_collection_rejects_oversized_subprocess_output():
    process = await asyncio.create_subprocess_exec(sys.executable, '-c', 'print("x"*220000)', stdout=asyncio.subprocess.PIPE)
    try:
        with pytest.raises(ValueError): await server.collect(process)
    finally:
        await process.wait()


def test_server_subprocess_has_scrubbed_env_and_cleanup(monkeypatch):
    original = asyncio.create_subprocess_exec
    seen = []
    async def spawn(*args, **kwargs):
        seen.append(kwargs)
        return await original(sys.executable, '-c', 'import json,sys; json.load(sys.stdin); print(json.dumps({"ok":True,"items":[]}))', **kwargs)
    monkeypatch.setattr(server.asyncio, 'create_subprocess_exec', spawn)
    with TestClient(server.create_app()) as client:
        assert client.get('/health').json()['channels'] == ['web','github']
        for _ in range(3):
            assert client.post('/query',json={'channel':'web','action':'search','query':'public'}).status_code == 200
    assert len(seen) == 3
    assert all(set(call['env']) == {'PATH','HOME','PYTHONUNBUFFERED'} and call['start_new_session'] for call in seen)


@pytest.mark.asyncio
async def test_capacity_and_cancel_kill_exact_children_and_release_slots(monkeypatch):
    original = asyncio.create_subprocess_exec
    children=[]
    async def spawn(*args, **kwargs):
        child = await original(sys.executable, '-c', 'import sys,time; sys.stdin.read(); time.sleep(30)', **kwargs)
        children.append(child)
        return child
    monkeypatch.setattr(server.asyncio, 'create_subprocess_exec', spawn)
    app=server.create_app()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        body={'channel':'web','action':'search','query':'public'}
        requests=[asyncio.create_task(client.post('/query',json=body)) for _ in range(2)]
        try:
            async with asyncio.timeout(3):
                while len(children)<2: await asyncio.sleep(.01)
            assert (await client.post('/query',json=body)).status_code == 429
        finally:
            for request in requests: request.cancel()
            await asyncio.gather(*requests,return_exceptions=True)
        assert all(child.returncode is not None for child in children)
        # Re-admission works after cancellation; it reaches a new child instead of returning 429.
        task=asyncio.create_task(client.post('/query',json=body))
        try:
            async with asyncio.timeout(3):
                while len(children)<3: await asyncio.sleep(.01)
        finally:
            task.cancel(); await asyncio.gather(task,return_exceptions=True)
        assert all(child.returncode is not None for child in children)
