from types import SimpleNamespace
import pytest
from runtime_kernel.docker_backend import DockerBackend
from runtime_kernel.profiles import Runnable


def test_meeting_voice_mount_is_read_only_and_source_is_operator_owned(monkeypatch):
    monkeypatch.setenv('TINA_MEETING_VOICE_MODELS_VOLUME', 'trusted-speech-cache')
    backend = DockerBackend()
    payloads = []
    def request(method, path, **kwargs):
        if '/create' in path:
            payloads.append(kwargs['json'])
            return SimpleNamespace(status_code=201, json=lambda: {'Id': 'fake'})
        return SimpleNamespace(status_code=204)
    monkeypatch.setattr(backend, '_req', request)
    backend.start('mtg-1-test', Runnable(image='test-only'), {'TINA_VOICE_URL': 'http://meeting/voice',
                  'TINA_MEETING_VOICE_MODELS_VOLUME': 'attacker-value-is-ignored'})
    mount = payloads[0]['HostConfig']['Mounts'][-1]
    assert mount == {'Type': 'volume', 'Source': 'trusted-speech-cache', 'Target': '/models/meeting-voice',
                     'ReadOnly': True, 'VolumeOptions': {'NoCopy': True}}
    backend.start('mtg-2-test', Runnable(image='test-only'), {})
    assert 'Mounts' not in payloads[1]['HostConfig']


def test_missing_operator_model_cache_refuses_voice_mount(monkeypatch):
    monkeypatch.delenv('TINA_MEETING_VOICE_MODELS_VOLUME', raising=False)
    with pytest.raises(ValueError, match='model volume'):
        DockerBackend().start('mtg-1-test', Runnable(image='test-only'), {'TINA_VOICE_URL': 'http://meeting/voice'})
