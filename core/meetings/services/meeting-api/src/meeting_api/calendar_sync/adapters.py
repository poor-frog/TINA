"""Production I/O for calendar sync — the ICS fetch (SSRF-pinned), Google Calendar API, and config discovery.

``fetch_ics`` dereferences a USER-SUPPLIED URL server-side, so it MUST ride the same pinned
transport the webhook sender uses (``webhooks/ssrf.build_pinned_transport``): the host is
resolved + validated at connect time and the socket dials the validated IP — a DNS-rebinding
flip can never turn the poller into an internal-network probe. Size-capped: a feed larger than
``MAX_ICS_BYTES`` is refused, not parsed.

``fetch_configs`` asks admin-api's internal edge (X-Internal-Secret) which users have a feed
connected — the secret URL crosses only this internal hop.
"""
from __future__ import annotations

import hashlib
import os
import time
from datetime import datetime
from typing import Optional
from urllib.parse import quote

MAX_ICS_BYTES = 2 * 1024 * 1024  # 2 MB — a personal calendar feed is KBs; refuse anything huge
MAX_GOOGLE_CALENDAR_EVENTS = 10_000
MAX_GOOGLE_CALENDAR_PAGE_BYTES = 8 * 1024 * 1024
MAX_GOOGLE_CALENDAR_TOTAL_BYTES = 16 * 1024 * 1024
_GOOGLE_ACCESS_TOKENS: dict[str, tuple[float, str]] = {}


def build_ics_client(*, timeout_s: float = 15.0):
    """A pinned httpx client for ICS fetches — the ONE place the transport is configured.

    A sweep that reuses a single client across a tick's feeds keeps connection pooling and TLS
    handshakes amortized; ``fetch_ics`` builds a per-call one when no client is passed.
    """
    import httpx

    from ..webhooks.ssrf import build_pinned_transport

    return httpx.AsyncClient(
        timeout=timeout_s, transport=build_pinned_transport(), follow_redirects=False,
    )


async def fetch_ics(url: str, *, timeout_s: float = 15.0,
                    client=None) -> tuple[Optional[str], Optional[str]]:
    """GET the ICS feed over the SSRF-pinned transport → ``(feed_text, None)`` on success or
    ``(None, human_reason)`` on any failure. The reason is USER-FACING (it becomes the feed's
    ``last_error`` and is shown in the terminal's calendar panel), so it names the actual
    problem — an HTML page instead of a feed, a bad status, oversize — never a stack trace.

    ``client`` (optional) is a caller-owned pinned client — pass one to share a connection pool
    across a sweep; the caller owns its lifetime."""
    try:
        if client is not None:
            resp = await client.get(url)
        else:
            async with build_ics_client(timeout_s=timeout_s) as owned:
                resp = await owned.get(url)
        if resp.status_code in (301, 302, 303, 307, 308):
            return None, "the URL redirects — paste the final feed URL (Google: the 'Secret address in iCal format')"
        if resp.status_code != 200:
            return None, f"the URL answered HTTP {resp.status_code}"
        if len(resp.content) > MAX_ICS_BYTES:
            return None, "the feed is too large (over 2 MB)"
        text = resp.text
        head = text.lstrip()[:200].lower()
        if head.startswith("<") or "<html" in head:
            return None, ("the URL returns a web page, not a calendar feed — in Google Calendar use "
                          "Settings → Integrate calendar → 'Secret address in iCal format' (ends in .ics)")
        if "begin:vcalendar" not in head:
            return None, "the URL doesn't return an ICS calendar (no BEGIN:VCALENDAR)"
        return text, None
    except Exception:
        return None, "couldn't reach the URL (unreachable, timed out, or a blocked/internal address)"


