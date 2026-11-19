"""Optional authenticated text -> mono PCM16/24 kHz sidecar. No core imports."""
from __future__ import annotations

import hmac
import json
import logging
import os
import socket
import threading
import time
import select
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from engine import Engine, MODEL, SAMPLE_RATE, FIXED_TEXTS, PRESET_VOICE, preset_voices,selected_voice
from voice_profile import resolve_profile

MAX_BODY = 20000
MAX_TEXT = 4000
log = logging.getLogger("tina.tts")


class SpeechServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, engine, token, *, max_connections=16, request_timeout=145, max_waiters=6, queue_timeout=30):
        if len(token) < 32 or not token.isascii() or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ValueError("TTS_API_TOKEN must contain at least 32 printable ASCII characters")
        self.engine = engine
        self.token = token.encode("ascii")
        self.busy = threading.Lock()
        self.queue = deque()
        self.queue_condition = threading.Condition()
        self.max_waiters = max_waiters
        self.queue_timeout = queue_timeout
        self.connections = threading.BoundedSemaphore(max_connections)
        self.request_timeout = request_timeout
        self.warming=set()
        super().__init__(address, Handler)

    def warm_voice(self,voice):
        if all(self.engine.cached_public(text,voice=voice) is not None for text in FIXED_TEXTS):return True
        with self.queue_condition:
            if voice in self.warming:return False
            if len(self.warming)>=3:return False
            self.warming.add(voice)
        def prepare():
            deadline=time.monotonic()+60
            try:
                for text in FIXED_TEXTS:
                    if self.engine.cached_public(text,voice=voice) is not None:continue
                    with self.queue_condition:
                        while self.queue or not self.busy.acquire(blocking=False):
                            if time.monotonic()>=deadline:return
                            self.queue_condition.wait(.1)
                    try:self.engine.synthesize(text,voice=voice)
                    finally:self.release_synthesis()
            except Exception:log.error('voice warmup failed')
            finally:
                with self.queue_condition:self.warming.discard(voice)
        threading.Thread(target=prepare,daemon=True).start()
        return False

    def acquire_synthesis(self, connection):
        ticket = object()
        deadline = time.monotonic() + self.queue_timeout
        with self.queue_condition:
            if len(self.queue) >= self.max_waiters:
                return False
            self.queue.append(ticket)
            try:
                while True:
                    # Disconnected/cancelled queued requests must never start native inference.
                    readable, _, _ = select.select([connection], [], [], 0)
                    if readable and connection.recv(1, socket.MSG_PEEK) == b'':
                        return False
                    if self.queue[0] is ticket and self.busy.acquire(blocking=False):
                        return True
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        return False
                    self.queue_condition.wait(min(remaining, .1))
            finally:
                self.queue.remove(ticket)
                self.queue_condition.notify_all()

    def release_synthesis(self):
        with self.queue_condition:
            self.busy.release()
            self.queue_condition.notify_all()

    def process_request(self, request, client_address):
        # Bound accepted connections before ThreadingMixIn allocates a thread.
        if not self.connections.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connections.release()
            raise

    def process_request_thread(self, request, client_address):
        # Inactivity timeouts alone allow indefinitely slow header/body senders.
        deadline = threading.Timer(self.request_timeout, self.expire_request, args=(request,))
        deadline.daemon = True
        deadline.start()
        try:
            super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            self.connections.release()

    def expire_request(self, request):
        # shutdown_request alone shuts down writes; wake a blocked header/body read too.
        try:
            request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.shutdown_request(request)


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def handle(self):
        try:
            super().handle()
        except (ConnectionError, TimeoutError):
            pass  # Client disconnect or the server's absolute connection deadline.

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *_args):
        pass  # BaseHTTPRequestHandler logs paths/arguments; never log submitted text/credentials.

    def send_bytes(self, status, body, content_type="application/json", headers=None):
        self.close_connection = True
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            for key, value in (headers or {}).items():
                self.send_header(key, value)
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # Stop can disconnect while native synthesis is still returning.

    def error(self, status, message):
        self.send_bytes(status, json.dumps({"detail": message}).encode())

    def do_GET(self):
        if self.path not in ("/health", "/status", "/ready"):
            return self.error(404, "Not found")
        if self.path == '/ready' and not hmac.compare_digest(self.headers.get('X-API-Key', '').encode(), self.server.token):
            return self.error(401, 'Unauthorized')
        self.send_bytes(200, json.dumps({"status": "ok", "model": MODEL,
            "voice": PRESET_VOICE,
            "device": "cpu", "sample_rate": SAMPLE_RATE, "channels": 1,
            "format": "pcm_s16le", "busy": self.server.busy.locked(),"voices":preset_voices(),
            "profiles_supported":len(os.environ.get('TINA_TTS_PROFILE_KEY',''))>=32},ensure_ascii=False).encode())

    def do_POST(self):
        if self.path not in ("/v1/audio/speech","/v1/voices/warm"):
            return self.error(404, "Not found")
        supplied = self.headers.get("X-API-Key", "").encode("utf-8")
        if not hmac.compare_digest(supplied, self.server.token):
            return self.error(401, "Unauthorized")
        if self.headers.get("Transfer-Encoding"):
            return self.error(400, "Transfer encoding is not supported")
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            return self.error(400, "Invalid content length")
        if length < 0:
            return self.error(411, "Content length required")
        if length > MAX_BODY:
            return self.error(413, "Speech request is too large")
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            return self.error(415, "JSON required")
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                return self.error(400, "Incomplete request")
            body = json.loads(raw)
        except (ValueError, UnicodeError, TimeoutError):
            return self.error(400, "Invalid JSON")
        if not isinstance(body, dict) or set(body) - {"input", "model", "voice", "response_format", "meeting_id","profile"}:
            return self.error(422, "Unsupported speech fields")
        meeting_id = body.get('meeting_id')
        if meeting_id is not None and (type(meeting_id) is not int or not 0 < meeting_id <= 9007199254740991):
            return self.error(422, 'Invalid meeting ID')
        if self.path=='/v1/voices/warm':
            try:
                voice,_=resolve_profile(body.get('profile'),meeting_id)
                ready=self.server.warm_voice(selected_voice(voice))
            except (ValueError,TypeError,KeyError,AttributeError):return self.error(422,'Invalid speech profile')
            return self.send_bytes(200,json.dumps({'ready':ready}).encode())
        text = body.get("input")
        if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT:
            return self.error(422, "Input must contain 1-4000 characters")
        if (body.get("model", "tts-1") not in ("tts-1", MODEL)
                or body.get("response_format", "pcm") != "pcm"):
            return self.error(422, "Use model=tts-1 and response_format=pcm")
        try:
            voice=body.get('voice','auto');pronunciations={}
            if body.get('profile') is not None:
                chosen,pronunciations=resolve_profile(body['profile'],meeting_id)
                if voice!='auto' and selected_voice(voice)!=selected_voice(chosen):raise ValueError()
                voice=chosen
            voice=selected_voice(voice)
        except (ValueError,TypeError,KeyError,AttributeError):return self.error(422,'Invalid preset voice or speech profile')
        options={}
        if voice!=PRESET_VOICE:options['voice']=voice
        if pronunciations:options['pronunciations']=pronunciations
        cached = self.server.engine.cached_public(text.strip(),**({'voice':voice} if voice!=PRESET_VOICE else {}))
        if cached is not None:
            return self.send_bytes(200, cached, 'audio/pcm', {
                'X-Audio-Sample-Rate': str(SAMPLE_RATE), 'X-Audio-Channels': '1',
                'Server-Timing': 'synthesis;dur=0'})
        if not self.server.acquire_synthesis(self.connection):
            return self.error(503, "Speech queue is full, cancelled or timed out")
        started = time.monotonic()
        streaming = False
        failed = False
        chunks = None
        try:
            if meeting_id is not None:options['meeting_id']=meeting_id
            chunks = self.server.engine.stream(text.strip(),**options)
            total = 0
            while True:
                readable, _, _ = select.select([self.connection], [], [], 0)
                if readable and self.connection.recv(1, socket.MSG_PEEK) == b'':
                    raise ConnectionResetError()
                try: audio = next(chunks)
                except StopIteration: break
                # A disconnect during a native chunk must not publish its late PCM or start another chunk.
                readable, _, _ = select.select([self.connection], [], [], 0)
                if readable and self.connection.recv(1, socket.MSG_PEEK) == b'':
                    raise ConnectionResetError()
                if not isinstance(audio, bytes) or len(audio) % 2: raise ValueError('Invalid PCM')
                if not audio: continue
                total += len(audio)
                if total > SAMPLE_RATE * 2 * 120: raise ValueError('Audio exceeds bound')
                if not streaming:
                    self.close_connection = True
                    self.connection.settimeout(self.server.request_timeout)
                    self.send_response(200)
                    for key, value in {'Content-Type':'application/octet-stream', 'Transfer-Encoding':'chunked',
                        'Connection':'close', 'Cache-Control':'no-store', 'X-Audio-Sample-Rate':str(SAMPLE_RATE),
                        'X-Audio-Channels':'1', 'Server-Timing':f'tts_first_audio;dur={(time.monotonic()-started)*1000:.1f}'}.items():
                        self.send_header(key, value)
                    self.end_headers()
                    streaming = True
                for offset in range(0, len(audio), 16384):
                    part = audio[offset:offset+16384]
                    self.wfile.write(f'{len(part):X}\r\n'.encode() + part + b'\r\n')
                    self.wfile.flush()
            if not total: raise ValueError('Empty PCM')
            self.wfile.write(b'0\r\n\r\n'); self.wfile.flush()
            log.info("synthesis complete: characters=%d bytes=%d seconds=%.3f", len(text), total, time.monotonic()-started)
        except (ConnectionError, TimeoutError):
            pass  # Stop disconnects the stream; never append a success terminator or error body.
        except Exception:
            # Never expose model exception messages: they may contain input text.
            log.error("synthesis failed")
            failed=True
        finally:
            try:
                if chunks is not None: chunks.close()
            except Exception:
                log.error('stream cleanup failed')
            finally:
                self.close_connection = True
                self.server.release_synthesis()
        if failed and not streaming:self.error(503,"Speech synthesis failed")


def main():
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    token = os.environ.get("TTS_API_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("Set a private TTS_API_TOKEN of at least 32 characters")
    directory = Path(os.environ.get("HF_HOME", "/models"))
    engine = Engine(directory)
    for text in FIXED_TEXTS: engine.synthesize(text)  # No private meeting text is cached.
    host = os.environ.get("TINA_TTS_HOST", "127.0.0.1")
    port = int(os.environ.get("TINA_TTS_PORT", "8000"))
    server = SpeechServer((host, port), engine, token)
    log.info("TTS ready: CPU, mono PCM16, 24000 Hz")
    server.serve_forever()


if __name__ == "__main__":
    main()
