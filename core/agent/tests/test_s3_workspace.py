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


def test_unrelated_wiki_write_preserves_newer_chat_history(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from control_plane.api import create_app
    from control_plane.dispatch import Dispatcher
    from control_plane.workspace_reader import WorkspaceReader
    from shared.config import load_settings

    bucket, prefix = "test", "users/42/system"
    s3 = FakeS3()
    worker = tmp_path / "worker"
    history = worker / ".claude" / "tina-bedrock" / "thread.json"
    history.parent.mkdir(parents=True)
    history.write_text(json.dumps(["first turn"]))
    prior, _ = push_workspace(s3, bucket, prefix, "tar", worker, SyncState(prefix=prefix, kind="tar"))

    root = tmp_path / "workspaces"
    store = S3WorkspaceStore(s3=s3, bucket=bucket, root=root)
    client_reader = WorkspaceReader(str(root))
    monkeypatch.setattr(S3WorkspaceStore, "from_env", lambda *args, **kwargs: store)
    app = create_app(Dispatcher(load_settings(), None, None), reader=client_reader)
    headers = {"x-user-id": "42"}
    with TestClient(app) as client:
        assert client.get("/api/sessions", headers=headers).status_code == 200
        history.write_text(json.dumps(["first turn", "second turn"]))
        latest, _ = push_workspace(s3, bucket, prefix, "tar", worker, prior)
        assert client.post("/api/workspace/shared/new", headers=headers, json={"name": "Synthetic Wiki"}).status_code == 201

    assert s3.head_object(Bucket=bucket, Key=f"{prefix}/head.json")["ETag"] == latest.etag


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


def test_nova_bedrock_workspace_supports_agent_reach_and_readonly_global(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from control_plane.dispatch import _has_workspace_byo_model, overlay_model_config
    from control_plane.system_mounts import ensure_global_workspace
    from llm import agent_reach, bedrock_workspace

    gdir = ensure_global_workspace(tmp_path / "_global")
    pdir = tmp_path / "5"
    (pdir / "kg").mkdir(parents=True)
    (pdir / "docs").mkdir(parents=True)
    (pdir / "docs" / "private.md").write_text("secret", encoding="utf-8")

    monkeypatch.setenv("TINA_AGENT_REACH_URL", "http://agent-reach.tina-staging.local:8080")
    monkeypatch.setenv("TINA_UNIT_TOOLS", json.dumps(["reach.web.search", "reach.github.read"]))
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "_global", "path": str(gdir), "role": "global", "write": False},
        {"slug": "personal", "path": str(pdir), "role": "private", "write": True},
    ]))

    # Direct _wiki_tool checks: seeded _global docs/README/CLAUDE/mail are readable; writes to _global
    # and non-kg reads on personal mounts are strictly denied.
    mounts_map = {
        "_global": {"slug": "_global", "path": str(gdir), "role": "global", "write": False},
        "personal": {"slug": "personal", "path": str(pdir), "role": "private", "write": True},
    }
    assert "TINA" in bedrock_workspace._wiki_tool(
        mounts_map, "read_wiki", {"workspace": "_global", "path": "README.md"}, "",
    )["text"]
    assert "Kiến trúc 3 tầng" in bedrock_workspace._wiki_tool(
        mounts_map, "read_wiki", {"workspace": "_global", "path": "docs/tina-handbook.md"}, "",
    )["text"]
    assert "Mẫu Email" in bedrock_workspace._wiki_tool(
        mounts_map, "read_wiki", {"workspace": "_global", "path": "mail/follow-up.md"}, "",
    )["text"]
    with pytest.raises(ValueError):
        bedrock_workspace._wiki_tool(
            mounts_map, "create_wiki",
            {"workspace": "_global", "path": "kg/x.md", "text": "nope"},
            "/wiki-create _global:kg/x.md",
        )
    with pytest.raises(ValueError):
        bedrock_workspace._wiki_tool(
            mounts_map, "read_wiki", {"workspace": "personal", "path": "docs/private.md"}, "",
        )

    reach_calls = []
    monkeypatch.setattr(
        agent_reach, "query",
        lambda ch, act, txt, **_: (reach_calls.append((ch, act, txt)), {"ok": True, "items": [{"title": "TINA", "url": "https://example.com", "text": "result"}]})[1],
    )

    turn_calls = []

    class FakeClient:
        def converse(self, **req):
            turn_calls.append(req)
            if len(turn_calls) == 1:
                return {"stopReason": "tool_use", "output": {"message": {"role": "assistant", "content": [
                    {"toolUse": {"toolUseId": "t1", "name": "reach_web_search", "input": {"query": "TINA AWS"}}},
                    {"toolUse": {"toolUseId": "t2", "name": "read_wiki", "input": {"workspace": "_global", "path": "docs/tina-handbook.md"}}},
                ]}}}
            return {"stopReason": "end_turn", "output": {"message": {"role": "assistant", "content": [
                {"text": "Found web result and global handbook."},
            ]}}}

    monkeypatch.setattr(bedrock_workspace, "BedrockConverseCompletion", lambda **_: SimpleNamespace(client=FakeClient()))
    harness = bedrock_workspace.BedrockWorkspaceHarness()
    harness.prepare(pdir)
    events = list(harness.run_turn(pdir, "<!--tina:user-input-below-->search TINA", allowed_tools=("Read", "Write"), model="amazon.nova-lite-v1:0"))
    assert any(e.get("type") == "tool-call" and e.get("tool") == "reach_web_search" for e in events)
    assert any(e.get("type") == "done" and e.get("ok") is True for e in events)
    assert reach_calls == [("web", "search", "TINA AWS")]
    tool_names = [t["toolSpec"]["name"] for t in turn_calls[0]["toolConfig"]["tools"]]
    assert "reach_web_search" in tool_names and "reach_github_read" in tool_names
    assert {"list_wiki", "search_wiki", "read_wiki", "create_wiki", "update_wiki"}.issubset(set(tool_names))

    # Natural-language create_wiki (nested folder), list_wiki, search_wiki, and update_wiki (append + replace)
    created = bedrock_workspace._wiki_tool(
        mounts_map,
        "create_wiki",
        {"workspace": "personal", "path": "kg/projects/acme.md", "text": "# Acme Project\n\nInitial brief.\n"},
        "Tạo giúp tôi trang dự án Acme trong Knowledge",
    )
    assert created["created"] == "kg/projects/acme.md"

    listed = bedrock_workspace._wiki_tool(mounts_map, "list_wiki", {"workspace": "personal"}, "")
    assert any(item["path"] == "kg/projects/acme.md" and item["title"] == "Acme Project" for item in listed["files"])

    searched = bedrock_workspace._wiki_tool(mounts_map, "search_wiki", {"workspace": "*", "query": "Acme"}, "")
    assert any(m["workspace"] == "personal" and m["path"] == "kg/projects/acme.md" for m in searched["matches"])

    appended = bedrock_workspace._wiki_tool(
        mounts_map,
        "update_wiki",
        {"workspace": "personal", "path": "kg/projects/acme.md", "mode": "append", "text": "- Next step: demo Friday"},
        "Thêm action item vào trang Acme",
    )
    assert appended["mode"] == "append"
    body_after_append = bedrock_workspace._wiki_tool(
        mounts_map, "read_wiki", {"workspace": "personal", "path": "kg/projects/acme.md"}, "",
    )["text"]
    assert "Initial brief." in body_after_append and "Next step: demo Friday" in body_after_append

    replaced = bedrock_workspace._wiki_tool(
        mounts_map,
        "update_wiki",
        {"workspace": "personal", "path": "kg/projects/acme.md", "mode": "replace", "text": "# Acme Project\n\nUpdated summary.\n"},
        "Cập nhật lại nội dung trang Acme",
    )
    assert replaced["mode"] == "replace"
    assert "Updated summary." in (pdir / "kg" / "projects" / "acme.md").read_text(encoding="utf-8")

    # Indirect prompt-injection guard (Option A): external web taint blocks writes when user didn't ask to write,
    # but permits writing when user explicitly asked to search web and save to Knowledge.
    with pytest.raises(ValueError, match="external web content"):
        bedrock_workspace._wiki_tool(
            mounts_map,
            "create_wiki",
            {"workspace": "personal", "path": "kg/injected.md", "text": "pwned"},
            "Tóm tắt trang web này giúp tôi",
            external_taint=True,
        )
    allowed_after_web = bedrock_workspace._wiki_tool(
        mounts_map,
        "create_wiki",
        {"workspace": "personal", "path": "kg/web-summary.md", "text": "# Web Summary\n\nFacts.\n"},
        "Tìm trên web về AWS Bedrock rồi lưu vào Knowledge giúp tôi",
        external_taint=True,
    )
    assert allowed_after_web["created"] == "kg/web-summary.md"

    # Regression tests for all 6 code-review findings:
    # 1. Numeric private slug ("5") accepts "personal" alias seamlessly; cross-mount/unknown slugs rejected.
    numeric_mounts = {
        "_global": {"slug": "_global", "path": str(gdir), "role": "global", "write": False},
        "5": {"slug": "5", "path": str(pdir), "role": "private", "write": True, "primary": True},
    }
    listed_alias = bedrock_workspace._wiki_tool(numeric_mounts, "list_wiki", {"workspace": "personal"}, "")
    assert listed_alias["workspace"] == "5"
    assert any(item["path"] == "kg/projects/acme.md" for item in listed_alias["files"])

    # 2. Absolute path matching mount root (from mounts_preamble) normalizes cleanly, while cross-mount path fails.
    abs_read = bedrock_workspace._wiki_tool(
        numeric_mounts, "read_wiki", {"workspace": "5", "path": f"{pdir}/kg/projects/acme.md"}, "",
    )
    assert "Updated summary." in abs_read["text"]
    with pytest.raises(ValueError):
        bedrock_workspace._wiki_tool(
            numeric_mounts, "read_wiki", {"workspace": "5", "path": "/workspaces/999/kg/projects/acme.md"}, "",
        )

    # 3. Vietnamese read-only words ("nghiên cứu", "lưu ý", "cấu tạo") do NOT false-positive as write intent.
    for readonly_prompt in (
        "Tìm trên web và nghiên cứu về AWS Bedrock giúp tôi",
        "Đọc trang web này và lưu ý các rủi ro bảo mật",
        "Giải thích cấu tạo của ECS Fargate",
    ):
        with pytest.raises(ValueError, match="external web content"):
            bedrock_workspace._wiki_tool(
                numeric_mounts,
                "create_wiki",
                {"workspace": "personal", "path": "kg/should-block.md", "text": "blocked"},
                readonly_prompt,
                external_taint=True,
            )

    # 4. update_wiki(mode='append') joins cleanly with exactly one blank line (never \n\n\n).
    bedrock_workspace._wiki_tool(
        numeric_mounts, "create_wiki",
        {"workspace": "5", "path": "kg/append-nl.md", "text": "# Log\n\nLine 1.\n"},
        "tạo trang log",
    )
    bedrock_workspace._wiki_tool(
        numeric_mounts, "update_wiki",
        {"workspace": "5", "path": "kg/append-nl.md", "mode": "append", "text": "Line 2."},
        "thêm dòng mới",
    )
    assert (pdir / "kg" / "append-nl.md").read_text(encoding="utf-8") == "# Log\n\nLine 1.\n\nLine 2.\n"

    # 5. stopReason == "max_tokens" preserves generated text instead of failing the turn.
    class MaxTokensClient:
        def converse(self, **req):
            assert "'5' (private, writable)" in req["system"][0]["text"]
            return {"stopReason": "max_tokens", "output": {"message": {"role": "assistant", "content": [
                {"text": "Partial long Vietnamese summary that hit max_tokens."},
            ]}}}

    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "_global", "path": str(gdir), "role": "global", "write": False},
        {"slug": "5", "path": str(pdir), "role": "private", "write": True, "primary": True},
    ]))
    monkeypatch.setattr(bedrock_workspace, "BedrockConverseCompletion", lambda **_: SimpleNamespace(client=MaxTokensClient()))
    max_tok_events = list(harness.run_turn(pdir, "<!--tina:user-input-below-->tóm tắt dài", allowed_tools=("Read",), model="amazon.nova-lite-v1:0"))
    done_ev = next(e for e in max_tok_events if e.get("type") == "done")
    assert done_ev["ok"] is True and "hit max_tokens" in done_ev["reply"]

    # Verify custom HTTPS + anthropic API key overlay cleanly into claude-code runner,
    # clearing stale credentials and setting Claude model aliases.
    env_custom: dict[str, str] = {
        "ANTHROPIC_API_KEY": "stale-anth",
        "CLAUDE_CODE_OAUTH_TOKEN": "stale-oauth",
        "OPENAI_API_KEY": "stale-openai",
        "AWS_BEARER_TOKEN_BEDROCK": "stale-bedrock",
    }
    overlay_model_config(env_custom, {
        "mode": "custom", "base_url": "https://openrouter.ai/api/v1",
        "api_key": "or-key", "model": "deepseek/deepseek-chat",
    })
    assert env_custom["TINA_RUNNER"] == "claude-code"
    assert env_custom["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api/v1"
    assert env_custom["ANTHROPIC_AUTH_TOKEN"] == "or-key"
    assert env_custom["ANTHROPIC_API_KEY"] == ""
    assert env_custom["CLAUDE_CODE_OAUTH_TOKEN"] == ""
    assert env_custom["OPENAI_API_KEY"] == ""
    assert env_custom["AWS_BEARER_TOKEN_BEDROCK"] == ""
    assert env_custom["ANTHROPIC_MODEL"] == "deepseek/deepseek-chat"
    assert env_custom["ANTHROPIC_DEFAULT_SONNET_MODEL"] == "deepseek/deepseek-chat"

    env_custom_nokey: dict[str, str] = {"ANTHROPIC_AUTH_TOKEN": "stale-tok"}
    overlay_model_config(env_custom_nokey, {"mode": "custom", "base_url": "https://openrouter.ai/api/v1"})
    assert env_custom_nokey["ANTHROPIC_AUTH_TOKEN"] == ""

    env_anth: dict[str, str] = {}
    overlay_model_config(env_anth, {"mode": "anthropic", "api_key": "sk-ant-test"})
    assert env_anth["TINA_RUNNER"] == "claude-code" and env_anth["ANTHROPIC_API_KEY"] == "sk-ant-test"
    assert _has_workspace_byo_model({"mode": "anthropic", "api_key": "sk-ant-test"}) is True


def test_workspace_sync_enforces_and_refreshes_readonly_mounts_nonroot(tmp_path):
    import stat
    from control_plane.system_mounts import ensure_global_workspace
    from worker.workspace_sync import SyncCoordinator

    s3 = FakeS3()
    src = ensure_global_workspace(tmp_path / "src_global")
    st1, _ = push_workspace(
        s3, "b", "_global", "git", src, SyncState(prefix="_global", kind="git"),
        actor="system", protect_policy=False, force=True,
    )

    ws_root = tmp_path / "workspaces"
    ws_root.mkdir()
    gpath = ws_root / "_global"
    coord = SyncCoordinator(
        s3=s3, bucket="b", kms_key_id=None, owner="42",
        mounts=[{"slug": "_global", "path": str(gpath), "role": "global", "write": False}],
        root=ws_root, tmp_dir=tmp_path / "tmp",
    )
    coord.bootstrap()

    try:
        readme = gpath / "README.md"
        assert readme.is_file()
        assert stat.S_IMODE(readme.stat().st_mode) == 0o444
        assert stat.S_IMODE(gpath.stat().st_mode) == 0o555
        if hasattr(os, "geteuid") and os.geteuid() != 0:
            with pytest.raises(PermissionError):
                readme.write_text("tamper", encoding="utf-8")

        # Update _global on S3 and verify refresh cleanly swaps + re-locks without PermissionError or .old-* leaks
        (src / "docs" / "tina-handbook.md").write_text("# Updated Handbook v2\n", encoding="utf-8")
        subprocess.run(["git", "-C", str(src), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(src), "commit", "-m", "v2"], check=True, capture_output=True)
        st2, changed = push_workspace(s3, "b", "_global", "git", src, st1, actor="system", protect_policy=False)
        assert changed and st2.rev == 2

        res = coord.refresh()
        assert res["refreshed"] == ["_global"]
        assert "Updated Handbook v2" in (gpath / "docs" / "tina-handbook.md").read_text(encoding="utf-8")
        assert stat.S_IMODE((gpath / "docs" / "tina-handbook.md").stat().st_mode) == 0o444
        assert stat.S_IMODE(gpath.stat().st_mode) == 0o555
        assert not [p for p in ws_root.iterdir() if p.name.startswith(".old-")]
    finally:
        SyncCoordinator._restore_writable(gpath)


def test_s3_middleware_hydrates_body_slug_on_git_sync_routes(tmp_path, monkeypatch):
    from contextlib import contextmanager
    from fastapi.testclient import TestClient
    from control_plane.api import create_app
    from control_plane.workspace_reader import WorkspaceReader

    monkeypatch.setenv("TINA_WORKSPACE_STORAGE", "s3")
    monkeypatch.setenv("TINA_S3_WORKSPACE_BUCKET", "ws-bucket")

    synced: list[str] = []
    pushed: list[str] = []

    class StubStore:
        def __init__(self, root):
            self.root = root

        def compact_bloated_system_snapshots(self):
            return {"compacted": 0}

        @contextmanager
        def distributed_lock(self, key, **_kw):
            yield

        def sync_subject_workspaces(self, subject, *, memberships=(), include_system=False, force=False):
            pass

        def ensure_synced(self, path, *, force=False):
            synced.append(path.name)
            path.mkdir(parents=True, exist_ok=True)

        def push_attach_state(self, subject):
            pass

        def push_if_changed(self, path, *, actor=None, protect_policy=False):
            pushed.append(path.name)

    store = StubStore(tmp_path)
    (tmp_path / "7").mkdir()
    monkeypatch.setattr("control_plane.workspace_store.S3WorkspaceStore.from_env", classmethod(lambda cls, *args, **kw: store))
    app = create_app(None, reader=WorkspaceReader(tmp_path))
    app.router.routes[:] = [
        route for route in app.router.routes if getattr(route, "path", None) != "/api/workspace/push"
    ]

    @app.post("/api/workspace/push")
    def _push_probe():
        return {"ok": True}

    client = TestClient(app)
    r = client.post("/api/workspace/push", headers={"X-User-Id": "7"}, json={"slug": "team-wiki"})
    assert r.status_code == 200
    assert "team-wiki" in synced
    assert "team-wiki" in pushed


def test_global_workspace_is_readonly_via_workspace_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from control_plane.api import create_app
    from control_plane.dispatch import Dispatcher
    from control_plane.system_mounts import ensure_global_workspace
    from control_plane.workspace_reader import WorkspaceReader
    from shared.config import load_settings

    root = tmp_path / "workspaces"
    gdir = ensure_global_workspace(root / "_global")
    monkeypatch.setenv("TINA_WORKSPACE_STORAGE", "local")
    settings = load_settings(workspaces_dir=str(root), global_system_workspace_path=str(gdir))
    app = create_app(Dispatcher(settings, None, None), reader=WorkspaceReader(str(root)))
    headers = {"x-user-id": "42"}

    with TestClient(app) as client:
        tree_res = client.get("/api/workspace/tree?slug=_global", headers=headers)
        assert tree_res.status_code == 200
        files = tree_res.json()["files"]
        assert "README.md" in files and "docs/tina-handbook.md" in files

        doc_res = client.get("/api/workspace/document?slug=_global&path=docs/tina-handbook.md", headers=headers)
        assert doc_res.status_code == 200
        doc = doc_res.json()
        assert doc["writable"] is False
        assert "Kiến trúc 3 tầng" in doc["content"]

        search_res = client.get("/api/workspace/search?slug=_global&q=TINA", headers=headers)
        assert search_res.status_code == 200
        assert len(search_res.json()["hits"]) >= 1

        # All mutation attempts against _global must fail closed (403)
        put_res = client.put("/api/workspace/document", headers=headers, json={
            "path": "docs/tina-handbook.md", "content": "hacked", "expected_sha256": doc["sha256"], "slug": "_global",
        })
        assert put_res.status_code == 403
        del_res = client.post("/api/workspace/document/delete", headers=headers, json={
            "path": "docs/tina-handbook.md", "expected_sha256": doc["sha256"], "slug": "_global",
        })
        assert del_res.status_code == 403
        up_res = client.post(
            "/api/workspace/upload?slug=_global",
            headers=headers,
            files=[("files", ("bad.txt", b"nope", "text/plain"))],
        )
        assert up_res.status_code == 403


def test_shared_wiki_document_edit_and_upload_enforces_roles(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from control_plane.api import create_app
    from control_plane.dispatch import Dispatcher
    from control_plane import workspace_membership as wm
    from control_plane.workspace_reader import WorkspaceReader
    from shared.config import load_settings

    root = tmp_path / "workspaces"
    ws_id = "team-docs"
    _init_git_repo(root / ws_id, {"README.md": "# Team\n", "wiki/guide.md": "# Guide\n"})
    idx = wm.InMemoryMembershipIndex()
    wm.ensure_owner(root, ws_id, "10", index=idx)
    wm.grant_membership(root, ws_id, "20", "contributor", added_by="10", index=idx)
    wm.grant_membership(root, ws_id, "30", "viewer", added_by="10", index=idx)

    monkeypatch.setenv("TINA_WORKSPACE_STORAGE", "local")
    settings = load_settings(workspaces_dir=str(root))
    app = create_app(Dispatcher(settings, None, None, membership_index=idx), reader=WorkspaceReader(str(root)), membership_index=idx)

    with TestClient(app) as client:
        # Owner and contributor see writable=True and can edit + upload to the shared workspace
        doc_owner = client.get(f"/api/workspace/document?slug={ws_id}&path=wiki/guide.md", headers={"x-user-id": "10"}).json()
        assert doc_owner["writable"] is True
        put_c = client.put("/api/workspace/document", headers={"x-user-id": "20"}, json={
            "path": "wiki/guide.md", "content": "# Guide v2\n", "expected_sha256": doc_owner["sha256"], "slug": ws_id,
        })
        assert put_c.status_code == 200
        up_c = client.post(
            f"/api/workspace/upload?slug={ws_id}",
            headers={"x-user-id": "20"},
            files=[("files", ("spec.txt", b"team spec", "text/plain"))],
        )
        assert up_c.status_code == 200
        assert (root / ws_id / up_c.json()["files"][0]["path"]).read_bytes() == b"team spec"

        # Viewer sees writable=False and is blocked from both PUT and upload (403)
        doc_v = client.get(f"/api/workspace/document?slug={ws_id}&path=wiki/guide.md", headers={"x-user-id": "30"}).json()
        assert doc_v["writable"] is False
        assert client.put("/api/workspace/document", headers={"x-user-id": "30"}, json={
            "path": "wiki/guide.md", "content": "tamper", "expected_sha256": doc_v["sha256"], "slug": ws_id,
        }).status_code == 403
        assert client.post(
            f"/api/workspace/upload?slug={ws_id}",
            headers={"x-user-id": "30"},
            files=[("files", ("spec.txt", b"viewer", "text/plain"))],
        ).status_code == 403
