import json
from copy import deepcopy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from control_plane import meeting_knowledge as api
from control_plane.workspace_reader import WorkspaceReader


@pytest.fixture
def voice(tmp_path, monkeypatch):
    root = tmp_path / '7'; root.mkdir()
    (root / 'wiki').mkdir()
    (root / 'wiki/shared.md').write_text('The approved budget is 100.')
    (root / 'wiki/private.md').write_text('PRIVATE WORKSPACE SECRET')
    policy = {'enabled': True, 'include_transcript': False, 'documents': ['wiki/shared.md'], 'revision': 1}
    row = {'id': 1, 'user_id': 7, 'status': 'active', 'platform': 'google_meet',
           'native_meeting_id': 'abc', 'data': {'voice_assistant': policy, 'docs': [{'path': 'wiki/shared.md'}]}}
    canonical = {'segments': [{'segment_id': 'seg1', 'text': 'PRIVATE TRANSCRIPT', 'revision': 0}]}
    prompts, mutate = [], [None]
    def meeting_get(base, subject, mid, path):
        if subject != '7' or mid != 1: raise HTTPException(404)
        return deepcopy(canonical if path.endswith('/canonical') else row)
    def complete(request, raw):
        prompts.append(json.loads(raw))
        if mutate[0]:
            override=mutate[0]()
            if isinstance(override,str):return override
        if prompts[-1].get('mode')=='voice_plan':
            return json.dumps({'tool_calls':[{'name':'search_shared_documents','query':'budget'}]})
        return json.dumps({'claims': [{'text': 'The budget is 100.', 'source_ids': ['s0']}]})
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'test-internal')
    monkeypatch.setattr(api, 'meeting_get', meeting_get)
    # Routing/fallback fixtures must not depend on whether the developer cached real E5 weights.
    monkeypatch.setattr(api, 'semantic_rank', lambda *_: [])
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(tmp_path)), 'http://meeting.test', complete)
    return TestClient(app), row, root, prompts, mutate


HEADERS = {'X-Internal-Secret': 'test-internal', 'X-User-Id': '7'}
URL = '/api/internal/meeting-voice/1/answer'


def test_room_sandbox_setting_marks_planning_and_answer_jobs(voice):
    client,row,_,prompts,_=voice
    row['data']['voice_assistant'].update(engine='livekit',agent_backend='sandbox')
    body={'question':'Budget for demo?','revision':1}
    result=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json=body|{'operation':'plan'})
    assert result.status_code==200 and prompts[-1]['use_sandbox_agent'] is True
    result=client.post(URL,headers=HEADERS,json=body)
    assert result.status_code==200 and prompts[-1]['use_sandbox_agent'] is True
    assert prompts[-1]['mode']=='voice'


def test_sandbox_social_classification_carries_the_turn_guard_without_changing_the_mode(voice):
    client,row,_,prompts,mutate=voice
    row['data']['voice_assistant'].update(agent_backend='sandbox')
    mutate[0]=lambda:json.dumps({'intent':'thanks'})
    response=client.post(URL,headers=HEADERS,json={'question':'Cảm ơn TINA nha, được rồi.','revision':1})
    assert response.status_code==200 and response.json()['answer_kind']=='assistant'
    assert prompts==[{'mode':'voice_intent','question':'Cảm ơn TINA nha, được rồi.','use_sandbox_agent':True}]


def test_project_sources_reuse_explicit_documents_and_revoke_after_removal(voice, monkeypatch):
    client,row,root,_,_=voice
    (root/'wiki/project.md').write_text('Lan owns the backend demo.')
    profiles='/api/workspace/meeting-knowledge/1/source-profiles'
    saved=client.post(profiles,headers=HEADERS,json={'name':'TINA project','documents':['wiki/project.md']})
    assert saved.status_code==200, saved.text
    profile=saved.json()
    assert client.get(profiles,headers=HEADERS).json()['profiles']==[profile]
    assert client.post(profiles,headers=HEADERS,json={'name':'TINA project'}).status_code==409
    policy=row['data']['voice_assistant']
    policy.update(profile['sources'],source_profile_id=profile['id'],source_profile_fingerprint=profile['fingerprint'])
    # A second room has no document links; explicit project sharing grants the same document.
    original=api.meeting_get
    def meeting_get(base,subject,mid,path):
        if mid==2 and path.endswith('/meetings/2'): return deepcopy(row)|{'id':2,'native_meeting_id':'second-room'}
        if mid==2: return {'segments':[]}
        return original(base,subject,mid,path)
    monkeypatch.setattr(api,'meeting_get',meeting_get)
    ready=client.get('/api/internal/meeting-voice/2/ready',headers=HEADERS)
    assert ready.status_code==200 and 'wiki/project.md' in ready.json()['documents']
    policy['allow_general_knowledge']=False
    assert client.get('/api/internal/meeting-voice/2/ready',headers=HEADERS).status_code==200
    policy['documents'].append('wiki/private.md')
    assert client.get('/api/internal/meeting-voice/2/ready',headers=HEADERS).status_code==409
    policy['documents'].pop()
    assert client.post(profiles+'/remove',headers=HEADERS,json={'key':profile['id'],'fingerprint':'0'*64}).status_code==409
    assert client.post(profiles+'/remove',headers=HEADERS,json={'key':profile['id'],'fingerprint':profile['fingerprint']}).status_code==200
    assert client.get('/api/internal/meeting-voice/2/ready',headers=HEADERS).status_code==409
    # Detaching does not require the deleted grant to remain readable.
    custom=policy|{'source_profile_id':None,'source_profile_fingerprint':None,'documents':[]}
    assert client.post('/api/internal/meeting-voice/2/profile',headers=HEADERS,json=custom).status_code==200


def test_project_profiles_reject_path_escape_and_other_meeting_owners(voice,monkeypatch):
    client,_,_,_,_=voice
    path='/api/workspace/meeting-knowledge/1/source-profiles'
    assert client.post(path,headers=HEADERS,json={'name':'unsafe','documents':['../7/wiki/private.md']}).status_code==422
    original=api.meeting_get
    monkeypatch.setattr(api,'meeting_get',lambda base,subject,mid,suffix:
        {'id':2,'user_id':8} if mid==2 else original(base,subject,mid,suffix))
    assert client.post(path,headers=HEADERS,json={'name':'other','shared_meeting_ids':[2]}).status_code==403


