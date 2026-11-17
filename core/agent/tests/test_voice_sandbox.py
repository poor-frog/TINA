"""Voice harness isolation, bounded cancellation and independent source verification."""
import json
from types import SimpleNamespace

import pytest

from worker import voice_sandbox


def test_runner_has_no_native_tools_mcp_writes_or_cli_resume(tmp_path):
    calls=[]
    class Harness:
        def prepare(self, work, chat_root=None): assert work==chat_root==tmp_path
        def run_turn(self, work, prompt, **kwargs):
            calls.append((prompt,kwargs))
            yield {'type':'message-delta','text':'Unverified draft must not escape'}
            yield {'type':'done','ok':True,'reply':'{"tool_calls":[]}'}
    result=voice_sandbox.run({'system':'JSON only','prompt':'Authorized question and excerpts','schema':{},'model':'chosen'},tmp_path,Harness())
    assert result=={'ok':True,'reply':'{"tool_calls":[]}'}
    assert calls[0][1]['allowed_tools']==() and calls[0][1]['session'] is None
    assert calls[0][1]['output_schema']=={}
    assert calls[0][1]['mcp_servers']=={} and json.loads((tmp_path/'mcp-empty.json').read_text())=={'mcpServers':{}}
    assert (tmp_path/'CLAUDE.md').read_text()=='JSON only'
    assert 'Authorized question' not in (tmp_path/'GEMINI.md').read_text()


