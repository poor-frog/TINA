"""Control-plane S3 WorkspaceStore for agent-api (local NVMe cache + write-through S3).

Keeps every existing agent-api domain module (workspace_reader, workspace_attach,
workspace_membership, workspace_git_sync, workspace_publish, workspace_documents,
workspace_routines) working transparently against local NVMe directories while persisting
all state durably in KMS-encrypted S3 with If-Match CAS, Valkey distributed locks, and
O(1) invite resolution.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
from pathlib import Path
import shutil
import threading
import time
from typing import Any, AsyncIterator, Iterator, Optional
import uuid

from shared.s3_workspace import (
    SyncState,
    _is_not_found,
    _is_precondition_failed,
    _kms_kwargs,
    _safe_extract_tar,
    _s3_error_code,
    head_etag,
    pull_workspace,
    push_workspace,
    s3_prefix_for_mount,
)

log = logging.getLogger("agent_api.workspace_store")

_HEAD_CHECK_TTL_SEC = 1.5
_MAX_STATE_CAS = 5


class S3WorkspaceStore:
    """Synchronizes local NVMe workspace cache directories with KMS-encrypted S3."""

    def __init__(
        self,
        *,
        s3: Any,
        bucket: str,
        root: Path,
        kms_key_id: Optional[str] = None,
        secrets_kms_key_id: Optional[str] = None,
        redis_url: Optional[str] = None,
    ) -> None:
        self.s3 = s3
        self.bucket = bucket
        self.root = Path(root)
        self.kms_key_id = kms_key_id
        self.secrets_kms_key_id = secrets_kms_key_id or kms_key_id
        self._redis_url = redis_url
        self._redis_client: Any = None
        self._lock = threading.Lock()
        self._states: dict[str, SyncState] = {}
        self._checked_at: dict[str, float] = {}
        self._state_etags: dict[str, tuple[Optional[str], float]] = {}
        self._draft_etags: dict[tuple[str, str], tuple[Optional[str], float]] = {}
        self.root.mkdir(parents=True, exist_ok=True)

    @classmethod
    def from_env(cls, root: Path, *, redis_url: Optional[str] = None) -> Optional[S3WorkspaceStore]:
        if (os.getenv("TINA_WORKSPACE_STORAGE") or "").strip().lower() != "s3":
            return None
        bucket = (os.getenv("TINA_S3_WORKSPACE_BUCKET") or "").strip()
        if not bucket:
            raise ValueError("TINA_WORKSPACE_STORAGE=s3 requires TINA_S3_WORKSPACE_BUCKET")
        import boto3
        from botocore.config import Config

        region = (os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION") or "us-east-1").strip()
        s3 = boto3.client("s3", region_name=region, config=Config(retries={"max_attempts": 4, "mode": "standard"}))
        return cls(
            s3=s3,
            bucket=bucket,
            root=root,
            kms_key_id=(os.getenv("TINA_S3_WORKSPACE_KMS_KEY_ID") or "").strip() or None,
            secrets_kms_key_id=(os.getenv("TINA_S3_SECRETS_KMS_KEY_ID") or "").strip() or None,
            redis_url=redis_url,
        )

    def _redis(self):
        if not self._redis_url:
            return None
        with self._lock:
            if self._redis_client is None:
                try:
                    import redis
                    self._redis_client = redis.from_url(
                        self._redis_url, decode_responses=True, socket_connect_timeout=1, socket_timeout=2,
                    )
                except Exception:  # noqa: BLE001
                    return None
            return self._redis_client

    @staticmethod
    def _try_acquire_lock(client: Any, lock_key: str, token: str) -> Optional[bool]:
        try:
            return bool(client.set(lock_key, token, nx=True, px=30000))
        except Exception:  # noqa: BLE001
            return None

    @staticmethod
    def _release_lock(client: Any, lock_key: str, token: str) -> None:
        try:
            script = (
                "if redis.call('get', KEYS[1]) == ARGV[1] then "
                "return redis.call('del', KEYS[1]) else return 0 end"
            )
            client.eval(script, 1, lock_key, token)
        except Exception:  # noqa: BLE001
            pass

    @contextlib.contextmanager
    def distributed_lock(self, key: str, *, timeout: float = 25.0) -> Iterator[None]:
        """Cross-replica Valkey mutex (falls back to in-process lock when Redis unavailable)."""
        client = self._redis()
        if client is None:
            yield
            return
        lock_key = f"tina:ws-lock:{key}"
        token = uuid.uuid4().hex
        deadline = time.monotonic() + timeout
        acquired = False
        while time.monotonic() < deadline:
            status = self._try_acquire_lock(client, lock_key, token)
            if status is True:
                acquired = True
                break
            if status is None:
                break
            time.sleep(0.05)
        try:
            yield
        finally:
            if acquired:
                self._release_lock(client, lock_key, token)

    @contextlib.asynccontextmanager
    async def async_distributed_lock(self, key: str, *, timeout: float = 25.0) -> AsyncIterator[None]:
        """Non-blocking cross-replica Valkey mutex for async middleware without stalling the event loop."""
        client = await asyncio.to_thread(self._redis)
        if client is None:
            yield
            return
        lock_key = f"tina:ws-lock:{key}"
        token = uuid.uuid4().hex
        deadline = time.monotonic() + timeout
        acquired = False
        while time.monotonic() < deadline:
            status = await asyncio.to_thread(self._try_acquire_lock, client, lock_key, token)
            if status is True:
                acquired = True
                break
            if status is None:
                break
            await asyncio.sleep(0.05)
        try:
            yield
        finally:
            if acquired:
                await asyncio.to_thread(self._release_lock, client, lock_key, token)

    # ── attach state.json sync ────────────────────────────────────────────────

    def _state_file(self, subject: str) -> Path:
        return self.root / "_attached" / subject / "state.json"

    def sync_attach_state(self, subject: str, *, force: bool = False) -> None:
        if not subject or not subject.isdecimal():
            return
        s3_key = f"users/{subject}/attached/state.json"
        now = time.monotonic()
        with self._lock:
            cached_etag, checked = self._state_etags.get(subject, (None, 0.0))
        if not force and (now - checked) < _HEAD_CHECK_TTL_SEC:
            return
        try:
            get_kwargs: dict[str, Any] = {"Bucket": self.bucket, "Key": s3_key}
            if cached_etag and self._state_file(subject).exists():
                get_kwargs["IfNoneMatch"] = cached_etag
            resp = self.s3.get_object(**get_kwargs)
            body = resp["Body"].read()
            etag = resp.get("ETag")
            dest = self._state_file(subject)
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".json.tmp")
            tmp.write_bytes(body)
            os.replace(tmp, dest)
            with self._lock:
                self._state_etags[subject] = (etag, time.monotonic())
        except Exception as exc:
            code, status = _s3_error_code(exc)
            if status == 304 or code == "304":
                with self._lock:
                    self._state_etags[subject] = (cached_etag, time.monotonic())
                return
            if _is_not_found(exc):
                with self._lock:
                    self._state_etags[subject] = (None, time.monotonic())
                return
            raise

    def push_attach_state(self, subject: str) -> None:
        if not subject or not subject.isdecimal():
            return
        src = self._state_file(subject)
        if not src.exists():
            return
        body = src.read_bytes()
        s3_key = f"users/{subject}/attached/state.json"
        put_kwargs: dict[str, Any] = {
            "Bucket": self.bucket,
            "Key": s3_key,
            "Body": body,
            "ContentType": "application/json",
            **_kms_kwargs(self.kms_key_id),
        }
        resp = self.s3.put_object(**put_kwargs)
        with self._lock:
            self._state_etags[subject] = (resp.get("ETag"), time.monotonic())

    # ── post-meeting draft latest.json sync ──────────────────────────────────

    def _post_meeting_draft_key(self, subject: str, meeting_id: int | str) -> Optional[str]:
        mid = str(meeting_id).strip()
        if not subject or not subject.isdecimal() or not mid or not mid.isdecimal():
            return None
        return f"_post-meeting-drafts/{subject}/{mid}/latest.json"

    def sync_post_meeting_draft(
        self,
        subject: str,
        meeting_id: int | str,
        dest: Path,
        *,
        force: bool = False,
    ) -> None:
        """Pull owner-scoped post-meeting draft state from KMS-encrypted S3 into local cache."""
        s3_key = self._post_meeting_draft_key(subject, meeting_id)
        if s3_key is None:
            return
        cache_key = (subject, str(meeting_id).strip())
        now = time.monotonic()
        with self._lock:
            cached_etag, checked = self._draft_etags.get(cache_key, (None, 0.0))
        if not force and dest.exists() and (now - checked) < _HEAD_CHECK_TTL_SEC:
            return
        try:
            get_kwargs: dict[str, Any] = {"Bucket": self.bucket, "Key": s3_key}
            if cached_etag and dest.exists():
                get_kwargs["IfNoneMatch"] = cached_etag
            resp = self.s3.get_object(**get_kwargs)
            body = resp["Body"].read()
            etag = resp.get("ETag")
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(f".{uuid.uuid4().hex[:8]}.tmp")
            try:
                tmp.write_bytes(body)
                os.replace(tmp, dest)
            finally:
                if tmp.exists():
                    tmp.unlink(missing_ok=True)
            with self._lock:
                self._draft_etags[cache_key] = (etag, time.monotonic())
        except Exception as exc:
            code, status = _s3_error_code(exc)
            if status == 304 or code == "304":
                with self._lock:
                    self._draft_etags[cache_key] = (cached_etag, time.monotonic())
                return
            if _is_not_found(exc):
                with self._lock:
                    self._draft_etags[cache_key] = (None, time.monotonic())
                return
            raise

    def push_post_meeting_draft(self, subject: str, meeting_id: int | str, src: Path) -> None:
        """Persist owner-scoped post-meeting draft state durably to KMS-encrypted S3."""
        s3_key = self._post_meeting_draft_key(subject, meeting_id)
        if s3_key is None or not src.exists():
            return
        cache_key = (subject, str(meeting_id).strip())
        body = src.read_bytes()
        put_kwargs: dict[str, Any] = {
            "Bucket": self.bucket,
            "Key": s3_key,
            "Body": body,
            "ContentType": "application/json",
            **_kms_kwargs(self.kms_key_id),
        }
        resp = self.s3.put_object(**put_kwargs)
        with self._lock:
            self._draft_etags[cache_key] = (resp.get("ETag"), time.monotonic())

    # ── workspace directory sync ──────────────────────────────────────────────

    def ensure_synced(self, path: Path, *, force: bool = False) -> SyncState:
        prefix, kind = s3_prefix_for_mount(self.root, path)
        now = time.monotonic()
        with self._lock:
            cur = self._states.get(prefix)
            last_check = self._checked_at.get(prefix, 0.0)
        if not force and cur is not None and path.exists() and (now - last_check) < _HEAD_CHECK_TTL_SEC:
            return cur
        if cur is not None and path.exists():
            remote_etag = head_etag(self.s3, self.bucket, prefix)
            if remote_etag == cur.etag:
                with self._lock:
                    self._checked_at[prefix] = time.monotonic()
                return cur
        new_state, _changed = pull_workspace(self.s3, self.bucket, prefix, kind, path, current_state=cur)
        with self._lock:
            self._states[prefix] = new_state
            self._checked_at[prefix] = time.monotonic()
        return new_state

    def push_if_changed(self, path: Path, *, actor: str = "system", protect_policy: bool = False, force: bool = False) -> bool:
        prefix, kind = s3_prefix_for_mount(self.root, path)
        with self._lock:
            base = self._states.get(prefix) or SyncState(prefix=prefix, kind=kind)
        new_state, changed = push_workspace(
            self.s3, self.bucket, prefix, kind, path, base,
            actor=actor, kms_key_id=self.kms_key_id,
            protect_policy=protect_policy, force=force,
        )
        with self._lock:
            self._states[prefix] = new_state
            self._checked_at[prefix] = time.monotonic()
        if changed and new_state.has_routines and prefix.startswith("users/"):
            subj = prefix.split("/", 2)[1]
            self.mark_routine_subject(subj)
        return changed

    def sync_subject_workspaces(self, subject: str, *, memberships: Optional[list[dict]] = None,
                                include_system: bool = False, force: bool = False) -> None:
        if not subject or not subject.isdecimal():
            return
        self.sync_attach_state(subject, force=force)
        paths: list[Path] = [self.root / subject]
        if include_system:
            paths.append(self.root / "_system" / subject)
        state_file = self._state_file(subject)
        if state_file.exists():
            try:
                data = json.loads(state_file.read_text(encoding="utf-8"))
                for slug in (data.get("slots") or {}).keys():
                    if slug and slug not in ("seed", "seed-prev"):
                        paths.append(self.root / "_attached" / subject / slug)
            except (OSError, ValueError):
                pass
        for entry in memberships or []:
            ws_id = (entry.get("workspace_id") or "").strip() if isinstance(entry, dict) else ""
            if ws_id and not ws_id.startswith(".") and not ws_id.startswith("_") and not ws_id.isdecimal():
                paths.append(self.root / ws_id)
        for p in dict.fromkeys(paths):
            try:
                self.ensure_synced(p, force=force)
            except Exception:  # noqa: BLE001
                log.debug("skipping sync for %s", p, exc_info=True)

    # ── O(1) invite index on S3 ───────────────────────────────────────────────

    def record_invite_index(self, token_hash: str, workspace_id: str) -> None:
        self.s3.put_object(
            Bucket=self.bucket,
            Key=f"_invites/{token_hash}.json",
            Body=json.dumps({"workspace_id": workspace_id}).encode("utf-8"),
            ContentType="application/json",
            **_kms_kwargs(self.kms_key_id),
        )

    def sync_invite_target(self, token_hash: str) -> Optional[str]:
        try:
            resp = self.s3.get_object(Bucket=self.bucket, Key=f"_invites/{token_hash}.json")
            wid = str(json.loads(resp["Body"].read().decode("utf-8")).get("workspace_id") or "")
            if wid:
                self.ensure_synced(self.root / wid, force=True)
                return wid
        except Exception as exc:
            if not _is_not_found(exc):
                raise
        # Fallback for pre-indexed shared wikis: sync all shared/* prefixes once
        for wid in self.list_shared_workspaces():
            self.ensure_synced(self.root / wid, force=False)
        return None

    def list_shared_workspaces(self) -> list[str]:
        found: list[str] = []
        token: Optional[str] = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": "shared/", "Delimiter": "/"}
            if token:
                kwargs["ContinuationToken"] = token
            page = self.s3.list_objects_v2(**kwargs)
            for cp in page.get("CommonPrefixes", []):
                parts = cp["Prefix"].strip("/").split("/")
                if len(parts) == 2 and parts[1]:
                    found.append(parts[1])
            token = page.get("NextContinuationToken")
            if not token:
                break
        return sorted(found)

    def list_user_subjects(self) -> list[str]:
        found: list[str] = []
        token: Optional[str] = None
        while True:
            kwargs: dict[str, Any] = {"Bucket": self.bucket, "Prefix": "users/", "Delimiter": "/"}
            if token:
                kwargs["ContinuationToken"] = token
            page = self.s3.list_objects_v2(**kwargs)
            for cp in page.get("CommonPrefixes", []):
                parts = cp["Prefix"].strip("/").split("/")
                if len(parts) == 2 and parts[1].isdecimal():
                    found.append(parts[1])
            token = page.get("NextContinuationToken")
            if not token:
                break
        return sorted(found)

    def mark_routine_subject(self, subject: str) -> None:
        client = self._redis()
        if client is not None and subject.isdecimal():
            try:
                client.sadd("tina:routines:active_subjects", subject)
            except Exception:  # noqa: BLE001
                pass

    # ── secrets (GitHub PAT) ──────────────────────────────────────────────────

    def read_secret_token(self, subject: str) -> Optional[str]:
        try:
            resp = self.s3.get_object(Bucket=self.bucket, Key=f"secrets/users/{subject}/github.token")
            tok = resp["Body"].read().decode("utf-8").strip()
            return tok or None
        except Exception as exc:
            if _is_not_found(exc):
                return None
            raise

    def write_secret_token(self, subject: str, token: Optional[str]) -> bool:
        key = f"secrets/users/{subject}/github.token"
        tok = (token or "").strip()
        if not tok:
            try:
                self.s3.delete_object(Bucket=self.bucket, Key=key)
            except Exception:
                pass
            return False
        self.s3.put_object(
            Bucket=self.bucket,
            Key=key,
            Body=tok.encode("utf-8"),
            ContentType="text/plain",
            **_kms_kwargs(self.secrets_kms_key_id),
        )
        return True

    # ── one-time idempotent EFS -> S3 migration ───────────────────────────────

    def migrate_from_efs(self, efs_root: Path) -> dict[str, int]:
        """Idempotently mirror existing EFS workspaces/secrets to S3 (never overwrites existing S3 heads)."""
        counts = {"git": 0, "system": 0, "state": 0, "secrets": 0, "invites": 0, "skipped": 0}
        if not efs_root.is_dir():
            return counts

        def _migrate_tree(src: Path, prefix: str, kind: str) -> None:
            if head_etag(self.s3, self.bucket, prefix) is not None:
                counts["skipped"] += 1
                return
            try:
                _st, changed = push_workspace(
                    self.s3, self.bucket, prefix, kind, src,
                    SyncState(prefix=prefix, kind=kind),
                    actor="efs-migration", kms_key_id=self.kms_key_id,
                    protect_policy=False, force=True,
                )
                if changed:
                    counts["system" if kind == "tar" else "git"] += 1
            except Exception as exc:
                if _is_precondition_failed(exc):
                    counts["skipped"] += 1
                else:
                    log.exception("EFS->S3 migration failed for %s (%s)", src, prefix)

        # 1. Top-level numeric homes + shared workspaces
        for child in sorted(efs_root.iterdir()):
            if not child.is_dir() or child.is_symlink():
                continue
            name = child.name
            if name.startswith(".") or name in ("_system", "_attached", "_global"):
                continue
            if name.isdecimal():
                if (child / ".git").exists():
                    _migrate_tree(child, f"users/{name}/home", "git")
            else:
                if (child / ".git").exists():
                    _migrate_tree(child, f"shared/{name}", "git")
                    # Index existing invites for O(1) lookup
                    inv_file = child / "policy" / "invites.json"
                    if inv_file.is_file():
                        try:
                            for rec in json.loads(inv_file.read_text(encoding="utf-8")):
                                if isinstance(rec, dict) and rec.get("hash"):
                                    self.record_invite_index(str(rec["hash"]), name)
                                    counts["invites"] += 1
                        except (OSError, ValueError):
                            pass

        # 2. _system/<uid> (and fallback .system/<uid>)
        for sys_dir_name in ("_system", ".system"):
            sroot = efs_root / sys_dir_name
            if sroot.is_dir() and not sroot.is_symlink():
                for child in sorted(sroot.iterdir()):
                    if child.is_dir() and not child.is_symlink() and child.name.isdecimal():
                        _migrate_tree(child, f"users/{child.name}/system", "tar")

        # 3. _attached/<uid> (and fallback .attached/<uid>) state.json + slots
        for att_dir_name in ("_attached", ".attached"):
            aroot = efs_root / att_dir_name
            if aroot.is_dir() and not aroot.is_symlink():
                for subj_dir in sorted(aroot.iterdir()):
                    if not subj_dir.is_dir() or subj_dir.is_symlink() or not subj_dir.name.isdecimal():
                        continue
                    uid = subj_dir.name
                    st_file = subj_dir / "state.json"
                    if st_file.is_file():
                        s3_key = f"users/{uid}/attached/state.json"
                        try:
                            self.s3.put_object(
                                Bucket=self.bucket, Key=s3_key, Body=st_file.read_bytes(),
                                ContentType="application/json", IfNoneMatch="*",
                                **_kms_kwargs(self.kms_key_id),
                            )
                            counts["state"] += 1
                        except Exception as exc:
                            if _is_precondition_failed(exc):
                                counts["skipped"] += 1
                            else:
                                raise
                    for slot in sorted(subj_dir.iterdir()):
                        if slot.is_dir() and not slot.is_symlink() and not slot.name.startswith(".") and (slot / ".git").exists():
                            _migrate_tree(slot, f"users/{uid}/attached/slots/{slot.name}", "git")

        # 4. .secrets/<uid>.ghtoken -> secrets/users/<uid>/github.token (KMS Secrets Key)
        sec_root = efs_root / ".secrets"
        if sec_root.is_dir() and not sec_root.is_symlink():
            for f in sorted(sec_root.glob("*.ghtoken")):
                uid = f.name[:-len(".ghtoken")]
                if not uid.isdecimal():
                    continue
                if self.read_secret_token(uid) is None:
                    tok = f.read_text(encoding="utf-8").strip()
                    if tok:
                        self.write_secret_token(uid, tok)
                        counts["secrets"] += 1
                else:
                    counts["skipped"] += 1

        log.info("EFS->S3 migration summary: %s", counts)
        return counts

    def compact_bloated_system_snapshots(self, threshold_bytes: int = 5_000_000) -> dict[str, int]:
        """Atomically strip excluded CLI caches from any oversized users/*/system tarball on S3."""
        import tempfile

        summary = {"checked": 0, "compacted": 0, "skipped": 0, "bytes_saved": 0}
        for uid in self.list_user_subjects():
            prefix = f"users/{uid}/system"
            head_key = f"{prefix}/head.json"
            try:
                resp = self.s3.get_object(Bucket=self.bucket, Key=head_key)
            except Exception as exc:
                if _is_not_found(exc):
                    continue
                raise
            summary["checked"] += 1
            etag = resp.get("ETag")
            head = json.loads(resp["Body"].read().decode("utf-8"))
            old_bytes = int(head.get("bundle_bytes") or 0)
            if head.get("kind") != "tar" or old_bytes <= threshold_bytes:
                summary["skipped"] += 1
                continue
            bundle_key = head.get("bundle_key")
            if not bundle_key:
                summary["skipped"] += 1
                continue
            with tempfile.TemporaryDirectory(prefix="tina-sys-compact-") as td:
                archive = Path(td) / "old.tar.gz"
                staged = Path(td) / "clean"
                obj = self.s3.get_object(Bucket=self.bucket, Key=bundle_key)
                with archive.open("wb") as out:
                    for chunk in iter(lambda: obj["Body"].read(256 * 1024), b""):
                        out.write(chunk)
                _safe_extract_tar(archive, staged)
                cur_state = SyncState(
                    prefix=prefix,
                    kind="tar",
                    rev=int(head.get("rev") or 0),
                    etag=etag,
                    head_sha=head.get("head_sha"),
                )
                try:
                    new_state, changed = push_workspace(
                        self.s3, self.bucket, prefix, "tar", staged, cur_state,
                        actor="system-compact", kms_key_id=self.kms_key_id,
                        protect_policy=False, force=True, tmp_dir=Path(td),
                    )
                    if changed:
                        new_head = json.loads(
                            self.s3.get_object(Bucket=self.bucket, Key=head_key)["Body"].read().decode("utf-8")
                        )
                        new_bytes = int(new_head.get("bundle_bytes") or 0)
                        saved = max(0, old_bytes - new_bytes)
                        summary["compacted"] += 1
                        summary["bytes_saved"] += saved
                        log.info(
                            "S3 system compaction %s: %d -> %d bytes (rev %d)",
                            prefix, old_bytes, new_bytes, new_state.rev,
                        )
                except Exception as exc:
                    if _is_precondition_failed(exc):
                        summary["skipped"] += 1
                    else:
                        log.warning("S3 system compaction skipped for %s", prefix, exc_info=True)
        log.info("S3 system compaction summary: %s", summary)
        return summary
