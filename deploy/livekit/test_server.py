from contextlib import asynccontextmanager, suppress
from uuid import uuid4

import asyncio
import socket
import httpx
import pytest
import uvicorn
from livekit.agents import AgentSession

import server

SESSION=str(uuid4())
HEADERS={'Authorization':'Bearer test-meeting-capability'}
URL=f'/bots/1/{SESSION}'


@pytest.fixture
async def service(monkeypatch):
    monkeypatch.delenv('MEETING_API_URL',raising=False)
    monkeypatch.setenv('TTS_API_TOKEN', 'synthetic-tts-' + 'x' * 40)
    calls=[];blocked=[None];entered=asyncio.Event();connect_gate=[None];connect_entered=asyncio.Event();context_gate=[None]
    connect_names=[]
    broken_tts=[False];config_hook=[None];config_status=[200];turn_hook=[None];tts_stream=[None]
    class PartialTTS(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'\0\0'*24000
            await asyncio.sleep(.1)
            raise httpx.ReadError('synthetic TTS connection lost after partial PCM')
    state={'engine':'livekit','enabled':True,'revision':1};flow_gate=[None]
    heard={};planned=set();lookup_gate=[None];lookup_started=[];lookup_closed=[];both_lookups=asyncio.Event()
    async def upstream(request):
        calls.append(request)
        if '/turn/' in request.url.path:
            if turn_hook[0]: await turn_hook[0](request)
            return httpx.Response(200,json={'current':state.get('turn_current',True)})
        if request.url.path.endswith('/config'):
            assert request.url.host=='meeting-api' and request.url.port==8080
            if config_hook[0]: await config_hook[0]()
            if request.headers.get('Authorization')!=HEADERS['Authorization']:return httpx.Response(401)
            return httpx.Response(config_status[0],json=state)
        if request.url.path.endswith('/agent'):
            import json
            body=json.loads(request.content)
            if body['operation']=='plan' and state.get('planning_unavailable'):
                return httpx.Response(503,json={'detail':'Synthetic planner outage'})
            if body['operation']=='context':
                if context_gate[0]:entered.set();await context_gate[0].wait()
                mid=int(request.url.path.split('/')[3]);speaker=request.headers.get('X-Voice-Speaker-Key')
                return httpx.Response(200,json={'history':heard.get((mid,speaker),heard.get(speaker,[])),'available_tools':['search_meeting'],
                    **({'task_flow':{'node':state.get('flow_node','title'),**({'kind':'decision'} if state.get('decision_flow') else {})}} if state.get('task_flow') else {})})
            if body['operation'] in ('flow_plan','flow_apply'):
                if flow_gate[0]:entered.set();await flow_gate[0].wait()
                return httpx.Response(200,json={'action':state.get('flow_action','update'),'node':'decision_status' if state.get('decision_flow') else 'assignee',
                    'state':{'title':'demo'},'text':'Bạn muốn ghi ai phụ trách, hay để trống?'})
            if body['operation']=='plan':
                if body['request_id'] in planned:return httpx.Response(200,json={'tool_calls':[]})
                planned.add(body['request_id'])
                plan=[{'name':'search_meeting','query':'demo'}]
                if state.get('two_tools'):plan.append({'name':'search_shared_documents','query':'demo'})
                return httpx.Response(200,json={'tool_calls':plan})
            if lookup_gate[0]:
                name=body['lookup']['name'];lookup_started.append(name)
                if len(lookup_started)==2:both_lookups.set()
                try:await lookup_gate[0].wait()
                finally:lookup_closed.append(name)
            name=body['lookup']['name']
            if name in state.get('lookup_http_status',{}):
                return httpx.Response(state['lookup_http_status'][name],json={'detail':'PRIVATE rejected source'})
            if name in state.get('lookup_results',{}):
                return httpx.Response(200,json=state['lookup_results'][name])
            return httpx.Response(200,json={'tool':'search_meeting','source_count':1,'sources':[{'id':'s0','text':'Lan phụ trách demo.'}]})
        if request.url.path.endswith('/answer'):
            entered.set()
            if blocked[0]: await blocked[0].wait()
            mid=int(request.url.path.split('/')[3])
            return httpx.Response(200,json={'text':state.get('answers_by_mid',{}).get(mid,'Lan phụ trách demo.'),'reason':'answered','sources':[{'id':'s0'}]})
        if request.url.path.endswith('/state'):
            return httpx.Response(state.get('cancel_status',200),json={'accepted':state.get('cancel_ack',True)})
        if broken_tts[0]: return httpx.Response(200,stream=PartialTTS())
        if tts_stream[0]: return httpx.Response(200,stream=tts_stream[0](),headers={'x-audio-sample-rate':'24000','x-audio-channels':'1'})
        return httpx.Response(200,content=b'\0\0'*2400,headers={'x-audio-sample-rate':'24000','x-audio-channels':'1'})
    original_start=AgentSession.start
    async def start(self,agent,**kwargs):return await original_start(self,agent)
    monkeypatch.setattr(AgentSession,'start',start)
    async def disconnect():pass
    async def connect(name):
        connect_names.append(name)
        connect_entered.set()
        if connect_gate[0]: await connect_gate[0].wait()
        from types import SimpleNamespace
        return SimpleNamespace(disconnect=disconnect)
    async def delete(name):pass
    monkeypatch.setattr(server,'delete_room',delete)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client,room_connector=connect)
        app.state.blocked=blocked;app.state.entered=entered;app.state.context_gate=context_gate
        app.state.connect_gate=connect_gate;app.state.connect_entered=connect_entered
        app.state.connect_names=connect_names
        app.state.broken_tts=broken_tts
        app.state.config_hook=config_hook
        app.state.config_status=config_status
        app.state.turn_hook=turn_hook
        app.state.tts_stream=tts_stream
        app.state.heard=heard
        app.state.flow_gate=flow_gate
        app.state.lookup_gate=lookup_gate;app.state.lookup_started=lookup_started
        app.state.lookup_closed=lookup_closed;app.state.both_lookups=both_lookups
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://pilot') as client:
                yield client,calls,state,app


def question():return {'request_id':str(uuid4()),'question':'Ai làm demo?','revision':1}


async def test_slow_new_room_does_not_block_an_existing_runtime(service):
    _,_,_,app=service
    existing=await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    gate=asyncio.Event();app.state.connect_gate[0]=gate;app.state.connect_entered.clear()
    slow=asyncio.create_task(app.state.get_runtime(2,str(uuid4()),HEADERS['Authorization'],1))
    reuse=None
    try:
        await asyncio.wait_for(app.state.connect_entered.wait(),2)
        reuse=asyncio.create_task(app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1))
        assert await asyncio.wait_for(asyncio.shield(reuse),1) is existing
        assert not gate.is_set()
    finally:
        gate.set();await asyncio.gather(slow,*([reuse] if reuse else []),return_exceptions=True)


