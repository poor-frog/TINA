from test_task_flow import flow_service, question, context, BOT, AUTH
import asyncio
import json
import pytest
import httpx


async def advance(client,body):
    for operation in ('flow_plan','flow_apply'):
        response=await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':operation})
        assert response.status_code==200,response.text
    return await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})


async def heard(client,playback,body):
    for state in ('started','completed'):await playback.report(1,body['request_id'],'current',state)
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})


async def test_decision_flow_follows_same_speaker_and_uses_decision_finish_only(flow_service):
    client,repo,redis,playback,state,_,_,calls=flow_service
    state['node']='decision_status';body=question('Ghi quyết định demo')
    snapshot=await context(client,body)
    assert snapshot.json()['task_flow']=={'node':'title','kind':'decision'}
    result=await advance(client,body);assert result.status_code==200,result.text
    assert any(path.endswith('/decision-flow') and 'decision_state' in payload for path,payload in calls)
    await heard(client,playback,body)
    other=question('đề xuất')
    snapshot=await context(client,other,AUTH|{'X-Voice-Speaker-Key':'b'*64})
    assert 'task_flow' not in snapshot.json()
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':other['request_id']})
    state.update(node='review',requested_status='proposed');body=question('đề xuất')
    assert (await context(client,body)).json()['task_flow']=={'node':'decision_status','kind':'decision'}
    assert (await advance(client,body)).status_code==200
    await heard(client,playback,body)
    state['action']='finish';body=question('đồng ý')
    assert (await context(client,body)).json()['task_flow']['kind']=='decision'
    assert (await advance(client,body)).status_code==200
    assert any(path.endswith('/decision-flow') and payload['operation']=='finish' for path,payload in calls)
    assert not await redis.keys('*:task-flow:*')


async def test_decision_without_identified_channel_cannot_fall_back_to_unchecked_draft(flow_service):
    client,*_=flow_service
    response=await context(client,question('Ghi quyết định demo'),{'Authorization':AUTH['Authorization']})
    assert response.status_code==409


async def test_paused_decision_handoff_keeps_status_and_atomically_detaches_flow(flow_service):
    client,_,redis,playback,state,*_=flow_service
    state.update(node='decision_status',action='pause');body=question('Ghi quyết định demo')
    assert (await context(client,body)).json()['task_flow']['kind']=='decision'
    assert (await advance(client,body)).status_code==200
    await heard(client,playback,body)
    owner={'X-User-Id':'7'}
    hint=(await client.get('/meetings/1/voice-assistant',headers=owner)).json()['runtime']['handoff']
    assert hint['kind']=='decision'
    response=await client.post('/meetings/1/voice-assistant/handoff/'+body['request_id'],headers=owner)
    assert response.status_code==200,response.text
    assert response.json()['decision']=={'title':'demo','requested_status':None,'evidence_status':'unchecked','missing_field':'decision_status','save_uncertain':False}
    assert response.json()['task'] is None and not await redis.keys('*:task-flow:*')


async def test_stop_fences_late_decision_planning(flow_service):
    client,_,redis,_,state,entered,release,_=flow_service
    state.update(node='decision_status',block=True);body=question('Ghi quyết định demo')
    assert (await context(client,body)).status_code==200
    running=asyncio.create_task(client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':'flow_plan'}))
    await asyncio.wait_for(entered.wait(),2)
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})
    release.set()
    assert (await running).status_code==409
    assert not await redis.keys('*:task-flow:*')


@pytest.mark.parametrize('status',[409,503])
async def test_source_conflict_and_unknown_write_have_distinct_recovery(flow_service,status):
    client,_,redis,playback,state,*_=flow_service
    state.update(node='review',requested_status='decided');body=question('Ghi quyết định demo, đã chốt')
    await context(client,body);assert (await advance(client,body)).status_code==200
    await heard(client,playback,body)
    state.update(action='finish',finish_status=status);body=question('đồng ý')
    await context(client,body)
    result=await advance(client,body)
    assert result.status_code==200,result.text
    stored=json.loads(await redis.get((await redis.keys('*:task-flow:*'))[0]))
    if status==409:
        assert result.json()['reason']=='clarification' and result.json()['clarification'] is True
        assert stored['node']=='decision_evidence' and stored['state']['evidence_status']=='unchecked'
        assert not stored['state'].get('save_uncertain')
    else:
        assert result.json()['reason']=='draft_unavailable' and not result.json()['clarification']
        assert stored['state']['save_uncertain'] is True


