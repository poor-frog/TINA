"""Private Linux TCP fixture: actual SDK STT, synthetic meeting authority and acoustic backend."""
import asyncio
from email.parser import BytesParser
import io
import os
import wave

from fastapi import FastAPI
import httpx
import numpy as np
import uvicorn

from audio import build_audio_router

os.environ['LIVEKIT_API_SECRET']='synthetic-stream-smoke'
stats={'requests':0,'windows':[]}


async def upstream(request):
    if request.url.host=='authority':return httpx.Response(200,json={'current':True,'noise_suppression':True})
    stats['requests']+=1
    message=BytesParser().parsebytes(('Content-Type: '+request.headers['Content-Type']+'\r\n\r\n').encode()+request.content)
    part=next(p for p in message.walk() if p.get_param('name',header='Content-Disposition')=='file')
    with wave.open(io.BytesIO(part.get_payload(decode=True)),'rb') as w:
        pcm=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2')
    boundaries=np.concatenate(([0],np.flatnonzero(pcm[1:]!=pcm[:-1])+1,[len(pcm)]))
    segments=[{'text':f'token{int(pcm[start])}','start':int(start)/16000,'end':int(end)/16000}
        for start,end in zip(boundaries[:-1],boundaries[1:])]
    stats['windows'].append(len(pcm))
    await asyncio.sleep(.01)
    return httpx.Response(200,json={'text':' '.join(s['text'] for s in segments),'segments':segments,'language':'en','duration':len(pcm)/16000})


http=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
app=FastAPI();app.include_router(build_audio_router(http,'http://authority'))


@app.get('/proof/stats')
def status():return stats


if __name__=='__main__':
    uvicorn.run(app,host='0.0.0.0',port=8081,access_log=False,log_level='critical',
        ws='websockets-sansio',ws_max_size=100000,ws_max_queue=16)
