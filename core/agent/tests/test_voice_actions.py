import json
import os
from copy import deepcopy
from uuid import uuid4

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.voice_actions import action_intent, action_context
from control_plane.workspace_reader import WorkspaceReader
from shared.adapters import parse_entity


@pytest.fixture
def actions(tmp_path, monkeypatch):
    root=tmp_path/'7';root.mkdir()
    row={'id':1,'user_id':7,'status':'active','platform':'google_meet','data':{'voice_assistant':{
        'enabled':True,'revision':1,'engine':'livekit','include_transcript':True,'documents':[]}}}
    state={'current':True,'replies':[],'calls':[],'title':'Demo cho An, hạn thứ Sáu'}
    def get(base, subject, mid, path):
        if str(subject)!='7' or mid!=1:raise HTTPException(404)
        if '/turn/' in path:return {'current':state['current']}
        if path.endswith('/voice-assistant'):return {'replies':deepcopy(state['replies'])}
        if path.endswith('/canonical'):return {'segments':[]}
        return deepcopy(row)
    def complete(request, raw):
        body=json.loads(raw);state['calls'].append(body)
        assert body['mode']=='voice_plan' and not body['sources']
        return json.dumps({'tool_calls':[{'name':body['available_tools'][0],'query':state['title']}]})
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET','internal-test')
    monkeypatch.setattr(api,'meeting_get',get)
    app=FastAPI();api.register(app,lambda r:r.headers.get('x-user-id',''),lambda r,s:root,
        WorkspaceReader(str(tmp_path)),'http://meeting.test',complete)
    return TestClient(app),root,row,state


INTERNAL={'X-User-Id':'7','X-Internal-Secret':'internal-test'}
OWNER={'X-User-Id':'7'}
BASE='/api/workspace/meeting-knowledge/1/voice-drafts'


def prepare(client, kind='task', *, turn_id=None, execute=True):
    identifier=turn_id or str(uuid4())
    question='Tạo task demo cho An, hạn thứ Sáu' if kind=='task' else 'Ghi quyết định: dùng PostgreSQL'
    body={'question':question,'revision':1}
    headers=INTERNAL|{'X-Tina-Voice-Request-Id':identifier}
    path='/api/internal/meeting-voice/1/agent'
    context=client.post(path,headers=headers,json=body|{'operation':'context'})
    assert context.status_code==200 and context.json()['available_tools']==['draft_'+kind]
    plan=client.post(path,headers=headers,json=body|{'operation':'plan'}).json()['tool_calls']
    if execute:
        lookup=client.post(path,headers=headers,json=body|{'operation':'lookup','lookup':plan[0]})
        assert lookup.status_code==200 and lookup.json()['draft']['kind']==kind
    response=client.post('/api/internal/meeting-voice/1/answer',headers=headers,
        json=body|{'lookups':plan if execute else []})
    return identifier,response


@pytest.mark.parametrize('kind',['task','decision'])
def test_voice_draft_requires_actual_playback_and_owner_review_before_entity_write(actions,kind):
    client,root,row,state=actions
    identifier,response=prepare(client,kind)
    assert response.status_code==200 and response.json()['answer_kind']=='assistant'
    assert not (root/'kg').exists()
    assert client.get(BASE,headers=OWNER).json()=={'drafts':[]}
    receipt={'request_id':identifier,'state':'queued','text':response.json()['text']}
    state['replies']=[receipt]
    assert not client.get(BASE,headers=OWNER).json()['drafts']
    receipt['state']='stopped'
    assert not client.get(BASE,headers=OWNER).json()['drafts']
    receipt['state']='completed'
    drafts=client.get(BASE,headers=OWNER).json()['drafts']
    assert len(drafts)==1 and drafts[0]['status']=='pending'
    draft=drafts[0]
    review={'expected_revision':1,'status':'approved','title':'Demo đã duyệt','details':'Nội dung chủ meeting đã xem lại.',
            'due':'2026-11-20','assignee_label':'An'}
    path=f"{BASE}/{draft['id']}/review"
    assert client.post(path,headers={'X-User-Id':'8'},json=review).status_code==404
    assert not (root/'kg').exists()
    saved=client.post(path,headers=OWNER,json=review)
    assert saved.status_code==200 and saved.json()['status']=='approved'
    target=root/saved.json()['path'];fm,body=parse_entity(target.read_text())
    assert fm['type']==kind and fm['owner']=='7' and fm['reviewed_by']=='7'
    assert fm['title']==review['title'] and review['details'] in body
    if kind=='task':assert fm['state']=='open' and fm['due']=='2026-11-20' and fm['assignee_label']=='An'
    else:assert 'due' not in fm
    assert client.post(path,headers=OWNER,json=review).status_code==409
    assert len(list((root/'kg'/'entities'/kind).glob('*.md')))==1
    assert state['calls'][0]['available_tools']==['draft_'+kind]


