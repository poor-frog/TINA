import json

import pytest

from shared.voice_decision_flow import DecisionState, apply_decision_patch, checked_evidence


def patch(**values):
    return json.dumps({'intent':'update','title':None,'requested_status':None,'status_text':None,'source_hint':None}|values)


def test_collect_status_correct_cancel_and_pause_without_inventing_consensus():
    first=apply_decision_patch('Ghi quyết định dùng PostgreSQL',{},patch(title='dùng PostgreSQL'))
    assert first['node']=='decision_status' and first['state']['requested_status'] is None
    proposed=apply_decision_patch('Đây là đề xuất',first['state'],patch(requested_status='proposed',status_text='đề xuất'))
    assert proposed['node']=='review' and 'đề xuất' in proposed['text']
    changed=apply_decision_patch('Sửa thành dùng MySQL',proposed['state'],patch(title='dùng MySQL'))
    assert changed['state']['title']=='dùng MySQL' and changed['state']['evidence']==[]
    confirmed=apply_decision_patch('đồng ý',changed['state'],patch(intent='confirm'))
    assert confirmed['action']=='finish'
    assert apply_decision_patch('hủy quyết định',changed['state'],patch(intent='cancel'))['action']=='cancel'
    for _ in range(3):first=apply_decision_patch('ừm',first['state'],patch(intent='unmatched'))
    assert first['action']=='pause' and first['state']['title']=='dùng PostgreSQL'
    assert apply_decision_patch('Tạo task demo',first['state'],patch(intent='leave'))['action']=='leave'


def test_decided_request_needs_sources_and_explicit_downgrade():
    first=apply_decision_patch('Ghi quyết định dùng PostgreSQL, đã chốt',{},
        patch(title='dùng PostgreSQL',requested_status='decided',status_text='đã chốt'))
    assert first['node']=='decision_evidence' and not first['state']['evidence']
    with pytest.raises(ValueError):apply_decision_patch('đồng ý',first['state'],patch(intent='confirm'))
    downgraded=apply_decision_patch('Ghi dưới dạng đề xuất',first['state'],patch(requested_status='proposed',status_text='đề xuất'))
    assert downgraded['node']=='review' and downgraded['state']['evidence']==[]


def test_full_decision_history_retains_fields_and_allows_control_commands():
    state={'kind':'decision','title':'dùng PostgreSQL','requested_status':'proposed','status_text':'đề xuất',
        'source_hint':'phần backend','utterances':['Ghi quyết định dùng PostgreSQL']+['thông tin cũ']*4+['đề xuất','phần backend','ghi chú']}
    for intent,question in [('confirm','đồng ý'),('cancel','hủy'),('leave','Tạo task demo')]:
        result=apply_decision_patch(question,state,patch(intent=intent))
        assert result['action']==('finish' if intent=='confirm' else intent)
        assert len(result['state']['utterances'])<=8
        assert result['state']['utterances'][0]==state['utterances'][0]
        assert result['state']['title']==state['title']
        DecisionState.model_validate(result['state'])
    result=apply_decision_patch('đổi thành dùng MySQL',state,patch(title='dùng MySQL'))
    assert result['state']['status_text']=='đề xuất' and result['state']['source_hint']=='phần backend'
    assert len(result['state']['utterances'])<=8


@pytest.mark.parametrize('question,values',[
    ('Ghi quyết định dùng PostgreSQL',{'title':'dùng MySQL'}),
    ('Ghi quyết định dùng PostgreSQL',{'requested_status':'decided','status_text':'đã chốt'}),
    ('Chưa thống nhất dùng PostgreSQL',{'requested_status':'decided','status_text':'thống nhất'}),
    ('đồng ý',{'requested_status':'decided','status_text':'đồng ý'}),
    ('đề xuất',{'requested_status':'proposed'}),
])
def test_rejects_nonliteral_or_ambiguous_fields(question,values):
    with pytest.raises(ValueError):apply_decision_patch(question,{},patch(**values))


@pytest.mark.parametrize('quote',[
    'Chưa thống nhất dùng PostgreSQL.', 'Đề xuất đã chốt dùng PostgreSQL.',
    'TINA ghi quyết định đã chốt dùng PostgreSQL.', 'Đã chốt dùng PostgreSQL?',
    'Nếu thống nhất thì dùng PostgreSQL.',
])
def test_proposals_questions_and_commands_are_not_decided_evidence(quote):
    sources=[{'id':'s0','key':'segment:s0','fingerprint':'a'*64,'text':quote}]
    with pytest.raises(ValueError):checked_evidence(json.dumps({'verdict':'supported','source_ids':['s0'],'quotes':[quote]}),sources)


