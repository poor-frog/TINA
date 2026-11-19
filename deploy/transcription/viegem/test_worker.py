"""Model-free source-clock and API checks; no downloaded model/code is imported."""
import asyncio
import io
import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import httpx
import numpy as np
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from engine import VieGemEngine, verify_model_assets, name_biased_decoder, contextual_biased_decoder
from gipformer.engine import AudioInputError
from gipformer.telemetry import AsrMetrics
from http_worker import create_app


def wav(pcm):
    stream = io.BytesIO()
    sf.write(stream, pcm, 16000, format='WAV', subtype='FLOAT')
    return stream.getvalue()


class EngineTests(unittest.TestCase):
    def test_name_bias_is_opt_in_bounded_and_preserves_baseline_decoder(self):
        base = SimpleNamespace(vocab={'tin', 'anh'}, prefixes={'t', 'ti', 'tin', 'a', 'an', 'anh'},
                               bias_words=set(), bias_weight=0)
        self.assertIs(name_biased_decoder(base, 0), base)
        biased = name_biased_decoder(base, .25)
        self.assertEqual(biased.bias_words, {'tina'})
        self.assertIn('tina', biased.vocab)
        self.assertIn('tina', biased.prefixes)
        self.assertEqual(biased.bias_weight, .25)
        self.assertNotIn('tina', base.vocab)
        self.assertEqual(base.bias_weight, 0)
        for value in (-1, 2.1, float('nan'), float('inf')):
            with self.assertRaises(ValueError): name_biased_decoder(base, value)

    def test_custom_bias_reserves_tina_for_the_name_weight(self):
        class FakeDecoder:
            def __init__(self):
                self.vocab, self.prefixes = {'release'}, {'r', 're', 'rel', 'rele', 'relea', 'releas', 'release'}
                self.bias_words, self.bias_weight = set(), 0

            def _word(self, state, word):
                return state, 2.0

        base = FakeDecoder()
        custom = contextual_biased_decoder(base, ['release', 'TINA'], name_weight=0, custom_weight=1)
        self.assertEqual(custom.bias_words, {'release'})
        self.assertNotIn('tina', custom.vocab)
        self.assertEqual(custom._word(None, 'release')[1], 3.0)
        self.assertEqual(custom._word(None, 'tina')[1], 2.0)

        named = contextual_biased_decoder(base, ['release', 'tina'], name_weight=.25, custom_weight=1)
        self.assertEqual(named.bias_weights, {'release': 1.0, 'tina': .25})
        self.assertEqual(named._word(None, 'tina')[1], 2.25)
        self.assertEqual(base.bias_words, set())

    def test_speech_samples_and_source_offsets(self):
        vad = Mock()
        vad.generate.return_value = [{'value': [[250, 500], [1000, 1500]]}]
        engine = VieGemEngine.__new__(VieGemEngine)
        engine.vad = vad
        engine.decode = Mock(return_value='nội dung')
        pcm = np.linspace(.01, .4, 32000, dtype=np.float32)
        result = engine.transcribe(wav(pcm), 350)
        self.assertEqual([(s['start'], s['end']) for s in result['segments']], [(.25, .5), (1, 1.5)])
        np.testing.assert_array_equal(engine.decode.call_args_list[0].args[0], pcm[4000:8000])
        np.testing.assert_array_equal(engine.decode.call_args_list[1].args[0], pcm[16000:24000])
        cache = vad.generate.call_args.kwargs['cache']
        engine.transcribe(wav(pcm))
        self.assertIsNot(cache, vad.generate.call_args.kwargs['cache'])
        self.assertNotIn('words', result['segments'][0])

    def test_short_input_silence_and_invalid_audio(self):
        engine = VieGemEngine.__new__(VieGemEngine)
        engine.vad = Mock()
        engine.vad.generate.return_value = [{'value': [[0, 200]]}]
        engine.decode = Mock(return_value='có')
        self.assertEqual(engine.transcribe(wav(np.zeros(16000)))['segments'], [])
        engine.vad.generate.assert_not_called()
        result = engine.transcribe(wav(np.full(800, .1)))
        self.assertEqual(result['segments'][0]['end'], .05)
        self.assertEqual(len(engine.decode.call_args.args[0]), 800)
        with self.assertRaises(AudioInputError):
            engine.transcribe(wav(np.array([float('nan')])))

    def test_missing_assets_fail_before_code_import(self):
        with self.assertRaises(FileNotFoundError):
            verify_model_assets(Path('/nonexistent/tina-viegem-model-assets'))


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_auth_languages_limits_and_model_failure(self):
        fake = Mock()
        fake.transcribe.return_value = {'text': 'xin chào API', 'duration': 1, 'segments': []}
        app = create_app(model_id='5CD-AI/VieGem-ASR', name='VieGem + KenLM', prefix='TINA_VIEGEM',
                         default_directory=Path('.'), load_engine=lambda _: fake,
                         device='cpu', decoder='pytorch-ctc-kenlm', languages=('vi', 'en'))
        app.state.token = 'private-test-token' * 3
        app.state.engine = fake
        app.state.lock = asyncio.Semaphore(1)
        app.state.requests = 0
        app.state.metrics = AsrMetrics()
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            headers = {'Authorization': 'Bearer ' + app.state.token}
            audio = wav(np.full(16000, .1))
            async def post(**fields):
                return await client.post('/v1/audio/transcriptions', headers=headers,
                                         files={'file': ('clip.wav', audio)}, data=fields)
            denied = await client.post('/v1/audio/transcriptions', content=b'no multipart parser')
            self.assertEqual(denied.status_code, 401)
            fake.transcribe.assert_not_called()
            for language in ('vi', 'en', 'auto'):
                response = await post(model='5CD-AI/VieGem-ASR', language=language, response_format='verbose_json')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['language'], language if language != 'auto' else 'unknown')
            self.assertEqual((await post(model='unknown')).status_code, 400)
            self.assertEqual((await post(language='ja')).status_code, 422)
            with patch.object(app.state, 'max_bytes', 100):
                self.assertEqual((await post()).status_code, 413)
            fake.transcribe.side_effect = AudioInputError('bad audio')
            self.assertEqual((await post()).status_code, 400)
            fake.transcribe.side_effect = RuntimeError('private exception')
            response = await post()
            self.assertEqual(response.status_code, 502)
            self.assertNotIn('private exception', response.text)
            status = (await client.get('/status')).json()
            self.assertNotIn('xin chào', json.dumps(status, ensure_ascii=False))
            self.assertEqual((await client.get('/capabilities')).json()['languages'], ['vi', 'en'])


