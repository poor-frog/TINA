import asyncio
from copy import deepcopy
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from fakeredis.aioredis import FakeRedis

from meeting_api.lifecycle.voice import build_voice_router, voice_token
from meeting_api.lifecycle.speech_status import PlaybackStore


class Repo:
    def __init__(self):
        self.row = {'id': 1, 'user_id': 7, 'platform': 'google_meet', 'status': 'active',
                    'data': {'voice_agent_enabled': True, 'voice_assistant_capable': True, 'voice_assistant': {
                        'enabled': True, 'include_transcript': True, 'documents': [], 'revision': 1}}}
    async def get_meeting(self, mid): return deepcopy(self.row) if mid == 1 else None
    async def list_sessions(self, **kwargs): return ['current']
    async def save_voice_reply(self, mid, session, reply):
        from meeting_api.lifecycle.voice_replies import merge_reply
        self.row['data'] = merge_reply(self.row['data'], session, reply)
    async def set_voice_policy(self, mid, user, revision, policy):
        if revision != self.row['data']['voice_assistant']['revision']: raise ValueError()
        saved = dict(policy, revision=revision + 1)
        self.row['data']['voice_assistant'] = saved
        return saved


@pytest.fixture
async def setup(monkeypatch):
    monkeypatch.setenv('ADMIN_TOKEN', 'test-admin-secret')
    monkeypatch.setenv('INTERNAL_API_SECRET', 'test-internal-secret')
    monkeypatch.setenv('AGENT_API_URL', 'http://agent.test')
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    repo, redis, calls = Repo(), FakeRedis(decode_responses=True), []
    entered, release = asyncio.Event(), asyncio.Event()
    blocked = [False]
    async def upstream(request):
        calls.append(request)
        if request.url.host == 'livekit.test':
            return httpx.Response(200,json={'ready':True,'engine':'livekit-agents'})
        if request.url.path.endswith('/agent'):
            import json
            body=json.loads(request.content)
            if body['operation']=='context':
                return httpx.Response(200,json={'history':[{k:t[k] for k in ('question','answer','created_at_ms')} for t in body['history']], 'available_tools':['search_meeting','search_shared_documents']})
            if body['operation']=='plan':
                return httpx.Response(200,json={'tool_calls':[{'name':'search_meeting','query':'demo'},{'name':'search_shared_documents','query':'demo'}]})
            entered.set()
            if blocked[0]: await release.wait()
            return httpx.Response(200,json={'tool':body['lookup']['name'],'source_count':1,'sources':[{'id':'s0','text':'Supported answer'}]})
        if request.url.path.endswith('/answer'):
            entered.set()
            if blocked[0]: await release.wait()
            return httpx.Response(200, json={'text': 'Supported answer', 'sources': []})
        return httpx.Response(200, json={'documents': ['wiki/shared.md']})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    app = FastAPI()
    app.state.playback = PlaybackStore(redis, repo.save_voice_reply)
    app.include_router(build_voice_router(repo, redis, redis, app.state.playback, client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        yield client, repo, redis, calls, entered, release, blocked
    await redis.aclose()


def headers(session='current'):
    return {'Authorization': 'Bearer ' + voice_token('test-admin-secret', 1, session)}


async def test_project_policy_validates_profile_before_saving_and_requires_a_complete_reference(setup):
    import json
    client,repo,_,calls,*_=setup
    policy=deepcopy(repo.row['data']['voice_assistant'])|{'source_profile_id':'a'*32,'source_profile_fingerprint':'b'*64,
        'documents':['wiki/shared.md']}
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)
    assert response.status_code==200,response.text
    request=next(r for r in calls if r.url.path.endswith('/profile'))
    assert request.method=='POST' and json.loads(request.content)['source_profile_fingerprint']=='b'*64
    assert response.json()['policy']['revision']==2
    policy.pop('source_profile_fingerprint')
    assert (await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)).status_code==422


async def test_project_readiness_rechecks_profile_revocation_even_with_a_cached_ready_verdict(setup):
    client,repo,redis,calls,*_=setup
    repo.row['data']['voice_assistant'].update(source_profile_id='a'*32,source_profile_fingerprint='b'*64)
    await redis.set('meeting:voice:1:current:ready:1','1')
    for _ in range(2):
        response=await client.get('/bots/voice/1/current/config',headers=headers())
        assert response.status_code==200
    assert len([r for r in calls if r.url.host=='agent.test' and r.url.path.endswith('/ready')])==2


def question(): return {'request_id': str(uuid4()), 'question': 'What is the plan?', 'revision': 1}


async def test_whole_wiki_only_policy_is_a_valid_source_and_toggling_revalidates_the_proposed_scope(setup):
    import json
    client,repo,_,calls,*_=setup
    policy=deepcopy(repo.row['data']['voice_assistant'])|{'include_transcript':False,'include_workspace_wiki':True}
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)
    assert response.status_code==200,response.text
    request=next(r for r in calls if r.url.path.endswith('/profile'))
    assert json.loads(request.content)['include_workspace_wiki'] is True
    from meeting_api.lifecycle.voice import VoicePolicy
    assert VoicePolicy.model_validate({'enabled':True}).include_workspace_wiki is False


async def test_retrieval_deadline_is_server_owned_and_unchanged_across_plan_and_lookup(setup):
    import json
    import time
    client,repo,_,calls,*_=setup
    repo.row['data']['voice_assistant']['engine']='livekit'
    body=question();path='/bots/voice/1/current/agent'
    assert (await client.post(path,headers=headers(),json=body|{'operation':'context'})).status_code==200
    assert (await client.post(path,headers=headers(),json=body|{
        'operation':'plan','agent_context':[],'retrieval_deadline_ms':int(time.time()*1000)+999999})).status_code==422
    plan=await client.post(path,headers=headers(),json=body|{'operation':'plan','agent_context':[]})
    assert plan.status_code==200
    deadline=json.loads(calls[-1].content)['retrieval_deadline_ms']
    assert 0<deadline-int(time.time()*1000)<=30000
    lookup=await client.post(path,headers=headers(),json=body|{'operation':'lookup','agent_context':[],
        'lookup':plan.json()['tool_calls'][0]})
    assert lookup.status_code==200 and json.loads(calls[-1].content)['retrieval_deadline_ms']==deadline


async def test_shared_meeting_policy_requires_owned_non_deleted_distinct_sources_and_current_owner(setup):
    client,repo,*_=setup
    original=repo.get_meeting
    shared={'id':2,'user_id':7,'status':'past','data':{}}
    async def get(mid):return deepcopy(shared) if mid==2 else await original(mid)
    repo.get_meeting=get
    policy={'enabled':True,'include_transcript':True,'revision':1,'shared_meeting_ids':[2]}
    path='/meetings/1/voice-assistant'
    assert (await client.put(path,headers={'X-User-Id':'8'},json=policy)).status_code==404
    for ids in [[1],[2,2],[0],[True],['2'],[2,3,4,5,6]]:
        assert (await client.put(path,headers={'X-User-Id':'7'},json=policy|{'shared_meeting_ids':ids})).status_code==422
    shared['user_id']=8
    assert (await client.put(path,headers={'X-User-Id':'7'},json=policy)).status_code==404
    shared['user_id']=7;shared['data']['artifact_deletion']=True
    assert (await client.put(path,headers={'X-User-Id':'7'},json=policy)).status_code==409
    shared['data']={}
    saved=await client.put(path,headers={'X-User-Id':'7'},json=policy)
    assert saved.status_code==200 and saved.json()['policy']['shared_meeting_ids']==[2]
    assert saved.json()['policy']['revision']==2


async def test_calculation_lookup_receives_only_handles_returned_by_this_reserved_turn(setup):
    import json
    _,repo,redis,*_=setup
    repo.row['data']['voice_assistant'].update(engine='livekit',include_approved_actions=True)
    handle='ctx-'+'a'*64;plans=[];calculations=[]
    search={'name':'search_approved_actions','query':'chi phí demo'}
    calculate={'name':'calculate','query':json.dumps({'expression':'100+200','context_handles':[handle]},separators=(',',':'))}
    async def upstream(request):
        body=json.loads(request.content)
        if body['operation']=='context':return httpx.Response(200,json={'history':[]})
        if body['operation']=='plan':
            plans.append(body)
            return httpx.Response(200,json={'tool_calls':[search if len(plans)==1 else calculate]})
        if body['lookup']['name']=='calculate':
            calculations.append(body)
            return httpx.Response(200,json={'tool':'calculate','source_count':1,'sources':[]})
        return httpx.Response(200,json={'tool':'search_approved_actions','source_count':1,'sources':[],
            'context_handles':[handle]})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    app=FastAPI();app.include_router(build_voice_router(repo,redis,redis,client_factory=factory))
    body=question();path='/bots/voice/1/current/agent'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        async def op(operation,**extra):return await client.post(path,headers=headers(),json=body|{'operation':operation}|extra)
        assert (await op('context')).status_code==200
        assert (await op('plan',agent_context=[])).status_code==200
        assert (await op('lookup',agent_context=[],lookup=search)).status_code==200
        assert (await op('plan',agent_context=[])).status_code==200
        assert (await op('lookup',agent_context=[],lookup=calculate)).status_code==200
    assert calculations[0]['context_handles']==[handle]
    assert plans[0]['context_handles']==[] and plans[1]['context_handles']==[handle]


