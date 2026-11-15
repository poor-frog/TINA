"""Linux native NS parity and real TCP bridge; backend/meeting authority are synthetic."""
import asyncio
import base64
import hmac
import io
import json
import os
import socket
import wave

import aiohttp
import httpx
import numpy as np
import uvicorn
from fastapi import FastAPI

from audio import build_audio_router, NoiseStreams
from tina_ns import NsStream


async def main():
    os.environ['LIVEKIT_API_SECRET']='synthetic-audio-smoke'
    target={'meeting':1,'session':'synthetic','url':'http://backend','model':'selected','token':'synthetic-backend'}
    payload=base64.urlsafe_b64encode(json.dumps(target).encode()).decode().rstrip('=')
    cap=payload+'.'+hmac.new(b'synthetic-audio-smoke',b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()
    frames=[];expected={};streams={};rng=np.random.default_rng(17)
    for i in range(9):
        channel=i%3;seq=i+1;pcm=rng.uniform(-.1,.1,1024 if i<6 else 777).astype('<f4')
        if channel not in streams:streams[channel]=NsStream(lambda seq,clean:expected.update({seq:clean.tobytes()}))
        streams[channel].feed(seq,pcm)
        frames.append({'type':'audio','seq':seq,'channel':channel,'stamp':1000+(i//3)*64,
            'startSample':(i//3)*1024,'audio':base64.b64encode(pcm.tobytes()).decode()})
    for stream in streams.values():stream.close()
    native=NoiseStreams();actual=[]
    for frame in frames:actual.extend(native.feed(frame))
    actual.extend(native.flush())
    assert {v['seq']:base64.b64decode(v['audio']) for v in actual}==expected

    state={'current':True,'noise_suppression':True};count=0;entered=asyncio.Event();cancelled=asyncio.Event()
    async def upstream(request):
        nonlocal count
        if request.url.host=='authority':return httpx.Response(200,json=state)
        assert request.headers['Authorization']=='Bearer synthetic-backend'
        count+=1
        if state.get('hold'):
            entered.set()
            try:await asyncio.Event().wait()
            finally:cancelled.set()
        if state.get('revoke_after'):state['current']=False
        return httpx.Response(200,json={'text':'synthetic transcript','segments':[{'start':.2,'end':.5,'text':'synthetic transcript'}],
            'duration':.064},headers={'Server-Timing':'asr_queue;dur=3'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as http:
        app=FastAPI();app.include_router(build_audio_router(http,'http://authority'))
        sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        server=uvicorn.Server(uvicorn.Config(app,log_level='critical',access_log=False,
            ws='websockets-sansio',ws_max_size=100000,ws_max_queue=16))
        task=asyncio.create_task(server.serve(sockets=[sock]))
        try:
            for _ in range(300):
                if server.started:break
                if task.done():await task
                await asyncio.sleep(.01)
            assert server.started
            base=f'http://127.0.0.1:{port}/audio/1/synthetic'
            async with aiohttp.ClientSession() as client:
                async with client.ws_connect(base+'/noise',protocols=['tina-audio-v1','cap.'+cap]) as ws:
                    assert (await ws.receive_json())=={'ready':True,'filter':'webrtc'}
                    assert ws.protocol=='tina-audio-v1'
                    for frame in frames:await ws.send_json(frame)
                    await ws.send_json({'type':'flush'})
                    remote={}
                    for _ in frames:
                        packet=await asyncio.wait_for(ws.receive_json(),3)
                        remote[packet['seq']]=base64.b64decode(packet['audio'])
                    assert remote==expected
            out=io.BytesIO()
            with wave.open(out,'wb') as w:
                w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\0\0'*1024)
            async with httpx.AsyncClient() as client:
                async def request():
                    return await client.post(base+'/v1/audio/transcriptions',headers={'Authorization':'Bearer '+cap},
                        data={'model':'selected','response_format':'verbose_json'},files={'file':('a.wav',out.getvalue(),'audio/wav')})
                response=await request()
                assert response.status_code==200 and response.json()['segments'][0]['start']==.2
                assert response.headers['server-timing']=='asr_queue;dur=3' and count==1
                state['revoke_after']=True
                assert (await request()).status_code==409
                state.update(current=True,revoke_after=False,hold=True)
                pending=asyncio.create_task(request());await asyncio.wait_for(entered.wait(),3)
                pending.cancel();await asyncio.gather(pending,return_exceptions=True)
                await asyncio.wait_for(cancelled.wait(),3)
        finally:
            server.should_exit=True;await asyncio.wait_for(task,5);sock.close()
    print(json.dumps({'native_ns_byte_parity':True,'tcp_websocket_frames':len(frames),'sample_count':sum(len(v)//4 for v in expected.values()),
        'sdk_stt_offsets':True,'stop_fence':True,'client_disconnect_cancels_asr':True}))


if __name__=='__main__':asyncio.run(main())
