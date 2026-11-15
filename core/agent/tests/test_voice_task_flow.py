import json

import pytest

from shared.voice_task_flow import TaskState, apply_task_patch


def patch(**kwargs):
    return json.dumps({'intent':'update','title':None,'assignee':None,'due':None,
                       'skip_assignee':False,'skip_due':False} | kwargs)


def test_task_collects_optional_fields_allows_correction_and_requires_review_confirmation():
    first=apply_task_patch('Tạo task kiểm thử đăng nhập',{},patch(title='kiểm thử đăng nhập'))
    assert first['node']=='assignee' and 'ai phụ trách' in first['text']
    second=apply_task_patch('Lan',first['state'],patch(assignee='Lan'))
    assert second['node']=='due'
    third=apply_task_patch('thứ Sáu',second['state'],patch(due='thứ Sáu'))
    assert third['node']=='review' and 'Lan' in third['text'] and 'thứ Sáu' in third['text']
    fourth=apply_task_patch('Không, đổi sang thứ Hai',third['state'],patch(due='thứ Hai'))
    assert fourth['state']['title']=='kiểm thử đăng nhập' and fourth['state']['assignee']=='Lan'
    assert 'thứ Hai' in fourth['text'] and 'thứ Sáu' not in fourth['text']
    confirmed=apply_task_patch('đồng ý',fourth['state'],patch(intent='confirm'))
    assert confirmed['action']=='finish' and confirmed['text']==''


def test_explicit_omission_is_optional_and_does_not_invent_assignments_or_dates():
    first=apply_task_patch('Tạo task demo',{},patch(title='demo'))
    second=apply_task_patch('để trống',first['state'],patch(skip_assignee=True))
    third=apply_task_patch('chưa biết',second['state'],patch(skip_due=True))
    assert third['node']=='review' and third['state']['assignee']==third['state']['due']==''
    for raw in [patch(assignee='Minh'),patch(due='2026-11-20'),patch(skip_due=True),patch(intent='confirm')]:
        with pytest.raises(ValueError): apply_task_patch('thứ Sáu',first['state'],raw)


def test_unknown_fields_and_ungrounded_persistent_state_are_rejected():
    for state in [{'title':'secret','utterances':['Tạo task demo']}, {'title':'demo','utterances':['demo']*9},
                  {'owner':'admin'}, {'utterances':['x'*2001]}]:
        with pytest.raises(ValueError): TaskState.model_validate(state)
    with pytest.raises(ValueError): apply_task_patch('Tạo task demo',{},patch(title='demo',path='/private'))
    with pytest.raises(ValueError): apply_task_patch('đổi hạn',{},patch(intent='confirm',due='hạn'))
    with pytest.raises(ValueError): apply_task_patch('Tạo task demo giao Lan',{},patch(title='demo',assignee='An'))


def test_cancellation_or_unrelated_question_does_not_create_a_task():
    state=apply_task_patch('Tạo task demo',{},patch(title='demo'))['state']
    assert apply_task_patch('hủy',state,patch(intent='cancel'))['action']=='cancel'
    assert apply_task_patch('Ai phụ trách production?',state,patch(intent='leave'))['action']=='leave'
    with pytest.raises(ValueError): apply_task_patch('Lan',state,patch(intent='cancel'))


def test_full_history_allows_confirmation_cancellation_and_literal_corrections():
    first='Tạo task demo giao Lan hạn thứ Sáu'
    state={'title':'demo','assignee':'Lan','due':'thứ Sáu','utterances':[first]+['thông tin cũ']*7}
    confirmed=apply_task_patch('đồng ý',state,patch(intent='confirm'))
    assert confirmed['action']=='finish' and confirmed['state']['utterances'][-1]=='đồng ý'
    assert confirmed['state']['utterances'][0]==first
    assert len(confirmed['state']['utterances'])<=8
    for intent,question in [('cancel','hủy'),('leave','Ai phụ trách production?')]:
        result=apply_task_patch(question,state,patch(intent=intent))
        assert result['action']==intent and result['state']['utterances']==state['utterances']
    state['utterances']=['Tạo task demo']+['thông tin cũ']*4+['Lan','thứ Sáu','ghi chú']
    result=apply_task_patch('đổi hạn thành thứ Hai',state,patch(due='thứ Hai'))
    assert result['state']['assignee']=='Lan' and result['state']['due']=='thứ Hai'
    assert 'Lan' in result['state']['utterances']
    assert len(result['state']['utterances'])<=8
    # Character capacity is bounded too, while retaining exact current-field provenance.
    state['utterances']=[first]+['x'*1100]*7
    assert len(''.join(state['utterances']))<8000
    result=apply_task_patch('đổi hạn thành thứ Hai '+('y'*1500),state,patch(due='thứ Hai'))
    assert sum(map(len,result['state']['utterances']))<=8000


def test_uncertain_task_save_cannot_create_another_draft(actions,monkeypatch):
    from control_plane import meeting_knowledge as api
    from tests.test_voice_actions import INTERNAL
    from fastapi import HTTPException
    from uuid import uuid4
    client,root,row,state=actions
    original=api.create_draft;first=[True]
    def lost_response(*args,**kwargs):
        draft=original(*args,**kwargs)
        if first[0]:first[0]=False;raise HTTPException(503,'Synthetic lost successful write response')
        return draft
    monkeypatch.setattr(api,'create_draft',lost_response)
    endpoint='/api/internal/meeting-voice/1/task-flow'
    task={'title':'demo','assignee':'Lan','due':'thứ Sáu',
        'utterances':['Tạo task demo giao Lan hạn thứ Sáu','đồng ý']}
    body={'question':'đồng ý','revision':1,'operation':'finish','task_state':task}
    assert client.post(endpoint,headers=INTERNAL|{'X-Tina-Voice-Request-Id':str(uuid4())},json=body).status_code==503
    task['save_uncertain']=True
    plan=client.post(endpoint,headers=INTERNAL,json=body|{'operation':'plan','task_state':task})
    assert plan.status_code==200 and plan.json()['action']=='pause'
    assert client.post(endpoint,headers=INTERNAL|{'X-Tina-Voice-Request-Id':str(uuid4())},json=body|{'task_state':task}).status_code==409
    cancelled=client.post(endpoint,headers=INTERNAL,json=body|{'operation':'plan','question':'hủy','task_state':task})
    assert cancelled.status_code==200 and cancelled.json()['action']=='cancel'
    assert len(list(root.rglob('voice-drafts/*.json')))==1


