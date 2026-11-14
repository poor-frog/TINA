"""Explicit Docker proof: real pinned Codex + MCP + public page, offline fake LLM."""
import json,os,tempfile
from pathlib import Path
from unittest.mock import patch
import httpx
from llm.codex import CodexHarness
from llm.groq_responses import groq_responses_proxy
from test_groq_cli_wire import _stream_response

calls=[]
def upstream(request):
    data=json.loads(request.content);calls.append(data)
    if len(calls)==1:
        names=[t['name'] for t in data.get('tools',[]) if 'reach_web_read' in t.get('name','')]
        assert len(names)==1, 'Granted MCP tool missing from real CLI request'
        return _stream_response({'id':'fc_reach','type':'function_call','status':'completed','call_id':'call_reach','name':names[0],'arguments':json.dumps({'query':'https://example.com'})})
    outputs=[x for x in data['input'] if x.get('type')=='function_call_output' and x.get('call_id')=='call_reach']
    assert outputs and 'https://example.com' in str(outputs[0].get('output')), 'MCP result did not reach CLI follow-up'
    return _stream_response({'id':'msg_reach','type':'message','role':'assistant','status':'completed','content':[{'type':'output_text','text':'public-source-verified','annotations':[]}]})
proxy=groq_responses_proxy
with tempfile.TemporaryDirectory() as d, patch.dict(os.environ,{'TINA_CODEX_AUTH_MODE':'groq','TINA_LLM_API_KEY':'dummy-offline-key','TINA_MOUNTS':'[]'}), patch('llm.groq_responses.groq_responses_proxy',lambda key:proxy(key,transport=httpx.MockTransport(upstream))):
    work=Path(d);h=CodexHarness();h.prepare(work)
    events=list(h.run_turn(work,'Read the public example page through reach_web_read.',model='qwen/qwen3.8-27b',allowed_tools=['mcp__tina-reach'],mcp_servers={'tina-reach':{'command':'/opt/venv/bin/python','args':['/app/llm/reach_mcp.py','--url','http://agent-reach:8080','--tools','reach_web_read']}},mcp_tools={'tina-reach':['reach_web_read']}))
    done=next(e for e in reversed(events) if e['type']=='done')
    assert done['ok'], done.get('reply')
    assert done['reply'].startswith('public-source-verified')
    assert len(calls)==2 and 'https://example.com' in done['reply']
    print(json.dumps({'real_codex_cli':True,'actual_mcp_tool_round_trip':True,'mock_llm_only':True,'actual_public_read':True,'llm_requests':len(calls),'citation_preserved':'https://example.com' in done['reply']}))
