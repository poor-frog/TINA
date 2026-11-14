"""Local LiveKit SDK STT + WebRTC NS bridge. TINA's bot remains the transcript writer."""
import asyncio
import base64
from email.parser import BytesParser
from email.policy import default
import hmac
import io as bytes_io
import json
import math
import os
import time
from urllib.parse import urlsplit
import wave

from fastapi import APIRouter, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import httpx
import numpy as np
from livekit import rtc
from livekit.agents import stt
from livekit.agents.types import APIConnectOptions

MAX_BODY=4*1024*1024


def denoiser():
    choice=os.environ.get('TINA_AUDIO_DENOISER','webrtc')
    if choice not in ('webrtc','dtln'):raise ValueError('Unsupported audio denoiser')
    return choice


def noise_ready():
    choice=denoiser()
    if choice=='dtln':
        from dtln import sessions
        sessions()
    else:
        from tina_ns import NativeNs
        probe=NativeNs();probe.close()
    return {'id':choice,'label':'DTLN' if choice=='dtln' else 'WebRTC NS Low','device':'cpu',
            'sample_rate':16000,'delay_samples':384 if choice=='dtln' else 96}


def capability(token, mid, session):
    try:
        secret=os.environ.get('LIVEKIT_API_SECRET','')
        if not secret or not isinstance(token,str) or len(token)>7200: raise ValueError()
        payload,signature=token.rsplit('.',1)
        expected=hmac.new(secret.encode(),b'tina-audio.v1:'+payload.encode(),'sha256').hexdigest()
        if not hmac.compare_digest(signature,expected):raise ValueError()
        body=json.loads(base64.urlsafe_b64decode(payload+'='*(-len(payload)%4)))
        url=urlsplit(body['url'])
        if (body['meeting']!=mid or body['session']!=session or url.scheme not in ('http','https')
                or not url.hostname or url.username or url.password or url.query or url.fragment):raise ValueError()
        return body
    except (ValueError,KeyError,TypeError,AttributeError):
        raise HTTPException(403,'Audio capability rejected') from None


def parse_window(content_type, raw):
    if not isinstance(content_type,str) or '\r' in content_type or '\n' in content_type:raise ValueError()
    message=BytesParser(policy=default).parsebytes(('Content-Type: '+content_type+'\r\nMIME-Version: 1.0\r\n\r\n').encode()+raw)
    if message.get_content_type()!='multipart/form-data' or not message.is_multipart():raise ValueError()
    fields={};audio=None
    allowed={'model','response_format','language','timestamp_granularities','max_speech_duration_s','min_silence_duration_ms','prompt'}
    parts=list(message.iter_parts())
    if len(parts)>10:raise ValueError()
    for part in parts:
        name=part.get_param('name',header='content-disposition');data=part.get_payload(decode=True)
        if not isinstance(data,bytes):raise ValueError()
        if name=='file':
            if audio is not None or len(data)>MAX_BODY:raise ValueError()
            audio=data
        else:
            if name not in allowed or name in fields or len(data)>16000:raise ValueError()
            fields[name]=data.decode('utf-8')
    if audio is None:raise ValueError()
    with wave.open(bytes_io.BytesIO(audio),'rb') as wav:
        if wav.getnchannels()!=1 or wav.getframerate()!=16000 or wav.getsampwidth()!=2 or wav.getnframes()>90*16000:raise ValueError()
        pcm=wav.readframes(wav.getnframes())
        if len(pcm)!=wav.getnframes()*2:raise ValueError()
    return pcm,fields


class BackendSTT(stt.STT):
    """Use SDK recognition/metrics with a pinned non-streaming backend; retain its raw offsets."""
    def __init__(self,http,target,fields,headers):
        super().__init__(capabilities=stt.STTCapabilities(streaming=False,interim_results=False))
        self.http,self.target,self.fields,self.headers=http,target,fields,headers
        self.response_headers={}

    @property
    def model(self):return self.target.get('model') or 'tina-selected-stt'
    @property
    def provider(self):return 'tina-local-asr'

    async def _recognize_impl(self,buffer,*,language,conn_options):
        pcm=bytes(buffer.data)
        out=bytes_io.BytesIO()
        with wave.open(out,'wb') as wav:
            wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(pcm)
        url=self.target['url'].rstrip('/')
        if not url.endswith('/v1/audio/transcriptions'):
            url+='/v1/audio/transcriptions'
        headers=dict(self.headers)
        if self.target['token']:headers['Authorization']='Bearer '+self.target['token']
        async with self.http.stream('POST',url,headers=headers,data=self.fields,
                files={'file':('audio.wav',out.getvalue(),'audio/wav')},timeout=90) as response:
            if response.status_code!=200:
                detail='ASR backend rejected request'
                if response.status_code==400 and self.fields.get('response_format')=='verbose_json':detail+=': verbose_json'
                raise HTTPException(response.status_code,detail)
            self.response_headers={k:response.headers[k] for k in ('server-timing',) if k in response.headers}
            raw=bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw)>200000:raise HTTPException(502,'ASR response exceeds bound')
        try:result=json.loads(raw)
        except (ValueError,UnicodeError):raise HTTPException(502,'ASR returned invalid transcript') from None
        if not isinstance(result,dict) or not isinstance(result.get('text'),str) or not isinstance(result.get('segments',[]),list):
            raise HTTPException(502,'ASR returned invalid transcript')
        return stt.SpeechEvent(type=stt.SpeechEventType.FINAL_TRANSCRIPT,alternatives=[stt.SpeechData(
            language=result.get('language') or 'vi',text=result['text'],metadata={'tina_result':result})])