def test_automatic_public_source_routing_never_receives_private_context(voice):
    client,row,_,prompts,mutate=voice
    row['data']['voice_assistant'].update(engine='livekit',allow_web_search=True,auto_web_search=True)
    def respond():
        if prompts[-1]['mode']=='voice_source_intent': return json.dumps({'route':'web'})
    mutate[0]=respond
    question='Where are the latest React release notes?'
    result=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,
        json={'question':question,'revision':1,'operation':'plan'})
    assert result.status_code==200 and result.json()['tool_calls']==[{'name':'search_web','query':question}]
    assert prompts==[{'mode':'voice_source_intent','question':question}]
    prompts.clear()
    client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,
        json={'question':'Ai phụ trách dự án này?','revision':1,'operation':'plan'})
    assert not any(p['mode']=='voice_source_intent' for p in prompts)


def test_public_route_outage_keeps_authorized_local_retrieval(voice):
    client,row,_,prompts,mutate=voice
    row['data']['voice_assistant'].update(engine='livekit',allow_web_search=True,auto_web_search=True)
    def respond():
        if prompts[-1]['mode']=='voice_source_intent': raise HTTPException(503)
    mutate[0]=respond
    result=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,
        json={'question':'Find the React release notes','revision':1,'operation':'plan'})
    assert result.status_code==200 and result.json()['tool_calls'][0]['name']=='search_shared_documents'


def test_source_routing_is_reused_within_a_turn_but_not_after_policy_changes(voice):
    client,row,_,prompts,mutate=voice
    policy=row['data']['voice_assistant'];policy.update(engine='livekit',allow_web_search=True,auto_web_search=True)
    mutate[0]=lambda:json.dumps({'route':'web'}) if prompts[-1]['mode']=='voice_source_intent' else None
    headers=HEADERS|{'X-Tina-Voice-Request-Id':'00000000-0000-4000-8000-000000000001'}
    body={'question':'Find the newest React release notes','revision':1,'operation':'plan'}
    for _ in range(2):
        assert client.post('/api/internal/meeting-voice/1/agent',headers=headers,json=body).status_code==200
    assert len([p for p in prompts if p['mode']=='voice_source_intent'])==1
    policy['auto_web_search']=False
    result=client.post('/api/internal/meeting-voice/1/agent',headers=headers,json=body)
    assert result.json()['tool_calls'][0]['name']=='search_shared_documents'
    assert len([p for p in prompts if p['mode']=='voice_source_intent'])==1


def test_project_profile_references_remain_owner_scoped_and_cannot_grant_symlink_documents(voice):
    client,row,root,_,_=voice
    path='/api/workspace/meeting-knowledge/1/source-profiles'
    (root/'wiki/escape.md').symlink_to(root/'wiki/private.md')
    assert client.post(path,headers=HEADERS,json={'name':'escape','documents':['wiki/escape.md']}).status_code==422
    (root/'.meeting-knowledge/voice-source-profiles').mkdir(parents=True)
    (root/'.meeting-knowledge/voice-source-profiles/8.json').write_text('[]')
    row['data']['voice_assistant'].update(source_profile_id='a'*32,source_profile_fingerprint='b'*64)
    assert client.get('/api/internal/meeting-voice/1/ready',headers=HEADERS).status_code==409


def test_natural_social_reply_uses_selected_classifier_without_exporting_room_context(voice):
    client, row, _, prompts, mutate = voice
    mutate[0]=lambda:json.dumps({'intent':'thanks'})
    response=client.post(URL,headers=HEADERS,json={'question':'Cảm ơn TINA nha, được rồi.','revision':1})
    assert response.status_code==200
    assert response.json()['answer_kind']=='assistant' and response.json()['reason']=='answered'
    assert response.json()['sources']==[]
    assert prompts==[{'mode':'voice_intent','question':'Cảm ơn TINA nha, được rồi.'}]


def test_social_classifier_outage_preserves_evidence_path_and_compound_request_never_uses_it(voice):
    client, _, _, prompts, mutate = voice
    def unavailable():
        if prompts[-1]['mode']=='voice_intent':raise HTTPException(503)
    mutate[0]=unavailable
    response=client.post(URL,headers=HEADERS,json={'question':'Cảm ơn TINA nha.','revision':1})
    assert response.status_code==200 and response.json()['answer_kind']=='meeting'
    assert [p['mode'] for p in prompts]==['voice_intent','voice']
    prompts.clear()
    response=client.post(URL,headers=HEADERS,json={'question':'Cảm ơn, deadline của chúng ta là gì?','revision':1})
    assert response.status_code==200 and response.json()['answer_kind']=='meeting'
    assert [p['mode'] for p in prompts]==['voice']


def test_heard_topic_note_reaches_both_livekit_plan_and_final_and_disappears_when_revoked(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client,row,_,prompts,_=voice
    row['data']['voice_assistant']['engine']='livekit'
    source=sources_for({'segments':[]},{'wiki/shared.md':'The approved budget is 100.'})[0]
    history=[{'question':q,'answer':'The budget is 100.','created_at_ms':int(time.time()*1000)-1000,
        'sources':[{k:source[k] for k in ('key','fingerprint')}]} for q in ('Budget for demo?', 'What about it?')]
    body={'question':'Còn hạn?','revision':1,'history':history}
    response=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json=body|{'operation':'plan'})
    assert response.status_code==200
    assert prompts[-1]['dialogue_context']=={'goal':'Budget for demo?','refinements':['What about it?']}
    response=client.post(URL,headers=HEADERS,json=body)
    assert response.status_code==200 and prompts[-1]['dialogue_context']['goal']=='Budget for demo?'
    for turn in history: turn['sources'][0]['fingerprint']='0'*64
    response=client.post(URL,headers=HEADERS,json=body)
    assert response.status_code==200 and prompts[-1]['dialogue_context'] is None


def test_voice_request_uuid_correlates_retrieval_and_answer_without_logging_sources(voice, caplog):
    import logging
    client, *_ = voice
    identifier = '00000000-0000-4000-8000-000000000123'
    with caplog.at_level(logging.INFO, logger='shared.voice_trace'):
        response = client.post(URL, headers=HEADERS | {'X-Tina-Voice-Request-Id': identifier},
                               json={'question': 'Budget?', 'revision': 1})
    assert response.status_code == 200
    records = [json.loads(r.message) for r in caplog.records if r.name == 'shared.voice_trace']
    assert {r['request_id'] for r in records} == {identifier}
    assert {'semantic_retrieval', 'answer'} <= {r['stage'] for r in records}
    assert 'PRIVATE' not in caplog.text and 'budget' not in caplog.text.casefold()


