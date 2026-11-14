"""Observe the existing pinned Silero logic inside the LiveKit worker; no turn authority."""
import base64
import asyncio
import json
import math
import os
import re
import time
from pathlib import Path

import numpy as np
from fastapi import HTTPException, WebSocket, WebSocketDisconnect


class VadObserver:
    def __init__(self,directory,factory=None):
        if factory is None:
            from tina_meeting_voice.vad_monitor import VadMonitor
            factory=VadMonitor
        self.events=[];self.activity={};self.inputs={};self.generation=0;self.phase='LISTENING'
        self.engine=factory(directory,self.emit,time.monotonic)

    def emit(self,event):
        if event.get('event')=='activity':self.activity[event['channel']]=event
        self.events.append(dict(event,generation=self.generation))

    def handle(self,value):
        self.events=[]
        if not isinstance(value,dict):raise ValueError()
        kind=value.get('type')
        if kind=='control':
            generation=value.get('generation');phase=value.get('state')
            if type(generation) is not int or generation<0 or phase not in (
                    'OFF','LISTENING','CAPTURING','THINKING','SPEAKING','QUIET','ERROR'):raise ValueError()
            if generation<self.generation:return []
            if generation!=self.generation or phase in ('OFF','THINKING','SPEAKING','QUIET','ERROR'):
                self.activity.clear();self.inputs.clear()
            self.generation=generation;self.phase=phase
            self.engine.control(phase)
        elif kind=='audio':
            channel,stamp=value.get('channel'),value.get('stamp');participant=value.get('participant')
            if (type(channel) is not int or not 0<=channel<65536 or type(stamp) not in (int,float)
                    or not math.isfinite(stamp) or participant is not None
                    and (not isinstance(participant,str) or len(participant)>512)):raise ValueError()
            raw=base64.b64decode(value['audio'],validate=True)
            if not raw or len(raw)>64000 or len(raw)%4:raise ValueError()
            pcm=np.frombuffer(raw,dtype='<f4')
            if not np.isfinite(pcm).all():raise ValueError()
            old=self.inputs.get(channel)
            if old and (stamp<old[0] or stamp-old[0]>1000 or participant and old[1] and participant!=old[1]):
                self.activity.pop(channel,None)
            self.engine.feed(channel,participant,pcm,stamp)
            if channel in self.engine.channels:self.inputs[channel]=(stamp,participant)
            for key in list(self.inputs):
                if key not in self.engine.channels:self.inputs.pop(key,None);self.activity.pop(key,None)
        elif kind=='endpoint':
            if value.get('generation')!=self.generation:return []
            identifier=value.get('id');channel=value.get('channel');end=value.get('end_ms');asr_end=value.get('asr_end_ms')
            if (not isinstance(identifier,str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}',identifier)
                    or type(channel) is not int or not 0<=channel<65536 or type(end) not in (int,float)
                    or not math.isfinite(end) or type(value.get('local_ready')) is not bool):raise ValueError()
            row=self.activity.get(channel);speech_end=row.get('endMs') if row else None
            ready=(self.phase=='CAPTURING' and row is not None and row.get('speech') is False
                and type(speech_end) in (float,int) and math.isfinite(speech_end) and abs(speech_end-end)<=2
                and type(asr_end) in (float,int) and math.isfinite(asr_end) and asr_end>=speech_end-2)
            self.events.append({'event':'endpoint','generation':self.generation,'id':identifier,
                'channel':channel,'ready':bool(ready),'end_ms':speech_end})
        else:raise ValueError()
        return self.events

    def close(self):self.engine.close();self.activity.clear();self.inputs.clear();self.events=[]


def verify_assets():
    from tina_meeting_voice.assets import verify_vad
    return verify_vad(Path('/models/meeting-voice'))


def add_vad_route(router,authorize,native):
    connections=set()
    @router.websocket('/audio/{mid}/{session}/vad')
    async def observe(socket:WebSocket,mid:int,session:str):
        token=next((p[4:] for p in socket.scope.get('subprotocols',[]) if p.startswith('cap.')),'')
        observer=None;slot=object()
        async def permit():
            _,policy=await authorize(mid,session,token)
            if policy.get('voice_enabled') is not True:raise HTTPException(409,'Voice observation disabled')
        try:
            if os.getenv('TINA_LIVEKIT_VAD_SHADOW')!='1':raise HTTPException(409,'Voice observation disabled')
            await permit()
            if len(connections)>=8:raise HTTPException(503,'VAD observer capacity exceeded')
            connections.add(slot)
            await socket.accept(subprotocol='tina-audio-v1')
            observer=await native(VadObserver,Path('/models/meeting-voice'))
            await socket.send_json({'event':'vad-ready'});checked=time.monotonic()
            while True:
                try:line=await asyncio.wait_for(socket.receive_text(),15)
                except TimeoutError:
                    await permit();checked=time.monotonic();continue
                if len(line)>100000:raise ValueError()
                if time.monotonic()-checked>=1:await permit();checked=time.monotonic()
                events=await native(observer.handle,json.loads(line))
                for event in events:await socket.send_json(event)
        except (WebSocketDisconnect,HTTPException,ValueError,KeyError,TypeError,TimeoutError,RuntimeError,OSError):pass
        finally:
            if observer:observer.close()
            connections.discard(slot)
            try:await socket.close()
            except RuntimeError:pass