class NoiseStreams:
    def __init__(self):
        self.rows={};self.choice=denoiser()
    def feed(self,value):
        # Reuse the existing exact-count/delay-compensated WebRTC NS implementation.
        from tina_ns import NsStream
        channel,seq,stamp=value['channel'],value['seq'],value['stamp']
        if (type(channel) is not int or not 0<=channel<65536 or type(seq) is not int or seq<0
                or type(stamp) not in (float,int) or not math.isfinite(stamp)):raise ValueError()
        raw=base64.b64decode(value['audio'],validate=True)
        if not raw or len(raw)>64000 or len(raw)%4:raise ValueError()
        pcm=np.frombuffer(raw,dtype='<f4')
        if not np.isfinite(pcm).all():raise ValueError()
        sample=value.get('startSample');participant=value.get('participant')
        if sample is not None and (type(sample) is not int or sample<0):raise ValueError()
        if participant is not None and (not isinstance(participant,str) or len(participant)>512):raise ValueError()
        row=self.rows.get(channel);output=[]
        def emit(identifier,clean):output.append({'seq':identifier,'audio':base64.b64encode(clean.astype('<f4').tobytes()).decode()})
        if row:row['stream'].emit=emit
        if row and (abs(stamp-row['end'])>2 or sample is not None and row['sample'] is not None and sample!=row['sample']
                    or participant and row['participant'] and participant!=row['participant']):
            row['stream'].close();del self.rows[channel];row=None
        if row is None:
            if len(self.rows)>=16:
                oldest=min(self.rows,key=lambda k:self.rows[k]['end']);retired=self.rows.pop(oldest)['stream']
                retired.emit=emit;retired.close()
            if self.choice=='dtln':
                from dtln import stream
                filtering=stream(emit)
            else:filtering=NsStream(emit)
            row={'stream':filtering};self.rows[channel]=row
        # Each NsStream may retain one original packet; attach the current emission sink per call.
        row['stream'].emit=emit
        row.update(end=stamp+len(pcm)/16,sample=None if sample is None else sample+len(pcm),participant=participant)
        row['stream'].feed(seq,pcm)
        return output
    def flush(self):
        output=[]
        for row in self.rows.values():
            row['stream'].emit=lambda seq,pcm:output.append({'seq':seq,'audio':base64.b64encode(pcm.astype('<f4').tobytes()).decode()})
            row['stream'].close()
        self.rows.clear();return output
    def close(self):
        for row in self.rows.values():row['stream'].native.close()
        self.rows.clear()