@pytest.mark.parametrize('held',[True,False])
@pytest.mark.parametrize('old_state',['QUIET','THINKING'])
async def test_late_old_turn_state_cannot_overwrite_replacement_status_or_release_its_lease(setup,held,old_state):
    import json
    client,_,redis,*_=setup
    old,new=str(uuid4()),str(uuid4())
    current={'state':'THINKING' if held else 'CAPTURING','request_id':new,'session_uid':'current'}
    await redis.set('meeting:voice:1:state',json.dumps(current))
    if held:await redis.set('meeting:voice:1:lock','current:'+new)
    response=await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':old_state,'request_id':old})
    assert response.status_code==200
    assert json.loads(await redis.get('meeting:voice:1:state'))==current
    if held:assert await redis.get('meeting:voice:1:lock')=='current:'+new
    response=await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'QUIET','request_id':new})
    assert response.status_code==200 and not await redis.get('meeting:voice:1:lock')
    assert json.loads(await redis.get('meeting:voice:1:state'))['state']=='QUIET'


async def test_tool_progress_is_owner_scoped_and_disappears_on_stop_or_request_change(setup):
    client, repo, redis, _, entered, release, blocked = setup
    repo.row['data']['voice_assistant']['engine'] = 'livekit'
    body = question()
    path = '/bots/voice/1/current/agent'
    assert (await client.post(path, headers=headers(), json=body | {'operation':'context'})).status_code == 200
    payload = body | {'agent_context':[]}
    assert (await client.post(path, headers=headers(), json=payload | {'operation':'plan'})).status_code == 200
    await client.post('/bots/voice/1/current/state', headers=headers(), json={'state':'THINKING','request_id':body['request_id']})
    blocked[0] = True
    task = asyncio.create_task(client.post(path, headers=headers(), json=payload | {
        'operation':'lookup','lookup':{'name':'search_shared_documents','query':'demo'}}))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        snapshot = await client.get('/meetings/1/voice-assistant', headers={'X-User-Id':'7'})
        progress = snapshot.json()['runtime']['progress']
        assert progress['stage'] == 'reading_documents' and progress['request_id'] == body['request_id']
        assert set(progress) == {'request_id','session_uid','revision','stage','observed_at_ms'}
        assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id':'8'})).status_code == 404
        await redis.set('meeting:voice:1:lock', 'current:' + str(uuid4()))
        assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id':'7'})).json()['runtime']['progress'] is None
        await redis.set('meeting:voice:1:lock', 'current:' + body['request_id'])
        await client.post('/bots/voice/1/current/state', headers=headers(), json={'state':'QUIET','request_id':body['request_id']})
        assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id':'7'})).json()['runtime']['progress'] is None
    finally:
        release.set()
        response = await task
        assert response.status_code == 409


async def test_answer_service_propagates_bot_request_uuid_and_logs_no_content(setup, caplog):
    import json
    import logging
    client, _, _, calls, *_ = setup
    body = question()
    with caplog.at_level(logging.INFO, logger='meeting_api.lifecycle.voice'):
        response = await client.post('/bots/voice/1/current/answer', json=body, headers=headers())
    assert response.status_code == 200
    request = next(r for r in calls if r.url.path.endswith('/answer'))
    assert request.headers['X-Tina-Voice-Request-Id'] == body['request_id']
    records = [json.loads(r.message) for r in caplog.records if r.name == 'meeting_api.lifecycle.voice']
    assert records == [{'type': 'voice_stage', 'request_id': body['request_id'],
                        'stage': 'answer_service', 'status': 'ok', 'elapsed_ms': records[0]['elapsed_ms']}]
    assert body['question'] not in caplog.text and 'test-internal-secret' not in caplog.text


async def test_summary_permit_requires_internal_owner_and_current_unstopped_reservation(setup):
    client, repo, redis, _, entered, release, blocked = setup
    body = question(); blocked[0] = True
    task = asyncio.create_task(client.post('/bots/voice/1/current/answer', json=body, headers=headers()))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        path = '/internal/meeting-voice/1/turn/' + body['request_id']
        internal = {'X-User-Id': '7', 'X-Internal-Secret': 'test-internal-secret'}
        assert (await client.get(path, headers={'X-User-Id': '7'})).status_code == 401
        assert (await client.get(path, headers={'X-Internal-Secret': 'test-internal-secret'})).status_code == 401
        assert (await client.get(path, headers=internal | {'X-User-Id': '8'})).status_code == 404
        assert (await client.get(path, headers=internal)).json() == {'current': True}
        repo.row['data']['artifact_deletion'] = True
        assert (await client.get(path, headers=internal)).json() == {'current': False}
        repo.row['data'].pop('artifact_deletion')
        original_sessions = repo.list_sessions
        async def replacement(**kwargs): return ['current', 'replacement']
        repo.list_sessions = replacement
        assert (await client.get(path, headers=internal)).json() == {'current': False}
        repo.list_sessions = original_sessions
        assert await redis.ttl('meeting:voice:1:lock') > 330
        assert (await client.get(path.replace(body['request_id'], str(uuid4())), headers=internal)).json() == {'current': False}
        await client.post('/bots/voice/1/current/state', headers=headers(),
                          json={'state': 'QUIET', 'request_id': body['request_id']})
        assert (await client.get(path, headers=internal)).json() == {'current': False}
        release.set()
        assert (await task).status_code == 409
    finally:
        release.set()
        await task


async def test_agents_turn_permit_is_bound_to_capability_revision_and_live_redis_lease(setup):
    client,repo,redis,*_=setup
    repo.row['data']['voice_assistant']['engine']='livekit'
    rid=str(uuid4());path=f'/bots/voice/1/current/turn/{rid}?revision=1'
    await redis.set('meeting:voice:1:lock','current:'+rid,ex=360)
    assert (await client.get(path)).status_code==401
    assert (await client.get(path,headers=headers('different'))).status_code==401
    assert (await client.get(path,headers=headers())).json()=={'current':True}
    assert (await client.get(path.replace('revision=1','revision=2'),headers=headers())).json()=={'current':False}
    await redis.set('meeting:voice:1:lock','current:'+str(uuid4()),ex=360)
    assert (await client.get(path,headers=headers())).json()=={'current':False}
    await redis.delete('meeting:voice:1:lock')
    assert (await client.get(path,headers=headers())).json()=={'current':False}


async def test_a_room_capability_cannot_validate_another_rooms_turn(setup):
    client,repo,redis,*_=setup
    second=deepcopy(repo.row);second['id']=2;second['user_id']=8
    second['data']['voice_assistant']['engine']='livekit'
    get=repo.get_meeting
    async def get_meeting(mid):return deepcopy(second) if mid==2 else await get(mid)
    repo.get_meeting=get_meeting
    rid=str(uuid4());await redis.set('meeting:voice:2:lock','current:'+rid,ex=360)
    path=f'/bots/voice/2/current/turn/{rid}?revision=1'
    assert (await client.get(path,headers=headers())).status_code==401
    correct={'Authorization':'Bearer '+voice_token('test-admin-secret',2,'current')}
    assert (await client.get(path,headers=correct)).json()=={'current':True}
    await redis.delete('meeting:voice:2:lock')
    assert (await client.get(path,headers=correct)).json()=={'current':False}


