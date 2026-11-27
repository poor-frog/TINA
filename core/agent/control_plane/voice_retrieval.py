"""Local CPU multilingual embeddings; only the caller's approved source list is ranked."""
from collections import OrderedDict
import hashlib
import json
import logging
import os
from pathlib import Path
import threading
import time

MODEL = 'Xenova/multilingual-e5-small'
REVISION = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
FILES = {
    'onnx/model_quantized.onnx': 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
    'tokenizer.json': '0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39',
}
DIRECTORY = Path(os.environ.get('TINA_VOICE_EMBED_DIR', Path.home() / '.cache/tina/voice-retrieval'))
log = logging.getLogger(__name__)
_lock = threading.Lock()
_LOCK_TIMEOUT = 0.25
_encoder = None
_failed = False
_retry_at = 0.0


def file_hash(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def download(directory):
    import tempfile
    import urllib.request
    for relative, expected in FILES.items():
        path = directory / relative
        if path.is_file() and file_hash(path) == expected: continue
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as output:
                temporary = Path(output.name)
                with urllib.request.urlopen(f'https://huggingface.co/{MODEL}/resolve/{REVISION}/{relative}', timeout=120) as response:
                    while block := response.read(1024 * 1024): output.write(block)
            if file_hash(temporary) != expected: raise ValueError('Embedding artifact checksum mismatch')
            temporary.chmod(0o644); temporary.replace(path)
        finally:
            if temporary is not None: temporary.unlink(missing_ok=True)
    print(json.dumps({'model': MODEL, 'revision': REVISION, 'assets_verified': True}), flush=True)


class Encoder:
    def __init__(self, directory):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        for relative, expected in FILES.items():
            if file_hash(directory / relative) != expected: raise ValueError('Embedding artifact checksum mismatch')
        self.np = np
        self.tokenizer = Tokenizer.from_file(str(directory / 'tokenizer.json'))
        options = ort.SessionOptions(); options.intra_op_num_threads = 2; options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.session = ort.InferenceSession(str(directory / 'onnx/model_quantized.onnx'), options,
                                            providers=['CPUExecutionProvider'])
        self.cache = OrderedDict()
        self.last_indexed = 0

    def embed(self, texts, prefix):
        np = self.np
        prefix_ids = self.tokenizer.encode(prefix + ': ', add_special_tokens=False).ids
        capacity = 510 - len(prefix_ids)
        windows, owners = [], []
        for owner, text in enumerate(texts):
            ids = self.tokenizer.encode(text, add_special_tokens=False).ids
            for start in range(0, max(1, len(ids)), capacity - 32):
                windows.append([0] + prefix_ids + ids[start:start + capacity] + [2]); owners.append(owner)
                if start + capacity >= len(ids): break
        vectors = [[] for _ in texts]
        for offset in range(0, len(windows), 8):
            batch = windows[offset:offset + 8]; width = max(map(len, batch))
            inputs = np.full((len(batch), width), 1, dtype=np.int64)
            mask = np.zeros_like(inputs)
            for i, tokens in enumerate(batch): inputs[i, :len(tokens)] = tokens; mask[i, :len(tokens)] = 1
            features = {'input_ids': inputs, 'attention_mask': mask}
            names = {value.name for value in self.session.get_inputs()}
            if 'token_type_ids' in names: features['token_type_ids'] = np.zeros_like(inputs)
            output = self.session.run(None, features)[0]
            weights = mask[..., None]
            pooled = (output * weights).sum(axis=1) / weights.sum(axis=1)
            for i, vector in enumerate(pooled): vectors[owners[offset + i]].append(vector)
        result = []
        for parts in vectors:
            vector = np.asarray(parts).mean(axis=0).astype(np.float32)
            norm = np.linalg.norm(vector)
            if not np.isfinite(vector).all() or norm <= 0: raise ValueError('Invalid embedding')
            result.append(vector / norm)
        return result

    def rank(self, scope, question, sources):
        now = time.monotonic()
        for key, (created, _) in list(self.cache.items()):
            if now - created >= 900: del self.cache[key]
        query = self.embed([question], 'query')[0]
        deadline = time.monotonic() + 3
        keys = [(scope, s['key'], s['fingerprint']) for s in sources]
        missing = [i for i,k in enumerate(keys) if k not in self.cache]
        # shortcut: bound cold indexing to three seconds; later turns fill the remaining cache.
        for start in range(0, len(missing), 8):
            if time.monotonic() >= deadline: break
            batch = missing[start:start + 8]
            for i, vector in zip(batch, self.embed([sources[i]['quote'] for i in batch], 'passage')):
                self.cache[keys[i]] = (now, vector)
                while len(self.cache) > 8192: self.cache.popitem(last=False)
        ranked = []
        indexed = 0
        for i, key in enumerate(keys):
            cached = self.cache.pop(key, None)
            if cached is None: continue
            created, vector = cached
            self.cache[key] = cached; indexed += 1
            similarity = float(vector @ query)
            if similarity >= .75: ranked.append((i, similarity))
        ranked.sort(key=lambda row: (-row[1], row[0]))
        self.last_indexed = indexed
        log.info('voice retrieval semantic indexed=%d candidates=%d', indexed, len(sources))
        return [i for i, _ in ranked[:16]]


def semantic_rank(scope, question, sources):
    global _encoder, _failed, _retry_at
    if not sources: return []
    if not _lock.acquire(timeout=_LOCK_TIMEOUT):
        log.warning('voice semantic retrieval skipped lock_busy=true candidates=%d', len(sources))
        return []
    try:
        if time.monotonic() < _retry_at: return []
        if _encoder is None: _encoder = Encoder(DIRECTORY)
        ranked = _encoder.rank(scope, question, sources)
        _failed, _retry_at = False, 0.0
        return ranked
    except Exception as exc:
        log.warning('voice semantic retrieval unavailable error=%s', type(exc).__name__)
        _failed = True
        # Retry both initialization and inference faults without hammering unavailable assets/runtime.
        _retry_at = time.monotonic() + 30
        return []
    finally:
        _lock.release()


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', required=True)
    parser.add_argument('--directory', type=Path, default=DIRECTORY)
    download(parser.parse_args().directory)