async def test_pending_admissions_reserve_capacity_and_cancellation_releases_the_slot(service):
    _,_,_,app=service
    gate=asyncio.Event();app.state.connect_gate[0]=gate
    tasks=[asyncio.create_task(app.state.get_runtime(mid,str(uuid4()),HEADERS['Authorization'],1)) for mid in (1,2,3)]
    try:
        for _ in range(50):
            if len(app.state.connect_names)==3:break
            await asyncio.sleep(.01)
        assert len(app.state.connect_names)==3 and not app.state.rows
        with pytest.raises(server.HTTPException) as error:
            await asyncio.wait_for(app.state.get_runtime(4,str(uuid4()),HEADERS['Authorization'],1),1)
        assert error.value.status_code==503
        tasks[0].cancel();await asyncio.gather(tasks[0],return_exceptions=True)
        tasks.append(asyncio.create_task(app.state.get_runtime(4,str(uuid4()),HEADERS['Authorization'],1)))
        for _ in range(50):
            if len(app.state.connect_names)==4:break
            await asyncio.sleep(.01)
        assert len(app.state.connect_names)==4
    finally:
        gate.set();await asyncio.gather(*tasks,return_exceptions=True)
    assert len(app.state.rows)==3


async def test_same_room_admissions_share_one_runtime(service):
    _,_,_,app=service
    gate=asyncio.Event();app.state.connect_gate[0]=gate
    tasks=[asyncio.create_task(app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)) for _ in range(2)]
    try:
        await asyncio.wait_for(app.state.connect_entered.wait(),2)
        await asyncio.sleep(.02)
        assert len(app.state.connect_names)==1
    finally:
        gate.set();values=await asyncio.gather(*tasks)
    assert values[0] is values[1] and len(app.state.rows)==1


async def test_slow_cleanup_does_not_block_another_ready_room(service,monkeypatch):
    _,_,_,app=service
    old=await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    other_session=str(uuid4())
    other=await app.state.get_runtime(2,other_session,HEADERS['Authorization'],1)
    gate,entered=asyncio.Event(),asyncio.Event();original=server.Runtime.close
    async def close(row):
        if row is old:entered.set();await gate.wait()
        await original(row)
    monkeypatch.setattr(server.Runtime,'close',close);old.failed=True
    replacing=asyncio.create_task(app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1))
    reuse=None
    try:
        await asyncio.wait_for(entered.wait(),2)
        reuse=asyncio.create_task(app.state.get_runtime(2,other_session,HEADERS['Authorization'],1))
        assert await asyncio.wait_for(asyncio.shield(reuse),1) is other
        assert not gate.is_set()
    finally:
        gate.set();await asyncio.gather(replacing,*([reuse] if reuse else []),return_exceptions=True)


@pytest.mark.parametrize('stop', [False, True])
async def test_actual_session_parallel_lookup_waits_for_both_and_stop_drains_http_requests(service, stop):
    import json
    client,calls,state,app=service;state['two_tools']=True;app.state.lookup_gate[0]=asyncio.Event()
    body=question()
    task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.both_lookups.wait(),3)
        assert set(app.state.lookup_started)=={'search_meeting','search_shared_documents'}
        assert not [r for r in calls if r.url.path.endswith('/answer')]
        if stop:
            result=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})
            assert result.status_code==200,result.text
            assert (await asyncio.wait_for(task,3)).status_code==409
            assert not [r for r in calls if r.url.path.endswith('/answer')]
        else:
            app.state.lookup_gate[0].set()
            result=await asyncio.wait_for(task,3)
            assert result.status_code==200,result.text
            operations=[json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]
            assert operations==['context','plan','lookup','lookup','plan']
            assert len([r for r in calls if r.url.path.endswith('/answer')])==1
        assert set(app.state.lookup_closed)==set(app.state.lookup_started)
    finally:
        app.state.lookup_gate[0].set()
        if not task.done():task.cancel()
        await asyncio.gather(task,return_exceptions=True)


@pytest.mark.parametrize('mode', ['partial', 'empty', 'unavailable', 'revoked', 'uncommitted_error'])
async def test_actual_session_distinguishes_empty_temporary_and_revoked_lookups(service, mode):
    import json
    client,calls,state,app=service;state['two_tools']=True
    empty={'source_count':0,'sources':[],'lookup_status':'empty'}
    unavailable={'source_count':0,'sources':[],'lookup_status':'unavailable',
                 'skipped':True,'retrieval_unavailable':True}
    if mode=='partial':state['lookup_results']={'search_shared_documents':unavailable}
    elif mode=='empty':state['lookup_results']={name:empty for name in ('search_meeting','search_shared_documents')}
    elif mode=='unavailable':state['lookup_results']={name:unavailable for name in ('search_meeting','search_shared_documents')}
    else:state['lookup_http_status']={'search_shared_documents':409 if mode=='revoked' else 503}
    result=await client.post(URL+'/answer',headers=HEADERS,json=question())
    answers=[r for r in calls if r.url.path.endswith('/answer')]
    operations=[json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]
    if mode in ('partial','empty'):
        assert result.status_code==200,result.text
        assert len(answers)==1
        assert operations.count('plan')==(1 if mode=='partial' else 2)
    elif mode=='revoked':
        assert result.status_code==409 and not answers
        assert operations.count('plan')==1
        assert 'PRIVATE' not in result.text
        assert app.state.rows[(1,SESSION)].failed is False
    else:
        assert result.status_code==503 and not answers
        assert operations.count('plan')==1
        assert 'PRIVATE' not in result.text
    # HTTP 503 not committed by core is fatal: the worker cannot pretend that its reserved call settled.


async def test_task_flow_uses_pipecat_once_without_running_livekit_tool_planning(service):
    import json
    client,calls,state,app=service;state['task_flow']=True
    response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':'a'*64},json=question()|{'question':'Tạo task demo'})
    assert response.status_code==200,response.text
    assert response.json()['workflow_runtime']=='pipecat-flows'
    operations=[json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]
    assert operations==['context','flow_plan','flow_apply']
    assert len([r for r in calls if r.url.path.endswith('/answer')])==1


async def test_decision_flow_uses_pipecat_without_running_normal_tool_planning(service):
    import json
    client,calls,state,app=service;state.update(task_flow=True,decision_flow=True,flow_node='decision_status')
    response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':'a'*64},json=question()|{'question':'đã chốt'})
    assert response.status_code==200,response.text
    assert response.json()['workflow_runtime']=='pipecat-flows'
    assert [json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]==['context','flow_plan','flow_apply']


async def test_task_flow_leaves_to_normal_qa_sequentially_and_stop_cancels_planning(service):
    import json
    client,calls,state,app=service;state.update(task_flow=True,flow_action='leave')
    response=await client.post(URL+'/answer',headers=HEADERS,json=question())
    assert response.status_code==200 and 'workflow_runtime' not in response.json()
    operations=[json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]
    assert operations[:3]==['context','flow_plan','flow_apply'] and 'plan' in operations[3:]
    calls.clear();state['flow_action']='update';app.state.flow_gate[0]=asyncio.Event()
    body=question();app.state.entered.clear()
    running=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    await asyncio.wait_for(app.state.entered.wait(),3)
    stopped=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})
    assert stopped.status_code==200,stopped.text
    assert (await running).status_code==409
    assert not [r for r in calls if r.url.path.endswith('/answer')]


