"""Download pinned model data into a private HF cache; never execute hub code."""
import argparse
import hashlib
import json
import os
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, default=Path(os.environ.get("HF_HOME", "/models")))
    args = parser.parse_args()
    from huggingface_hub import snapshot_download

    manifest = json.loads(Path(__file__).with_name("model-assets.json").read_text())
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
