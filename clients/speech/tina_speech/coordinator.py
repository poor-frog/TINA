"""Single-room, single-process speech pilot above the existing Gateway APIs."""
import asyncio
from dataclasses import dataclass, field
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import time
from uuid import UUID, uuid4
import wave

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
import httpx

MAX_WAV = 800000
TERMINAL = {"COMPLETED", "FAILED", "STOPPED"}


@dataclass(frozen=True)
class Room:
    meeting_id: int
    platform: str
    native_meeting_id: str
    operator_user_id: int
    participants: list[int]
    documents: list[str]
    include_transcript: bool
    gateway_url: str
    stt_url: str
    stt_model: str = "whisper-1"

    def __post_init__(self):
        if self.meeting_id <= 0 or self.operator_user_id <= 0 or not self.participants:
            raise ValueError("Explicit meeting/operator/participant enrollment is required")
        if self.platform not in {"google_meet", "zoom", "teams", "jitsi", "browser_session"}:
            raise ValueError("Unsupported speech bot platform")
        if not re.fullmatch(r"[\w.-]{1,200}", self.native_meeting_id):
            raise ValueError("Invalid native meeting identifier")
        if len(self.documents) > 8 or any(not isinstance(p, str) or p.startswith('/') or '\\' in p
                or any(part in {'.', '..'} or part.startswith('.') for part in p.split('/'))
                or PurePosixPath(p).suffix != '.md' for p in self.documents):
            raise ValueError("Only explicit relative Markdown document paths are allowed")
        if not self.include_transcript and not self.documents:
            raise ValueError("Approve at least one source")
        for url in (self.gateway_url, self.stt_url):
            parsed = httpx.URL(url)
            if parsed.scheme not in ('http', 'https') or not parsed.host or parsed.userinfo or parsed.query:
                raise ValueError("Use explicit service URLs without credentials or query strings")

    @property
    def speak_path(self):
        return f"/bots/{self.platform}/{self.native_meeting_id}/speak"


def question_text(text):
    if not isinstance(text, str) or len(text) > 2100:
        raise ValueError("Invalid transcription")
    # Audio includes bounded wake pre-roll. Require that ASR begins with the wake;
    # reject preceding conversation instead of deleting arbitrary transcript words.
    match = re.match(r"^\s*(?:hey|hi|hay|hây|hêy)[\s,.!?-]+ti\s*na\b[\s,.!?;:-]*", text, re.IGNORECASE)
    if not match:
        raise ValueError("Transcription did not begin with the captured wake phrase")
    result = text[match.end():].strip()
    if not result or len(result) > 2000:
        raise ValueError("Question is empty or too long")
    return result


def spoken_answer(answer, room):
    if not isinstance(answer, dict) or answer.get('stale') is not False or answer.get('meeting_ids', []):
        raise ValueError("Stale or cross-meeting answer")
    claims, sources = answer.get('claims'), answer.get('sources')
    if not isinstance(claims, list) or len(claims) > 12 or not isinstance(sources, list) or len(sources) > 40:
        raise ValueError("Malformed answer")
    ids = set()
    for source in sources:
        # Older single-meeting Knowledge endpoints omit this additive source field.
        # Bind absent IDs to the fixed authenticated endpoint, never accept another ID.
        if not isinstance(source, dict) or source.get('meeting_id', room.meeting_id) != room.meeting_id:
            raise ValueError("Unapproved source meeting")
        if (source.get('kind') == 'document' and source.get('path') in room.documents
                or source.get('kind') == 'transcript' and room.include_transcript):
            identifier = source.get('id')
            if not isinstance(identifier, str) or not identifier or len(identifier) > 128 or identifier in ids:
                raise ValueError("Malformed source ID")
            ids.add(identifier)
        else:
            raise ValueError("Unapproved source")
    texts = []
    for claim in claims:
        if (not isinstance(claim, dict) or not isinstance(claim.get('text'), str)
                or not claim['text'].strip() or len(claim['text']) > 1600
                or not isinstance(claim.get('source_ids'), list) or not claim['source_ids']
                or any(not isinstance(i, str) or i not in ids for i in claim['source_ids'])):
            raise ValueError("Malformed or ungrounded claim")
        texts.append(claim['text'].strip())
    text = ' '.join(texts) if texts else 'Mình chưa có đủ thông tin trong các nguồn được phép để trả lời.'
    if len(text) > 4000:
        raise ValueError("Answer exceeds the speech limit")
    return text, sorted(ids)


