"""Model-free clock, protocol and concurrency tests. Real-model replay is separate."""
import asyncio
import io
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import httpx
import numpy as np
import soundfile as sf
from fastapi import HTTPException, Request

import server
from gipformer.engine import GipformerEngine
from asr_audio import AudioInputError, read_audio, speech_ranges
from telemetry import AsrMetrics


def wav(samples, rate=16000):
    output = io.BytesIO()
    sf.write(output, samples, rate, format='WAV', subtype='FLOAT')
    return output.getvalue()


class VAD:
    def __init__(self, ranges):
        self.ranges, self.calls = ranges, []

    def generate(self, **kwargs):
        self.calls.append(kwargs)
        return [{'value': self.ranges}]


class Recognizer:
    def __init__(self):
        self.streams = []

    def create_stream(self):
        stream = SimpleNamespace(result=SimpleNamespace(text='xin chào'))
        stream.accept_waveform = lambda rate, pcm: self.streams.append((rate, pcm.copy()))
        return stream

    def decode_streams(self, streams):
        pass


class EngineTests(unittest.TestCase):
    def test_ranges_keep_original_clock_and_separate_cache(self):
        pcm = np.linspace(.01, .4, 32000, dtype=np.float32)
        vad, recognizer = VAD([[250, 500], [1000, 1500]]), Recognizer()
        engine = GipformerEngine(vad, recognizer)
        result = engine.transcribe(wav(pcm), 400)
        self.assertEqual([(s['start'], s['end']) for s in result['segments']], [(.25, .5), (1, 1.5)])
        np.testing.assert_array_equal(recognizer.streams[0][1], pcm[4000:8000])
        np.testing.assert_array_equal(recognizer.streams[1][1], pcm[16000:24000])
        engine.transcribe(wav(pcm))
        self.assertIsNot(vad.calls[0]['cache'], vad.calls[1]['cache'])
        self.assertEqual(vad.calls[0]['max_end_silence_time'], 400)
        self.assertNotIn('words', result['segments'][0])

    def test_silence_and_short_tail(self):
        vad, recognizer = VAD([[0, 200]]), Recognizer()
        engine = GipformerEngine(vad, recognizer)
        self.assertEqual(engine.transcribe(wav(np.zeros(16000, dtype=np.float32)))['text'], '')
        self.assertEqual(len(vad.calls), 0)
        tail = engine.transcribe(wav(np.full(800, .1, dtype=np.float32)))
        self.assertEqual(len(vad.calls[0]['input']), 3200)
        self.assertEqual(tail['duration'], .05)
        self.assertEqual(tail['segments'][0]['end'], .05)
        self.assertEqual(len(recognizer.streams[0][1]), 800)

    def test_stereo_resample_and_input_limits(self):
        pcm, duration = read_audio(wav(np.tile([.2, .4], (24000, 1)), 48000))
        self.assertEqual(duration, .5); self.assertEqual(len(pcm), 8000)
        np.testing.assert_allclose(pcm[100:-100], .3, atol=.001)
        for samples in [np.array([np.nan], dtype=np.float32), np.zeros((4, 9), dtype=np.float32), np.zeros(16000 * 91, dtype=np.float32)]:
            with self.assertRaises(AudioInputError): read_audio(wav(samples))

    def test_invalid_vad_is_not_empty_success(self):
        for result in [None, [], [{'value': None}], [{'value': [[100, 50]]}], [{'value': [[0, float('nan')]]}], [{'value': [[0, 100000]]}], [{'value': [[500, 600], [100, 200]]}]]:
            with self.assertRaises(RuntimeError): speech_ranges(result, 32000)
        self.assertEqual(speech_ranges([{'value': []}], 32000), [])
        self.assertEqual(speech_ranges([{'value': [[0, 90000]]}], 90 * 16000), [(0, 480000), (480000, 960000), (960000, 1440000)])