def test_evidence_requires_exact_current_source_and_bounded_quotes():
    quote='Chúng ta đã thống nhất dùng PostgreSQL.'
    sources=[{'id':'s0','key':'segment:s0','fingerprint':'a'*64,'text':quote}]
    raw=json.dumps({'verdict':'supported','source_ids':['s0'],'quotes':[quote]})
    status,proof=checked_evidence(raw,sources)
    assert status=='supported' and proof[0].quote==quote
    with pytest.raises(ValueError):checked_evidence(raw,[])
    with pytest.raises(ValueError):checked_evidence(raw.replace('PostgreSQL','MySQL'),sources)
    with pytest.raises(ValueError):DecisionState(evidence_status='supported')


from tests.test_voice_actions import actions, INTERNAL, OWNER, BASE


@pytest.fixture
def decision_service(actions,monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from control_plane import meeting_knowledge as api
    from control_plane.workspace_reader import WorkspaceReader
    _,root,row,state=actions
    state.update(quote='Chúng ta đã thống nhất dùng PostgreSQL.',verdict='supported',calls=[],patch={
        'title':'dùng PostgreSQL','requested_status':'decided','status_text':'đã chốt'})
    original=api.meeting_get
    def get(base,subject,mid,path):
        if path.endswith('/canonical') and subject=='7':
            return {'segments':[{'segment_id':'decision-1','text':state['quote'],'revision':0}]} if state['quote'] else {'segments':[]}
        return original(base,subject,mid,path)
    def complete(request,raw):
        data=json.loads(raw);state['calls'].append(data)
        if data['mode']=='voice_decision_flow':return patch(**state['patch'])
        assert data['mode']=='voice_decision_evidence'
        if state.get('outage'):
            from fastapi import HTTPException
            raise HTTPException(503,'Synthetic evidence service outage')
        source=data['sources'][0]
        response=json.dumps({'verdict':state['verdict'],'source_ids':[source['id']],'quotes':[source['quote']]})
        if state.get('revoke'):row['data']['voice_assistant']['revision']=2
        return response
    monkeypatch.setattr(api,'meeting_get',get)
    app=FastAPI();api.register(app,lambda r:r.headers.get('x-user-id',''),lambda r,s:root,
        WorkspaceReader(str(root.parent)),'http://meeting.test',complete)
    return TestClient(app),root,row,state


ENDPOINT='/api/internal/meeting-voice/1/decision-flow'
REQUEST='Ghi quyết định dùng PostgreSQL, đã chốt'


def test_decision_flow_proves_sources_then_requires_live_confirmation_and_owner_approval(decision_service):
    from uuid import uuid4
    client,root,row,state=decision_service
    result=client.post(ENDPOINT,headers=INTERNAL,json={'question':REQUEST,'revision':1,'operation':'plan','decision_state':{}})
    assert result.status_code==200,result.text
    proposal=result.json();assert proposal['node']=='review' and proposal['state']['evidence_status']=='supported'
    assert proposal['state']['evidence'][0]['quote']==state['quote']
    assert not list(root.rglob('voice-drafts/*.json'))
    confirmation=apply_decision_patch('đồng ý',proposal['state'],patch(intent='confirm'))
    rid=str(uuid4());headers=INTERNAL|{'X-Tina-Voice-Request-Id':rid}
    body={'question':'đồng ý','revision':1,'operation':'finish','decision_state':confirmation['state']}
    state['current']=False
    assert client.post(ENDPOINT,headers=headers,json=body).status_code==409
    state['current']=True;previous=state['quote'];state['quote']='Chưa thống nhất dùng PostgreSQL.'
    assert client.post(ENDPOINT,headers=headers,json=body).status_code==409
    assert not list(root.rglob('voice-drafts/*.json'))
    state['quote']=previous
    reply=client.post(ENDPOINT,headers=headers,json=body)
    assert reply.status_code==200,reply.text
    draft=json.loads(next(root.rglob('voice-drafts/*.json')).read_text())
    assert draft['kind']=='decision' and draft['status']=='pending'
    assert state['quote'] in draft['details'] and 'chưa được chủ meeting duyệt' in draft['details']
    assert not list((root/'kg').rglob('*.md'))
    state['replies']=[{'request_id':rid,'state':'completed','text':reply.json()['text']}]
    listed=client.get(BASE,headers=OWNER).json()['drafts'];assert len(listed)==1
    review={'expected_revision':1,'status':'approved','title':draft['title'],'details':draft['details']}
    assert client.post(BASE+'/'+draft['id']+'/review',headers={'X-User-Id':'8'},json=review).status_code==404
    assert client.post(BASE+'/'+draft['id']+'/review',headers=OWNER,json=review).status_code==200
    assert len(list((root/'kg'/'entities'/'decision').glob('*.md')))==1
    assert client.post(ENDPOINT,headers=INTERNAL|{'X-User-Id':'8'},json=body).status_code==404


@pytest.mark.parametrize('condition',['missing','conflict','private','policy_change'])
def test_unverified_decisions_never_become_decided_drafts(decision_service,condition):
    client,root,row,state=decision_service
    if condition=='missing':state['quote']=''
    if condition=='conflict':state.update(quote='Chưa thống nhất dùng PostgreSQL.',verdict='conflict')
    if condition=='private':row['data']['voice_assistant']['include_transcript']=False
    if condition=='policy_change':state['revoke']=True
    result=client.post(ENDPOINT,headers=INTERNAL,json={'question':REQUEST,'revision':1,'operation':'plan','decision_state':{}})
    if condition=='policy_change':assert result.status_code==409
    else:
        assert result.status_code==200,result.text
        proposal=result.json();assert proposal['node']=='decision_evidence'
        assert proposal['state']['requested_status']=='decided'
        assert not list(root.rglob('voice-drafts/*.json'))
        state['patch']={'requested_status':'proposed','status_text':'đề xuất'}
        downgraded=client.post(ENDPOINT,headers=INTERNAL,json={'question':'Ghi dưới dạng đề xuất','revision':1,
            'operation':'plan','decision_state':proposal['state']})
        assert downgraded.status_code==200,downgraded.text
        assert downgraded.json()['node']=='review' and downgraded.json()['state']['evidence']==[]
    assert not list(root.rglob('voice-drafts/*.json'))


@pytest.mark.parametrize('approved',[True,False])
def test_worker_verifies_decided_evidence_independently(monkeypatch,approved):
    from types import SimpleNamespace
    from shared.meeting_knowledge import PREFIX
    from worker import engine
    events=[];calls=[];quote='Chúng ta đã thống nhất dùng PostgreSQL.'
    def structured(prompt,*,system,schema):
        calls.append(system)
        value={'verdict':'supported','source_ids':['s0'],'quotes':[quote]} if len(calls)==1 else {
            'approved':approved,'reason':'unsupported_claim','claim_indexes':[0]}
        return SimpleNamespace(text=json.dumps(value))
    monkeypatch.setattr(engine,'completion_from_env',lambda **kw:SimpleNamespace(complete_structured=structured))
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-decision-test')
    payload={'request_id':'decision-test','text':json.dumps({'mode':'voice_decision_evidence','title':'dùng PostgreSQL',
        'sources':[{'id':'s0','key':'segment:s0','fingerprint':'a'*64,'quote':quote}]})}
    stream=SimpleNamespace(xadd=lambda _,entry:events.append(json.loads(entry['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    result=json.loads(next(e['text'] for e in events if e['type']=='message-delta'))
    assert len(calls)==2 and result['verdict']==('supported' if approved else 'missing')


def test_source_service_error_keeps_collected_fields_and_failed_playback_does_not_consume_a_reply(decision_service):
    client,root,row,state=decision_service;state['outage']=True
    body={'question':REQUEST,'revision':1,'operation':'plan','decision_state':{}}
    result=client.post(ENDPOINT,headers=INTERNAL,json=body)
    assert result.status_code==200,result.text
    proposal=result.json()
    assert proposal['action']=='service_error' and proposal['state']['title']=='dùng PostgreSQL'
    assert proposal['state']['requested_status']=='decided' and proposal['state']['evidence_status']=='unchecked'
    recovery=client.post(ENDPOINT,headers=INTERNAL,json=body|{'question':'đồng ý',
        'decision_state':proposal['state'],'recover_prompt':True})
    assert recovery.status_code==200 and recovery.json()['state']==proposal['state']
    assert not list(root.rglob('voice-drafts/*.json'))


def test_changed_source_before_review_requires_source_confirmation_again(decision_service):
    client,root,row,state=decision_service
    result=client.post(ENDPOINT,headers=INTERNAL,json={'question':REQUEST,'revision':1,'operation':'plan','decision_state':{}})
    previous=result.json()['state'];assert previous['evidence_status']=='supported'
    state.update(quote='Chưa thống nhất dùng PostgreSQL.',verdict='conflict')
    state['patch']={'intent':'unmatched'}
    result=client.post(ENDPOINT,headers=INTERNAL,json={'question':'đồng ý','revision':1,'operation':'plan','decision_state':previous})
    assert result.status_code==200,result.text
    assert result.json()['action']=='update' and result.json()['node']=='decision_evidence'
    assert result.json()['state']['evidence_status']=='conflict'
    assert result.json()['state']['evidence'][0]['quote']==state['quote']
    assert not list(root.rglob('voice-drafts/*.json'))


def test_uncertain_save_does_not_blindly_create_another_draft(decision_service):
    client,root,row,state=decision_service
    proposal=client.post(ENDPOINT,headers=INTERNAL,json={'question':REQUEST,'revision':1,'operation':'plan','decision_state':{}}).json()
    uncertain=proposal['state']|{'save_uncertain':True}
    body={'question':'đồng ý','revision':1,'decision_state':uncertain}
    result=client.post(ENDPOINT,headers=INTERNAL,json=body|{'operation':'plan'})
    assert result.status_code==200 and result.json()['action']=='pause'
    assert client.post(ENDPOINT,headers=INTERNAL,json=body|{'operation':'finish'}).status_code==409
    assert not list(root.rglob('voice-drafts/*.json'))
