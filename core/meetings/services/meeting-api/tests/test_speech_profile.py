import base64
import json

from fakeredis.aioredis import FakeRedis
import httpx
import pytest

from meeting_api.lifecycle.speech_profile import room_profile,sign_profile


async def test_owner_voice_and_glossary_are_pinned_privately_per_session(monkeypatch):
    monkeypatch.setenv('ADMIN_API_URL','http://identity.test');monkeypatch.setenv('INTERNAL_API_SECRET','synthetic-internal')
    monkeypatch.setenv('TINA_TTS_PROFILE_KEY','synthetic-profile-key-'+'x'*32)
    prefs={'speech_voice':'Mai Anh','pronunciations':{'TINA':'ti na'}};requests=[]
    def upstream(request):
        requests.append(request);assert request.headers['X-Internal-Secret']=='synthetic-internal'
        assert request.url.path=='/internal/users/7/bot-context'
        return httpx.Response(200,json={'voice':prefs})
    def factory(**kw):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kw)
    redis=FakeRedis();row={'id':14,'user_id':7}
    try:
        first=await room_profile(row,'session-a',redis,factory)
        prefs['speech_voice']='Hải Đăng'
        assert await room_profile(row,'session-a',redis,factory)==first and len(requests)==1
        second=await room_profile(row,'session-b',redis,factory)
        decode=lambda value:json.loads(base64.urlsafe_b64decode(value.split('.')[0]+'='*(-len(value.split('.')[0])%4)))
        assert decode(first)['voice']=='Mai Anh' and decode(second)['voice']=='Hải Đăng'
        assert decode(first)['meeting_id']==14 and decode(first)['session']=='session-a'
        assert row=={'id':14,'user_id':7},'No glossary/profile is written into public meeting data'
    finally:await redis.aclose()


def test_profile_signing_requires_key_and_rejects_oversized_or_markup_rules(monkeypatch):
    monkeypatch.delenv('TINA_TTS_PROFILE_KEY',raising=False)
    assert sign_profile() is None
    with pytest.raises(ValueError):sign_profile('Mai Anh')
    monkeypatch.setenv('TINA_TTS_PROFILE_KEY','synthetic-profile-key-'+'x'*32)
    with pytest.raises(ValueError):sign_profile('auto',{'TINA':'<script>'})
    with pytest.raises(ValueError):sign_profile('auto',{'word '+str(i):'a'*120 for i in range(33)})
