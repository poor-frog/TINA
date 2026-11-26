"""Install checksum-verified model assets without loading model code."""
import hashlib
import json
import shutil
import urllib.request
from pathlib import Path

FSMN_MANIFEST = Path(__file__).with_name('fsmn-assets.json')


def fsmn_assets():
    return json.loads(FSMN_MANIFEST.read_text())


def verified(path, digest):
    if not path.is_file():
        return False
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() == digest


def install(path, digest, url, cached=None):
    if path.exists():
        if not verified(path, digest):
            raise ValueError(f'Existing asset checksum mismatch: {path.name}')
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.part')
    try:
        if cached and verified(cached, digest):
            shutil.copyfile(cached, temporary)
        else:
            with urllib.request.urlopen(url, timeout=60) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output, length=1024 * 1024)
        if not verified(temporary, digest):
            raise ValueError(f'Downloaded asset checksum mismatch: {path.name}')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
