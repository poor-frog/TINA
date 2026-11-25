"""Loopback S3 workspace sync sidecar (127.0.0.1:8722) for ephemeral Fargate workers.

Security boundary:
- Receives turn-scoped temporary STS credentials ONLY in this sidecar's environment.
- Pulls ONLY the turn's granted prefixes into the shared local ephemeral ``/workspaces`` volume
  before advertising ``/health`` = 200 (the ``worker`` container depends on ``sync: HEALTHY``).
- Commits ONLY writable mounts back to S3 via ``If-Match`` CAS + 3-way merge, enforcing
  ``policy/`` protection outside the untrusted ``worker`` container.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import threading
import time
from typing import Any
from urllib.request import Request, urlopen

from shared.s3_workspace import SyncState, head_etag, pull_workspace, push_workspace, s3_prefix_for_mount

PORT = 8722
_DRAIN_BUFFER_SEC = 180
log = logging.getLogger("tina.workspace_sync")


class WorkspaceSyncClient:
    """Thin loopback HTTP client used by ``worker.engine`` when ``TINA_WORKSPACE_SYNC_SIDECAR=1``."""

    def __init__(self, port: int = PORT) -> None:
        self._base = f"http://127.0.0.1:{port}"

    def _post(self, path: str, timeout: float = 120.0) -> dict[str, Any]:
        req = Request(
            f"{self._base}{path}",
            data=b"{}",
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def refresh(self) -> dict[str, Any]:
        return self._post("/refresh", timeout=60.0)

    def commit(self) -> dict[str, Any]:
        return self._post("/commit", timeout=120.0)


class SyncCoordinator:
    """Manages pull/refresh/commit across one turn's validated mount set."""

    def __init__(
        self,
        *,
        s3: Any,
        bucket: str,
        kms_key_id: str | None,
        owner: str,
        mounts: list[dict[str, Any]],
        root: Path = Path("/workspaces"),
        token_expires_at: float = 0.0,
        tmp_dir: Path | None = None,
    ) -> None:
        self.s3 = s3
        self.bucket = bucket
        self.kms_key_id = kms_key_id
        self.owner = owner
        self.root = root
        self.token_expires_at = token_expires_at
        self.tmp_dir = tmp_dir
        self._lock = threading.Lock()
        self._entries: list[tuple[Path, str, str, bool]] = []
        self._states: dict[str, SyncState] = {}
        for mount in mounts:
            mpath = Path(mount["path"])
            prefix, kind = s3_prefix_for_mount(self.root, mpath)
            writable = bool(mount.get("write", False))
            self._entries.append((mpath, prefix, kind, writable))
            self._states[str(mpath)] = SyncState(prefix=prefix, kind=kind)

    def drain_after_turn(self) -> bool:
        return bool(self.token_expires_at and (self.token_expires_at - time.time()) <= _DRAIN_BUFFER_SEC)

    def bootstrap(self) -> None:
        """Initial parallel pull of every granted mount into ephemeral SSD."""
        def _pull_one(item: tuple[Path, str, str, bool]) -> tuple[str, SyncState]:
            mpath, prefix, kind, _writable = item
            state, _changed = pull_workspace(
                self.s3, self.bucket, prefix, kind, mpath, tmp_dir=self.tmp_dir,
            )
            mpath.parent.mkdir(parents=True, exist_ok=True)
            return str(mpath), state

        with self._lock:
            with ThreadPoolExecutor(max_workers=min(6, max(1, len(self._entries)))) as pool:
                for key, state in pool.map(_pull_one, self._entries):
                    self._states[key] = state

    def refresh(self) -> dict[str, Any]:
        """Fast HEAD check + pull for any mount that changed remotely while worker was warm."""
        refreshed: list[str] = []
        with self._lock:
            for mpath, prefix, kind, _writable in self._entries:
                cur = self._states[str(mpath)]
                remote_etag = head_etag(self.s3, self.bucket, prefix)
                if remote_etag and remote_etag != cur.etag:
                    new_state, changed = pull_workspace(
                        self.s3, self.bucket, prefix, kind, mpath,
                        current_state=cur, tmp_dir=self.tmp_dir,
                    )
                    self._states[str(mpath)] = new_state
                    if changed:
                        refreshed.append(prefix)
        return {"refreshed": refreshed, "drain_after_turn": self.drain_after_turn()}

    def commit(self) -> dict[str, Any]:
        """Push ONLY writable mounts back to S3 with policy/ protection and CAS merge."""
        committed: list[dict[str, Any]] = []
        writable_entries = [e for e in self._entries if e[3]]

        def _push_one(item: tuple[Path, str, str, bool]) -> tuple[str, SyncState, bool]:
            mpath, prefix, kind, _writable = item
            cur = self._states[str(mpath)]
            new_state, changed = push_workspace(
                self.s3, self.bucket, prefix, kind, mpath, cur,
                actor=self.owner, kms_key_id=self.kms_key_id,
                protect_policy=True, tmp_dir=self.tmp_dir,
            )
            return str(mpath), new_state, changed

        with self._lock:
            with ThreadPoolExecutor(max_workers=min(4, max(1, len(writable_entries)))) as pool:
                for key, new_state, changed in pool.map(_push_one, writable_entries):
                    self._states[key] = new_state
                    if changed:
                        committed.append({
                            "prefix": new_state.prefix,
                            "rev": new_state.rev,
                            "head_sha": new_state.head_sha,
                            "has_routines": new_state.has_routines,
                        })
        return {"committed": committed, "drain_after_turn": self.drain_after_turn()}


