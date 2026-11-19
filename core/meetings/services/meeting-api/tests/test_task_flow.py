import asyncio
import json
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fakeredis.aioredis import FakeRedis

from meeting_api.lifecycle.voice import build_voice_router, voice_token
from meeting_api.lifecycle.speech_status import PlaybackStore
from test_meeting_voice import Repo

BOT='/bots/voice/1/current'
AUTH={'Authorization':'Bearer '+voice_token('test-admin-secret',1,'current'),'X-Voice-Speaker-Key':'a'*64}


@pytest.fixture
async def flow_service(monkeypatch):
    monkeypatch.setenv('ADMIN_TOKEN','test-admin-secret');monkeypatch.setenv('INTERNAL_API_SECRET','test-internal-secret')
    monkeypatch.setenv('AGENT_API_URL','http://agent.test')
    repo=Repo();repo.row['data']['voice_assistant']['engine']='livekit'
    redis=FakeRedis(decode_responses=True);playback=PlaybackStore(redis,repo.save_voice_reply)
    state={'node':'assignee','action':'update','block':False};entered=asyncio.Event();release=asyncio.Event();calls=[]
    async def upstream(request):
        body=json.loads(request.content);calls.append((request.url.path,body))
        if request.url.path.endswith('/sources'):
            return httpx.Response(200,json={'sources':[],'unavailable':int(state.get('unavailable',False))})
        if request.url.path.endswith('/agent'):
            return httpx.Response(200,json={'history':[],'available_tools':[],
                'task_flow_requested':body['question'].startswith('Tạo task'),
                'decision_flow_requested':body['question'].startswith('Ghi quyết định')})
        if state.get('unavailable'):
            return httpx.Response(503,json={'detail':'synthetic outage'})
        if body['operation']=='finish':
            if state.get('finish_status'):return httpx.Response(state['finish_status'],json={'detail':'Synthetic finish rejection'})
            return httpx.Response(200,json={'text':'Em đã chuẩn bị bản nháp task: demo.','sources':[],
                'answer_kind':'assistant','reason':'answered','clarification':False})
        if state['block']: entered.set();await release.wait()
        updated=deepcopy(body.get('decision_state',body.get('task_state')));updated['title']='demo';updated['utterances'].append(body['question'])
        if 'decision_state' in body:
            updated.update(requested_status=state.get('requested_status'),evidence_status='unchecked')
        return httpx.Response(200,json={'action':state['action'],'node':state['node'],'state':updated,
            'text':'Bạn muốn ghi ai phụ trách, hay để trống?'})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    app=FastAPI();app.include_router(build_voice_router(repo,redis,redis,playback,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        yield client,repo,redis,playback,state,entered,release,calls
    await redis.aclose()


def question(text='Tạo task demo'):
    return {'request_id':str(uuid4()),'question':text,'revision':1}


async def context(client,body,auth=AUTH):
    return await client.post(BOT+'/agent',headers=auth,json=body|{'operation':'context'})


async def test_only_heard_prompts_continue_the_same_caller_flow(flow_service):
    client,repo,redis,playback,*_=flow_service
    body=question()
    snapshot=await context(client,body)
    assert snapshot.status_code==200 and snapshot.json()['task_flow']=={'node':'title'}
    assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':'flow_apply'})).status_code==409
    body=question();assert (await context(client,body)).status_code==200
    plan=await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':'flow_plan'})
    assert plan.status_code==200,plan.text
    assert (await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})).status_code==409
    # The rejected early finalize releases the old lease; start a clean request.
    body=question();assert (await context(client,body)).status_code==200
    for operation in ('flow_plan','flow_apply'):
        assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':operation})).status_code==200
    response=await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})
    assert response.status_code==200 and response.json()['clarification']
    await playback.report(1,body['request_id'],'current','started')
    await playback.report(1,body['request_id'],'current','completed')
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})
    another=question('Lan');other=AUTH|{'X-Voice-Speaker-Key':'b'*64}
    assert 'task_flow' not in (await context(client,another,other)).json()
    await client.post(BOT+'/state',headers=other,json={'state':'QUIET','request_id':another['request_id']})
    same=question('Lan')
    continued=await context(client,same)
    assert continued.status_code==200 and continued.json()['task_flow']['node']=='assignee'


