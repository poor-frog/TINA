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
    assert agent_reach.answer_public('public',complete,lambda p:'{"approved":false}')['reason'] == 'web_no_sources'
    unsupported=lambda p:'{"claims":[{"text":"100 users","source_ids":["s0"]}]}'
    assert agent_reach.answer_public('public',unsupported,lambda p:'{"approved":true}')['reason'] == 'web_no_sources'


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
        assert (channel,action,text)==('web','search','What is Redis?')
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
    assert result=={'text':'Redis is a database.','links':[{'url':'https://redis.io','title':'Redis'}]}


def test_upstream_rate_limit_is_returned_without_retry(monkeypatch):
    monkeypatch.setenv('TINA_AGENT_REACH_URL','http://reach:8080')
    calls=[]
    def handler(request):
        calls.append(request)
        return httpx.Response(200,json={'channel':'github','action':'read','ok':False,
                                       'items':[],'error':{'code':'RATE_LIMITED','message':'discard'}})
    result=agent_reach.query('github','read','redis/redis',transport=httpx.MockTransport(handler))
    assert len(calls)==1 and result=={'ok':False,'items':[],'error':{'code':'RATE_LIMITED'}}
