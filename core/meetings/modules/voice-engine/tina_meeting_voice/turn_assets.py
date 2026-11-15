"""Explicit hash-pinned installation; inference never downloads assets."""
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request


def manifest():
    return json.loads(Path(__file__).with_name('turn-models.json').read_text())


def check(path, expected):
    if path.is_symlink() or not path.is_file() or path.stat().st_size != expected['bytes']:
        raise ValueError('Missing or modified turn model')
    digest = hashlib.sha256()
    with path.open('rb') as source:
        while block := source.read(1024*1024): digest.update(block)
    if digest.hexdigest() != expected['sha256']:
        raise ValueError('Turn model checksum mismatch')


def verify(directory):
    for name, expected in manifest()['files'].items():
        check(directory/name, expected)


def install(directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name, expected in manifest()['files'].items():
        target = directory/name
        try:
            check(target, expected)
            continue
        except ValueError:
            pass
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
            temporary = Path(output.name)
            try:
                count = 0
                with urllib.request.urlopen(expected['url'], timeout=90) as response:
                    while block := response.read(1024*1024):
                        count += len(block)
                        if count > expected['bytes']: raise ValueError('Turn model exceeds pinned size')
                        output.write(block)
                output.flush()
                check(temporary, expected)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
    license_file = Path(__file__).with_name('smart-turn.LICENSE')
    (directory/'smart-turn.LICENSE').write_bytes(license_file.read_bytes())
    verify(directory)