async def test_capability_policy_revision_and_payload_guard_before_runtime_creation(service):
    client,calls,state,app=service
    assert (await client.post(URL+'/answer',json=question())).status_code==401
    assert (await client.post(URL+'/answer',headers={'Authorization':'Bearer other'},json=question())).status_code==403
    state['engine']='tina'
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==409
    state['engine']='livekit';state['revision']=2
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==409
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question()|{'documents':['private.md']})).status_code==422
    assert (await client.post(URL+'/answer',headers=HEADERS,content=b'x'*20001)).status_code==413
    async def chunked_body(): yield b'{}'
    assert (await client.post(URL+'/answer',headers=HEADERS,content=chunked_body())).status_code==413
    assert not app.state.rows


async def test_real_agents_answer_preserves_citations_and_speaker_scope(service):
    client,calls,state,app=service
    response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':'a'*64},json=question())
    assert response.status_code==200,response.text
    assert response.json()['voice_runtime']=='livekit' and response.json()['sources']==[{'id':'s0'}]
    answers=[r for r in calls if r.url.path.endswith('/answer')]
    assert len(answers)==1 and answers[0].headers['X-Voice-Speaker-Key']=='a'*64
    import json
    operations=[json.loads(r.content)['operation'] for r in calls if r.url.path.endswith('/agent')]
    assert operations==['context','plan','lookup','plan']
    assert json.loads(answers[0].content)['agent_context']==[]
    assert len(app.state.rows)==1
    assert (await client.post(f'/bots/2/{uuid4()}/answer',headers=HEADERS,json=question())).status_code==200


async def test_tts_uses_only_core_selected_speech_profile(service):
    import json
    client,calls,state,app=service;state['speech_profile']='core-approved-profile'
    request=question()
    response=await client.post(URL+'/v1/audio/speech',headers=HEADERS|{
        'X-Voice-Revision':'1','X-Voice-Request-Id':request['request_id']},json={
        'model':'tts-1','input':'synthetic','voice':'auto','meeting_id':1,'profile':'caller-forged-profile'})
    assert response.status_code==200
    speech=[r for r in calls if r.url.path.endswith('/v1/audio/speech')]
    assert speech and all(json.loads(r.content)['profile']=='core-approved-profile' for r in speech)


async def test_three_meetings_have_independent_sessions_answers_context_and_stop(service):
    import json
    client,calls,state,app=service
    speaker='a'*64
    state['answers_by_mid']={1:'Lan phụ trách demo.',2:'Minh phụ trách demo.',3:'Huy phụ trách demo.'}
    turns={mid:{'question':f'Meeting {mid}?','answer':text,'created_at_ms':1000} for mid,text in state['answers_by_mid'].items()}
    for mid,turn in turns.items():app.state.heard[(mid,speaker)]=[turn]
    bases={mid:f'/bots/{mid}/{uuid4()}' for mid in range(1,4)}
    bodies={mid:question() for mid in bases}
    responses=await asyncio.gather(*(client.post(base+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':speaker},json=bodies[mid]) for mid,base in bases.items()))
    assert [r.status_code for r in responses]==[200,200,200]
    assert [r.json()['text'] for r in responses]==list(state['answers_by_mid'].values())
    assert len(app.state.rows)==3
    assert len({id(row.session) for row in app.state.rows.values()})==3
    for request in [r for r in calls if r.url.path.endswith('/answer')]:
        mid=int(request.url.path.split('/')[3])
        assert json.loads(request.content)['agent_context']==[turns[mid]]
    assert (await client.post(f'/bots/4/{uuid4()}/answer',headers=HEADERS,json=question())).status_code==503
    assert (await client.request('DELETE',bases[1]+'/turn',headers=HEADERS,json={'request_id':bodies[1]['request_id']})).status_code==200
    assert (await client.post(bases[1]+'/answer',headers=HEADERS,json=bodies[1])).status_code==409
    assert (await client.post(bases[2]+'/answer',headers=HEADERS,json=question())).status_code==200


async def test_speech_revalidates_core_reservation_after_agents_runtime_is_recreated(service):
    client,calls,state,app=service
    body=question()
    assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==200
    key=next(iter(app.state.rows));row=app.state.rows.pop(key);await row.close()
    # Emulate a restart: SDK registry/Stop deque are empty; core remains the authority.
    state['turn_current']=False
    headers=HEADERS|{'X-Voice-Revision':'1','X-Voice-Request-Id':body['request_id']}
    response=await client.post(URL+'/v1/audio/speech',headers=headers,json={'input':'Old answer.','meeting_id':1})
    assert response.status_code==409
    assert not any(r.url.path.endswith('/v1/audio/speech') for r in calls)
    state['turn_current']=True
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200


async def test_disconnect_before_pcm_headers_releases_reserved_audio_slot(service,monkeypatch):
    client,calls,state,app=service
    body=question()
    assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==200
    original=server.StreamingResponse.__call__
    async def disconnect_headers(response,scope,receive,send):
        async def failed_send(message):
            if message['type']=='http.response.start':raise OSError('synthetic client disconnected before headers')
            await send(message)
        await original(response,scope,receive,failed_send)
    monkeypatch.setattr(server.StreamingResponse,'__call__',disconnect_headers)
    with pytest.raises(Exception):
        await client.post(URL+'/v1/audio/speech',headers=HEADERS|{
            'X-Voice-Revision':'1','X-Voice-Request-Id':body['request_id']},
            json={'input':'Synthetic reply.','meeting_id':1})
    row=next(iter(app.state.rows.values()))
    assert row.pending_audio==0
    assert not row.lock.locked()


@pytest.mark.parametrize('tts_status',[200,401,503,'unreachable'])
async def test_readiness_requires_authenticated_tts_without_synthesizing(monkeypatch,tts_status):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    token='synthetic-tts-'+'x'*40
    monkeypatch.setenv('TINA_LIVEKIT_VAD_SHADOW','1')
    def unavailable_observer():raise ValueError('synthetic missing observer asset')
    monkeypatch.setattr('vad_shadow.verify_assets',unavailable_observer)
    monkeypatch.setenv('TTS_API_TOKEN',token)
    class LiveKit:
        room=SimpleNamespace(list_rooms=AsyncMock(return_value=None))
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
    monkeypatch.setattr(server.api,'LiveKitAPI',LiveKit)
    calls=[]
    async def upstream(request):
        calls.append(request)
        if request.url.path=='/health':return httpx.Response(200)
        assert request.url.path=='/ready' and request.headers['X-API-Key']==token
        if tts_status=='unreachable':raise httpx.ConnectError('synthetic outage')
        return httpx.Response(tts_status,json={'status':'ok','sample_rate':24000,'channels':1,'format':'pcm_s16le'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
            response=await client.get('/ready')
            assert response.status_code==(200 if tts_status==200 else 503)
            assert all(r.method=='GET' for r in calls)
            if response.status_code==200:
                assert response.json()['capacity']==3 and response.json()['tts_ready'] is True
                assert response.json()['vad_shadow_ready'] is False


@pytest.mark.parametrize('token',['','short','encrypted:'+'x'*40,'x '*40,'ầ'*40])
async def test_readiness_refuses_invalid_tts_credentials_without_forwarding_them(monkeypatch,token):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    monkeypatch.setenv('TTS_API_TOKEN',token)
    class LiveKit:
        room=SimpleNamespace(list_rooms=AsyncMock(return_value=None))
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
    monkeypatch.setattr(server.api,'LiveKitAPI',LiveKit)
    async def upstream(request):
        assert request.url.path=='/health'
        return httpx.Response(200)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
            assert (await client.get('/ready')).status_code==503


async def test_real_agents_pcm_uses_existing_tts_and_stop_fences_only_its_turn(service):
    client,calls,state,app=service
    body=question()
    assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==200
    headers=HEADERS|{'X-Voice-Revision':'1','X-Voice-Request-Id':body['request_id']}
    speech={'input':'Lan phụ trách demo.','meeting_id':1,'response_format':'pcm'}
    response=await client.post(URL+'/v1/audio/speech',headers=headers,json=speech)
    assert response.status_code==200 and 4800<=len(response.content)<=5760
    assert response.headers['x-audio-sample-rate']=='24000'
    stopped=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})
    assert stopped.status_code==200
    assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==409
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    assert len([r for r in calls if r.url.path.endswith('/v1/audio/speech')])==1


async def test_stop_during_real_agents_llm_cancels_the_deferred_backend_and_cannot_resume(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.blocked[0]=gate
    body=question()
    task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.entered.wait(),2)
        assert (await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})).status_code==200
        response=await asyncio.wait_for(task,2)
        assert response.status_code==409
        assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==409
        gate.set();app.state.blocked[0]=None
        fresh=await client.post(URL+'/answer',headers=HEADERS,json=question())
        assert fresh.status_code==200
        assert len([r for r in calls if r.url.path.endswith('/answer')])==2
    finally:
        gate.set();task.cancel()


async def test_replacement_starts_immediately_after_stop_ack_and_a_late_old_stop_cannot_interrupt_it(service):
    client,calls,state,app=service
    first_gate,second_gate=asyncio.Event(),asyncio.Event()
    app.state.blocked[0]=first_gate
    first=question();old=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=first))
    new=None
    try:
        await asyncio.wait_for(app.state.entered.wait(),2)
        assert (await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':first['request_id']})).status_code==200
        app.state.blocked[0]=second_gate;app.state.entered.clear()
        replacement=question();replacement['question']='Tổng hợp cuộc họp. Chỉ lấy phần backend.'
        new=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=replacement))
        await asyncio.wait_for(app.state.entered.wait(),2)
        assert (await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':first['request_id']})).status_code==200
        assert not new.done()
        second_gate.set()
        assert (await asyncio.wait_for(new,2)).status_code==200
        assert (await old).status_code==409
    finally:
        first_gate.set();second_gate.set();old.cancel()
        if new and not new.done():new.cancel()


async def test_stop_does_not_acknowledge_a_failed_core_release(service):
    client,calls,state,app=service
    state['cancel_status']=503
    response=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':str(uuid4())})
    assert response.status_code==503
    state['cancel_status']=200;state['cancel_ack']=False
    response=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':str(uuid4())})
    assert response.status_code==503


async def test_context_loading_is_cancellable_before_a_speech_handle_exists(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.context_gate[0]=gate
    body=question();task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.entered.wait(),2)
        response=await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})
        assert response.status_code==200
        assert (await asyncio.wait_for(task,2)).status_code==409
        app.state.context_gate[0]=None
        assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    finally:gate.set();task.cancel()


