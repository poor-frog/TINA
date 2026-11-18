import json

import httpx
import pytest

from llm import agent_reach, reach_mcp
from llm.citations import web_sources
from llm.errors import LLMError
from shared.tools import ToolRegistry
from shared.voice_knowledge import voice_route


def test_public_client_sends_only_fixed_operation_and_explicit_query(monkeypatch):
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach.test')
    def handler(request):
        assert str(request.url) == 'http://reach.test/query'
        assert json.loads(request.content) == {'channel':'github','action':'read','query':'redis/redis'}
        assert 'authorization' not in request.headers
        return httpx.Response(200,json={'ok':True,'channel':'github','action':'read','items':[
            {'title':'Redis','url':'https://github.com/redis/redis','text':'Redis source'},
            {'url':'javascript:bad','text':'discard'}]})
    assert len(agent_reach.query('github','read','redis/redis',transport=httpx.MockTransport(handler))['items']) == 1


@pytest.mark.parametrize('status,body', [(302,{}),(500,{}),(200,{'ok':True,'channel':'web','action':'read','items':{}})])
def test_client_does_not_follow_redirects_or_accept_mismatched_response(monkeypatch,status,body):
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach.test')
    with pytest.raises(LLMError):
        agent_reach.query('web','search','public',transport=httpx.MockTransport(lambda r:httpx.Response(status,json=body)))


def test_mcp_selects_only_granted_fixed_read_tools_and_keeps_urls(monkeypatch):
    from pathlib import Path
    grant = ToolRegistry.from_dir(Path(__file__).parents[1]/'tools-seed').resolve(['reach.github.read'])
    assert grant.mcp_tools == {'tina-reach':['reach_github_read']}
    assert 'env_vars' not in grant.mcp_servers['tina-reach']
    monkeypatch.setattr(reach_mcp,'query',lambda c,a,q:{'ok':True,'items':[{'url':'https://github.com/redis/redis','title':'Redis'}]})
    result=reach_mcp.handle({'method':'tools/call','params':{'name':'reach_github_read','arguments':{'query':'redis/redis'}}})
    event={'type':'mcpToolCall','server':'tina-reach','tool':'reach_github_read','result':result}
    assert web_sources(event)[0]['url'] == 'https://github.com/redis/redis'
    assert web_sources(event|{'server':'unrelated'}) == []
    with pytest.raises(ValueError):
        reach_mcp.handle({'method':'tools/call','params':{'name':'delete_repo','arguments':{'query':'redis/redis'}}})


def test_voice_public_route_and_claim_verification(monkeypatch):
    assert voice_route('Đọc GitHub redis/redis') == ('web','github redis/redis')
    assert voice_route('Tìm GitHub redis python') == ('web','github redis python')
    assert voice_route('Đọc web https://redis.io/docs/') == ('web','https://redis.io/docs/')
    assert voice_route('Trong cuộc họp ai nhắc GitHub?')[0] == 'meeting'
    calls=[]
    def query(*args, **kwargs):
        calls.append(args)
        return {'ok':True,'items':[{'url':'https://github.com/redis/redis','title':'Redis','text':'Redis is a database.'}]}
    monkeypatch.setattr(agent_reach,'query',query)
    complete=lambda p: json.dumps({'claims':[{'text':'Redis is a database.','source_ids':['s0']}]})
    result=agent_reach.answer_public('github redis/redis',complete,lambda p:'{"approved":true}')
    assert result['links'] == [{'url':'https://github.com/redis/redis','title':'Redis'}]
    assert calls == [('github','read','https://github.com/redis/redis')]
    assert agent_reach.answer_public('public',complete,lambda p:'{"approved":false}')['reason'] == 'verification_rejected'
    unsupported=lambda p:'{"claims":[{"text":"100 users","source_ids":["s0"]}]}'
    assert agent_reach.answer_public('public',unsupported,lambda p:'{"approved":true}')['reason'] == 'web_numeric_mismatch'


def test_mcp_bridge_restricts_advertisement_and_execution():
    tools = reach_mcp.handle({'method':'tools/list'}, ['reach_github_read'])['tools']
    assert [t['name'] for t in tools] == ['reach_github_read']
    with pytest.raises(ValueError):
        reach_mcp.handle({'method':'tools/call','params':{'name':'reach_web_search','arguments':{'query':'public'}}}, ['reach_github_read'])


