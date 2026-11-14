"""Offline HTTP/audio regression tests; native models are exercised by smoke.py."""
import io
import json
import threading
import hashlib
import tempfile
import sys
import socket
import time
import unittest
import urllib.error
import urllib.request
from contextlib import redirect_stderr
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

from server import SpeechServer

TOKEN = "test-only-" + "x" * 40


class TestEngine:
    def __init__(self, synthesize): self.synthesize = synthesize
    def stream(self, text, **kwargs): yield self.synthesize(text, **kwargs)
    def cached_public(self, text, **kwargs): return None


class ServerTests(unittest.TestCase):
    def test_voice_warmup_waits_for_user_work_and_caches_only_public_notices(self):
        from engine import FIXED_TEXTS
        cached=set();calls=[]
        def synthesize(text,voice=None):calls.append((text,voice));cached.add((voice,text));return b'\0\0'
        self.engine.synthesize=synthesize
        self.engine.cached_public=lambda text,voice='auto':b'\0\0' if (voice,text) in cached else None
        self.server.busy.acquire()
        try:
            self.assertFalse(self.server.warm_voice('Mai Anh'))
            self.assertEqual(calls,[])
        finally:self.server.release_synthesis()
        deadline=time.monotonic()+2
        while not self.server.warm_voice('Mai Anh') and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual({text for text,_ in calls},set(FIXED_TEXTS))
        self.assertTrue(all(voice=='Mai Anh' for _,voice in calls))

    def test_preset_voice_reaches_synthesis_and_unknown_models_are_refused(self):
        def selected(text,voice=None):self.calls.append(voice);return b'\x01\0'*100
        self.engine.synthesize=selected
        self.assertEqual(self.call({'input':'Xin chào','voice':'Mai Anh'})[0],200)
        self.assertEqual(self.calls,['Mai Anh'])
        self.assertEqual(self.call({'input':'Xin chào','voice':'../voice.wav'})[0],422)

    def test_signed_profile_is_bound_to_meeting_and_unsigned_glossary_is_rejected(self):
        import base64,hmac
        received=[]
        self.engine.synthesize=lambda text,**kwargs:(received.append(kwargs) or b'\x01\0'*100)
        body={'voice':'Mai Anh','pronunciations':{'TINA':'ti na'},'meeting_id':14,'session':'synthetic'}
        payload=base64.urlsafe_b64encode(json.dumps(body).encode()).decode().rstrip('=')
        key='synthetic-profile-key-'+'x'*32
        profile=payload+'.'+hmac.new(key.encode(),b'tina-speech.v1:'+payload.encode(),'sha256').hexdigest()
        with patch.dict('os.environ',{'TINA_TTS_PROFILE_KEY':key}):
            self.assertEqual(self.call({'input':'TINA','meeting_id':14,'profile':profile})[0],200)
            self.assertEqual(received[-1]['voice'],'Mai Anh')
            self.assertEqual(received[-1]['pronunciations'],{'TINA':'ti na'})
            self.assertEqual(self.call({'input':'TINA','meeting_id':15,'profile':profile})[0],422)
            self.assertEqual(self.call({'input':'TINA','meeting_id':14,'profile':profile+'x'})[0],422)
        self.assertEqual(self.call({'input':'TINA','pronunciations':{'TINA':'ti na'}})[0],422)
    def setUp(self):
        self.calls = []
        def synthesize(text):
            self.calls.append(text)
            return b"\x01\x00" * 2400
        self.engine = TestEngine(synthesize)
        self.server = SpeechServer(("127.0.0.1", 0), self.engine, TOKEN)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = "http://127.0.0.1:" + str(self.server.server_port)
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def call(self, body=None, *, token=TOKEN, raw=None, path="/v1/audio/speech"):
        data = raw if raw is not None else json.dumps(body or {"input": "Xin chào"}).encode()
        request = urllib.request.Request(self.url + path, data=data,
            headers={"X-API-Key": token, "Content-Type": "application/json"})
        try:
            response = self.opener.open(request, timeout=3)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, dict(response.headers), response.read()

    def test_health_and_status_do_not_synthesize(self):
        for path in ("/health", "/status"):
            with self.opener.open(self.url + path) as r:
                self.assertEqual(json.load(r)["sample_rate"], 24000)
        self.assertEqual(self.calls, [])

    def test_authenticated_readiness_does_not_synthesize(self):
        self.assertEqual(self.call(path='/ready', raw=b'', token='bad')[0], 404)  # POST is not a readiness route.
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.opener.open(self.url + '/ready')
        self.assertEqual(error.exception.code, 401)
        req = urllib.request.Request(self.url + '/ready', headers={'X-API-Key': TOKEN})
        with self.opener.open(req) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.calls, [])

    def test_bot_request_returns_raw_pcm_and_no_text_logs(self):
        output = io.StringIO()
        with redirect_stderr(output):
            code, headers, audio = self.call({"input": "private marker", "model": "tts-1",
                                            "voice": "auto", "response_format": "pcm"})
        self.assertEqual(code, 200)
        self.assertEqual(headers["X-Audio-Sample-Rate"], "24000")
        self.assertEqual(headers["Content-Type"], "application/octet-stream")
        self.assertEqual(audio, b"\x01\x00" * 2400)
        self.assertNotIn("private marker", output.getvalue())
        self.assertNotIn(TOKEN, output.getvalue())

    def test_auth_precedes_json_and_inference(self):
        self.assertEqual(self.call(token="bad", raw=b"not JSON")[0], 401)
        self.assertEqual(self.calls, [])

    def test_meeting_scope_is_validated_and_clients_cannot_inject_pronunciation_rules(self):
        def synthesize(text, meeting_id=None):
            self.calls.append((text, meeting_id)); return b'\x01\x00' * 100
        self.server.engine = TestEngine(synthesize)
        self.assertEqual(self.call({'input': 'Original API', 'meeting_id': 14})[0], 200)
        self.assertEqual(self.calls, [('Original API', 14)])
        for mid in [True, 0, -1, '14', 1.5, 9007199254740992]:
            self.assertEqual(self.call({'input': 'Original API', 'meeting_id': mid})[0], 422)
        self.assertEqual(self.call({'input':'Original API','pronunciations':{'API':'wrong'}})[0],422)
        self.assertEqual(len(self.calls), 1)

    def test_rejects_invalid_text_format_voice_and_oversize(self):
        for body in ({"input": " "}, {"input": 123}, {"input": "x" * 4001},
                     {"input": "x", "response_format": "wav"},
                     {"input": "x", "voice": "unknown"}, {"input": "x", "model": "unknown"},
                     {"input": "x", "ref_audio": "untrusted.wav"}):
            self.assertEqual(self.call(body)[0], 422)
        self.assertEqual(self.call(raw=b"x" * 20001)[0], 413)
        self.assertEqual(self.call(raw=b"bad JSON")[0], 400)
        self.assertEqual(self.calls, [])

    def test_two_rooms_are_served_sequentially_after_queueing(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def blocked(text):
            calls.append(text)
            if len(calls) == 1:
                entered.set()
                release.wait(2)
            return b"\x01\x00" * 10
        self.engine.synthesize = blocked
        result = []
        first = threading.Thread(target=lambda: result.append(self.call({'input': 'room one'})[0]))
        second = threading.Thread(target=lambda: result.append(self.call({'input': 'room two'})[0]))
        first.start()
        self.assertTrue(entered.wait(1))
        second.start()
        deadline = time.monotonic() + 1
        while not self.server.queue and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertEqual(calls, ['room one'])
        self.assertEqual(len(self.server.queue), 1)
        release.set()
        first.join(3); second.join(3)
        self.assertEqual(result, [200, 200])
        self.assertEqual(calls, ['room one', 'room two'])

    def test_three_rooms_and_their_lookahead_fit_the_bounded_fifo(self):
        entered, release = threading.Event(), threading.Event()
        calls, result = [], []
        def blocked(text):
            calls.append(text)
            if len(calls) == 1: entered.set(); release.wait(4)
            return b'\x01\x00' * 10
        self.engine.synthesize = blocked
        threads = [threading.Thread(target=lambda i=i: result.append(self.call({'input': f'room sentence {i}'})[0])) for i in range(6)]
        try:
            threads[0].start(); self.assertTrue(entered.wait(1))
            for thread in threads[1:]: thread.start()
            deadline = time.monotonic() + 2
            while len(self.server.queue) < 5 and time.monotonic() < deadline: time.sleep(.01)
            self.assertEqual(len(self.server.queue), 5)
            self.assertEqual(len(calls), 1)
        finally:
            release.set()
            for thread in threads:
                if thread.ident is not None: thread.join(3)
        self.assertEqual(result, [200] * 6)
        self.assertEqual(len(calls), 6)

    def test_cached_public_notice_is_immediate_while_private_inference_is_busy(self):
        from engine import ACK_TEXT
        entered, release = threading.Event(), threading.Event()
        def blocked(text):
            entered.set(); release.wait(3)
            return b'\x01\x00' * 10
        self.engine.synthesize = blocked
        self.engine.cached_public = lambda text: b'\x01\x00' * 10 if text == ACK_TEXT else None
        first = threading.Thread(target=self.call)
        try:
            first.start(); self.assertTrue(entered.wait(1))
            self.assertEqual(self.call({'input': ACK_TEXT})[0], 200)
            self.assertTrue(self.server.busy.locked())
            self.assertEqual(len(self.server.queue), 0)
            self.assertEqual(self.call({'input': ACK_TEXT},token='wrong')[0], 401)
        finally:
            release.set(); first.join(3)

    def test_cancelled_queued_request_never_enters_inference(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        def blocked(text):
            calls.append(text); entered.set(); release.wait(2)
            return b"\x01\x00" * 10
        self.engine.synthesize = blocked
        first = threading.Thread(target=lambda: self.call({'input': 'room one'}))
        first.start(); self.assertTrue(entered.wait(1))
        connection = socket.create_connection(self.server.server_address)
        data = json.dumps({'input': 'cancel me'}).encode()
        connection.sendall(f'POST /v1/audio/speech HTTP/1.1\r\nHost: localhost\r\nX-API-Key: {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n'.encode() + data)
        deadline = time.monotonic() + 1
        while not self.server.queue and time.monotonic() < deadline: time.sleep(.01)
        connection.close()
        time.sleep(.15)
        release.set(); first.join(3)
        self.assertEqual(calls, ['room one'])

    def test_queued_request_times_out_without_second_inference(self):
        self.server.queue_timeout = .05
        entered, release = threading.Event(), threading.Event()
        def blocked(text):
            entered.set()
            release.wait(3)
            return b"\x01\x00" * 10
        self.engine.synthesize = blocked
        result = []
        request = threading.Thread(target=lambda: result.append(self.call()[0]))
        request.start()
        try:
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.call()[0], 503)
        finally:
            release.set()
            request.join(3)
        self.assertEqual(result, [200])

    def test_native_error_is_sanitized_and_lock_recovers(self):
        def broken(text):
            raise RuntimeError("secret exception containing " + text)
        original = self.engine.synthesize
        self.engine.synthesize = broken
        code, _, body = self.call({"input": "private marker"})
        self.assertEqual(code, 503)
        self.assertNotIn(b"private marker", body)
        self.assertFalse(self.server.busy.locked())
        self.engine.synthesize = original
        self.assertEqual(self.call()[0], 200)

    def test_short_startup_token_is_refused(self):
        with self.assertRaises(ValueError):
            SpeechServer(("127.0.0.1", 0), self.engine, "short")


class ConnectionLimitTests(unittest.TestCase):
    def test_slow_headers_have_total_deadline_and_excess_connections_are_refused(self):
        engine = TestEngine(lambda _: b"\x01\x00")
        server = SpeechServer(("127.0.0.1", 0), engine, TOKEN,
                              max_connections=1, request_timeout=.4)
        entered, finished = threading.Event(), threading.Event()
        original = server.process_request_thread
        def tracked(*args):
            entered.set()
            try:
                original(*args)
            finally:
                finished.set()
        server.process_request_thread = tracked
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        address = server.server_address
        try:
            with socket.create_connection(address, timeout=2) as slow:
                slow.sendall(b"GET /health HTTP/1.1\r\nX-Slow: ")
                self.assertTrue(entered.wait(1))
                with socket.create_connection(address, timeout=2) as excess:
                    try:
                        self.assertEqual(excess.recv(1), b"")
                    except ConnectionResetError:
                        pass
                started = time.monotonic()
                # Keep activity well inside the ordinary 10-second socket timeout.
                while not finished.wait(.03):
                    try:
                        slow.sendall(b"x")
                    except OSError:
                        break
                    self.assertLess(time.monotonic() - started, 2)
                self.assertTrue(finished.wait(1))
                self.assertLess(time.monotonic() - started, 2)
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f"http://127.0.0.1:{address[1]}/health", timeout=2) as response:
                self.assertEqual(response.status, 200)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)