class DrainTests(unittest.IsolatedAsyncioTestCase):
    async def test_control_key_and_active_requests_protect_inference(self):
        import threading
        started, release = threading.Event(), threading.Event()
        def transcribe(*_):
            started.set(); release.wait(3)
            return {'text': 'xin chào', 'duration': 1, 'segments': []}
        fake = Mock(); fake.transcribe.side_effect = transcribe
        app = create_app(model_id='test', name='test', prefix='TINA_TEST', default_directory=Path('.'),
                         load_engine=lambda *_: fake, device='cpu', decoder='test', languages=('vi',))
        with patch.dict('os.environ', {'TINA_TEST_TOKEN': 'x' * 32, 'TINA_TEST_DRAIN_KEY': 'y' * 64}):
            async with app.router.lifespan_context(app), httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                denied = await client.post('/internal/drain', headers={'X-ASR-Control-Key': 'x' * 32}, json={'draining': True})
                self.assertEqual(denied.status_code, 401)
                headers = {'X-ASR-Control-Key': 'y' * 64}
                pending = asyncio.create_task(client.post('/v1/audio/transcriptions', headers={'Authorization': 'Bearer ' + 'x' * 32}, files={'file': ('a.wav', b'a')}))
                for _ in range(100):
                    if started.is_set(): break
                    await asyncio.sleep(.005)
                self.assertTrue(started.is_set())
                self.assertEqual((await client.post('/internal/drain', headers=headers, json={'draining': True})).status_code, 409)
                release.set(); self.assertEqual((await pending).status_code, 200)
                self.assertEqual((await client.post('/internal/drain', headers=headers, json=['draining'])).status_code, 422)
                self.assertEqual((await client.post('/internal/drain', headers=headers, json={'draining': True})).status_code, 200)
                blocked = await client.post('/v1/audio/transcriptions', headers={'Authorization': 'Bearer ' + 'x' * 32}, files={'file': ('a.wav', b'a')})
                self.assertEqual(blocked.status_code, 503)
                self.assertEqual((await client.post('/internal/drain', headers=headers, json={'draining': False})).status_code, 200)


if __name__ == '__main__':
    unittest.main()
