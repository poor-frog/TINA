"""Chunk continuity, early audio, and incomplete-response failures without private input."""
import http.client
import threading
import socket
import time
import unittest
import urllib.request
import numpy as np
import soxr
from types import SimpleNamespace
from engine import Engine
from speech_text import default_pronunciations
import test_server


class EngineStreamTests(unittest.TestCase):
    def test_stateful_resampling_and_final_flush_match_full_waveform(self):
        waveform = (.2 * np.sin(2 * np.pi * 440 * np.arange(48003) / 48000)).astype(np.float32)
        engine = Engine.__new__(Engine); engine.pronunciations = default_pronunciations()
        chunks = [waveform[:17], waveform[17:5000], waveform[5000:16001], waveform[16001:]]
        engine.tts = SimpleNamespace(sample_rate=48000, infer_stream=lambda *_a, **_kw: iter_with_close(chunks))
        actual = np.frombuffer(b''.join(engine.stream('TINA API')), dtype='<i2')
        expected = np.rint(np.clip(soxr.resample(waveform,48000,24000,quality='HQ'),-1,1)*32767).astype('<i2')
        self.assertEqual(len(actual), len(expected))
        self.assertLessEqual(np.abs(actual.astype(np.int32)-expected).max(), 1)

    def test_cancel_closes_native_iterator_and_invalid_chunk_fails(self):
        closed = []
        def chunks():
            try:
                yield np.zeros(10000,dtype=np.float32)
                yield np.array([float('nan')],dtype=np.float32)
            finally: closed.append(True)
        engine=Engine.__new__(Engine);engine.pronunciations=default_pronunciations()
        engine.tts=SimpleNamespace(sample_rate=24000,infer_stream=lambda *_a,**_kw:chunks())
        stream=engine.stream('TINA');next(stream);stream.close();self.assertEqual(closed,[True])
        with self.assertRaises(ValueError):list(engine.stream('TINA'))


def iter_with_close(chunks):
    yield from chunks


class HttpStreamTests(unittest.TestCase):
    setUp = test_server.ServerTests.setUp
    tearDown = test_server.ServerTests.tearDown
    def test_disconnect_during_native_chunk_discards_it_and_releases_the_next_room(self):
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        generated=[]
        def chunks(_text):
            try:
                entered.set();release.wait(2);generated.append('first')
                yield b'\x01\x00'*4000
                generated.append('late');yield b'\x02\x00'*4000
            finally:closed.set()
        self.engine.stream=chunks
        connection=socket.create_connection(self.server.server_address,timeout=2)
        data=b'{"input":"synthetic"}'
        try:
            connection.sendall(f'POST /v1/audio/speech HTTP/1.1\r\nHost: localhost\r\nX-API-Key: {test_server.TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\n\r\n'.encode()+data)
            self.assertTrue(entered.wait(1))
            connection.close();release.set()
            self.assertTrue(closed.wait(1))
            deadline=time.monotonic()+1
            while self.server.busy.locked() and time.monotonic()<deadline:time.sleep(.01)
            self.assertFalse(self.server.busy.locked())
            self.assertEqual(generated,['first'])
        finally:connection.close();release.set()
        self.engine.stream=lambda _text:iter_with_close([b'\x01\x00'*100])
        self.assertEqual(test_server.ServerTests.call(self)[0],200)
    def test_iterator_cleanup_failure_does_not_log_private_model_details(self):
        class Chunks:
            first = True
            def __next__(self):
                if not self.first: raise StopIteration
                self.first=False; return b'\x01\x00'*100
            def close(self): raise ValueError('PRIVATE MODEL CONTENT')
        self.engine.stream=lambda _:Chunks()
        with self.assertLogs('tina.tts',level='ERROR') as logs:
            status, _, _ = test_server.ServerTests.call(self)
        self.assertEqual(status,200)
        self.assertNotIn('PRIVATE MODEL CONTENT',' '.join(logs.output))

    def test_first_audio_arrives_before_remaining_synthesis_and_midstream_failure_is_not_success(self):
        release=threading.Event()
        def chunks(_text):
            yield b'\x01\x00'*4000
            release.wait(2)
            yield b'\x02\x00'*4000
        self.engine.stream=chunks
        req=urllib.request.Request(self.url+'/v1/audio/speech',data=b'{"input":"synthetic"}',headers={
            'Content-Type':'application/json','X-API-Key':self.server.token.decode()})
        try:
            with self.opener.open(req,timeout=3) as response:
                self.assertEqual(response.headers['Transfer-Encoding'],'chunked')
                self.assertEqual(response.read(20),b'\x01\x00'*10)
                self.assertFalse(release.is_set())
                release.set();self.assertEqual(len(response.read()),15980)
        finally:release.set()
        def broken(_text):
            yield b'\x01\x00'*4000
            raise ValueError('private model failure')
        self.engine.stream=broken
        with self.opener.open(req,timeout=3) as response:
            with self.assertRaises(http.client.IncompleteRead):response.read()
        self.assertFalse(self.server.busy.locked())


if __name__=='__main__':unittest.main()