class AudioTests(unittest.TestCase):
    def test_notice_cache_is_separate_for_each_preset_voice(self):
        from engine import Engine,ACK_TEXT
        import numpy as np
        calls=[];engine=Engine.__new__(Engine)
        def infer(text,**kwargs):
            calls.append(kwargs['voice']);return np.full(2400,.1 if kwargs['voice']=='Trúc Ly' else .2,dtype=np.float32)
        engine.tts=SimpleNamespace(sample_rate=24000,infer=infer)
        first=engine.synthesize(ACK_TEXT);second=engine.synthesize(ACK_TEXT,voice='Mai Anh')
        self.assertNotEqual(first,second)
        self.assertEqual(engine.synthesize(ACK_TEXT,voice='Mai Anh'),second)
        self.assertEqual(list(engine.stream(ACK_TEXT,voice='Mai Anh')),[second])
        self.assertEqual(calls,['Trúc Ly','Mai Anh'])

    def test_synthesis_uses_female_voice_and_spoken_name(self):
        import numpy as np
        from engine import Engine, spoken_text
        from unittest.mock import Mock

        engine = Engine.__new__(Engine)
        engine.tts = SimpleNamespace(sample_rate=24000, infer=Mock(return_value=np.ones(240)))
        original = "Xin chào, tôi là TINA. Tina giúp bạn dùng API."
        self.assertTrue(engine.synthesize(original))
        engine.tts.infer.assert_called_once_with(
            "Xin chào, tôi là ti na. ti na giúp bạn dùng ây pi ai.",
            voice="Trúc Ly", apply_watermark=False)
        self.assertIn("TINA", original)
        unchanged = "retina Latina TINA_API Tina123 đTINA"
        self.assertEqual(spoken_text(unchanged), unchanged)
        self.assertEqual(spoken_text("(TINA), tina!"), "(ti na), ti na!")

    def test_only_fixed_public_notices_are_cached(self):
        import numpy as np
        from engine import Engine, FIXED_TEXTS
        from unittest.mock import Mock
        engine = Engine.__new__(Engine)
        engine.tts = SimpleNamespace(sample_rate=24000, infer=Mock(return_value=np.ones(240)))
        self.assertEqual(len(FIXED_TEXTS), len(set(FIXED_TEXTS)))
        for text in FIXED_TEXTS:
            notice = engine.synthesize(text)
            self.assertEqual(engine.synthesize(text), notice)
            self.assertEqual(list(engine.stream(text)), [notice])
        self.assertEqual(engine.tts.infer.call_count, len(FIXED_TEXTS))
        engine.synthesize('Private meeting response')
        engine.synthesize('Private meeting response')
        self.assertEqual(engine.tts.infer.call_count, len(FIXED_TEXTS) + 2)
        engine._fixed_pcm['Private meeting response'] = b'not public'
        self.assertIsNone(engine.cached_public('Private meeting response'))

    def test_real_resampler_outputs_24k_little_endian_mono(self):
        import numpy as np
        from engine import pcm24
        wave = np.sin(2 * np.pi * 440 * np.arange(48000) / 48000) * .2
        pcm = pcm24(wave, 48000)
        self.assertEqual(len(pcm), 24000 * 2)
        self.assertGreater(np.abs(np.frombuffer(pcm, dtype="<i2")).max(), 100)
        self.assertFalse(pcm.startswith(b"RIFF"))
        for bad in (np.array([]), np.array([float("nan")]), np.zeros((2, 10))):
            with self.assertRaises(ValueError):
                pcm24(bad, 48000)