def test_stopped_summary_turn_cannot_dispatch_more_work(voice, monkeypatch):
    client, row, _, prompts, _ = voice
    original = api.meeting_get
    permits = []
    row['data']['voice_assistant']['include_transcript'] = True
    def fetch(base, user, mid, path):
        if path.startswith('/internal/meeting-voice/'):
            permits.append(path)
            return {'current': False}
        return original(base, user, mid, path)
    monkeypatch.setattr(api, 'meeting_get', fetch)
    response = client.post(URL, headers=HEADERS | {'X-Tina-Voice-Request-Id': '00000000-0000-4000-8000-000000000123'},
                           json={'question': 'Tổng hợp toàn bộ quyết định trong cuộc họp.', 'revision': 1})
    assert response.status_code == 409
    assert permits and not prompts


def test_summary_permit_reads_use_the_internal_secret_only_on_the_internal_path(monkeypatch):
    import io
    requests = []
    def open_request(request, **kwargs):
        requests.append({k.lower(): v for k, v in request.header_items()})
        return io.BytesIO(b'{"current":true}')
    monkeypatch.setattr(api.urllib.request, 'urlopen', open_request)
    monkeypatch.setenv('TINA_INTERNAL_API_SECRET', 'synthetic-internal-secret')
    assert api.meeting_get('http://meeting.test', '7', 1, '/internal/meeting-voice/1/turn/test')['current']
    assert requests[-1]['x-internal-secret'] == 'synthetic-internal-secret'
    api.meeting_get('http://meeting.test', '7', 1, '/meetings/1')
    assert 'x-internal-secret' not in requests[-1]
    monkeypatch.delenv('TINA_INTERNAL_API_SECRET')
    with pytest.raises(HTTPException) as error:
        api.meeting_get('http://meeting.test', '7', 1, '/internal/meeting-voice/1/turn/test')
    assert error.value.status_code == 503 and len(requests) == 2


def test_only_explicit_shared_sources_enter_voice_prompt(voice):
    client, row, root, prompts, mutate = voice
    response = client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1})
    assert response.status_code == 200, response.text
    assert response.json()['text'] == 'The budget is 100.'
    encoded = json.dumps(prompts)
    assert 'PRIVATE TRANSCRIPT' not in encoded and 'PRIVATE WORKSPACE SECRET' not in encoded
    assert all(s['path'] == 'wiki/shared.md' for s in prompts[0]['sources'])
    assert not (root / '.meeting-knowledge').exists()


@pytest.mark.parametrize('linked', ['direct', 'linked_first', 'linked_late'])
def test_selected_voice_document_survives_unselected_documents_filling_the_load_budget(voice, linked):
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    body = {'operation':'lookup','question':'Budget?', 'revision':1,
            'lookup':{'name':'search_shared_documents','query':'budget'}}
    path = '/api/internal/meeting-voice/1/agent'
    assert client.post(path, headers=HEADERS, json=body).status_code == 200
    for i in range(8):
        name = f'wiki/a-{i}.md'
        (root/name).write_text('Unshared budget note.')
        row['data']['docs'].append({'path':name})
    if linked != 'direct':
        row['data']['docs'] = [d for d in row['data']['docs'] if d['path'] != 'wiki/shared.md']
        anchor = 'wiki/a-0.md' if linked == 'linked_first' else 'wiki/z-anchor.md'
        (root/anchor).write_text('[[shared]]')
        if linked == 'linked_late': row['data']['docs'].append({'path':anchor})
    result = client.post(path, headers=HEADERS, json=body)
    assert result.status_code == 200, result.text
    assert {s['path'] for s in result.json()['sources']} == {'wiki/shared.md'}
    assert 'Unshared budget note' not in result.text
    ready = client.get('/api/internal/meeting-voice/1/ready', headers=HEADERS)
    assert ready.status_code == 200 and len(ready.json()['documents']) <= 8
    assert 'wiki/shared.md' in ready.json()['documents']
    if linked != 'direct': (root/anchor).write_text('Link removed.')
    else: row['data']['docs'] = [d for d in row['data']['docs'] if d['path'] != 'wiki/shared.md']
    assert client.post(path, headers=HEADERS, json=body).status_code == 409


def test_document_priority_does_not_grant_an_unlinked_workspace_file(voice):
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['documents'] = ['wiki/private.md']
    assert (root/'wiki/private.md').is_file()
    assert client.post(URL, headers=HEADERS, json={'question':'Budget?', 'revision':1}).status_code == 409


def test_all_eight_selected_linked_documents_fit_the_voice_evidence_budget(voice):
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    chosen = [f'wiki/z-selected-{i}.md' for i in range(8)]
    row['data']['voice_assistant']['documents'] = chosen
    row['data']['docs'] = []
    for i, selected in enumerate(chosen):
        (root/selected).write_text(f'Approved budget note {i}.')
        anchor = f'wiki/a-anchor-{i}.md'
        (root/anchor).write_text(f'[[z-selected-{i}]]')
        row['data']['docs'].append({'path':anchor})
    result = client.post('/api/internal/meeting-voice/1/agent', headers=HEADERS, json={
        'operation':'lookup','question':'Budget?', 'revision':1,
        'lookup':{'name':'search_shared_documents','query':'budget'}})
    assert result.status_code == 200, result.text
    assert {s['path'] for s in result.json()['sources']} == set(chosen)
    ready = client.get('/api/internal/meeting-voice/1/ready', headers=HEADERS)
    assert set(ready.json()['documents']) == set(chosen)


@pytest.mark.parametrize('operation', ['plan', 'lookup', 'answer', 'ready'])
@pytest.mark.parametrize('failure', ['utf8', 'read'])
def test_optional_unselected_document_failure_does_not_disable_voice(voice, monkeypatch, operation, failure):
    from pathlib import Path
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    optional = root/'wiki/unselected.md'
    optional.write_bytes(b'PRIVATE OPTIONAL DETAIL \xff' if failure == 'utf8' else b'Unselected note.')
    row['data']['docs'].append({'path':'wiki/unselected.md'})
    original = Path.open
    def open_file(path, *args, **kwargs):
        if failure == 'read' and path == optional: raise PermissionError('PRIVATE FILE DETAIL')
        return original(path, *args, **kwargs)
    monkeypatch.setattr(Path, 'open', open_file)
    body = {'question':'Budget?', 'revision':1}
    if operation == 'ready': result = client.get('/api/internal/meeting-voice/1/ready',headers=HEADERS)
    elif operation == 'answer': result = client.post(URL,headers=HEADERS,json=body)
    else:
        body['operation'] = operation
        if operation == 'lookup': body['lookup'] = {'name':'search_shared_documents','query':'budget'}
        result = client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json=body)
    assert result.status_code == 200,result.text
    assert 'PRIVATE' not in result.text


