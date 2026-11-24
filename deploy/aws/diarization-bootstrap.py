"""Fetch and verify the pinned upstream models before serving the AWS worker."""

import hashlib
import os
import sys
import tarfile
import urllib.request
from pathlib import Path


def download(url: str, path: Path, checksum: str) -> None:
    digest = hashlib.sha256()
    with urllib.request.urlopen(url, timeout=45) as response, path.open("wb") as target:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            target.write(chunk)
    if digest.hexdigest() != checksum:
        raise ValueError("Unexpected diarization model checksum")


if __name__ == "__main__":
    directory = Path(os.environ["TINA_DIARIZATION_MODELS"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive_path = directory / "segmentation.tar.bz2"
    release = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
    download(
        f"{release}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
        archive_path, "24615ee884c897d9d2ba09bb4d30da6bb1b15e685065962db5b02e76e4996488",
    )
    with tarfile.open(archive_path) as archive:
        for source, output in (("model.onnx", "segmentation.onnx"), ("LICENSE", "segmentation-LICENSE")):
            member = next(member for member in archive.getmembers()
                          if member.isfile() and Path(member.name).name == source)
            (directory / output).write_bytes(archive.extractfile(member).read())
    archive_path.unlink()
    download(
        f"{release}/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
        directory / "embedding.onnx", "f1ee61be04000b50392a63442e5dd9feaea7e81dddd494d3647cf1c3d88a1498",
    )
    os.execv(sys.executable, [sys.executable, "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8014"])