async def test_kws_runtime_is_capability_scoped_validated_and_readable_only_by_owner(setup):
    import time
    client, _, redis, *_ = setup
    kws={'engine':'livekit-wakeword','version':'2.1.1','mode':'activation','device':'cpu','status':'ready',
         'models':['hey_tina','tina_oi'],'observed_at_ms':int(time.time()*1000)}
    path='/bots/voice/1/current/state'
    assert (await client.post(path,json={'state':'LISTENING','kws':kws})).status_code==401
    assert (await client.post(path,headers=headers(),json={'state':'LISTENING','kws':kws})).status_code==200
    result=await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert result.json()['runtime']['kws']==kws
    assert (await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'8'})).status_code==404
    for change in [{'models':['tina','e_tina']},{'models':['hey_tina','hey_tina']},
                   {'observed_at_ms':kws['observed_at_ms']-20000},{'mode':'observe'},{'token':'must reject'}]:
        assert (await client.post(path,headers=headers(),json={'state':'LISTENING','kws':kws|change})).status_code==422


async def test_capability_is_scoped_to_active_session_and_owner_policy_is_private(setup):
    client, *_ = setup
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '8'})).status_code == 404
    assert (await client.get('/bots/voice/1/current/config')).status_code == 401
    assert (await client.get('/bots/voice/1/old/config', headers=headers('old'))).status_code == 409
    result = await client.get('/bots/voice/1/current/config', headers=headers())
    assert result.json() == {'enabled': True, 'ready': True, 'revision': 1, 'wake_variants': [], 'noise_suppression':False, 'unavailable_reason': None,'engine':'tina','agent_url':None}


async def test_source_selection_is_explicit_and_policy_save_uses_revision(setup):
    client, *_ = setup
    policy = {'enabled': True, 'include_transcript': False, 'documents': [], 'revision': 1}
    path = '/meetings/1/voice-assistant'
    assert (await client.put(path, json=policy, headers={'X-User-Id': '7'})).status_code == 422
    policy['documents'] = ['wiki/private.md']
    assert (await client.put(path, json=policy, headers={'X-User-Id': '7'})).status_code == 422
    policy['documents'] = ['wiki/shared.md']
    response = await client.put(path, json=policy, headers={'X-User-Id': '7'})
    assert response.status_code == 200 and response.json()['policy']['revision'] == 2
    assert (await client.put(path, json=policy, headers={'X-User-Id': '7'})).status_code == 409


async def test_ns_trial_is_opt_in_and_does_not_require_or_grant_room_sharing(setup):
    client,*_=setup
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json={
        'enabled':False,'include_transcript':False,'documents':[],'revision':1,'noise_suppression':True})
    assert response.status_code==200 and response.json()['policy']['noise_suppression']
    assert not response.json()['policy']['enabled']
    config=await client.get('/bots/voice/1/current/config',headers=headers())
    assert config.json()['noise_suppression'] and not config.json()['enabled']


async def test_voice_request_is_idempotent_and_cannot_substitute_sources(setup):
    client, repo, redis, calls, *_ = setup
    body = question(); path = '/bots/voice/1/current/answer'
    assert (await client.post(path, json=body | {'documents': ['wiki/private.md']}, headers=headers())).status_code == 422
    first = await client.post(path, json=body, headers=headers())
    assert first.status_code == 200, first.text
    assert (await client.post(path, json=body, headers=headers())).status_code == 409
    assert len([r for r in calls if r.url.path.endswith('/answer')]) == 1
    assert (await client.post(path, json=body | {'question': 'changed'}, headers=headers())).status_code == 409


async def test_stop_during_thought_discards_late_answer_and_blocks_competing_turn(setup):
    client, repo, redis, calls, entered, release, blocked = setup
    blocked[0] = True
    body = question(); path = '/bots/voice/1/current/answer'
    task = asyncio.create_task(client.post(path, json=body, headers=headers()))
    await entered.wait()
    assert (await client.post(path, json=question(), headers=headers())).status_code == 409
    stopped = await client.post('/bots/voice/1/current/state', json={'state': 'QUIET', 'request_id': body['request_id']}, headers=headers())
    assert stopped.status_code == 200
    release.set()
    assert (await task).status_code == 409


async def test_source_revocation_during_thought_prevents_speech(setup):
    client, repo, redis, calls, entered, release, blocked = setup
    blocked[0] = True
    task = asyncio.create_task(client.post('/bots/voice/1/current/answer', json=question(), headers=headers()))
    await entered.wait()
    repo.row['data']['voice_assistant']['revision'] = 2
    release.set()
    assert (await task).status_code == 409


async def test_voice_reply_history_survives_redis_and_tracks_receipts_without_changing_transcript(setup):
    client, repo, redis, *_ = setup
    repo.row['data']['transcript'] = ['original ASR']
    body = question()
    response = await client.post('/bots/voice/1/current/answer', json=body, headers=headers())
    assert response.status_code == 200
    async def history():
        response = await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})
        return response.json()['replies']
    assert (await history())[0]['text'] == 'Supported answer'
    assert (await history())[0]['state'] == 'queued'
    store = PlaybackStore(redis, repo.save_voice_reply)
    await store.report(1, body['request_id'], 'current', 'started')
    assert (await history())[0]['state'] == 'started'
    await store.report(1, body['request_id'], 'current', 'stopped')
    await store.report(1, body['request_id'], 'current', 'completed')
    await redis.flushall()
    assert (await client.post('/bots/voice/1/current/answer', json=body, headers=headers())).status_code == 409
    repo.row['status'] = 'completed'
    replies = await history()
    assert len(replies) == 1 and replies[0]['state'] == 'stopped'
    assert replies[0]['started_at_ms'] is not None and replies[0]['ended_at_ms'] is not None
    assert 'session_uid' not in replies[0] and 'question' not in replies[0]
    assert repo.row['data']['transcript'] == ['original ASR']
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '8'})).status_code == 404


async def test_departed_bot_does_not_make_a_queued_reply_look_spoken(setup):
    client, repo, *_ = setup
    await client.post('/bots/voice/1/current/answer', json=question(), headers=headers())
    repo.row['status'] = 'completed'
    result = await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})
    assert result.json()['replies'][0]['state'] == 'unconfirmed'


def test_voice_reply_merge_is_monotonic_and_hidden_from_transcript_shares():
    from meeting_api.lifecycle.voice_replies import merge_reply, public_replies
    from meeting_api.collector.projection import project_response_data
    reply = {'request_id': str(uuid4()), 'text': 'Approved answer', 'state': 'completed', 'created_at_ms': 1, 'updated_at_ms': 2}
    data = merge_reply({'title': 'Preserved', 'transcript_edits': {'raw': True}}, 'current', reply)
    assert merge_reply(data, 'current', reply | {'state': 'started'}) == data
    with pytest.raises(ValueError): merge_reply(data, 'other', reply)
    with pytest.raises(ValueError): merge_reply(data, 'current', reply | {'text': 'replacement'})
    with pytest.raises(ValueError): merge_reply({'artifact_deletion': {'state': 'completed'}}, 'current', reply)
    assert 'voice_replies' not in project_response_data(data, viewer_is_owner=False)
    assert 'voice_replies' not in project_response_data(data, viewer_is_owner=True)
    assert data['transcript_edits'] == {'raw': True}
    pending = merge_reply({}, 'current', reply | {'state': 'started'})
    assert public_replies({'data': pending}, 'current', False)[0]['state'] == 'unconfirmed'


async def test_receipt_retry_repairs_durable_history_after_the_redis_transition_commits():
    redis = FakeRedis(decode_responses=True)
    calls = []
    async def save(mid, session, reply):
        calls.append(reply)
        if len(calls) == 1: raise RuntimeError('temporary storage failure')
    store = PlaybackStore(redis, save)
    reply = {'request_id': str(uuid4()), 'text': 'Validated answer', 'state': 'queued', 'created_at_ms': 1, 'updated_at_ms': 1}
    try:
        with pytest.raises(RuntimeError):
            await store.begin(1, reply['request_id'], 'current', reply['text'], 'auto', reply=reply)
        _, created = await store.begin(1, reply['request_id'], 'current', reply['text'], 'auto', reply=reply)
        assert not created and len(calls) == 2
        await store.report(1, reply['request_id'], 'current', 'started')
        assert calls[-1]['state'] == 'started' and calls[-1]['started_at_ms'] is not None
    finally:
        await redis.aclose()


