"""Atomic S3-backed workspace snapshot, CAS commit, and 3-way Git merge engine.

Shared by BOTH:
- ``worker.workspace_sync`` (the Fargate ``sync`` sidecar running with turn-scoped STS creds)
- ``control_plane.workspace_store`` (``agent-api`` local NVMe cache + write-through S3 store)

Format on S3 (under one KMS-encrypted bucket):
  users/<uid>/home/head.json + snapshots/<rev>-<sha12>.bundle        (git repo)
  users/<uid>/system/head.json + snapshots/<rev>-<digest12>.tar.gz   (git + .claude + .codex)
  users/<uid>/attached/state.json                                    (JSON with ETag CAS)
  users/<uid>/attached/slots/<slug>/head.json + snapshots/...bundle  (git repo)
  shared/<workspace_id>/head.json + snapshots/<rev>-<sha12>.bundle   (git repo)
  _global/head.json + snapshots/<rev>-<sha12>.bundle                 (git repo, ro)

Zero partial-write corruption: immutable snapshot objects are uploaded BEFORE flipping
``head.json`` with S3 native conditional writes (``IfMatch`` / ``IfNoneMatch``).
"""
from __future__ import annotations

import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

if os.path.isdir("/app/_vendor_boto3") and "/app/_vendor_boto3" not in sys.path:
    sys.path.append("/app/_vendor_boto3")

from llm.ports import _revert_policy_writes
from shared.gitenv import scrubbed_git_env

log = logging.getLogger("tina.s3_workspace")

_URL_CRED_RE = re.compile(r"(https?://)[^/\s@]+@")
_RESERVED_TOP = frozenset({"_system", "_attached", "_global", "system", "global", "sys"})
_HOME_REMOTES = ("origin", "tina-publish")
_MAX_CAS_ATTEMPTS = 5


@dataclass(frozen=True)
class SyncState:
    prefix: str
    kind: str  # "git" or "tar"
    rev: int = 0
    etag: Optional[str] = None
    head_sha: Optional[str] = None
    policy_sha: Optional[str] = None
    remotes: tuple[tuple[str, str], ...] = ()
    branch: str = "main"
    has_routines: bool = False


def s3_prefix_for_mount(root: Path, path: Path) -> tuple[str, str]:
    """Map an on-disk path under ``root`` to ``(s3_prefix, kind)``."""
    root_r = root.resolve()
    path_r = path.resolve()
    try:
        rel = path_r.relative_to(root_r)
    except ValueError as exc:
        raise ValueError(f"path {path} escapes workspace root {root}") from exc
    parts = rel.parts
    if not parts or any(not p or p.startswith(".") or p == ".." for p in parts):
        raise ValueError(f"invalid workspace mount path: {path}")
    if len(parts) == 1:
        seg = parts[0]
        if seg == "_global":
            return "_global", "git"
        if seg in _RESERVED_TOP:
            raise ValueError(f"reserved workspace path: {path}")
        if seg.isdecimal():
            return f"users/{seg}/home", "git"
        return f"shared/{seg}", "git"
    if len(parts) == 2 and parts[0] == "_system" and parts[1].isdecimal():
        return f"users/{parts[1]}/system", "tar"
    if len(parts) == 3 and parts[0] == "_attached" and parts[1].isdecimal():
        slug = parts[2]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,120}", slug):
            raise ValueError(f"invalid attached workspace slug: {slug}")
        return f"users/{parts[1]}/attached/slots/{slug}", "git"
    raise ValueError(f"unsupported workspace mount layout: {path}")


def _s3_error_code(exc: BaseException) -> tuple[str, Optional[int]]:
    resp = getattr(exc, "response", None)
    if not isinstance(resp, dict):
        return "", None
    code = str((resp.get("Error") or {}).get("Code") or "")
    status = (resp.get("ResponseMetadata") or {}).get("HTTPStatusCode")
    return code, status if isinstance(status, int) else None


