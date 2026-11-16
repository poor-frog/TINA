"""Encryption for OAuth refresh tokens stored in the identity-owned user document."""
import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken


def _fernet() -> Fernet:
    secret = os.environ.get("INTERNAL_API_SECRET", "")
    if len(secret) < 32:
        raise RuntimeError("INTERNAL_API_SECRET is not configured for calendar-token encryption")
    # The shared high-entropy secret is domain-separated so the derived key is not reused directly.
    key = base64.urlsafe_b64encode(
        hashlib.sha256(b"tina:google-calendar-refresh:v1\0" + secret.encode()).digest()
    )
    return Fernet(key)


def encrypt_google_refresh_token(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_google_refresh_token(value: str) -> str | None:
    try:
        return _fernet().decrypt(value.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeError, ValueError, RuntimeError):
        return None