@pytest.mark.parametrize('mode,repaired,valid', [
    ('voice', '{"claims":[{"text":"Lan phụ trách demo.","source_ids":["s0"]}]}', True),
    ('voice', 'still malformed', False),
    ('voice', '{"claims":[],"tool_calls":[{"name":"search_meeting","query":"demo"}]}', False),
    ('voice_plan', '{"tool_calls":[{"name":"search_meeting","arguments":{"query":"demo"}}]}', True),
    ('voice_plan', '{"tool_calls":[{"name":"search_web","query":"private demo"}]}', False),
])
@pytest.mark.parametrize('stopped', [False, True])
def test_sandbox_format_repairs_once_with_existing_validators_and_turn_fences(monkeypatch, mode, repaired, valid, stopped):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VOICE_FORMAT_SYSTEM, VOICE_PLAN_SYSTEM, VERIFY_SYSTEM
    from shared.voice_schema import voice_schema
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-format')
    monkeypatch.setenv('REDIS_URL', 'redis://synthetic')
    held = ['session:turn']; events = []; candidates = []; repairs = []; reviews = []
    monkeypatch.setattr('redis.from_url', lambda *a, **k: SimpleNamespace(get=lambda _: held[0], close=lambda: None))
    def candidate(prompt, system, schema, **kwargs):
        candidates.append(schema)
        expected = voice_schema('plan', tools=['search_meeting']) if mode == 'voice_plan' else voice_schema('answer', [{'id':'s0'}])
        assert schema == expected
        return 'Prose around {"claims":[]} must not be spoken.'
    def structured(prompt, *, system, schema):
        if system == VERIFY_SYSTEM:
            reviews.append(True); return SimpleNamespace(text='{"approved":true}')
        if mode == 'voice_plan': assert system.startswith(VOICE_PLAN_SYSTEM)
        else: assert system == VOICE_FORMAT_SYSTEM
        repairs.append(json.loads(prompt))
        if stopped: held[0] = None
        return SimpleNamespace(text=repaired)
    monkeypatch.setattr(voice_sandbox, 'complete', candidate)
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete_structured=structured))
    source = {'mode':mode, 'question':'Ai phụ trách demo?', 'use_sandbox_agent':True, 'tools_remaining':0,
              'sources':[{'id':'s0','quote':'Lan phụ trách demo.'}], 'available_tools':['search_meeting']}
    payload = {'request_id':'format', 'voice_turn':{'meeting_id':1,'holder':'session:turn'}, 'text':json.dumps(source)}
    stream = SimpleNamespace(xadd=lambda _, e: events.append(json.loads(e['event'])), expire=lambda *_: None)
    engine._run_meeting_knowledge(stream, 'out', {'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert len(candidates) == len(repairs) == 1
    assert 'Prose around' in repairs[0]['invalid_output']
    output = [json.loads(e['text']) for e in events if e['type']=='message-delta']
    if stopped or not valid and mode == 'voice_plan':
        assert not output and not reviews
    elif valid:
        if mode == 'voice_plan': assert output == [json.loads(repaired)]
        else: assert output[0]['verification'] == ['approved']
        assert len(reviews) == int(mode == 'voice')
    else:
        assert output == [{'claims':[], 'reason':'generation_format_invalid'}] and not reviews
    assert events[-1] == {'type':'turn-complete'}


@pytest.mark.parametrize('mode', ['voice', 'voice_plan'])
def test_harness_service_failure_does_not_become_a_format_retry_or_direct_fallback(monkeypatch, mode):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    monkeypatch.setenv('TINA_CHAT_SESSION', 'meeting-knowledge-service-error')
    monkeypatch.setenv('REDIS_URL', 'redis://synthetic')
    monkeypatch.setattr('redis.from_url', lambda *a, **k: SimpleNamespace(get=lambda _: 'session:turn', close=lambda: None))
    def unavailable(*a, **k): raise RuntimeError('synthetic harness unavailable')
    def unexpected(*a, **k): pytest.fail('Service failures must not trigger format repair')
    monkeypatch.setattr(voice_sandbox, 'complete', unavailable)
    monkeypatch.setattr(engine, 'completion_from_env', lambda **_: SimpleNamespace(complete_structured=unexpected))
    source = {'mode':mode, 'question':'Ai?', 'use_sandbox_agent':True, 'sources':[], 'available_tools':[]}
    events = []; payload = {'request_id':'error', 'voice_turn':{'meeting_id':1,'holder':'session:turn'}, 'text':json.dumps(source)}
    engine._run_meeting_knowledge(SimpleNamespace(xadd=lambda _, e:events.append(json.loads(e['event'])),expire=lambda *_:None),
        'out', {'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert events == [{'type':'turn-complete'}]


def test_well_formed_but_unsupported_sandbox_answer_is_not_a_format_error(monkeypatch):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM, VOICE_REPAIR_SYSTEM
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-unsupported')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    monkeypatch.setattr('redis.from_url',lambda *a,**k:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
    raw='{"claims":[{"text":"Minh phụ trách demo.","source_ids":["s0"]}]}'
    monkeypatch.setattr(voice_sandbox,'complete',lambda *a,**k:raw)
    systems=[];events=[]
    def structured(prompt,*,system,schema):
        systems.append(system)
        assert system in (VERIFY_SYSTEM,VOICE_REPAIR_SYSTEM)
        return SimpleNamespace(text=raw if system==VOICE_REPAIR_SYSTEM else '{"approved":false,"reason":"contradiction","claim_indexes":[0]}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete_structured=structured))
    source={'mode':'voice','question':'Ai?','use_sandbox_agent':True,'sources':[{'id':'s0','quote':'Lan phụ trách demo.'}]}
    payload={'request_id':'unsupported','voice_turn':{'meeting_id':1,'holder':'session:turn'},'text':json.dumps(source)}
    engine._run_meeting_knowledge(SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None),
        'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert json.loads(events[0]['text'])['reason']=='verification_rejected'
    assert systems.count(VOICE_REPAIR_SYSTEM)==1 and systems.count(VERIFY_SYSTEM)==2


@pytest.mark.parametrize('cancel', [False,True])
def test_process_deadline_and_stop_kill_the_harness_group(monkeypatch,cancel):
    monkeypatch.setenv('TINA_MOUNTS','[]')
    monkeypatch.setenv('REDIS_URL','private-data-plane')
    monkeypatch.setenv('TINA_AGENT_IDENTITY_TOKEN','private-identity-token')
    real=voice_sandbox.subprocess.Popen;processes=[]
    def spawn(args,**kwargs):
        assert 'REDIS_URL' not in kwargs['env'] and 'TINA_AGENT_IDENTITY_TOKEN' not in kwargs['env']
        process=real([args[0],'-c','import time;time.sleep(60)'],**kwargs)
        processes.append(process);return process
    monkeypatch.setattr(voice_sandbox.subprocess,'Popen',spawn)
    checks=[]
    def current():
        checks.append(True);return not cancel or len(checks)==1
    with pytest.raises((TimeoutError,RuntimeError)):
        voice_sandbox.complete('input','system',{},timeout=.1,current=current)
    assert processes and processes[0].poll() is not None


def test_personal_workspace_mounts_refuse_sandbox_start(monkeypatch):
    monkeypatch.setenv('TINA_MOUNTS','[{"path":"/private/workspace"}]')
    with pytest.raises(RuntimeError,match='must not mount'):
        voice_sandbox.complete('input','system',{},timeout=1,current=lambda:True)


def test_timeout_kills_descendants_after_the_group_leader_exits(monkeypatch,tmp_path):
    import os
    import signal
    import sys
    import time
    monkeypatch.setenv('TINA_MOUNTS','[]')
    heartbeat=tmp_path/'heartbeat';real=voice_sandbox.subprocess.Popen;processes=[]
    child="import sys,time;from pathlib import Path\np=Path(sys.argv[1])\nwhile True:p.write_text(str(time.monotonic_ns()));time.sleep(.01)"
    parent=("import subprocess,sys,time,json;from pathlib import Path;"
            "subprocess.Popen([sys.executable,'-c',sys.argv[1],sys.argv[2]]);"
            "p=Path(sys.argv[2])\nwhile not p.exists():time.sleep(.01)\n"
            "print(json.dumps({'ok':True,'reply':'{}'}),flush=True)")
    def spawn(args,**kwargs):
        process=real([sys.executable,'-c',parent,child,str(heartbeat)],**kwargs)
        processes.append(process);return process
    monkeypatch.setattr(voice_sandbox.subprocess,'Popen',spawn)
    try:
        with pytest.raises(TimeoutError):voice_sandbox.complete('input','system',{},timeout=1,current=lambda:True)
        assert processes[0].poll()==0 and heartbeat.exists()
        last=heartbeat.read_text();time.sleep(.15)
        assert heartbeat.read_text()==last, 'no descendant may keep running after timeout'
    finally:
        for process in processes:
            try:os.killpg(process.pid,signal.SIGKILL)
            except ProcessLookupError:pass
            process.communicate(timeout=2)


@pytest.mark.parametrize('stop_at',['candidate','verify'])
def test_stop_prevents_later_model_calls_and_worker_publication(monkeypatch,stop_at):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-stopped')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    held=['session:turn'];events=[];calls=[];closed=[]
    monkeypatch.setattr('redis.from_url',lambda *a,**kw:SimpleNamespace(get=lambda _:held[0],close=lambda:closed.append(True)))
    def candidate(*args,**kwargs):
        if stop_at=='candidate':held[0]=None
        return '{"claims":[{"text":"Lan phụ trách demo.","source_ids":["s0"]}]}'
    def structured(prompt,*,system,schema):
        calls.append(system);held[0]=None
        return SimpleNamespace(text='{"approved":false,"reason":"unsupported_claim","claim_indexes":[0]}')
    monkeypatch.setattr(voice_sandbox,'complete',candidate)
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete_structured=structured))
    payload={'request_id':'stopped','voice_turn':{'meeting_id':1,'holder':'session:turn'},
             'text':json.dumps({'mode':'voice','question':'Ai?','use_sandbox_agent':True,'sources':[{'id':'s0','quote':'Lan phụ trách demo.'}]})}
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert calls==([VERIFY_SYSTEM] if stop_at=='verify' else [])
    assert events==[{'type':'turn-complete'}] and closed==[True]


@pytest.mark.parametrize('cancel',[False,True])
def test_planning_timeout_fallback_requires_a_current_turn(monkeypatch,cancel):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-plan-timeout')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    held=['session:turn'];events=[]
    monkeypatch.setattr('redis.from_url',lambda *a,**kw:SimpleNamespace(get=lambda _:held[0],close=lambda:None))
    def timeout(*a,**kw):
        if cancel:held[0]=None
        raise TimeoutError()
    monkeypatch.setattr(voice_sandbox,'complete',timeout)
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace())
    payload={'request_id':'plan-timeout','voice_turn':{'meeting_id':1,'holder':'session:turn'},
             'text':json.dumps({'mode':'voice_plan','question':'Ai?','use_sandbox_agent':True,'available_tools':[]})}
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert any(e.get('type')=='message-delta' for e in events) is not cancel
    assert events[-1]=={'type':'turn-complete'}


@pytest.mark.parametrize('mode',['voice_source_intent','voice_summary_verify'])
def test_api_only_sandbox_stages_also_discard_results_after_stop(monkeypatch,mode):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-api-stage')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    held=['session:turn'];events=[];calls=[]
    monkeypatch.setattr('redis.from_url',lambda *a,**kw:SimpleNamespace(get=lambda _:held[0],close=lambda:None))
    def completion(*args,**kwargs):
        calls.append(True);held[0]=None
        return SimpleNamespace(text='{"route":"meeting"}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete_structured=completion,complete=completion))
    def unexpected_harness(*a,**kw):raise AssertionError('API-only stages must not start CLI')
    monkeypatch.setattr(voice_sandbox,'complete',unexpected_harness)
    source={'mode':mode,'question':'Synthetic','sources':[],'use_sandbox_agent':True}
    if mode=='voice_summary_verify':
        source.update(sources=[{'id':'s0','quote':'Lan phụ trách demo.'}],
                      proposed_reply={'claims':[{'text':'Lan phụ trách demo.','source_ids':['s0']}]})
    payload={'request_id':'api-stage','voice_turn':{'meeting_id':1,'holder':'session:turn'},'text':json.dumps(source)}
    stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    assert calls==[True] and events==[{'type':'turn-complete'}]


def test_knowledge_dispatch_removes_all_account_mounts_and_chat_tools(monkeypatch):
    from control_plane import dispatch
    from shared.config import load_settings
    from shared.units import make_dispatch,entrypoint,MEETING_KNOWLEDGE_PREFIX
    monkeypatch.setattr(dispatch,'build_mount_set',lambda *_:[{'path':'/private/alice','write':True,'primary':True},
        {'path':'/private/shared-project','write':True}])
    invocation=make_dispatch(subject='alice',trigger='message',start=entrypoint(inline=MEETING_KNOWLEDGE_PREFIX+'{}'),
        workspaces=[{'id':'alice','mode':'ro'}],context={'kind':'none','session':'meeting-knowledge-opaque'})
    env=dispatch.build_unit_env(load_settings(),invocation,unit_id='synthetic',token='synthetic')
    assert env['TINA_MOUNTS']==env['TINA_WORKSPACES']==env['TINA_UNIT_TOOLS']=='[]'
    assert env['TINA_WORKSPACE_PATH'].startswith('/tmp/')


@pytest.mark.parametrize('approved',[True,False])
def test_harness_candidate_still_requires_independent_verification(monkeypatch,approved):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-sandbox-test')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    monkeypatch.setattr('redis.from_url', lambda *args,**kwargs:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
    calls=[];events=[]
    def candidate(prompt,system,schema,**kwargs):
        assert kwargs['current']();calls.append(json.loads(prompt))
        return '{"claims":[{"text":"Lan phụ trách demo.","source_ids":["s0"]}]}'
    monkeypatch.setattr(voice_sandbox,'complete',candidate)
    def structured(prompt,*,system,schema):
        return SimpleNamespace(text=json.dumps({'approved':approved}) if system==VERIFY_SYSTEM else '{"claims":[]}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:SimpleNamespace(complete_structured=structured))
    source={'mode':'voice','question':'Ai phụ trách demo?','sources':[{'id':'s0','quote':'Lan phụ trách demo.'}], 'use_sandbox_agent':True}
    payload={'request_id':'sandbox-test','text':json.dumps(source),'voice_turn':{'meeting_id':1,'holder':'session:turn'}}
    stream=SimpleNamespace(get=lambda _:'session:turn',xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    result=json.loads(events[0]['text'])
    assert len(calls)==1
    assert bool(result['claims']) is approved
    if approved: assert result['verification']==['approved']


def test_explicit_empty_tool_grant_disables_codex_claude_and_antigravity_native_access():
    import tomllib
    from llm.codex import CodexHarness
    from llm.claude_code import build_argv
    from llm.antigravity import _permission_settings
    argv=CodexHarness()._argv(no_tools=True)
    config=tomllib.loads('\n'.join(argv[i+1] for i,arg in enumerate(argv) if arg=='-c'))
    for name in ('shell_tool','unified_exec','apps','browser_use','computer_use','multi_agent','view_image'):
        assert config['features'][name] is False
    argv=build_argv('Synthetic',allowed_tools=[])
    assert argv[argv.index('--tools')+1]==''
    permissions=_permission_settings([{'path':'/tmp/voice','write':False}],set(),[])['permissions']
    assert not permissions['allow'] and 'read_file(*)' in permissions['deny']


def test_provider_native_web_remains_an_external_tool_before_sandbox_generation(monkeypatch):
    from worker import engine
    from shared.meeting_knowledge import PREFIX
    from shared.voice_knowledge import VERIFY_SYSTEM
    monkeypatch.delenv('TINA_AGENT_REACH_URL',raising=False)
    monkeypatch.setenv('TINA_CHAT_SESSION','meeting-knowledge-web-sandbox')
    monkeypatch.setenv('REDIS_URL','redis://synthetic')
    monkeypatch.setattr('redis.from_url',lambda *a,**kw:SimpleNamespace(get=lambda _:'session:turn',close=lambda:None))
    class Provider:
        def search(self,question):
            assert question=='What is Redis?'
            return SimpleNamespace(text='Redis is a database.',sources=[{'url':'https://redis.io','title':'Redis'}])
        def complete(self,prompt,*,system):
            assert system==VERIFY_SYSTEM and 'PRIVATE ROOM' not in prompt
            return SimpleNamespace(text='{"approved":true}')
    monkeypatch.setattr(engine,'completion_from_env',lambda **_:Provider())
    def candidate(prompt,system,schema,**kwargs):
        assert 'PRIVATE ROOM' not in prompt and kwargs['current']()
        return '{"claims":[{"text":"Redis is a database.","source_ids":["s0"]}]}'
    monkeypatch.setattr(voice_sandbox,'complete',candidate)
    source={'mode':'voice_web','question':'What is Redis?','use_sandbox_agent':True,'sources':[{'quote':'PRIVATE ROOM'}]}
    payload={'request_id':'web-sandbox','text':json.dumps(source),'voice_turn':{'meeting_id':1,'holder':'session:turn'}}
    events=[];stream=SimpleNamespace(xadd=lambda _,e:events.append(json.loads(e['event'])),expire=lambda *_:None)
    engine._run_meeting_knowledge(stream,'out',{'entrypoint':{'inline':PREFIX+json.dumps(payload)}})
    result=json.loads(events[0]['text'])
    assert result['text']=='Redis is a database.' and result['links'][0]['url']=='https://redis.io'