async def test_stop_while_room_is_connecting_fences_the_future_turn_before_llm_dispatch(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.connect_gate[0]=gate
    body=question();task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.connect_entered.wait(),2)
        assert not app.state.rows
        assert (await client.request('DELETE',URL+'/turn',headers=HEADERS,json={'request_id':body['request_id']})).status_code==200
        gate.set()
        response=await asyncio.wait_for(task,2)
        assert response.status_code==409
        assert not [r for r in calls if r.url.path.endswith('/answer')]
    finally:gate.set();task.cancel()


@pytest.mark.parametrize('failures',[1,4])
async def test_partial_tts_failure_never_finishes_a_successful_pcm_response_and_next_turn_recovers(service,failures):
    client,calls,state,app=service
    app.state.broken_tts[0]=True
    headers=HEADERS|{'X-Voice-Revision':'1','X-Voice-Request-Id':str(uuid4())}
    body={'input':'Synthetic complete answer whose audio fails halfway.','meeting_id':1}
    for _ in range(failures):
        headers['X-Voice-Request-Id']=str(uuid4())
        with pytest.raises(RuntimeError,match='Agent speech failed'):
            await client.post(URL+'/v1/audio/speech',headers=headers,json=body)
    row=app.state.rows[(1,SESSION)]
    assert row.pending_audio==0 and not row.lock.locked()
    app.state.broken_tts[0]=False
    response=await client.post(URL+'/v1/audio/speech',headers=headers|{'X-Voice-Request-Id':str(uuid4())},json=body)
    assert response.status_code==200 and len(response.content)>0


async def test_stale_reaper_cannot_close_a_replacement_runtime_or_delete_its_room(service,monkeypatch):
    client,calls,state,app=service
    old_check=asyncio.Event();release_check=asyncio.Event()
    closing=asyncio.Event();release_close=asyncio.Event()
    deleted=[];closed=[]
    async def delete(name): deleted.append(name)
    monkeypatch.setattr(server,'delete_room',delete)
    original_close=server.Runtime.close
    async def close(row):
        closed.append(row)
        if len(closed)==1:
            closing.set()
            await release_close.wait()
        await original_close(row)
    monkeypatch.setattr(server.Runtime,'close',close)
    old=await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    async def hold_old_check():
        app.state.config_hook[0]=None
        old_check.set()
        await release_check.wait()
    app.state.config_hook[0]=hold_old_check
    replacement=None
    try:
        await asyncio.wait_for(old_check.wait(),4)
        state['revision']=2
        replacement=asyncio.create_task(app.state.get_runtime(1,SESSION,HEADERS['Authorization'],2))
        await asyncio.wait_for(closing.wait(),2)
        release_check.set()
        # The old reaper must queue behind replacement while the old runtime is being closed.
        await asyncio.sleep(.03)
        release_close.set()
        new=await asyncio.wait_for(replacement,2)
        await asyncio.sleep(.05)
        assert app.state.rows[(1,SESSION)] is new
        assert closed.count(old)==1 and deleted==[old.room_name]
        assert new.room_name!=old.room_name
        body=question()|{'revision':2}
        assert (await client.post(URL+'/answer',headers=HEADERS,json=body)).status_code==200
    finally:
        release_check.set();release_close.set()
        if replacement and not replacement.done():replacement.cancel()