class AssetTests(unittest.TestCase):
    def test_offline_validation_requests_only_pinned_subset(self):
        import engine
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / "snapshot"
            snapshot.mkdir()
            content = b"test model bytes"
            (snapshot / "model.onnx").write_bytes(content)
            files = [{"path": "model.onnx", "sha256": hashlib.sha256(content).hexdigest()}]
            (root / "model-assets.json").write_text(json.dumps({"repos": [
                {"repo": "test/voice", "revision": "pinned", "files": files}]}))
            ref = root / "hub/models--test--voice/refs/main"
            ref.parent.mkdir(parents=True)
            ref.write_text("pinned")
            calls = []
            def downloaded(*args, **kwargs):
                calls.append(kwargs)
                return snapshot
            with patch.object(engine, "__file__", str(root / "engine.py")), patch.dict(
                sys.modules, {"huggingface_hub": SimpleNamespace(snapshot_download=downloaded)}
            ):
                engine.verify_assets(root)
                self.assertEqual(calls[0]["allow_patterns"], ["model.onnx"])
                self.assertTrue(calls[0]["local_files_only"])
                (snapshot / "model.onnx").write_bytes(b"tampered")
                with self.assertRaises(RuntimeError):
                    engine.verify_assets(root)


if __name__ == "__main__":
    unittest.main()