@pytest.mark.parametrize('origin', [False, True])
def test_required_document_or_unknown_link_proof_failure_remains_a_service_error(voice, origin):
    client, row, root, prompts, _ = voice
    if origin:
        row['data']['docs'] = [{'path':'wiki/anchor.md'}]
        (root/'wiki/anchor.md').write_bytes(b'PRIVATE UNREADABLE ORIGIN \xff')
    else: (root/'wiki/shared.md').write_bytes(b'PRIVATE SELECTED DOCUMENT \xff')
    response = client.post(URL,headers=HEADERS,json={'question':'Budget?','revision':1})
    assert response.status_code == 503 and not prompts
    assert 'PRIVATE' not in response.text


def test_empty_voice_selection_ignores_optional_errors_without_relaxing_generic_knowledge(voice):
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['documents'] = []
    (root/'wiki/unselected.md').write_bytes(b'PRIVATE BAD DOCUMENT \xff')
    row['data']['docs'].append({'path':'wiki/unselected.md'})
    ready = client.get('/api/internal/meeting-voice/1/ready',headers=HEADERS)
    assert ready.status_code == 200
    assert 'wiki/unselected.md' not in ready.json()['documents']
    assert client.get('/api/workspace/meeting-knowledge/1',headers=HEADERS).status_code == 503


@pytest.mark.parametrize('failure_site', ['late_root', 'unselected_target'])
def test_optional_discovery_failures_do_not_hide_an_independently_verified_selected_link(voice, failure_site):
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    if failure_site == 'late_root':
        row['data']['docs'] = []
        for i in range(8):
            path = f'wiki/a-{i}.md';(root/path).write_text('Unselected note.');row['data']['docs'].append({'path':path})
        (root/'wiki/y-bad.md').write_bytes(b'PRIVATE BAD ROOT \xff')
        (root/'wiki/z-origin.md').write_text('[[shared]]')
        row['data']['docs'] += [{'path':'wiki/y-bad.md'},{'path':'wiki/z-origin.md'}]
    else:
        (root/'wiki/anchor.md').write_text('[[unused]]')
        (root/'wiki/unused.md').write_bytes(b'PRIVATE UNUSED TARGET \xff')
        row['data']['docs'].append({'path':'wiki/anchor.md'})
    result = client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json={
        'operation':'lookup','question':'Budget?','revision':1,
        'lookup':{'name':'search_shared_documents','query':'budget'}})
    assert result.status_code == 200,result.text
    assert {source['path'] for source in result.json()['sources']} == {'wiki/shared.md'}
    assert 'PRIVATE' not in result.text


def test_missing_internal_secret_or_substituted_owner_is_denied(voice):
    client, *_ = voice
    assert client.post(URL, headers={'X-User-Id': '7'}, json={'question': 'Budget?', 'revision': 1}).status_code == 401
    assert client.post(URL, headers=HEADERS | {'X-User-Id': '8'}, json={'question': 'Budget?', 'revision': 1}).status_code == 404
    assert client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1, 'documents': ['wiki/private.md']}).status_code == 422


@pytest.mark.parametrize('change', ['source', 'policy'])
def test_revoked_or_changed_evidence_is_not_spoken(voice, change):
    client, row, root, prompts, mutate = voice
    mutate[0] = (lambda: (root / 'wiki/shared.md').write_text('Budget changed.')) if change == 'source' else lambda: row['data']['voice_assistant'].update(enabled=False, revision=2)
    assert client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1}).status_code == 409


def test_voice_payload_has_recent_context_and_rejects_revoked_history(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client, row, root, prompts, _ = voice
    now = int(time.time() * 1000)
    source = sources_for({'segments': []}, {'wiki/shared.md': 'The approved budget is 100.'})[0]
    history = [{'question': 'Budget?', 'answer': 'The budget is 100.', 'created_at_ms': now - 1000,
                'sources': [{k: source[k] for k in ('key', 'fingerprint')}]}]
    response = client.post(URL, headers=HEADERS, json={'question': 'What about it?', 'revision': 1, 'history': history})
    assert response.status_code == 200
    assert prompts[-1]['mode'] == 'voice' and prompts[-1]['history'][0]['answer'] == 'The budget is 100.'
    assert 'PRIVATE TRANSCRIPT' not in json.dumps(prompts[-1])
    history[0]['sources'][0]['fingerprint'] = '0' * 64
    response = client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1, 'history': history})
    assert response.status_code == 200 and not prompts[-1]['history']


