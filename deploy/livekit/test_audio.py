"""SDK STT preserves source offsets; capability and native-filter boundaries are independent of LLM."""
import asyncio
import base64
import hmac
import hashlib
import io
import json
import sys
from types import SimpleNamespace
import wave

import httpx
import numpy as np
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from audio import build_audio_router, NoiseStreams
from audio_stream import AudioWindows


def test_idle_noise_connection_revalidates_and_resumes_but_closes_when_revoked(monkeypatch):
    import threading
    import audio
    from starlette.websockets import WebSocketDisconnect
    current={'current':True,'noise_suppression':True};checks=[];revalidated=threading.Event()
    async def upstream(request):
        checks.append(request)
        if len(checks)>=2:revalidated.set()
        return httpx.Response(200,json=current)
    class Filter:
        def feed(self,value):return [{'seq':value['seq'],'audio':value['audio']}]
        def close(self):pass
    original=asyncio.wait_for
    async def fast_idle(task,timeout):return await original(task,.05 if timeout==15 else timeout)
    monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-livekit-secret')
    monkeypatch.setattr(audio,'NoiseStreams',Filter)
    monkeypatch.setattr(audio,'noise_ready',lambda:{'id':'webrtc'})
    monkeypatch.setattr(asyncio,'wait_for',fast_idle)
    app=FastAPI();app.include_router(build_audio_router(httpx.AsyncClient(transport=httpx.MockTransport(upstream)),'http://core'))
    with TestClient(app) as client:
        with client.websocket_connect('/audio/1/session-a/noise',subprotocols=['tina-audio-v1','cap.'+token()]) as ws:
            assert ws.receive_json()['ready'] is True
            assert revalidated.wait(2)
            ws.send_json({'type':'audio','seq':1,'audio':'AAAAAA=='})
            assert ws.receive_json()['seq']==1
            current['noise_suppression']=False
            with pytest.raises(WebSocketDisconnect):ws.receive_json()


