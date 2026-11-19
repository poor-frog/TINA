"""Optional BGE candidate for offline A/B evaluation; inference never downloads or sends text out."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile
import time
import urllib.request

MANIFEST = json.loads(Path(__file__).with_name('bge-reranker-assets.json').read_text())
DIRECTORY = Path.home() / '.cache/tina/bge-reranker-v2-m3'


def verify(path, specification):
    if path.stat().st_size != specification['size']: raise ValueError('Reranker artifact size mismatch')
    with path.open('rb') as stream: actual = hashlib.file_digest(stream, 'sha256').hexdigest()
    if actual != specification['sha256']: raise ValueError('Reranker artifact checksum mismatch')


def download(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, specification in MANIFEST['files'].items():
        path = directory / name
        if path.is_file():
            try: verify(path, specification); continue
            except ValueError: pass
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
                temporary = Path(output.name)
                url = f'https://huggingface.co/{MANIFEST["model"]}/resolve/{MANIFEST["revision"]}/{name}'
                with urllib.request.urlopen(url, timeout=120) as response:
                    while block := response.read(1024*1024): output.write(block)
            verify(temporary, specification)
            temporary.chmod(0o644); temporary.replace(path)
            print(json.dumps({'artifact': name, 'verified': True}), flush=True)
        finally:
            if temporary is not None: temporary.unlink(missing_ok=True)


class Reranker:
    def __init__(self, directory=DIRECTORY, device='cpu'):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
        started = time.monotonic()
        directory = Path(directory)
        for name, specification in MANIFEST['files'].items(): verify(directory / name, specification)
        if device not in ('cpu', 'mps', 'cuda'): raise ValueError('Invalid reranker device')
        self.torch = torch
        if device == 'cpu': torch.set_num_threads(2)
        self.device = device
        self.tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True)
        self.model = AutoModelForSequenceClassification.from_pretrained(directory, local_files_only=True,
            use_safetensors=True).to(device).eval()
        self.load_ms = round((time.monotonic()-started)*1000)
        self.last_ms = 0

    def __call__(self, question, sources):
        if not 0 < len(sources) <= 48 or len(question) > 2000: raise ValueError('Reranker input exceeds bound')
        started = time.monotonic(); scores = []
        with self.torch.inference_mode():
            for offset in range(0, len(sources), 4):
                pairs = [[question, s['quote']] for s in sources[offset:offset+4]]
                inputs = self.tokenizer(pairs, padding=True, truncation=True, return_tensors='pt', max_length=512).to(self.device)
                logits = self.model(**inputs, return_dict=True).logits.view(-1).float().cpu().tolist()
                if any(not math.isfinite(v) for v in logits): raise ValueError('Invalid reranker score')
                scores.extend(logits)
        self.last_ms = round((time.monotonic()-started)*1000)
        ranked = sorted(range(len(sources)), key=lambda i: (-scores[i], i))
        return [sources[i] | {'retrieval': sources[i].get('retrieval', {}) |
            {'rerank_model': MANIFEST['model'], 'rerank_score': scores[i]}} for i in ranked]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--download', action='store_true', required=True)
    parser.add_argument('--directory', type=Path, default=DIRECTORY)
    args = parser.parse_args(); download(args.directory)
