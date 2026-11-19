"""Pinned DTLN over real TCP: exact 64 ms/tail frames, channel isolation and three sessions."""
import asyncio
import base64
import hmac
import json
import os
import socket
import time

import aiohttp
from fastapi import FastAPI
import httpx
import numpy as np
import uvicorn

from audio import build_audio_router,noise_ready
from dtln import stream


async def main():
    os.environ['TINA_AUDIO_DENOISER']='dtln';os.environ['LIVEKIT_API_SECRET']='synthetic-dtln-proof'
    assert noise_ready()['id']=='dtln'
    rng=np.random.default_rng(41)
    frames=[];expected={};local={};count=80
    for i in range(count):
        for channel in range(2):
            seq=i*2+channel;size=1024 if i<count-1 else 777
            samples=rng.uniform(-.15,.15,size).astype('<f4') if channel==0 else np.zeros(size,dtype='<f4')
            if channel not in local:local[channel]=stream(lambda seq,pcm:expected.update({seq:pcm.tobytes()}))
            local[channel].feed(seq,samples)
            frames.append({'type':'audio','seq':seq,'channel':channel,'stamp':1000+i*64,'startSample':i*1024,
                'audio':base64.b64encode(samples.tobytes()).decode()})
    for instance in local.values():instance.close()
    async def authority(request):return httpx.Response(200,json={'current':True,'noise_suppression':True})
    async with httpx.AsyncClient(transport=httpx.MockTransport(authority)) as http:
        app=FastAPI();app.include_router(build_audio_router(http,'http://authority'))
        sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        server=uvicorn.Server(uvicorn.Config(app,log_level='critical',access_log=False,
            ws='websockets-sansio',ws_max_size=100000,ws_max_queue=16))
        running=asyncio.create_task(server.serve(sockets=[sock]))
        try:
            for _ in range(300):
                if server.started:break
                await asyncio.sleep(.01)
            assert server.started
            async def session(mid):
                payload=base64.urlsafe_b64encode(json.dumps({'meeting':mid,'session':'synthetic','url':'http://backend','token':'','model':''}).encode()).decode().rstrip('=')
                cap=payload+'.'+hmac.new(b'synthetic-dtln-proof',b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()
                actual={}
                async with aiohttp.ClientSession() as client:
                    async with client.ws_connect(f'http://127.0.0.1:{port}/audio/{mid}/synthetic/noise',protocols=['tina-audio-v1','cap.'+cap]) as ws:
                        assert await ws.receive_json()=={'ready':True,'filter':'dtln'}
                        async def receive():
                            for _ in frames:
                                item=await asyncio.wait_for(ws.receive_json(),5)
                                assert item['seq'] not in actual
                                actual[item['seq']]=base64.b64decode(item['audio'])
                        receiving=asyncio.create_task(receive())
                        for i in range(0,len(frames),2):
                            for frame in frames[i:i+2]:await ws.send_json(frame)
                            # Pace the fixture so the shared bridge's realtime deadline is exercised.
                            await asyncio.sleep(.064)
                        await ws.send_json({'type':'flush'});await receiving
                assert actual.keys()==expected.keys()
                for key in expected:np.testing.assert_allclose(np.frombuffer(actual[key],dtype='<f4'),np.frombuffer(expected[key],dtype='<f4'),atol=1e-6)
                quiet=max(float(np.max(np.abs(np.frombuffer(value,dtype='<f4')))) for key,value in actual.items() if key%2)
                assert quiet<1e-4
                return len(actual)
            started=time.perf_counter();counts=await asyncio.gather(*(session(mid) for mid in (1,2,3)))
            print(json.dumps({'dtln_cpu':True,'sessions':3,'channels_per_session':2,'frames_per_session':counts,
                'frame_ms':64,'tail_samples':777,'source_sample_parity':True,'no_cross_channel_leakage':True,
                'elapsed_seconds':round(time.perf_counter()-started,3)}))
        finally:
            server.should_exit=True;await asyncio.wait_for(running,5);sock.close()


if __name__=='__main__':asyncio.run(main())