def test_unmatched_answers_get_two_distinct_reprompts_then_pause_without_losing_fields():
    first=apply_task_patch('Tạo task demo giao Lan',{},patch(title='demo',assignee='Lan'))
    assert first['node']=='due'
    one=apply_task_patch('như hôm trước',first['state'],patch(intent='unmatched'))
    two=apply_task_patch('ừm',one['state'],patch(intent='unmatched'))
    paused=apply_task_patch('như cũ',two['state'],patch(due='như cũ'))
    assert len({first['text'],one['text'],two['text']})==3
    assert 'Ví dụ' in two['text'] and paused['action']=='pause'
    assert paused['state']['title']=='demo' and paused['state']['assignee']=='Lan'
    assert paused['state']['due'] is None and paused['state']['reprompts']==2
    assert paused['state']['utterances']==first['state']['utterances']
    resumed=apply_task_patch('thứ Hai',paused['state'],patch(due='thứ Hai'))
    assert resumed['node']=='review' and resumed['state']['reprompts']==0
    assert 'Lan' in resumed['text'] and 'thứ Hai' in resumed['text']


def test_worker_uses_the_selected_completion_port_with_a_bounded_structured_extraction(monkeypatch):
    from types import SimpleNamespace
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_task_flow import TASK_FLOW_SYSTEM
    calls=[];events=[]
    def structured(prompt,*,system,schema):
        calls.append((system,schema))
        assert json.loads(prompt)['question']=='Tạo task demo'
        return SimpleNamespace(text=patch(title='demo'))
    def provider(**kwargs):
        assert kwargs['timeout']==10
        return SimpleNamespace(complete_structured=structured)
    monkeypatch.setattr(engine,'completion_from_env',provider)
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-task-flow-test')
    payload={'request_id':'task-flow-test','text':json.dumps({'mode':'voice_task_flow','question':'Tạo task demo',
        'node':'title','task_state':{}})}
    stream=SimpleNamespace(xadd=lambda _,entry:events.append(json.loads(entry['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert calls[0][0]==TASK_FLOW_SYSTEM and calls[0][1]['additionalProperties'] is False
    assert json.loads(next(e['text'] for e in events if e['type']=='message-delta'))['title']=='demo'


def test_internal_task_flow_uses_existing_owner_draft_review_and_current_turn_permit(actions, monkeypatch):
    from control_plane import meeting_knowledge as api
    from tests.test_voice_actions import INTERNAL, OWNER, BASE
    from uuid import uuid4
    client,root,row,state=actions
    endpoint='/api/internal/meeting-voice/1/task-flow'
    def complete(request,raw):
        data=json.loads(raw)
        assert data['mode']=='voice_task_flow' and 'sources' not in data
        return patch(title='demo',assignee='Lan',due='thứ Sáu')
    # The fixture's completion callback is closed over; register a fresh app with the same authorized sources.
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from control_plane.workspace_reader import WorkspaceReader
    app=FastAPI();api.register(app,lambda r:r.headers.get('x-user-id',''),lambda r,s:root,
        WorkspaceReader(str(root.parent)),'http://meeting.test',complete)
    client=TestClient(app)
    body={'question':'Tạo task demo giao Lan hạn thứ Sáu','revision':1,'operation':'plan','task_state':{}}
    proposal=client.post(endpoint,headers=INTERNAL,json=body)
    assert proposal.status_code==200,proposal.text
    value=proposal.json();assert value['node']=='review'
    assert not list(root.rglob('voice-drafts/*.json'))
    confirmed=apply_task_patch('đồng ý',value['state'],patch(intent='confirm'))
    identifier=str(uuid4());headers=INTERNAL|{'X-Tina-Voice-Request-Id':identifier}
    finish={'question':'đồng ý','revision':1,'operation':'finish','task_state':confirmed['state']}
    state['current']=False
    assert client.post(endpoint,headers=headers,json=finish).status_code==409
    assert not list(root.rglob('voice-drafts/*.json'))
    state['current']=True
    saved=client.post(endpoint,headers=headers,json=finish)
    assert saved.status_code==200 and saved.json()['reason']=='answered'
    draft=json.loads(next(root.rglob('voice-drafts/*.json')).read_text())
    assert draft['kind']=='task' and draft['status']=='pending' and draft['owner']=='7'
    assert 'Lan' in draft['details'] and 'thứ Sáu' in draft['details']
    assert not list((root/'kg').rglob('*.md'))
    assert client.get(BASE,headers=OWNER).json()['drafts']==[]
    assert client.post(endpoint,headers=INTERNAL|{'X-User-Id':'8'},json=body).status_code==404
    recovery=client.post(endpoint,headers=INTERNAL,json={'question':'thứ Hai','revision':1,'operation':'plan',
        'task_state':value['state'],'recover_prompt':True})
    assert recovery.status_code==200 and recovery.json()['state']==value['state']
    assert recovery.json()['text'].startswith('Em vẫn giữ thông tin task.')


from tests.test_voice_actions import actions  # Existing synthetic owner/draft fixture.
