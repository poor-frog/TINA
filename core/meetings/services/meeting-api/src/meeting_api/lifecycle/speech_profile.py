"""Private, session-pinned owner speech settings. No speech rules enter meeting projections."""
import base64
import hashlib
import hmac
import json
import logging
import os

import httpx
from fastapi import HTTPException

log = logging.getLogger(__name__)
_AUTO_SENTINEL = 'auto'


def sign_profile(voice='auto',pronunciations=None,meeting_id=None,session=None):
    glossary=pronunciations or {}
    if voice=='auto' and not glossary:return None
    if (not isinstance(voice,str) or not 1<=len(voice)<=64 or not isinstance(glossary,dict)
            or len(glossary)>32 or len(json.dumps(glossary,ensure_ascii=False).encode())>2048):
        raise ValueError('Invalid speech preferences')
    for term,spoken in glossary.items():
        if (not isinstance(term,str) or not isinstance(spoken,str) or not 1<=len(term)<=80 or not 1<=len(spoken)<=120
                or term!=term.strip() or spoken!=spoken.strip() or not all(c.isalpha() or c in " -'.," for c in term+spoken)):
            raise ValueError('Invalid pronunciation entry')
    key=os.environ.get('TINA_TTS_PROFILE_KEY','')
    if len(key)<32:raise ValueError('Speech profiles unavailable')
    payload=base64.urlsafe_b64encode(json.dumps({'voice':voice,'pronunciations':glossary,
        'meeting_id':meeting_id,'session':session},ensure_ascii=False,separators=(',',':'),sort_keys=True).encode()).decode().rstrip('=')
    return payload+'.'+hmac.new(key.encode(),b'tina-speech.v1:'+payload.encode(),'sha256').hexdigest()


def verify_profile(token: str, meeting_id=None):
    if not isinstance(token, str) or not token or len(token) > 6000 or '.' not in token:
        return None
    key = os.environ.get('TINA_TTS_PROFILE_KEY', '')
    if len(key) < 32:
        return None
    try:
        payload, signature = token.rsplit('.', 1)
        expected = hmac.new(key.encode(), b'tina-speech.v1:' + payload.encode(), 'sha256').hexdigest()
        if not hmac.compare_digest(signature, expected):
            return None
        value = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        if not isinstance(value, dict):
            return None
        if meeting_id is not None and value.get('meeting_id') != meeting_id:
            return None
        voice = value.get('voice', 'auto')
        glossary = value.get('pronunciations', {})
        if not isinstance(voice, str) or not 1 <= len(voice) <= 64 or not isinstance(glossary, dict):
            return None
        return voice, glossary
    except (ValueError, TypeError, KeyError, AttributeError):
        return None


def voice_reply_storage_prefix(user_id, meeting_id) -> str:
    return f'voice-replies/{user_id}/{meeting_id}/'


def profile_storage_key(user_id, meeting_id, session: str) -> str:
    session_hash = hashlib.sha256(str(session).encode('utf-8')).hexdigest()[:32]
    return f'{voice_reply_storage_prefix(user_id, meeting_id)}profiles/{session_hash}.profile'


async def _read_stored_profile(storage, user_id, meeting_id, session: str):
    if storage is None or not session:
        return False, None
    key = profile_storage_key(user_id, meeting_id, session)
    try:
        if not await storage.exists(key):
            return False, None
        raw = (await storage.get(key)).decode('utf-8', errors='ignore').strip()
    except Exception:
        log.warning('Could not read persisted speech profile for meeting %s', meeting_id)
        return False, None
    if raw == _AUTO_SENTINEL:
        return True, None
    if verify_profile(raw, meeting_id) is not None:
        return True, raw
    return False, None


async def _write_stored_profile(storage, user_id, meeting_id, session: str, profile: str | None) -> None:
    if storage is None or not session:
        return
    key = profile_storage_key(user_id, meeting_id, session)
    try:
        payload = (profile if profile else _AUTO_SENTINEL).encode('utf-8')
        await storage.upload(key, payload, content_type='text/plain; charset=utf-8')
    except Exception:
        log.warning('Could not persist speech profile for meeting %s', meeting_id)