def build_audio_router(http,core):
    router=APIRouter();slots=asyncio.Semaphore(8);noise_connections=set()
    async def authorize(mid,session,token):
        target=capability(token,mid,session)
        try:
            response=await http.get(f'{core}/bots/audio/{mid}/{session}/permit',headers={'Authorization':'Bearer '+token},timeout=5)
            if response.status_code!=200:raise HTTPException(response.status_code,'Audio session rejected')
            policy=response.json()
            if policy.get('current') is not True:raise HTTPException(409,'Audio session is not current')
            return target,policy
        except (httpx.HTTPError,ValueError,AttributeError):raise HTTPException(503,'Audio authorization unavailable') from None

    async def recognize(target,pcm,fields,headers):
        if target['model'] and fields.get('model')!=target['model']:raise HTTPException(403,'ASR model selection changed')
        adapter=BackendSTT(http,target,fields,headers)
        frame=rtc.AudioFrame(data=pcm,sample_rate=16000,num_channels=1,samples_per_channel=len(pcm)//2)
        event=await adapter.recognize(frame,conn_options=APIConnectOptions(max_retry=0,timeout=95))
        return event.alternatives[0].metadata['tina_result'],adapter.response_headers

    from audio_stream import add_stream_route
    add_stream_route(router,authorize,recognize,slots)
    from vad_shadow import add_vad_route
    add_vad_route(router,authorize,native)

    @router.get('/audio/{mid}/{session}/health')
    async def health(mid:int,session:str,authorization:str=Header(default='')):
        target,_=await authorize(mid,session,authorization.removeprefix('Bearer '))
        base=target['url'].rstrip('/').removesuffix('/audio/transcriptions').removesuffix('/v1')
        headers={'Authorization':'Bearer '+target['token']} if target['token'] else {}
        try:
            response=await http.get(base+'/health',headers=headers,timeout=5)
            if response.status_code!=200:raise HTTPException(503,'ASR backend unavailable')
        except httpx.HTTPError:raise HTTPException(503,'ASR backend unavailable') from None
        return {'ready':True,'stt_runtime':'livekit-agents'}

    @router.post('/audio/{mid}/{session}/v1/audio/transcriptions')
    async def transcribe(mid:int,session:str,request:Request,authorization:str=Header(default='')):
        token=authorization.removeprefix('Bearer ')
        target,_=await authorize(mid,session,token)
        if slots.locked():raise HTTPException(503,'STT bridge is busy')
        async with slots:
            raw=bytearray()
            async for block in request.stream():
                raw.extend(block)
                if len(raw)>MAX_BODY:raise HTTPException(413,'Audio request exceeds bound')
            try:pcm,fields=parse_window(request.headers.get('content-type'),bytes(raw))
            except (ValueError,UnicodeError,wave.Error,EOFError):raise HTTPException(422,'Expected bounded mono PCM16 16kHz WAV') from None
            if target['model'] and fields.get('model')!=target['model']:raise HTTPException(403,'ASR model selection changed')
            headers={k:request.headers[k] for k in ('X-ASR-Request-ID','X-ASR-Source','X-ASR-Capture-Ms') if k in request.headers and len(request.headers[k])<256}
            task=asyncio.create_task(recognize(target,pcm,fields,headers))
            try:
                while not task.done():
                    if await request.is_disconnected():raise HTTPException(499,'ASR request cancelled')
                    await asyncio.sleep(.05)
                result,response_headers=await task
                await authorize(mid,session,token)
                return JSONResponse(result,headers=response_headers)
            except httpx.HTTPError:raise HTTPException(503,'ASR transport unavailable') from None
            finally:
                if not task.done():task.cancel()
                await asyncio.gather(task,return_exceptions=True)

    @router.websocket('/audio/{mid}/{session}/noise')
    async def noise(socket:WebSocket,mid:int,session:str):
        protocols=socket.scope.get('subprotocols',[])
        token=next((v.strip()[4:] for v in protocols if v.strip().startswith('cap.')),'')
        states=NoiseStreams();slot=object()
        try:
            _,policy=await authorize(mid,session,token)
            if policy.get('noise_suppression') is not True:raise HTTPException(409,'Noise suppression disabled')
            if len(noise_connections)>=8:raise HTTPException(503,'Noise bridge is busy')
            noise_connections.add(slot)
            await socket.accept(subprotocol='tina-audio-v1')
            info=await native(noise_ready)
            await socket.send_json({'ready':True,'filter':info['id']});checked=time.monotonic()
            while True:
                try:line=await asyncio.wait_for(socket.receive_text(),15)
                except TimeoutError:
                    _,policy=await authorize(mid,session,token)
                    if policy.get('noise_suppression') is not True:raise HTTPException(409,'Noise suppression disabled')
                    checked=time.monotonic()
                    continue
                if len(line)>100000:raise ValueError()
                value=json.loads(line)
                if time.monotonic()-checked>=1:
                    _,policy=await authorize(mid,session,token);checked=time.monotonic()
                    if policy.get('noise_suppression') is not True:raise HTTPException(409,'Noise suppression disabled')
                if value.get('type')=='flush':
                    for result in await native(states.flush):await socket.send_json(result)
                    break
                if value.get('type')!='audio':raise ValueError()
                results=await native(states.feed,value)
                for result in results:await socket.send_json(result)
        except (WebSocketDisconnect,TimeoutError,HTTPException,ValueError,KeyError,TypeError,RuntimeError,OSError):
            pass
        finally:
            states.close();noise_connections.discard(slot)
            try:await socket.close()
            except RuntimeError:pass
    return router


async def native(fn,*args):
    # Do not free a native filter while a cancelled thread still holds its C++ state.
    task=asyncio.create_task(asyncio.to_thread(fn,*args))
    try:return await asyncio.shield(task)
    except asyncio.CancelledError:
        await asyncio.gather(task,return_exceptions=True)
        raise