async def test_stop_releases_both_reservations_even_if_voice_history_storage_fails(setup, monkeypatch):
    client, repo, redis, *_ = setup
    failed = [False]
    # The fixture bound the original method; use the same store callback with a failing repository write.
    from meeting_api.lifecycle.voice_replies import merge_reply
    def save(data, session, reply):
        if failed[0]: raise RuntimeError('synthetic storage outage')
        return merge_reply(data, session, reply)
    monkeypatch.setattr('meeting_api.lifecycle.voice_replies.merge_reply', save)
    body = question()
    assert (await client.post('/bots/voice/1/current/answer', json=body, headers=headers())).status_code == 200
    failed[0] = True
    response = await client.post('/bots/voice/1/current/state', json={'state':'QUIET','request_id':body['request_id']}, headers=headers())
    assert response.status_code == 200
    assert await redis.get('meeting:voice:1:lock') is None
    assert await redis.get('speech:active:1') is None
    assert (await PlaybackStore(redis).get(1, body['request_id']))['state'] == 'stopped'
    failed[0] = False
    await PlaybackStore(redis, repo.save_voice_reply).report(1, body['request_id'], 'current', 'stopped')
    assert repo.row['data']['voice_replies'][body['request_id']]['state'] == 'stopped'
    assert (await client.post('/bots/voice/1/current/answer', json=question(), headers=headers())).status_code == 200


async def test_readiness_polling_does_not_reload_knowledge_every_two_seconds(setup):
    client, repo, redis, calls, *_ = setup
    for _ in range(3):
        response = await client.get('/bots/voice/1/current/config', headers=headers())
        assert response.json()['ready'] is True
    assert len([r for r in calls if r.url.path.endswith('/ready')]) == 2  # One Agent probe and one TTS probe.


async def test_spawn_default_signing_key_and_tts_token_reach_new_bot(monkeypatch):
    from meeting_api.bot_spawn import service
    from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo, FakeRuntimeClient
    async def context(user): return {}
    monkeypatch.setattr(service, '_fetch_bot_context', context)
    monkeypatch.setenv('ADMIN_TOKEN', 'test-admin-signing-secret')
    monkeypatch.setenv('TTS_API_TOKEN', 'test-tts-' + 'x' * 40)
    monkeypatch.setenv('TTS_SERVICE_URL', 'http://tts.test')
    monkeypatch.setenv('TINA_MEETING_VOICE', '1')
    monkeypatch.setenv('BOT_AUTHENTICATED', '0')
    runtime = FakeRuntimeClient()
    await service.request_bot(InMemoryMeetingRepo(), runtime, user_id=7, platform='google_meet',
        native_meeting_id='synthetic-token-proof', transcribe_enabled=False, voice_agent_enabled=True)
    env = runtime.specs[0]['env']
    assert env['TTS_API_TOKEN'] == 'test-tts-' + 'x' * 40
    assert env['TTS_SERVICE_URL'] == 'http://tts.test'
    assert len(env['TINA_VOICE_TOKEN']) == 64 and '/bots/voice/' in env['TINA_VOICE_URL']


async def test_owner_must_explicitly_approve_name_variants_and_hey_prefix_is_refused(setup):
    client, *_ = setup
    path = '/meetings/1/voice-assistant'
    base = {'enabled': True, 'include_transcript': True, 'documents': [], 'revision': 1}
    assert (await client.put(path, json=base | {'wake_variants': ['Hey Tina']}, headers={'X-User-Id': '7'})).status_code == 422
    approved = await client.put(path, json=base | {'wake_variants': ['Ti Na', 'TI NA', 'ti na ơi']}, headers={'X-User-Id': '7'})
    assert approved.status_code == 200
    assert approved.json()['policy']['wake_variants'] == ['ti na', 'ti na ơi']


async def test_anh_oi_is_refused_but_owner_requested_tin_oi_is_accepted(setup):
    client, *_ = setup
    for alias in ['Anh ơi']:
        response = await client.put('/meetings/1/voice-assistant', headers={'X-User-Id': '7'}, json={
            'enabled': True, 'include_transcript': True, 'documents': [], 'revision': 1, 'wake_variants': [alias]})
        assert response.status_code == 422
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json={
        'enabled':True,'include_transcript':True,'documents':[],'revision':1,'wake_variants':['Tin ơi']})
    assert response.status_code==200 and response.json()['policy']['wake_variants']==['tin ơi']


def diagnostic(code='name_not_matched', **changes):
    import time
    return {'event_id': str(uuid4()), 'code': code, 'observed_at_ms': int(time.time() * 1000),
            'heard_prefix': 'tiên na ơi', 'channel': 0, **changes}


async def test_audio_numbers_are_owner_and_session_scoped_bounded_and_expire(setup):
    import time
    client, repo, redis, *_ = setup
    now = int(time.time() * 1000)
    row = {'channel':0,'frames':5,'samples':5120,'last_frame_ms':now,'rms':.05,'sample_clock':True,
           'gap_samples':1024,'overlap_samples':0,'clock_resets':0,'asr_inflight':0,'asr_errors':0,'queue_ms':12.5}
    body = {'state':'LISTENING','audio':{'observed_at_ms':now,'channels':[row]}}
    path = '/bots/voice/1/current/state'
    assert (await client.post(path,json=body,headers=headers())).status_code == 200
    result = await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert result.json()['runtime']['audio']['channels'][0]['queue_ms'] == 12.5
    assert await redis.ttl('meeting:voice:1:state') <= 15
    assert (await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'8'})).status_code == 404
    for changes in [{'text':'private'}, {'rms':2}, {'queue_ms':-1}, {'frames':True}]:
        bad = body | {'audio':body['audio'] | {'channels':[row | changes]}}
        assert (await client.post(path,json=bad,headers=headers())).status_code == 422
    assert (await client.post(path,json=body | {'audio':{'observed_at_ms':now,'channels':[row,row]}},headers=headers())).status_code == 422
    assert (await client.post(path,json=body | {'audio':{'observed_at_ms':now+6000,'channels':[row]}},headers=headers())).status_code == 422
    old = body | {'audio':{'observed_at_ms':now-16000,'channels':[row | {'last_frame_ms':now-16000}]}}
    assert (await client.post(path,json=old,headers=headers())).status_code == 200
    result=await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert not result.json()['runtime'].get('audio')
    repo.row['status']='completed'
    assert not (await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})).json()['runtime'].get('audio')


async def test_diagnostics_are_owner_only_ephemeral_and_do_not_change_meeting_or_transcript(setup):
    import json
    client, repo, redis, *_ = setup
    before = deepcopy(repo.row)
    detail = diagnostic(heard_prefix='tiên na ơi SECRET')
    r = await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING', 'diagnostic': detail})
    assert r.status_code == 200
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '8'})).status_code == 404
    current = (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})).json()['runtime']
    assert current['diagnostic']['heard_prefix'] == 'tiên na ơi'
    assert current['diagnostic']['code'] == 'name_not_matched'
    assert current['session_active'] and current['heartbeat_fresh']
    assert 0 < await redis.pttl('meeting:voice:1:diagnostic') <= 30000
    state = await redis.get('meeting:voice:1:state')
    assert 'heard_prefix' not in state and 'SECRET' not in state
    assert repo.row == before
    await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING'})
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})).json()['runtime']['diagnostic']['event_id'] == detail['event_id']
    await redis.delete('meeting:voice:1:diagnostic')
    assert (await client.get('/meetings/1/voice-assistant', headers={'X-User-Id': '7'})).json()['runtime']['diagnostic'] is None


async def test_diagnostic_heartbeat_or_retry_cannot_extend_original_text_expiry(setup):
    import time
    client, repo, redis, *_ = setup
    detail = diagnostic(observed_at_ms=int(time.time() * 1000) - 10000)
    for _ in range(2):
        assert (await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING', 'diagnostic': detail})).status_code == 200
    assert 0 < await redis.pttl('meeting:voice:1:diagnostic') <= 20000
    expired = diagnostic(observed_at_ms=int(time.time() * 1000) - 31000)
    await redis.delete('meeting:voice:1:diagnostic')
    await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'LISTENING', 'diagnostic': expired})
    assert not await redis.exists('meeting:voice:1:diagnostic')


async def test_old_session_and_departed_meeting_cannot_expose_or_write_diagnostics(setup):
    import json,time
    client, repo, redis, *_ = setup
    await redis.set('meeting:voice:1:diagnostic', json.dumps(diagnostic() | {'session_uid': 'old', 'expires_at_ms': int(time.time()*1000)+30000}))
    owner={'X-User-Id':'7'}
    assert (await client.get('/meetings/1/voice-assistant', headers=owner)).json()['runtime']['diagnostic'] is None
    assert (await client.post('/bots/voice/1/old/state', headers=headers('old'), json={'state':'LISTENING','diagnostic':diagnostic()})).status_code == 409
    repo.row['status']='completed'
    assert (await client.get('/meetings/1/voice-assistant', headers=owner)).json()['runtime']['diagnostic'] is None
    assert (await client.post('/bots/voice/1/current/state', headers=headers(), json={'state':'LISTENING','diagnostic':diagnostic()})).status_code == 409