async def test_truncated_tts_aborts_the_real_http_chunked_stream(service):
    _,calls,state,app=service
    app.state.broken_tts[0]=True
    listener=socket.socket()
    listener.bind(('127.0.0.1',0))
    port=listener.getsockname()[1]
    worker=uvicorn.Server(uvicorn.Config(app,lifespan='off',log_config=None,log_level='critical',
                                        access_log=False,timeout_graceful_shutdown=1))
    task=asyncio.create_task(worker.serve(sockets=[listener]))
    received=0
    try:
        async with asyncio.timeout(3):
            while not worker.started: await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}',timeout=5) as client:
            async with client.stream('POST',URL+'/v1/audio/speech',headers=HEADERS|{
                'X-Voice-Revision':'1','X-Voice-Request-Id':str(uuid4())},
                json={'input':'Synthetic complete answer.','meeting_id':1}) as response:
                assert response.status_code==200
                with pytest.raises(httpx.RemoteProtocolError):
                    async for chunk in response.aiter_bytes(): received+=len(chunk)
        assert received>0
    finally:
        worker.should_exit=True
        await asyncio.wait_for(task,3)
        listener.close()


@pytest.mark.parametrize('core_status',[200,503,'unreachable'])
async def test_readiness_checks_the_real_meeting_api_endpoint(monkeypatch,core_status):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    monkeypatch.delenv('MEETING_API_URL',raising=False)
    class LiveKit:
        room=SimpleNamespace(list_rooms=AsyncMock(return_value=None))
        async def __aenter__(self):return self
        async def __aexit__(self,*args):pass
    monkeypatch.setattr(server.api,'LiveKitAPI',LiveKit)
    async def upstream(request):
        assert str(request.url)=='http://meeting-api:8080/health'
        if core_status=='unreachable':raise httpx.ConnectError('synthetic refused connection')
        return httpx.Response(core_status)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=server.create_app(client=upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://pilot') as client:
            response=await client.get('/health')
            assert response.status_code==(200 if core_status==200 else 503)
            if core_status==200:assert response.json()['ready'] is True


def test_compose_pilot_uses_the_same_meeting_api_as_the_gateway():
    from pathlib import Path
    import yaml
    compose=yaml.safe_load((Path(__file__).resolve().parents[1]/'compose/docker-compose.yml').read_text())
    services=compose['services']
    gateway=dict(item.split('=',1) for item in services['gateway']['environment'])
    assert services['livekit-agent']['environment']['MEETING_API_URL']==gateway['MEETING_API_URL']=='http://meeting-api:8080'


@pytest.mark.parametrize('upstream_status,expected',[(401,403),(403,403),(404,403),(409,409),
                                                  (429,503),(500,503),(503,503),(504,503)])
async def test_config_distinguishes_permission_failures_from_service_outages(service,upstream_status,expected):
    _,_,_,app=service
    app.state.config_status[0]=upstream_status
    with pytest.raises(server.HTTPException) as failure:
        await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    assert failure.value.status_code==expected
    assert not app.state.rows


async def test_transient_503_keeps_an_inflight_answer_and_recovers_without_replacing_its_room(service):
    client,_,_,app=service
    gate=asyncio.Event();checked=asyncio.Event();app.state.blocked[0]=gate
    body=question()
    task=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=body))
    try:
        await asyncio.wait_for(app.state.entered.wait(),2)
        row=app.state.rows[(1,SESSION)]
        app.state.config_status[0]=503
        async def observe_check():checked.set()
        app.state.config_hook[0]=observe_check
        await asyncio.wait_for(checked.wait(),4)
        await asyncio.sleep(.05)
        assert app.state.rows.get((1,SESSION)) is row and row.lock.locked()
        assert not task.done()
        app.state.config_status[0]=200;app.state.config_hook[0]=None
        gate.set()
        response=await asyncio.wait_for(task,2)
        assert response.status_code==200 and response.json()['reason']=='answered'
        assert app.state.rows[(1,SESSION)] is row
    finally:
        gate.set()
        if not task.done():task.cancel()


async def test_sdk_chat_context_is_per_caller_and_refreshes_only_played_prefixes(service):
    import json,time
    client,calls,state,app=service
    a,b='a'*64,'b'*64
    turn={'question':'Ai làm demo?','answer':'Lan phụ trách demo.', 'created_at_ms':int(time.time()*1000)-1000}
    app.state.heard[a]=[turn]
    for speaker in (a,b,a):
        if speaker==a and len([r for r in calls if r.url.path.endswith('/answer')])==2:
            app.state.heard[a]=[turn|{'answer':'Lan phụ trách'}]  # Actual stopped playback prefix.
        response=await client.post(URL+'/answer',headers=HEADERS|{'X-Voice-Speaker-Key':speaker},json=question())
        assert response.status_code==200,response.text
    bodies=[json.loads(r.content) for r in calls if r.url.path.endswith('/answer')]
    assert [b['agent_context'] for b in bodies]==[[turn],[],[turn|{'answer':'Lan phụ trách'}]]
    row=next(iter(app.state.rows.values()))
    assert server.context_turns(row.contexts[a][1])==[turn|{'answer':'Lan phụ trách'}]
    assert server.context_turns(row.contexts[b][1])==[]
    messages=row.session.current_agent.chat_ctx.items
    assert [m.text_content for m in messages if m.type=='message' and m.role=='assistant']==['Lan phụ trách']


async def test_repeated_planner_failures_release_core_turn_and_recover_when_service_returns(service):
    import json
    client,calls,state,app=service
    state['planning_unavailable']=True
    for _ in range(4):
        response=await client.post(URL+'/answer',headers=HEADERS,json=question())
        assert response.status_code==503
    state['planning_unavailable']=False
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    cancelled=[json.loads(r.content) for r in calls if r.url.path.endswith('/state')]
    assert len(cancelled)==4 and all(c['state']=='QUIET' for c in cancelled)


async def test_sdk_executes_transcript_and_wiki_tools_before_one_verified_final(service):
    import json
    client,calls,state,app=service
    state['two_tools']=True
    assert (await client.post(URL+'/answer',headers=HEADERS,json=question())).status_code==200
    operations=[json.loads(r.content) for r in calls if r.url.path.endswith('/agent')]
    assert len([op for op in operations if op['operation']=='plan'])==2
    assert {op['lookup']['name'] for op in operations if op['operation']=='lookup'}=={'search_meeting','search_shared_documents'}
    assert len([r for r in calls if r.url.path.endswith('/answer')])==1


async def test_real_disconnect_during_context_cancels_lookup_and_releases_room(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.context_gate[0]=gate
    sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen()
    port=sock.getsockname()[1]
    server=uvicorn.Server(uvicorn.Config(app,lifespan='off',access_log=False,log_level='critical',timeout_graceful_shutdown=1))
    serving=asyncio.create_task(server.serve(sockets=[sock]))
    try:
        while not server.started:await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}') as http:
            pending=asyncio.create_task(http.post(URL+'/answer',headers=HEADERS,json=question()))
            await asyncio.wait_for(app.state.entered.wait(),3)
            pending.cancel()
            with suppress(asyncio.CancelledError):await pending
            row=next(iter(app.state.rows.values()))
            async with asyncio.timeout(2):
                while row.lock.locked():await asyncio.sleep(.02)
            assert row.context_task is None and row.turn_done.is_set()
            assert not gate.is_set(),'disconnect must not need the source lookup to finish'
            assert [r for r in calls if r.url.path.endswith('/state')]
            assert not [r for r in calls if r.url.path.endswith('/answer')]
            gate.set()
            replacement=await http.post(URL+'/answer',headers=HEADERS,json=question())
            assert replacement.status_code==200,replacement.text
    finally:
        gate.set();server.should_exit=True;await serving