async def test_unplayed_prompt_expiry_and_policy_revision_cannot_resume_flow(flow_service):
    client,repo,redis,playback,*_=flow_service
    for condition in ('unplayed','expired','policy'):
        body=question();assert (await context(client,body)).status_code==200
        for operation in ('flow_plan','flow_apply'):
            assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':operation})).status_code==200
        assert (await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})).status_code==200
        if condition!='unplayed':
            await playback.report(1,body['request_id'],'current','started')
            await playback.report(1,body['request_id'],'current','completed')
        else:await playback.report(1,body['request_id'],'current','stopped')
        await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})
        if condition=='expired':
            for key in await redis.keys('*:task-flow:*'):await redis.delete(key)
        if condition=='policy':repo.row['data']['voice_assistant']['revision']=2
        following=question('Lan')|{'revision':repo.row['data']['voice_assistant']['revision']}
        snapshot=await context(client,following)
        assert snapshot.status_code==200 and 'task_flow' not in snapshot.json()
        await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':following['request_id']})


async def test_stop_fences_late_flow_plan_and_worker_cannot_supply_task_state(flow_service):
    client,repo,redis,playback,state,entered,release,calls=flow_service
    body=question();assert (await context(client,body)).status_code==200
    injected=body|{'operation':'flow_plan','task_state':{'title':'forged'}}
    assert (await client.post(BOT+'/agent',headers=AUTH,json=injected)).status_code==422
    state['block']=True
    running=asyncio.create_task(client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':'flow_plan'}))
    await asyncio.wait_for(entered.wait(),2)
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})
    release.set();assert (await running).status_code==409
    assert not await redis.keys('*:task-flow:*')


async def test_late_context_reset_cannot_erase_a_replacement_turns_flow(flow_service):
    from fastapi import HTTPException
    from meeting_api.lifecycle.task_flow import TaskFlowStore
    client,repo,redis,playback,*_=flow_service
    store=TaskFlowStore(redis,playback)
    key='meeting:voice:1:current:task-flow:1:'+'a'*64
    await redis.set(key,'replacement-state')
    pending=await store.context(1,'current',1,'a'*64,True)
    assert pending['node']=='title' and await redis.get(key)=='replacement-state'
    await redis.set('lease','current:new')
    await redis.set('old:agent',json.dumps({'fingerprint':'old'}))
    with pytest.raises(HTTPException):
        await store.save_reservation('lease','old','current:old',{'fingerprint':'old'},
            {'fingerprint':'old','task_flow':pending},clear_key=key)
    assert await redis.get(key)=='replacement-state'


async def test_service_failure_preserves_fields_without_consuming_a_reprompt_and_failed_tts_reasks(flow_service):
    client,repo,redis,playback,state,*_=flow_service
    body=question();assert (await context(client,body)).status_code==200
    state['unavailable']=True
    plan=await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':'flow_plan'})
    assert plan.status_code==200 and plan.json()['action']=='service_error'
    assert plan.json()['state'].get('reprompts',0)==0
    assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':'flow_apply'})).status_code==200
    reply=await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})
    assert reply.status_code==200 and reply.json()['reason']=='llm_unavailable' and not reply.json()['clarification']
    await playback.report(1,body['request_id'],'current','failed')
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})
    state['unavailable']=False
    following=question('Lan')
    assert 'task_flow' in (await context(client,following)).json()
    await client.post(BOT+'/agent',headers=AUTH,json=following|{'operation':'flow_plan'})
    calls=flow_service[-1]
    assert next(b for path,b in reversed(calls) if path.endswith('/task-flow'))['recover_prompt'] is True


async def test_pause_is_not_a_completed_task_and_keeps_a_source_free_terminal_history_marker(flow_service):
    client,repo,redis,playback,state,*_=flow_service
    body=question();state['action']='pause'
    assert (await context(client,body)).status_code==200
    for operation in ('flow_plan','flow_apply'):
        assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':operation})).status_code==200
    reply=await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})
    assert reply.status_code==200 and reply.json()['reason']=='clarification_exhausted' and not reply.json()['clarification']
    key='meeting:voice:1:current:history:1:'+'a'*64
    turn=json.loads(await redis.get(key))[-1]
    assert turn['clarification'] is False and turn['sources']==[]