def test_short_answer_to_a_recent_clarification_keeps_its_topic_but_expired_question_is_not_pending(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client, _, _, prompts, _ = voice
    now=int(time.time()*1000)
    source=sources_for({'segments':[]},{'wiki/shared.md':'The approved budget is 100.'})[0]
    history=[{'question':'Budget?', 'answer':'Demo or production?', 'clarification':True,
              'created_at_ms':now-1000,'sources':[{k:source[k] for k in ('key','fingerprint')}]}]
    r=client.post(URL,headers=HEADERS,json={'question':'Production.', 'revision':1,'history':history})
    assert r.status_code==200 and prompts[-1]['history'][0]['clarification'] is True
    assert prompts[-1]['history'][0]['question']=='Budget?'
    assert prompts[-1]['pending_clarification']=={'question':'Budget?', 'asked':'Demo or production?', 'replies':[]}
    history[0]['created_at_ms']=now-31000
    r=client.post(URL,headers=HEADERS,json={'question':'Budget?', 'revision':1,'history':history})
    assert r.status_code==200 and prompts[-1]['history'][0]['clarification'] is False
    assert prompts[-1]['pending_clarification'] is None


def test_short_reply_to_a_heard_follow_up_keeps_goal_for_livekit_plan_and_answer(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client,row,_,prompts,_=voice
    row['data']['voice_assistant']['engine']='livekit'
    now=int(time.time()*1000)
    source=sources_for({'segments':[]},{'wiki/shared.md':'The approved budget is 100.'})[0]
    history=[{'question':'Budget for which project?', 'answer':'The budget is 100. Demo or production?',
              'follow_up':'Demo or production?', 'created_at_ms':now-1000,
              'sources':[{k:source[k] for k in ('key','fingerprint')}]}]
    body={'question':'Production.', 'revision':1,'history':history}
    expected={'question':history[0]['question'],'asked':'Demo or production?','replies':[]}
    r=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json=body|{'operation':'plan'})
    assert r.status_code==200 and prompts[-1]['pending_clarification']==expected
    r=client.post(URL,headers=HEADERS,json=body)
    assert r.status_code==200 and prompts[-1]['pending_clarification']==expected
    assert prompts[-1]['dialogue_context']['goal']==history[0]['question']
    history[0]['created_at_ms']=now-31000
    client.post(URL,headers=HEADERS,json=body)
    assert prompts[-1]['pending_clarification'] is None
    history[0]['created_at_ms']=now-1000
    history[0]['sources'][0]['fingerprint']='0'*64
    client.post(URL,headers=HEADERS,json=body)
    assert prompts[-1]['pending_clarification'] is None and not prompts[-1]['history']


def test_clarification_is_spoken_but_rechecks_all_context_sources(voice, monkeypatch):
    client, row, root, prompts, mutate = voice
    def complete(request, raw):
        prompts.append(json.loads(raw))
        if mutate[0]:
            override=mutate[0]()
            if isinstance(override,str):return override
        if prompts[-1].get('mode')=='voice_plan':
            return json.dumps({'tool_calls':[{'name':'search_shared_documents','query':'budget'}]})
        return json.dumps({'claims': [], 'clarification': 'Bạn hỏi ngân sách demo hay ngân sách triển khai?'})
    # Re-register with the same owner/source fixture and a clarification-only completion.
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(root.parent)), 'http://meeting.test', complete)
    scoped = TestClient(app)
    r = scoped.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1})
    assert r.status_code == 200 and r.json()['text'].endswith('?') and r.json()['sources'] == []
    mutate[0] = lambda: (root / 'wiki/shared.md').write_text('Changed budget information')
    assert scoped.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1}).status_code == 409


def test_worker_selects_voice_prompt_and_validates_clarification(monkeypatch):
    from llm.ports import CompletionResult
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_SYSTEM, VERIFY_SYSTEM
    from worker import engine
    captured = []
    class Completion:
        def complete(self, prompt, **kwargs):
            captured.append(kwargs['system'])
            if kwargs['system'] == VERIFY_SYSTEM: return CompletionResult(text='{"approved":true}')
            return CompletionResult(text=json.dumps({'claims': [], 'clarification': 'Bạn hỏi việc nào?'}))
    class Stream:
        def __init__(self): self.events = []
        def xadd(self, _topic, fields): self.events.append(json.loads(fields['event']))
        def expire(self, *_): pass
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-voice')
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: Completion())
    payload = {'request_id': 'voice', 'text': json.dumps({'mode': 'voice', 'question': 'Việc đó?', 'sources': []})}
    stream = Stream()
    engine._run_meeting_knowledge(stream, 'private-output', {'entrypoint': {'inline': PREFIX + json.dumps(payload)}})
    assert captured == [VOICE_SYSTEM, VERIFY_SYSTEM]
    assert stream.events[0]['type'] == 'message-delta'
    assert json.loads(stream.events[0]['text'])['clarification'] == 'Bạn hỏi việc nào?'


def test_unrelated_source_edits_do_not_cancel_a_supported_factual_answer(voice):
    client, row, root, prompts, mutate = voice
    (root / 'wiki/shared.md').write_text('The approved budget is 100.\n\nA separate lunch discussion.')
    # The neighboring paragraph is context, but the answer cites only the budget paragraph.
    # Editing a paragraph changes the whole document fingerprint, so use a different linked file.
    (root / 'wiki/other.md').write_text('The budget review lunch is at noon.')
    row['data']['docs'].append({'path': 'wiki/other.md'})
    row['data']['voice_assistant']['documents'].append('wiki/other.md')
    mutate[0] = lambda: (root / 'wiki/other.md').write_text('The budget review lunch moved.')
    response = client.post(URL, headers=HEADERS, json={'question': 'Budget?', 'revision': 1})
    assert response.status_code == 200, response.text


def test_lookup_round_can_recover_a_semantic_miss_and_cannot_open_unapproved_paths(voice):
    client, row, root, prompts, mutate = voice
    def complete(request, raw):
        payload = json.loads(raw); prompts.append(payload)
        if payload['tools_remaining']:
            return json.dumps({'tool_calls': [{'name': 'search_shared_documents', 'query': 'budget'}]})
        return json.dumps({'claims': [{'text': 'The budget is 100.', 'source_ids': [payload['sources'][0]['id']]}]})
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(root.parent)), 'http://meeting.test', complete)
    response = TestClient(app).post(URL, headers=HEADERS, json={'question': 'How much can we spend?', 'revision': 1})
    assert response.status_code == 200 and response.json()['reason'] == 'answered'
    assert response.json()['lookups'] == [{'tool': 'search_shared_documents', 'source_count': 1}]
    assert prompts[0]['sources'] == [] and len(prompts[1]['sources']) == 1
    assert 'PRIVATE' not in json.dumps(prompts)


@pytest.mark.parametrize('kind,question,flag', [
    ('general', 'ASR là gì?', 'allow_general_knowledge'),
    ('web', 'Tìm trên web về Redis', 'allow_web_search'),
])
def test_public_routes_are_opt_in_and_never_send_room_sources_or_history(voice, kind, question, flag):
    client, row, root, prompts, mutate = voice
    assert client.post(URL, headers=HEADERS, json={'question': question, 'revision': 1}).json()['reason'] == kind + '_disabled'
    assert not prompts
    row['data']['voice_assistant'][flag] = True
    def complete(request, raw):
        payload = json.loads(raw); prompts.append(payload)
        return json.dumps({'text': 'A public explanation.', 'links': [{'url': 'https://redis.io/docs/', 'title': 'Redis'}]})
    app = FastAPI()
    api.register(app, lambda r: r.headers['x-user-id'], lambda r, slug: root,
                 WorkspaceReader(str(root.parent)), 'http://meeting.test', complete)
    response = TestClient(app).post(URL, headers=HEADERS, json={'question': question, 'revision': 1})
    assert response.status_code == 200 and response.json()['answer_kind'] == kind
    assert response.json()['reason'] == 'answered'
    assert set(prompts[-1]) == {'mode', 'question'}
    assert 'PRIVATE' not in json.dumps(prompts) and 'budget' not in json.dumps(prompts)


