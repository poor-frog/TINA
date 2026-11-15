import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from control_plane import api, voice_handoff
from control_plane.dispatch import Dispatcher
from shared.config import load_settings
from tests.test_api import _FakeRuntime, _FakeIdentity, _FakeReader

RID='00000000-0000-4000-8000-000000000123'
SESSION='voice-handoff-1-'+RID


def test_handoff_is_owner_resolved_each_turn_and_skips_ambient_grounding(monkeypatch):
    monkeypatch.setenv('ANTHROPIC_API_KEY','test-credential')
    runtime=_FakeRuntime();dispatcher=Dispatcher(load_settings(),runtime,_FakeIdentity())
    calls=[]
    def resolve(base,subject,mid,path):
        calls.append((subject,mid,path))
        return {'meeting_id':1,'request_id':RID,'kind':'task','original_request':'Tạo task demo',
                'task':{'title':'demo','assignee':'Lan','due':None,'missing_field':'due'}}
    monkeypatch.setattr(voice_handoff,'meeting_get',resolve)
    monkeypatch.setattr(api,'_context_grounding',lambda *a,**kw:pytest.fail('Handoff must not fold ambient full-meeting context'))
    client=TestClient(api.create_app(dispatcher,stream_reader=_FakeReader()))
    response=client.post('/api/chat',headers={'X-User-Id':'u_jane'},json={
        'prompt':'Thứ sáu nhé','session':SESSION,'subject':'forged-owner','active':{'kind':'meeting','native_id':'unrelated'}})
    assert response.status_code==200,response.text
    assert calls==[('u_jane','1',f'/meetings/1/voice-assistant/handoff/{RID}')]
    # The fresh owner lookup also runs on reconnect; stale context cannot dispatch a new turn.
    count=len(runtime.spawned)
    def revoked(*args):raise HTTPException(404,'Meeting unavailable')
    monkeypatch.setattr(voice_handoff,'meeting_get',revoked)
    for headers in ({'X-User-Id':'u_jane'},{'X-User-Id':'u_jane','Last-Event-ID':'1-0'}):
        assert client.post('/api/chat',headers=headers,json={'prompt':'Tiếp tục','session':SESSION}).status_code==404
    assert len(runtime.spawned)==count


def test_prompt_preserves_fields_and_treats_snapshot_as_data(monkeypatch):
    monkeypatch.setattr(voice_handoff,'meeting_get',lambda *args:{'meeting_id':1,'request_id':RID,'kind':'task',
        'task':{'title':'demo','assignee':'Lan','due':None}})
    context,tools,prompt=voice_handoff.grounding('base','owner',SESSION,'Thứ sáu nhé')
    assert context=={'kind':'none','session':SESSION} and tools==[]
    assert 'Lan' in prompt and 'untrusted data' in prompt and prompt.endswith('Thứ sáu nhé')
    assert voice_handoff.grounding('base','owner','normal-chat','hello') is None
    with pytest.raises(HTTPException):voice_handoff.grounding('base','owner','voice-handoff-forged','hello')


def test_decision_handoff_keeps_source_check_separate_from_owner_approval(monkeypatch):
    monkeypatch.setattr(voice_handoff,'meeting_get',lambda *args:{'meeting_id':1,'request_id':RID,'kind':'decision',
        'decision':{'title':'dùng PostgreSQL','requested_status':'decided','evidence_status':'missing'}})
    _,_,prompt=voice_handoff.grounding('base','owner',SESSION,'Tiếp tục')
    assert 'without fresh source confirmation' in prompt and 'owner approval is separate' in prompt
    assert '"evidence_status": "missing"' in prompt