class FakeEngine:
    def __init__(self):
        self.calls = []; self.started = threading.Event(); self.release = threading.Event(); self.release.set()
        self.active = 0; self.max_active = 0; self.fail = False

    def transcribe(self, content, silence):
        self.active += 1; self.max_active = max(self.max_active, self.active)
        self.calls.append((content, silence)); self.started.set()
        try:
            if not self.release.wait(3): raise RuntimeError('test timeout')
            if self.fail: raise RuntimeError('Private model failure')
            return {'text': 'nội dung riêng tư', 'duration': 2, 'segments': [{'start': .25, 'end': 1.5, 'text': 'nội dung riêng tư'}]}
        finally: self.active -= 1


class ServerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = FakeEngine()
        server.app.state.token = 'test-token-' * 4
        server.app.state.engine = self.engine
        server.app.state.lock = asyncio.Semaphore(1)
        server.app.state.requests = 0
        server.app.state.metrics = AsrMetrics()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://test')
        self.audio = wav(np.full(32000, .1, dtype=np.float32))

    async def asyncTearDown(self):
        self.engine.release.set(); await self.client.aclose()

    async def transcribe(self, headers=None, **fields):
        return await self.client.post('/v1/audio/transcriptions', files={'file': ('test.wav', self.audio, 'audio/wav')},
            headers=headers if headers is not None else {'Authorization': 'Bearer ' + server.app.state.token},
            data={'model': 'custom', 'response_format': 'verbose_json', **fields})

    async def test_auth_before_decode_and_limits(self):
        self.assertEqual((await self.transcribe(headers={})).status_code, 401)
        self.assertEqual(len(self.engine.calls), 0)
        self.assertEqual((await self.transcribe(model='wrong-model')).status_code, 400)
        self.assertEqual((await self.transcribe(language='en')).status_code, 422)
        self.assertEqual((await self.transcribe(response_format='srt')).status_code, 422)
        self.assertEqual((await self.transcribe(min_silence_duration_ms=50)).status_code, 422)
        with patch.object(server.app.state, 'max_bytes', 100):
            self.assertEqual((await self.transcribe()).status_code, 413)
        self.assertEqual(len(self.engine.calls), 0)

    async def test_chunked_body_limit_is_enforced_before_multipart_spooling(self):
        async def chunks():
            yield b'--x\r\nContent-Disposition: form-data; name="file"; filename="test.wav"\r\nContent-Type: audio/wav\r\n\r\n'
            yield b'x' * 700000
            yield b'x' * 700000
            yield b'\r\n--x--\r\n'
        with patch.object(server.app.state, 'max_bytes', 100):
            response = await self.client.post('/v1/audio/transcriptions', content=chunks(),
                headers={'Authorization': 'Bearer ' + server.app.state.token, 'Content-Type': 'multipart/form-data; boundary=x'})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(len(self.engine.calls), 0)

    async def test_protocol_and_private_metrics(self):
        response = await self.transcribe(model='whisper-1', prompt='do not echo this context', min_silence_duration_ms=350)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['language'], 'unknown')
        self.assertEqual(response.json()['segments'][0]['start'], .25)
        self.assertIn('X-ASR-Request-ID', response.headers)
        self.assertIn('asr_inference', response.headers['Server-Timing'])
        self.assertEqual(self.engine.calls[0], (self.audio, 350))
        self.assertEqual((await self.transcribe(language='vi')).json()['language'], 'vi')
        self.assertEqual((await self.transcribe(response_format='text')).text, 'nội dung riêng tư')
        status = (await self.client.get('/status')).json()
        self.assertEqual(status['version'], 'asr-status.v1')
        self.assertEqual(status['model']['device'], server.DEVICE)
        self.assertEqual(status['model']['asr_model'], server.MODEL)
        self.assertNotIn('nội dung', json.dumps(status, ensure_ascii=False))
        self.assertNotIn('test-token', json.dumps(status))
        caps = (await self.client.get('/capabilities')).json()
        self.assertEqual(caps['runtime'], server.DECODER)
        self.assertFalse(caps['word_timestamps']); self.assertFalse(caps['language_detection']); self.assertFalse(caps['prompt'])

    async def test_queue_and_model_failure(self):
        self.engine.release.clear()
        tasks = [asyncio.create_task(self.transcribe()) for _ in range(4)]
        for _ in range(100):
            if server.app.state.requests == 4: break
            await asyncio.sleep(.005)
        self.assertEqual((await self.transcribe()).status_code, 429)
        self.engine.release.set()
        self.assertTrue(all(r.status_code == 200 for r in await asyncio.gather(*tasks)))
        self.assertEqual(self.engine.max_active, 1)
        self.assertEqual(server.app.state.requests, 0)
        self.engine.fail = True
        response = await self.transcribe()
        self.assertEqual(response.status_code, 502)
        self.assertNotIn('Private model failure', response.text)

    async def test_cancel_keeps_native_lock_until_thread_exits(self):
        request = Mock(spec=Request); request.is_disconnected = AsyncMock(return_value=False); request.state = SimpleNamespace(asr_timing={}); request.app = server.app
        self.engine.release.clear()
        task = asyncio.create_task(server.infer(request, self.audio, 800))
        for _ in range(100):
            if self.engine.started.is_set(): break
            await asyncio.sleep(.005)
        task.cancel(); await asyncio.sleep(.02)
        self.assertTrue(server.app.state.lock.locked())
        self.assertFalse(task.done())
        self.engine.release.set()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertFalse(server.app.state.lock.locked()); self.assertEqual(server.app.state.requests, 0)

    async def test_repeated_cancel_serializes_next_request_even_after_native_failure(self):
        for native_failure in (False, True):
            with self.subTest(native_failure=native_failure):
                engine = FakeEngine()
                engine.fail = native_failure
                engine.release.clear()
                server.app.state.engine = engine
                request = Mock(spec=Request)
                request.is_disconnected = AsyncMock(return_value=False)
                request.state = SimpleNamespace(asr_timing={})
                request.app = server.app
                first = asyncio.create_task(server.infer(request, self.audio, 800))
                second = None
                try:
                    for _ in range(100):
                        if engine.started.is_set(): break
                        await asyncio.sleep(.005)
                    self.assertTrue(engine.started.is_set())
                    for _ in range(3):
                        first.cancel()
                        await asyncio.sleep(.01)
                        self.assertTrue(server.app.state.lock.locked())
                        self.assertFalse(first.done())
                        self.assertEqual(server.app.state.requests, 1)
                    second = asyncio.create_task(server.infer(request, self.audio, 800))
                    await asyncio.sleep(.02)
                    self.assertEqual(len(engine.calls), 1)
                    engine.release.set()
                    with self.assertRaises(asyncio.CancelledError): await first
                    if native_failure:
                        with self.assertRaises(RuntimeError): await second
                    else:
                        self.assertTrue((await second)['text'])
                    self.assertEqual(engine.max_active, 1)
                    self.assertFalse(server.app.state.lock.locked())
                    self.assertEqual(server.app.state.requests, 0)
                finally:
                    engine.release.set()
                    await asyncio.gather(first, *([second] if second else []), return_exceptions=True)

    async def test_wait_timeout_and_disconnected_queue(self):
        request = Mock(spec=Request); request.is_disconnected = AsyncMock(return_value=False); request.state = SimpleNamespace(asr_timing={}); request.app = server.app
        await server.app.state.lock.acquire()
        try:
            with patch.object(server.app.state, 'wait_seconds', .02):
                with self.assertRaises(HTTPException) as caught: await server.infer(request, self.audio, 800)
                self.assertEqual(caught.exception.status_code, 503)
        finally: server.app.state.lock.release()
        request.is_disconnected = AsyncMock(return_value=True)
        with self.assertRaises(HTTPException) as caught: await server.infer(request, self.audio, 800)
        self.assertEqual(caught.exception.status_code, 499)
        self.assertEqual(len(self.engine.calls), 0)


if __name__ == '__main__':
    unittest.main()
