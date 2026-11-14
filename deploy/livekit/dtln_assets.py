"""Explicit build-time download of immutable upstream DTLN weights and their MIT notice."""
import hashlib
from pathlib import Path
import sys
import tempfile
import urllib.request

REVISION='1de1f15a8b5b7e1c44905618ff2ef70ca8277fbc'
ASSETS={
    'model_1.onnx':('pretrained_model/model_1.onnx',1458237,'22b91cae3855e5a0620e66a917ca6c82c58db0e842c770f58d86751c5e8d4ae3'),
    'model_2.onnx':('pretrained_model/model_2.onnx',2510010,'e20c92f9233fccf29cddf86970d0d0161a03aebccc26d6f4d5639c4d5ec2e639'),
    'LICENSE':('LICENSE',1075,'aa95acd8c8a7341bfcdb2823694dcbb27a2a4143e860bb52db1ff0f29c85e5a1'),
}
DIRECTORY=Path('/opt/tina-dtln')


def valid(path,size,digest):
    if not path.is_file() or path.stat().st_size!=size:return False
    with path.open('rb') as source:return hashlib.file_digest(source,'sha256').hexdigest()==digest


def verify(directory=DIRECTORY):
    for name,(_,size,digest) in ASSETS.items():
        if not valid(directory/name,size,digest):raise ValueError('Pinned DTLN asset missing or modified')


def install(directory):
    directory.mkdir(parents=True,exist_ok=True)
    for name,(relative,size,digest) in ASSETS.items():
        if valid(directory/name,size,digest):continue
        url=f'https://raw.githubusercontent.com/breizhn/DTLN/{REVISION}/{relative}'
        with tempfile.NamedTemporaryFile(dir=directory,delete=False) as output:
            temporary=Path(output.name)
            try:
                with urllib.request.urlopen(url,timeout=60) as source:
                    total=0
                    while chunk:=source.read(65536):
                        total+=len(chunk)
                        if total>size:raise ValueError('DTLN asset exceeds pinned size')
                        output.write(chunk)
                output.flush()
                if not valid(temporary,size,digest):raise ValueError('DTLN asset checksum mismatch')
                temporary.chmod(0o644);temporary.replace(directory/name)
            finally:temporary.unlink(missing_ok=True)
    verify(directory)


if __name__=='__main__':install(Path(sys.argv[1]) if len(sys.argv)>1 else DIRECTORY)