async def test_diagnostic_boundary_rejects_unknown_codes_and_unbounded_text(setup):
    client,*_=setup
    for detail in [diagnostic(code='untrusted message'), diagnostic(heard_prefix='x'*65), diagnostic(channel=-1)]:
        assert (await client.post('/bots/voice/1/current/state', headers=headers(), json={'state':'LISTENING','diagnostic':detail})).status_code == 422


@pytest.mark.parametrize('failed_host,reason', [('agent.test','sources_unavailable'),('tts.test','tts_unavailable')])
async def test_readiness_diagnostics_separate_tts_from_source_failure(setup, failed_host, reason):
    client,repo,redis,*_=setup
    async def upstream(request):
        return httpx.Response(503 if request.url.host==failed_host else 200,json={'documents':[]})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    app=FastAPI();app.include_router(build_voice_router(repo,redis,redis,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as scoped:
        value=(await scoped.get('/bots/voice/1/current/config',headers=headers())).json()
        assert value['ready'] is False and value['unavailable_reason']==reason


async def test_new_diagnostics_win_over_delayed_old_events_and_stage_changes_do_not_refresh_prefix(setup):
    import time
    client,repo,redis,*_=setup
    now=int(time.time()*1000)
    latest=diagnostic(code='waiting_asr_tail',observed_at_ms=now,heard_at_ms=now-10000)
    await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'CAPTURING','diagnostic':latest})
    assert 0<await redis.pttl('meeting:voice:1:diagnostic')<=20000
    old=diagnostic(observed_at_ms=now-20000)
    await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'LISTENING','diagnostic':old})
    value=(await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})).json()['runtime']['diagnostic']
    assert value['event_id']==latest['event_id'] and value['code']=='waiting_asr_tail'


@pytest.mark.parametrize('livekit',[False,True])
async def test_conversation_history_requires_completed_playback_and_same_speaker_session_policy(setup,livekit):
    import json
    client, repo, redis, *_ = setup
    seen = []
    if livekit: repo.row['data']['voice_assistant']['engine']='livekit'
    async def upstream(request):
        seen.append(json.loads(request.content))
        payload=seen[-1]
        if payload.get('operation')=='context':
            return httpx.Response(200,json={'history':[{k:t[k] for k in ('question','answer','created_at_ms')} for t in payload['history']]})
        if payload.get('operation')=='plan':return httpx.Response(200,json={'tool_calls':[]})
        return httpx.Response(200, json={'text': 'Demo is Monday.',
                              'sources': [{'key': 'segment:demo', 'fingerprint': 'a' * 64}]})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    store = PlaybackStore(redis, repo.save_voice_reply)
    app = FastAPI(); app.include_router(build_voice_router(repo, redis, redis, store, client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as scoped:
        async def ask(speaker, revision=1):
            body = question() | {'revision': revision}
            h = headers() | ({'X-Voice-Speaker-Key': speaker} if speaker else {})
            if livekit:
                context=await scoped.post('/bots/voice/1/current/agent',headers=h,json=body|{'operation':'context'})
                assert context.status_code==200,context.text
                body['agent_context']=context.json()['history']
                assert (await scoped.post('/bots/voice/1/current/agent',headers=h,json=body|{'operation':'plan'})).status_code==200
            r = await scoped.post('/bots/voice/1/current/answer', headers=h, json=body)
            assert r.status_code == 200, r.text
            return body
        async def finish(body, completed):
            if completed:
                await store.report(1, body['request_id'], 'current', 'started')
                await store.report(1, body['request_id'], 'current', 'completed')
            await scoped.post('/bots/voice/1/current/state', headers=headers(),
                              json={'state': 'QUIET', 'request_id': body['request_id']})
        first = await ask('a' * 64); assert seen[-1]['history'] == []
        await finish(first, False)
        second = await ask('a' * 64); assert seen[-1]['history'] == []
        await finish(second, True)
        third = await ask('a' * 64)
        assert len(seen[-1]['history']) == 1
        assert seen[-1]['history'][0]['answer'] == 'Demo is Monday.'
        await finish(third, True)
        other = await ask('b' * 64); assert not seen[-1]['history']; await finish(other, True)
        legacy = await ask(None); assert not seen[-1]['history']; await finish(legacy, True)
        repo.row['data']['voice_assistant']['revision'] = 2
        changed = await ask('a' * 64, 2); assert not seen[-1]['history']; await finish(changed, True)
        assert await redis.ttl('meeting:voice:1:current:history:1:' + 'a' * 64) <= 900
        bad = await scoped.post('/bots/voice/1/current/answer', headers=headers() | {'X-Voice-Speaker-Key': 'display name'}, json=question())
        assert bad.status_code == 422


@pytest.mark.parametrize('livekit', [False, True])
@pytest.mark.parametrize('unheard_state', ['failed', 'stopped'])
async def test_unheard_answers_cannot_evict_the_three_last_heard_turns(setup, livekit, unheard_state):
    import json
    _, repo, redis, *_ = setup
    if livekit: repo.row['data']['voice_assistant']['engine'] = 'livekit'
    seen = []
    async def upstream(request):
        body = json.loads(request.content)
        if body.get('operation') == 'context':
            return httpx.Response(200,json={'history':[{k:t[k] for k in ('question','answer','created_at_ms')} for t in body['history']]})
        if body.get('operation') == 'plan': return httpx.Response(200,json={'tool_calls':[]})
        seen.append(body['history'])
        return httpx.Response(200,json={'text':'Lan owns demo.',
            'sources':[{'key':'segment:demo','fingerprint':'a'*64}]})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    store = PlaybackStore(redis,repo.save_voice_reply)
    app = FastAPI();app.include_router(build_voice_router(repo,redis,redis,store,client_factory=factory))
    h = headers() | {'X-Voice-Speaker-Key':'a'*64};base = '/bots/voice/1/current'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        heard = []
        for index in range(8):
            body = question() | {'question':f'Demo owner question {index}?'}
            if livekit:
                context = await client.post(base+'/agent',headers=h,json=body|{'operation':'context'})
                assert context.status_code == 200,context.text
                body['agent_context'] = context.json()['history']
                plan = await client.post(base+'/agent',headers=h,json=body|{'operation':'plan'})
                assert plan.status_code == 200,plan.text
            answer = await client.post(base+'/answer',headers=h,json=body)
            assert answer.status_code == 200,answer.text
            assert [t['question'] for t in seen[-1]] == heard[-3:]
            cached = json.loads(await redis.get('meeting:voice:1:current:history:1:'+'a'*64))
            assert len(cached) <= 4
            if index < 4:
                await store.report(1,body['request_id'],'current','started')
                await store.report(1,body['request_id'],'current','completed')
                heard.append(body['question'])
            else: await store.report(1,body['request_id'],'current',unheard_state)
            await client.post(base+'/state',headers=h,json={'state':'QUIET','request_id':body['request_id']})


@pytest.mark.parametrize('refs', [[], [{'key': 'segment:demo', 'fingerprint': 'a' * 64}]])
@pytest.mark.parametrize('follow_up', [False, True])
async def test_completed_clarification_is_context_only_and_internal_refs_are_not_returned(setup, refs, follow_up):
    import json
    _, repo, redis, *_ = setup
    seen = []
    async def upstream(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={'text': 'Bạn hỏi bản demo hay bản chính thức?', 'sources': [],
            'clarification': not follow_up, 'context_refs': refs,
            **({'follow_up': 'Bạn hỏi bản demo hay bản chính thức?'} if follow_up else {})})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    store = PlaybackStore(redis, repo.save_voice_reply)
    app = FastAPI(); app.include_router(build_voice_router(repo, redis, redis, store, client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        h = headers() | {'X-Voice-Speaker-Key': 'a' * 64}
        body = question()
        r = await client.post('/bots/voice/1/current/answer', headers=h, json=body)
        assert r.status_code == 200 and r.json()['clarification'] is not follow_up
        assert 'context_refs' not in r.json() and not r.json()['evidence_available']
        history_key='meeting:voice:1:current:history:1:'+'a'*64
        stored=json.loads(await redis.get(history_key));stored[-1]['created_at_ms']-=60000
        await redis.set(history_key,json.dumps(stored))
        await store.report(1, body['request_id'], 'current', 'started')
        await store.report(1, body['request_id'], 'current', 'completed')
        await client.post('/bots/voice/1/current/state', headers=headers(), json={'state': 'QUIET', 'request_id': body['request_id']})
        r = await client.post('/bots/voice/1/current/answer', headers=h, json=question())
        assert r.status_code == 200 and seen[-1]['history'][0]['answer'].endswith('?')
        assert seen[-1]['history'][0]['clarification'] is not follow_up
        assert bool(seen[-1]['history'][0].get('follow_up')) is follow_up
        assert seen[-1]['history'][0]['created_at_ms']==repo.row['data']['voice_replies'][body['request_id']]['ended_at_ms']


async def test_interrupted_history_keeps_only_monotonic_completed_sentences_and_session_source_scope(setup):
    import json
    _,repo,redis,*_=setup;seen=[]
    async def upstream(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200,json={'text':'Lan phụ trách demo. Hạn thứ Sáu.',
            'follow_up':'Bạn cần phần backend?',
            'sources':[{'key':'segment:demo','fingerprint':'a'*64}]})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    store=PlaybackStore(redis,repo.save_voice_reply);app=FastAPI()
    app.include_router(build_voice_router(repo,redis,redis,store,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        h=headers()|{'X-Voice-Speaker-Key':'a'*64};body=question();identifier=body['request_id']
        assert (await client.post('/bots/voice/1/current/answer',headers=h,json=body)).status_code==200
        await store.report(1,identifier,'current','started')
        await store.report(1,identifier,'current','started',played_text='Lan phụ trách demo.')
        from meeting_api.lifecycle.speech_status import SpeechConflict
        for text in ['invented','Lan']:
            with pytest.raises(SpeechConflict):await store.report(1,identifier,'current','started',played_text=text)
        await store.report(1,identifier,'current','stopped',played_text='Lan phụ trách demo.')
        await store.report(1,identifier,'current','completed')
        await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'QUIET','request_id':identifier})
        reply=repo.row['data']['voice_replies'][identifier]
        assert reply['state']=='stopped' and reply['played_text']=='Lan phụ trách demo.'
        assert reply['text']=='Lan phụ trách demo. Hạn thứ Sáu.','preserve the generated proposal separately'
        assert (await client.post('/bots/voice/1/current/answer',headers=h,json=question())).status_code==200
        history=seen[-1]['history'];assert len(history)==1 and history[0]['answer']=='Lan phụ trách demo.'
        assert 'Hạn thứ Sáu' not in json.dumps(history) and history[0]['clarification'] is False
        assert history[0]['follow_up'] is None, 'an interrupted prompt must not arm a pending reply'


async def test_public_answer_options_are_owner_scoped_opt_in_and_revision_bound(setup):
    client, repo, redis, *_ = setup
    policy={'enabled':True,'include_transcript':False,'documents':[],'revision':1,
            'allow_general_knowledge':True,'allow_web_search':True}
    assert (await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'8'},json=policy)).status_code==404
    response=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)
    assert response.status_code==200 and response.json()['policy']['allow_web_search']
    assert response.json()['policy']['revision']==2
    from meeting_api.lifecycle.voice import VoicePolicy
    assert not VoicePolicy().allow_web_search and not VoicePolicy().allow_general_knowledge


def test_public_answer_metadata_is_validated_and_survives_playback_projection():
    from meeting_api.lifecycle.voice_replies import VoiceReply, merge_reply, public_replies
    reply=VoiceReply(request_id=uuid4(),text='Public reply.',state='completed',created_at_ms=1,updated_at_ms=2,
                     answer_kind='web',links=[{'url':'https://redis.io/docs/','title':'Redis'}],
                     lookups=[{'tool':'search_meeting','source_count':2}]).model_dump(mode='json')
    row={'data':merge_reply({},'current',reply)}
    assert public_replies(row,'current')[0]['links']==reply['links']
    for url in ['javascript:alert(1)','https://user:pass@example.com','file:///tmp/secret']:
        with pytest.raises(ValueError): VoiceReply.model_validate(reply|{'links':[{'url':url,'title':'bad'}]})


async def test_livekit_pilot_is_explicit_and_unavailable_does_not_claim_ready(setup,monkeypatch):
    client,repo,redis,*_=setup
    policy={'enabled':True,'include_transcript':True,'documents':[],'revision':1,'engine':'livekit'}
    assert (await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)).status_code==503
    monkeypatch.setenv('LIVEKIT_AGENT_URL','http://pilot.test')
    result=await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=policy)
    assert result.status_code==200 and result.json()['policy']['engine']=='livekit'
    config=(await client.get('/bots/voice/1/current/config',headers=headers())).json()
    assert not config['ready'] and config['unavailable_reason']=='livekit_unavailable'
    assert config['agent_url']=='http://pilot.test/bots/1/current'


