"""Download pinned model data into a private HF cache; never execute hub code."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


def verify_file(path, entry):
    if "sha256" in entry:
        with path.open("rb") as data:
            actual = hashlib.file_digest(data, "sha256").hexdigest()
        expected = entry["sha256"]
    else:
        content = path.read_bytes()
        actual = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
        expected = entry["git_blob"]
    if actual != expected:
        raise RuntimeError("TTS asset verification failed: " + entry["path"])


def install_encrypted_archive(directory, manifest, archive):
    files = {}
    for repo in manifest["repos"]:
        snapshot = Path("hub") / ("models--" + repo["repo"].replace("/", "--")) / "snapshots" / repo["revision"]
        files.update((str(snapshot / entry["path"]), entry) for entry in repo["files"])
    password = sys.stdin.readline(66).rstrip("\n")
    if not re.fullmatch(r"[a-f0-9]{64}", password):
        raise RuntimeError("Missing or invalid TTS bundle password")
    with tempfile.TemporaryDirectory(prefix=".tina-tts-import-", dir=directory) as tmp:
        stage = Path(tmp)
        model_tar = stage / "models.tar.gz"
        result = subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-pbkdf2", "-iter", "200000",
                                 "-md", "sha256", "-pass", "stdin", "-in", str(archive), "-out", str(model_tar)],
                                input=password + "\n", text=True, capture_output=True, timeout=120)
        if result.returncode:
            raise RuntimeError("TTS bundle decryption failed")
        pending = set(files)
        total = 0
        with tarfile.open(model_tar, mode="r|gz") as data:
            for member in data:
                total += member.size
                if not member.isfile() or member.name not in pending or total > 600 * 1024**2:
                    raise RuntimeError("Unexpected file in TTS model archive")
                pending.remove(member.name)
                path = stage / member.name
                path.parent.mkdir(parents=True, exist_ok=True)
                with data.extractfile(member) as source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)
                verify_file(path, files[member.name])
        if pending:
            raise RuntimeError("TTS model archive is incomplete")
        for name in files:
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            (stage / name).replace(target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(os.environ.get("HF_HOME", "/models")))
    parser.add_argument("--encrypted-archive", type=Path)
    args = parser.parse_args()
    from huggingface_hub import snapshot_download

    manifest = json.loads(Path(__file__).with_name("model-assets.json").read_text())
    if args.encrypted_archive:
        args.directory.mkdir(parents=True, exist_ok=True)
        install_encrypted_archive(args.directory, manifest, args.encrypted_archive)
    for repo in manifest["repos"]:
        cache = args.directory / "hub"
        repo_cache = cache / ("models--" + repo["repo"].replace("/", "--"))
        snapshot = repo_cache / "snapshots" / repo["revision"]
        if not all((snapshot / entry["path"]).is_file() for entry in repo["files"]):
            snapshot = Path(snapshot_download(repo["repo"], revision=repo["revision"],
                allow_patterns=[f["path"] for f in repo["files"]], cache_dir=str(cache)))
        for entry in repo["files"]:
            verify_file(snapshot / entry["path"], entry)
        ref = repo_cache / "refs/main"
        ref.parent.mkdir(parents=True, exist_ok=True)
        ref.write_text(repo["revision"])
        print("Verified " + repo["repo"] + "@" + repo["revision"], flush=True)
    # Hub tree metadata is created mode 0600 by some SDK versions. The serving
    # non-root UID may differ from the installer UID; cached assets must remain
    # readable from the read-only mount.
    for path in args.directory.rglob("*.json"):
        if path.is_file():
            path.chmod(0o644)


if __name__ == "__main__":
    main()
