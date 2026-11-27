"""One-room Agents pilot with capability-authenticated TINA text/PCM custom I/O."""
import asyncio
from collections import deque, OrderedDict
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass, field
from datetime import timedelta
import logging
import os
import time
from uuid import UUID, uuid4
from typing import Callable, Awaitable
from weakref import WeakValueDictionary

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from livekit import api, rtc
from livekit.agents import Agent, AgentSession, llm
from livekit.agents.types import APIConnectOptions
from livekit.agents.voice import SessionConnectOptions

from adapters import TinaLLM, VieNeuTTS, SynthesisStatus, HttpAudioOutput, SAMPLE_RATE
from rag import SourceAccessChanged
from task_flow import run_task_flow

MAX_ROOMS = 3

# Framework/provider logs must not include source text, questions, PCM or bearer capabilities.
logging.getLogger('livekit.agents').setLevel(logging.CRITICAL)
logging.getLogger('httpx').setLevel(logging.WARNING)


class BoundedBody:
    """Validate headers without wrapping streamed errors in BaseHTTPMiddleware."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type']=='http' and scope['method'] in ('POST','DELETE'):
            length = dict(scope['headers']).get(b'content-length',b'')
            limit=4*1024*1024 if scope.get('path','').startswith('/audio/') else 20000
            if not length.isdigit() or len(length)>8 or int(length)>limit:
                await JSONResponse({'detail':'Bounded request body required'},status_code=413)(scope,receive,send)
                return
        await self.app(scope,receive,send)


class Question(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    revision: int = Field(ge=0)


class HeardTurn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(min_length=1, max_length=4000)
    created_at_ms: int = Field(ge=0)


def heard_context(turns):
    context = llm.ChatContext.empty()
    for turn in turns:
        context.add_message(role='user', content=turn.question, created_at=turn.created_at_ms/1000)
        context.add_message(role='assistant', content=turn.answer, created_at=turn.created_at_ms/1000)
    return context


def context_turns(context):
    messages = [m for m in context.items if m.type == 'message' and m.role in ('user','assistant')]
    return [{'question':a.text_content,'answer':b.text_content,'created_at_ms':round(a.created_at*1000)}
            for a,b in zip(messages[::2],messages[1::2])]


class Speech(BaseModel):
    model_config = ConfigDict(extra='forbid')
    model: str = 'tts-1'
    input: str = Field(min_length=1, max_length=4000)
    voice: str = Field(default='auto', max_length=64)
    profile: str | None = Field(default=None,max_length=6000)
    response_format: str = Field(default='pcm', pattern='^pcm$')
    meeting_id: int = Field(gt=0)


class Stop(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID


class _ClientDisconnected(Exception):
    """Raised when the HTTP caller closes the connection before completion."""

    def __init__(self, *, settled: bool = True):
        super().__init__('Client disconnected')
        self.settled = settled


async def connect_room(name):
    room = rtc.Room()
    token = api.AccessToken().with_identity('tina-agent').with_ttl(timedelta(minutes=2)).with_grants(
        api.VideoGrants(room_join=True, room=name, can_publish=False, can_subscribe=False,
                        can_publish_data=False, can_update_own_metadata=True)).to_jwt()
    try:
        await asyncio.wait_for(room.connect(os.environ['LIVEKIT_URL'], token,
            options=rtc.RoomOptions(auto_subscribe=False)), 12)
    except BaseException:
        with suppress(Exception):await asyncio.wait_for(room.disconnect(),5)
        raise
    return room


async def delete_room(name):
    with suppress(Exception):
        async with api.LiveKitAPI() as livekit:
            await asyncio.wait_for(livekit.room.delete_room(api.DeleteRoomRequest(room=name)), 4)


@dataclass
class Runtime:
    room: object
    session: AgentSession
    model: TinaLLM
    tts: VieNeuTTS
    revision: int
    token: str
    room_name: str
    current_id: str | None = None
    current_handle: object | None = None
    turn_done: asyncio.Event | None = None
    context_task: asyncio.Task | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    touched: float = field(default_factory=time.monotonic)
    pending_audio: int = 0
    failed: bool = False
    contexts: OrderedDict = field(default_factory=OrderedDict)
    release_turn: Callable[[str], Awaitable[None]] | None = None
    closing: asyncio.Task | None = None
    created_by: asyncio.Task | None = None

    async def close(self):
        async def dispose():
            task,rid,done=self.context_task,self.current_id,self.turn_done
            if task is not None:task.cancel()
            if self.current_handle is not None:
                with suppress(Exception):self.current_handle.interrupt()
            if rid and self.release_turn:
                with suppress(Exception):await asyncio.wait_for(self.release_turn(rid),6)
            if task is not None:
                await asyncio.wait({task},timeout=3)
                if task.done() and not task.cancelled():task.exception()
                elif not task.done():task.add_done_callback(lambda done:None if done.cancelled() else done.exception())
            if done is not None:
                with suppress(TimeoutError):await asyncio.wait_for(done.wait(),3)
            with suppress(Exception):await asyncio.wait_for(self.session.aclose(),5)
            with suppress(Exception):await asyncio.wait_for(self.room.disconnect(),5)
            await delete_room(self.room_name)
        if self.closing is None:self.closing=asyncio.create_task(dispose())
        await asyncio.shield(self.closing)


class PCMResponse(StreamingResponse):
    """Release admission even when the client disconnects before the iterator starts."""
    def __init__(self, content, runtime):
        super().__init__(content, media_type='audio/pcm', headers={
            'X-Audio-Sample-Rate': str(SAMPLE_RATE), 'X-Audio-Channels': '1', 'Cache-Control': 'no-store'})
        self.runtime = runtime

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                await self.body_iterator.aclose()
            finally:
                self.runtime.pending_audio -= 1


def create_app(client=None, room_connector=connect_room):
    core = os.environ.get('MEETING_API_URL', 'http://meeting-api:8080').rstrip('/')
    tts_url = os.environ.get('TTS_SERVICE_URL', 'http://tts:8000').rstrip('/')
    tts_token = os.environ.get('TTS_API_TOKEN', '')
    http = client or httpx.AsyncClient(timeout=150, follow_redirects=False)
    from audio import build_audio_router
    rows, opening, initializing, stopped = {}, WeakValueDictionary(), set(), deque(maxlen=128)

    def room_lock(key):
        # Active callers retain the lock; idle keys need no permanent registry entry.
        lock = opening.get(key)
        if lock is None: opening[key] = lock = asyncio.Lock()
        return lock

    async def config(mid, session, token, revision=None):
        if mid <= 0 or len(session) > 128:
            raise HTTPException(422, 'Invalid meeting session')
        try: UUID(session)
        except ValueError: raise HTTPException(422, 'Invalid meeting session') from None
        if not token.startswith('Bearer ') or len(token) > 256:
            raise HTTPException(401, 'Voice capability required')
        try:
            r = await http.get(f'{core}/bots/voice/{mid}/{session}/config', headers={
                'Authorization': token,'X-TINA-Voice-Runtime':'livekit-v1'}, timeout=5)
        except httpx.HTTPError: raise HTTPException(503, 'TINA is unavailable') from None
        if r.status_code in (401,403,404):
            raise HTTPException(403, 'Voice capability or active session rejected')
        if r.status_code == 409:
            raise HTTPException(409, 'Voice session or policy changed')
        if r.status_code != 200:
            raise HTTPException(503, 'TINA is unavailable')
        try: value = r.json()
        except ValueError: raise HTTPException(503,'Invalid TINA configuration response') from None
        if not isinstance(value,dict) or value.get('enabled') is not True or value.get('engine') != 'livekit' or revision is not None and value.get('revision') != revision:
            raise HTTPException(409, 'Voice runtime policy changed')
        return value

    async def get_runtime(mid, session, token, revision):
        await config(mid, session, token, revision)
        key = (mid, session)
        async with room_lock(key):
            row = rows.get(key)
            if row and row.closing is not None:
                if not row.closing.done():raise HTTPException(409,'Previous runtime is closing')
                await row.close();rows.pop(key);row=None
            if row and (row.revision != revision or row.token != token or row.failed):
                if row.lock.locked(): raise HTTPException(409, 'Previous voice turn is stopping')
                await row.close(); rows.pop(key); row = None
            if row:
                if getattr(row.room,'connection_state',rtc.ConnectionState.CONN_CONNECTED) != rtc.ConnectionState.CONN_CONNECTED:
                    if row.lock.locked(): raise HTTPException(503,'LiveKit room is reconnecting')
                    await row.close(); rows.pop(key); row=None
            if row:
                row.touched = time.monotonic()
                return row
            async def answer(request):
                headers = {'Authorization': token}
                if request['speaker']: headers['X-Voice-Speaker-Key'] = request['speaker']
                r = await http.post(f'{core}/bots/voice/{mid}/{session}/answer', json=request['body'], headers=headers)
                if r.status_code != 200 or len(r.content) > 200000: raise RuntimeError('TINA answer rejected')
                return r.json()
            async def agent(request, operation, lookup=None):
                headers = {'Authorization': token}
                if request['speaker']: headers['X-Voice-Speaker-Key'] = request['speaker']
                body = request['body'] | {'operation':operation}
                if operation == 'context': body.pop('agent_context', None)
                if lookup is not None: body['lookup'] = lookup
                r = await http.post(f'{core}/bots/voice/{mid}/{session}/agent', json=body, headers=headers)
                if r.status_code in (401,403,404,409): raise SourceAccessChanged('TINA source or session access changed')
                if r.status_code != 200 or len(r.content) > 200000: raise RuntimeError('TINA agent operation rejected')
                return r.json()
            async def speech(text):
                selected=await config(mid,session,token,revision)
                speech_profile=selected.get('speech_profile')
                async with http.stream('POST', tts_url+'/v1/audio/speech', headers={'X-API-Key': tts_token},
                    json={'model':'tts-1','input':text,'voice':'auto','response_format':'pcm','meeting_id':mid,
                          **({'profile':speech_profile} if speech_profile else {})}, timeout=145) as r:
                    if (r.status_code != 200 or r.headers.get('x-audio-sample-rate','24000') != '24000'
                            or r.headers.get('x-audio-channels','1') != '1'):
                        raise RuntimeError('Local TTS rejected')
                    async for chunk in r.aiter_bytes(): yield chunk
            # A late server-side deletion must never target a replacement generation's room.
            name = f'tina-meeting-{mid}-{session}-{uuid4().hex}'
            room=session_io=None
            # No await between checking capacity and reserving this pending admission.
            if len(rows)+len(initializing) >= MAX_ROOMS: raise HTTPException(503, 'LiveKit meeting capacity is full')
            initializing.add(key)
            try:
                room = await room_connector(name)
                model = TinaLLM(answer, agent)
                tts = VieNeuTTS(speech)
                session_io = AgentSession(llm=model, tts=tts, vad=None, turn_handling={'turn_detection':'manual','interruption':{'resume_false_interruption':False}},
                    user_away_timeout=None, conn_options=SessionConnectOptions(
                        llm_conn_options=APIConnectOptions(max_retry=0,timeout=160),
                        tts_conn_options=APIConnectOptions(max_retry=0,timeout=145)))
                from livekit.agents.voice import room_io
                await session_io.start(Agent(instructions='Use only the authorized TINA backend.'),room=room,
                        session_host=False,record=False,room_options=room_io.RoomOptions(
                            audio_input=False,video_input=False,text_input=False,audio_output=False,text_output=False,
                            close_on_disconnect=False))
                row = Runtime(room,session_io,model,tts,revision,token,name,
                    release_turn=lambda rid:cancel_turn(mid,session,rid,token),created_by=asyncio.current_task())
                rows[key] = row
                return row
            except BaseException:
                if session_io is not None:
                    with suppress(Exception):await asyncio.wait_for(session_io.aclose(),5)
                if room is not None:
                    with suppress(Exception):await asyncio.wait_for(room.disconnect(),5)
                await delete_room(name)
                raise
            finally:
                initializing.discard(key)

    async def reap():
        while True:
            await asyncio.sleep(2)
            for key, row in list(rows.items()):
                invalid = False
                try:
                    await config(*key, row.token, row.revision)
                except HTTPException as exc:
                    invalid = exc.status_code != 503
                async with room_lock(key):
                    if rows.get(key) is not row: continue
                    if not invalid and (row.lock.locked() or time.monotonic()-row.touched < 90): continue
                    await row.close()
                    if rows.get(key) is row:rows.pop(key)

    @asynccontextmanager
    async def lifespan(app):
        task = asyncio.create_task(reap())
        try: yield
        finally:
            task.cancel()
            with suppress(asyncio.CancelledError): await task
            for row in list(rows.values()): await row.close()
            if client is None: await http.aclose()

    app = FastAPI(lifespan=lifespan)
    app.include_router(build_audio_router(http,core))
    app.add_middleware(BoundedBody)
    app.state.rows = rows
    app.state.get_runtime = get_runtime

    @app.exception_handler(_ClientDisconnected)
    async def _handle_client_disconnected(_request: Request, _exc: _ClientDisconnected):
        return JSONResponse({'detail': 'Client disconnected'}, status_code=499)

    @app.get('/health')
    async def health():
        try:
            async with api.LiveKitAPI() as livekit:
                await asyncio.wait_for(livekit.room.list_rooms(api.ListRoomsRequest()),3)
        except Exception: raise HTTPException(503,'LiveKit server is unavailable') from None
        try:
            response = await http.get(core+'/health',timeout=3)
            if response.status_code != 200: raise HTTPException(503,'TINA Meeting API is unavailable')
        except httpx.HTTPError:
            raise HTTPException(503,'TINA Meeting API is unavailable') from None
        return {'ready':True,'engine':'livekit-agents','version':'1.8.11','capacity':MAX_ROOMS,'sessions':len(rows)}

    @app.get('/ready')
    async def ready():
        status = await health()
        if (len(tts_token) < 32 or tts_token.startswith('encrypted:') or not tts_token.isascii()
                or any(ord(c) < 33 or ord(c) > 126 for c in tts_token)):
            raise HTTPException(503, 'TTS credential is not configured')
        try:
            response = await http.get(tts_url + '/ready', headers={'X-API-Key': tts_token}, timeout=5)
            if response.status_code != 200:
                raise HTTPException(503, 'TTS authentication or readiness failed')
            body = response.json()
            if (body.get('status') != 'ok' or body.get('sample_rate') != SAMPLE_RATE
                    or body.get('channels') != 1 or body.get('format') != 'pcm_s16le'):
                raise HTTPException(503, 'Unexpected TTS audio format')
        except (httpx.HTTPError, ValueError, AttributeError):
            raise HTTPException(503, 'TTS is unavailable') from None
        if os.environ.get('TINA_LIVEKIT_AUDIO')=='1':
            try:
                from audio import noise_ready
                noise_info=await asyncio.to_thread(noise_ready)
                if not os.environ.get('LIVEKIT_API_SECRET'):raise ValueError()
            except Exception:raise HTTPException(503,'Local audio preprocessing unavailable') from None
        vad_ready=False
        if os.environ.get('TINA_LIVEKIT_VAD_SHADOW')=='1':
            try:
                from vad_shadow import verify_assets
                verify_assets();vad_ready=True
            except Exception:pass  # Optional observer failure must not stop STT or TTS.
        return status | {'tts_ready': True,'audio_bridge_ready':os.environ.get('TINA_LIVEKIT_AUDIO')=='1',
                         'noise_filter':noise_info if os.environ.get('TINA_LIVEKIT_AUDIO')=='1' else None,'vad_shadow_ready':vad_ready}

    async def turn_permit(mid, session, rid, token, revision):
        try:
            response = await http.get(f'{core}/bots/voice/{mid}/{session}/turn/{rid}',
                params={'revision': revision}, headers={'Authorization': token}, timeout=5)
            if response.status_code == 200 and response.json().get('current') is True: return
        except (httpx.HTTPError, ValueError, AttributeError):
            raise HTTPException(503, 'Voice turn validation is unavailable') from None
        raise HTTPException(409, 'Voice turn is no longer current')

    async def wait_handle(handle, request):
        task=asyncio.create_task(handle.wait_for_playout())
        try:
            while not task.done():
                await asyncio.sleep(.05)
                if await request.is_disconnected():
                    handle.interrupt()
                    settled = False
                    try:
                        await asyncio.wait_for(asyncio.shield(task), 1.0)
                        settled = True
                    except (TimeoutError, Exception):
                        settled = task.done()
                    raise _ClientDisconnected(settled=settled)
            await task
            if handle.exception() is not None: raise HTTPException(503,'Agent pipeline failed')
        finally:
            if not task.done():
                handle.interrupt(); task.cancel()
                with suppress(asyncio.CancelledError, Exception): await task

    async def wait_flow(task, request):
        try:
            while not task.done():
                await asyncio.sleep(.05)
                if await request.is_disconnected():
                    raise _ClientDisconnected()
            return await task
        finally:
            if not task.done(): task.cancel()
            with suppress(asyncio.CancelledError): await task

    async def admit(mid,session,token,revision,request):
        task=asyncio.create_task(get_runtime(mid,session,token,revision))
        try:return await wait_flow(task,request)
        except BaseException:
            # Admission can finish in the same tick as disconnect; discard only an unused new runtime.
            if task.done() and not task.cancelled() and task.exception() is None:
                row=task.result()
                async with room_lock((mid,session)):
                    if row.created_by is task and rows.get((mid,session)) is row and not row.lock.locked():
                        await row.close();rows.pop((mid,session))
            raise

    async def cancel_turn(mid, session, rid, token, *, strict=False):
        # Release TINA's room reservation even if planning or the SDK failed before finalization.
        try:
            response=await http.post(f'{core}/bots/voice/{mid}/{session}/state', headers={'Authorization':token},
                                    json={'state':'QUIET','request_id':rid}, timeout=5)
            if strict and (response.status_code!=200 or response.json().get('accepted') is not True):
                raise HTTPException(503,'TINA cancellation was not confirmed')
        except httpx.HTTPError:
            if strict: raise HTTPException(503,'TINA cancellation is unavailable') from None
        except (ValueError,AttributeError):
            if strict: raise HTTPException(503,'Invalid TINA cancellation acknowledgment') from None

    @app.post('/bots/{mid}/{session}/answer')
    async def answer(mid:int,session:str,body:Question,request:Request,authorization:str=Header(default=''),
                     x_voice_speaker_key:str|None=Header(default=None,pattern=r'^[0-9a-f]{64}$')):
        row=await admit(mid,session,authorization,body.revision,request)
        if row.lock.locked(): raise HTTPException(409,'Voice turn is busy')
        async with row.lock:
            if row.closing is not None:raise HTTPException(409,'Voice runtime is closing')
            rid=str(body.request_id)
            if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
            row.current_id=rid; row.model.result=None
            done=asyncio.Event();row.turn_done=done
            row.model.request={'body':body.model_dump(mode='json'),'speaker':x_voice_speaker_key}
            row.session.output.audio=None
            context = llm.ChatContext.empty()
            disconnected = False
            try:
                row.context_task=asyncio.create_task(row.model.agent(row.model.request, 'context'))
                try: snapshot = await wait_flow(row.context_task,request)
                finally: row.context_task=None
                if len(snapshot['history']) > 3: raise RuntimeError('Heard context exceeds bound')
                context = heard_context([HeardTurn.model_validate(t) for t in snapshot['history']])
                now = time.monotonic()
                row.contexts = OrderedDict((k,v) for k,v in row.contexts.items() if now-v[0] < 900)
                if x_voice_speaker_key:
                    row.contexts.pop(x_voice_speaker_key, None)
                    row.contexts[x_voice_speaker_key] = (now, context.copy())
                    while len(row.contexts) > 32: row.contexts.popitem(last=False)
                    context = row.contexts[x_voice_speaker_key][1].copy()
                row.model.request['body']['agent_context'] = context_turns(context)
                if snapshot.get('task_flow'):
                    row.context_task=asyncio.create_task(run_task_flow(snapshot['task_flow']['node'],row.model.agent,row.model.request,
                        kind=snapshot['task_flow'].get('kind','task')))
                    try: flow=await wait_flow(row.context_task,request)
                    finally: row.context_task=None
                    if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
                    if flow['action']!='leave':
                        row.context_task=asyncio.create_task(row.model.answer(row.model.request))
                        try: result=await wait_flow(row.context_task,request)
                        finally: row.context_task=None
                        if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
                        if not isinstance(result.get('text'),str) or not 1<=len(result['text'])<=4000:
                            raise RuntimeError('Invalid task flow answer')
                        row.model.result=result
                        return row.model.result | {'voice_runtime':'livekit','workflow_runtime':'pipecat-flows'}
                await row.session.current_agent.update_chat_ctx(context.copy())
                if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
                handle=row.session.generate_reply(user_input=body.question,chat_ctx=context.copy())
                row.current_handle=handle
                await asyncio.wait_for(wait_handle(handle,request),165)
                if (mid,session,rid) in stopped: raise HTTPException(409,'Voice turn stopped')
                if not row.model.result: raise HTTPException(503,'TINA answer failed')
                return row.model.result | {'voice_runtime':'livekit'}
            except _ClientDisconnected as exc:
                disconnected = exc.settled
                return JSONResponse({'detail': 'Client disconnected'}, status_code=499)
            except asyncio.CancelledError:
                if (mid,session,rid) in stopped or row.closing is not None: raise HTTPException(409,'Voice turn stopped') from None
                raise
            except (RuntimeError, ValueError, httpx.HTTPError):
                raise HTTPException(503,'TINA agent operation failed') from None
            finally:
                if row.model.result is None:
                    if not disconnected and (mid,session,rid) not in stopped: row.failed=True
                    await cancel_turn(mid,session,rid,authorization)
                    row.current_id=None
                row.model.request=None; row.model.result=None; row.touched=time.monotonic()
                row.current_handle=None
                try:
                    with suppress(RuntimeError): await row.session.current_agent.update_chat_ctx(context.copy())
                finally: done.set()

    @app.post('/bots/{mid}/{session}/v1/audio/speech')
    async def speech(mid:int,session:str,body:Speech,request:Request,authorization:str=Header(default=''),
                     x_voice_revision:int=Header(ge=0),x_voice_request_id:UUID=Header()):
        if body.meeting_id!=mid or body.voice!='auto': raise HTTPException(422,'Only the selected room voice is supported')
        row=await admit(mid,session,authorization,x_voice_revision,request)
        rid=str(x_voice_request_id)
        await turn_permit(mid,session,rid,authorization,x_voice_revision)
        if row.pending_audio >= 2: raise HTTPException(429,'Current speech and lookahead are already reserved')
        row.pending_audio += 1
        async def stream():
            async with row.lock:
                if row.closing is not None:return
                if (mid,session,rid) in stopped: return
                await turn_permit(mid,session,rid,authorization,x_voice_revision)
                if (mid,session,rid) in stopped: return
                if row.failed: raise RuntimeError('Agent speech failed')
                row.current_id=rid
                done=asyncio.Event();row.turn_done=done
                synthesis = SynthesisStatus()
                row.tts.synthesis = synthesis
                output=HttpAudioOutput(); row.session.output.audio=output
                handle=row.session.say(body.input,add_to_chat_ctx=False)
                row.current_handle=handle
                waiter=asyncio.create_task(handle.wait_for_playout())
                try:
                    async with asyncio.timeout(150):
                        checked_at = time.monotonic()
                        while not waiter.done() or not output.queue.empty():
                            if (mid,session,rid) in stopped: return
                            if time.monotonic() - checked_at >= 1:
                                await turn_permit(mid,session,rid,authorization,x_voice_revision)
                                checked_at = time.monotonic()
                            if synthesis.failed: raise RuntimeError('Agent speech failed')
                            try: yield await asyncio.wait_for(output.queue.get(),.1)
                            except TimeoutError: pass
                        if handle.exception() is not None or handle.interrupted or not synthesis.complete or not output.samples:
                            raise RuntimeError('Agent speech failed')
                        await turn_permit(mid,session,rid,authorization,x_voice_revision)
                finally:
                    if not waiter.done(): handle.interrupt(); waiter.cancel()
                    with suppress(asyncio.CancelledError): await waiter
                    # Recreate a failed SDK session before the next turn instead of retaining its error budget/state.
                    row.failed = row.failed or synthesis.failed
                    row.session.output.audio=None; row.touched=time.monotonic()
                    row.current_handle=None;done.set()
        return PCMResponse(stream(), row)

    @app.delete('/bots/{mid}/{session}/turn')
    async def stop(mid:int,session:str,body:Stop,authorization:str=Header(default='')):
        await config(mid,session,authorization)
        row=rows.get((mid,session));rid=str(body.request_id)
        stopped.append((mid,session,rid))
        done=None
        if row and row.current_id==rid:
            done,handle=row.turn_done,row.current_handle
            if row.context_task is not None: row.context_task.cancel()
            if handle is not None: handle.interrupt()
        await cancel_turn(mid,session,rid,authorization,strict=True)
        if done is not None:
            try: await asyncio.wait_for(done.wait(),3)
            except TimeoutError: raise HTTPException(503,'Previous voice turn is still stopping') from None
        return {'stopped':True}
    return app


if __name__=='__main__':
    import uvicorn
    uvicorn.run(create_app(),host='0.0.0.0',port=8080,access_log=False,
                ws='websockets-sansio',ws_max_size=100000,ws_max_queue=16)