async def test_disconnect_during_room_connect_cleans_admission_before_other_meeting(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.connect_gate[0]=gate
    sock=socket.socket();sock.bind(('127.0.0.1',0));sock.listen()
    port=sock.getsockname()[1]
    server=uvicorn.Server(uvicorn.Config(app,lifespan='off',access_log=False,log_level='critical',timeout_graceful_shutdown=1))
    serving=asyncio.create_task(server.serve(sockets=[sock]));other=None
    try:
        while not server.started:await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}') as http:
            first=asyncio.create_task(http.post(URL+'/answer',headers=HEADERS,json=question()))
            await asyncio.wait_for(app.state.connect_entered.wait(),3)
            first.cancel()
            with suppress(asyncio.CancelledError):await first
            app.state.connect_gate[0]=None
            other=asyncio.create_task(app.state.get_runtime(2,str(uuid4()),HEADERS['Authorization'],1))
            await asyncio.wait_for(other,2)
            assert not gate.is_set(),'new meeting must not wait for abandoned connector'
            assert (1,SESSION) not in app.state.rows
            assert len(app.state.rows)==1
    finally:
        gate.set()
        if other:await asyncio.gather(other,return_exceptions=True)
        server.should_exit=True;await serving


async def test_policy_reaper_cancels_context_and_releases_turn_before_removal(service):
    client,calls,state,app=service
    gate=asyncio.Event();app.state.context_gate[0]=gate
    running=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=question()))
    await asyncio.wait_for(app.state.entered.wait(),3)
    row=app.state.rows[(1,SESSION)]
    state['enabled']=False
    try:
        async with asyncio.timeout(4):
            while (1,SESSION) in app.state.rows:await asyncio.sleep(.02)
        assert not row.lock.locked() and row.context_task is None
        assert row.closing is not None and row.closing.done()
        assert (await asyncio.wait_for(running,2)).status_code==409
        assert [r for r in calls if r.url.path.endswith('/state')]
        assert not [r for r in calls if r.url.path.endswith('/answer')]
        assert not gate.is_set(),'disposal must cancel the lookup, not wait for its source'
    finally:
        gate.set();await asyncio.gather(running,return_exceptions=True)


async def test_runtime_disposal_is_idempotent_and_releases_only_its_owned_turn(service,monkeypatch):
    import json
    client,calls,state,app=service
    deleted=[]
    async def delete(name):deleted.append(name)
    monkeypatch.setattr(server,'delete_room',delete)
    row=await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    rid=str(uuid4());row.current_id=rid
    await asyncio.gather(row.close(),row.close())
    assert deleted==[row.room_name]
    assert [json.loads(r.content) for r in calls if r.url.path.endswith('/state')]==[{'state':'QUIET','request_id':rid}]
    replacement=await app.state.get_runtime(1,SESSION,HEADERS['Authorization'],1)
    assert replacement is not row and replacement.room_name!=row.room_name


async def test_cancel_during_sdk_start_cleans_the_partial_room(service,monkeypatch):
    client,calls,state,app=service
    entered=asyncio.Event();deleted=[]
    async def start(*args,**kwargs):entered.set();await asyncio.Event().wait()
    async def delete(name):deleted.append(name)
    monkeypatch.setattr(AgentSession,'start',start);monkeypatch.setattr(server,'delete_room',delete)
    pending=asyncio.create_task(client.post(URL+'/answer',headers=HEADERS,json=question()))
    await asyncio.wait_for(entered.wait(),2)
    pending.cancel()
    with suppress(asyncio.CancelledError):await asyncio.wait_for(pending,2)
    assert not app.state.rows and len(deleted)==1


async def test_connect_room_grants_can_update_own_metadata(monkeypatch):
    captured = {}

    class FakeRoom:
        async def connect(self, url, token, options=None):
            captured['url'] = url
            captured['token'] = token

        async def disconnect(self):
            pass

    monkeypatch.setenv('LIVEKIT_URL', 'ws://livekit.test:7880')
    monkeypatch.setenv('LIVEKIT_API_KEY', 'test-api-key')
    monkeypatch.setenv('LIVEKIT_API_SECRET', 'test-api-secret-at-least-32-chars-long')
    monkeypatch.setattr(server.rtc, 'Room', FakeRoom)
    await server.connect_room('room-meta-check')
    verified = server.api.TokenVerifier('test-api-key', 'test-api-secret-at-least-32-chars-long').verify(captured['token'])
    assert verified.video.room_join is True
    assert verified.video.room == 'room-meta-check'
    assert verified.video.can_update_own_metadata is True
    assert verified.video.can_publish is False
    assert verified.video.can_subscribe is False


async def test_real_disconnect_does_not_poison_runtime_failed_flag(service):
    client, calls, state, app = service
    gate = asyncio.Event()
    app.state.context_gate[0] = gate
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen()
    port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app, lifespan='off', access_log=False, log_level='critical', timeout_graceful_shutdown=1))
    serving = asyncio.create_task(srv.serve(sockets=[sock]))
    try:
        while not srv.started:
            await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}') as http:
            pending = asyncio.create_task(http.post(URL + '/answer', headers=HEADERS, json=question()))
            await asyncio.wait_for(app.state.entered.wait(), 3)
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending
            row = next(iter(app.state.rows.values()))
            async with asyncio.timeout(2):
                while row.lock.locked():
                    await asyncio.sleep(.02)
            assert row.failed is False
            gate.set()
            replacement = await http.post(URL + '/answer', headers=HEADERS, json=question())
            assert replacement.status_code == 200
            assert app.state.rows[(1, SESSION)] is row
    finally:
        gate.set()
        srv.should_exit = True
        await serving


@pytest.mark.parametrize('settles_cleanly', [True, False])
async def test_disconnect_during_generate_reply_marks_failed_only_when_interrupt_hangs(service, monkeypatch, settles_cleanly):
    client, calls, state, app = service
    started = asyncio.Event()
    interrupted = asyncio.Event()
    hang = asyncio.Event()

    class SyntheticHandle:
        def interrupt(self):
            interrupted.set()

        def exception(self):
            return None

        async def wait_for_playout(self):
            started.set()
            if settles_cleanly:
                await interrupted.wait()
            else:
                await hang.wait()

    monkeypatch.setattr(AgentSession, 'generate_reply', lambda self, **kw: SyntheticHandle())
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    sock.listen()
    port = sock.getsockname()[1]
    srv = uvicorn.Server(uvicorn.Config(app, lifespan='off', access_log=False, log_level='critical', timeout_graceful_shutdown=1))
    serving = asyncio.create_task(srv.serve(sockets=[sock]))
    try:
        while not srv.started:
            await asyncio.sleep(.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}') as http:
            pending = asyncio.create_task(http.post(URL + '/answer', headers=HEADERS, json=question()))
            await asyncio.wait_for(started.wait(), 3)
            pending.cancel()
            with suppress(asyncio.CancelledError):
                await pending
            row = next(iter(app.state.rows.values()))
            async with asyncio.timeout(4):
                while row.lock.locked():
                    await asyncio.sleep(.02)
            assert interrupted.is_set()
            assert row.failed is (not settles_cleanly)
    finally:
        hang.set()
        srv.should_exit = True
        await serving


