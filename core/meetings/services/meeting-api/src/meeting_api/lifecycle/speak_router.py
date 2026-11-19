"""Owner-scoped Speak commands published to an active bot's acts.v1 Redis channel."""
from __future__ import annotations

import json
import os
import hmac
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ..bot_spawn.ports import MeetingRepo
from .stop import leave_command_channel
from .stop_router import CommandPublisher, _SUPPORTED_PLATFORMS, _resolve_user_id
from .speech_status import PlaybackStore, SpeechConflict, TERMINAL


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=4000)
    voice: Optional[str] = Field(default=None, max_length=64)
    command_id: Optional[UUID] = None
    model_config = ConfigDict(extra="forbid")

    @field_validator("text")
    @classmethod
    def non_blank_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("text must not be blank")
        return value


class PlaybackReport(BaseModel):
    command_id: UUID
    meeting_id: int = Field(gt=0)
    session_uid: str = Field(min_length=1, max_length=128)
    state: str = Field(pattern=r"^(started|completed|failed|stopped)$")
    played_text: str | None = Field(default=None, max_length=4000)
    model_config = ConfigDict(extra="forbid")


def build_speak_router(repo: MeetingRepo, publisher: CommandPublisher, playback: PlaybackStore) -> APIRouter:
    router = APIRouter()

    async def operation(awaitable):
        try:
            return await awaitable
        except SpeechConflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, "Speech state is unavailable") from exc

    async def publish(meeting: dict, command: dict) -> None:
        try:
            listeners = await publisher.publish(
                leave_command_channel(meeting["id"]),
                json.dumps(command, ensure_ascii=False),
            )
        except Exception as exc:
            raise HTTPException(status_code=503, detail="Bot command channel is unavailable") from exc
        if listeners == 0:
            raise HTTPException(status_code=409, detail="Bot is not listening for commands")

    async def active_voice_bot(platform: str, native_meeting_id: str, user_id: int) -> dict:
        if platform not in _SUPPORTED_PLATFORMS:
            raise HTTPException(status_code=422, detail=f"unsupported platform '{platform}'")
        meeting = await repo.find_active(user_id, platform, native_meeting_id)
        if meeting is None:
            raise HTTPException(status_code=404, detail="No active meeting for this bot")
        if meeting.get("status") != "active":
            raise HTTPException(status_code=409, detail="Bot is not admitted to the meeting")
        return meeting

    @router.post("/bots/{platform}/{native_meeting_id}/speak")
    async def speak(
        platform: str,
        native_meeting_id: str,
        body: SpeakRequest,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        meeting = await active_voice_bot(platform, native_meeting_id, user_id)
        if not os.getenv("TTS_SERVICE_URL", "").strip():
            raise HTTPException(status_code=503, detail="TTS_SERVICE_URL is not configured")
        if not (meeting.get("data") or {}).get("voice_agent_enabled"):
            raise HTTPException(status_code=409, detail="Speak was not enabled when this bot started")
        command = {"action": "speak", "text": body.text, "voice": (body.voice or "").strip() or "auto"}
        if body.command_id:
            command_id = str(body.command_id)
            sessions = await repo.list_sessions(meeting_id=meeting["id"])
            if not sessions:
                raise HTTPException(409, "Bot session is unavailable")
            record, created = await operation(playback.begin(meeting["id"], command_id,
                sessions[-1], body.text, command["voice"]))
            if not created:
                return {"accepted": True, **playback.public(record)}
            command.update(action="speech_speak", command_id=command_id)
            try:
                await publish(meeting, command)
            except HTTPException:
                # Publication can be ambiguous: keep queued/room locked for explicit Stop.
                raise
            return {"accepted": True, **playback.public(record)}
        await publish(meeting, command)
        return {"accepted": True, "meeting_id": meeting["id"]}

    @router.delete("/bots/{platform}/{native_meeting_id}/speak")
    async def stop_speaking(
        platform: str,
        native_meeting_id: str,
        command_id: Optional[UUID] = None,
        x_user_id: Optional[str] = Header(default=None),
    ):
        user_id = _resolve_user_id(x_user_id)
        meeting = await active_voice_bot(platform, native_meeting_id, user_id)
        if not (meeting.get("data") or {}).get("voice_agent_enabled"):
            raise HTTPException(status_code=409, detail="Speak was not enabled when this bot started")
        if command_id:
            sessions = await repo.list_sessions(meeting_id=meeting["id"])
            if not sessions:
                raise HTTPException(409, "Bot session is unavailable")
            record = await operation(playback.cancel(meeting["id"], str(command_id), sessions[-1]))
            if record["state"] not in TERMINAL:
                await publish(meeting, {"action": "speech_stop", "command_id": str(command_id)})
            return {"accepted": True, **playback.public(record)}
        await publish(meeting, {"action": "speak_stop"})
        return {"accepted": True, "meeting_id": meeting["id"]}

    @router.get("/bots/{platform}/{native_meeting_id}/speak/{command_id}")
    async def speech_state(platform: str, native_meeting_id: str, command_id: UUID,
                           x_user_id: Optional[str] = Header(default=None)):
        user_id = _resolve_user_id(x_user_id)
        if platform not in _SUPPORTED_PLATFORMS:
            raise HTTPException(422, f"unsupported platform '{platform}'")
        # Reading a retained receipt must survive bot departure; the repository
        # still scopes this lookup to the authenticated meeting owner.
        meeting = await repo.find_latest(user_id, platform, native_meeting_id)
        if meeting is None:
            raise HTTPException(404, "No meeting for this bot")
        record = await operation(playback.get(meeting["id"], str(command_id)))
        if not record:
            raise HTTPException(404, "Unknown or expired speech command")
        return playback.public(record)

    @router.post("/bots/internal/callback/speech", include_in_schema=False)
    async def speech_callback(body: PlaybackReport, x_internal_secret: Optional[str] = Header(default=None)):
        expected = os.environ.get("INTERNAL_API_SECRET", "")
        if not expected or not hmac.compare_digest((x_internal_secret or "").encode(), expected.encode()):
            raise HTTPException(401, "Unauthorized")
        return playback.public(await operation(playback.report(body.meeting_id, str(body.command_id),
                                                               body.session_uid, body.state, played_text=body.played_text)))

    return router
