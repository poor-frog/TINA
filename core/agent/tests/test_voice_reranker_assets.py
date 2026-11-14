"""The optional local candidate never substitutes unchecked model artifacts."""
import hashlib
import json
from pathlib import Path

import pytest

from control_plane.voice_reranker import MANIFEST, verify


def test_manifest_pins_safetensors_tokenizer_and_model_revision():
    assert MANIFEST['model'] == 'BAAI/bge-reranker-v2-m3'
    assert len(MANIFEST['revision']) == 40 and MANIFEST['license'] == 'Apache-2.0'
    assert {'model.safetensors', 'tokenizer.json', 'config.json'} <= set(MANIFEST['files'])
    assert all('/' not in n and len(s['sha256']) == 64 and s['size'] > 0 for n, s in MANIFEST['files'].items())


def test_verification_streams_exact_bytes_and_refuses_modified_weights(tmp_path):
    path = tmp_path/'model.safetensors'; path.write_bytes(b'test weights')
    specification = {'size': 12, 'sha256': hashlib.sha256(b'test weights').hexdigest()}
    verify(path, specification)
    path.write_bytes(b'bad! weights')
    with pytest.raises(ValueError, match='checksum'): verify(path, specification)
    path.write_bytes(b'bad')
    with pytest.raises(ValueError, match='size'): verify(path, specification)