def token(**changes):
    body={'meeting':1,'session':'session-a','url':'http://asr','token':'synthetic-asr-secret','model':'viegem'}|changes
    payload=base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip('=')
    return payload+'.'+hmac.new(b'synthetic-livekit-secret',b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()


def wav():
    out=io.BytesIO()
    with wave.open(out,'wb') as w:
        w.setnchannels(1);w.setsampwidth(2);w.setframerate(16000);w.writeframes(b'\0\0'*1024)
    return out.getvalue()


def test_stream_windows_keep_channel_boundaries_and_exact_tail_across_capture_gaps():
    windows=AudioWindows()
    windows.feed('ch-1:1',1000,b'\x01\0'*1024)
    windows.feed('ch-2:1',1000,b'\x02\0'*1024)
    windows.feed('ch-1:1',1200,b'\x03\0'*777)
    assert windows.window('ch-1:1',1032,512+777)==b'\x01\0'*512+b'\x03\0'*777
    assert windows.window('ch-2:1',1000,1024)==b'\x02\0'*1024
    with pytest.raises(ValueError):windows.window('ch-1:1',1064,1)
    with pytest.raises(ValueError):windows.window('ch-1:1',1200,778)


def test_stream_cache_stays_bounded_during_long_audio_and_releases_closed_turns():
    windows=AudioWindows()
    for i in range(2000):windows.feed('ch-0:1',1000+i*64,b'\x01\0'*1024)
    assert windows.held_samples<=32*16000
    with pytest.raises(ValueError):windows.window('ch-0:1',1000,10)
    windows.close('ch-0:1')
    assert windows.held_samples==0


@pytest.fixture
async def bridge(monkeypatch):
    monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-livekit-secret')
    state={'current':True,'noise_suppression':True};calls=[]
    async def upstream(request):
        calls.append(request)
        if request.url.host=='core':return httpx.Response(200,json=state)
        if state.get('block'):await state['block'].wait()
        if state.get('revoke_after'):state['current']=False
        return httpx.Response(state.get('backend_status',200),json={
            'text':'Lan phụ trách demo.','segments':[{'start':.1,'end':.06+1,'text':'Lan phụ trách demo.'}],
            'duration':.064,'language':'vi','timing':{'decode_ms':12}},headers={'Server-Timing':'asr_queue;dur=7'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app=FastAPI();app.include_router(build_audio_router(upstream_client,'http://core'))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://bridge') as client:
            yield client,state,calls


async def recognize(client,cap=None,model='viegem'):
    return await client.post('/audio/1/session-a/v1/audio/transcriptions',headers={
        'Authorization':'Bearer '+(cap or token()),'X-ASR-Request-ID':'request-a'},
        data={'model':model,'response_format':'verbose_json','language':'vi','prompt':'TINA'},
        files={'file':('a.wav',wav(),'audio/wav')})


async def test_sdk_recognizes_selected_backend_once_and_preserves_raw_offsets(bridge):
    client,state,calls=bridge
    response=await recognize(client)
    assert response.status_code==200,response.text
    assert response.json()['segments'][0]['start']==.1 and response.json()['duration']==.064
    assert response.json()['timing']=={'decode_ms':12}
    assert response.headers['server-timing']=='asr_queue;dur=7'
    actual=[r for r in calls if r.url.host=='asr']
    assert len(actual)==1 and actual[0].url.path=='/v1/audio/transcriptions'
    assert actual[0].headers['authorization']=='Bearer synthetic-asr-secret'
    assert actual[0].headers['X-ASR-Request-ID']=='request-a'
    assert b'TINA' in actual[0].content and b'verbose_json' in actual[0].content
    assert len([r for r in calls if r.url.host=='core'])==2


async def test_rejects_tamper_cross_session_changed_model_and_stopped_result(bridge):
    client,state,calls=bridge
    for cap in (token()+'x',token(session='other'),token(meeting=2)):
        assert (await recognize(client,cap)).status_code==403
    assert (await recognize(client,model='gipformer')).status_code==403
    assert not any(r.url.host=='asr' for r in calls)
    state['revoke_after']=True
    assert (await recognize(client)).status_code==409


async def test_backend_rejection_is_not_retried_by_sdk_or_leaked(bridge):
    client,state,calls=bridge;state['backend_status']=400
    response=await recognize(client)
    assert response.status_code==400 and 'verbose_json' in response.text
    assert 'synthetic-asr-secret' not in response.text
    assert len([r for r in calls if r.url.host=='asr'])==1


async def test_malformed_audio_never_reaches_model(bridge):
    client,state,calls=bridge
    response=await client.post('/audio/1/session-a/v1/audio/transcriptions',headers={'Authorization':'Bearer '+token()},
        files={'file':('a.wav',b'bad','audio/wav')})
    assert response.status_code==422 and not any(r.url.host=='asr' for r in calls)


def test_noise_discontinuity_and_flush_emit_every_pending_packet(monkeypatch):
    class Stream:
        def __init__(self,emit):self.emit=emit;self.frames=[];self.native=SimpleNamespace(close=lambda:None)
        def feed(self,seq,pcm):self.frames.append((seq,pcm))
        def close(self):
            for seq,pcm in self.frames:self.emit(seq,pcm)
            self.frames.clear()
    monkeypatch.setitem(sys.modules,'tina_ns',SimpleNamespace(NsStream=Stream))
    states=NoiseStreams();audio=base64.b64encode(np.zeros(1024,dtype='<f4').tobytes()).decode()
    frame={'channel':0,'seq':1,'stamp':1000,'startSample':0,'audio':audio}
    assert states.feed(frame)==[]
    assert [x['seq'] for x in states.feed(frame|{'seq':2,'stamp':2000,'startSample':1024})]==[1]
    assert [x['seq'] for x in states.flush()]==[2]
    assert not states.rows


def test_websocket_checks_scoped_permission_and_flushes_without_dropping_tail(monkeypatch):
    monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-livekit-secret')
    class Stream:
        def __init__(self,emit):self.emit=emit;self.frames=[];self.native=SimpleNamespace(close=lambda:None)
        def feed(self,seq,pcm):self.frames.append((seq,pcm))
        def close(self):
            for seq,pcm in self.frames:self.emit(seq,pcm)
    monkeypatch.setitem(sys.modules,'tina_ns',SimpleNamespace(NsStream=Stream,NativeNs=lambda:SimpleNamespace(close=lambda:None)))
    async def upstream(request):return httpx.Response(200,json={'current':True,'noise_suppression':True})
    app=FastAPI();http=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app.include_router(build_audio_router(http,'http://core'))
    with TestClient(app) as client:
        with client.websocket_connect('/audio/1/session-a/noise',subprotocols=['tina-audio-v1','cap.'+token()]) as ws:
            assert ws.receive_json()=={'ready':True,'filter':'webrtc'}
            audio=base64.b64encode(np.zeros(1024,dtype='<f4').tobytes()).decode()
            ws.send_json({'type':'audio','seq':1,'channel':0,'stamp':1000,'audio':audio})
            ws.send_json({'type':'flush'})
            assert ws.receive_json()=={'seq':1,'audio':audio}


def test_continuous_stt_assembles_referenced_windows_and_fences_revoked_results(monkeypatch):
    monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-livekit-secret')
    state={'current':True,'noise_suppression':True};calls=[]
    async def upstream(request):
        if request.url.host=='core':return httpx.Response(200,json=state)
        calls.append(request)
        state['current']=not state.get('revoke_after',False)
        return httpx.Response(200,json={'text':'Lan làm demo.','segments':[{'start':0,'end':.1,'text':'Lan làm demo.'}]},
            headers={'Server-Timing':'asr_queue;dur=4'})
    http=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app=FastAPI();app.include_router(build_audio_router(http,'http://core'))
    pcm=b'\x01\0'*1024+b'\x02\0'*777
    command={'type':'window','id':'request-1','stream':'ch-1:1','start_ms':1000,'samples':1801,
        'sha256':hashlib.sha256(pcm).hexdigest(),'fields':{'model':'viegem','response_format':'verbose_json'}}
    with TestClient(app) as client:
        with client.websocket_connect('/audio/1/session-a/stt',subprotocols=['tina-audio-v1','cap.'+token()]) as ws:
            assert ws.receive_json()['ready'] is True
            for i,chunk in enumerate((pcm[:2048],pcm[2048:])):
                ws.send_json({'type':'audio','stream':'ch-1:1','stamp':1000+i*64,'audio':base64.b64encode(chunk).decode()})
            ws.send_json(command)
            result=ws.receive_json()
            assert result['type']=='draft' and result['id']=='request-1'
            assert result['result']['text']=='Lan làm demo.' and result['server_timing']=='asr_queue;dur=4'
            assert len(calls)==1 and pcm in calls[0].content
            ws.send_json(command|{'id':'wrong','sha256':'0'*64})
            assert ws.receive_json()['status']==409 and len(calls)==1
            state['revoke_after']=True
            ws.send_json(command|{'id':'request-2'})
            result=ws.receive_json()
            assert result['id']=='request-2' and result['status']==409 and 'result' not in result


def test_continuous_cancel_does_not_block_audio_or_publish_old_draft(monkeypatch):
    monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-livekit-secret')
    entered=__import__('threading').Event();cancelled=__import__('threading').Event();calls=[]
    async def upstream(request):
        if request.url.host=='core':return httpx.Response(200,json={'current':True})
        calls.append(request)
        if len(calls)==1:
            entered.set()
            try:await asyncio.Event().wait()
            finally:cancelled.set()
        return httpx.Response(200,json={'text':'new question','segments':[]})
    http=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    app=FastAPI();app.include_router(build_audio_router(http,'http://core'))
    pcm=b'\x01\0'*1024
    command={'type':'window','id':'old','stream':'ch-0:1','start_ms':1000,'samples':1024,
        'sha256':hashlib.sha256(pcm).hexdigest(),'fields':{'model':'viegem'}}
    with TestClient(app) as client:
        with client.websocket_connect('/audio/1/session-a/stt',subprotocols=['tina-audio-v1','cap.'+token()]) as ws:
            ws.receive_json()
            ws.send_json({'type':'audio','stream':'ch-0:1','stamp':1000,'audio':base64.b64encode(pcm).decode()})
            ws.send_json(command);assert entered.wait(3)
            ws.send_json({'type':'cancel','id':'old'})
            ws.send_json({'type':'audio','stream':'ch-0:1','stamp':1064,'audio':base64.b64encode(pcm).decode()})
            ws.send_json(command|{'id':'new','start_ms':1064})
            result=ws.receive_json()
            assert result['id']=='new' and result['result']['text']=='new question'
            assert cancelled.wait(3)
            ws.send_json({'type':'close_turn','stream':'ch-0:1'})
            ws.send_json(command|{'id':'closed'})
            assert ws.receive_json()['status']==409


def test_idle_stt_connection_revalidates_preserves_window_and_closes_when_revoked(monkeypatch):
    import threading
    from starlette.websockets import WebSocketDisconnect
    current={'current':True,'noise_suppression':True};checks=[];revalidated=threading.Event();asr_calls=[]
    async def upstream(request):
        if request.url.host=='core':
            checks.append(request)
            if len(checks)>=2:revalidated.set()
            return httpx.Response(200,json=current)
        asr_calls.append(request)
        return httpx.Response(200,json={'text':'Sau khoang lang.','segments':[]})
    original=asyncio.wait_for
    async def fast_idle(task,timeout):return await original(task,.05 if timeout==15 else timeout)
    monkeypatch.setenv('LIVEKIT_API_SECRET','synthetic-livekit-secret')
    monkeypatch.setattr(asyncio,'wait_for',fast_idle)
    pcm=b'\x01\0'*1024
    command={'type':'window','id':'after-idle','stream':'ch-0:1','start_ms':1000,'samples':1024,
        'sha256':hashlib.sha256(pcm).hexdigest(),'fields':{'model':'viegem'}}
    app=FastAPI();app.include_router(build_audio_router(httpx.AsyncClient(transport=httpx.MockTransport(upstream)),'http://core'))
    with TestClient(app) as client:
        with client.websocket_connect('/audio/1/session-a/stt',subprotocols=['tina-audio-v1','cap.'+token()]) as ws:
            assert ws.receive_json()['ready'] is True
            ws.send_json({'type':'audio','stream':'ch-0:1','stamp':1000,'audio':base64.b64encode(pcm).decode()})
            assert revalidated.wait(2),'idle STT socket must revalidate permit without closing'
            ws.send_json(command)
            result=ws.receive_json()
            assert result['type']=='draft' and result['id']=='after-idle'
            assert result['result']['text']=='Sau khoang lang.' and len(asr_calls)==1
            current['current']=False
            with pytest.raises(WebSocketDisconnect):ws.receive_json()


async def test_capability_rejects_missing_token_or_model_and_non_bearer_header(bridge):
    client, state, calls = bridge
    # Missing required 'token' or 'model' fields in signed payload must return 403, never 500 KeyError.
    for omitted in ('token', 'model'):
        body = {'meeting': 1, 'session': 'session-a', 'url': 'http://asr', 'token': 'tok', 'model': 'viegem'}
        del body[omitted]
        payload = base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip('=')
        bad_cap = payload + '.' + hmac.new(b'synthetic-livekit-secret', b'tina-audio.v1:' + payload.encode(), 'sha256').hexdigest()
        res = await recognize(client, cap=bad_cap)
        assert res.status_code == 403
    # Non-Bearer Authorization header must be rejected on both /health and /v1/audio/transcriptions.
    no_bearer_health = await client.get('/audio/1/session-a/health', headers={'Authorization': token()})
    assert no_bearer_health.status_code == 403
    no_bearer_stt = await client.post('/audio/1/session-a/v1/audio/transcriptions',
        headers={'Authorization': token()},
        data={'model': 'viegem'}, files={'file': ('a.wav', wav(), 'audio/wav')})
    assert no_bearer_stt.status_code == 403


async def test_transcriptions_validates_payload_before_acquiring_shared_stt_slots(monkeypatch):
    monkeypatch.setenv('LIVEKIT_API_SECRET', 'synthetic-livekit-secret')
    gate = asyncio.Event()
    entered = asyncio.Event()
    async def upstream(request):
        if request.url.host == 'core': return httpx.Response(200, json={'current': True})
        entered.set()
        await gate.wait()
        return httpx.Response(200, json={'text': 'ok', 'segments': []})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
        app = FastAPI()
        app.include_router(build_audio_router(upstream_client, 'http://core'))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://bridge') as client:
            # Fill all 8 slots.
            holders = [asyncio.create_task(recognize(client)) for _ in range(8)]
            try:
                await asyncio.wait_for(entered.wait(), 2)
                await asyncio.sleep(0.05)
                # Malformed audio and wrong model must be rejected with 422/403 before hitting 503 busy.
                bad_wav = await client.post('/audio/1/session-a/v1/audio/transcriptions',
                    headers={'Authorization': 'Bearer ' + token()}, files={'file': ('a.wav', b'not-wav', 'audio/wav')})
                assert bad_wav.status_code == 422
                bad_model = await recognize(client, model='other-model')
                assert bad_model.status_code == 403
                # Valid request hits 503 while slots are full.
                overflow = await recognize(client)
                assert overflow.status_code == 503
            finally:
                gate.set()
                await asyncio.gather(*holders, return_exceptions=True)


def test_noise_streams_close_uses_stream_close_not_private_native(monkeypatch):
    closed = []
    class Stream:
        def __init__(self, emit): self.emit = emit
        def feed(self, seq, pcm): pass
        def close(self): closed.append('stream.close')
    monkeypatch.setitem(sys.modules, 'tina_ns', SimpleNamespace(NsStream=Stream))
    states = NoiseStreams()
    audio_b64 = base64.b64encode(np.zeros(1024, dtype='<f4').tobytes()).decode()
    states.feed({'channel': 0, 'seq': 1, 'stamp': 1000, 'audio': audio_b64})
    states.close()
    assert closed == ['stream.close']
    assert not states.rows
