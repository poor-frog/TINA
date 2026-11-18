"""Run bounded retries recorded on failed meeting rows.

The row is the durable queue, so retries survive meeting-api restarts without relying on the
in-memory scheduling harness in ``meeting_api.scheduling``.
"""
from __future__ import annotations

import logging
from typing import Any, Awaitable, Callable, Optional

from .ports import MeetingStopped
from .service import DuplicateMeeting, request_bot

log = logging.getLogger("meeting_api.bot_spawn.join_retry")


async def _publish(publish_status, row, status, retry_state):
    if publish_status is None:
        return
    try:
        await publish_status(
            user_id=row["user_id"], meeting_id=row["id"],
            native_id=row.get("native_meeting_id") or row.get("platform_specific_id"),
            status=status, when=None, auto_retry=retry_state,
        )
    except Exception:
        log.exception("could not publish automatic bot retry status for meeting %s", row["id"])


async def join_retry_tick(
    repo: Any,
    runtime: Any,
    *,
    authority: Any = None,
    publish_status: Optional[Callable[..., Awaitable[None]]] = None,
    token_secret: Optional[str] = None,
    redis_url: Optional[str] = None,
    meeting_api_url: Optional[str] = None,
    internal_secret: Optional[str] = None,
    now: Any = None,
) -> dict[str, int]:
    """Dispatch due retries once; the production caller wraps this tick in its PG single-flight lock."""
    from datetime import datetime, timezone

    moment = now or datetime.now(timezone.utc)
    rows = await repo.list_due_join_retries(now=moment)
    result = {"due": len(rows), "sent": 0, "superseded": 0, "failed": 0}
    for row in rows:
        data = row.get("data") if isinstance(row.get("data"), dict) else {}
        retry = data.get("auto_retry") if isinstance(data.get("auto_retry"), dict) else {}
        request = data.get("_auto_retry_request")
        attempt = retry.get("attempt")
        if not isinstance(request, dict) or type(attempt) is not int or attempt < 1:
            await repo.merge_meeting_data(row["id"], {"auto_retry": {
                "state": "failed", "attempt": attempt if type(attempt) is int else 1,
                "max_attempts": retry.get("max_attempts", 3),
            }})
            await _publish(publish_status, row, "failed", {
                "state": "failed", "attempt": attempt if type(attempt) is int else 1,
                "max_attempts": retry.get("max_attempts", 3),
            })
            result["failed"] += 1
            continue

        try:
            meeting = await request_bot(
                repo,
                runtime,
                authority=authority,
                user_id=row["user_id"],
                platform=row["platform"],
                native_meeting_id=row.get("native_meeting_id") or row.get("platform_specific_id"),
                meeting_url=data.get("constructed_meeting_url"),
                continue_meeting=True,
                expected_meeting_id=row["id"],
                auto_retry_attempt=attempt + 1,
                token_secret=token_secret,
                redis_url=redis_url,
                meeting_api_url=meeting_api_url,
                internal_secret=internal_secret,
                **request,
            )
        except DuplicateMeeting:
            fresh = await repo.get_meeting(row["id"])
            if (not fresh or fresh.get("status") != "failed"
                    or ((fresh.get("data") or {}).get("auto_retry") or {}).get("state") != "scheduled"):
                result["superseded"] += 1
                continue
            state = dict(retry, state="superseded")
            state.pop("next_at", None)
            await repo.merge_meeting_data(row["id"], {"auto_retry": state})
            await _publish(publish_status, row, "failed", state)
            result["superseded"] += 1
            continue
        except MeetingStopped:
            fresh = await repo.get_meeting(row["id"])
            if not fresh or ((fresh.get("data") or {}).get("auto_retry") or {}).get("state") == "cancelled":
                result["superseded"] += 1
                continue
            state = dict(retry, state="cancelled")
            state.pop("next_at", None)
            await repo.merge_meeting_data(row["id"], {"auto_retry": state})
            await _publish(publish_status, row, "failed", state)
            result["superseded"] += 1
            continue
        except Exception as error:  # noqa: BLE001 — a failed retry remains visible and manual-sendable
            state = dict(retry, state="failed", last_error=type(error).__name__)
            state.pop("next_at", None)
            try:
                await repo.merge_meeting_data(row["id"], {"auto_retry": state})
            except Exception:
                log.exception("could not persist failed bot retry state for meeting %s", row["id"])
            await _publish(publish_status, row, "failed", state)
            log.warning("automatic bot retry failed for meeting %s (%s)", row["id"], type(error).__name__)
            result["failed"] += 1
            continue

        result["sent"] += 1
        await _publish(
            publish_status, row, meeting.get("status", "requested"),
            (meeting.get("data") or {}).get("auto_retry"),
        )
    return result