async def room_profile(row,session: str,redis,client_factory,storage=None):
    key=f'meeting:voice:{row["id"]}:{session}:speech-profile'
    cached=await redis.get(key)
    if cached is not None:
        await redis.expire(key,86400)
        if isinstance(cached,bytes):cached=cached.decode()
        return cached or None
    found, persisted = await _read_stored_profile(storage, row['user_id'], row['id'], session)
    if found:
        await redis.set(key, persisted or '', nx=True, ex=86400)
        saved = await redis.get(key)
        if isinstance(saved, bytes): saved = saved.decode()
        return saved or None
    base=os.environ.get('ADMIN_API_URL','').rstrip('/')
    if not base:return None
    try:
        async with client_factory(timeout=5,follow_redirects=False) as client:
            response=await client.get(f'{base}/internal/users/{row["user_id"]}/bot-context',
                headers={'X-Internal-Secret':os.environ.get('INTERNAL_API_SECRET','')})
            if response.status_code!=200 or len(response.content)>100000:raise ValueError()
            prefs=response.json().get('voice') or {}
        profile=sign_profile(prefs.get('speech_voice','auto'),prefs.get('pronunciations'),row['id'],session)
        await redis.set(key,profile or '',nx=True,ex=86400)
        saved=await redis.get(key)
        if isinstance(saved,bytes):saved=saved.decode()
        result = saved or None
        await _write_stored_profile(storage, row['user_id'], row['id'], session, result)
        return result
    except (httpx.HTTPError,ValueError,TypeError,KeyError,AttributeError):raise HTTPException(503,'Speech preferences unavailable') from None


async def resolve_reply_speech_profile(row, session: str | None, redis, client_factory, storage=None) -> tuple[str, str | None]:
    """Resolve (voice, signed_profile) for replaying a saved Voice Agent reply.

    Prefers the exact meeting/session profile pinned during the meeting (Redis -> durable object
    storage), then falls back to the owner's current Voice Settings from admin-api, and finally
    to VieNeu's default ('auto'). Never mutates meeting data.
    """
    mid = row['id']
    if session:
        redis_key = f'meeting:voice:{mid}:{session}:speech-profile'
        try:
            cached = await redis.get(redis_key)
        except Exception:
            cached = None
        if cached is not None:
            if isinstance(cached, bytes):
                cached = cached.decode('utf-8', errors='ignore')
            if cached == '':
                return 'auto', None
            if verify_profile(cached, mid) is not None:
                return 'auto', cached
        found, persisted = await _read_stored_profile(storage, row['user_id'], mid, session)
        if found:
            return ('auto', persisted) if persisted else ('auto', None)

    base = os.environ.get('ADMIN_API_URL', '').rstrip('/')
    if not base:
        return 'auto', None
    try:
        async with client_factory(timeout=5, follow_redirects=False) as client:
            response = await client.get(
                f'{base}/internal/users/{row["user_id"]}/bot-context',
                headers={'X-Internal-Secret': os.environ.get('INTERNAL_API_SECRET', '')},
            )
            if response.status_code != 200 or len(response.content) > 100000:
                return 'auto', None
            prefs = response.json().get('voice') or {}
    except (httpx.HTTPError, ValueError, TypeError, KeyError, AttributeError):
        log.warning('Owner voice preferences unavailable for replay; falling back to default voice')
        return 'auto', None

    voice = prefs.get('speech_voice') or 'auto'
    glossary = prefs.get('pronunciations') or {}
    if not isinstance(voice, str) or not 1 <= len(voice) <= 64:
        voice = 'auto'
    if not isinstance(glossary, dict):
        glossary = {}
    try:
        profile = sign_profile(voice, glossary, mid, session or 'replay')
        return ('auto', profile) if profile else ('auto', None)
    except ValueError:
        return (voice, None) if voice != 'auto' else ('auto', None)