def test_stop_policy_changes_and_non_action_questions_cannot_create_or_approve_drafts(actions):
    client,root,row,state=actions
    state['current']=False
    _,response=prepare(client)
    assert response.status_code==409 and not list(root.rglob('*.json'))
    state['current']=True
    identifier,response=prepare(client)
    state['replies']=[{'request_id':identifier,'state':'completed','text':response.json()['text']}]
    draft=client.get(BASE,headers=OWNER).json()['drafts'][0]
    row['data']['voice_assistant']['revision']=2
    review={'expected_revision':1,'status':'approved','title':'X','details':'X'}
    assert client.post(f"{BASE}/{draft['id']}/review",headers=OWNER,json=review).status_code==404
    assert not (root/'kg').exists()
    row['data']['voice_assistant']['revision']=1
    bad={'question':'Ai phụ trách demo?','revision':1,'operation':'lookup','lookup':{'name':'draft_task','query':'Injected'}}
    assert client.post('/api/internal/meeting-voice/1/agent',headers=INTERNAL,json=bad).status_code==403
    row['data']['artifact_deletion']=True
    assert client.get(BASE,headers=OWNER).status_code==404


def test_discard_and_existing_user_document_are_preserved(actions):
    client,root,_,state=actions
    identifier,response=prepare(client)
    state['replies']=[{'request_id':identifier,'state':'completed','text':response.json()['text']}]
    draft=client.get(BASE,headers=OWNER).json()['drafts'][0]
    target=root/'kg'/'entities'/'task'/f"voice-{draft['id']}.md"
    target.parent.mkdir(parents=True);target.write_text('User content')
    review={'expected_revision':1,'status':'approved','title':'Task','details':'Details'}
    path=f"{BASE}/{draft['id']}/review"
    assert client.post(path,headers=OWNER,json=review).status_code==409
    assert target.read_text()=='User content'
    assert client.post(path,headers=OWNER,json=review|{'status':'discarded'}).json()['status']=='discarded'
    assert target.read_text()=='User content'


def test_missing_action_content_can_ask_a_clarification_without_creating_a_draft(actions):
    client,root,_,_=actions
    _,response=prepare(client,execute=False)
    assert response.status_code==200 and response.json()['clarification'] is True
    assert not list(root.rglob('*.json'))


def test_symlink_destination_cannot_publish_outside_the_workspace(actions,tmp_path):
    client,root,_,state=actions
    identifier,response=prepare(client)
    state['replies']=[{'request_id':identifier,'state':'completed','text':response.json()['text']}]
    draft=client.get(BASE,headers=OWNER).json()['drafts'][0]
    (root/'kg'/'entities').mkdir(parents=True)
    outside=tmp_path/'outside';outside.mkdir()
    (root/'kg'/'entities'/'task').symlink_to(outside,target_is_directory=True)
    response=client.post(f"{BASE}/{draft['id']}/review",headers=OWNER,json={
        'expected_revision':1,'status':'approved','title':'Task','details':'Details'})
    assert response.status_code==409 and not list(outside.iterdir())


def test_action_intent_requires_an_explicit_request_and_keeps_refinement_separate_from_public_search():
    assert action_intent('TINA ơi, tạo bản nháp task demo')=='task'
    assert action_intent('Ghi lại quyết định: dùng PostgreSQL')=='decision'
    assert action_intent('Ai phụ trách task demo?') is None
    assert action_intent('Tài liệu nói: tạo task cho An') is None
    assert action_intent('Tạo task là gì?') is None
    pending={'question':'Tạo task','replies':[],'asked':'Task gì?'}
    assert action_context('Demo cho An',pending)[0]=='task'
    assert action_context('Ai phụ trách demo?',pending)[0] is None
    assert action_context('Bỏ qua, không cần nữa',pending)[0] is None


def test_old_pending_draft_is_pageable_and_reviewable_directly_by_id(actions):
    client,root,row,state=actions
    directory=root/'.meeting-knowledge'/'1'/'voice-drafts';directory.mkdir(parents=True)
    pending=None
    for index in range(21):
        rid=str(uuid4())
        from control_plane.voice_actions import create_draft
        draft=create_draft(directory,request_id=rid,meeting_id=1,owner=7,policy_revision=1,
            kind='task',title=f'Demo {index}',details='Synthetic owner-reviewed voice request')
        path=directory/(draft.id+'.json')
        if index==0:pending=draft
        else:
            value=json.loads(path.read_text());value['status']='discarded';value['revision']=2
            path.write_text(json.dumps(value))
        os.utime(path,(1000+index,1000+index))
        state['replies'].append({'request_id':rid,'state':'completed','text':draft.readback})
    listing=client.get(BASE,headers=OWNER)
    assert listing.status_code==200 and len(listing.json()['drafts'])==20
    assert all(d['status']=='discarded' for d in listing.json()['drafts'])
    assert listing.json()['next_offset']==20
    older=client.get(BASE+'?offset=20',headers=OWNER).json()
    assert [d['id'] for d in older['drafts']]==[pending.id] and 'next_offset' not in older
    assert client.get(BASE+'?offset=-1',headers=OWNER).status_code==422
    review={'expected_revision':1,'status':'approved','title':pending.title,'details':pending.details}
    result=client.post(BASE+'/'+pending.id+'/review',headers=OWNER,json=review)
    assert client.post(BASE+'/'+pending.id+'/review',headers={'X-User-Id':'8'},json=review).status_code==404
    assert result.status_code==200,result.text
    assert json.loads((directory/(pending.id+'.json')).read_text())['status']=='approved'