async def test_reaper_survives_unexpected_room_errors_and_reaps_remaining_rooms(monkeypatch):
    monkeypatch.setattr(server, 'REAP_INTERVAL', 0.05)
    monkeypatch.delenv('MEETING_API_URL', raising=False)
    monkeypatch.setenv('TTS_API_TOKEN', 'synthetic-tts-' + 'x' * 40)
    state = {'engine': 'livekit', 'enabled': True, 'revision': 1}
    async def upstream(request):
        if request.url.path.endswith('/config'):
            return httpx.Response(200, json=state)
        return httpx.Response(200, json={'accepted': True})
    original_start = AgentSession.start
    async def start(self, agent, **kwargs): return await original_start(self, agent)
    monkeypatch.setattr(AgentSession, 'start', start)
    async def disconnect(): pass
    async def connect(name):
        from types import SimpleNamespace
        return SimpleNamespace(disconnect=disconnect)
    async def delete(name): pass
    monkeypatch.setattr(server, 'delete_room', delete)
    original_close = server.Runtime.close
    failed_once = {'raised': False}
    broken_row = {'ref': None}
    async def flaky_close(row):
        if row is broken_row['ref'] and not failed_once['raised']:
            failed_once['raised'] = True
            raise RuntimeError('synthetic close failure')
        await original_close(row)
    monkeypatch.setattr(server.Runtime, 'close', flaky_close)
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app = server.create_app(client=upstream_client, room_connector=connect)
        async with app.router.lifespan_context(app):
            s1, s2, s3 = str(uuid4()), str(uuid4()), str(uuid4())
            r1 = await app.state.get_runtime(1, s1, HEADERS['Authorization'], 1)
            r2 = await app.state.get_runtime(2, s2, HEADERS['Authorization'], 1)
            broken_row['ref'] = r1
            r1.touched = 0
            r2.touched = 0
            async with asyncio.timeout(2):
                while app.state.rows:
                    await asyncio.sleep(0.02)
            assert failed_once['raised'] is True
            # Verify reaper task is still alive by adding a 3rd idle room and confirming it gets reaped too.
            r3 = await app.state.get_runtime(3, s3, HEADERS['Authorization'], 1)
            r3.touched = 0
            async with asyncio.timeout(2):
                while (3, s3) in app.state.rows:
                    await asyncio.sleep(0.02)
            assert not app.state.rows


