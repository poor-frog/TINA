"""Session-bound audio capabilities; no transcript writes or source-policy grants."""
import base64
import hmac
import json
import os

from fastapi import APIRouter, Header, HTTPException


def audio_key():
    explicit=os.environ.get('LIVEKIT_API_SECRET','')
    if explicit: return explicit.encode()
    secret=os.environ.get('INTERNAL_API_SECRET','')
    if not secret: raise ValueError('Internal service secret is required for audio bridge')
    return hmac.new(secret.encode(),b'tina-livekit-server:v1','sha256').hexdigest().encode()


def issue_audio_capability(mid, session, url, token, model):
    payload=base64.urlsafe_b64encode(json.dumps({'meeting':mid,'session':session,'url':url,
        'token':token or '', 'model':model or ''},separators=(',',':')).encode()).decode().rstrip('=')
    if len(payload)>7000: raise ValueError('ASR configuration exceeds audio capability bound')
    return payload+'.'+hmac.new(audio_key(),b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()


def build_audio_router(repo):
    router=APIRouter()
    @router.get('/bots/audio/{mid}/{session}/permit',include_in_schema=False)
    async def permit(mid:int,session:str,authorization:str=Header(default='')):
        try:
            if not authorization.startswith('Bearer ') or len(authorization)>7200: raise ValueError()
            payload,signature=authorization[7:].rsplit('.',1)
            expected=hmac.new(audio_key(),b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()
            if not hmac.compare_digest(signature,expected): raise ValueError()
            body=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
            if body['meeting']!=mid or body['session']!=session: raise ValueError()
        except (ValueError,KeyError,TypeError):
            raise HTTPException(403,'Audio capability rejected') from None
        row=await repo.get_meeting(mid)
        sessions=await repo.list_sessions(meeting_id=mid) if row else []
        if (not row or not sessions or sessions[-1]!=session
                or (row.get('data') or {}).get('stop_requested')
                or (row.get('data') or {}).get('transcribe_enabled') is not True):
            raise HTTPException(409,'Audio session is no longer active')
        if row.get('status') in ('requested','joining','awaiting_admission'):
            raise HTTPException(503,'Audio session is not ready')
        if row.get('status')!='active':raise HTTPException(409,'Audio session is no longer active')
        data=row.get('data') or {};policy=data.get('voice_assistant') or {}
        return {'current':True,'noise_suppression':policy.get('noise_suppression',True),
                'voice_enabled':data.get('voice_assistant_capable') is True and policy.get('enabled') is True}
    return router
