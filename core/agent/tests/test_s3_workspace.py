"""Unit tests for S3-backed ephemeral workspaces: snapshot CAS, 3-way merge, policy guard,
_system cache exclusion, symlink-loop resilience, compaction, and EFS->S3 migration."""
from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

import pytest

from control_plane.workspace_store import S3WorkspaceStore
from shared.s3_workspace import (
    SyncState,
    _create_tar,
    _dir_content_digest,
    _safe_extract_tar,
    pull_workspace,
    push_workspace,
    s3_prefix_for_mount,
)


class _FakeS3Error(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeS3:
    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str, dict]] = {}
        self.seq = 0

    def put_object(self, *, Bucket, Key, Body, IfMatch=None, IfNoneMatch=None, **kwargs):
        cur = self.objects.get(Key)
        if IfNoneMatch == "*" and cur is not None:
            raise _FakeS3Error("PreconditionFailed")
        if IfMatch is not None and (cur is None or cur[1] != IfMatch):
            raise _FakeS3Error("PreconditionFailed")
        self.seq += 1
        etag = f'"etag-{self.seq}"'
        raw = Body if isinstance(Body, bytes) else Body.read()
        self.objects[Key] = (raw, etag, kwargs)
        return {"ETag": etag}

    def get_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise _FakeS3Error("NoSuchKey")
        raw, etag, _ = self.objects[Key]
        return {"Body": io.BytesIO(raw), "ETag": etag}

    def head_object(self, *, Bucket, Key):
        if Key not in self.objects:
            raise _FakeS3Error("404")
        return {"ETag": self.objects[Key][1]}

    def delete_object(self, *, Bucket, Key):
        self.objects.pop(Key, None)
        return {}

    def list_objects_v2(self, *, Bucket, Prefix="", Delimiter="", **kwargs):
        prefixes = set()
        contents = []
        for k, (raw, etag, _) in sorted(self.objects.items()):
            if not k.startswith(Prefix):
                continue
            rest = k[len(Prefix):]
            if Delimiter and Delimiter in rest:
                prefixes.add(Prefix + rest.split(Delimiter, 1)[0] + Delimiter)
            else:
                contents.append({"Key": k, "Size": len(raw), "ETag": etag})
        return {
            "CommonPrefixes": [{"Prefix": p} for p in sorted(prefixes)],
            "Contents": contents,
        }