def test_diagnostics_distinguish_missing_sources_retrieval_and_model_failure(voice):
    client, row, root, prompts, mutate = voice
    assert client.post(URL, headers=HEADERS, json={'question': 'Spend?', 'revision': 1}).json()['reason'] == 'llm_unavailable'
    row['data']['voice_assistant']['documents'] = []
    assert client.post(URL, headers=HEADERS, json={'question': 'Spend?', 'revision': 1}).json()['reason'] == 'no_shared_sources'


def test_agents_plan_and_lookup_use_only_approved_sources_and_no_nested_tool_loop(voice):
    client,row,root,prompts,mutate=voice
    row['data']['voice_assistant']['engine']='livekit'
    path='/api/internal/meeting-voice/1/agent'
    base={'question':'Compare the budget against the shared document','revision':1}
    plan=client.post(path,headers=HEADERS,json=base|{'operation':'plan'})
    assert plan.status_code==200,plan.text
    assert plan.json()['tool_calls']==[{'name':'search_shared_documents','query':'budget'}]
    assert prompts[0]['mode']=='voice_plan' and prompts[0]['available_tools']==['search_shared_documents','calculate']
    assert 'PRIVATE TRANSCRIPT' not in json.dumps(prompts) and 'PRIVATE WORKSPACE SECRET' not in json.dumps(prompts)
    lookup=client.post(path,headers=HEADERS,json=base|{'operation':'lookup','lookup':plan.json()['tool_calls'][0]})
    assert lookup.status_code==200 and lookup.json()['source_count']==1
    assert {s['path'] for s in lookup.json()['sources']}=={'wiki/shared.md'}
    result=client.post(URL,headers=HEADERS,json=base|{'lookups':plan.json()['tool_calls']})
    assert result.status_code==200 and result.json()['lookups']==[{'tool':'search_shared_documents','source_count':1}]
    assert prompts[-1]['tools_remaining']==0
    assert client.post(path,headers=HEADERS,json=base|{'operation':'lookup','lookup':{'name':'search_meeting','query':'private'}}).status_code==403
    row['data']['voice_assistant']['revision']=2
    assert client.post(path,headers=HEADERS,json=base|{'operation':'plan'}).status_code==409


def test_plan_deadline_is_forwarded_and_expired_plans_do_not_dispatch(voice):
    import time
    client,row,_,prompts,_=voice
    row['data']['voice_assistant']['engine']='livekit'
    deadline=int(time.time()*1000)+6000
    base={'question':'Compare the budget','revision':1,'operation':'plan','retrieval_deadline_ms':deadline}
    path='/api/internal/meeting-voice/1/agent'
    assert client.post(path,headers=HEADERS,json=base).status_code==200
    assert prompts[-1]['retrieval_deadline_ms']==deadline
    count=len(prompts)
    expired=client.post(path,headers=HEADERS,json=base|{'retrieval_deadline_ms':1})
    assert expired.status_code==200 and expired.json()=={'tool_calls':[]}
    assert len(prompts)==count
    for invalid in (True,'6000',0):
        assert client.post(path,headers=HEADERS,json=base|{'retrieval_deadline_ms':invalid}).status_code==422


@pytest.mark.parametrize('approved',[True,False])
def test_plan_timeout_uses_completion_api_shared_sources_and_still_requires_verification(voice,monkeypatch,approved):
    from types import SimpleNamespace
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM
    from worker import engine
    client,row,_,prompts,mutate=voice
    row['data']['voice_assistant']['engine']='livekit'
    monkeypatch.setenv('TINA_RUNNER','codex');monkeypatch.setenv('TINA_CODEX_AUTH_MODE','chatgpt-plan')
    seen=[];reviews=[]
    def generate(prompt,system):
        source=json.loads(prompt);seen.append(source)
        if source.get('mode')=='voice_plan':raise TimeoutError('synthetic plan timeout')
        rows=source['sources']
        assert all(r.get('path')=='wiki/shared.md' for r in rows)
        return json.dumps({'claims':[{'text':'The approved budget is 100.','source_ids':[rows[0]['id']]}]})
    def complete(prompt,*,system):
        if system==VERIFY_SYSTEM:
            reviews.append(json.loads(prompt));return SimpleNamespace(text=json.dumps({'approved':approved}))
        return SimpleNamespace(text=generate(prompt,system))
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete=complete))
    def dispatch():
        monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-api-timeout')
        events=[];stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
        engine._run_meeting_knowledge(stream,'test',{'entrypoint':{'inline':PREFIX+json.dumps({
            'request_id':'api-timeout','text':json.dumps(prompts[-1])})}})
        return next(e['text'] for e in events if e['type']=='message-delta')
    mutate[0]=dispatch
    base={'question':'What is the approved budget?','revision':1}
    plan=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json=base|{'operation':'plan'})
    assert plan.status_code==200 and plan.json()=={'tool_calls':[]}
    reply=client.post(URL,headers=HEADERS,json=base|{'lookups':[]})
    assert reply.status_code==200 and reviews
    if approved:
        assert reply.json()['reason']=='answered' and reply.json()['text']=='The approved budget is 100.'
        assert {s['path'] for s in reply.json()['sources']}=={'wiki/shared.md'}
    else:
        assert reply.json()['reason']=='verification_rejected' and reply.json()['sources']==[]
    assert 'PRIVATE' not in json.dumps(seen)


def test_typed_llm_plan_normalizes_to_existing_api_and_still_refuses_scope_changes(voice):
    client, row, root, prompts, mutate = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    path = '/api/internal/meeting-voice/1/agent'
    base = {'question': 'Compare the budget against the shared document', 'revision': 1}
    mutate[0] = lambda: json.dumps({'tool_calls': [{'name': 'search_shared_documents',
        'arguments': {'query': 'budget'}}]}) if prompts[-1].get('mode') == 'voice_plan' else None
    plan = client.post(path, headers=HEADERS, json=base | {'operation': 'plan'})
    assert plan.status_code == 200 and plan.json()['tool_calls'] == [{'name': 'search_shared_documents', 'query': 'budget'}]
    lookup = client.post(path, headers=HEADERS, json=base | {'operation': 'lookup', 'lookup': plan.json()['tool_calls'][0]})
    assert lookup.status_code == 200 and {s['path'] for s in lookup.json()['sources']} == {'wiki/shared.md'}
    mutate[0] = lambda: json.dumps({'tool_calls': [{'name': 'search_shared_documents',
        'arguments': {'query': 'budget', 'path': 'wiki/private.md'}}]})
    assert client.post(path, headers=HEADERS, json=base | {'operation': 'plan'}).status_code == 502


