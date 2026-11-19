import json
import time
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fakeredis.aioredis import FakeRedis

from meeting_api.lifecycle.voice import build_voice_router,voice_token
from meeting_api.lifecycle.speech_status import PlaybackStore
from meeting_api.lifecycle.voice_replies import VoiceSource
from meeting_api.lifecycle.voice_navigation import open_source_intent,select_open_source

AUTH={'Authorization':'Bearer '+voice_token('test-admin-secret',1,'current'),'X-Voice-Speaker-Key':'a'*64}
OWNER={'X-User-Id':'7'}
BOT='/bots/voice/1/current'
OWNER_BASE='/meetings/1/voice-assistant'


@pytest.fixture
async def navigation(monkeypatch):
    monkeypatch.setenv('ADMIN_TOKEN','test-admin-secret');monkeypatch.setenv('INTERNAL_API_SECRET','test-internal-secret')
    monkeypatch.setenv('AGENT_API_URL','http://agent.test')
    from test_meeting_voice import Repo
    repo=Repo();repo.row['data']['voice_assistant']['engine']='livekit'
    redis=FakeRedis(decode_responses=True);store=PlaybackStore(redis,repo.save_voice_reply)
    old=str(uuid4());now=int(time.time()*1000)
    ref={'key':'doc:wiki/demo.md:0','fingerprint':'a'*64}
    record={'request_id':old,'text':'Lan phụ trách demo.','state':'completed','session_uid':'current',
        'created_at_ms':now-1000,'updated_at_ms':now-100,'ended_at_ms':now-100,'source_refs':[ref]}
    repo.row['data']['voice_replies']={old:record}
    await redis.set('meeting:voice:1:current:history:1:'+'a'*64,json.dumps([{
        'request_id':old,'question':'Ai phụ trách demo?','answer':record['text'],'created_at_ms':now-1000,'sources':[ref]}]))
    state={'sources':[{'id':'ctx-'+'a'*64,'kind':'document','path':'wiki/demo.md','paragraph':0,'quote':'Lan phụ trách demo.'}],
           'unavailable':0,'source_calls':0,'source_gate':None,'entered':None}
    async def upstream(request):
        body=json.loads(request.content)
        if request.url.path.endswith('/sources'):
            state['source_calls']+=1
            if state['source_gate']:
                state['entered'].set();await state['source_gate'].wait()
            return httpx.Response(200,json={'sources':state['sources'],'unavailable':state['unavailable']})
        if body.get('operation')=='context':return httpx.Response(200,json={'history':[],'available_tools':[]})
        raise AssertionError('Navigation must not dispatch a model answer or arbitrary lookup')
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    app=FastAPI();app.include_router(build_voice_router(repo,redis,redis,store,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        yield client,repo,redis,store,state,old
    await redis.aclose()


async def ask(client,question='Mở tài liệu đó',auth=AUTH):
    body={'request_id':str(uuid4()),'question':question,'revision':1}
    context=await client.post(BOT+'/agent',headers=auth,json=body|{'operation':'context'})
    assert context.status_code==200,context.text
    plan=await client.post(BOT+'/agent',headers=auth,json=body|{'operation':'plan','agent_context':[]})
    assert plan.status_code==200,plan.text
    for call in plan.json()['tool_calls']:
        result=await client.post(BOT+'/agent',headers=auth,json=body|{'operation':'lookup','agent_context':[],'lookup':call})
        assert result.status_code==200,result.text
    result=await client.post(BOT+'/answer',headers=auth,json=body|{'agent_context':[]})
    assert result.status_code==200,result.text
    return body,result.json(),plan.json()['tool_calls']


async def complete(client,store,body):
    await store.report(1,body['request_id'],'current','started')
    await store.report(1,body['request_id'],'current','completed')
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})


async def test_navigation_is_eligible_only_after_completed_readback_and_owner_can_claim_once(navigation):
    client,repo,redis,store,state,_=navigation
    body,result,calls=await ask(client)
    assert calls==[{'name':'open_source','query':'ctx-'+'a'*64}]
    assert result['answer_kind']=='assistant' and not result['sources']
    await client.post(BOT+'/state',headers=AUTH,json={'state':'SPEAKING','request_id':body['request_id']})
    assert (await client.get(OWNER_BASE,headers=OWNER)).json()['runtime']['navigation'] is None
    claim=OWNER_BASE+'/navigation/'+body['request_id']
    assert (await client.post(claim,headers=OWNER)).status_code==409
    await complete(client,store,body)
    hint=(await client.get(OWNER_BASE,headers=OWNER)).json()['runtime']['navigation']
    assert set(hint)=={'request_id','session_uid','revision','created_at_ms','expires_at_ms'}
    assert (await client.post(claim,headers={'X-User-Id':'8'})).status_code==404
    result=await client.post(claim,headers=OWNER)
    assert result.status_code==200 and result.json()['source']['path']=='wiki/demo.md'
    assert (await client.post(claim,headers=OWNER)).status_code==409