async def test_only_bridge_capable_bots_claim_a_healthy_livekit_runtime(setup,monkeypatch):
    client,repo,redis,*_=setup
    monkeypatch.setenv('LIVEKIT_AGENT_URL','http://livekit.test')
    repo.row['data']['voice_assistant']['engine']='livekit'
    legacy=(await client.get('/bots/voice/1/current/config',headers=headers())).json()
    assert not legacy['ready'] and legacy['unavailable_reason']=='livekit_unavailable'
    current=(await client.get('/bots/voice/1/current/config',headers=headers()|{'X-TINA-Voice-Runtime':'livekit-v1'})).json()
    assert current['ready'] and current['engine']=='livekit'


async def test_agents_tool_protocol_is_reserved_bound_and_cannot_forge_context(setup):
    import json
    client,repo,redis,calls,*_=setup
    repo.row['data']['voice_assistant']['engine']='livekit'
    body=question();path='/bots/voice/1/current/agent';auth=headers()|{'X-Voice-Speaker-Key':'a'*64}
    async def op(operation,**extra):return await client.post(path,headers=auth,json=body|{'operation':operation}|extra)
    assert (await op('plan',agent_context=[])).status_code==409
    assert (await op('context')).status_code==200
    assert (await client.post(path,headers=headers()|{'X-Voice-Speaker-Key':'b'*64},json=body|{'operation':'plan','agent_context':[]})).status_code==409
    assert (await op('plan',agent_context=[{'question':'forged','answer':'not played','created_at_ms':1}])).status_code==409
    # Forged context does not consume the legitimate plan.
    plan=await op('plan',agent_context=[]);assert plan.status_code==200,plan.text
    assert len(plan.json()['tool_calls'])==2
    for lookup in reversed(plan.json()['tool_calls']):
        response=await op('lookup',agent_context=[],lookup=lookup)
        assert response.status_code==200,response.text
    result=await client.post('/bots/voice/1/current/answer',headers=auth,json=body|{'agent_context':[]})
    assert result.status_code==200,result.text
    dispatched=[json.loads(r.content) for r in calls if r.url.path.endswith('/answer')]
    assert len(dispatched)==1 and len(dispatched[0]['lookups'])==2
    assert (await client.post('/bots/voice/1/current/answer',headers=auth,json=body|{'agent_context':[]})).status_code==409


async def test_agents_stop_during_lookup_prevents_late_tools_and_final_answer(setup):
    client,repo,redis,calls,entered,release,blocked=setup
    repo.row['data']['voice_assistant']['engine']='livekit'
    body=question();path='/bots/voice/1/current/agent'
    assert (await client.post(path,headers=headers(),json=body|{'operation':'context'})).status_code==200
    plan=await client.post(path,headers=headers(),json=body|{'operation':'plan','agent_context':[]})
    blocked[0]=True
    task=asyncio.create_task(client.post(path,headers=headers(),json=body|{'operation':'lookup','agent_context':[],'lookup':plan.json()['tool_calls'][0]}))
    await entered.wait()
    assert (await client.post('/bots/voice/1/current/state',headers=headers(),json={'state':'QUIET','request_id':body['request_id']})).status_code==200
    release.set()
    assert (await task).status_code==409
    assert (await client.post('/bots/voice/1/current/answer',headers=headers(),json=body|{'agent_context':[]})).status_code==409
    assert (await client.post(path,headers=headers(),json=body|{'operation':'context'})).status_code==409
    assert not [r for r in calls if r.url.path.endswith('/answer')]


