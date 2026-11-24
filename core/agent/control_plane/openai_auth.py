"""Per-user Sign in with ChatGPT credentials for the self-hosted Codex runner.

The terminal owns OAuth completion; this module owns credential writes, disconnect, refresh
and short-lived access-token brokerage. Secrets remain in the private ``openai-auth`` volume.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token"
_SCOPES = {"chatgpt.tokens.use.direct", "resource.invoke", "offline_access"}
_SAFE_SUBJECT = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_LOCAL_LOCK = threading.Lock()


class ChatGPTAuthError(RuntimeError):
    """A safe, user-actionable ChatGPT plan auth error (never includes token values)."""


def _path(subject: str) -> Path:
    if not _SAFE_SUBJECT.fullmatch(subject) or subject in {".", ".."}:
        raise ChatGPTAuthError("Invalid TINA user id for ChatGPT credentials.")
    root = Path(os.environ.get("TINA_OPENAI_AUTH_DIR", "/var/lib/tina/openai-auth"))
    return root / f"{subject}.json"


def _read(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise ChatGPTAuthError("Connect a ChatGPT plan in Settings → Models first.") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise ChatGPTAuthError("TINA could not read the saved ChatGPT connection; reconnect it.") from exc
    if not isinstance(data, dict) or not data.get("client_id") or not data.get("refresh_token"):
        raise ChatGPTAuthError("The saved ChatGPT connection is incomplete; reconnect it.")
    if not _SCOPES.issubset(set(data.get("scopes") or [])):
        raise ChatGPTAuthError("This ChatGPT connection has not granted plan usage; reconnect and allow it.")
    return data


def _write(path: Path, data: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    fd, temp_name = tempfile.mkstemp(prefix=".chatgpt-", dir=str(path.parent))
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_name, path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    finally:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass


def profile_status(subject: str) -> dict:
    try:
        profile = _read(_path(subject))
    except ChatGPTAuthError:
        return {"connected": False}
    return {
        "connected": True,
        "email": str(profile.get("email") or ""),
        "sharing": True,
        "expires_at": int(profile.get("expires_at") or 0),
    }


@contextmanager
def _locked(subject: str):
    path = _path(subject)
    with _LOCAL_LOCK:
        lock_path = path.with_suffix(".lock")
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock_fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            yield path
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)


def _generation(path: Path) -> str:
    epoch = path.with_suffix('.epoch')
    try:
        value = json.loads(epoch.read_text())['generation']
        if not isinstance(value, str) or not value:
            raise ValueError('invalid epoch')
        return value
    except FileNotFoundError:
        value = str(uuid4())
        _write(epoch, {'generation': value})
        return value
    except (ValueError, KeyError, TypeError, OSError) as exc:
        raise ChatGPTAuthError('Could not read ChatGPT connection state; disconnect and retry.') from exc


def connection_generation(subject: str) -> str:
    with _locked(subject) as path:
        return _generation(path)


def save_connection(subject: str, expected: str, profile: dict) -> None:
    fields = {'subject', 'email', 'client_id', 'host_id', 'id_token', 'access_token', 'refresh_token', 'expires_at', 'scopes', 'saved_at'}
    if (not isinstance(profile, dict) or set(profile) != fields
            or any(not isinstance(profile[k], str) or len(profile[k]) > 32768 for k in fields - {'expires_at', 'scopes'})
            or type(profile['expires_at']) is not int or profile['expires_at'] < 0
            or not isinstance(profile['scopes'], list) or len(profile['scopes']) > 32
            or any(not isinstance(s, str) or len(s) > 128 for s in profile['scopes'])):
        raise ChatGPTAuthError('Invalid ChatGPT connection profile.')
    with _locked(subject) as path:
        if expected != _generation(path):
            raise ChatGPTAuthError('This sign-in was cancelled; start a new ChatGPT connection.')
        _write(path, profile)


def disconnect(subject: str) -> None:
    # Share the refresh lock so a delayed refresh cannot recreate deleted credentials.
    with _locked(subject) as path:
        _write(path.with_suffix('.epoch'), {'generation': str(uuid4())})
        path.unlink(missing_ok=True)


def refresh_profile(profile: dict) -> bool:
    """Update an authorized profile only when its access token needs refreshing."""
    expiry = int(profile.get("expires_at") or 0)
    if profile.get("access_token") and expiry > int(time.time()) + 120:
        return False
    form = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": profile["client_id"],
        "refresh_token": profile["refresh_token"],
        "resource": "https://api.openai.com/v1",
    }).encode()
    request = urllib.request.Request(
        _TOKEN_URL, data=form, method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            refreshed = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise ChatGPTAuthError(
            f"ChatGPT token refresh failed (HTTP {exc.code}); reconnect the account in Settings."
        ) from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise ChatGPTAuthError("ChatGPT token refresh could not reach OpenAI; retry shortly.") from exc
    token = refreshed.get("access_token")
    if not isinstance(token, str) or not token:
        raise ChatGPTAuthError("OpenAI did not return an access token; reconnect the account.")
    granted = set(str(refreshed.get("scope") or "").split())
    if granted and not _SCOPES.issubset(granted):
        raise ChatGPTAuthError("The refreshed ChatGPT token lacks plan usage permission; reconnect it.")
    profile["access_token"] = token
    profile["refresh_token"] = refreshed.get("refresh_token") or profile["refresh_token"]
    profile["expires_at"] = int(time.time()) + int(refreshed.get("expires_in") or 3600)
    if refreshed.get("id_token"):
        profile["id_token"] = refreshed["id_token"]
    if granted:
        profile["scopes"] = sorted(granted)
    return True


def access_token(subject: str) -> str:
    """Return a usable access token, refreshing and atomically rotating it when near expiry."""
    with _locked(subject) as path:
        profile = _read(path)
        if refresh_profile(profile):
            _write(path, profile)
        return str(profile["access_token"])
