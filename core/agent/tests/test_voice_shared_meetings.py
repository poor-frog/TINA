import json
from copy import deepcopy

import pytest
from fastapi import FastAPI,HTTPException
from fastapi.testclient import TestClient

from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader
from shared.voice_knowledge import voice_sources,lookup_voice_sources
from shared.voice_rerank import rerank_voice_sources

HEADERS={'X-User-Id':'7','X-Internal-Secret':'test-internal'}
BASE='/api/internal/meeting-voice/1'


@pytest.fixture
def shared(tmp_path,monkeypatch):
    root=tmp_path/'7';root.mkdir()
    rows={i:{'id':i,'user_id':7 if i<3 else 8,'status':'active' if i==1 else 'past',
        'platform':'google_meet','title':f'Meeting {i}','start_time':f'2026-11-{10+i:02d}T08:00:00Z',
        'data':{'voice_assistant':{'enabled':True,'include_transcript':True,'documents':[],
            'revision':1,'engine':'livekit','shared_meeting_ids':[]}}} for i in (1,2,3)}
    canonical={i:{'segments':[{'segment_id':'same-id','text':f'Deadline demo trong meeting {i}: thứ '+('Sáu.' if i==1 else 'Hai.'),
        'revision':0,'speaker_name':'An','start_ms':i*1000,'end_ms':i*1000+1000}]} for i in rows}
    state={'mutate':None,'prompts':[],'fetches':[]}
    def get(base,subject,mid,path):
        state['fetches'].append((mid,path))
        if str(subject)!='7' or mid not in rows:raise HTTPException(404)
        return deepcopy(canonical[mid] if path.endswith('/canonical') else rows[mid])
    def complete(request,raw):
        body=json.loads(raw);state['prompts'].append(body)
        if state['mutate']:state['mutate']()
        if body['mode']=='voice_plan':return '{"tool_calls":[{"name":"search_shared_meetings","query":"deadline demo"}]}'
        return json.dumps({'claims':[{'text':s['quote'],'source_ids':[s['id']]} for s in body['sources'][:2]]})
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET','test-internal');monkeypatch.setattr(api,'meeting_get',get)
    app=FastAPI();api.register(app,lambda r:r.headers.get('x-user-id'),lambda r,s:root,WorkspaceReader(str(tmp_path)),
        'http://meeting.test',complete)
    return TestClient(app),rows,canonical,state


def lookup(client,name='search_shared_meetings'):
    return client.post(BASE+'/agent',headers=HEADERS,json={'question':'So sánh deadline demo giữa các cuộc họp',
        'revision':1,'operation':'lookup','lookup':{'name':name,'query':'deadline demo'}})


def test_extra_transcripts_require_explicit_selection_and_keep_meeting_attribution(shared):
    client,rows,canonical,state=shared
    assert lookup(client).status_code==403
    assert not any(mid==2 for mid,_ in state['fetches'])
    rows[1]['data']['voice_assistant']['shared_meeting_ids']=[2]
    result=lookup(client);assert result.status_code==200,result.text
    sources=result.json()['sources']
    assert {s['meeting_id'] for s in sources}=={1,2}
    assert len({s['key'] for s in sources})==2 and any(s['key'].startswith('meeting:2:') for s in sources)
    assert {s['meeting_title'] for s in sources}=={'Meeting 1','Meeting 2'}
    local=lookup(client,'search_meeting').json()['sources']
    assert {s['meeting_id'] for s in local}=={1}
    ref=next(s for s in sources if s['meeting_id']==2)
    body={'sources':[{'key':ref['key'],'fingerprint':ref['fingerprint']}]}
    assert client.post(BASE+'/sources',headers=HEADERS,json=body).json()['sources'][0]['meeting_id']==2
    rows[1]['data']['voice_assistant']['shared_meeting_ids']=[]
    assert client.post(BASE+'/sources',headers=HEADERS,json=body).json()['unavailable']==1


@pytest.mark.parametrize('reason',['owner','deleted','missing'])
def test_private_deleted_or_missing_meetings_cannot_be_redistributed(shared,reason):
    client,rows,_,_=shared
    rows[1]['data']['voice_assistant']['shared_meeting_ids']=[2]
    if reason=='owner':rows[2]['user_id']=8
    elif reason=='deleted':rows[2]['data']['artifact_deletion']=True
    else:rows.pop(2)
    assert lookup(client).status_code in (403,404,409)


