"""Bounded per-turn PCM16 storage for the private, continuous STT connection."""
import math
import re
import asyncio
import base64
import hashlib
import json
import time
from collections import deque

from fastapi import HTTPException, WebSocket, WebSocketDisconnect
import httpx


class AudioWindows:
    def __init__(self):self.rows={}

    @property
    def held_samples(self):return sum(row['samples'] for row in self.rows.values())

    def feed(self,key,stamp,pcm):
        if (not isinstance(key,str) or not re.fullmatch(r'ch-\d{1,5}:\d{1,10}',key)
                or type(stamp) not in (int,float) or not math.isfinite(stamp)
                or not isinstance(pcm,bytes) or not pcm or len(pcm)>32000 or len(pcm)%2):raise ValueError()
        row=self.rows.get(key)
        if row is None:
            if len(self.rows)>=32:raise ValueError('Stream capacity exceeded')
            row={'chunks':deque(),'samples':0};self.rows[key]=row
        if row['chunks'] and stamp<row['chunks'][-1][0]:raise ValueError('Capture clock reversed')
        row['chunks'].append((stamp,pcm));row['samples']+=len(pcm)//2
        while row['samples']>32*16000:
            old_stamp,old=row['chunks'].popleft()
            trim=min(row['samples']-32*16000,len(old)//2)
            row['samples']-=trim
            if trim<len(old)//2:row['chunks'].appendleft((old_stamp+trim/16,old[trim*2:]))

    def window(self,key,stamp,count):
        if (not isinstance(key,str) or type(stamp) not in (int,float) or not math.isfinite(stamp)
                or type(count) is not int or not 0<count<=30*16000):raise ValueError()
        row=self.rows.get(key)
        if row is None:raise ValueError('Window unavailable')
        output=[];remaining=count;started=False
        for at,pcm in row['chunks']:
            if not started:
                offset=round((stamp-at)*16)
                if offset<0 or offset>=len(pcm)//2 or abs(at+offset/16-stamp)>.04:continue
                pcm=pcm[offset*2:];started=True
            take=min(remaining,len(pcm)//2)
            output.append(pcm[:take*2]);remaining-=take
            if not remaining:return b''.join(output)
        raise ValueError('Window unavailable')

    def close(self,key):self.rows.pop(key,None)


def add_stream_route(router,authorize,recognize,slots):
    connections=set()

    @router.websocket('/audio/{mid}/{session}/stt')
    async def continuous(socket:WebSocket,mid:int,session:str):
        protocols=socket.scope.get('subprotocols',[])
        token=next((p[4:] for p in protocols if p.startswith('cap.')),'')
        windows=AudioWindows();pending={};send_lock=asyncio.Lock();slot=object()
        async def send(value):
            async with send_lock:await socket.send_json(value)
        async def request(value,pcm):
            identifier=value['id']
            try:
                target,_=await authorize(mid,session,token)
                if slots.locked():raise HTTPException(503,'STT bridge is busy')
                async with slots:
                    fields=value.get('fields',{})
                    allowed={'model','response_format','language','timestamp_granularities','max_speech_duration_s','min_silence_duration_ms','prompt'}
                    if (not isinstance(fields,dict) or not set(fields)<=allowed
                            or any(not isinstance(v,str) or len(v)>16000 for v in fields.values())):raise ValueError()
                    headers={'X-ASR-Request-ID':identifier,'X-ASR-Source':'meeting-bot'}
                    capture=value.get('capture_ms')
                    if type(capture) in (int,float) and math.isfinite(capture) and 0<=capture<=3600000:
                        headers['X-ASR-Capture-Ms']=str(capture)
                    result,reply_headers=await recognize(target,pcm,fields,headers)
                    await authorize(mid,session,token)
                    await send({'type':'draft','id':identifier,'result':result,'server_timing':reply_headers.get('server-timing','')})
            except HTTPException as error:
                await send({'id':identifier,'status':error.status_code,'detail':error.detail})
            except (ValueError,TypeError):await send({'id':identifier,'status':422,'detail':'Invalid STT window'})
            except (httpx.HTTPError,TimeoutError):await send({'id':identifier,'status':503,'detail':'ASR transport unavailable'})
            except Exception:await send({'id':identifier,'status':502,'detail':'STT bridge failed'})

        try:
            await authorize(mid,session,token)
            if len(connections)>=8:raise HTTPException(503,'STT connection capacity exceeded')
            connections.add(slot)
            await socket.accept(subprotocol='tina-audio-v1')
            await send({'ready':True});checked=time.monotonic()
            while True:
                try:line=await asyncio.wait_for(socket.receive_text(),15)
                except TimeoutError:
                    await authorize(mid,session,token)
                    if any(not task.done() for task in pending.values()):continue
                    break
                if len(line)>100000:raise ValueError()
                value=json.loads(line)
                if not isinstance(value,dict):raise ValueError()
                if time.monotonic()-checked>=1:
                    await authorize(mid,session,token);checked=time.monotonic()
                for key,task in list(pending.items()):
                    if task.done():
                        await asyncio.gather(task,return_exceptions=True);pending.pop(key)
                kind=value.get('type')
                if kind=='audio':
                    raw=base64.b64decode(value['audio'],validate=True)
                    windows.feed(value['stream'],value['stamp'],raw)
                elif kind=='close_turn':windows.close(value['stream'])
                elif kind=='cancel':
                    task=pending.get(value.get('id'))
                    if task:task.cancel()
                elif kind=='window':
                    identifier=value.get('id')
                    if not isinstance(identifier,str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}',identifier):raise ValueError()
                    if identifier in pending:raise ValueError()
                    if len(pending)>=8:
                        await send({'id':identifier,'status':503,'detail':'STT bridge is busy'});continue
                    try:
                        pcm=windows.window(value.get('stream'),value.get('start_ms'),value.get('samples'))
                        if value.get('sha256')!=hashlib.sha256(pcm).hexdigest():raise ValueError()
                    except (ValueError,TypeError):
                        await send({'id':identifier,'status':409,'detail':'STT window unavailable'});continue
                    pending[identifier]=asyncio.create_task(request(value,pcm))
                else:raise ValueError()
        except (WebSocketDisconnect,HTTPException,TimeoutError,ValueError,KeyError,TypeError):pass
        finally:
            for task in pending.values():task.cancel()
            await asyncio.gather(*pending.values(),return_exceptions=True)
            windows.rows.clear();connections.discard(slot)
            try:await socket.close()
            except RuntimeError:pass