def test_claude_attaches_public_bridge_config_for_duration_of_turn(tmp_path):
    from pathlib import Path
    from llm.claude_code import ClaudeCodeHarness
    paths=[]
    def execute(argv, cwd):
        path=Path(argv[argv.index('--mcp-config')+1]); paths.append(path)
        assert json.loads(path.read_text()) == {'mcpServers':{'tina-reach':{'command':'python','args':['-m','llm.reach_mcp','--url','http://reach:8080','--tools','reach_web_read']}}}
        yield json.dumps({'type':'result','result':'done','subtype':'success'})
    harness=ClaudeCodeHarness(exec_fn=execute)
    assert list(harness.run_turn(tmp_path,'Read public page',allowed_tools=['mcp__tina-reach'],
        mcp_servers={'tina-reach':{'command':'python','args':['-m','llm.reach_mcp','--url','http://reach:8080','--tools','reach_web_read']}},
        mcp_tools={'tina-reach':['reach_web_read']}))[-1]['ok']
    assert paths and not paths[0].exists()


def test_bridge_launches_with_scrubbed_pythonpath_from_workspace(tmp_path):
    import os
    from pathlib import Path
    import subprocess
    import sys
    messages=[{'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05'}},
              {'jsonrpc':'2.0','id':2,'method':'tools/list'}]
    run=subprocess.run([sys.executable,str(Path(reach_mcp.__file__).resolve()),'--url','http://reach:8080',
                        '--tools','reach_web_read'],cwd=tmp_path,env={'PATH':os.defpath},
                       input=''.join(json.dumps(m)+'\n' for m in messages),text=True,capture_output=True,timeout=5)
    assert run.returncode == 0
    rows=[json.loads(line) for line in run.stdout.splitlines()]
    assert [t['name'] for t in rows[1]['result']['tools']] == ['reach_web_read']


def test_groq_reach_namespace_round_trip_preserves_grants_and_call_ids():
    from llm.groq_responses import sanitize_responses_request, restore_reach_event
    fn={'type':'function','name':'reach_web_read','parameters':{'type':'object'}}
    call={'type':'function_call','namespace':'mcp__tina_reach','name':'reach_web_read',
          'call_id':'call-read','arguments':'{"query":"https://example.com"}'}
    original={'tools':[{'type':'namespace','name':'mcp__tina_reach','tools':[fn]},
                       {'type':'namespace','name':'other','tools':[fn]}], 'input':[call]}
    clean=sanitize_responses_request(original)
    flat='mcp__tina_reach__reach_web_read'
    assert [t['name'] for t in clean['tools']] == [flat]
    assert clean['input'][0]['name']==flat and 'namespace' not in clean['input'][0]
    event={'type':'response.output_item.done','item':clean['input'][0]}
    restored=restore_reach_event(event)
    assert restored['item']==call
    assert restore_reach_event({'response':{'output':[clean['input'][0]]}})['response']['output']==[call]
    assert original['tools'][0]['tools'][0]['name']=='reach_web_read'