def _is_not_found(exc: BaseException) -> bool:
    code, status = _s3_error_code(exc)
    return code in ("NoSuchKey", "404", "NotFound") or status == 404


def _is_precondition_failed(exc: BaseException) -> bool:
    code, status = _s3_error_code(exc)
    return code in ("PreconditionFailed", "412", "ConditionalRequestConflict") or status in (409, 412)


def _git(cwd: Path, *args: str, check: bool = True, extra_env: Optional[dict[str, str]] = None) -> subprocess.CompletedProcess:
    env = scrubbed_git_env(GIT_TERMINAL_PROMPT="0", GIT_ASKPASS="true")
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        check=check,
        env=env,
    )


def _scrub_remote_url(url: str) -> str:
    return _URL_CRED_RE.sub(r"\1", url.strip())


def _extract_remotes(work_dir: Path) -> dict[str, str]:
    remotes: dict[str, str] = {}
    for name in _HOME_REMOTES:
        proc = _git(work_dir, "remote", "get-url", name, check=False)
        if proc.returncode == 0:
            raw = proc.stdout.strip()
            # Never persist temporary local bundle paths as origin.
            if raw and not raw.startswith("/") and not raw.startswith("file://"):
                remotes[name] = _scrub_remote_url(raw)
    return remotes


def _current_branch(work_dir: Path) -> str:
    proc = _git(work_dir, "rev-parse", "--abbrev-ref", "HEAD", check=False)
    br = proc.stdout.strip()
    return br if proc.returncode == 0 and br and br != "HEAD" else "main"


def _head_sha(work_dir: Path) -> Optional[str]:
    proc = _git(work_dir, "rev-parse", "HEAD", check=False)
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else None


def _has_routines(work_dir: Path) -> bool:
    rdir = work_dir / "routines"
    return rdir.is_dir() and any(rdir.glob("*.md"))