async def test_livekit_max_rooms_is_configurable_via_env(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock
    class LiveKit:
        room = SimpleNamespace(list_rooms=AsyncMock(return_value=None))
        async def __aenter__(self): return self
        async def __aexit__(self, *args): pass
    monkeypatch.setattr(server.api, 'LiveKitAPI', LiveKit)
    async def upstream(request): return httpx.Response(200)
    monkeypatch.setenv('LIVEKIT_MAX_ROOMS', '5')
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app = server.create_app(client=upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://pilot') as client:
            res = await client.get('/health')
            assert res.status_code == 200 and res.json()['capacity'] == 5
    monkeypatch.setenv('LIVEKIT_MAX_ROOMS', 'invalid')
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app = server.create_app(client=upstream_client)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://pilot') as client:
            res = await client.get('/health')
            assert res.status_code == 200 and res.json()['capacity'] == server.MAX_ROOMS


async def test_speech_streams_pcm_without_blocking_on_slow_periodic_turn_permit(service, monkeypatch):
    _, calls, state, app = service
    monkeypatch.setattr(server, 'PERMIT_CHECK_INTERVAL', 0.05)
    permit_calls = 0
    periodic_entered = asyncio.Event()
    release_periodic = asyncio.Event()
    async def slow_periodic(_request):
        nonlocal permit_calls
        permit_calls += 1
        # Call 1 = pre-lock check, Call 2 = inside-lock check, Call 3 = first periodic background check.
        if permit_calls == 3:
            periodic_entered.set()
            await release_periodic.wait()
    app.state.turn_hook[0] = slow_periodic

    class SlowPcmStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(10):
                yield b'\x01\x00' * 1200  # 50ms of 24kHz PCM per chunk
                await asyncio.sleep(0.03)
    app.state.tts_stream[0] = SlowPcmStream

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    worker = uvicorn.Server(uvicorn.Config(app, lifespan='off', log_config=None, log_level='critical',
                                           access_log=False, timeout_graceful_shutdown=1))
    serving = asyncio.create_task(worker.serve(sockets=[listener]))
    bytes_while_blocked = 0
    total_bytes = 0
    try:
        async with asyncio.timeout(3):
            while not worker.started: await asyncio.sleep(0.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=5) as client:
            async with client.stream('POST', URL + '/v1/audio/speech', headers=HEADERS | {
                'X-Voice-Revision': '1', 'X-Voice-Request-Id': str(uuid4())},
                json={'input': 'Synthetic smooth audio.', 'meeting_id': 1}) as response:
                assert response.status_code == 200
                async for chunk in response.aiter_bytes():
                    total_bytes += len(chunk)
                    if periodic_entered.is_set() and not release_periodic.is_set():
                        bytes_while_blocked += len(chunk)
                        if bytes_while_blocked >= 4800:
                            release_periodic.set()
                release_periodic.set()
        assert periodic_entered.is_set()
        assert bytes_while_blocked >= 4800, 'PCM must keep streaming while periodic turn_permit is slow'
        assert total_bytes >= 24000
    finally:
        release_periodic.set()
        worker.should_exit = True
        await asyncio.wait_for(serving, 3)
        listener.close()


async def test_speech_aborts_mid_stream_when_background_turn_permit_is_revoked(service, monkeypatch):
    _, calls, state, app = service
    monkeypatch.setattr(server, 'PERMIT_CHECK_INTERVAL', 0.05)
    permit_calls = 0
    async def revoke_on_periodic(_request):
        nonlocal permit_calls
        permit_calls += 1
        if permit_calls >= 3:
            state['turn_current'] = False
    app.state.turn_hook[0] = revoke_on_periodic

    class LongPcmStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(40):
                yield b'\x01\x00' * 1200
                await asyncio.sleep(0.03)
    app.state.tts_stream[0] = LongPcmStream

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    port = listener.getsockname()[1]
    worker = uvicorn.Server(uvicorn.Config(app, lifespan='off', log_config=None, log_level='critical',
                                           access_log=False, timeout_graceful_shutdown=1))
    serving = asyncio.create_task(worker.serve(sockets=[listener]))
    received = 0
    try:
        async with asyncio.timeout(3):
            while not worker.started: await asyncio.sleep(0.01)
        async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}', timeout=5) as client:
            async with client.stream('POST', URL + '/v1/audio/speech', headers=HEADERS | {
                'X-Voice-Revision': '1', 'X-Voice-Request-Id': str(uuid4())},
                json={'input': 'Synthetic revoked audio.', 'meeting_id': 1}) as response:
                assert response.status_code == 200
                with pytest.raises(httpx.RemoteProtocolError):
                    async for chunk in response.aiter_bytes():
                        received += len(chunk)
        assert received > 0
        row = app.state.rows[(1, SESSION)]
        assert row.failed is False, 'turn revocation must not poison room health'
        assert row.pending_audio == 0 and not row.lock.locked()
    finally:
        state['turn_current'] = True
        worker.should_exit = True
        await asyncio.wait_for(serving, 3)
        listener.close()


async def test_lookahead_speech_prefetches_tts_while_current_sentence_holds_lock(service):
    client, calls, state, app = service
    first_started = asyncio.Event()
    second_started = asyncio.Event()
    release_first = asyncio.Event()
    tts_inputs = []

    class GatedStream(httpx.AsyncByteStream):
        def __init__(self, idx):
            self.idx = idx
        async def __aiter__(self):
            if self.idx == 1:
                first_started.set()
                yield b'\x01\x00' * 1200
                await release_first.wait()
                yield b'\x01\x00' * 1200
            else:
                second_started.set()
                yield b'\x02\x00' * 2400

    stream_count = [0]
    def make_stream():
        stream_count[0] += 1
        tts_inputs.append(stream_count[0])
        return GatedStream(stream_count[0])
    app.state.tts_stream[0] = make_stream

    rid = str(uuid4())
    headers = HEADERS | {'X-Voice-Revision': '1', 'X-Voice-Request-Id': rid}
    first = asyncio.create_task(client.post(URL + '/v1/audio/speech', headers=headers,
        json={'input': 'First sentence.', 'meeting_id': 1}))
    second = None
    try:
        await asyncio.wait_for(first_started.wait(), 3)
        second = asyncio.create_task(client.post(URL + '/v1/audio/speech', headers=headers,
            json={'input': 'Second lookahead sentence.', 'meeting_id': 1}))
        # Lookahead TTS must start synthesizing while sentence 1 still holds row.lock.
        await asyncio.wait_for(second_started.wait(), 3)
        assert not first.done()
        release_first.set()
        r1, r2 = await asyncio.wait_for(asyncio.gather(first, second), 5)
        assert r1.status_code == 200 and len(r1.content) > 0
        assert r2.status_code == 200 and len(r2.content) > 0
        row = app.state.rows[(1, SESSION)]
        assert row.tts.speech is row.tts.base_speech
        assert row.pending_audio == 0
    finally:
        release_first.set()
        for t in (first, second):
            if t and not t.done(): t.cancel()
        await asyncio.gather(*[t for t in (first, second) if t], return_exceptions=True)


def test_livekit_agents_logger_emits_redacted_errors_without_private_text(caplog):
    import logging
    lk_logger = logging.getLogger('livekit.agents')
    assert lk_logger.level == logging.ERROR
    with caplog.at_level(logging.ERROR, logger='livekit.agents'):
        try:
            raise ConnectionError('Bearer SECRET_TOKEN PRIVATE_QUESTION')
        except ConnectionError:
            lk_logger.error('SDK failure with PRIVATE_QUESTION and Bearer SECRET_TOKEN', exc_info=True)
    assert any('ConnectionError' in r.getMessage() for r in caplog.records)
    assert 'SECRET_TOKEN' not in caplog.text and 'PRIVATE_QUESTION' not in caplog.text


def test_staging_voice_template_defines_bounded_container_resources():
    from pathlib import Path
    import yaml

    class _CfnLoader(yaml.SafeLoader):
        pass

    for tag in ('!Ref', '!Sub', '!GetAtt', '!If'):
        _CfnLoader.add_constructor(tag, lambda loader, node: loader.construct_scalar(node) if isinstance(node, yaml.ScalarNode) else loader.construct_sequence(node))

    tpl = yaml.load((Path(__file__).resolve().parents[1] / 'aws/staging-voice.yml').read_text(), Loader=_CfnLoader)
    task_props = tpl['Resources']['TaskDefinition']['Properties']
    task_cpu = int(task_props['Cpu'])
    task_mem = int(task_props['Memory'])
    defs = {c['Name']: c for c in task_props['ContainerDefinitions']}
    assert set(defs) == {'vieneu', 'livekit', 'agent'}
    assert sum(c['Cpu'] for c in defs.values()) == task_cpu
    assert sum(c['MemoryReservation'] for c in defs.values()) <= task_mem
    for c in defs.values():
        assert 0 < c['MemoryReservation'] <= c['Memory'] <= task_mem
    env_names = {e['Name'] for e in defs['agent']['Environment']}
    assert 'LIVEKIT_MAX_ROOMS' in env_names


@pytest.mark.parametrize('change', [{'enabled': False}, {'engine': 'tina'}])
async def test_stop_interrupts_inflight_turn_even_after_voice_disabled_or_engine_switched(service, change):
    client, calls, state, app = service
    gate = asyncio.Event()
    app.state.blocked[0] = gate
    body = question()
    task = asyncio.create_task(client.post(URL + '/answer', headers=HEADERS, json=body))
    try:
        await asyncio.wait_for(app.state.entered.wait(), 2)
        state.update(change)
        stop_resp = await client.request('DELETE', URL + '/turn', headers=HEADERS, json={'request_id': body['request_id']})
        assert stop_resp.status_code == 200 and stop_resp.json() == {'stopped': True}
        ans_resp = await asyncio.wait_for(task, 2)
        assert ans_resp.status_code == 409
        assert any(r.url.path.endswith('/state') for r in calls)
        # Capability / session authorization is still enforced on DELETE /turn
        bad_auth = await client.request('DELETE', URL + '/turn', headers={'Authorization': 'Bearer wrong-token'},
                                        json={'request_id': body['request_id']})
        assert bad_auth.status_code == 403
    finally:
        gate.set()
        if not task.done():
            task.cancel()
            with suppress(BaseException):
                await task


async def test_answer_timeout_returns_504_and_cancels_turn(service, monkeypatch):
    client, calls, state, app = service
    body = question()

    async def timeout_wait_for(coro, _timeout):
        if hasattr(coro, 'close'):
            coro.close()
        raise TimeoutError('synthetic livekit answer timeout')

    monkeypatch.setattr(server.asyncio, 'wait_for', timeout_wait_for)
    resp = await client.post(URL + '/answer', headers=HEADERS, json=body)
    assert resp.status_code == 504
    assert any(r.url.path.endswith('/state') for r in calls)
    row = app.state.rows[(1, SESSION)]
    assert row.failed is True