@pytest.mark.parametrize('sandbox',[False,True])
def test_voice_worker_uses_reach_for_non_search_llm_and_emits_verified_links(monkeypatch,sandbox):
    from types import SimpleNamespace
    from worker.engine import _run_meeting_knowledge
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach:8080')
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-public-request')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    monkeypatch.setattr('redis.from_url',lambda *a,**kw:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
    if sandbox:
        monkeypatch.setenv('REDIS_URL','redis://synthetic')
        monkeypatch.setattr('redis.from_url',lambda *a,**kw:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
        def candidate(prompt,system,schema,**kwargs):
            assert 'PRIVATE ROOM' not in prompt and kwargs['current']()
            return '{"claims":[{"text":"Redis is a database.","source_ids":["s0"]}]}'
        monkeypatch.setattr('worker.voice_sandbox.complete',candidate)
    class Provider:
        def complete(self,prompt,*,system):
            assert 'PRIVATE ROOM' not in prompt
            if sandbox: assert system==VERIFY_SYSTEM
            return SimpleNamespace(text='{"approved":true}' if system==VERIFY_SYSTEM else
                '{"claims":[{"text":"Redis is a database.","source_ids":["s0"]}]}')
    monkeypatch.setattr('worker.engine.completion_from_env',lambda **kw:Provider())
    def retrieve(channel,action,text,**kw):
        assert (channel,action,text) in (('web','search','What is Redis?'),('web','read','https://redis.io'))
        return {'ok':True,'items':[{'url':'https://redis.io','title':'Redis','text':'Redis is a database.'}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    class Stream:
        def __init__(self): self.events=[]
        def xadd(self,key,body): self.events.append(json.loads(body['event']))
        def expire(self,*args): pass
    stream=Stream()
    payload={'request_id':'public-request','text':json.dumps({'mode':'voice_web','question':'What is Redis?','use_sandbox_agent':sandbox}),
             'voice_turn':{'meeting_id':1,'holder':'session:turn'}}
    _run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    result=json.loads(next(e['text'] for e in stream.events if e['type']=='message-delta'))
    assert result=={'text':'Redis is a database.','links':[{'url':'https://redis.io','title':'Redis'}],'verification':['approved']}


def test_upstream_rate_limit_is_returned_without_retry(monkeypatch):
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach:8080')
    calls=[]
    def handler(request):
        calls.append(request)
        return httpx.Response(200,json={'channel':'github','action':'read','ok':False,
                                       'items':[],'error':{'code':'RATE_LIMITED','message':'discard'}})
    result=agent_reach.query('github','read','redis/redis',transport=httpx.MockTransport(handler))
    assert len(calls)==1 and result=={'ok':False,'items':[],'error':{'code':'RATE_LIMITED'}}


@pytest.mark.parametrize('case,expected',[
 ('no_results','web_no_sources'),('retrieval_down','web_unavailable'),('model_down','llm_unavailable'),
 ('empty','web_answer_empty'),('format','generation_format_invalid'),('numbers','web_numeric_mismatch'),
 ('rejected','verification_rejected'),('review_down','verification_unavailable'),('valid','answered'),
])
def test_web_failure_categories_retain_counts_without_logging_content(monkeypatch,caplog,case,expected):
    import logging
    from shared.voice_trace import voice_span
    quote='PRIVATE TEST TEXT: Redis has 10 users.'
    def retrieve(*a,**kw):
        if case=='retrieval_down':return {'ok':False,'error':{'code':'RATE_LIMITED'},'items':[]}
        return {'ok':True,'items':[] if case=='no_results' else [{'title':'Redis','url':'https://redis.io','text':quote}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    calls=[]
    def complete(prompt):
        calls.append('generation')
        if case=='model_down':raise RuntimeError('PRIVATE PROVIDER RESPONSE')
        if case=='empty':return '{"claims":[]}'
        if case=='format':return 'PRIVATE INVALID JSON'
        return json.dumps({'claims':[{'text':f'Redis has {24 if case=="numbers" else 10} users.','source_ids':['s0']}]})
    def review(prompt):
        calls.append('review')
        if case=='review_down':raise RuntimeError('PRIVATE REVIEW RESPONSE')
        return json.dumps({'approved':case!='rejected','reason':'contradiction','claim_indexes':[0]})
    with caplog.at_level(logging.INFO),voice_span('web_search','00000000-0000-4000-8000-000000000001'):
        result=agent_reach.answer_public('PRIVATE QUERY',complete,review)
    assert result.get('reason','answered')==expected
    rows=[json.loads(r.message) for r in caplog.records if r.message.startswith('{') and json.loads(r.message).get('type')=='voice_web_result']
    assert len(rows)==1 and rows[0]['reason']==expected
    assert rows[0]['request_id']=='00000000-0000-4000-8000-000000000001'
    assert rows[0]['retrieved_sources']==(0 if case in ('no_results','retrieval_down') else 1)
    assert 'PRIVATE' not in caplog.text
    if case in ('numbers','empty','format'):assert calls==['generation']
    if case=='numbers':assert result['verification']==['numeric_mismatch']
    if case=='review_down':assert result['verification']==['unavailable']
    if case=='valid':assert result['verification']==['approved'] and result['links']
    else:assert not result.get('text') and not result.get('links')


@pytest.mark.parametrize('status,code',[(429,'RATE_LIMITED'),(504,'TIMEOUT'),(403,'PLATFORM_BLOCKED')])
def test_http_retrieval_failures_keep_typed_reason_without_retry(monkeypatch,caplog,status,code):
    import logging
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://fixture')
    calls=[]
    def handler(request):calls.append(True);return httpx.Response(status)
    original=agent_reach.query
    monkeypatch.setattr(agent_reach,'query',lambda *a,**kw:original(*a,**kw,transport=httpx.MockTransport(handler)))
    with caplog.at_level(logging.INFO):result=agent_reach.answer_public('public query',None,None)
    assert result=={'reason':'web_unavailable'} and calls==[True]
    row=next(json.loads(r.message) for r in caplog.records if 'voice_web_result' in r.message)
    assert row['retrieval_error']==code


def test_web_reads_two_pages_in_parallel_and_verifies_original_excerpts(monkeypatch):
    from threading import Barrier
    barrier = Barrier(2)
    calls = []
    def retrieve(channel, action, target, **kwargs):
        calls.append((action,target))
        assert 0 < kwargs['timeout'] <= 10
        if action == 'search':
            return {'ok':True,'items':[{'title':str(i),'url':f'https://example.com/{i}',
                'text':'Search snippet says 24 users.'} for i in (0,0,1,2,3)]}
        barrier.wait(timeout=2)
        return {'ok':True,'items':[{'title':'Original page','url':target,
            'text':'# Release\n| Product | Users |\n| Redis | 19 |'}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    def complete(prompt):
        sources = json.loads(prompt)['sources']
        assert len(sources) == 4
        assert all('| Redis | 19 |' in s['quote'] for s in sources[:2])
        assert sources[2]['quote'] == 'Search snippet says 24 users.'
        return '{"claims":[{"text":"Redis has 19 users.","source_ids":["s0"]}]}'
    answer = agent_reach.answer_public('Redis users',complete,lambda _:'{"approved":true}')
    assert answer['text'] == 'Redis has 19 users.'
    assert sorted(calls) == [('read','https://example.com/0'),('read','https://example.com/1'),('search','Redis users')]


def test_missing_web_evidence_searches_once_more_with_three_page_total_bound(monkeypatch,caplog):
    import logging
    calls, generated, plans = [], [], []
    def retrieve(channel, action, target, **kwargs):
        calls.append((channel,action,target))
        if action == 'search':
            values = range(5) if target == 'Redis users' else range(4,9)
            return {'ok':True,'items':[{'title':str(i),'url':f'https://example.com/{i}',
                'text':'Users not published.'} for i in values]}
        return {'ok':True,'items':[{'title':'Release','url':target,
            'text':'Redis has 19 users.' if target.endswith('/5') else 'Users not published.'}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    def complete(prompt):
        data = json.loads(prompt); generated.append(data)
        assert set(data) == {'question','sources'}
        return ('{"claims":[]}' if len(generated) == 1 else
                '{"claims":[{"text":"Redis has 19 users.","source_ids":["s5"]}]}')
    def refine(prompt):
        plans.append(json.loads(prompt))
        return '{"query":"Redis release users count"}'
    with caplog.at_level(logging.INFO):
        result = agent_reach.answer_public('Redis users',complete,lambda _:'{"approved":true}',refine=refine)
    assert result['links'] == [{'title':'Release','url':'https://example.com/5'}]
    assert len(generated) == 2 and len(plans) == 1
    assert len(generated[1]['sources']) == 6
    assert len([c for c in calls if c[1]=='search']) == 2
    assert len([c for c in calls if c[1]=='read']) == 3
    row = next(json.loads(r.message) for r in caplog.records if 'voice_web_result' in r.message)
    assert row['search_rounds'] == 2 and row['pages_read'] == 3


@pytest.mark.parametrize('plan', ['{"query":null}','{"query":"public"}',
    '{"query":"bad\\nquery"}','{"query":"new","private":"ignored"}', 'not JSON',
    json.dumps({'query':'x'*201})])
def test_invalid_or_repeated_refinement_cannot_start_another_search(monkeypatch,plan):
    calls = []
    monkeypatch.setattr(agent_reach,'query',lambda *a,**k:(calls.append(a) or {'ok':True,'items':[]}))
    result = agent_reach.answer_public('public',None,None,refine=lambda _:plan)
    assert result['reason'] == 'web_no_sources' and len(calls) == 1


@pytest.mark.parametrize('output,reason', [('{"claims":[]}', 'web_answer_empty'),
    ('invalid', 'generation_format_invalid'),
    ('{"claims":[{"text":"19 users","source_ids":["s0"]}]}','web_numeric_mismatch')])
def test_read_failures_keep_snippets_and_never_retry_format_or_numeric_errors(monkeypatch,output,reason):
    calls, plans = [], []
    def retrieve(c,a,q,**kw):
        calls.append((a,q))
        if a=='read': raise LLMError('Unavailable')
        return {'ok':True,'items':[{'url':'https://example.com','title':'Example','text':'24 users'}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    def refine(prompt):
        plans.append(True)
        assert json.loads(prompt)['sources'][0]['quote'] == '24 users'
        return '{"query":"new public query"}'
    result = agent_reach.answer_public('public',lambda _:output,lambda _:'{"approved":true}',refine=refine)
    assert result['reason'] == reason
    assert len(plans) == int(reason=='web_answer_empty')
    assert len([c for c in calls if c[0]=='search']) == (2 if plans else 1)
    assert len([c for c in calls if c[0]=='read']) == 1


def test_stop_during_page_read_blocks_generation_and_further_search(monkeypatch):
    from threading import Event
    stopped, release = Event(), Event()
    def retrieve(c,a,q,**kw):
        if a=='search': return {'ok':True,'items':[{'title':'Page','url':'https://example.com','text':'snippet'}]}
        stopped.set()
        release.wait(timeout=2)
        return {'ok':True,'items':[{'title':'Page','url':q,'text':'late content'}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    def forbidden(_): pytest.fail('Stop must block model calls')
    try:
        with pytest.raises(RuntimeError,match='cancelled'):
            agent_reach.answer_public('public',forbidden,forbidden,refine=forbidden,current=lambda:not stopped.is_set())
    finally: release.set()


def test_deadline_stops_reads_and_skips_supplemental_search_without_budget(monkeypatch):
    now, calls = [0], []
    monkeypatch.setattr(agent_reach.time,'monotonic',lambda:now[0])
    def retrieve(c,a,q,**kw):
        calls.append((a,kw['timeout']))
        now[0] += 2
        return {'ok':True,'items':[]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    def forbidden(_): pytest.fail('No budget for another round')
    assert agent_reach.answer_public('public',forbidden,forbidden,refine=forbidden,deadline=10)['reason']=='web_no_sources'
    assert calls == [('search',10)]
    now[0] = 9
    with pytest.raises(TimeoutError):
        agent_reach.answer_public('public',forbidden,forbidden,deadline=10)
    assert calls[-1] == ('search',1)


@pytest.mark.parametrize('sandbox',[False,True])
def test_web_worker_refines_public_only_and_keeps_sandbox_verification_boundary(monkeypatch,sandbox):
    import time
    from types import SimpleNamespace
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach:8080')
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-refine')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    monkeypatch.setattr('redis.from_url',lambda *a,**k:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
    stages=[]
    def candidate(prompt):
        data=json.loads(prompt)
        assert set(data)=={'question','sources'}
        stages.append('candidate')
        return ('{"claims":[]}' if len(data['sources'])==1 else
                '{"claims":[{"text":"Redis has 19 users.","source_ids":["s1"]}]}')
    class Provider:
        def complete(self,prompt,*,system):
            if system==VERIFY_SYSTEM:
                stages.append('verify')
                return SimpleNamespace(text='{"approved":true}')
            assert not sandbox
            return SimpleNamespace(text=candidate(prompt))
        def complete_structured(self,prompt,*,system,schema):
            assert set(json.loads(prompt))=={'question','sources'}
            assert schema['properties']['query']['maxLength']==200
            assert 'untrusted' in system
            stages.append('refine')
            return SimpleNamespace(text='{"query":"Redis release users"}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **k:Provider())
    monkeypatch.setattr('worker.voice_sandbox.complete',lambda prompt,*a,**k:candidate(prompt))
    def retrieve(c,a,q,**k):
        assert q in ('Redis users','Redis release users','https://example.com/old','https://example.com/new')
        new=q in ('Redis release users','https://example.com/new')
        return {'ok':True,'items':[{'title':'Release','url':'https://example.com/'+('new' if new else 'old'),
                                  'text':'Redis has 19 users.' if new else 'No user count.'}]}
    monkeypatch.setattr(agent_reach,'query',retrieve)
    events=[]
    stream=SimpleNamespace(xadd=lambda _,body:events.append(json.loads(body['event'])),expire=lambda *a:None)
    payload={'request_id':'refine','voice_turn':{'meeting_id':1,'holder':'session:turn'},'text':json.dumps({
        'mode':'voice_web','question':'Redis users','use_sandbox_agent':sandbox,
        'retrieval_deadline_ms':int(time.time()*1000)+30000})}
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    result=json.loads(next(e['text'] for e in events if e['type']=='message-delta'))
    assert result['text']=='Redis has 19 users.' and result['verification']==['approved']
    assert stages==['candidate','refine','candidate','verify']


def test_web_worker_expired_shared_deadline_does_not_contact_retrieval(monkeypatch):
    from types import SimpleNamespace
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-expired')
    def forbidden(*a,**k): pytest.fail('Expired job cannot contact a provider')
    monkeypatch.setattr(engine,'completion_from_env',forbidden)
    monkeypatch.setattr(agent_reach,'query',forbidden)
    events=[]
    stream=SimpleNamespace(xadd=lambda _,body:events.append(json.loads(body['event'])),expire=lambda *a:None)
    payload={'request_id':'expired','text':json.dumps({'mode':'voice_web','question':'public','retrieval_deadline_ms':1})}
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert events==[{'type':'turn-complete'}]
