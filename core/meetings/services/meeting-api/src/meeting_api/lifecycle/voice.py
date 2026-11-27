"""Owner-approved room voice; bots receive only a meeting/session-scoped capability."""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import asyncio
import time
from contextlib import suppress
from uuid import UUID
from typing import Literal, Annotated

import httpx
from fastapi import APIRouter, Header, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

from .stop_router import _resolve_user_id
from .stop import leave_command_channel
from .speech_status import SpeechConflict
from .voice_replies import VoiceReply, VoiceSourceRef, VoiceSources, public_replies
from .voice_navigation import VoiceNavigationHint,VoiceNavigation,open_source_intent,select_open_source,navigation_reply
from redis.exceptions import WatchError
from .task_flow import TaskFlowStore, checked_proposal, service_error, decision_sources_changed
from .voice_handoff import VoiceHandoffs, VoiceHandoff, public_context

STATES = '^(LISTENING|CAPTURING|THINKING|SPEAKING|QUIET|ERROR|OFF)$'
RECOVERABLE_READS = {'get_recent_transcript', 'search_meeting', 'search_shared_meetings',
                     'search_shared_documents', 'search_approved_actions'}
log = logging.getLogger(__name__)
log.setLevel(logging.INFO)
if not log.hasHandlers(): log.addHandler(logging.StreamHandler())


class VoiceTurnPermit(BaseModel):
    model_config = ConfigDict(extra='forbid')
    current: StrictBool


