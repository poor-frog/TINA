"""Signed speech settings from Meeting API; ordinary TTS clients cannot inject a glossary."""
import base64
import hmac
import json
import os

from speech_text import Pronunciations


def resolve_profile(token,meeting_id):
    if not isinstance(token,str) or len(token)>6000:raise ValueError('Invalid speech profile')
    key=os.environ.get('TINA_TTS_PROFILE_KEY','')
    if len(key)<32:raise ValueError('Speech profiles unavailable')
    payload,signature=token.rsplit('.',1)
    expected=hmac.new(key.encode(),b'tina-speech.v1:'+payload.encode(),'sha256').hexdigest()
    if not hmac.compare_digest(signature,expected):raise ValueError('Invalid speech profile')
    value=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
    if not isinstance(value,dict) or value.get('meeting_id')!=meeting_id:raise ValueError('Speech profile scope changed')
    glossary=value.get('pronunciations',{})
    if not isinstance(glossary,dict) or len(glossary)>32 or len(json.dumps(glossary,ensure_ascii=False).encode())>2048:
        raise ValueError('Pronunciation profile exceeds bounds')
    Pronunciations({'default':glossary,'projects':{},'meeting_projects':{}})
    return value.get('voice','auto'),glossary