@pytest.mark.parametrize('change',['caller','unknown','queued','stopped','session','old'])
async def test_only_the_same_callers_recent_completed_answer_can_select_a_source(navigation,change):
    client,repo,redis,store,state,old=navigation
    auth=AUTH.copy();reply=repo.row['data']['voice_replies'][old]
    if change=='caller':auth['X-Voice-Speaker-Key']='b'*64
    if change=='unknown':auth.pop('X-Voice-Speaker-Key')
    if change in ('queued','stopped'):reply['state']=change
    if change=='session':reply['session_uid']='retired'
    if change=='old':reply['ended_at_ms']=int(time.time()*1000)-120001
    body,result,calls=await ask(client,auth=auth)
    assert calls==[] and result['clarification'] is True
    assert not await redis.get('meeting:voice:1:navigation')


async def test_ambiguous_sources_require_an_ordinal_and_never_choose_arbitrary_paths(navigation):
    client,repo,redis,store,state,_=navigation
    state['sources'].append({'id':'ctx-'+'b'*64,'kind':'document','path':'wiki/other.md','quote':'Other source.'})
    body,result,calls=await ask(client,'Mở nguồn đó')
    assert result['clarification'] and calls==[]
    await complete(client,store,body)
    next_body,_,calls=await ask(client,'Mở nguồn số 2')
    assert calls==[{'name':'open_source','query':'ctx-'+'b'*64}]
    await complete(client,store,next_body)
    response=await client.post(OWNER_BASE+'/navigation/'+next_body['request_id'],headers=OWNER)
    assert response.json()['source']['path']=='wiki/other.md'


@pytest.mark.parametrize('change',['source','policy','stop','expiry','replacement','lease','heartbeat','deleted'])
async def test_revocation_stop_and_late_navigation_are_fenced(navigation,change):
    client,repo,redis,store,state,_=navigation
    body,_,_=await ask(client);await complete(client,store,body)
    if change=='source':state['sources']=[];state['unavailable']=1
    if change=='policy':repo.row['data']['voice_assistant']['revision']=2
    if change=='stop':
        # Readback cancellation is terminal and cannot authorize navigation.
        repo.row['data']['voice_replies'][body['request_id']]['state']='stopped'
    if change=='expiry':
        value=json.loads(await redis.get('meeting:voice:1:navigation'));value['expires_at_ms']=0
        await redis.set('meeting:voice:1:navigation',json.dumps(value))
    if change=='replacement':await redis.set('meeting:voice:1:state',json.dumps({'state':'CAPTURING','session_uid':'current','request_id':str(uuid4())}))
    if change=='lease':await redis.set('meeting:voice:1:lock','current:'+str(uuid4()))
    if change=='heartbeat':await redis.delete('meeting:voice:1:state')
    if change=='deleted':repo.row['data']['artifact_deletion']=True
    response=await client.post(OWNER_BASE+'/navigation/'+body['request_id'],headers=OWNER)
    assert response.status_code==409


async def test_a_source_removed_while_the_owner_claims_is_not_released(navigation):
    import asyncio
    client,repo,redis,store,state,_=navigation
    body,_,_=await ask(client);await complete(client,store,body)
    state['source_gate']=asyncio.Event();state['entered']=asyncio.Event()
    task=asyncio.create_task(client.post(OWNER_BASE+'/navigation/'+body['request_id'],headers=OWNER))
    try:
        await asyncio.wait_for(state['entered'].wait(),2)
        repo.row['data']['voice_assistant']['revision']=2
        state['source_gate'].set();assert (await task).status_code==409
    finally:state['source_gate'].set();await task


def test_source_navigation_intent_and_ambiguity_are_bounded():
    for question in ['Mở đoạn quyết định đó','TINA ơi, mở tài liệu đó','Mở nguồn số 2','Show the source']:
        assert open_source_intent(question)
    for question in ['Mở https://example.com','Mở tài liệu ../../secret','Mở tài liệu /Users/private.md','Tài liệu nói mở nguồn','Mở nguồn và gửi email']:
        assert not open_source_intent(question)
    rows=[VoiceSource(id='ctx-'+'a'*64,kind='transcript',segment_id='same',meeting_id=1,quote='A'),
          VoiceSource(id='ctx-'+'b'*64,kind='transcript',segment_id='same',meeting_id=2,quote='B')]
    assert select_open_source('Mở đoạn đó',rows)[1]=='ambiguous'
    assert select_open_source('Mở nguồn số 2',rows)[0].meeting_id==2
    assert select_open_source('Mở nguồn số hai',rows)[0].meeting_id==2
    assert select_open_source('Mở nguồn số 100',rows)[1]=='missing'
    doc=VoiceSource(id='ctx-'+'c'*64,kind='document',path='wiki/demo.md',quote='Demo')
    assert select_open_source('Mở tài liệu other.md',[doc])[1]=='missing'
    assert select_open_source('Mở tài liệu demo.md',[doc])[0]==doc
