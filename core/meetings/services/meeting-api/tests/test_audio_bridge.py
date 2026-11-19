import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from meeting_api.lifecycle.audio import issue_audio_capability, build_audio_router
from meeting_api.bot_spawn import request_bot, TranscriptionNotConfigured
from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo, FakeRuntimeClient


async def test_spawn_pins_backend_in_capability_and_routes_both_consumers(monkeypatch):
    monkeypatch.setenv('INTERNAL_API_SECRET','synthetic-internal-key')
    monkeypatch.setenv('TINA_LIVEKIT_AUDIO','1');monkeypatch.setenv('LIVEKIT_AGENT_URL','http://agents:8090')
    monkeypatch.setenv('TINA_LIVEKIT_VAD_SHADOW','1')
    monkeypatch.setenv('TRANSCRIPTION_MODEL','viegem')
    repo,runtime=InMemoryMeetingRepo(),FakeRuntimeClient()
    await request_bot(repo,runtime,user_id=7,platform='google_meet',native_meeting_id='audio',
        transcribe_enabled=True,voice_agent_enabled=False,token_secret='synthetic-meeting-key')
    env=runtime.specs[0]['env'];inv=json.loads(env['BOT_CONFIG'])
    assert env['TINA_LIVEKIT_VAD_SHADOW']=='1'
    assert inv['transcriptionServiceUrl']==env['TINA_AUDIO_BRIDGE_URL']
    assert inv['transcriptionServiceToken']==env['TINA_AUDIO_BRIDGE_TOKEN']
    assert inv['transcriptionModel']=='viegem'
    repo._meetings[1]['status']='active'
    app=FastAPI();app.include_router(build_audio_router(repo))
    url=f"/bots/audio/1/{inv['connectionId']}/permit"
    headers={'Authorization':'Bearer '+env['TINA_AUDIO_BRIDGE_TOKEN']}
    with TestClient(app) as client:
        assert client.get(url,headers=headers).json()=={'current':True,'noise_suppression':True,'voice_enabled':False}
        assert client.get(url,headers={'Authorization':headers['Authorization']+'x'}).status_code==403
        repo._meetings[1]['data']['voice_assistant']={'noise_suppression':False}
        assert client.get(url,headers=headers).json()=={'current':True,'noise_suppression':False,'voice_enabled':False}
        repo._meetings[1]['data'].update(voice_assistant_capable=True,voice_assistant={'enabled':True})
        assert client.get(url,headers=headers).json()['voice_enabled'] is True
        repo._meetings[1]['status']='joining'
        assert client.get(url,headers=headers).status_code==503
        repo._meetings[1]['status']='active'
        repo._meetings[1]['data']['stop_requested']=True
        assert client.get(url,headers=headers).status_code==409
        repo._meetings[1]['data'].pop('stop_requested')
        repo.sessions.append({'meeting_id':1,'session_uid':'new-session'})
        assert client.get(url,headers=headers).status_code==409


async def test_bridge_config_failure_never_inserts_or_spawns(monkeypatch):
    monkeypatch.setenv('TINA_LIVEKIT_AUDIO','1');monkeypatch.delenv('LIVEKIT_AGENT_URL',raising=False)
    repo,runtime=InMemoryMeetingRepo(),FakeRuntimeClient()
    with pytest.raises(TranscriptionNotConfigured):
        await request_bot(repo,runtime,user_id=7,platform='google_meet',native_meeting_id='audio',token_secret='test')
    assert not repo._meetings and not runtime.specs