def _init_git_repo(path: Path, files: dict[str, str], remote_url: str | None = None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    subprocess.run(["git", "init", "-b", "main", str(path)], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "tester"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "tester@tina"], check=True)
    for rel, text in files.items():
        fp = path / rel
        fp.parent.mkdir(parents=True, exist_ok=True)
        fp.write_text(text, encoding="utf-8")
    subprocess.run(["git", "-C", str(path), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-m", "init"], check=True, capture_output=True)
    if remote_url:
        subprocess.run(["git", "-C", str(path), "remote", "add", "origin", remote_url], check=True)


def test_canonical_s3_prefix_mapping(tmp_path):
    root = tmp_path / "workspaces"
    root.mkdir()
    assert s3_prefix_for_mount(root, root / "42") == ("users/42/home", "git")
    assert s3_prefix_for_mount(root, root / "_system/42") == ("users/42/system", "tar")
    assert s3_prefix_for_mount(root, root / "_attached/42/workspace-1") == (
        "users/42/attached/slots/workspace-1", "git",
    )
    assert s3_prefix_for_mount(root, root / "team-wiki-abc") == ("shared/team-wiki-abc", "git")
    assert s3_prefix_for_mount(root, root / "_global") == ("_global", "git")


def test_git_push_pull_preserves_token_free_remotes_and_3way_merges(tmp_path):
    s3 = FakeS3()
    repo_a = tmp_path / "a"
    _init_git_repo(
        repo_a,
        {"README.md": "hello\n", "policy/acl.json": '{"owner":"1"}\n'},
        remote_url="https://x-access-token:ghp_secret123@github.com/org/wiki.git",
    )

    st_a, changed = push_workspace(
        s3, "b", "shared/wiki-1", "git", repo_a,
        SyncState(prefix="shared/wiki-1", kind="git"),
        actor="user-1", kms_key_id="kms-data", protect_policy=False,
    )
    assert changed and st_a.rev == 1

    # Pull into B and verify token was scrubbed from restored remote
    repo_b = tmp_path / "b"
    st_b, pulled = pull_workspace(s3, "b", "shared/wiki-1", "git", repo_b)
    assert pulled and st_b.rev == 1
    origin = subprocess.check_output(["git", "-C", str(repo_b), "remote", "get-url", "origin"], text=True).strip()
    assert origin == "https://github.com/org/wiki.git"
    assert "ghp_secret123" not in origin

    # Concurrent edit on A (file_a) and B (file_b) -> CAS 412 triggers clean 3-way merge
    (repo_a / "a.md").write_text("from A\n")
    subprocess.run(["git", "-C", str(repo_a), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo_a), "commit", "-m", "A edit"], check=True, capture_output=True)
    st_a2, _ = push_workspace(s3, "b", "shared/wiki-1", "git", repo_a, st_a, actor="user-1")
    assert st_a2.rev == 2

    (repo_b / "b.md").write_text("from B\n")
    subprocess.run(["git", "-C", str(repo_b), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo_b), "commit", "-m", "B edit"], check=True, capture_output=True)
    st_b2, merged = push_workspace(s3, "b", "shared/wiki-1", "git", repo_b, st_b, actor="user-2")
    assert merged and st_b2.rev == 3
    assert (repo_b / "a.md").read_text() == "from A\n"
    assert (repo_b / "b.md").read_text() == "from B\n"


def test_system_tar_excludes_cli_bloat_and_survives_symlink_loop(tmp_path):
    root = tmp_path / "sys"
    (root / ".claude/sessions").mkdir(parents=True)
    (root / ".claude/sessions/main.session").write_text("s-1")
    (root / ".claude/sessions/main.history.json").write_text('["s-1"]')
    (root / ".claude/tina-bedrock").mkdir(parents=True)
    (root / ".claude/tina-bedrock/main.json").write_text('{"ok":true}')
    (root / ".claude/debug").mkdir(parents=True)
    (root / ".claude/debug/trace.txt").write_bytes(b"Z" * 100_000)
    # Self-looping symlink (reproduces real Fargate claude_code.py crash)
    os.symlink(str(root / ".claude/projects"), str(root / ".claude/projects"))

    (root / ".codex/sessions").mkdir(parents=True)
    (root / ".codex/sessions/t1.jsonl").write_text('{"ok":1}\n')
    (root / ".codex/tina-sources/t1").mkdir(parents=True)
    (root / ".codex/tina-sources/t1/turn1.json").write_text('{"s":1}')
    (root / ".codex/.tmp/plugins/.git/objects/pack").mkdir(parents=True)
    (root / ".codex/.tmp/plugins/.git/objects/pack/big.pack").write_bytes(os.urandom(6_000_000))
    (root / ".codex/plugins/canva").mkdir(parents=True)
    (root / ".codex/plugins/canva/icon.png").write_bytes(os.urandom(300_000))
    (root / ".npm/_cacache").mkdir(parents=True)
    (root / ".npm/_cacache/blob").write_bytes(os.urandom(300_000))
    (root / "identity.md").write_text("# Owner\n")
    (root / "worker.log").write_text("noise")

    digest = _dir_content_digest(root)
    assert len(digest) == 64

    archive = tmp_path / "sys.tar.gz"
    _create_tar(root, archive)
    assert archive.stat().st_size < 10_000

    extracted = tmp_path / "out"
    _safe_extract_tar(archive, extracted)
    assert (extracted / ".claude/sessions/main.session").read_text() == "s-1"
    assert (extracted / ".claude/tina-bedrock/main.json").exists()
    assert (extracted / ".codex/sessions/t1.jsonl").exists()
    assert (extracted / ".codex/tina-sources/t1/turn1.json").exists()
    assert (extracted / "identity.md").read_text() == "# Owner\n"
    assert not (extracted / ".codex/.tmp").exists()
    assert not (extracted / ".codex/plugins").exists()
    assert not (extracted / ".npm").exists()
    assert not (extracted / ".claude/debug").exists()
    assert not (extracted / "worker.log").exists()
    assert not (extracted / ".claude/projects").is_symlink()