def valid_wav(raw):
    if not 44 < len(raw) <= MAX_WAV:
        raise ValueError("Question WAV is too large or empty")
    with wave.open(io.BytesIO(raw), 'rb') as w:
        if (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError("Expected mono PCM16 WAV at 16 kHz")
        frames = w.getnframes()
        if not 1600 <= frames <= 24 * 16000 or len(w.readframes(frames)) != frames * 2:
            raise ValueError("Invalid audio duration or truncated WAV")


@dataclass
class Turn:
    request_id: str
    user_id: int
    state: str = 'CAPTURING'
    reason: str | None = None
    source_ids: list = field(default_factory=list)
    created: float = field(default_factory=time.monotonic)
    digest: str | None = None
    maybe_playing: bool = False
    cancelled: bool = False
    task: asyncio.Task | None = field(default=None, repr=False)

    def public(self):
        return {'request_id': self.request_id, 'state': self.state, 'reason': self.reason,
                'source_ids': self.source_ids}


class Coordinator:
    def __init__(self, room, operator_key, stt_key, http):
        if not operator_key:
            raise ValueError("Set a private TINA_SPEECH_OPERATOR_KEY")
        self.room, self.operator_key, self.stt_key, self.http = room, operator_key, stt_key, http
        self.turns = {}
        self.active = None
        self.lock = asyncio.Lock()
        self.epoch = str(uuid4())
        self.revision = 0

    async def gateway(self, method, path, *, key=None, **kwargs):
        response = await self.http.request(method, self.room.gateway_url.rstrip('/') + path,
            headers={'X-API-Key': key or self.operator_key}, **kwargs)
        response.raise_for_status()
        if len(response.content) > 1000000:
            raise ValueError("Gateway response too large")
        return response.json()

    async def identity(self, key):
        if not key:
            raise HTTPException(401, 'Missing participant API key')
        try:
            body = await self.gateway('GET', '/auth/me', key=key)
            uid = int(body['user_id'])
        except httpx.HTTPStatusError as exc:
            raise HTTPException(401 if exc.response.status_code in (401, 403) else 503, 'Identity unavailable') from exc
        except Exception as exc:
            raise HTTPException(503, 'Identity unavailable') from exc
        if uid not in self.room.participants:
            raise HTTPException(403, 'Participant is not enrolled in this room')
        return uid

    async def preflight(self):
        who = await self.gateway('GET', '/auth/me')
        if int(who['user_id']) != self.room.operator_user_id:
            raise ValueError("Operator identity does not match the room configuration")
        row = await self.gateway('GET', f'/meetings/{self.room.meeting_id}')
        if (row.get('status') != 'active' or row.get('user_id') != self.room.operator_user_id or row.get('platform') != self.room.platform
                or (row.get('native_meeting_id') or row.get('platform_specific_id')) != self.room.native_meeting_id
                or not (row.get('data') or {}).get('voice_agent_enabled')):
            raise ValueError("The configured voice bot is not active in the approved room")
        knowledge = await self.gateway('GET', f'/agent/workspace/meeting-knowledge/{self.room.meeting_id}')
        linked = {d['path'] for d in knowledge.get('documents', [])}
        if any(path not in linked for path in self.room.documents):
            raise ValueError("Approved Wiki document is not linked to the configured meeting")

    def expire(self):
        now = time.monotonic()
        for key, turn in list(self.turns.items()):
            if turn.state == 'CAPTURING' and now - turn.created > 35:
                self.finish(turn, 'FAILED', 'capture_expired')
            if turn.state in TERMINAL and now - turn.created > 600:
                del self.turns[key]

    async def room_status(self):
        async with self.lock:
            self.expire()
            return {'epoch': self.epoch, 'revision': self.revision, 'busy': self.active is not None}

    async def reserve(self, identifier, user_id, revision=None):
        async with self.lock:
            self.expire()
            if identifier in self.turns:
                return self.owned(identifier, user_id)
            if self.active or revision is not None and revision != self.revision:
                raise HTTPException(409, 'Room is busy or awaiting operator recovery')
            if len(self.turns) >= 256:
                raise HTTPException(429, 'Turn receipt capacity reached; wait for expiry')
            turn = Turn(identifier, user_id)
            self.turns[identifier] = turn
            self.active = identifier
            self.revision += 1
            return turn

    def owned(self, identifier, user_id):
        turn = self.turns.get(identifier)
        if not turn or turn.user_id != user_id:
            raise HTTPException(404, 'Unknown or expired turn')
        return turn

    def finish(self, turn, state, reason=None):
        turn.state, turn.reason = state, reason
        if state in TERMINAL and self.active == turn.request_id:
            self.active = None

    async def upload(self, turn, raw):
        try: valid_wav(raw)
        except Exception as exc: raise HTTPException(422, 'Invalid bounded question WAV') from exc
        digest = hashlib.sha256(raw).hexdigest()
        if turn.digest:
            if turn.digest != digest: raise HTTPException(409, 'Request ID already used with different audio')
            return
        if turn.state != 'CAPTURING' or time.monotonic() - turn.created > 35:
            raise HTTPException(409, 'Capture grant expired or cancelled')
        turn.digest, turn.state = digest, 'WAITING'
        turn.task = asyncio.create_task(self.run(turn, raw))

    async def cancel(self, turn):
        if turn.state in TERMINAL:
            return
        turn.cancelled = True
        if turn.task and turn.task is not asyncio.current_task(): turn.task.cancel()
        if turn.maybe_playing:
            try:
                await self.gateway('DELETE', self.room.speak_path, params={'command_id': turn.request_id})
                # Only an actual terminal bot receipt unlocks a possibly playing turn.
                await self.wait_playback(turn, cancelling=True)
            except Exception:
                self.finish(turn, 'ERROR', 'playback_unknown')
        else:
            self.finish(turn, 'STOPPED', 'operator')

    async def wait_playback(self, turn, cancelling=False):
        deadline = time.monotonic() + (10 if cancelling else 175)
        while time.monotonic() < deadline:
            status = await self.gateway('GET', self.room.speak_path + '/' + turn.request_id)
            if status.get('command_id') != turn.request_id or status.get('meeting_id') != self.room.meeting_id:
                raise ValueError("Mismatched playback receipt")
            state = status.get('state')
            if state in ('completed', 'failed', 'stopped'):
                self.finish(turn, 'STOPPED' if turn.cancelled else state.upper(), 'operator' if turn.cancelled else None)
                return
            if state not in ('queued', 'started'):
                raise ValueError("Unknown playback state")
            await asyncio.sleep(.2)
        raise TimeoutError("Playback outcome unavailable")

    async def run(self, turn, raw):
        try:
            headers = {'Authorization': 'Bearer ' + self.stt_key} if self.stt_key else {}
            response = await self.http.post(self.room.stt_url.rstrip('/') + '/v1/audio/transcriptions',
                headers=headers, files={'file': ('question.wav', raw, 'audio/wav')},
                data={'model': self.room.stt_model}, timeout=45)
            response.raise_for_status()
            question = question_text(response.json().get('text'))
            if turn.cancelled: return
            answer = await self.gateway('POST', f'/agent/workspace/meeting-knowledge/{self.room.meeting_id}/ask',
                json={'question': question, 'documents': self.room.documents}, timeout=90)
            identifier = answer.get('id')
            if not isinstance(identifier, str) or not re.fullmatch('[0-9a-f]{32}', identifier):
                raise ValueError("Malformed answer identity")
            answer = await self.gateway('GET', f'/agent/workspace/meeting-knowledge/{self.room.meeting_id}/answers/{identifier}')
            text, source_ids = spoken_answer(answer, self.room)
            if turn.cancelled: return
            turn.source_ids, turn.state = source_ids, 'SPEAKING'
            turn.maybe_playing = True
            await self.gateway('POST', self.room.speak_path,
                json={'text': text, 'voice': 'auto', 'command_id': turn.request_id})
            await self.wait_playback(turn)
        except asyncio.CancelledError:
            return
        except Exception:
            # No raw upstream text, exceptions, tools or JSON become a spoken fallback.
            self.finish(turn, 'ERROR' if turn.maybe_playing else 'FAILED',
                        'playback_unknown' if turn.maybe_playing else 'upstream_or_source_error')


def create_app(room, operator_key, stt_key='', http=None):
    from contextlib import asynccontextmanager
    client = http or httpx.AsyncClient(timeout=8, follow_redirects=False, trust_env=False)
    coordinator = Coordinator(room, operator_key, stt_key, client)

    @asynccontextmanager
    async def lifespan(app):
        try:
            await coordinator.preflight()
            yield
        finally:
            if coordinator.active:
                await coordinator.cancel(coordinator.turns[coordinator.active])
            if http is None: await client.aclose()

    app = FastAPI(lifespan=lifespan)
    app.state.coordinator = coordinator

    @app.get('/health')
    async def health():
        return {'status': 'ok', 'busy': coordinator.active is not None}

    async def participant(request):
        return await coordinator.identity(request.headers.get('x-api-key'))

    @app.get('/room')
    async def room_status(request: Request):
        await participant(request)
        return JSONResponse(await coordinator.room_status(), headers={'Cache-Control': 'no-store'})

    def check_epoch(request):
        if request.headers.get('x-tina-speech-epoch') != coordinator.epoch:
            raise HTTPException(409, 'Coordinator epoch changed; restart the participant explicitly')

    @app.post('/turns/{request_id}', status_code=201)
    async def reserve(request_id: UUID, request: Request):
        check_epoch(request)
        if request.headers.get('transfer-encoding') or request.headers.get('content-length') not in (None, '0'):
            raise HTTPException(422, 'Room and sources are operator-configured; no request body is accepted')
        revision = request.headers.get('x-tina-speech-revision', '')
        if not re.fullmatch(r'[0-9]{1,15}', revision):
            raise HTTPException(422, 'A fresh room revision is required')
        turn = await coordinator.reserve(str(request_id), await participant(request), int(revision))
        return turn.public()

    @app.put('/turns/{request_id}/audio', status_code=202)
    async def upload(request_id: UUID, request: Request):
        check_epoch(request)
        turn = coordinator.owned(str(request_id), await participant(request))
        if request.headers.get('content-type', '').split(';')[0] != 'audio/wav':
            raise HTTPException(415, 'Expected audio/wav')
        raw = bytearray()
        async for block in request.stream():
            raw.extend(block)
            if len(raw) > MAX_WAV: raise HTTPException(413, 'Question WAV exceeds limit')
        await coordinator.upload(turn, bytes(raw))
        return turn.public()

    @app.get('/turns/{request_id}')
    async def state(request_id: UUID, request: Request):
        check_epoch(request)
        return coordinator.owned(str(request_id), await participant(request)).public()

    @app.delete('/turns/{request_id}')
    async def cancel(request_id: UUID, request: Request):
        check_epoch(request)
        turn = coordinator.owned(str(request_id), await participant(request))
        await coordinator.cancel(turn)
        return turn.public()

    return app


def from_config(path):
    room = Room(**json.loads(Path(path).read_text(encoding='utf-8')))
    return create_app(room, os.environ.get('TINA_SPEECH_OPERATOR_KEY', ''), os.environ.get('TINA_SPEECH_STT_KEY', ''))