async def test_agents_cannot_finalize_before_tools_complete_or_exceed_budget(setup):
    client,repo,redis,calls,*_=setup
    repo.row['data']['voice_assistant']['engine']='livekit'
    body=question();path='/bots/voice/1/current/agent'
    assert (await client.post(path,headers=headers(),json=body|{'operation':'context'})).status_code==200
    plan=await client.post(path,headers=headers(),json=body|{'operation':'plan','agent_context':[]})
    lookup=plan.json()['tool_calls'][0]
    assert (await client.post(path,headers=headers(),json=body|{'operation':'lookup','agent_context':[],'lookup':lookup})).status_code==200
    # Duplicate calls invalidate the turn instead of repeating retrieval.
    assert (await client.post(path,headers=headers(),json=body|{'operation':'lookup','agent_context':[],'lookup':lookup})).status_code==409
    assert (await client.post('/bots/voice/1/current/answer',headers=headers(),json=body|{'agent_context':[]})).status_code==409


async def test_concurrent_agents_tools_retry_redis_contention_without_losing_completion(setup,monkeypatch):
    from redis.exceptions import WatchError
    client,repo,redis,calls,*_=setup
    repo.row['data']['voice_assistant']['engine']='livekit'
    body=question();path='/bots/voice/1/current/agent'
    assert (await client.post(path,headers=headers(),json=body|{'operation':'context'})).status_code==200
    plan=await client.post(path,headers=headers(),json=body|{'operation':'plan','agent_context':[]})
    pipeline_type=type(redis.pipeline());original=pipeline_type.execute;conflicts=[0]
    async def execute(pipe,*args,**kwargs):
        commands=pipe.command_stack
        if conflicts[0]<2 and any(str(args[0]).upper()=='SET' and str(args[1]).endswith(':agent') for args,_ in commands):
            conflicts[0]+=1
            raise WatchError('Synthetic concurrent reservation change')
        return await original(pipe,*args,**kwargs)
    monkeypatch.setattr(pipeline_type,'execute',execute)
    results=await asyncio.gather(*(client.post(path,headers=headers(),json=body|{'operation':'lookup','agent_context':[],'lookup':lookup}) for lookup in plan.json()['tool_calls']))
    assert conflicts[0]==2
    assert all(r.status_code==200 for r in results),[r.text for r in results]
    assert (await client.post('/bots/voice/1/current/answer',headers=headers(),json=body|{'agent_context':[]})).status_code==200


@pytest.mark.parametrize('change', ['none', 'stop', 'policy'])
async def test_parallel_lookup_completion_preserves_plan_order_budget_and_revocation(setup, change):
    import json
    _, repo, redis, *_ = setup
    repo.row['data']['voice_assistant'].update(engine='livekit', documents=['wiki/shared.md'])
    calls = [{'name': 'search_meeting', 'query': 'demo'}, {'name': 'search_shared_documents', 'query': 'demo'}]
    started, finished = set(), set()
    both = asyncio.Event()
    gates = {c['name']: asyncio.Event() for c in calls}
    plans = []
    async def upstream(request):
        body = json.loads(request.content)
        if body['operation'] == 'context': return httpx.Response(200, json={'history': []})
        if body['operation'] == 'plan':
            plans.append(body)
            return httpx.Response(200, json={'tool_calls': calls if len(plans) == 1 else []})
        name = body['lookup']['name']; started.add(name)
        if len(started) == 2: both.set()
        await gates[name].wait(); finished.add(name)
        return httpx.Response(200, json={'tool': name, 'source_count': 1, 'sources': [],
            'context_handles': ['ctx-' + ('a' if name == 'search_meeting' else 'b') * 64]})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    app = FastAPI(); app.include_router(build_voice_router(repo, redis, redis, client_factory=factory))
    body = question(); path = '/bots/voice/1/current/agent'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        async def op(operation, **extra):
            return await client.post(path, headers=headers(), json=body | {'operation': operation, 'agent_context': []} | extra)
        assert (await client.post(path, headers=headers(), json=body | {'operation': 'context'})).status_code == 200
        assert (await op('plan')).status_code == 200
        tasks = [asyncio.create_task(op('lookup', lookup=c)) for c in calls]
        try:
            await asyncio.wait_for(both.wait(), 2)
            key = f'meeting:voice:1:current:{body["request_id"]}:agent'
            saved = json.loads(await redis.get(key))
            assert len(saved['lookups']) == 2 and saved['plan_round'] == 1
            assert not saved['executed'] and not saved['completed']
            if change == 'stop':
                assert (await client.post('/bots/voice/1/current/state', headers=headers(),
                    json={'state': 'QUIET', 'request_id': body['request_id']})).status_code == 200
            elif change == 'policy': repo.row['data']['voice_assistant']['revision'] = 2
            gates['search_shared_documents'].set()
            document = await asyncio.wait_for(tasks[1], 2)
            gates['search_meeting'].set()
            transcript = await asyncio.wait_for(tasks[0], 2)
            assert finished == started
            if change == 'none':
                assert document.status_code == transcript.status_code == 200
                saved = json.loads(await redis.get(key))
                assert saved['completed'] == saved['executed'] == saved['planned'] == calls
                assert len(saved['lookups']) == 2 and len(saved['context_handles']) == 2
                assert (await op('plan')).status_code == 200
                assert plans[1]['lookups'] == calls and len(plans[1]['context_handles']) == 2
            else:
                assert document.status_code == transcript.status_code == 409
                assert (await op('plan')).status_code == 409
        finally:
            for gate in gates.values(): gate.set()
            await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize('failed_status,other_found', [(503, True), (429, True), (500, True),
    (503, False), (403, True), (404, True), (409, True)])
async def test_read_failure_is_reserved_without_execution_but_access_changes_always_stop(setup, failed_status, other_found):
    import json
    _, repo, redis, *_ = setup
    repo.row['data']['voice_assistant'].update(engine='livekit', documents=['wiki/shared.md'])
    calls = [{'name': 'search_meeting', 'query': 'demo'}, {'name': 'search_shared_documents', 'query': 'demo'}]
    final_payloads = []
    async def upstream(request):
        body = json.loads(request.content)
        if request.url.path.endswith('/answer'):
            final_payloads.append(body)
            return httpx.Response(200, json={'text': 'Verified result from remaining source', 'sources': []})
        if body['operation'] == 'context': return httpx.Response(200, json={'history': []})
        if body['operation'] == 'plan': return httpx.Response(200, json={'tool_calls': calls})
        if body['lookup']['name'] == 'search_meeting':
            return httpx.Response(failed_status, json={'detail': 'PRIVATE upstream detail'})
        return httpx.Response(200, json={'tool': 'search_shared_documents', 'source_count': int(other_found), 'sources': []})
    def factory(**kwargs): return httpx.AsyncClient(transport=httpx.MockTransport(upstream), **kwargs)
    app = FastAPI(); app.include_router(build_voice_router(repo, redis, redis, client_factory=factory))
    body = question(); path = '/bots/voice/1/current/agent'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        async def op(operation, **extra):
            return await client.post(path, headers=headers(), json=body | {'operation': operation, 'agent_context': []} | extra)
        assert (await client.post(path, headers=headers(), json=body | {'operation': 'context'})).status_code == 200
        assert (await op('plan')).status_code == 200
        # Failure arrives first: it must not release a concurrent successful read's lease.
        failed = await op('lookup', lookup=calls[0])
        remaining = await op('lookup', lookup=calls[1])
        if failed_status in (403, 404, 409):
            assert failed.status_code == failed_status and remaining.status_code == 409
            assert 'PRIVATE' not in failed.text
        else:
            assert failed.status_code == 200 and failed.json()['lookup_status'] == 'unavailable'
            assert failed.json()['retrieval_unavailable'] is True
            assert remaining.status_code == 200
            assert remaining.json()['lookup_status'] == ('found' if other_found else 'empty')
            saved = json.loads(await redis.get(f'meeting:voice:1:current:{body["request_id"]}:agent'))
            assert saved['completed'] == calls and len(saved['lookups']) == 2
            assert saved['executed'] == [calls[1]]
        result = await client.post('/bots/voice/1/current/answer', headers=headers(), json=body | {'agent_context': []})
        if failed_status not in (403, 404, 409) and other_found:
            assert result.status_code == 200,result.text
            assert len(final_payloads) == 1 and final_payloads[0]['lookups'] == [calls[1]]
        else:
            assert result.status_code in (409, 503) and not final_payloads