def test_workspace_store_compaction_secrets_and_migration(tmp_path):
    s3 = FakeS3()
    store = S3WorkspaceStore(
        s3=s3, bucket="ws-bucket", root=tmp_path / "cache",
        kms_key_id="kms-data", secrets_kms_key_id="kms-secrets",
    )

    # Secrets isolated under WorkspaceSecretsKey
    assert store.write_secret_token("2", "ghp_live_token") is True
    assert store.read_secret_token("2") == "ghp_live_token"
    assert s3.objects["secrets/users/2/github.token"][2]["SSEKMSKeyId"] == "kms-secrets"

    # Compaction strips oversized >5MB system snapshot atomically
    src = tmp_path / "legacy_sys"
    (src / ".claude/sessions").mkdir(parents=True)
    (src / ".claude/sessions/main.session").write_text("keep")
    (src / ".codex/.tmp/plugins").mkdir(parents=True)
    (src / ".codex/.tmp/plugins/pack.bin").write_bytes(os.urandom(5_500_000))
    bloated_path = tmp_path / "bloated.tar.gz"
    with tarfile.open(bloated_path, "w:gz", compresslevel=1) as tf:
        tf.add(src / ".claude/sessions/main.session", arcname=".claude/sessions/main.session")
        tf.add(src / ".codex/.tmp/plugins/pack.bin", arcname=".codex/.tmp/plugins/pack.bin")
    bloated = bloated_path.read_bytes()
    s3.put_object(Bucket="ws-bucket", Key="users/2/system/snapshots/000001-old.tar.gz", Body=bloated)
    s3.put_object(
        Bucket="ws-bucket", Key="users/2/system/head.json",
        Body=json.dumps({
            "schema": "tina.ws.head.v1", "workspace_key": "users/2/system", "kind": "tar",
            "rev": 1, "head_sha": "old", "bundle_key": "users/2/system/snapshots/000001-old.tar.gz",
            "bundle_sha256": hashlib.sha256(bloated).hexdigest(), "bundle_bytes": len(bloated),
        }).encode(),
    )

    res = store.compact_bloated_system_snapshots(threshold_bytes=5_000_000)
    assert res["compacted"] == 1 and res["bytes_saved"] > 5_000_000
    head_after = json.loads(s3.objects["users/2/system/head.json"][0])
    assert head_after["rev"] == 2 and head_after["bundle_bytes"] < 5_000
    # Second pass is a fast no-op
    res2 = store.compact_bloated_system_snapshots(threshold_bytes=5_000_000)
    assert res2["compacted"] == 0 and res2["skipped"] == 1

    # EFS -> S3 migration is idempotent
    efs = tmp_path / "efs"
    _init_git_repo(efs / "9", {"README.md": "user 9"})
    _init_git_repo(efs / "team-wiki", {"policy/invites.json": json.dumps([{"hash": "abc123"}])})
    counts = store.migrate_from_efs(efs)
    assert counts["git"] == 2 and counts["invites"] == 1
    counts2 = store.migrate_from_efs(efs)
    assert counts2["git"] == 0 and counts2["skipped"] >= 2