def test_cross_meeting_answer_rechecks_sources_after_generation_and_never_exports_to_web(shared):
    client,rows,canonical,state=shared
    rows[1]['data']['voice_assistant']['shared_meeting_ids']=[2]
    question={'question':'So với tuần trước deadline demo đã đổi chưa?','revision':1,
        'lookups':[{'name':'search_shared_meetings','query':'deadline demo'}]}
    result=client.post(BASE+'/answer',headers=HEADERS,json=question)
    assert result.status_code==200 and {s['meeting_id'] for s in result.json()['sources']}=={1,2}
    assert state['prompts'][-1]['mode']=='voice'
    state['mutate']=lambda:canonical[2]['segments'][0].update(text='Deadline mới: thứ Ba.',revision=1)
    assert client.post(BASE+'/answer',headers=HEADERS,json=question).status_code==409
    state['mutate']=None
    public=client.post(BASE+'/agent',headers=HEADERS,json={'question':'Tìm web về deadline demo','revision':1,'operation':'context'})
    assert 'search_shared_meetings' not in public.json()['available_tools']


def test_source_inspection_hides_only_revoked_other_meeting_quotes(shared):
    client,rows,_,_=shared
    rows[1]['data']['voice_assistant']['shared_meeting_ids']=[2]
    sources=lookup(client).json()['sources'];rows[2]['user_id']=8
    response=client.post(BASE+'/sources',headers=HEADERS,json={'sources':[
        {'key':s['key'],'fingerprint':s['fingerprint']} for s in sources]})
    assert response.status_code==200
    assert {s['meeting_id'] for s in response.json()['sources']}=={1}
    assert response.json()['unavailable']==1


def test_current_transcript_can_stay_private_while_selected_meeting_transcript_is_shared(shared):
    client,rows,_,_=shared
    rows[1]['data']['voice_assistant'].update(shared_meeting_ids=[2],include_transcript=False)
    assert {s['meeting_id'] for s in lookup(client).json()['sources']}=={2}
    assert lookup(client,'search_meeting').status_code==403


def test_single_meeting_recap_does_not_absorb_shared_meeting_transcripts(shared,monkeypatch):
    client,rows,_,_=shared
    rows[1]['data']['voice_assistant']['shared_meeting_ids']=[2]
    captured=[]
    def recap(question,sources,scope,complete,**kwargs):
        captured.extend(sources)
        return {'text':'Tóm tắt meeting hiện tại.','sources':sources[:1],
                'answer_kind':'meeting','reason':'answered'}
    monkeypatch.setattr(api,'recap',recap)
    response=client.post(BASE+'/answer',headers=HEADERS,json={'question':'Tóm tắt cuộc họp','revision':1,'lookups':[]})
    assert response.status_code==200 and {s['meeting_id'] for s in captured}=={1}


def test_retrieval_and_rerank_keep_both_meetings_and_context_neighbors_cannot_cross_them():
    sources=[{'kind':'transcript','key':f'new:{i}','fingerprint':str(i),'quote':'Deadline demo hiện tại.',
        'meeting_id':1,'current_meeting':True,'start_ms':1000,'end_ms':2000} for i in range(30)]
    sources.append({'kind':'transcript','key':'old','fingerprint':'old','quote':'Deadline demo cũ.',
        'meeting_id':2,'current_meeting':False,'start_ms':1000,'end_ms':2000})
    selected,recent=voice_sources(sources,'deadline demo',[],0)
    assert {s['meeting_id'] for s in selected}=={1,2}
    # An adjacent array entry with matching timestamps is still a different meeting.
    from shared.voice_knowledge import context_handle
    handle=context_handle(sources[-1])
    rows,_=lookup_voice_sources(sources,[],[{'name':'read_source_context','query':handle}],0)
    assert {s['meeting_id'] for s in rows}=={2}
    ranked,_=rerank_voice_sources('So sánh deadline',selected,[],[],lambda _:json.dumps({'source_ids':[selected[0]['id']]}))
    assert {s['meeting_id'] for s in ranked}=={1,2}
