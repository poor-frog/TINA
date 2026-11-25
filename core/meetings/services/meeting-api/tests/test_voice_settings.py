import io
import json
import time
import wave
import httpx
import pytest
from fastapi import FastAPI
from fakeredis.aioredis import FakeRedis
from meeting_api.lifecycle.voice_settings import build_voice_settings_router, PREVIEW_TEXT


@pytest.fixture
async def settings(monkeypatch):
    monkeypatch.setenv('TTS_SERVICE_URL','http://tts.test')
    monkeypatch.setenv('TTS_API_TOKEN','synthetic-secret')
    monkeypatch.setenv('TINA_MEETING_VOICE','1')
    requests=[];redis=FakeRedis(decode_responses=True)
    def upstream(request):
        requests.append(request)
        if request.method=='GET':return httpx.Response(200,json={'status':'ok','model':'vieneu-v3-turbo','voice':'Trúc Ly','device':'cpu'})
        return httpx.Response(200,content=b'\x01\x00'*2400,headers={'X-Audio-Sample-Rate':'24000','X-Audio-Channels':'1'})
    def factory(**kw):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kw)
    app=FastAPI();app.include_router(build_voice_settings_router(redis,factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        yield client,requests,redis
    await redis.aclose()


async def test_service_metadata_is_authenticated_safe_and_reports_the_actual_voice(settings):
    client,requests,_=settings
    assert (await client.get('/bots/voice/services')).status_code==401
    r=await client.get('/bots/voice/services',headers={'X-User-Id':'7'})
    assert r.json()['tts']['voice']=='Trúc Ly' and r.json()['tts']['ready']
    assert r.json()['wake']['names']==['TINA ơi','hey TINA']
    assert r.json()['wake']['method']=='livekit_wakeword' and r.json()['wake']['status']=='no_active_bot'
    from meeting_api.lifecycle.voice import new_meeting_voice_policy
    assert r.json()['new_meeting_policy']==new_meeting_voice_policy()
    assert 'synthetic-secret' not in r.text and 'tts.test' not in r.text
    assert requests[0].headers['X-API-Key']=='synthetic-secret'


async def test_service_metadata_reports_transcript_only_policy_when_pilot_room_is_set(settings, monkeypatch):
    client, _, _ = settings
    monkeypatch.setenv('TINA_MEETING_VOICE_PILOT_ROOM', 'abc-defg-hij')
    r = await client.get('/bots/voice/services', headers={'X-User-Id': '7'})
    from meeting_api.lifecycle.voice import new_meeting_voice_policy
    assert r.json()['new_meeting_policy'] == new_meeting_voice_policy(transcript_only=True)


async def test_services_reports_selected_filter_without_forwarding_tts_key_to_livekit(monkeypatch):
    monkeypatch.setenv('LIVEKIT_AGENT_URL','http://livekit.test')
    monkeypatch.setenv('TTS_SERVICE_URL','http://tts.test');monkeypatch.setenv('TTS_API_TOKEN','synthetic-secret')
    def upstream(request):
        if request.url.host=='livekit.test':
            assert 'X-API-Key' not in request.headers
            return httpx.Response(200,json={'audio_bridge_ready':True,'noise_filter':{'id':'dtln','label':'DTLN','device':'cpu'}})
        return httpx.Response(200,json={'status':'ok'})
    def factory(**kw):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kw)
    redis=FakeRedis();app=FastAPI();app.include_router(build_voice_settings_router(redis,factory))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
            result=await client.get('/bots/voice/services',headers={'X-User-Id':'7'})
            assert result.json()['noise_filter']=={'id':'dtln','label':'DTLN','device':'cpu','ready':True}
            assert 'synthetic-secret' not in result.text and 'livekit.test' not in result.text
    finally:await redis.aclose()


async def test_preview_uses_fixed_text_returns_wav_and_never_publishes_to_a_meeting(settings):
    import json
    client,requests,redis=settings
    assert (await client.post('/bots/voice/preview')).status_code==401
    r=await client.post('/bots/voice/preview',headers={'X-User-Id':'7'},json={'input':'ignored user text'})
    assert r.status_code==200 and r.headers['cache-control']=='no-store'
    with wave.open(io.BytesIO(r.content)) as wav:assert wav.getframerate()==24000 and wav.getnchannels()==1
    assert json.loads(requests[-1].content)['input']==PREVIEW_TEXT
    assert (await client.post('/bots/voice/preview',headers={'X-User-Id':'7'})).status_code==429
    assert (await client.post('/bots/voice/preview',headers={'X-User-Id':'8'})).status_code==200
    assert all('preview' in key for key in await redis.keys('*'))


async def test_bad_upstream_audio_is_refused_without_returning_credentials_or_raw_errors(monkeypatch):
    monkeypatch.setenv('TTS_SERVICE_URL','http://tts.test');monkeypatch.setenv('TTS_API_TOKEN','synthetic-secret')
    redis=FakeRedis(decode_responses=True)
    def factory(**kw):return httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(200,content=b'x',headers={'X-Audio-Sample-Rate':'24000','X-Audio-Channels':'1'})),**kw)
    app=FastAPI();app.include_router(build_voice_settings_router(redis,factory))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            r=await c.post('/bots/voice/preview',headers={'X-User-Id':'7'})
            assert r.status_code==503 and 'synthetic-secret' not in r.text
    finally:await redis.aclose()