def test_v2_lookup_pack_refs_match_quotes_and_filters_never_widen_linked_sources(voice):
    client, row, root, prompts, mutate = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    path = '/api/internal/meeting-voice/1/agent'
    base = {'question': 'What is the approved budget?', 'revision': 1, 'operation': 'lookup'}
    (root/'retrieval-domain.json').write_text(json.dumps({'version':1,'aliases':{'budget':['cost']}}))
    call = {'name':'search_shared_documents','query':'cost'}
    result = client.post(path, headers=HEADERS, json=base | {'lookup':call})
    assert result.status_code == 200,result.text
    body = result.json(); pack = body['evidence_pack']
    assert pack['version'] == 'retrieval-evidence.v2' and pack['selected'] == len(body['sources']) == 1
    assert pack['items'][0]['id'] == body['sources'][0]['id']
    assert pack['items'][0]['fingerprint'] == body['sources'][0]['fingerprint']
    assert body['sources'][0]['quote'] == 'The approved budget is 100.'
    assert body['sources'][0]['retrieval']['version'] == 'v2'
    assert 'PRIVATE' not in result.text
    filters = {'speaker_id':'unknown','start_ms':None,'end_ms':None,'entities':[]}
    scoped = {'name':'search_shared_documents','query':json.dumps({'query':'cost','filters':filters},separators=(',',':'))}
    empty = client.post(path,headers=HEADERS,json=base | {'lookup':scoped})
    assert empty.status_code == 200 and empty.json()['source_count'] == 0 and not empty.json()['sources']
    assert not empty.json()['evidence_pack']['items']
    filters['owner_id'] = 99
    scoped['query'] = json.dumps({'query':'cost','filters':filters},separators=(',',':'))
    assert client.post(path,headers=HEADERS,json=base | {'lookup':scoped}).status_code == 422


@pytest.mark.parametrize('nested', [False, True])
def test_final_voice_prompt_cannot_restore_sources_outside_lookup_filters(voice, monkeypatch, nested):
    from shared.voice_tools import normalize_tool_call
    client, row, _, prompts, mutate = voice
    row['data']['voice_assistant']['include_transcript'] = True
    original = api.meeting_get
    def fetch(base, subject, mid, path):
        if path.endswith('/canonical'):
            return {'segments': [
                {'segment_id': key, 'revision': 1, 'text': 'Demo budget ' + key,
                 'speaker_id': speaker, 'start_ms': start, 'end_ms': start+1000}
                for key, speaker, start in [('a','s1',1000), ('b','s2',1000), ('c','s1',50000)]]}
        return original(base, subject, mid, path)
    monkeypatch.setattr(api, 'meeting_get', fetch)
    call = normalize_tool_call({'name':'search_meeting','arguments':{'query':'demo','filters':{
        'speaker_id':'s1','start_ms':0,'end_ms':3000,'entities':[]}}})
    def completion():
        if nested and len(prompts) == 1: return json.dumps({'tool_calls':[call]})
        sources = prompts[-1]['sources']
        assert sources and all(s.get('speaker_id') == 's1' and s['end_ms'] <= 3000 for s in sources)
        assert [s['key'] for s in prompts[-1]['evidence_pack']['items']] == [s['key'] for s in sources]
        return json.dumps({'claims':[{'text':'Demo budget a','source_ids':[sources[0]['id']]}]})
    mutate[0] = completion
    response = client.post(URL, headers=HEADERS, json={'question':'Demo budget?', 'revision':1}
        | ({} if nested else {'lookups':[call]}))
    assert response.status_code == 200, response.text
    assert response.json()['reason'] == 'answered'
    assert len(prompts) == (2 if nested else 1)


@pytest.mark.parametrize('route', ['answer', 'plan', 'lookup'])
@pytest.mark.parametrize('content', ['{PRIVATE DICTIONARY',
    pytest.param('[' * 15000 + '0' + ']' * 15000, id='deep-json')])
def test_bad_optional_dictionary_keeps_voice_routes_available(voice, route, caplog, content):
    client, row, root, _, _ = voice
    row['data']['voice_assistant']['engine'] = 'livekit'
    (root/'retrieval-domain.json').write_text(content)
    body = {'question':'Budget?', 'revision':1}
    if route != 'answer': body['operation'] = route
    if route == 'lookup': body['lookup'] = {'name':'search_shared_documents','query':'budget'}
    response = client.post(URL if route == 'answer' else '/api/internal/meeting-voice/1/agent', headers=HEADERS, json=body)
    assert response.status_code == 200, response.text
    assert 'using built-in aliases' in caplog.text and 'PRIVATE DICTIONARY' not in caplog.text


def test_agents_web_query_is_explicit_opt_in_and_cannot_contain_room_context(voice):
    client,row,root,prompts,mutate=voice
    policy=row['data']['voice_assistant'];policy['engine']='livekit'
    path='/api/internal/meeting-voice/1/agent'
    base={'question':'Tìm trên web về LiveKit Agents','revision':1}
    assert client.post(path,headers=HEADERS,json=base|{'operation':'plan'}).json()=={'tool_calls':[]}
    policy['allow_web_search']=True
    plan=client.post(path,headers=HEADERS,json=base|{'operation':'plan'}).json()
    assert plan=={'tool_calls':[{'name':'search_web','query':'LiveKit Agents'}]}
    assert not prompts  # Never ask an LLM to generate a web query using private sources.
    assert client.post(path,headers=HEADERS,json=base|{'operation':'lookup','lookup':{'name':'search_web','query':'PRIVATE TRANSCRIPT'}}).status_code==403
    mutate[0]=lambda:json.dumps({'text':'LiveKit has Agents.','links':[{'url':'https://docs.livekit.io/agents/','title':'Agents'}]})
    lookup=client.post(path,headers=HEADERS,json=base|{'operation':'lookup','lookup':plan['tool_calls'][0]})
    assert lookup.status_code==200,lookup.text
    assert prompts[-1]=={'mode':'voice_web','question':'LiveKit Agents'}
    before=len(prompts)
    answer=client.post(URL,headers=HEADERS,json=base|{'lookups':plan['tool_calls'],'web_result':lookup.json()['web_result']})
    assert answer.status_code==200 and len(prompts)==before
    assert answer.json()['lookups']==[{'tool':'search_web','source_count':1}]


