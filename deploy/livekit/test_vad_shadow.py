import base64
import hmac
import json
from pathlib import Path

import numpy as np
import pytest
import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from vad_shadow import VadObserver
from audio import build_audio_router


class Monitor:
    def __init__(self,directory,emit,clock):
        self.emit=emit;self.channels={};self.closed=False
        emit({'event':'state','state':'LISTENING'})
    def control(self,state):self.channels.clear();self.emit({'event':'state','state':state})
    def feed(self,channel,participant,pcm,stamp):
        self.channels[channel]={}
        self.emit({'event':'activity','channel':channel,'speech':bool(np.max(pcm)),
                   'endMs':stamp+len(pcm)/16,'stamp':stamp+len(pcm)/16})
    def close(self):self.closed=True


def frame(channel=1,stamp=1000,loud=False):
    return {'type':'audio','channel':channel,'stamp':stamp,'participant':'speaker',
        'audio':base64.b64encode(np.full(1024,float(loud),dtype='<f4').tobytes()).decode()}


def test_shadow_vad_preserves_source_clock_and_only_evaluates_current_caller_with_covered_tail():
    observer=VadObserver(Path('/unused'),factory=Monitor)
    observer.handle({'type':'control','state':'CAPTURING','generation':2})
    event=observer.handle(frame())[0]
    assert event['generation']==2 and event['stamp']==1064
    candidate={'type':'endpoint','id':'request-a','generation':2,'channel':1,'end_ms':1064,
        'asr_end_ms':1064,'local_ready':True}
    result=observer.handle(candidate)[0]
    assert result['ready'] and result['end_ms']==1064
    assert observer.handle(candidate|{'generation':1})==[]
    assert not observer.handle(candidate|{'asr_end_ms':1050})[0]['ready']
    assert not observer.handle(candidate|{'channel':2})[0]['ready']
    observer.handle(frame(loud=True))
    assert not observer.handle(candidate)[0]['ready']
    observer.close();assert observer.engine.closed


def test_shadow_control_and_bad_audio_cannot_reuse_old_endpoint():
    observer=VadObserver(Path('/unused'),factory=Monitor)
    observer.handle({'type':'control','state':'CAPTURING','generation':0})
    observer.handle(frame())
    observer.handle({'type':'control','state':'QUIET','generation':1})
    result=observer.handle({'type':'endpoint','id':'request-a','generation':1,'channel':1,
        'end_ms':1064,'asr_end_ms':1064,'local_ready':True})[0]
    assert not result['ready']
    with pytest.raises(ValueError):observer.handle(frame()|{'channel':True})
    with pytest.raises(ValueError):observer.handle(frame()|{'audio':'bad-base64'})
    observer.close()


def test_vad_socket_requires_enabled_voice_and_cleans_up_on_disconnect(monkeypatch):
    monkeypatch.setenv('TINA_LIVEKIT_VAD_SHADOW','1');monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-vad-test')
    payload=base64.urlsafe_b64encode(json.dumps({'meeting':1,'session':'s','url':'http://backend','token':'','model':''}).encode()).decode().rstrip('=')
    token=payload+'.'+hmac.new(b'synthetic-vad-test',b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()
    state={'current':True,'voice_enabled':False};created=[]
    async def upstream(request):return httpx.Response(200,json=state)
    def factory(directory):
        observer=VadObserver(directory,factory=Monitor);created.append(observer);return observer
    monkeypatch.setattr('vad_shadow.VadObserver',factory)
    app=FastAPI();http=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app.include_router(build_audio_router(http,'http://core'))
    with TestClient(app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/audio/1/s/vad',subprotocols=['tina-audio-v1','cap.'+token]):pass
        assert not created
        state['voice_enabled']=True
        with client.websocket_connect('/audio/1/s/vad',subprotocols=['tina-audio-v1','cap.'+token]) as ws:
            assert ws.receive_json()=={'event':'vad-ready'}
            ws.send_json({'type':'control','state':'CAPTURING','generation':1})
            assert ws.receive_json()['generation']==1
            ws.send_json(frame());assert ws.receive_json()['endMs']==1064
            ws.send_json({'type':'endpoint','id':'request-a','channel':1,'generation':1,'end_ms':1064,'asr_end_ms':1064,'local_ready':True})
            assert ws.receive_json()['ready'] is True
    assert created[0].engine.closed