async def fetch_configs(admin_api_url: str, internal_secret: str,
                        *, timeout_s: float = 10.0) -> Optional[list[dict]]:
    """Calendar connection configs from admin-api's internal calendar-configs edge, or
    ``None`` when identity is unreachable (the sweep skips the tick — fail-closed, not fail-silent)."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(
                f"{admin_api_url.rstrip('/')}/internal/calendar-configs",
                headers={"X-Internal-Secret": internal_secret},
            )
        if resp.status_code != 200:
            return None
        body = resp.json()
        configs = body.get("configs") if isinstance(body, dict) else None
        return configs if isinstance(configs, list) else None
    except Exception:
        return None


async def _google_access_token(config: dict, client) -> tuple[str | None, str | None, bool]:
    """Return the access token, a sanitized error, and whether the error can be retried."""
    refresh_token = config.get("google_refresh_token")
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET", "")
    if not all(isinstance(value, str) and value for value in (refresh_token, client_id, client_secret)):
        return None, "Google Calendar is not configured; reconnect the calendar or configure OAuth.", False
    cache_key = hashlib.sha256(refresh_token.encode()).hexdigest()
    cached = _GOOGLE_ACCESS_TOKENS.get(cache_key)
    if cached and cached[0] > time.monotonic() + 60:
        return cached[1], None, False
    try:
        response = await client.post(
            "https://oauth2.googleapis.com/token",
            data={"client_id": client_id, "client_secret": client_secret,
                  "refresh_token": refresh_token, "grant_type": "refresh_token"},
        )
        status = response.status_code
        if status in (400, 401, 403):
            return None, "Google Calendar permission expired; reconnect the Google account.", False
        if status != 200:
            return None, f"Google token refresh returned HTTP {status}.", status in (408, 429) or status >= 500
        payload = response.json()
        token = payload.get("access_token") if isinstance(payload, dict) else None
        expires_in = payload.get("expires_in", 3600) if isinstance(payload, dict) else 3600
        if not isinstance(token, str) or not token or type(expires_in) not in (int, float):
            return None, "Google token refresh returned an invalid response.", True
        _GOOGLE_ACCESS_TOKENS[cache_key] = (time.monotonic() + max(60, float(expires_in)), token)
        if len(_GOOGLE_ACCESS_TOKENS) > 1024:
            expired = [key for key, (expiry, _) in _GOOGLE_ACCESS_TOKENS.items()
                       if expiry <= time.monotonic()]
            for key in expired:
                _GOOGLE_ACCESS_TOKENS.pop(key, None)
            while len(_GOOGLE_ACCESS_TOKENS) > 1024:
                _GOOGLE_ACCESS_TOKENS.pop(next(iter(_GOOGLE_ACCESS_TOKENS)))
        return token, None, False
    except Exception:
        return None, "Could not refresh Google Calendar access; reconnect the account if this continues.", True


async def fetch_google_events(config: dict, *, now: datetime, client=None):
    """Fetch a complete bounded upcoming-event snapshot for one Google calendar.

    The existing ICS reconciliation expects a full snapshot so it can retire cancelled or removed
    meetings safely. API failures therefore return no snapshot; they never look like an empty feed.
    """
    from .service import DEFAULT_HORIZON_DAYS, DEFAULT_LOOKBACK_S, parse_google_events
    from datetime import timedelta, timezone
    import json

    if client is None:
        async with build_ics_client() as owned:
            return await fetch_google_events(config, now=now, client=owned)
    calendar_id = config.get("google_calendar_id")
    if not isinstance(calendar_id, str) or not calendar_id or len(calendar_id) > 512:
        return None, "Google Calendar connection is missing its calendar id."
    token, error, _ = await _google_access_token(config, client)
    if error:
        return None, error

    moment = now.astimezone(timezone.utc)
    params = {
        "timeMin": (moment - timedelta(seconds=DEFAULT_LOOKBACK_S)).isoformat().replace("+00:00", "Z"),
        "timeMax": (moment + timedelta(days=DEFAULT_HORIZON_DAYS)).isoformat().replace("+00:00", "Z"),
        "singleEvents": "true",
        "showDeleted": "true",
        "orderBy": "startTime",
        "maxResults": "2500",
        "conferenceDataVersion": "1",
            "fields": ("items(id,recurringEventId,status,summary,description,location,start,end,updated,"
                   "attendees(email,displayName,responseStatus,resource),hangoutLink,"
                   "conferenceData(entryPoints(entryPointType,uri))),nextPageToken"),
    }
    url = "https://www.googleapis.com/calendar/v3/calendars/" + quote(calendar_id, safe="") + "/events"
    items: list[dict] = []
    page_token = None
    pages = 0
    total_bytes = 0
    try:
        while True:
            page_params = params | ({"pageToken": page_token} if page_token else {})
            async with client.stream("GET", url, params=page_params,
                                     headers={"Authorization": f"Bearer {token}"}) as response:
                if response.status_code != 200:
                    if response.status_code in (401, 403):
                        _GOOGLE_ACCESS_TOKENS.pop(
                            hashlib.sha256(config["google_refresh_token"].encode()).hexdigest(), None,
                        )
                        return None, "Google Calendar rejected access; reconnect the Google account."
                    if response.status_code == 429:
                        return None, "Google Calendar rate limit reached; TINA will retry later."
                    return None, f"Google Calendar API returned HTTP {response.status_code}."
                raw = bytearray()
                async for chunk in response.aiter_bytes():
                    raw.extend(chunk)
                    if len(raw) > MAX_GOOGLE_CALENDAR_PAGE_BYTES:
                        return None, "Google Calendar page exceeded TINA's import size limit."
            total_bytes += len(raw)
            if total_bytes > MAX_GOOGLE_CALENDAR_TOTAL_BYTES:
                return None, "Google Calendar exceeded TINA's import size limit."
            body = json.loads(raw)
            page_items = body.get("items") if isinstance(body, dict) else None
            if not isinstance(page_items, list):
                return None, "Google Calendar returned an invalid event list."
            items.extend(item for item in page_items if isinstance(item, dict))
            if len(items) > MAX_GOOGLE_CALENDAR_EVENTS:
                return None, "Google Calendar has too many upcoming events for one sync pass."
            page_token = body.get("nextPageToken")
            pages += 1
            if not page_token:
                break
            if pages >= 8:
                return None, "Google Calendar has too many pages for one sync pass."
        return parse_google_events(items, now=moment, time_zone=config.get("google_time_zone")), None
    except Exception:
        return None, "Could not read Google Calendar events; TINA will retry later."
