"""Real pinned Silero over private TCP: synthetic authority, local VieNeu sample, three sessions."""
import asyncio
import base64
import hmac
import json
import os
from pathlib import Path
import socket
import sys
import time

import aiohttp
from fastapi import FastAPI
import httpx
import numpy as np
from livekit import rtc
import uvicorn

from audio import build_audio_router
from tina_meeting_voice.vad_monitor import VadMonitor


async def main():
    tts=json.load(sys.stdin)
    os.environ['LIVEKIT_API_SECRET']='synthetic-vad-proof'
    os.environ['TINA_LIVEKIT_VAD_SHADOW']='1'
    async with httpx.AsyncClient() as client:
        reply=await client.post(tts['url'].rstrip('/')+'/v1/audio/speech',headers={'X-API-Key':tts['token']},
            json={'model':'tts-1','input':'Lan phụ trách demo vào thứ sáu.','voice':'auto','response_format':'pcm'},timeout=60)
        assert reply.status_code==200 and reply.headers['x-audio-sample-rate']=='24000'
        assert 0<len(reply.content)<2000000
    resampler=rtc.AudioResampler(24000,16000,num_channels=1)
    source=resampler.push(rtc.AudioFrame(data=reply.content,sample_rate=24000,num_channels=1,samples_per_channel=len(reply.content)//2))+resampler.flush()
    speech=np.frombuffer(b''.join(bytes(frame.data) for frame in source),dtype='<i2').astype(np.float32)/32768
    pcm=np.concatenate((np.zeros(16000,dtype=np.float32),speech,np.zeros(24000,dtype=np.float32)))
    async def authority(request):return httpx.Response(200,json={'current':True,'voice_enabled':True})
    async with httpx.AsyncClient(transport=httpx.MockTransport(authority)) as http:
        app=FastAPI();app.include_router(build_audio_router(http,'http://authority'))
        sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        server=uvicorn.Server(uvicorn.Config(app,log_level='critical',access_log=False,
            ws='websockets-sansio',ws_max_size=100000,ws_max_queue=16))
        serving=asyncio.create_task(server.serve(sockets=[sock]))
        try:
            for _ in range(300):
                if server.started:break
                await asyncio.sleep(.01)
            assert server.started
            async def session(mid):
                payload=base64.urlsafe_b64encode(json.dumps({'meeting':mid,'session':'synthetic','url':'http://backend','token':'','model':''}).encode()).decode().rstrip('=')
                cap=payload+'.'+hmac.new(b'synthetic-vad-proof',b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()
                events=[];local=VadMonitor(Path('/models/meeting-voice'),events.append,time.monotonic)
                remote=[]
                try:
                    async with aiohttp.ClientSession() as client:
                        async with client.ws_connect(f'http://127.0.0.1:{port}/audio/{mid}/synthetic/vad',protocols=['tina-audio-v1','cap.'+cap]) as ws:
                            assert (await ws.receive_json())['event']=='vad-ready'
                            await ws.send_json({'type':'control','state':'CAPTURING','generation':0})
                            for offset in range(0,len(pcm),1024):
                                frame=pcm[offset:offset+1024];stamp=1000+offset/16
                                local.feed(0,'caller',frame,stamp)
                                await ws.send_json({'type':'audio','channel':0,'participant':'caller','stamp':stamp,
                                    'audio':base64.b64encode(frame.astype('<f4').tobytes()).decode()})
                                local.feed(1,'other',np.zeros(len(frame),dtype=np.float32),stamp)
                                await ws.send_json({'type':'audio','channel':1,'participant':'other','stamp':stamp,
                                    'audio':base64.b64encode(np.zeros(len(frame),dtype='<f4').tobytes()).decode()})
                            ended=[e for e in events if e.get('event')=='activity' and e.get('speech') is False and e.get('endMs') is not None]
                            assert ended and any(e.get('speech') is True for e in events)
                            end=ended[-1]['endMs']
                            await ws.send_json({'type':'endpoint','id':'candidate','generation':0,'channel':0,'end_ms':end,'asr_end_ms':end,'local_ready':True})
                            while True:
                                event=await asyncio.wait_for(ws.receive_json(),5)
                                if event['event']=='endpoint':assert event['ready'] is True;break
                                if event['event']=='activity':remote.append(event)
                            def transitions(rows):
                                result=[];last={}
                                for e in rows:
                                    if e.get('event')!='activity' or last.get(e['channel'])==e['speech']:continue
                                    last[e['channel']]=e['speech'];result.append((e['channel'],e['speech'],e['endMs'],e['stamp']))
                                return result
                            assert transitions(remote)==transitions(events)
                            assert not any(e['channel']==1 and e['speech'] for e in remote)
                            return len(transitions(remote))
                finally:local.close()
            counts=await asyncio.gather(*(session(mid) for mid in (1,2,3)))
            print(json.dumps({'real_silero':True,'sessions':3,'channels_per_session':2,
                'activity_transitions':counts,'source_endpoint_parity':True,'candidates_ready':3,'shadow_only':True}))
        finally:
            server.should_exit=True;await asyncio.wait_for(serving,5);sock.close()


if __name__=='__main__':asyncio.run(main())