async def test_task_unknown_write_gets_the_same_uncertainty_marker(flow_service):
    client,_,redis,playback,state,*_=flow_service
    state['node']='review';body=question('Tạo task demo')
    await context(client,body);await advance(client,body);await heard(client,playback,body)
    state.update(action='finish',finish_status=503);body=question('đồng ý')
    await context(client,body)
    result=await advance(client,body)
    assert result.status_code==200 and result.json()['reason']=='draft_unavailable'
    stored=json.loads(await redis.get((await redis.keys('*:task-flow:*'))[0]))
    assert stored['state']['save_uncertain'] is True




@pytest.mark.parametrize('outcome',['fresh','stale','unavailable','stopped'])
async def test_decision_readback_revalidates_sources_and_keeps_proof_receipts(flow_service,monkeypatch,outcome):
    client,repo,redis,playback,state,*_=flow_service
    old=httpx.AsyncClient.request
    source_checks=[]
    stale=[False];turn_id=[None]
    async def request(self,method,url,**kwargs):
        body=kwargs.get('json') or {}
        if str(url).endswith('/sources'):
            source_checks.append(body)
            if outcome=='stopped':await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':turn_id[0]})
            if outcome=='unavailable':return httpx.Response(503,json={'detail':'Synthetic source outage'})
            source={'id':'ctx-'+'a'*64,'kind':'transcript','segment_id':'decision-1','quote':'Đã thống nhất dùng PostgreSQL.'}
            return httpx.Response(200,json={'sources':[] if stale[0] else [source],'unavailable':int(stale[0])})
        if str(url).endswith('/decision-flow') and body.get('operation')=='plan':
            return httpx.Response(200,json={'action':'update','node':'review','state':{
                'kind':'decision','title':'dùng PostgreSQL','requested_status':'decided','status_text':'đã chốt',
                'evidence_status':'supported','evidence':[{'key':'segment:decision-1','fingerprint':'a'*64,
                    'quote':'Đã thống nhất dùng PostgreSQL.'}],'utterances':['Ghi quyết định dùng PostgreSQL, đã chốt']},
                'text':'Em ghi: dùng PostgreSQL. Trạng thái: đã chốt, có nguồn xác nhận. Tạo bản nháp nhé?'})
        return await old(self,method,url,**kwargs)
    monkeypatch.setattr(httpx.AsyncClient,'request',request)
    body=question('Ghi quyết định dùng PostgreSQL, đã chốt');turn_id[0]=body['request_id']
    assert (await context(client,body)).status_code==200
    for operation in ('flow_plan','flow_apply'):
        assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':operation})).status_code==200
    # The source is edited/revoked after plan/apply; the policy revision is unchanged.
    stale[0]=outcome=='stale'
    reply=await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})
    if outcome=='stopped':
        assert reply.status_code==409
        receipt=await playback.get(1,body['request_id'])
        assert receipt is None or receipt['state'] in ('stopped','failed')
        return
    assert reply.status_code==200,reply.text
    assert len(source_checks)==1
    receipt=await playback.get(1,body['request_id'])
    stored=json.loads(await redis.get((await redis.keys('*:task-flow:*'))[0]))
    if outcome=='fresh':
        assert 'đã chốt, có nguồn xác nhận' in reply.json()['text']
        assert reply.json()['evidence_available'] is True
        assert receipt['voice_reply']['source_refs']==[{'key':'segment:decision-1','fingerprint':'a'*64}]
    else:
        assert 'đã chốt, có nguồn xác nhận' not in reply.json()['text']
        assert not receipt['voice_reply']['source_refs']
        assert stored['state']['title']=='dùng PostgreSQL'
        if outcome=='stale':
            assert stored['node']=='decision_evidence' and stored['state']['evidence_status']=='unchecked'
            assert reply.json()['reason']=='clarification'
        else:
            assert reply.json()['reason']=='llm_unavailable'
            assert stored['state']['evidence_status']=='supported'