def handler_for(coord: SyncCoordinator):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # Never log request metadata or credentials.

        def _reply(self, code: int, body: dict[str, Any]) -> None:
            raw = json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/health":
                self._reply(200, {"ok": True, "mounts": len(coord._entries)})
                return
            self.send_error(404)

        def do_POST(self):
            try:
                if self.path == "/refresh":
                    self._reply(200, coord.refresh())
                elif self.path == "/commit":
                    self._reply(200, coord.commit())
                else:
                    self.send_error(404)
            except Exception as exc:  # noqa: BLE001
                log.exception("workspace sync %s failed", self.path)
                self._reply(500, {"error": type(exc).__name__, "detail": str(exc)[:300]})

    return Handler


def main() -> None:
    import boto3
    from botocore.config import Config

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    region = (os.environ.get("TINA_S3_REGION") or os.environ.get("AWS_REGION") or "us-east-1").strip()
    bucket = os.environ["TINA_S3_BUCKET"]
    kms_key_id = (os.environ.get("TINA_S3_KMS_KEY_ID") or "").strip() or None
    owner = os.environ["TINA_OWNER"]
    mounts = json.loads(os.environ["TINA_MOUNTS"])
    expires_at = float(os.environ.get("TINA_SYNC_TOKEN_EXPIRES_AT") or "0")
    s3 = boto3.client(
        "s3",
        region_name=region,
        aws_access_key_id=os.environ.pop("AWS_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.pop("AWS_SECRET_ACCESS_KEY"),
        aws_session_token=os.environ.pop("AWS_SESSION_TOKEN"),
        config=Config(retries={"max_attempts": 4, "mode": "standard"}),
    )
    coord = SyncCoordinator(
        s3=s3, bucket=bucket, kms_key_id=kms_key_id, owner=owner, mounts=mounts,
        root=Path("/workspaces"), token_expires_at=expires_at,
        tmp_dir=Path(os.environ.get("TMPDIR") or "/tmp"),
    )
    coord.bootstrap()
    log.info("workspace_sync ready for owner=%s mounts=%d", owner, len(mounts))
    with ThreadingHTTPServer(("127.0.0.1", PORT), handler_for(coord)) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()
