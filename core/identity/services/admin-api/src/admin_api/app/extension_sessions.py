"""Google account bindings and revocable browser extension sessions."""

import base64
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..schema.models import ExtensionSession, GoogleLogin, User
from .db import get_db

_TOKEN_PATTERN = r"^[A-Za-z0-9_-]{43}$"
_EXTENSION_PATTERN = r"^[a-p]{32}$"
_CODE_TTL = timedelta(minutes=3)
_ACCESS_TTL = timedelta(minutes=15)
_SESSION_TTL = timedelta(days=7)


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _challenge(verifier: str) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")


class GoogleBinding(BaseModel):
    subject: str = Field(min_length=1, max_length=255)
    user_id: int | None = Field(default=None, gt=0)


class ExtensionCode(BaseModel):
    subject: str = Field(min_length=1, max_length=255)
    user_id: int = Field(gt=0)
    extension_id: str = Field(pattern=_EXTENSION_PATTERN)
    challenge: str = Field(pattern=_TOKEN_PATTERN)


class ExtensionCredential(BaseModel):
    action: Literal["exchange", "refresh", "logout"]
    extension_id: str = Field(pattern=_EXTENSION_PATTERN)
    credential: str = Field(pattern=_TOKEN_PATTERN)
    verifier: str | None = Field(default=None, pattern=_TOKEN_PATTERN)


def register(app: FastAPI, authenticate) -> None:
    @app.post("/internal/google-login", dependencies=[Depends(authenticate)], include_in_schema=False)
    async def google_login(body: GoogleBinding, db: AsyncSession = Depends(get_db)):
        binding = await db.get(GoogleLogin, body.subject)
        if binding is None and body.user_id is not None:
            if await db.get(User, body.user_id) is None:
                raise HTTPException(404, "Account unavailable")
            await db.execute(insert(GoogleLogin).values(subject=body.subject, user_id=body.user_id).on_conflict_do_nothing())
            await db.commit()
            binding = await db.get(GoogleLogin, body.subject)
            if binding is None or binding.user_id != body.user_id:
                raise HTTPException(409, "Google account already linked")
        if binding is None:
            raise HTTPException(404, "Google account not linked")
        if body.user_id is not None and binding.user_id != body.user_id:
            raise HTTPException(409, "Google account already linked")
        user = await db.get(User, binding.user_id)
        if user is None:
            raise HTTPException(404, "Account unavailable")
        return {"id": user.id, "email": user.email, "name": user.name}

    @app.post("/internal/extension/code", dependencies=[Depends(authenticate)], include_in_schema=False)
    async def extension_code(body: ExtensionCode, db: AsyncSession = Depends(get_db)):
        binding = await db.get(GoogleLogin, body.subject)
        if binding is None or binding.user_id != body.user_id:
            raise HTTPException(403, "Google session does not match the Terminal account")
        now = datetime.utcnow()
        await db.execute(delete(ExtensionSession).where(ExtensionSession.expires_at <= now))
        code = secrets.token_urlsafe(32)
        db.add(ExtensionSession(id=digest(code), user_id=body.user_id, extension_id=body.extension_id,
                                challenge=body.challenge, expires_at=now + _CODE_TTL))
        await db.commit()
        return {"code": code}

    @app.post("/internal/extension/session", dependencies=[Depends(authenticate)], include_in_schema=False)
    async def extension_session(body: ExtensionCredential, db: AsyncSession = Depends(get_db)):
        predicate = (ExtensionSession.id if body.action == "exchange" else ExtensionSession.refresh_digest)
        session = (await db.execute(select(ExtensionSession).where(
            predicate == digest(body.credential), ExtensionSession.extension_id == body.extension_id,
        ).with_for_update())).scalar_one_or_none()
        if body.action == "logout":
            if session:
                await db.delete(session)
                await db.commit()
            return {"ok": True}
        now = datetime.utcnow()
        if not session or session.expires_at <= now:
            raise HTTPException(401, "Extension session expired")
        if body.action == "exchange":
            if not session.challenge or not body.verifier or not hmac.compare_digest(session.challenge, _challenge(body.verifier)):
                raise HTTPException(401, "Invalid authorization code")
            session.challenge = None
            session.expires_at = now + _SESSION_TTL
        user = await db.get(User, session.user_id)
        if not user:
            raise HTTPException(401, "Account unavailable")
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        session.access_digest, session.refresh_digest = digest(access), digest(refresh)
        session.access_expires_at = min(now + _ACCESS_TTL, session.expires_at)
        response = {"access_token": access, "refresh_token": refresh,
                    "expires_in": int((session.access_expires_at - now).total_seconds()),
                    "user": {"id": str(user.id), "email": user.email}}
        await db.commit()
        return response
