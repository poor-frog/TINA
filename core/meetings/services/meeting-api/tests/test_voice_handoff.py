import json

import pytest

from test_task_flow import flow_service, question, context, BOT, AUTH

OWNER={'X-User-Id':'7'}


async def paused(service,action='pause'):
    client,_,_,playback,state,*_=service
    state['action']=action
    body=question()
    assert (await context(client,body)).status_code==200
    for operation in ('flow_plan','flow_apply'):
        assert (await client.post(BOT+'/agent',headers=AUTH,json=body|{'operation':operation})).status_code==200
    reply=await client.post(BOT+'/answer',headers=AUTH,json=body|{'agent_context':[]})
    assert reply.status_code==200,reply.text
    path='/meetings/1/voice-assistant/handoff/'+body['request_id']
    await playback.report(1,body['request_id'],'current','started')
    await playback.report(1,body['request_id'],'current','completed')
    await client.post(BOT+'/state',headers=AUTH,json={'state':'QUIET','request_id':body['request_id']})
    return path,body


async def test_owner_claim_preserves_task_and_never_writes_a_draft(flow_service):
    client,repo,redis,_,_,_,_,calls=flow_service
    path,body=await paused(flow_service)
    policy=(await client.get('/meetings/1/voice-assistant',headers=OWNER)).json()
    assert policy['runtime']['handoff']['request_id']==body['request_id']
    assert (await client.post(path,headers={'X-User-Id':'8'})).status_code==404
    assert (await client.get(path,headers=OWNER)).status_code==409
    result=await client.post(path,headers=OWNER)
    assert result.status_code==200,result.text
    value=result.json()
    assert value['task']=={'title':'demo','assignee':None,'due':None,'missing_field':'assignee','save_uncertain':False}
    assert value['original_request']=='Tạo task demo'
    assert 'flow_key' not in value and 'session_uid' not in value and 'source_refs' not in value
    assert not await redis.keys('*:task-flow:*')
    assert (await client.post(path,headers=OWNER)).json()==value
    assert (await client.get(path,headers=OWNER)).json()==value
    assert not any(payload.get('operation')=='finish' for _,payload in calls)
    repo.row['data']['voice_assistant']['revision']=2
    assert (await client.get(path,headers=OWNER)).status_code==409


@pytest.mark.parametrize('condition',['expired','stopped','new_turn','new_session','changed_task','busy','sources','deleted'])
async def test_stale_or_revoked_handoff_is_not_exported(flow_service,condition):
    client,repo,redis,playback,state,*_=flow_service
    path,body=await paused(flow_service)
    rid=body['request_id'];key='meeting:voice:1:handoff:'+rid
    if condition=='expired':await redis.delete(key)
    elif condition=='stopped':
        # Receipt is immutable once completed; replace only in this fake to exercise the gate.
        receipt=await playback.get(1,rid)
        receipt['state']='stopped'
        await redis.set(playback.key(1,rid),json.dumps(receipt))
    elif condition=='new_turn':
        await client.post(BOT+'/state',headers=AUTH,json={'state':'LISTENING','request_id':question()['request_id']})
    elif condition=='new_session':repo.row['status']='past'
    elif condition=='changed_task':
        for flow_key in await redis.keys('*:task-flow:*'):await redis.delete(flow_key)
    elif condition=='busy':await redis.set('meeting:voice:1:lock','other:turn')
    elif condition=='sources':state['unavailable']=True
    elif condition=='deleted':repo.row['data']['artifact_deletion']=True
    result=await client.post(path,headers=OWNER)
    assert result.status_code in (409,503),result.text


async def test_successful_clarification_has_no_handoff_button_hint(flow_service):
    client,*_=flow_service
    await paused(flow_service,'update')
    assert (await client.get('/meetings/1/voice-assistant',headers=OWNER)).json()['runtime']['handoff'] is None


@pytest.mark.parametrize('reason',['llm_unavailable','generation_format_invalid'])
def test_general_handoff_keeps_current_request_and_bounds_source_excerpts(reason):
    from meeting_api.lifecycle.voice_handoff import public_context, ELIGIBLE, VoiceHandoff
    value={'state':None,'question':'Ai phụ trách demo?','request_id':'request','expires_at_ms':1,
        'reason':reason,'history':[{'question':'Tóm tắt meeting','answer':'Nội dung đã phát.'}]}
    result=public_context(1,value,[{'quote':'x'*1200} for _ in range(16)])
    assert reason in ELIGIBLE and result['reason']==reason
    assert reason in VoiceHandoff.model_json_schema()['properties']['reason']['enum']
    assert result['original_request']=='Ai phụ trách demo?'
    assert result['heard_turns']==value['history']
    assert len(result['sources'])<=8 and sum(len(s['quote']) for s in result['sources'])<=8000


def test_format_failure_is_durable_reply_metadata_not_a_source_verification_rejection():
    from uuid import uuid4
    from meeting_api.lifecycle.voice_replies import VoiceReply,merge_reply,public_replies
    reply=VoiceReply(request_id=uuid4(),text='Lỗi định dạng câu trả lời.',reason='generation_format_invalid',
        state='completed',created_at_ms=1,updated_at_ms=2)
    data=merge_reply({},'current',reply.model_dump(mode='json'))
    stored=public_replies({'data':data},'current')[0]
    assert stored['reason']=='generation_format_invalid'
    assert stored['verification']==[] and stored['source_count']==0