async def test_kws_readiness_is_owner_scoped_and_requires_current_fresh_session(monkeypatch):
    monkeypatch.delenv('TTS_SERVICE_URL', raising=False)
    redis=FakeRedis(decode_responses=True)
    class Repo:
        async def list_meetings(self, user, **kwargs):
            assert user==7 and kwargs=={'status':['active'],'platform':'google_meet','limit':20,'slim':True}
            return [{'id':1,'user_id':7,'status':'active'}, {'id':2,'user_id':8,'status':'active'},
                    {'id':3,'user_id':7,'status':'active'}]
        async def list_sessions(self, meeting_id): return ['current']
    snapshot={'engine':'livekit-wakeword','version':'2.1.1','mode':'activation','device':'cpu','status':'ready',
              'models':['hey_tina','tina_oi'],'observed_at_ms':int(time.time()*1000)}
    await redis.set('meeting:voice:1:state',json.dumps({'session_uid':'current','kws':snapshot}))
    await redis.set('meeting:voice:2:state',json.dumps({'session_uid':'current','kws':snapshot}))
    await redis.set('meeting:voice:3:state',json.dumps({'session_uid':'old','kws':snapshot}))
    repo=Repo()
    app=FastAPI();app.include_router(build_voice_settings_router(redis,repo=repo,store=repo))
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            value=(await c.get('/bots/voice/services',headers={'X-User-Id':'7'})).json()['wake']
            assert value['sessions']==[{'meeting_id':1,'status':'ready'},{'meeting_id':3,'status':'unknown'}]
            snapshot['observed_at_ms']-=16000
            await redis.set('meeting:voice:1:state',json.dumps({'session_uid':'current','kws':snapshot}))
            value=(await c.get('/bots/voice/services',headers={'X-User-Id':'7'})).json()['wake']
            assert value['sessions'][0]['status']=='unknown'
    finally:await redis.aclose()


async def test_real_app_composes_collector_listing_with_lifecycle_sessions(monkeypatch):
    from meeting_api import create_app
    from meeting_api.collector.fakes import InMemoryTranscriptStore
    from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
    monkeypatch.delenv('TTS_SERVICE_URL', raising=False)
    store=InMemoryTranscriptStore();repo=InMemoryMeetingRepo();redis=FakeRedis(decode_responses=True)
    assert not hasattr(repo,'list_meetings'), 'The lifecycle repo is not the collector listing port'
    store.seed_meeting(user_id=7,platform='google_meet',native_meeting_id='test',meeting_id=14)
    repo.sessions.append({'meeting_id':14,'session_uid':'current'})
    snapshot={'engine':'livekit-wakeword','version':'2.1.1','mode':'activation','device':'cpu','status':'ready',
              'models':['hey_tina','tina_oi'],'observed_at_ms':int(time.time()*1000)}
    await redis.set('meeting:voice:14:state',json.dumps({'session_uid':'current','kws':snapshot}))
    app=create_app(transcript_store=store,meeting_repo=repo,command_publisher=redis)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as c:
            r=await c.get('/bots/voice/services',headers={'X-User-Id':'7'})
            assert r.status_code==200 and r.json()['wake']['sessions']==[{'meeting_id':14,'status':'ready'}]
            r=await c.get('/bots/voice/services',headers={'X-User-Id':'8'})
            assert r.status_code==200 and r.json()['wake']['sessions']==[]
    finally:await redis.aclose()
