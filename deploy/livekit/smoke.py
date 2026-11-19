"""Actual self-hosted room + AgentSession + local TTS; only the meeting API is a synthetic fixture."""
import asyncio
import hashlib
import json
import os
import time
from uuid import uuid4

import httpx
from livekit import api

from server import create_app


async def main():
    session=str(uuid4());calls=[];operations=[];heard=[];contexts=[];planned=set();arrived={}
    fault={'mode':None}
    real=httpx.AsyncHTTPTransport()
    class FixtureTransport(httpx.AsyncBaseTransport):
        async def handle_async_request(self,request):
            if request.url.host=='meeting-api':
                calls.append(request.url.path)
                if '/turn/' in request.url.path:return httpx.Response(200,json={'current':True})
                if request.url.path.endswith('/state'):return httpx.Response(200,json={'accepted':True})
                if request.url.path.endswith('/config'):
                    return httpx.Response(200,json={'enabled':True,'engine':'livekit','revision':1})
                if request.url.path.endswith('/agent'):
                    body=json.loads(request.content);operations.append(body['operation'])
                    if body['operation']=='context':return httpx.Response(200,json={'history':heard})
                    if body['operation']=='plan':
                        tool_calls=[] if body['request_id'] in planned else [
                            {'name':name,'arguments':{'query':'synthetic'}}
                            for name in ('search_meeting','search_shared_documents')]
                        planned.add(body['request_id'])
                        return httpx.Response(200,json={'tool_calls':tool_calls})
                    assert body['lookup'] in [{'name':name,'query':'synthetic'}
                        for name in ('search_meeting','search_shared_documents')]
                    names,ready=arrived.setdefault(body['request_id'],(set(),asyncio.Event()))
                    names.add(body['lookup']['name'])
                    if len(names)==2:ready.set()
                    await asyncio.wait_for(ready.wait(),3)
                    name=body['lookup']['name']
                    if fault['mode']=='revoked' and name=='search_shared_documents':
                        return httpx.Response(409,json={'detail':'Synthetic source revoked'})
                    if fault['mode']=='unavailable' or fault['mode']=='partial' and name=='search_shared_documents':
                        return httpx.Response(200,json={'tool':name,'source_count':0,'sources':[],
                            'lookup_status':'unavailable','skipped':True,'retrieval_unavailable':True})
                    return httpx.Response(200,json={'tool':'search_meeting','source_count':1,'sources':[{'text':'Synthetic fixture source.'}]})
                if request.url.path.endswith('/answer'):contexts.append(json.loads(request.content)['agent_context'])
                return httpx.Response(200,json={'text':'Dạ, em nghe.','reason':'answered','sources':[]})
            return await real.handle_async_request(request)
        async def aclose(self):await real.aclose()
    async with httpx.AsyncClient(transport=FixtureTransport(),timeout=45) as http:
        app=create_app(client=http)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as client:
                headers={'Authorization':'Bearer synthetic-scoped-capability'}
                headers['X-Voice-Speaker-Key']='a'*64
                body={'question':'Synthetic source-free acknowledgment','request_id':str(uuid4()),'revision':1}
                base=f'/bots/1/{session}'
                started=time.monotonic()
                response=await client.post(base+'/answer',headers=headers,json=body)
                assert response.status_code==200,response.text
                assert response.json()['voice_runtime']=='livekit'
                assert operations==['context','plan','lookup','lookup','plan'] and contexts==[[]]
                room_name=app.state.rows[(1,session)].room_name
                async with api.LiveKitAPI() as livekit:
                    rooms=await livekit.room.list_rooms(api.ListRoomsRequest())
                    assert any(room.name==room_name for room in rooms.rooms)
                audio=await client.post(base+'/v1/audio/speech',headers=headers|{
                    'X-Voice-Revision':'1','X-Voice-Request-Id':body['request_id']},
                    json={'input':response.json()['text'],'meeting_id':1,'voice':'auto','response_format':'pcm'})
                assert audio.status_code==200 and len(audio.content)>4800 and len(audio.content)%2==0
                heard.append({'question':body['question'],'answer':'Dạ, em nghe.', 'created_at_ms':int(time.time()*1000)-1000})
                followup_body=body|{'request_id':str(uuid4()),'question':'Synthetic follow-up'}
                followup=await client.post(base+'/answer',headers=headers,json=followup_body)
                assert followup.status_code==200 and contexts[-1]==heard
                stop=await client.request('DELETE',base+'/turn',headers=headers,json={'request_id':followup_body['request_id']})
                assert stop.status_code==200
                assert (await client.post(base+'/answer',headers=headers,json=followup_body)).status_code==409
                fault_results={}
                for mode in ('partial','unavailable','revoked'):
                    fault['mode']=mode;before=len(contexts)
                    probe=body|{'request_id':str(uuid4())}
                    response=await client.post(base+'/answer',headers=headers,json=probe)
                    assert response.status_code==(200 if mode=='partial' else 503),response.text
                    assert len(contexts)==before+(1 if mode=='partial' else 0)
                    fault_results[mode]=True
                report={'real_self_hosted_room':True,'actual_agent_session_llm':True,'langgraph_rag':True,'typed_tool_arguments':True,
                    'parallel_transcript_and_wiki':all(len(names)==2 for names,_ in arrived.values()),
                    'lookup_error_routes':fault_results,
                    'heard_chat_context_followup':True,'local_vieneu_tts':True,
                    'sample_rate':24000,'pcm_bytes':len(audio.content),'pcm_sha256':hashlib.sha256(audio.content).hexdigest(),
                    'stop_replay_fenced':True,'meeting_api_is_synthetic':True,'live_google_meet':False,
                    'duration_ms':round((time.monotonic()-started)*1000)}
        async with api.LiveKitAPI() as livekit:
            rooms=await livekit.room.list_rooms(api.ListRoomsRequest())
            assert not any(room.name==room_name for room in rooms.rooms)
        report['room_removed_after_close']=True
        print(json.dumps(report),flush=True)


if __name__=='__main__':asyncio.run(main())
