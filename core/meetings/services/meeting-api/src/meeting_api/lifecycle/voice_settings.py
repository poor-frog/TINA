"""Account-authenticated service checks and fixed local-browser TTS preview; no room playback."""
import io
import json
import os
import time
import wave

import httpx
from fastapi import APIRouter, Header, HTTPException, Response

from .stop_router import _resolve_user_id
from .voice import new_meeting_voice_policy

PREVIEW_TEXT = 'Xin chào, tôi là TINA. Tôi sẵn sàng hỗ trợ cuộc họp của bạn.'


def build_voice_settings_router(redis, client_factory=httpx.AsyncClient, repo=None, store=None):
    router = APIRouter()

    def connection():
        return os.environ.get('TTS_SERVICE_URL', '').rstrip('/'), os.environ.get('TTS_API_TOKEN', '')

    @router.get('/bots/voice/services')
    async def services(x_user_id: str | None = Header(default=None)):
        user = _resolve_user_id(x_user_id)
        url, token = connection()
        tts = {'configured':bool(url and token), 'ready':False, 'model':None, 'voice':None, 'device':None, 'busy':False}
        if tts['configured']:
            try:
                async with client_factory(timeout=3, follow_redirects=False) as client:
                    async with client.stream('GET', url + '/ready', headers={'X-API-Key':token}) as response:
                        raw = bytearray()
                        async for chunk in response.aiter_bytes():
                            raw.extend(chunk)
                            if len(raw) > 8192: raise ValueError('Oversized readiness response')
                        info = json.loads(raw) if response.status_code == 200 else {}
                        if not isinstance(info,dict): raise ValueError('Invalid readiness response')
                        tts.update(ready=info.get('status') == 'ok', busy=info.get('busy') is True)
                        for key in ['model', 'voice', 'device']:
                            value = info.get(key)
                            if isinstance(value,str) and 0 < len(value) <= 100: tts[key] = value
                        tts['profiles_supported']=info.get('profiles_supported') is True
                        voices=info.get('voices') or []
                        tts['voices']=[{k:item[k] for k in ('id','label','region') if isinstance(item.get(k),str) and len(item[k])<=64}
                            for item in voices[:32] if isinstance(item,dict) and isinstance(item.get('id'),str) and isinstance(item.get('label'),str)] if isinstance(voices,list) else []
            except (httpx.HTTPError, ValueError, TypeError):
                pass
        noise_filter=None
        audio_url=os.environ.get('LIVEKIT_AGENT_URL','').rstrip('/')
        if audio_url:
            try:
                async with client_factory(timeout=3,follow_redirects=False) as client:
                    async with client.stream('GET',audio_url+'/ready') as response:
                        raw=bytearray()
                        async for chunk in response.aiter_bytes():
                            raw.extend(chunk)
                            if len(raw)>4096:raise ValueError('Oversized audio readiness')
                        info=json.loads(raw) if response.status_code==200 else {}
                        selected=info.get('noise_filter') or {}
                        if selected.get('id') in ('dtln','webrtc'):
                            choice=selected['id']
                            noise_filter={'id':choice,'label':'DTLN' if choice=='dtln' else 'WebRTC NS Low',
                                          'device':'cpu','ready':info.get('audio_bridge_ready') is True}
            except (httpx.HTTPError,ValueError,TypeError,AttributeError):pass
        wake = {'method':'livekit_wakeword', 'engine':'LiveKit WakeWord', 'version':'2.1.1', 'device':'cpu',
                'names':['TINA ơi','hey TINA'], 'platforms':['google_meet'], 'status':'no_active_bot', 'sessions':[]}
        if repo is not None and store is not None:
            from .voice import KwsStatus
            from pydantic import ValidationError
            rows = await store.list_meetings(user, status=['active'], platform='google_meet', limit=20, slim=True)
            # list_meetings also returns shared rooms; only the owner's bots may report private runtime status.
            rows = [r for r in rows if str(r.get('user_id')) == str(user) and r.get('status') == 'active'][:20]
            raw = await redis.mget([f'meeting:voice:{r["id"]}:state' for r in rows]) if rows else []
            for row, value in zip(rows, raw):
                sessions = await repo.list_sessions(meeting_id=row['id'])
                status = 'unknown'
                try:
                    runtime = json.loads(value) if value else {}
                    if not isinstance(runtime, dict): raise ValueError('Invalid runtime snapshot')
                    if sessions and runtime.get('session_uid') == sessions[-1]:
                        kws = KwsStatus.model_validate(runtime.get('kws'))
                        if 0 <= int(time.time()*1000) - kws.observed_at_ms < 15000: status = kws.status
                except (ValueError, TypeError, ValidationError):
                    pass
                wake['sessions'].append({'meeting_id':row['id'], 'status':status})
            statuses = {r['status'] for r in wake['sessions']}
            if statuses: wake['status'] = next((s for s in ['failed','unknown','starting','off','ready'] if s in statuses))
        return {'wake':wake,
                'new_meeting_policy':new_meeting_voice_policy(),
                'voice_pipeline_configured':os.environ.get('TINA_MEETING_VOICE', '').lower() in ('1','true','yes','on'),
                'default_prepare_new_bots':bool(url), 'tts':tts,'noise_filter':noise_filter}

    @router.post('/bots/voice/preview')
    async def preview(body:dict | None = None,x_user_id: str | None = Header(default=None)):
        user = _resolve_user_id(x_user_id)
        url, token = connection()
        if not url or not token: raise HTTPException(503, 'TTS chưa được cấu hình trên máy chủ.')
        supplied=body or {};voice=supplied.get('voice','auto');glossary=supplied.get('pronunciations',{})
        try:
            from .speech_profile import sign_profile
            if not isinstance(voice,str) or not isinstance(glossary,dict):raise ValueError()
            profile=sign_profile(voice,glossary) if glossary else None
        except ValueError:raise HTTPException(422,'Use a preset voice and bounded pronunciation words') from None
        sample=PREVIEW_TEXT+(' Ví dụ cách đọc: '+', '.join(list(glossary)[:3])+'.' if glossary else '')
        if not await redis.set(f'voice:preview:{user}', '1', nx=True, ex=10):
            raise HTTPException(429, 'Vui lòng đợi vài giây trước khi nghe thử lại.')
        try:
            async with client_factory(timeout=35, follow_redirects=False) as client:
                async with client.stream('POST', url + '/v1/audio/speech', headers={'X-API-Key':token},
                    json={'model':'tts-1','voice':voice,'response_format':'pcm','input':sample,
                          **({'profile':profile} if profile else {})}) as response:
                    if response.status_code != 200: raise ValueError('TTS unavailable')
                    if response.headers.get('X-Audio-Sample-Rate') != '24000' or response.headers.get('X-Audio-Channels') != '1':
                        raise ValueError('Unexpected PCM format')
                    pcm = bytearray()
                    async for chunk in response.aiter_bytes():
                        pcm.extend(chunk)
                        if len(pcm) > 24000 * 2 * 15: raise ValueError('Oversized preview')
            if not pcm or len(pcm) % 2: raise ValueError('Invalid PCM')
            output = io.BytesIO()
            with wave.open(output, 'wb') as wav:
                wav.setparams((1,2,24000,0,'NONE','not compressed')); wav.writeframes(pcm)
            return Response(output.getvalue(), media_type='audio/wav', headers={'Cache-Control':'no-store'})
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(503, 'Chưa tạo được audio nghe thử. Hãy kiểm tra dịch vụ TTS.') from exc

    return router