def test_agents_context_removes_history_after_document_revocation(voice):
    import time
    from shared.meeting_knowledge import sources_for
    client,row,root,prompts,mutate=voice
    row['data']['voice_assistant']['engine']='livekit'
    source=sources_for({'segments':[]},{'wiki/shared.md':'The approved budget is 100.'})[0]
    turn={'question':'Budget?','answer':'100','created_at_ms':int(time.time()*1000)-1000,
          'sources':[{k:source[k] for k in ('key','fingerprint')}]}
    body={'question':'And the deadline?','revision':1,'operation':'context','history':[turn]}
    path='/api/internal/meeting-voice/1/agent'
    assert len(client.post(path,headers=HEADERS,json=body).json()['history'])==1
    (root/'wiki/shared.md').write_text('Changed source')
    assert client.post(path,headers=HEADERS,json=body).json()['history']==[]


@pytest.mark.parametrize('livekit',[False,True])
def test_social_and_capability_questions_use_server_metadata_without_room_fact_generation(voice,livekit):
    client,row,root,prompts,mutate=voice
    policy=row['data']['voice_assistant'];policy.update(include_transcript=False,documents=[],engine='livekit' if livekit else 'tina')
    for question in ('Bạn là ai?', 'Bạn làm được gì?', 'Cảm ơn!', 'Gửi email cho nhóm'):
        base={'question':question,'revision':1}
        if livekit:
            plan=client.post('/api/internal/meeting-voice/1/agent',headers=HEADERS,json=base|{'operation':'plan'})
            assert plan.json()=={'tool_calls':[]}
        answer=client.post(URL,headers=HEADERS,json=base)
        assert answer.status_code==200,answer.text
        assert answer.json()['answer_kind']=='assistant' and answer.json()['sources']==[]
    assert not prompts
    assert client.post(URL,headers=HEADERS,json={'question':'Budget?','revision':1}).json()['reason']=='no_shared_sources'


def test_repair_metadata_and_partial_answer_survive_source_checked_api(voice):
    client,row,root,prompts,mutate=voice
    mutate[0]=lambda:json.dumps({'claims':[{'text':'The budget is 100.','source_ids':['s0']}],
        'follow_up':'Can you confirm the deadline?', 'verification':['unsupported_claim','approved']})
    response=client.post(URL,headers=HEADERS,json={'question':'Budget and deadline?','revision':1})
    assert response.status_code==200,response.text
    assert response.json()['text']=='The budget is 100. Can you confirm the deadline?'
    assert response.json()['follow_up']=='Can you confirm the deadline?'
    assert response.json()['clarification'] is False and response.json()['context_refs']
    assert {s['key'] for s in response.json()['sources']} <= {s['key'] for s in response.json()['context_refs']}
    assert response.json()['verification']==['unsupported_claim','approved'] and response.json()['sources']
    mutate[0]=lambda:json.dumps({'claims':[],'reason':'verification_rejected','verification':['contradiction','contradiction']})
    response=client.post(URL,headers=HEADERS,json={'question':'Budget?','revision':1})
    assert response.json()['verification']==['contradiction','contradiction']
    assert response.json()['reason']=='verification_rejected' and '?' not in response.json()['text']


def test_repeated_heard_clarifications_pause_but_a_resolved_answer_is_still_allowed(voice):
    import time
    client,row,root,prompts,mutate=voice
    history=[{'question':'Phần đó.', 'answer':'Bạn muốn phần nào?', 'clarification':True,
        'created_at_ms':int(time.time()*1000)-1000+i,'sources':[]} for i in range(3)]
    mutate[0]=lambda:json.dumps({'claims':[],'clarification':'Bạn muốn phần nào?'})
    response=client.post(URL,headers=HEADERS,json={'question':'Như trước.','revision':1,'history':history})
    assert response.status_code==200 and response.json()['reason']=='clarification_exhausted'
    assert response.json()['clarification'] is False and response.json()['sources']==[]
    assert any(p.get('clarification_attempt')==3 for p in prompts)
    mutate[0]=lambda:json.dumps({'claims':[{'text':'The budget is 100.','source_ids':['s0']}]})
    resolved=client.post(URL,headers=HEADERS,json={'question':'Budget?','revision':1,'history':history})
    assert resolved.status_code==200 and resolved.json()['reason']=='answered'


def test_worker_repairs_one_rejected_draft_with_a_shared_deadline_and_rechecks(monkeypatch):
    from types import SimpleNamespace
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_SYSTEM,VERIFY_SYSTEM,VOICE_REPAIR_SYSTEM
    from worker import engine
    calls=[];timeouts=[];events=[];reviews=[False,True]
    def complete(prompt,**kwargs):
        calls.append(kwargs['system'])
        if kwargs['system']==VERIFY_SYSTEM:
            return SimpleNamespace(text=json.dumps({'approved':reviews.pop(0),'reason':'contradiction','claim_indexes':[0]}))
        return SimpleNamespace(text=json.dumps({'claims':[{'text':'Lan làm demo.' if kwargs['system']==VOICE_REPAIR_SYSTEM else 'Minh làm demo.','source_ids':['s0']}]}))
    def factory(**kwargs):timeouts.append(kwargs['timeout']);return SimpleNamespace(complete=complete)
    monkeypatch.setattr(engine,'completion_from_env',factory)
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-repair')
    payload={'request_id':'repair','text':json.dumps({'mode':'voice','question':'Ai?','sources':[{'id':'s0','quote':'Lan làm demo.'}],'tools_remaining':0})}
    stream=SimpleNamespace(xadd=lambda _,entry:events.append(json.loads(entry['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'synthetic',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert calls==[VOICE_SYSTEM,VERIFY_SYSTEM,VOICE_REPAIR_SYSTEM,VERIFY_SYSTEM]
    assert timeouts[0]==25 and all(t<=10 for t in timeouts[1:])
    result=json.loads(events[0]['text'])
    assert result['verification']==['contradiction','approved'] and result['claims'][0]['text']=='Lan làm demo.'