def _kms_kwargs(kms_key_id: Optional[str]) -> dict[str, Any]:
    if kms_key_id:
        return {"ServerSideEncryption": "aws:kms", "SSEKMSKeyId": kms_key_id}
    return {"ServerSideEncryption": "AES256"}


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(256 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


_SYSTEM_EXCLUDED_PREFIXES = (
    # Top-level $HOME caches & temp dirs created when HOME=/workspaces/_system/<uid>
    ".cache", ".npm", ".local", ".node-gyp", ".nv", ".yarn", ".pnpm-store",
    ".tmp", "tmp", ".config/npm", ".config/configstore",
    # Codex CLI plugin marketplace clones, caches, logs & snapshots (can exceed 80MB)
    ".codex/.tmp", ".codex/tmp", ".codex/plugins", ".codex/cache",
    ".codex/vendor_imports", ".codex/log", ".codex/logs",
    ".codex/shell_snapshots", ".codex/models_cache",
    # Claude Code debug logs, telemetry, shell snapshots & temp caches
    ".claude/debug", ".claude/statsig", ".claude/shell-snapshots",
    ".claude/todos", ".claude/file-history", ".claude/cache",
    ".claude/ide", ".claude/downloads", ".claude/backups", ".claude/telemetry",
)
_SYSTEM_EXCLUDED_SEGMENTS = frozenset({"node_modules", "__pycache__"})
_SYSTEM_EXCLUDED_SUFFIXES = (".lock", ".log", ".tmp", ".part", ".swp", ".bak")


def _is_excluded_system_path(rel: str) -> bool:
    norm = rel
    while norm.startswith("./"):
        norm = norm[2:]
    norm = norm.lstrip("/").rstrip("/")
    if not norm:
        return False
    for prefix in _SYSTEM_EXCLUDED_PREFIXES:
        if norm == prefix or norm.startswith(prefix + "/"):
            return True
    parts = norm.split("/")
    if any(seg in _SYSTEM_EXCLUDED_SEGMENTS for seg in parts):
        return True
    base = parts[-1]
    if base == ".tina-writer.lock" or base.endswith(_SYSTEM_EXCLUDED_SUFFIXES):
        return True
    return False


def _symlink_stays_inside(link_path: Path, root_resolved: Path) -> bool:
    try:
        resolved = link_path.resolve()
    except (OSError, RuntimeError):
        return False
    return resolved == root_resolved or root_resolved in resolved.parents


def _dir_content_digest(work_dir: Path) -> str:
    h = hashlib.sha256()
    if not work_dir.exists():
        return h.hexdigest()
    work_r = work_dir.resolve()
    for dirpath, dirs, files in os.walk(work_r, topdown=True, followlinks=False):
        cur = Path(dirpath)
        rel_dir = "" if cur == work_r else cur.relative_to(work_r).as_posix()
        kept_dirs: list[str] = []
        for d in sorted(dirs):
            rel = f"{rel_dir}/{d}" if rel_dir else d
            if _is_excluded_system_path(rel):
                continue
            p = cur / d
            if p.is_symlink():
                if _symlink_stays_inside(p, work_r):
                    h.update(f"L:{rel}:{os.readlink(p)}\n".encode())
                continue
            kept_dirs.append(d)
        dirs[:] = kept_dirs
        for f in sorted(files):
            rel = f"{rel_dir}/{f}" if rel_dir else f
            if _is_excluded_system_path(rel):
                continue
            p = cur / f
            if p.is_symlink():
                if _symlink_stays_inside(p, work_r):
                    h.update(f"L:{rel}:{os.readlink(p)}\n".encode())
            elif p.is_file():
                try:
                    st = p.stat()
                    h.update(f"F:{rel}:{st.st_size}:{st.st_mtime_ns}\n".encode())
                    with p.open("rb") as fh:
                        for chunk in iter(lambda: fh.read(128 * 1024), b""):
                            h.update(chunk)
                except OSError:
                    continue
    return h.hexdigest()


def _safe_extract_tar(archive: Path, dest: Path) -> None:
    dest_r = dest.resolve()
    dest_r.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf.getmembers():
            name = member.name
            if not name or name in (".", "./"):
                continue
            if _is_excluded_system_path(name):
                continue
            try:
                target = (dest_r / name).resolve()
            except (OSError, RuntimeError):
                continue
            if target != dest_r and dest_r not in target.parents:
                raise ValueError(f"tar path traversal blocked: {name}")
            if member.issym() or member.islnk():
                try:
                    link_target = (target.parent / member.linkname).resolve()
                except (OSError, RuntimeError):
                    continue
                if link_target == target or (link_target != dest_r and dest_r not in link_target.parents):
                    continue  # drop self-looping or escaping symlinks
            tf.extract(member, path=dest_r, filter="fully_trusted")


def _create_tar(work_dir: Path, archive: Path) -> None:
    work_r = work_dir.resolve()
    with tarfile.open(archive, "w:gz", compresslevel=3) as tf:
        for dirpath, dirs, files in os.walk(work_r, topdown=True, followlinks=False):
            cur = Path(dirpath)
            rel_dir = "" if cur == work_r else cur.relative_to(work_r).as_posix()
            kept_dirs: list[str] = []
            for d in sorted(dirs):
                rel = f"{rel_dir}/{d}" if rel_dir else d
                if _is_excluded_system_path(rel):
                    continue
                p = cur / d
                if p.is_symlink():
                    if _symlink_stays_inside(p, work_r):
                        try:
                            tf.add(p, arcname=rel, recursive=False)
                        except OSError:
                            pass
                    continue
                kept_dirs.append(d)
                try:
                    tf.add(p, arcname=rel, recursive=False)
                except OSError:
                    continue
            dirs[:] = kept_dirs
            for f in sorted(files):
                rel = f"{rel_dir}/{f}" if rel_dir else f
                if _is_excluded_system_path(rel):
                    continue
                p = cur / f
                if p.is_symlink() and not _symlink_stays_inside(p, work_r):
                    continue
                try:
                    tf.add(p, arcname=rel, recursive=False)
                except OSError:
                    continue


def _atomic_swap_dir(staged: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    backup: Optional[Path] = None
    if dest.exists() or dest.is_symlink():
        backup = dest.parent / f".old-{dest.name}-{os.getpid()}-{time.time_ns()}"
        shutil.move(str(dest), str(backup))
    try:
        shutil.move(str(staged), str(dest))
    except Exception:
        if backup and backup.exists() and not dest.exists():
            shutil.move(str(backup), str(dest))
        raise
    finally:
        if backup and backup.exists():
            shutil.rmtree(backup, ignore_errors=True)


def _restore_git_from_bundle(bundle_path: Path, dest: Path, *, branch: str, remotes: dict[str, str]) -> None:
    staging_parent = Path(tempfile.mkdtemp(prefix="tina-s3-clone-", dir=str(dest.parent)))
    staged = staging_parent / "repo"
    try:
        proc = subprocess.run(
            ["git", "clone", "--quiet", "--", str(bundle_path), str(staged)],
            capture_output=True, text=True, check=True, env=scrubbed_git_env(GIT_TERMINAL_PROMPT="0"),
        )
        _ = proc
        # Remove temporary bundle origin, then restore real token-free GitHub remotes.
        _git(staged, "remote", "remove", "origin", check=False)
        for rname, rurl in remotes.items():
            if rurl:
                _git(staged, "remote", "add", rname, _scrub_remote_url(rurl), check=False)
        _git(staged, "config", "user.name", "tina-agent", check=False)
        _git(staged, "config", "user.email", "agent@tina", check=False)
        if branch:
            _git(staged, "checkout", "--quiet", branch, check=False)
        _atomic_swap_dir(staged, dest)
    finally:
        shutil.rmtree(staging_parent, ignore_errors=True)


def head_etag(s3: Any, bucket: str, prefix: str) -> Optional[str]:
    """Cheap HEAD check on ``<prefix>/head.json`` — returns ETag or None if absent."""
    try:
        resp = s3.head_object(Bucket=bucket, Key=f"{prefix}/head.json")
        return resp.get("ETag")
    except Exception as exc:
        if _is_not_found(exc):
            return None
        raise


def pull_workspace(
    s3: Any,
    bucket: str,
    prefix: str,
    kind: str,
    dest_dir: Path,
    *,
    current_state: Optional[SyncState] = None,
    tmp_dir: Optional[Path] = None,
) -> tuple[SyncState, bool]:
    """Ensure ``dest_dir`` matches S3 ``<prefix>/head.json``. Returns ``(state, changed)``."""
    head_key = f"{prefix}/head.json"
    try:
        resp = s3.get_object(Bucket=bucket, Key=head_key)
    except Exception as exc:
        if _is_not_found(exc):
            return SyncState(prefix=prefix, kind=kind), False
        raise
    etag = resp.get("ETag")
    head = json.loads(resp["Body"].read().decode("utf-8"))
    remotes_dict = {str(k): str(v) for k, v in (head.get("remotes") or {}).items() if v}
    new_state = SyncState(
        prefix=prefix,
        kind=kind,
        rev=int(head.get("rev") or 0),
        etag=etag,
        head_sha=head.get("head_sha"),
        policy_sha=head.get("policy_sha"),
        remotes=tuple(sorted(remotes_dict.items())),
        branch=str(head.get("branch") or "main"),
        has_routines=bool(head.get("has_routines", False)),
    )
    if current_state is not None and current_state.etag == etag and dest_dir.exists():
        return new_state, False

    bundle_key = head["bundle_key"]
    expected_sha256 = head.get("bundle_sha256")
    scratch_root = tmp_dir or Path(tempfile.gettempdir())
    scratch_root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tina-s3-pull-", dir=str(scratch_root)) as td:
        archive_path = Path(td) / ("snap.bundle" if kind == "git" else "snap.tar.gz")
        obj = s3.get_object(Bucket=bucket, Key=bundle_key)
        with archive_path.open("wb") as out:
            for chunk in iter(lambda: obj["Body"].read(256 * 1024), b""):
                out.write(chunk)
        if expected_sha256:
            actual = _sha256_file(archive_path)
            if actual != expected_sha256:
                raise RuntimeError(f"S3 snapshot integrity mismatch for {bundle_key}")
        dest_dir.parent.mkdir(parents=True, exist_ok=True)
        if kind == "git":
            _restore_git_from_bundle(archive_path, dest_dir, branch=new_state.branch, remotes=remotes_dict)
        else:
            staged = Path(tempfile.mkdtemp(prefix="tina-s3-tar-", dir=str(dest_dir.parent)))
            try:
                _safe_extract_tar(archive_path, staged)
                _atomic_swap_dir(staged, dest_dir)
            except Exception:
                shutil.rmtree(staged, ignore_errors=True)
                raise
    return new_state, True


def _merge_remote_git_bundle(
    work_dir: Path,
    remote_bundle: Path,
    *,
    branch: str,
    actor: str,
) -> None:
    """Three-way merge remote S3 bundle commits into local ``work_dir`` without losing writes."""
    ref_target = f"refs/remotes/tina-s3/{branch}"
    _git(work_dir, "fetch", "--quiet", str(remote_bundle), f"refs/heads/{branch}:{ref_target}")
    # Ensure working tree has no unstaged leftovers before merge
    dirty = _git(work_dir, "status", "--porcelain", check=False).stdout.strip()
    if dirty:
        _git(work_dir, "add", "-A", check=False)
        _git(
            work_dir, "commit", "-q", "-m", "tina: autosave before merge",
            check=False,
            extra_env={
                "GIT_AUTHOR_NAME": actor, "GIT_AUTHOR_EMAIL": f"{actor}@tina.local",
                "GIT_COMMITTER_NAME": "tina-platform", "GIT_COMMITTER_EMAIL": "platform@tina.local",
            },
        )
    merge_env = {
        "GIT_AUTHOR_NAME": actor, "GIT_AUTHOR_EMAIL": f"{actor}@tina.local",
        "GIT_COMMITTER_NAME": "tina-platform", "GIT_COMMITTER_EMAIL": "platform@tina.local",
    }
    proc = _git(work_dir, "merge", "--no-edit", ref_target, check=False, extra_env=merge_env)
    if proc.returncode == 0:
        return
    # Merge conflict: never drop user's work — save conflicting local files into kg/conflicts/
    unmerged = [
        ln.strip()
        for ln in _git(work_dir, "diff", "--name-only", "--diff-filter=U", check=False).stdout.splitlines()
        if ln.strip()
    ]
    local_head = _head_sha(work_dir)
    _git(work_dir, "merge", "--abort", check=False)
    saved: list[tuple[str, bytes]] = []
    if local_head:
        for rel in unmerged:
            if rel.startswith("policy/"):
                continue
            show = subprocess.run(
                ["git", "show", f"{local_head}:{rel}"],
                cwd=str(work_dir), capture_output=True, check=False, env=scrubbed_git_env(),
            )
            if show.returncode == 0:
                saved.append((rel, show.stdout))
    _git(work_dir, "reset", "--hard", ref_target)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    conflicts_dir = work_dir / "kg" / "conflicts"
    for rel, content in saved:
        conflicts_dir.mkdir(parents=True, exist_ok=True)
        src = Path(rel)
        safe_actor = re.sub(r"[^A-Za-z0-9_-]+", "-", actor or "user")[:32]
        copy_name = f"{src.stem}.{safe_actor}-{ts}{src.suffix or '.md'}"
        (conflicts_dir / copy_name).write_bytes(content)
    if saved:
        _git(work_dir, "add", "kg/conflicts")
        _git(work_dir, "commit", "-q", "-m", f"tina: preserve concurrent edits ({len(saved)} file(s))",
             extra_env=merge_env)


def _merge_remote_tar_dir(work_dir: Path, remote_tar: Path) -> None:
    """Merge missing remote files (e.g. concurrent chat threads in _system) into local dir."""
    with tempfile.TemporaryDirectory(prefix="tina-s3-tarmerge-") as td:
        remote_dir = Path(td) / "remote"
        _safe_extract_tar(remote_tar, remote_dir)
        for p in remote_dir.rglob("*"):
            rel = p.relative_to(remote_dir)
            dst = work_dir / rel
            if p.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
            elif p.is_file() and not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dst)


def push_workspace(
    s3: Any,
    bucket: str,
    prefix: str,
    kind: str,
    work_dir: Path,
    base_state: SyncState,
    *,
    actor: str = "system",
    kms_key_id: Optional[str] = None,
    protect_policy: bool = True,
    tmp_dir: Optional[Path] = None,
    force: bool = False,
) -> tuple[SyncState, bool]:
    """Commit local ``work_dir`` to S3 with atomic ``If-Match`` CAS + 3-way merge on ``412``."""
    if not work_dir.exists():
        return base_state, False
    if kind == "git" and not (work_dir / ".git").exists():
        return base_state, False

    state = base_state
    scratch_root = tmp_dir or Path(tempfile.gettempdir())
    scratch_root.mkdir(parents=True, exist_ok=True)

    for attempt in range(_MAX_CAS_ATTEMPTS):
        if kind == "git":
            if protect_policy:
                policy_base = state.policy_sha or state.head_sha
                _revert_policy_writes(work_dir, policy_base)
                pol_dirty = _git(work_dir, "status", "--porcelain", "--", "policy", check=False).stdout.strip()
                if pol_dirty:
                    _git(work_dir, "add", "-A", "--", "policy", check=False)
                    _git(
                        work_dir, "commit", "-q", "-m", "tina: restore protected policy/",
                        check=False,
                        extra_env={
                            "GIT_AUTHOR_NAME": "tina-platform", "GIT_AUTHOR_EMAIL": "platform@tina.local",
                            "GIT_COMMITTER_NAME": "tina-platform", "GIT_COMMITTER_EMAIL": "platform@tina.local",
                        },
                    )
            current_sha = _head_sha(work_dir)
            if not current_sha:
                return state, False
            remotes_dict = _extract_remotes(work_dir)
            remotes_tuple = tuple(sorted(remotes_dict.items()))
            branch = _current_branch(work_dir)
            if (not force and state.etag is not None and current_sha == state.head_sha
                    and remotes_tuple == state.remotes and branch == state.branch):
                return state, False
            next_rev = state.rev + 1
            bundle_key = f"{prefix}/snapshots/{next_rev:06d}-{current_sha[:12]}.bundle"
            with tempfile.TemporaryDirectory(prefix="tina-s3-push-", dir=str(scratch_root)) as td:
                bundle_file = Path(td) / "out.bundle"
                _git(work_dir, "bundle", "create", str(bundle_file), "--all")
                bundle_sha256 = _sha256_file(bundle_file)
                bundle_bytes = bundle_file.stat().st_size
                with bundle_file.open("rb") as fh:
                    s3.put_object(
                        Bucket=bucket, Key=bundle_key, Body=fh.read(),
                        ContentType="application/octet-stream",
                        **_kms_kwargs(kms_key_id),
                    )
            new_policy_sha = current_sha if not protect_policy else (state.policy_sha or current_sha)
            has_rt = _has_routines(work_dir)
            head_doc = {
                "schema": "tina.ws.head.v1",
                "workspace_key": prefix,
                "kind": "git",
                "rev": next_rev,
                "head_sha": current_sha,
                "policy_sha": new_policy_sha,
                "branch": branch,
                "remotes": remotes_dict,
                "bundle_key": bundle_key,
                "bundle_sha256": bundle_sha256,
                "bundle_bytes": bundle_bytes,
                "has_routines": has_rt,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "updated_by": actor,
            }
        else:
            digest = _dir_content_digest(work_dir)
            if not force and state.etag is not None and digest == state.head_sha:
                return state, False
            next_rev = state.rev + 1
            bundle_key = f"{prefix}/snapshots/{next_rev:06d}-{digest[:12]}.tar.gz"
            with tempfile.TemporaryDirectory(prefix="tina-s3-push-", dir=str(scratch_root)) as td:
                archive_file = Path(td) / "out.tar.gz"
                _create_tar(work_dir, archive_file)
                bundle_sha256 = _sha256_file(archive_file)
                bundle_bytes = archive_file.stat().st_size
                with archive_file.open("rb") as fh:
                    s3.put_object(
                        Bucket=bucket, Key=bundle_key, Body=fh.read(),
                        ContentType="application/gzip",
                        **_kms_kwargs(kms_key_id),
                    )
            remotes_tuple = ()
            branch = "main"
            current_sha = digest
            new_policy_sha = None
            has_rt = False
            head_doc = {
                "schema": "tina.ws.head.v1",
                "workspace_key": prefix,
                "kind": "tar",
                "rev": next_rev,
                "head_sha": digest,
                "bundle_key": bundle_key,
                "bundle_sha256": bundle_sha256,
                "bundle_bytes": bundle_bytes,
                "has_routines": False,
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "updated_by": actor,
            }

        put_kwargs: dict[str, Any] = {
            "Bucket": bucket,
            "Key": f"{prefix}/head.json",
            "Body": json.dumps(head_doc, sort_keys=True, separators=(",", ":")).encode("utf-8"),
            "ContentType": "application/json",
            **_kms_kwargs(kms_key_id),
        }
        if state.etag is None:
            put_kwargs["IfNoneMatch"] = "*"
        else:
            put_kwargs["IfMatch"] = state.etag

        try:
            resp = s3.put_object(**put_kwargs)
            return SyncState(
                prefix=prefix, kind=kind, rev=next_rev, etag=resp.get("ETag"),
                head_sha=current_sha, policy_sha=new_policy_sha,
                remotes=remotes_tuple, branch=branch, has_routines=has_rt,
            ), True
        except Exception as exc:
            if not _is_precondition_failed(exc) or attempt == _MAX_CAS_ATTEMPTS - 1:
                raise
            log.info("S3 CAS conflict on %s (attempt %d/%d) — fetching latest and merging",
                     prefix, attempt + 1, _MAX_CAS_ATTEMPTS)
            remote_resp = s3.get_object(Bucket=bucket, Key=f"{prefix}/head.json")
            remote_etag = remote_resp.get("ETag")
            remote_head = json.loads(remote_resp["Body"].read().decode("utf-8"))
            with tempfile.TemporaryDirectory(prefix="tina-s3-merge-", dir=str(scratch_root)) as td:
                rpath = Path(td) / ("remote.bundle" if kind == "git" else "remote.tar.gz")
                robj = s3.get_object(Bucket=bucket, Key=remote_head["bundle_key"])
                with rpath.open("wb") as out:
                    for chunk in iter(lambda: robj["Body"].read(256 * 1024), b""):
                        out.write(chunk)
                if kind == "git":
                    _merge_remote_git_bundle(work_dir, rpath, branch=str(remote_head.get("branch") or "main"), actor=actor)
                else:
                    _merge_remote_tar_dir(work_dir, rpath)
            remote_remotes = tuple(sorted((remote_head.get("remotes") or {}).items()))
            state = SyncState(
                prefix=prefix, kind=kind, rev=int(remote_head.get("rev") or 0),
                etag=remote_etag, head_sha=remote_head.get("head_sha"),
                policy_sha=remote_head.get("policy_sha"),
                remotes=remote_remotes, branch=str(remote_head.get("branch") or "main"),
                has_routines=bool(remote_head.get("has_routines", False)),
            )
            force = True
            time.sleep(0.05 * (attempt + 1))

    raise RuntimeError(f"S3 CAS commit failed after {_MAX_CAS_ATTEMPTS} attempts for {prefix}")