def test_s3_middleware_hydrates_meeting_voice_reads_and_pushes_draft_writes(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from fastapi.testclient import TestClient
    from control_plane.api import create_app
    from control_plane.workspace_reader import WorkspaceReader

    monkeypatch.setenv("TINA_INTERNAL_API_SECRET", "voice-internal-secret")
    monkeypatch.setenv("TINA_WORKSPACE_STORAGE", "s3")
    monkeypatch.setenv("TINA_S3_WORKSPACE_BUCKET", "ws-bucket")

    events = []

    class StubStore:
        def __init__(self, root):
            self.root = root

        def compact_bloated_system_snapshots(self):
            return {"compacted": 0}

        @contextmanager
        def distributed_lock(self, key, **_kw):
            events.append(("lock", key))
            yield

        def sync_subject_workspaces(self, subject, *, memberships=(), include_system=False, force=False):
            events.append(("sync", subject, force))

        def push_attach_state(self, subject):
            events.append(("push_attach", subject))

        def push_if_changed(self, path, *, actor=None, protect_policy=False):
            events.append(("push", path.name, actor))

    store = StubStore(tmp_path)
    (tmp_path / "7").mkdir()
    monkeypatch.setattr("control_plane.workspace_store.S3WorkspaceStore.from_env", classmethod(lambda cls, *args, **kw: store))
    app = create_app(None, reader=WorkspaceReader(tmp_path))
    events.clear()

    app.router.routes[:] = [
        route for route in app.router.routes
        if getattr(route, "path", None) != "/api/internal/meeting-voice/{meeting_id}/task-flow"
    ]

    @app.post("/api/internal/meeting-voice/{meeting_id}/sources-probe")
    def _voice_read_probe(meeting_id: int):
        return {"ok": True}

    @app.post("/api/internal/meeting-voice/{meeting_id}/task-flow")
    def _voice_write_probe(meeting_id: int):
        return {"ok": True}

    client = TestClient(app)

    # Unauthenticated request must NOT trigger S3 hydration
    client.post("/api/internal/meeting-voice/42/sources-probe", headers={"X-User-Id": "7"})
    assert events == []

    # Authenticated voice read hydrates lazily (force=False) without distributed lock or push
    r = client.post(
        "/api/internal/meeting-voice/42/sources-probe",
        headers={"X-User-Id": "7", "X-Internal-Secret": "voice-internal-secret"},
    )
    assert r.status_code == 200
    assert events == [("sync", "7", False)]

    # Authenticated voice task-flow write locks, force-syncs, and pushes back to S3
    events.clear()
    r = client.post(
        "/api/internal/meeting-voice/42/task-flow",
        headers={"X-User-Id": "7", "X-Internal-Secret": "voice-internal-secret"},
    )
    assert r.status_code == 200
    assert ("lock", "subject:7") in events
    assert ("sync", "7", True) in events
    assert ("push", "7", "7") in events


def test_workspace_stream_pins_live_meeting_topics_and_rejects_foreign_keys():
    from worker.workspace_stream import WorkspaceStream, meeting_topics, topics

    assert topics("7", "agent-meet-42") == ("unit:agent-meet-42:in", "unit:agent-meet-42:out")
    assert meeting_topics("tc:meeting:42", "42") == ("tc:meeting:42", "proc:meeting:42", "proc:meeting:42:cursor")
    with pytest.raises(ValueError):
        meeting_topics("tc:meeting:99", "42")

    seen = []
    ws = WorkspaceStream("7", "agent-meet-42", transcript_stream="tc:meeting:42", meeting_numeric_id="42")
    ws._request = lambda path, data: (seen.append((path, data)), [["tc:meeting:42", []]] if path == "meeting-read" else "1-0")[1]

    assert ws.xread({"tc:meeting:42": "0"}, count=50, block=10) == [["tc:meeting:42", []]]
    assert ws.xadd("proc:meeting:42", {"note": '{"id":"s1"}'}) == "1-0"
    assert ws.set("proc:meeting:42:cursor", "1700-0") == "1-0"
    assert [p for p, _ in seen] == ["meeting-read", "meeting-proc", "meeting-cursor"]

    # Foreign meeting keys are rejected client-side before crossing loopback
    with pytest.raises(ValueError):
        ws.xread({"tc:meeting:99": "0"}, count=10, block=10)
    with pytest.raises(ValueError):
        ws.xadd("proc:meeting:99", {"note": "{}"})
    with pytest.raises(ValueError):
        ws.set("proc:meeting:99:cursor", "1-0")
