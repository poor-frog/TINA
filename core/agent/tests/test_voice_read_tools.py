import json
from datetime import datetime,timezone
from uuid import uuid4

import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.voice_actions import create_draft,review_draft,VoiceActionReview
from control_plane.workspace_reader import WorkspaceReader
from shared.voice_knowledge import context_handle

HEADERS={'X-User-Id':'7','X-Internal-Secret':'test-internal'}
URL='/api/internal/meeting-voice/1'


@pytest.fixture
def tools(tmp_path,monkeypatch):
    root=tmp_path/'7';root.mkdir()
    row={'id':1,'user_id':7,'status':'active','platform':'google_meet','data':{'voice_assistant':{
        'enabled':True,'include_transcript':False,'include_approved_actions':False,'documents':[],
        'revision':1,'engine':'livekit'}}}
    state={'prompts':[],'mutate':None}
    def get(base,subject,mid,path):
        if str(subject)!='7' or mid!=1:raise HTTPException(404)
        if path.endswith('/canonical'):return {'segments':[]}
        return json.loads(json.dumps(row))
    def complete(request,raw):
        body=json.loads(raw);state['prompts'].append(body)
        if state['mutate']:state['mutate']()
        if body['mode']=='voice_plan':return '{"tool_calls":[]}'
        source=next((s for s in body['sources'] if s['kind']=='calculation'),body['sources'][0])
        return json.dumps({'claims':[{'text':source['quote'],'source_ids':[source['id']]}]})
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET','test-internal');monkeypatch.setattr(api,'meeting_get',get)
    app=FastAPI();api.register(app,lambda r:r.headers.get('x-user-id'),lambda r,s:root,
        WorkspaceReader(str(tmp_path)),'http://meeting.test',complete)
    directory=root/'.meeting-knowledge'/'1'/'voice-drafts';directory.mkdir(parents=True)
    def approved(kind='task',mid=1,owner='7'):
        draft=create_draft(directory,request_id=str(uuid4()),meeting_id=mid,owner=owner,policy_revision=1,
            kind=kind,title='Demo',details='Chi phí: 100 và 200. Hạn đã duyệt: 2026-11-20.')
        review=VoiceActionReview(expected_revision=1,status='approved',title='Demo',details=draft.details,
            assignee_label='An',due='2026-11-20')
        def safe(relative):path=root/relative;path.mkdir(parents=True,exist_ok=True);return path
        return review_draft(root,directory,draft,review,safe,lambda:None)
    return TestClient(app),root,row,state,approved


def test_approved_actions_are_opt_in_same_owner_meeting_and_live_entity_fingerprinted(tools):
    client,root,row,state,approved=tools
    saved=approved();approved('decision',mid=2);approved(owner='8')
    question={'question':'Task demo đã giao ai và hạn khi nào?','revision':1}
    body=question|{'operation':'lookup','lookup':{'name':'search_approved_actions','query':'demo'}}
    assert client.post(URL+'/agent',headers=HEADERS,json=body).status_code==403
    row['data']['voice_assistant']['include_approved_actions']=True
    lookup=client.post(URL+'/agent',headers=HEADERS,json=body)
    assert lookup.status_code==200
    sources=lookup.json()['sources'];assert sources and {s['path'] for s in sources}=={saved['path']}
    assert any('An' in s['quote'] for s in sources)
    original=sources[0]
    sources_body={'sources':[{'key':original['key'],'fingerprint':original['fingerprint']}]}
    assert client.post(URL+'/sources',headers=HEADERS,json=sources_body).json()['unavailable']==0
    (root/saved['path']).write_text((root/saved['path']).read_text().replace('state: open','state: done').replace('status: open','status: done'))
    assert client.post(URL+'/sources',headers=HEADERS,json=sources_body).json()['unavailable']==1
    row['data']['voice_assistant']['include_approved_actions']=False
    assert client.post(URL+'/sources',headers=HEADERS,json=sources_body).json()['sources']==[]


def test_calculate_tool_uses_spoken_inputs_and_recomputes_sources_for_inspection(tools):
    client,_,row,state,_=tools
    query=json.dumps({'expression':'100+200'})
    body={'question':'Tính 100 cộng 200','revision':1}
    call={'name':'calculate','query':query}
    result=client.post(URL+'/agent',headers=HEADERS,json=body|{'operation':'lookup','lookup':call})
    assert result.status_code==200 and result.json()['source_count']==1
    source=result.json()['sources'][0];assert '300.' in source['quote']
    answer=client.post(URL+'/answer',headers=HEADERS,json=body|{'lookups':[call]})
    assert answer.status_code==200 and '300.' in answer.json()['text']
    evidence=client.post(URL+'/sources',headers=HEADERS,json={'sources':[{'key':source['key'],'fingerprint':source['fingerprint']}]})
    assert evidence.status_code==200 and evidence.json()['sources'][0]['kind']=='calculation'
    invalid=client.post(URL+'/agent',headers=HEADERS,json=body|{'operation':'lookup','lookup':{'name':'calculate','query':'{"expression":"100+999"}'}})
    assert invalid.json()['source_count']==0 and invalid.json()['error']=='invalid_or_unsupported_inputs'
    missing=client.post(URL+'/answer',headers=HEADERS,json=body|{'lookups':[{'name':'calculate','query':'invalid json'}]})
    assert missing.status_code==200 and missing.json()['clarification'] is True


def test_document_calculation_needs_a_returned_handle_and_revocation_blocks_the_final_answer(tools):
    client,root,row,state,approved=tools
    saved=approved();row['data']['voice_assistant']['include_approved_actions']=True
    body={'question':'Tính tổng chi phí demo đã duyệt','revision':1}
    lookup=client.post(URL+'/agent',headers=HEADERS,json=body|{'operation':'lookup',
        'lookup':{'name':'search_approved_actions','query':'chi phí'}}).json()
    source=next(s for s in lookup['sources'] if '100 và 200' in s['quote']);handle=source['context_handle']
    call={'name':'calculate','query':json.dumps({'expression':'100+200','context_handles':[handle]},separators=(',',':'))}
    assert client.post(URL+'/agent',headers=HEADERS,json=body|{'operation':'lookup','lookup':call}).json()['source_count']==0
    calculation=client.post(URL+'/agent',headers=HEADERS,json=body|{'operation':'lookup','lookup':call,'context_handles':[handle]})
    assert calculation.json()['source_count']==1
    calls=[{'name':'search_approved_actions','query':'chi phí'},call]
    result=client.post(URL+'/answer',headers=HEADERS,json=body|{'lookups':calls})
    assert result.status_code==200 and any(s.get('path')==saved['path'] for s in result.json()['sources'])
    state['mutate']=lambda:(root/saved['path']).write_text((root/saved['path']).read_text().replace('100 và 200','100 và 900'))
    assert client.post(URL+'/answer',headers=HEADERS,json=body|{'lookups':calls}).status_code==409


def test_public_routes_do_not_offer_private_action_or_calculation_tools(tools):
    client,_,row,_,approved=tools
    approved();row['data']['voice_assistant']['include_approved_actions']=True
    for question in ['Tìm web về demo','Kiến thức chung: CPU là gì?']:
        value=client.post(URL+'/agent',headers=HEADERS,json={'question':question,'revision':1,'operation':'context'})
        assert value.status_code==200 and 'search_approved_actions' not in value.json()['available_tools']
        assert 'calculate' not in value.json()['available_tools']
