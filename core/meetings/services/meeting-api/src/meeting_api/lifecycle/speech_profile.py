"""Private, session-pinned owner speech settings. No speech rules enter meeting projections."""
import base64
import hmac
import json
import os

import httpx
from fastapi import HTTPException


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


async def room_profile(row,session: str,redis,client_factory):
    key=f'meeting:voice:{row["id"]}:{session}:speech-profile'
    cached=await redis.get(key)
    if cached is not None:
        await redis.expire(key,86400)
        if isinstance(cached,bytes):cached=cached.decode()
        return cached or None
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
        return saved or None
    except (httpx.HTTPError,ValueError,TypeError,KeyError,AttributeError):raise HTTPException(503,'Speech preferences unavailable') from None