async def test_empty_lookup_is_successful_not_a_service_error(setup):
    import json
    _,repo,redis,*_=setup;repo.row['data']['voice_assistant']['engine']='livekit'
    call={'name':'search_meeting','query':'missing'}
    async def upstream(request):
        body=json.loads(request.content)
        if body['operation']=='context':return httpx.Response(200,json={'history':[]})
        if body['operation']=='plan':return httpx.Response(200,json={'tool_calls':[call]})
        return httpx.Response(200,json={'tool':'search_meeting','source_count':0,'sources':[]})
    app=FastAPI();app.include_router(build_voice_router(repo,redis,redis,
        client_factory=lambda **kw:httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kw)))
    body=question();path='/bots/voice/1/current/agent'
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as client:
        assert (await client.post(path,headers=headers(),json=body|{'operation':'context'})).status_code==200
        assert (await client.post(path,headers=headers(),json=body|{'operation':'plan','agent_context':[]})).status_code==200
        result=await client.post(path,headers=headers(),json=body|{'operation':'lookup','lookup':call,'agent_context':[]})
        assert result.json()['lookup_status']=='empty' and not result.json().get('retrieval_unavailable')
        saved=json.loads(await redis.get(f'meeting:voice:1:current:{body["request_id"]}:agent'))
        assert saved['executed']==[call] and not saved.get('retrieval_unavailable')


async def test_voice_reply_persists_content_free_verification_trace_and_assistant_kind(setup):
    client,repo,redis,*_=setup
    async def upstream(request):
        return httpx.Response(200,json={'text':'Tôi là TINA.','sources':[], 'answer_kind':'assistant','reason':'answered',
                                      'verification':['unsupported_claim','approved']})
    def factory(**kwargs):return httpx.AsyncClient(transport=httpx.MockTransport(upstream),**kwargs)
    app=FastAPI();store=PlaybackStore(redis,repo.save_voice_reply)
    app.include_router(build_voice_router(repo,redis,redis,store,client_factory=factory))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as scoped:
        body=question()|{'question':'Bạn là ai?'}
        result=await scoped.post('/bots/voice/1/current/answer',headers=headers(),json=body)
        assert result.status_code==200,result.text
        record=repo.row['data']['voice_replies'][body['request_id']]
        assert record['answer_kind']=='assistant' and record['verification']==['unsupported_claim','approved']
        from meeting_api.lifecycle.voice_replies import VoiceReply
        from pydantic import ValidationError
        with pytest.raises(ValidationError):VoiceReply.model_validate({k:v for k,v in record.items() if k!='session_uid'}|{'verification':['private provider response']})


@pytest.mark.parametrize('engine', ['tina', 'livekit'])
async def test_current_session_reclaims_only_retired_voice_and_playback_ownership(setup, monkeypatch, engine):
    client, repo, redis, *_ = setup
    async def sessions(**kwargs): return ['retired', 'current']
    monkeypatch.setattr(repo, 'list_sessions', sessions)
    repo.row['data']['voice_assistant']['engine'] = engine
    old_id = str(uuid4())
    await redis.set('meeting:voice:1:lock', f'retired:{old_id}', ex=240)
    store = PlaybackStore(redis)
    await store.begin(1, old_id, 'retired', 'Old answer', 'auto')
    body = question()
    path = '/bots/voice/1/current/answer' if engine == 'tina' else '/bots/voice/1/current/agent'
    payload = body if engine == 'tina' else body | {'operation': 'context'}
    response = await client.post(path, headers=headers(), json=payload)
    assert response.status_code == 200, response.text
    assert await redis.get('meeting:voice:1:lock') == f"current:{body['request_id']}"
    assert (await store.get(1, old_id))['state'] == 'stopped'
    await store.report(1, old_id, 'retired', 'started')
    assert (await store.get(1, old_id))['state'] == 'stopped'
    if engine == 'tina': assert await redis.get('speech:active:1') == body['request_id']


@pytest.mark.parametrize('holder', ['current', 'unknown'])
async def test_voice_admission_does_not_steal_current_or_unrecognized_session_lock(setup, monkeypatch, holder):
    client, repo, redis, calls, *_ = setup
    async def sessions(**kwargs): return ['retired', 'current']
    monkeypatch.setattr(repo, 'list_sessions', sessions)
    held = f'{holder}:{uuid4()}'
    await redis.set('meeting:voice:1:lock', held, ex=240)
    response = await client.post('/bots/voice/1/current/answer', headers=headers(), json=question())
    assert response.status_code == 409
    assert await redis.get('meeting:voice:1:lock') == held
    assert not calls


async def test_parallel_new_turns_have_one_winner_after_retired_session_crash(setup, monkeypatch):
    client, repo, redis, calls, entered, release, blocked = setup
    async def sessions(**kwargs): return ['retired', 'current']
    monkeypatch.setattr(repo, 'list_sessions', sessions)
    await redis.set('meeting:voice:1:lock', f'retired:{uuid4()}', ex=240)
    blocked[0] = True
    async def send(): return await client.post('/bots/voice/1/current/answer', headers=headers(), json=question())
    tasks = [asyncio.create_task(send()), asyncio.create_task(send())]
    try:
        await asyncio.wait_for(entered.wait(), 2)
        # A retired bot's late state cannot release the replacement session's lease.
        held = await redis.get('meeting:voice:1:lock')
        late = await client.post('/bots/voice/1/retired/state', headers=headers('retired'),
                                 json={'state': 'QUIET', 'request_id': str(uuid4())})
        assert late.status_code == 409 and await redis.get('meeting:voice:1:lock') == held
        release.set()
        responses = await asyncio.wait_for(asyncio.gather(*tasks), 2)
        assert sorted(r.status_code for r in responses) == [200, 409]
        assert len([r for r in calls if r.url.path.endswith('/answer')]) == 1
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_bot_config_exposes_only_live_session_and_revision_fenced_tool_progress(setup):
    import json
    import time
    client, repo, redis, *_ = setup
    request_id = str(uuid4())
    value = {'request_id': request_id, 'session_uid': 'current', 'revision': 1,
             'stage': 'reading_documents', 'observed_at_ms': int(time.time()*1000)}
    await redis.set('meeting:voice:1:lock', 'current:' + request_id)
    await redis.set('meeting:voice:1:progress', json.dumps(value))
    path = '/bots/voice/1/current/config'
    response = await client.get(path, headers=headers())
    assert response.status_code == 200 and response.json()['progress'] == value
    assert (await client.get(path)).status_code in (401, 403)
    for invalid in [value | {'session_uid': 'retired'}, value | {'revision': 2},
                    value | {'request_id': str(uuid4())}, value | {'stage': 'invented'},
                    value | {'observed_at_ms': int(time.time()*1000) - 181000},
                    value | {'observed_at_ms': int(time.time()*1000) + 10000}]:
        await redis.set('meeting:voice:1:progress', json.dumps(invalid))
        assert (await client.get(path, headers=headers())).json().get('progress') is None
    await redis.set('meeting:voice:1:progress', 'invalid-json')
    assert (await client.get(path, headers=headers())).json().get('progress') is None
    await redis.set('meeting:voice:1:progress', json.dumps(value))
    await redis.delete('meeting:voice:1:lock')
    assert (await client.get(path, headers=headers())).json().get('progress') is None


async def test_retired_runtime_metadata_does_not_block_existing_meetings_or_expand_sources(setup):
    client,repo,*_=setup
    policy=repo.row['data']['voice_assistant']
    policy.update(engine='livekit',agent_runtime='amp',allow_general_knowledge=False,allow_web_search=False)
    response=await client.get('/meetings/1/voice-assistant',headers={'X-User-Id':'7'})
    assert response.status_code==200
    saved=response.json()['policy']
    assert 'agent_runtime' not in saved and saved['engine']=='livekit'
    assert saved['allow_general_knowledge'] is False and saved['allow_web_search'] is False
    # Stored history/config is retained, but new writes cannot re-enable a removed runtime.
    assert policy['agent_runtime']=='amp'
    assert (await client.put('/meetings/1/voice-assistant',headers={'X-User-Id':'7'},json=saved|{'agent_runtime':'amp'})).status_code==422


def test_legacy_reply_metadata_remains_readable_without_the_retired_runtime():
    from meeting_api.lifecycle.voice_replies import VoiceReply,public_replies
    value=VoiceReply(request_id=uuid4(),text='Lan làm demo.',detail_text='Hạn thứ Sáu.',answer_complete=False,
        state='stopped',played_text='Lan làm demo.',created_at_ms=1,updated_at_ms=2).model_dump(mode='json')
    row={'data':{'voice_replies':{value['request_id']:value|{'session_uid':'old'}}}}
    reply=public_replies(row,None)[0]
    assert reply['text']=='Lan làm demo.' and reply['detail_text']=='Hạn thứ Sáu.' and not reply['answer_complete']