class VoiceProgress(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    session_uid: str = Field(max_length=128)
    revision: int = Field(ge=0)
    stage: Literal['planning', 'searching_transcript', 'reading_documents', 'searching_web',
                   'reading_context', 'answering', 'preparing_speech', 'drafting']
    observed_at_ms: int = Field(ge=0, strict=True)


def live_progress(raw, held, session, revision, request_id=None):
    if not raw or not session:
        return None
    try:
        value = VoiceProgress.model_validate_json(raw).model_dump(mode='json')
        if isinstance(held, bytes): held = held.decode()
        if (value['session_uid'] == session and value['revision'] == revision
                and held == f"{session}:{value['request_id']}"
                and (request_id is None or value['request_id'] == request_id)
                and 0 <= int(time.time()*1000) - value['observed_at_ms'] < 180000):
            return value
    except (ValueError, TypeError):
        pass
    return None


def voice_token(secret, meeting, session):
    secret = secret if secret is not None else os.environ.get('ADMIN_TOKEN', '')
    if not secret:
        raise ValueError('ADMIN_TOKEN is required for a voice capability')
    return hmac.new(secret.encode(), f'meeting-voice.v1:{meeting}:{session}'.encode(), 'sha256').hexdigest()


class VoicePolicy(BaseModel):
    model_config = ConfigDict(extra='forbid')
    enabled: StrictBool = False
    include_transcript: StrictBool = False
    include_workspace_wiki: StrictBool = False
    include_approved_actions: StrictBool = False
    shared_meeting_ids: list[Annotated[int,Field(gt=0,strict=True)]] = Field(default_factory=list,max_length=4)
    documents: list[str] = Field(default_factory=list, max_length=8)
    source_profile_id: str | None = Field(default=None, pattern=r'^[0-9a-f]{32}$')
    source_profile_fingerprint: str | None = Field(default=None, pattern=r'^[0-9a-f]{64}$')
    revision: int = Field(default=0, ge=0)
    wake_variants: list[str] = Field(default_factory=list, max_length=8)
    noise_suppression: StrictBool = False
    allow_general_knowledge: StrictBool = False
    allow_web_search: StrictBool = False
    auto_web_search: StrictBool = False
    agent_backend: Literal['completion', 'sandbox'] = 'completion'
    engine: Literal['tina', 'livekit'] = 'tina'

    @model_validator(mode='after')
    def profile_reference(self):
        if bool(self.source_profile_id) != bool(self.source_profile_fingerprint):
            raise ValueError('Source profile id and fingerprint are required together')
        return self


    @field_validator('shared_meeting_ids')
    @classmethod
    def unique_shared_meetings(cls, values):
        if len(set(values))!=len(values): raise ValueError('Choose distinct meetings')
        return values

    @field_validator('wake_variants')
    @classmethod
    def wake_aliases(cls, values):
        import unicodedata
        result = []
        for value in values:
            value = unicodedata.normalize('NFKC', value).strip().casefold()
            if (not 2 <= len(value) <= 40 or not all(c.isalpha() or c in ' -' for c in value)
                    or value.startswith(('hey ', 'hi ', 'hello ')) or value == 'anh ơi'):
                raise ValueError('Choose a short approved ASR name variant without a greeting prefix')
            if value not in result: result.append(value)
        return result

    @field_validator('documents')
    @classmethod
    def paths(cls, values):
        if len(set(values)) != len(values) or any(not p.endswith('.md') or len(p) > 512 or p.startswith('/') or '..' in p.split('/') for p in values):
            raise ValueError('Choose linked Markdown documents')
        return values


class HeardTurn(BaseModel):
    model_config = ConfigDict(extra='forbid')
    question: str = Field(min_length=1, max_length=2000)
    answer: str = Field(min_length=1, max_length=4000)
    created_at_ms: int = Field(ge=0)


class VoiceQuestion(BaseModel):
    model_config = ConfigDict(extra='forbid')
    request_id: UUID
    question: str = Field(min_length=1, max_length=2000)
    revision: int = Field(ge=0)
    agent_context: list[HeardTurn] | None = Field(default=None, max_length=3)

    @field_validator('question')
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError('Question is empty')
        return value.strip()


class VoiceLookupQuery(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: Literal['get_recent_transcript', 'search_meeting', 'search_shared_documents', 'search_web', 'read_source_context', 'draft_task', 'draft_decision', 'search_approved_actions', 'calculate', 'search_shared_meetings', 'open_source']
    query: str = Field(default='', max_length=200)

    @field_validator('query')
    @classmethod
    def nonblank(cls, value, info):
        if info.data.get('name') != 'get_recent_transcript' and not value.strip():
            raise ValueError('Search query is empty')
        if info.data.get('name') in ('read_source_context','open_source') and not re.fullmatch(r'ctx-[0-9a-f]{64}',value.strip()):
            raise ValueError('Invalid context handle')
        return value.strip()


class VoiceAgentQuestion(VoiceQuestion):
    operation: Literal['context', 'plan', 'lookup', 'flow_plan', 'flow_apply']
    lookup: VoiceLookupQuery | None = None


DiagnosticCode = Literal[
    'starting', 'listening', 'waiting_asr', 'tts_unavailable', 'sources_unavailable', 'name_not_matched', 'name_unconfirmed', 'wake_confirmed',
    'waiting_speech_end', 'waiting_asr_tail', 'waiting_question', 'thinking', 'speaking',
    'waiting_quiet', 'stopped', 'completed', 'question_timeout', 'ambiguous_audio',
    'ambiguous_window', 'stale_asr', 'asr_unavailable', 'services_unavailable',
    'worker_failed', 'kws_unavailable', 'answer_failed', 'no_evidence', 'playback_failed', 'policy_changed',
    'interrupted', 'waiting_turn_end', 'livekit_unavailable', 'no_input', 'dialogue_paused',
]
DIAGNOSTIC_TTL_SECONDS = 30


class VoiceDiagnostic(BaseModel):
    model_config = ConfigDict(extra='forbid')
    event_id: UUID
    code: DiagnosticCode
    observed_at_ms: int = Field(ge=0, strict=True)
    heard_prefix: str | None = Field(default=None, max_length=64)
    heard_at_ms: int | None = Field(default=None, ge=0, strict=True)
    channel: int | None = Field(default=None, ge=0, lt=65536, strict=True)
    source_start_ms: float | None = Field(default=None, ge=0, allow_inf_nan=False)

    @field_validator('heard_prefix')
    @classmethod
    def prefix_only(cls, value):
        if value is None: return None
        # Three words only. The full question remains in the existing transcript, not diagnostics.
        return ' '.join(''.join(c if c.isprintable() else ' ' for c in value).split()[:3]) or None


class AudioChannel(BaseModel):
    model_config = ConfigDict(extra='forbid')
    channel: int = Field(ge=0, lt=65536, strict=True)
    frames: int = Field(ge=0, le=9007199254740991, strict=True)
    samples: int = Field(ge=0, le=9007199254740991, strict=True)
    last_frame_ms: int = Field(ge=0, strict=True)
    rms: float = Field(ge=0, le=1, allow_inf_nan=False)
    sample_clock: StrictBool
    gap_samples: int = Field(ge=0, le=9007199254740991, strict=True)
    overlap_samples: int = Field(ge=0, le=9007199254740991, strict=True)
    clock_resets: int = Field(ge=0, le=9007199254740991, strict=True)
    asr_inflight: int = Field(ge=0, le=64, strict=True)
    asr_errors: int = Field(ge=0, le=9007199254740991, strict=True)
    asr_at_ms: int | None = Field(default=None, ge=0, strict=True)
    capture_lag_ms: float | None = Field(default=None, ge=0, le=3600000, allow_inf_nan=False)
    capture_age_ms: float | None = Field(default=None, ge=0, le=3600000, allow_inf_nan=False)
    roundtrip_ms: float | None = Field(default=None, ge=0, le=3600000, allow_inf_nan=False)
    queue_ms: float | None = Field(default=None, ge=0, le=3600000, allow_inf_nan=False)


class AudioSnapshot(BaseModel):
    model_config = ConfigDict(extra='forbid')
    observed_at_ms: int = Field(ge=0, strict=True)
    channels: list[AudioChannel] = Field(max_length=16)
    noise_suppression: Literal['off','starting','low','failed'] | None = None

    @field_validator('channels')
    @classmethod
    def unique_channels(cls, rows):
        if len({r.channel for r in rows}) != len(rows): raise ValueError('Duplicate audio channel')
        return rows


class KwsStatus(BaseModel):
    model_config = ConfigDict(extra='forbid')
    engine: Literal['livekit-wakeword']
    version: Literal['2.1.1']
    mode: Literal['activation']
    device: Literal['cpu']
    status: Literal['off', 'starting', 'ready', 'failed']
    models: list[Literal['hey_tina', 'tina_oi']] = Field(min_length=2, max_length=2)
    observed_at_ms: int = Field(ge=0, strict=True)

    @field_validator('models')
    @classmethod
    def retained_models(cls, values):
        if len(set(values)) != 2: raise ValueError('Expected both retained KWS models')
        return values


class VoiceState(BaseModel):
    model_config = ConfigDict(extra='forbid')
    state: str = Field(pattern=STATES)
    request_id: UUID | None = None
    diagnostic: VoiceDiagnostic | None = None
    audio: AudioSnapshot | None = None
    kws: KwsStatus | None = None


def voice_pilot_rooms() -> set[str]:
    return set(os.environ.get('TINA_MEETING_VOICE_PILOT_ROOM', '').replace(',', ' ').split())


def voice_pilot_user_allowed(user_id: int | str) -> bool:
    raw = os.environ.get('TINA_MEETING_VOICE_PILOT_USER_IDS', '').strip()
    if not raw:
        return True
    allowed = {entry.strip() for entry in raw.split(',') if entry.strip()}
    return '*' in allowed or str(user_id) in allowed


def new_meeting_voice_policy(*, transcript_only=False, agent_backend=None):
    """Seed new capable rooms; saved policies and document grants remain owner-controlled."""
    if transcript_only:
        return VoicePolicy(enabled=True, include_transcript=True, noise_suppression=True,
                           engine='livekit', agent_backend='completion').model_dump()
    backend = agent_backend or ('completion' if os.environ.get('TINA_MEETING_VOICE_AGENT_BACKEND') == 'completion' else 'sandbox')
    return VoicePolicy(enabled=True,include_transcript=True,include_workspace_wiki=True,noise_suppression=True,
                       allow_general_knowledge=True,allow_web_search=True,auto_web_search=True,
                       engine='livekit',agent_backend=backend).model_dump()


def policy_of(row):
    saved=dict((row.get('data') or {}).get('voice_assistant') or {})
    # Ignore the retired selector in saved rows; source grants and strict incoming validation stay intact.
    saved.pop('agent_runtime',None)
    return VoicePolicy.model_validate(saved)


def build_voice_router(repo, redis, publisher, playback=None, client_factory=httpx.AsyncClient):
    router = APIRouter()
    task_flows = TaskFlowStore(redis, playback)
    handoffs = VoiceHandoffs(redis, playback)
    ready_inflight: dict[str, asyncio.Task[tuple[bool, str | None]]] = {}

    async def meeting(mid, user=None, session: str | None = None, authorization=None):
        row = await repo.get_meeting(mid)
        if row is None or (user is not None and str(row['user_id']) != str(user)):
            raise HTTPException(404, 'Meeting not found')
        if session is not None:
            secret = os.environ.get('ADMIN_TOKEN', '')
            expected = voice_token(secret, mid, session) if secret else ''
            if not expected or not hmac.compare_digest((authorization or '').encode(), ('Bearer ' + expected).encode()):
                raise HTTPException(401, 'Invalid voice capability')
            sessions = await repo.list_sessions(meeting_id=mid)
            if (row.get('status') != 'active' or not sessions or sessions[-1] != session
                    or (row.get('data') or {}).get('stop_requested')):
                raise HTTPException(409, 'Voice session is no longer active')
        return row

    async def agent(row, suffix, body=None, *, request_id=None):
        base = os.environ.get('AGENT_API_URL', '').rstrip('/')
        secret = os.environ.get('INTERNAL_API_SECRET', '')
        if not base or not secret:
            raise HTTPException(503, 'Meeting voice service is not configured')
        started, status = time.monotonic(), 'error'
        headers = {'X-User-Id': str(row['user_id']), 'X-Internal-Secret': secret}
        if request_id is not None: headers['X-Tina-Voice-Request-Id'] = str(request_id)
        try:
            timeout = 4 if suffix == 'ready' else (150 if suffix == 'answer' else 95)
            async with client_factory(timeout=timeout, follow_redirects=False) as client:
                response = await client.request('POST' if body is not None else 'GET',
                    f'{base}/api/internal/meeting-voice/{row["id"]}/{suffix}', json=body,
                    headers=headers)
                if response.status_code in (401,403,404,409,422):
                    raise HTTPException(response.status_code,'Voice request or shared sources changed; refresh before retrying')
                if response.status_code >= 400 or len(response.content) > 200000:
                    raise HTTPException(503, 'Approved meeting sources are unavailable')
                result = response.json()
                status = 'ok'
                return result
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, 'Meeting voice service is unavailable') from exc
        finally:
            if request_id is not None:
                stage = 'tool_' + body['operation'] if suffix == 'agent' else 'answer_service'
                log.info('%s', json.dumps({'type': 'voice_stage',
                    'request_id': str(request_id), 'stage': stage, 'status': status,
                    'elapsed_ms': round((time.monotonic() - started) * 1000)}))

    def keys(mid, session, request):
        return f'meeting:voice:{mid}:lock', f'meeting:voice:{mid}:{session}:{request}'

    async def progress(mid, session: str, body, stage):
        value = VoiceProgress(request_id=body.request_id, session_uid=session,
                              revision=body.revision, stage=stage, observed_at_ms=int(time.time()*1000))
        await redis.set(f'meeting:voice:{mid}:progress', value.model_dump_json(), ex=180)


    async def reserve(mid, session: str, request):
        lock, _ = keys(mid, session, request)
        for _ in range(4):
            try:
                async with redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(lock)
                    held = await pipe.get(lock)
                    if isinstance(held, bytes): held = held.decode()
                    sessions = await repo.list_sessions(meeting_id=mid)
                    if not sessions or sessions[-1] != session:
                        raise HTTPException(409, 'Voice session is no longer active')
                    retired = [s for s in sessions if s != session]
                    if held:
                        previous, separator, identifier = held.rpartition(':')
                        if not separator or previous not in retired:
                            raise HTTPException(409, 'Another voice turn is active')
                        try: UUID(identifier)
                        except ValueError: raise HTTPException(409, 'Unknown voice reservation') from None
                    if playback is not None and retired:
                        await playback.retire_previous_sessions(mid, retired)
                    pipe.multi()
                    pipe.set(lock, f'{session}:{request}', ex=360)
                    await pipe.execute()
                    return
            except WatchError:
                continue
        raise HTTPException(409, 'Voice reservation changed concurrently')

    async def release(mid, session: str, request):
        lock, _ = keys(mid, session, request)
        for _ in range(3):
            async with redis.pipeline(transaction=True) as pipe:
                try:
                    await pipe.watch(lock)
                    held = await pipe.get(lock)
                    if isinstance(held, bytes): held = held.decode()
                    if held != f'{session}:{request}': return
                    pipe.multi()
                    pipe.delete(lock)
                    await pipe.execute()
                    return
                except WatchError:
                    continue


    @router.get('/internal/meeting-voice/{mid}/turn/{request_id}', response_model=VoiceTurnPermit, include_in_schema=False)
    async def current_summary_turn(mid: int, request_id: UUID,
                                   x_user_id: str | None = Header(default=None),
                                   x_internal_secret: str | None = Header(default=None)):
        secret = os.environ.get('INTERNAL_API_SECRET', '')
        if not secret or not x_user_id or not x_internal_secret or not hmac.compare_digest(secret.encode(), x_internal_secret.encode()):
            raise HTTPException(401, 'Internal voice credential required')
        row = await meeting(mid, _resolve_user_id(x_user_id))
        sessions = await repo.list_sessions(meeting_id=mid)
        if (row.get('status') != 'active' or not sessions or not policy_of(row).enabled
                or (row.get('data') or {}).get('artifact_deletion')):
            return {'current': False}
        held = await redis.get(f'meeting:voice:{mid}:lock')
        if isinstance(held, bytes): held = held.decode()
        return {'current': held == f'{sessions[-1]}:{request_id}'}

    @router.get('/bots/voice/{mid}/{session}/turn/{request_id}', response_model=VoiceTurnPermit, include_in_schema=False)
    async def current_agent_turn(mid: int, session: str, request_id: UUID, revision: int,
                                 authorization: str | None = Header(default=None)):
        row = await meeting(mid, session=session, authorization=authorization)
        policy = policy_of(row)
        if (not policy.enabled or policy.engine != 'livekit' or policy.revision != revision
                or (row.get('data') or {}).get('artifact_deletion')):
            return {'current': False}
        held = await redis.get(f'meeting:voice:{mid}:lock')
        if isinstance(held, bytes): held = held.decode()
        return {'current': held == f'{session}:{request_id}'}


    @router.get('/meetings/{meeting_id}/voice-assistant')
    async def get_policy(meeting_id: int, x_user_id: str | None = Header(default=None)):
        mid = meeting_id
        row = await meeting(mid, _resolve_user_id(x_user_id))
        sessions = await repo.list_sessions(meeting_id=mid) if row.get('status') == 'active' else []
        active_session = sessions[-1] if row.get('status') == 'active' and sessions else None
        state, diagnostic, raw_progress, held, raw_issue = await redis.mget(f'meeting:voice:{mid}:state',
            f'meeting:voice:{mid}:diagnostic', f'meeting:voice:{mid}:progress', f'meeting:voice:{mid}:lock',
            f'meeting:voice:{mid}:provider-issue')
        runtime = json.loads(state) if state else {}
        if not active_session or runtime.get('session_uid') != active_session:
            runtime = {}
        audio = runtime.get('audio')
        if audio and int(time.time() * 1000) - audio['observed_at_ms'] > 15000:
            runtime.pop('audio', None)
        detail = json.loads(diagnostic) if diagnostic else None
        if (not active_session or not detail or detail.get('session_uid') != active_session
                or detail.get('expires_at_ms', 0) <= int(time.time() * 1000)):
            detail = None
        policy = policy_of(row)
        issue = None
        if active_session and policy.enabled and raw_issue:
            with suppress(ValueError, AttributeError):
                candidate = json.loads(raw_issue)
                if (candidate.get('session_uid') == active_session
                        and candidate.get('code') in ('reconnect_required', 'usage_limit')):
                    issue = candidate['code']
        current_progress = live_progress(raw_progress, held, active_session, policy.revision, runtime.get('request_id')) \
            if policy.enabled and runtime.get('state') == 'THINKING' and runtime.get('request_id') else None
        return {'replies': public_replies(row, active_session, bool(runtime)),
                'chatgpt_plan_issue': issue,
                'livekit_available': bool(os.environ.get('LIVEKIT_AGENT_URL', '').strip()),
                'available': bool((row.get('data') or {}).get('voice_assistant_capable')),
                'policy': policy_of(row).model_dump(), 'runtime': {
                    **runtime, 'state': runtime.get('state', 'OFF'), 'session_active': bool(active_session),
                    'heartbeat_fresh': bool(runtime), 'diagnostic': detail, 'progress': current_progress,
                    'navigation':await navigation_hint(mid,row,runtime),
                    'handoff':await handoffs.hint(mid,policy.revision,active_session,runtime)
                        if policy.enabled and not (row.get('data') or {}).get('artifact_deletion') else None}}

    async def handoff_context(mid,rid,user,claim):
        row=await meeting(mid,user);policy=policy_of(row)
        if not policy.enabled or (row.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(409,'Voice sharing is no longer available')
        sessions=await repo.list_sessions(meeting_id=mid) if row.get('status')=='active' else []
        value=await handoffs.read(mid,rid,policy.revision,sessions[-1] if sessions else None)
        if not claim and not value['claimed']:raise HTTPException(409,'Open this handoff from the meeting first')
        sources=VoiceSources.model_validate(await agent(row,'sources',{'sources':value['source_refs']}))
        fresh=await meeting(mid,user)
        if sources.unavailable or policy_of(fresh)!=policy or (fresh.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(409,'Voice sources changed; start a new request')
        # Claim only after rechecking playback/session and sharing after the source lookup.
        fresh_sessions=await repo.list_sessions(meeting_id=mid) if fresh.get('status')=='active' else []
        value=await handoffs.read(mid,rid,policy.revision,fresh_sessions[-1] if fresh_sessions else None)
        if claim:value=await handoffs.claim(mid,rid,value)
        return public_context(mid,value,sources.sources)

    @router.post('/meetings/{meeting_id}/voice-assistant/handoff/{request_id}',response_model=VoiceHandoff)
    async def claim_handoff(meeting_id:int,request_id:UUID,response:Response,x_user_id:str|None=Header(default=None)):
        response.headers['Cache-Control']='no-store'
        return await handoff_context(meeting_id,str(request_id),_resolve_user_id(x_user_id),True)

    @router.get('/meetings/{meeting_id}/voice-assistant/handoff/{request_id}',response_model=VoiceHandoff)
    async def read_handoff(meeting_id:int,request_id:UUID,response:Response,x_user_id:str|None=Header(default=None)):
        response.headers['Cache-Control']='no-store'
        return await handoff_context(meeting_id,str(request_id),_resolve_user_id(x_user_id),False)

    async def navigation_hint(mid,row,runtime=None):
        raw=await redis.get(f'meeting:voice:{mid}:navigation')
        if not raw:return None
        value=json.loads(raw);policy=policy_of(row)
        sessions=await repo.list_sessions(meeting_id=mid) if row.get('status')=='active' else []
        if runtime is None:runtime=json.loads(await redis.get(f'meeting:voice:{mid}:state') or '{}')
        held=await redis.get(f'meeting:voice:{mid}:lock')
        if isinstance(held,bytes):held=held.decode()
        reply=((row.get('data') or {}).get('voice_replies') or {}).get(value['request_id'],{})
        if (not sessions or not policy.enabled or policy.revision!=value['revision']
                or (row.get('data') or {}).get('artifact_deletion') or value['session_uid']!=sessions[-1]
                or runtime.get('session_uid')!=sessions[-1] or runtime.get('state') in ('OFF','ERROR')
                or runtime.get('request_id') not in (None,value['request_id'])
                or held not in (None,f"{value['session_uid']}:{value['request_id']}")
                or reply.get('session_uid')!=sessions[-1] or reply.get('state')!='completed'
                or not value['created_at_ms']<=int(time.time()*1000)<value['expires_at_ms']):return None
        return {k:value[k] for k in VoiceNavigationHint.model_fields}

    @router.post('/meetings/{meeting_id}/voice-assistant/navigation/{request_id}',response_model=VoiceNavigation)
    async def claim_navigation(meeting_id:int,request_id:UUID,x_user_id:str|None=Header(default=None)):
        mid=meeting_id;user=_resolve_user_id(x_user_id)
        row=await meeting(mid,user);hint=await navigation_hint(mid,row)
        if not hint or hint['request_id']!=str(request_id):raise HTTPException(409,'Source navigation expired or changed')
        key=f'meeting:voice:{mid}:navigation';raw=await redis.get(key);value=json.loads(raw or '{}')
        if value.get('request_id')!=str(request_id):raise HTTPException(409,'Source navigation changed')
        sources=VoiceSources.model_validate(await agent(row,'sources',{'sources':value['source_refs']}))
        target=next((s for s in sources.sources if s.id==value['target_id'] and s.kind!='calculation'),None)
        fresh=await meeting(mid,user)
        if target is None or policy_of(fresh)!=policy_of(row) or await navigation_hint(mid,fresh)!=hint:
            raise HTTPException(409,'Source is no longer shared')
        async with redis.pipeline(transaction=True) as pipe:
            try:
                await pipe.watch(key,f'meeting:voice:{mid}:state',f'meeting:voice:{mid}:lock')
                current,state,held=await pipe.mget(key,f'meeting:voice:{mid}:state',f'meeting:voice:{mid}:lock')
                if isinstance(held,bytes):held=held.decode()
                state=json.loads(state or '{}')
                if (current!=raw or state.get('state') in ('OFF','ERROR') or state.get('session_uid')!=hint['session_uid']
                        or state.get('request_id') not in (None,str(request_id))
                        or held not in (None,f"{hint['session_uid']}:{request_id}")):
                    raise HTTPException(409,'Source navigation changed')
                claim=key+':claimed:'+str(request_id)
                await pipe.watch(claim)
                if await pipe.get(claim):raise HTTPException(409,'Source navigation already claimed')
                pipe.multi();pipe.set(claim,'1',ex=60);await pipe.execute()
            except WatchError:raise HTTPException(409,'Source navigation changed') from None
        return VoiceNavigation(**hint,source=target)

    @router.get('/meetings/{meeting_id}/voice-assistant/sources/{request_id}', response_model=VoiceSources)
    async def reply_sources(meeting_id: int, request_id: UUID, x_user_id: str | None = Header(default=None)):
        user = _resolve_user_id(x_user_id)
        row = await meeting(meeting_id, user)
        if (row.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(404, 'Meeting artifacts were deleted')
        reply = ((row.get('data') or {}).get('voice_replies') or {}).get(str(request_id))
        if reply is None: raise HTTPException(404, 'Voice reply not found')
        refs = [r.model_dump() for r in VoiceReply.model_validate({k:v for k,v in reply.items() if k!='session_uid'}).source_refs]
        result = VoiceSources.model_validate(await agent(row, 'sources', {'sources': refs}))
        fresh = await meeting(meeting_id, user)
        if policy_of(fresh) != policy_of(row) or (fresh.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(409, 'Voice sources changed')
        return result

    @router.put('/meetings/{meeting_id}/voice-assistant')
    async def set_policy(meeting_id: int, body: VoicePolicy, x_user_id: str | None = Header(default=None)):
        mid = meeting_id
        user = _resolve_user_id(x_user_id)
        row = await meeting(mid, user)
        if mid in body.shared_meeting_ids: raise HTTPException(422,'The current meeting already has its own transcript option')
        for shared_id in body.shared_meeting_ids:
            shared=await meeting(shared_id,user)
            if (shared.get('data') or {}).get('artifact_deletion'):
                raise HTTPException(409,'A selected meeting has deleted artifacts')
        if body.noise_suppression and (row.get('platform') != 'google_meet' or not (row.get('data') or {}).get('voice_assistant_capable')):
            raise HTTPException(409, 'Start a new voice-capable Google Meet bot before testing noise suppression')
        if body.enabled:
            if body.engine == 'livekit' and not os.environ.get('LIVEKIT_AGENT_URL', '').strip():
                raise HTTPException(503, 'The self-hosted LiveKit pilot is not configured')
            if row.get('status') not in {'requested', 'joining', 'awaiting_admission', 'active'}:
                raise HTTPException(409, 'Start a new bot session before enabling voice')
            if row.get('platform') != 'google_meet':
                raise HTTPException(422, 'Voice assistant currently supports Google Meet')
            if not (row.get('data') or {}).get('voice_assistant_capable'):
                raise HTTPException(409, 'Start a new voice-enabled bot before enabling the assistant')
            if (row.get('data') or {}).get('transcribe_enabled') is False:
                raise HTTPException(409, 'Enable transcription for the bot before enabling voice questions')
            if not body.include_transcript and not body.include_workspace_wiki and not body.include_approved_actions and not body.shared_meeting_ids and not body.documents and not body.allow_general_knowledge and not body.allow_web_search:
                raise HTTPException(422, 'Choose sources that may be spoken to this room')
            available = await agent(row, 'profile', body.model_dump()) if body.source_profile_id or policy_of(row).source_profile_id or body.include_workspace_wiki != policy_of(row).include_workspace_wiki else await agent(row, 'ready')
            if any(path not in available['documents'] for path in body.documents):
                raise HTTPException(422, 'Choose documents linked to this meeting')
        try:
            saved = await repo.set_voice_policy(mid, user, body.revision, body.model_dump())
        except ValueError as exc:
            raise HTTPException(409, 'Voice settings changed; reload before saving') from exc
        # Any policy change cancels in-flight thought/playback, including a source revocation.
        await publisher.publish(leave_command_channel(mid), json.dumps({'action': 'speak_stop'}))
        return {'policy': saved, 'runtime': {'state': 'OFF' if not body.enabled else 'QUIET'}}

    @router.get('/bots/voice/{mid}/{session}/config', include_in_schema=False)
    async def config(mid: int, session: str, authorization: str | None = Header(default=None),
                     x_tina_voice_runtime: str | None = Header(default=None)):
        row = await meeting(mid, session=session, authorization=authorization)
        policy = policy_of(row)
        from .speech_profile import room_profile
        speech_profile=await room_profile(row,session,redis,client_factory) if policy.enabled else None
        ready = False
        reason = None
        if policy.enabled:
            ready_key = f'meeting:voice:{mid}:{session}:ready:{policy.revision}'
            bridge = x_tina_voice_runtime == 'livekit-v1'
            if policy.engine == 'livekit': ready_key += ':bridge' if bridge else ':legacy'
            cached = None if policy.source_profile_id else await redis.get(ready_key)
            if cached is not None:
                if cached in ('1', b'1', '0', b'0'):
                    ready = cached in ('1', b'1')
                else:
                    verdict = json.loads(cached)
                    ready, reason = verdict['ready'], verdict.get('reason')
            else:
                async def _probe_ready() -> tuple[bool, str | None]:
                    probe_ready = False
                    probe_reason = 'livekit_unavailable' if policy.engine == 'livekit' and not bridge else None
                    try:
                        available = await agent(row, 'ready')
                        if any(path not in available['documents'] for path in policy.documents):
                            raise HTTPException(409, 'Shared source was removed')
                    except HTTPException:
                        probe_reason = 'sources_unavailable'
                    if probe_reason is None:
                        url = os.environ.get('TTS_SERVICE_URL', '').rstrip('/')
                        try:
                            if url:
                                async with client_factory(timeout=4, follow_redirects=False) as client:
                                    response = await client.get(url + '/ready', headers={'X-API-Key': os.environ.get('TTS_API_TOKEN', '')})
                                    probe_ready = response.status_code == 200
                        except httpx.HTTPError:
                            pass
                        if not probe_ready: probe_reason = 'tts_unavailable'
                    if probe_reason is None and policy.engine == 'livekit':
                        base = os.environ.get('LIVEKIT_AGENT_URL', '').rstrip('/')
                        try:
                            async with client_factory(timeout=4, follow_redirects=False) as client:
                                response = await client.get(base + '/ready') if base else None
                                probe_ready = bool(response is not None and response.status_code == 200
                                                   and response.json().get('engine') == 'livekit-agents')
                        except (httpx.HTTPError, ValueError):
                            probe_ready = False
                        if not probe_ready: probe_reason = 'livekit_unavailable'
                    # Readiness is advisory; answers always recheck live policy/source fingerprints.
                    await redis.set(ready_key, json.dumps({'ready': probe_ready, 'reason': probe_reason}),
                                    ex=15 if probe_ready else 5)
                    return probe_ready, probe_reason

                flight_key = f'{ready_key}:{policy.source_profile_id or ""}'
                task = ready_inflight.get(flight_key)
                if task is None or task.done():
                    task = asyncio.create_task(_probe_ready())
                    ready_inflight[flight_key] = task
                    def _cleanup_ready(done_task: asyncio.Task, key: str = flight_key) -> None:
                        if ready_inflight.get(key) is done_task:
                            ready_inflight.pop(key, None)
                        if not done_task.cancelled():
                            done_task.exception()
                    task.add_done_callback(_cleanup_ready)
                ready, reason = await asyncio.shield(task)
        if ready and speech_profile:
            try:
                async with client_factory(timeout=4,follow_redirects=False) as client:
                    response=await client.post(os.environ.get('TTS_SERVICE_URL','').rstrip('/')+'/v1/voices/warm',
                        headers={'X-API-Key':os.environ.get('TTS_API_TOKEN','')},json={'profile':speech_profile,'meeting_id':mid})
                    ready=response.status_code==200 and response.json().get('ready') is True
            except (httpx.HTTPError,ValueError):ready=False
            if not ready:reason='tts_unavailable'
        current_progress = None
        if ready and policy.enabled:
            raw_progress, held = await redis.mget(f'meeting:voice:{mid}:progress', f'meeting:voice:{mid}:lock')
            current_progress = live_progress(raw_progress, held, session, policy.revision)
        return {'enabled': policy.enabled, 'ready': ready, 'revision': policy.revision,
                **({'progress': current_progress} if current_progress else {}),
                'engine': policy.engine,
                'agent_url': (os.environ.get('LIVEKIT_AGENT_URL', '').rstrip('/') + f'/bots/{mid}/{session}')
                    if policy.engine == 'livekit' and os.environ.get('LIVEKIT_AGENT_URL', '').strip() else None,
                'wake_variants': policy.wake_variants, 'noise_suppression':policy.noise_suppression,
                **({'speech_profile':speech_profile} if speech_profile else {}),'unavailable_reason': reason}

    @router.post('/bots/voice/{mid}/{session}/state', include_in_schema=False)
    async def state(mid: int, session: str, body: VoiceState, authorization: str | None = Header(default=None)):
        await meeting(mid, session=session, authorization=authorization)
        now_ms = int(time.time() * 1000)
        if body.kws and not now_ms - 15000 < body.kws.observed_at_ms <= now_ms + 5000:
            raise HTTPException(422, 'Invalid KWS observation clock')
        if body.audio and (body.audio.observed_at_ms > now_ms + 5000
                or any(r.last_frame_ms > body.audio.observed_at_ms + 5000 or (r.asr_at_ms or 0) > body.audio.observed_at_ms + 5000 for r in body.audio.channels)):
            raise HTTPException(422, 'Invalid audio observation clock')
        state_key,lock = f'meeting:voice:{mid}:state',f'meeting:voice:{mid}:lock'
        accepted = False
        for attempt in range(3):
            try:
                async with redis.pipeline(transaction=True) as pipe:
                    await pipe.watch(state_key,lock)
                    held,current = await pipe.mget(lock,state_key)
                    if isinstance(held,bytes): held=held.decode()
                    current=json.loads(current) if current else {}
                    if body.request_id and (held and held != f'{session}:{body.request_id}'
                            or not held and current.get('session_uid')==session
                            and current.get('state') in ('CAPTURING','THINKING','SPEAKING')
                            and current.get('request_id') not in (None,str(body.request_id))):
                        break
                    pipe.multi()
                    pipe.set(state_key,json.dumps(body.model_dump(mode='json',exclude={'diagnostic'})
                             | {'session_uid':session}),ex=15)
                    await pipe.execute();accepted=True;break
            except WatchError: continue
        detail = body.diagnostic if accepted else None
        if detail:
            heard_at = detail.heard_at_ms if detail.heard_prefix and detail.heard_at_ms is not None else detail.observed_at_ms
            born = min(detail.observed_at_ms, heard_at)
            if (now_ms - DIAGNOSTIC_TTL_SECONDS * 1000 < born
                    and max(detail.observed_at_ms, heard_at) <= now_ms + 5000):
                key = f'meeting:voice:{mid}:diagnostic'
                for _ in range(3):
                    try:
                        async with redis.pipeline(transaction=True) as pipe:
                            await pipe.watch(key)
                            raw = await pipe.get(key)
                            previous = json.loads(raw) if raw else None
                            if previous and previous.get('session_uid') == session and (
                                    previous.get('event_id') == str(detail.event_id)
                                    or previous.get('observed_at_ms', 0) > detail.observed_at_ms):
                                break
                            # Absolute expiry is based on the original heard/observed time.
                            expires = min(now_ms, born) + DIAGNOSTIC_TTL_SECONDS * 1000
                            pipe.multi()
                            pipe.set(key, json.dumps(detail.model_dump(mode='json') | {
                                'session_uid': session, 'expires_at_ms': expires}), pxat=expires)
                            await pipe.execute()
                            break
                    except WatchError:
                        continue  # Diagnostic contention must not prevent Stop below.
        if body.state in ('QUIET', 'OFF') and body.request_id:
            try:
                if playback is not None:
                    try:
                        await playback.cancel(mid, str(body.request_id), session)
                        await playback.report(mid, str(body.request_id), session, 'stopped')
                    except SpeechConflict:
                        pass  # An unrelated manual Speak owns the active reservation.
            finally:
                await release(mid, session, body.request_id)
        return {'accepted': True}

    async def heard_history(mid, session: str, policy, speaker, row):
        key = f'meeting:voice:{mid}:{session}:history:{policy.revision}:{speaker}' if speaker else None
        stored = json.loads(await redis.get(key) or '[]') if key else []
        replies = (row.get('data') or {}).get('voice_replies') or {}
        history = []
        for turn in stored:
            reply = replies.get(turn['request_id'], {})
            if reply.get('session_uid') != session: continue
            if reply.get('state') == 'completed':
                history.append(turn | {'created_at_ms': reply.get('ended_at_ms') or turn['created_at_ms']})
            elif reply.get('state') == 'stopped' and reply.get('played_text'):
                history.append(turn | {'answer': reply['played_text'], 'sources': [],
                                       'heard_source_guards':turn.get('heard_source_guards',turn['sources']),
                                       'clarification': False, 'follow_up': None, 'heard_partial': True})
        history = history[-3:]
        return key, history, [{k: v for k, v in t.items() if k != 'request_id'} for t in history]

    async def prepare_source_navigation(mid, session: str, policy, speaker, row, question):
        _,stored,_=await heard_history(mid,session,policy,speaker,row)
        previous=next((t for t in reversed(stored) if t.get('sources')),None)
        reply=((row.get('data') or {}).get('voice_replies') or {}).get(previous['request_id'],{}) if previous else {}
        heard_at=reply.get('ended_at_ms') or reply.get('updated_at_ms') or (previous or {}).get('created_at_ms',0)
        if (not previous or reply.get('state')!='completed' or reply.get('session_uid')!=session
                or not 0<=int(time.time()*1000)-heard_at<=120000):
            return {'status':'missing'}
        sources=VoiceSources.model_validate(await agent(row,'sources',{'sources':previous['sources']}))
        if sources.unavailable:return {'status':'revoked'}
        target,status=select_open_source(question,sources.sources)
        return {'status':status,'target_id':target.id if target else None,'source_refs':previous['sources']}

    def turn_fingerprint(body, speaker):
        return hashlib.sha256(json.dumps({'question': body.question, 'revision': body.revision,
            'request_id': str(body.request_id), 'speaker': speaker}, sort_keys=True).encode()).hexdigest()

    def match_context(context, history):
        # SDK context may select heard turns, but cannot introduce or edit one.
        wanted = [t.model_dump() for t in context or []]
        matched = [t for t in history if {k: t[k] for k in ('question','answer','created_at_ms')} in wanted]
        if [{k:t[k] for k in ('question','answer','created_at_ms')} for t in matched] != wanted:
            raise HTTPException(409, 'Conversation is no longer current')
        return matched

    async def livekit_reservation(mid, session: str, body, speaker, policy):
        if policy.engine != 'livekit': raise HTTPException(409, 'LiveKit room policy required')
        lock, key = keys(mid, session, body.request_id)
        saved = json.loads(await redis.get(key + ':agent') or '{}')
        held = await redis.get(lock)
        if isinstance(held, bytes): held = held.decode()
        if held != f'{session}:{body.request_id}' or saved.get('fingerprint') != turn_fingerprint(body, speaker):
            raise HTTPException(409, 'Agent turn is no longer reserved')
        return lock, key, saved

    @router.post('/bots/voice/{mid}/{session}/agent', include_in_schema=False)
    async def agent_operation(mid: int, session: str, body: VoiceAgentQuestion,
            authorization: str | None = Header(default=None),
            x_voice_speaker_key: str | None = Header(default=None, pattern=r'^[0-9a-f]{64}$', max_length=64)):
        row = await meeting(mid, session=session, authorization=authorization)
        policy = policy_of(row)
        if not policy.enabled or policy.revision != body.revision or policy.engine != 'livekit':
            raise HTTPException(409, 'LiveKit sharing policy changed')
        if (row.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(409, 'Meeting artifacts were deleted')
        lock, key = keys(mid, session, body.request_id)
        if body.operation == 'context':
            if body.agent_context is not None or body.lookup is not None:
                raise HTTPException(422, 'Context does not accept worker history or tools')
            if await redis.get(key) or str(body.request_id) in ((row.get('data') or {}).get('voice_replies') or {}):
                raise HTTPException(409, 'Voice request already dispatched')
            if playback is not None and await playback.get(mid, str(body.request_id)):
                raise HTTPException(409, 'Voice request already stopped or played')
            await reserve(mid, session, body.request_id)
            await redis.delete(f'meeting:voice:{mid}:navigation')
            try:
                navigation=({'navigation':await prepare_source_navigation(mid,session,policy,x_voice_speaker_key,row,body.question)}
                    if open_source_intent(body.question) else {})
                await redis.set(key + ':agent', json.dumps({'fingerprint': turn_fingerprint(body, x_voice_speaker_key),
                    'lookups': [], 'completed': [], 'executed': [], 'planned': [], 'context_handles': [],
                    'plan_round':0, 'retrieval_deadline_ms':int(time.time()*1000)+30000,**navigation}),ex=240)
            except BaseException:
                await release(mid,session,body.request_id);raise
        lock, key, saved = await livekit_reservation(mid, session, body, x_voice_speaker_key, policy)
        if body.operation!='context' and await redis.get(key+':final'):
            raise HTTPException(409,'Agent answer already dispatched')
        _, _, history = await heard_history(mid, session, policy, x_voice_speaker_key, row)
        payload = {'operation': body.operation, 'question': body.question, 'revision': body.revision,
                   'history': history if body.operation == 'context' else match_context(body.agent_context, history)}
        try:
            if body.operation in ('flow_plan','flow_apply'):
                flow=saved.get('task_flow')
                if not flow or body.lookup is not None:
                    raise HTTPException(403,'No caller-scoped task flow')
                updated={**saved,'task_flow':dict(flow)}
                if body.operation=='flow_plan':
                    if flow.get('proposal'): raise HTTPException(409,'Task flow already planned')
                    if not await redis.set(key+':flow-plan','1',nx=True,ex=240):
                        raise HTTPException(409,'Task flow planning already requested')
                    try:
                        suffix,field=('decision-flow','decision_state') if flow.get('kind')=='decision' else ('task-flow','task_state')
                        result=checked_proposal(await agent(row,suffix,{'operation':'plan','question':body.question,
                            'revision':body.revision,field:flow['state'],'recover_prompt':flow.get('recover_prompt',False)},request_id=body.request_id))
                    except HTTPException as exc:
                        if exc.status_code not in (502,503,504): raise
                        result=service_error(flow,body.question)
                    updated['task_flow']['proposal']=result
                    await progress(mid,session,body,'planning')
                else:
                    if not flow.get('proposal') or flow.get('applied'): raise HTTPException(409,'Task flow was not planned or already applied')
                    result=flow['proposal']
                    updated['task_flow']['applied']=True
                    if result['action']=='leave':
                        updated.pop('task_flow')
                fresh=await meeting(mid,session=session,authorization=authorization)
                if policy_of(fresh)!=policy: raise HTTPException(409,'Voice sharing policy changed')
                await task_flows.save_reservation(lock,key,f'{session}:{body.request_id}',saved,updated,
                    clear_key=flow['key'] if body.operation=='flow_apply' and result['action']=='leave' else None)
                return result
            if saved.get('task_flow') and body.operation!='context':
                raise HTTPException(409,'Task flow owns this turn')
            if body.operation == 'plan':
                round_index=saved.get('plan_round',0)
                if round_index>=2 or any(c not in saved['completed'] for c in saved['planned']):
                    raise HTTPException(409,'Agent plan budget exhausted or tools pending')
                if not await redis.set(key + ':plan:'+str(round_index), '1', nx=True, ex=240):
                    raise HTTPException(409, 'Agent plan already requested')
                payload['lookups']=saved['executed']
                payload['context_handles']=saved['context_handles']
            if body.operation == 'lookup':
                if body.lookup is None: raise HTTPException(422, 'Tool query required')
                lookup = body.lookup.model_dump()
                # Reserve the four-call budget atomically, including timed-out/concurrent requests.
                for attempt in range(4):
                    async with redis.pipeline(transaction=True) as pipe:
                        try:
                            await pipe.watch(key + ':agent', lock)
                            _, _, saved = await livekit_reservation(mid, session, body, x_voice_speaker_key, policy)
                            if lookup not in saved.get('planned', []) or lookup in saved['lookups'] or len(saved['lookups']) >= 4:
                                raise HTTPException(409, 'Tool was not planned or its budget is exhausted')
                            if lookup['name']=='read_source_context' and lookup['query'] not in saved['context_handles']:
                                raise HTTPException(403,'Context was not returned in this turn')
                            saved['lookups'].append(lookup)
                            pipe.multi(); pipe.set(key + ':agent', json.dumps(saved), ex=240)
                            await pipe.execute()
                            break
                        except WatchError:
                            if attempt == 3: raise HTTPException(409, 'Agent tool reservation changed') from None
                payload['lookup'] = lookup
                payload['context_handles'] = saved['context_handles']
            stage = {'get_recent_transcript':'searching_transcript', 'search_meeting':'searching_transcript',
                     'search_shared_documents':'reading_documents', 'search_web':'searching_web',
                     'read_source_context':'reading_context', 'draft_task':'drafting',
                     'draft_decision':'drafting', 'search_approved_actions':'reading_documents',
                     'calculate':'planning','search_shared_meetings':'searching_transcript','open_source':'reading_context'}[body.lookup.name] if body.operation == 'lookup' else 'planning'
            await progress(mid, session, body, stage)
            if 'navigation' in saved and body.operation!='context':
                nav=saved['navigation'];call={'name':'open_source','query':nav.get('target_id') or ''}
                if body.operation=='plan':
                    result={'tool_calls':[call] if nav['status']=='ready' and not saved['lookups'] else []}
                else:
                    if body.lookup.model_dump()!=call or nav['status']!='ready':raise HTTPException(403,'Source was not selected in this turn')
                    fresh_sources=VoiceSources.model_validate(await agent(row,'sources',{'sources':nav['source_refs']}))
                    if fresh_sources.unavailable or not any(s.id==nav['target_id'] for s in fresh_sources.sources):
                        raise HTTPException(409,'Source is no longer shared')
                    result={'tool':'open_source','source_count':1,'sources':[]}
            elif body.operation=='context':
                result=await agent(row,'agent',payload,request_id=body.request_id)
                if 'navigation' in saved:result['available_tools']=['open_source'] if saved['navigation']['status']=='ready' else []
                requested=result.pop('task_flow_requested',False) is True
                if result.pop('decision_flow_requested',False) is True:requested='decision'
                flow=await task_flows.context(mid,session,policy.revision,x_voice_speaker_key,requested) if 'navigation' not in saved else None
                if requested=='decision' and flow is None:
                    raise HTTPException(409,'Decision flow needs an identified speaker channel')
                if flow:
                    await task_flows.save_reservation(lock,key,f'{session}:{body.request_id}',saved,{**saved,'task_flow':flow},
                        clear_key=flow['key'] if requested else None)
                    result['task_flow']={'node':flow['node'],**({'kind':'decision'} if flow.get('kind')=='decision' else {})}
                    result['available_tools']=[]
            else:
                payload['retrieval_deadline_ms']=saved['retrieval_deadline_ms']
                remaining=(saved['retrieval_deadline_ms']-int(time.time()*1000))/1000
                try:
                    if remaining<=0: raise TimeoutError()
                    async with asyncio.timeout(remaining):
                        result=await agent(row,'agent',payload,request_id=body.request_id)
                except TimeoutError:
                    result={'tool_calls':[]} if body.operation=='plan' else {
                        'tool':body.lookup.name,'source_count':0,'sources':[],'budget_exhausted':True}
                    if body.operation=='lookup' and body.lookup.name=='search_web':
                        result['web_result']={'text':'','links':[],'reason':'web_unavailable'}
                except HTTPException as exc:
                    local_read = body.operation == 'lookup' and body.lookup.name in RECOVERABLE_READS
                    if exc.status_code!=503 or not (local_read or saved['executed']): raise
                    result={'tool_calls':[]} if body.operation=='plan' else {
                        'tool':body.lookup.name,'source_count':0,'sources':[],'skipped':True,'retrieval_unavailable':True}
                    if body.operation=='lookup' and body.lookup.name=='search_web':
                        result['web_result']={'text':'','links':[],'reason':'web_unavailable'}
            fresh = await meeting(mid, session=session, authorization=authorization)
            if policy_of(fresh) != policy: raise HTTPException(409, 'Voice sharing policy changed')
            _, _, saved = await livekit_reservation(mid, session, body, x_voice_speaker_key, policy)
            if body.operation in ('plan', 'lookup'):
                for attempt in range(4):
                    async with redis.pipeline(transaction=True) as pipe:
                        try:
                            await pipe.watch(key + ':agent', lock)
                            _, _, saved = await livekit_reservation(mid, session, body, x_voice_speaker_key, policy)
                            if body.operation == 'plan':
                                calls = [VoiceLookupQuery.model_validate(c).model_dump() for c in result['tool_calls']]
                                if len(calls)>2 or len(saved['planned'])+len(calls)>4 or any(c in saved['planned'] for c in calls):
                                    raise ValueError('Tool budget exceeded or query repeated')
                                saved['planned'].extend(calls)
                                saved['plan_round']=round_index+1
                            else:
                                if body.lookup.name in RECOVERABLE_READS:
                                    count = result.get('source_count')
                                    if type(count) is not int or count < 0 or not isinstance(result.get('sources'), list):
                                        raise ValueError('Invalid lookup result')
                                    result['lookup_status'] = ('unavailable' if result.get('budget_exhausted') or result.get('skipped')
                                        else 'found' if count > 0 else 'empty')
                                    if result['lookup_status'] == 'unavailable':
                                        saved['retrieval_unavailable'] = True
                                    elif result['lookup_status'] == 'found':
                                        saved['retrieval_has_evidence'] = True
                                saved['completed'].append(body.lookup.model_dump())
                                if not result.get('budget_exhausted') and not result.get('skipped'):
                                    saved['executed'].append(body.lookup.model_dump())
                                    handles=result.get('context_handles',[])
                                    if not isinstance(handles,list) or len(handles)>32 or any(not isinstance(h,str) or not re.fullmatch(r'ctx-[0-9a-f]{64}',h) for h in handles):
                                        raise ValueError('Invalid tool context handles')
                                    saved['context_handles']=list(dict.fromkeys(saved['context_handles']+handles))[-128:]
                                if body.lookup.name == 'search_web': saved['web_result'] = result['web_result']
                                # Concurrent lookup completion must not reorder the next evidence prompt.
                                saved['completed'].sort(key=saved['planned'].index)
                                saved['executed'].sort(key=saved['planned'].index)
                            pipe.multi(); pipe.set(key + ':agent', json.dumps(saved), ex=240)
                            await pipe.execute()
                            break
                        except WatchError:
                            if attempt == 3: raise HTTPException(409, 'Agent turn changed') from None
            return result
        except (ValueError, KeyError, TypeError):
            await release(mid, session, body.request_id)
            raise HTTPException(502, 'Invalid agent operation response') from None
        except BaseException:
            await release(mid, session, body.request_id)
            raise

    @router.post('/bots/voice/{mid}/{session}/answer', include_in_schema=False)
    async def answer(mid: int, session: str, body: VoiceQuestion, authorization: str | None = Header(default=None),
                     x_voice_speaker_key: str | None = Header(default=None, pattern=r'^[0-9a-f]{64}$', max_length=64)):
        row = await meeting(mid, session=session, authorization=authorization)
        policy = policy_of(row)
        if not policy.enabled or policy.revision != body.revision:
            raise HTTPException(409, 'Voice sharing policy changed')
        if (row.get('data') or {}).get('artifact_deletion'):
            raise HTTPException(409, 'Meeting artifacts were deleted')
        if str(body.request_id) in ((row.get('data') or {}).get('voice_replies') or {}):
            raise HTTPException(409, 'Voice request already recorded; do not replay playback')
        lock, key = keys(mid, session, body.request_id)
        fingerprint = turn_fingerprint(body, x_voice_speaker_key)
        prior = await redis.get(key)
        if prior:
            value = json.loads(prior)
            if value['fingerprint'] != fingerprint:
                raise HTTPException(409, 'Voice request changed')
            raise HTTPException(409, 'Voice request already dispatched; do not replay playback')
        holder = f'{session}:{body.request_id}'
        saved = None
        if body.agent_context is not None:
            _, _, saved = await livekit_reservation(mid, session, body, x_voice_speaker_key, policy)
        else:
            await reserve(mid, session, body.request_id)
        try:
            history_key, stored, history = await heard_history(mid, session, policy, x_voice_speaker_key, row)
            await redis.delete(f'meeting:voice:{mid}:navigation')
            payload = {'question': body.question, 'revision': body.revision, 'history': history}
            flow = saved.get('task_flow') if saved is not None else None
            if saved is not None:
                if saved.get('retrieval_unavailable') and not saved.get('retrieval_has_evidence'):
                    raise HTTPException(503, 'Retrieval is unavailable; no verified source lookup remains')
                if flow and not flow.get('applied'):
                    raise HTTPException(409,'Task flow transition has not completed')
                if not flow and (not saved.get('plan_round') or sorted(saved['completed'], key=lambda c:(c['name'],c['query'])) != sorted(saved['planned'], key=lambda c:(c['name'],c['query']))):
                    raise HTTPException(409, 'Agent tools have not completed')
                payload.update(history=match_context(body.agent_context, history), lookups=saved['executed'])
                if 'web_result' in saved: payload['web_result'] = saved['web_result']
                if not await redis.set(key + ':final', '1', nx=True, ex=240):
                    raise HTTPException(409, 'Agent answer already dispatched')
            await progress(mid, session, body, 'answering')
            if flow:
                proposal=flow['proposal']
                if proposal['action']=='finish':
                    try:
                        suffix,field=('decision-flow','decision_state') if flow.get('kind')=='decision' else ('task-flow','task_state')
                        result=await agent(row,suffix,{'operation':'finish','question':body.question,
                            'revision':body.revision,field:proposal['state']},request_id=body.request_id)
                    except HTTPException as exc:
                        if exc.status_code==409 and flow.get('kind')=='decision':
                            proposal=decision_sources_changed(proposal)
                            result={'text':proposal['text'],'sources':[],'answer_kind':'assistant',
                                    'reason':'clarification','clarification':True}
                        else:
                            if exc.status_code not in (502,503,504): raise
                            proposal=service_error({'node':proposal['node'],'state':proposal['state']},body.question,saving=True)
                            proposal['state']['save_uncertain']=True
                            result={'text':proposal['text'],'sources':[],'answer_kind':'assistant',
                                    'reason':'draft_unavailable','clarification':False}
                else:
                    proofs=[]
                    if (flow.get('kind')=='decision' and proposal['action']=='update'
                            and proposal['state'].get('requested_status')=='decided'
                            and proposal['state'].get('evidence_status')=='supported'):
                        proofs=[VoiceSourceRef.model_validate({k:p[k] for k in ('key','fingerprint')}).model_dump()
                                for p in proposal['state'].get('evidence',[])]
                        try:
                            checked=VoiceSources.model_validate(await agent(row,'sources',{'sources':proofs}))
                            if not proofs or checked.unavailable or len(checked.sources)!=len(proofs):
                                proposal=decision_sources_changed(proposal);proofs=[]
                        except HTTPException as exc:
                            if exc.status_code not in (502,503,504):raise
                            proposal=service_error({'node':proposal['node'],'state':proposal['state']},body.question);proofs=[]
                    result={'text':proposal['text'],'sources':proofs,'answer_kind':'assistant',
                        'reason':{'update':'clarification','pause':'clarification_exhausted','service_error':'llm_unavailable'}.get(proposal['action'],'answered'),
                        'clarification':proposal['action']=='update'}
            elif saved is not None and 'navigation' in saved:
                nav=saved['navigation'];status=nav['status']
                if status=='ready':
                    if {'name':'open_source','query':nav['target_id']} not in saved['executed']:
                        raise HTTPException(409,'Source navigation tool has not completed')
                    current_sources=VoiceSources.model_validate(await agent(row,'sources',{'sources':nav['source_refs']}))
                    if current_sources.unavailable or not any(s.id==nav['target_id'] for s in current_sources.sources):
                        raise HTTPException(409,'Source is no longer shared')
                result=navigation_reply(status)
                result['lookups']=[{'tool':'open_source','source_count':1}] if status=='ready' else []
            else:result = await agent(row, 'answer', payload, request_id=body.request_id)
            source_refs = [VoiceSourceRef(key=s['key'], fingerprint=s['fingerprint']).model_dump()
                           for s in result.get('sources', [])[:32]]
            fresh = await meeting(mid, session=session, authorization=authorization)
            held = await redis.get(lock)
            if isinstance(held, bytes): held = held.decode()
            if policy_of(fresh) != policy or held != holder:
                raise HTTPException(409, 'Voice turn was cancelled')
            if playback is not None:
                try:
                    now = int(time.time() * 1000)
                    reply = VoiceReply(request_id=body.request_id, text=result['text'], state='queued',
                                       source_refs=source_refs,
                                       **{k: result[k] for k in ('answer_kind', 'reason', 'links', 'lookups', 'verification') if k in result},
                                       created_at_ms=now, updated_at_ms=now).model_dump(mode='json', exclude_none=True)
                    await playback.begin(mid, str(body.request_id), session, result['text'], 'auto', reply=reply)
                except SpeechConflict as exc:
                    raise HTTPException(409, 'Speech turn was stopped or another playback is active') from exc
            result['evidence_available'] = bool(result.get('sources'))
            if flow:
                await task_flows.stage(flow,proposal,body.request_id,result['text'],lock,holder)
            if x_voice_speaker_key:
                await handoffs.stage(mid,session,policy.revision,body.request_id,body.question,result,
                    history,flow,proposal if flow else None,lock,holder)
            await redis.set(key, json.dumps({'fingerprint': fingerprint, 'answer': result}), ex=240)
            if saved is not None and saved.get('navigation',{}).get('status')=='ready':
                now=int(time.time()*1000)
                hint=VoiceNavigationHint(request_id=body.request_id,session_uid=session,revision=policy.revision,
                    created_at_ms=now,expires_at_ms=now+60000).model_dump(mode='json')
                await redis.set(f'meeting:voice:{mid}:navigation',json.dumps(hint|{
                    'target_id':saved['navigation']['target_id'],'source_refs':saved['navigation']['source_refs']}),ex=60)
            await progress(mid, session, body, 'preparing_speech')
            refs = result.pop('context_refs', []) if result.get('clarification') or result.get('follow_up') else []
            result.pop('context_refs', None)
            refs = refs or [{'key': s['key'], 'fingerprint': s['fingerprint']} for s in result.get('sources', [])]
            if history_key and (refs or result.get('clarification') is True or result.get('follow_up') or result.get('reason')=='clarification_exhausted'):
                turn = {'request_id': str(body.request_id), 'question': body.question, 'answer': result['text'],
                        'clarification': result.get('clarification') is True,
                        'follow_up': result.get('follow_up'),
                        'created_at_ms': int(time.time() * 1000),
                        'sources': refs}
                async with redis.pipeline(transaction=True) as pipe:
                    try:
                        await pipe.watch(lock)
                        held=await pipe.get(lock)
                        if isinstance(held,bytes): held=held.decode()
                        if held!=holder: raise HTTPException(409,'Voice turn was cancelled')
                        # Keep three heard turns plus this pending candidate; unheard replies use no heard slot.
                        pipe.multi();pipe.set(history_key,json.dumps(stored+[turn]),ex=900)
                        await pipe.execute()
                    except WatchError:
                        raise HTTPException(409,'Voice turn was cancelled') from None
            return result
        except BaseException:
            if playback is not None:
                try:
                    await playback.report(mid, str(body.request_id), session, 'failed')
                except Exception:
                    pass  # Clear Redis playback ownership even if durable storage is temporarily unavailable.
            await release(mid, session, body.request_id)
            raise
    return router
