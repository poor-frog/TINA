"""Shared public retrieval worker; no credentials, workspace mounts or host port."""
import asyncio
import json
import os
from pathlib import Path
import signal
import sys
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from agent_reach.channels.github import _parse_target
from agent_reach.runtime.result import ReachError
from agent_reach.utils.url import normalize_public_http_url
from runner import REVISION


class Query(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    channel: Literal['web', 'github']
    action: Literal['search', 'read']
    query: str = Field(min_length=1, max_length=2000)


async def collect(process):
    output = bytearray()
    while chunk := await process.stdout.read(8192):
        output.extend(chunk)
        if len(output) > 200000:
            raise ValueError('Retrieval output exceeds bound')
    await process.wait()
    if process.returncode:
        raise ValueError('Retrieval failed')
    return json.loads(output)


def create_app():
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    running = set()

    @app.get('/health')
    async def health():
        return {'ready': True, 'service': 'agent-reach', 'revision': REVISION,
                'channels': ['web', 'github'], 'capacity': 2}

    @app.post('/query')
    async def query(request: Request):
        raw = bytearray()
        async for part in request.stream():
            raw.extend(part)
            if len(raw) > 4096:
                raise HTTPException(413, 'Retrieval request exceeds bound')
        try:
            body = Query.model_validate_json(raw)
            if not body.query.strip() or any(ord(c) < 32 for c in body.query):
                raise ValueError('Invalid query')
            if body.action == 'read':
                if body.channel == 'github':
                    _parse_target(body.query)
                else:
                    normalize_public_http_url(body.query)
        except (ValueError, ReachError):
            raise HTTPException(422, 'Expected a public web or GitHub search/read request') from None
        if len(running) >= 2:
            raise HTTPException(429, 'Public retrieval worker is busy')
        slot = object()
        running.add(slot)
        process = task = None
        try:
            process = await asyncio.create_subprocess_exec(sys.executable, str(Path(__file__).with_name('runner.py')),
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True, env={'PATH': os.defpath, 'HOME': '/tmp/tina-reach',
                                             'PYTHONUNBUFFERED': '1'})
            process.stdin.write(body.model_dump_json().encode())
            await process.stdin.drain()
            process.stdin.close()
            task = asyncio.create_task(collect(process))
            async with asyncio.timeout(24):
                while not task.done():
                    if await request.is_disconnected():
                        raise HTTPException(499, 'Retrieval cancelled')
                    await asyncio.sleep(.1)
                return await task
        except TimeoutError:
            raise HTTPException(504, 'Public retrieval timed out') from None
        except (ValueError, OSError):
            raise HTTPException(502, 'Public retrieval is unavailable') from None
        finally:
            if process is not None:
                if process.returncode is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                await process.wait()
            if task is not None:
                if not task.done():
                    task.cancel()
                await asyncio.gather(task, return_exceptions=True)
            running.discard(slot)

    return app


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(create_app(), host='0.0.0.0', port=8080, access_log=False)
