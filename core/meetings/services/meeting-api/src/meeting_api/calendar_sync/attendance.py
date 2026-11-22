"""Read the signed-in Google Meet roster and resolve emails by Google account ID."""
from __future__ import annotations

import asyncio
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

from .adapters import _google_access_token

_MAX_PARTICIPANTS = 500
_MAX_PAGES = 2
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
# shortcut: caps lookup at 500 participants; raise if TINA targets larger Meet rooms.
_EMAIL = re.compile(r'[^\s@<>;,:()\[\]"\\]+@[^\s@<>;,:()\[\]"\\]+')


class _ProviderUnavailable(Exception):
    def __init__(self, *, retryable: bool = True):
        self.retryable = retryable


def _time(value) -> datetime | None:
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _account_id(participant: dict) -> str | None:
    signed_in = participant.get("signedinUser")
    resource = signed_in.get("user") if isinstance(signed_in, dict) else None
    if not isinstance(resource, str) or not resource.startswith("users/"):
        return None
    account_id = resource.removeprefix("users/")
    return account_id if re.fullmatch(r"[0-9]{1,64}", account_id) else None


def _email(person: dict, account_id: str) -> str | None:
    addresses = person.get("emailAddresses")
    if not isinstance(addresses, list):
        return None
    values, primary = set(), set()
    for entry in addresses:
        if not isinstance(entry, dict):
            continue
        metadata = entry.get("metadata")
        source = metadata.get("source") if isinstance(metadata, dict) else None
        if (not isinstance(source, dict) or source.get("id") != account_id
                or source.get("type") not in ("ACCOUNT", "PROFILE", "DOMAIN_PROFILE")
                or metadata.get("verified") is not True):
            continue
        value = entry.get("value")
        address = value.strip().lower() if isinstance(value, str) else ""
        if len(address) <= 254 and _EMAIL.fullmatch(address):
            values.add(address)
            if metadata.get("primary") is True:
                primary.add(address)
    preferred = primary or values
    return next(iter(preferred)) if len(preferred) == 1 else None


async def _get_json(client, url: str, token: str, params=None) -> dict | None:
    try:
        response = await client.get(
            url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            params=params,
        )
    except Exception as exc:
        raise _ProviderUnavailable from exc
    if response.status_code == 404:
        return None
    if response.status_code != 200:
        raise _ProviderUnavailable(retryable=response.status_code in (408, 429) or response.status_code >= 500)
    if len(response.content) > _MAX_RESPONSE_BYTES:
        raise _ProviderUnavailable
    try:
        body = response.json()
    except Exception as exc:
        raise _ProviderUnavailable from exc
    return body if isinstance(body, dict) else None


async def _conference(client, token: str, code: str, start: datetime) -> str | None:
    lower = start - timedelta(hours=3)
    filter_value = (f'space.meeting_code = "{code}" AND '
                    f'start_time>="{lower.isoformat().replace("+00:00", "Z")}" AND '
                    f'start_time<="{start.isoformat().replace("+00:00", "Z")}"')
    records, page_token = [], None
    for _ in range(_MAX_PAGES):
        params = [("pageSize", "100"), ("filter", filter_value)]
        if page_token:
            params.append(("pageToken", page_token))
        body = await _get_json(client, "https://meet.googleapis.com/v2/conferenceRecords", token, params)
        if body is None or not isinstance(body.get("conferenceRecords", []), list):
            return None
        records.extend(body.get("conferenceRecords", []))
        page_token = body.get("nextPageToken")
        if page_token is not None and not isinstance(page_token, str):
            raise _ProviderUnavailable
        if not page_token:
            break
    if page_token:
        return None

    matching = {}
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("name"), str):
            continue
        record_start = _time(record.get("startTime"))
        if record_start is None or record_start > start:
            continue
        end = record.get("endTime")
        record_end = _time(end)
        # The conference must contain the bot's actual admission time.
        if end is None or (record_end is not None and start < record_end):
            if not re.fullmatch(r"conferenceRecords/[A-Za-z0-9_-]+", record["name"]):
                return None
            matching[record["name"]] = record_end
    if len(matching) != 1:
        return None
    name, record_end = next(iter(matching.items()))
    if record_end is None:
        raise _ProviderUnavailable
    return name


async def _participants(client, token: str, record_name: str) -> list[dict] | None:
    people, page_token = [], None
    for _ in range(_MAX_PAGES):
        params = [("pageSize", "250")]
        if page_token:
            params.append(("pageToken", page_token))
        body = await _get_json(
            client, f"https://meet.googleapis.com/v2/{quote(record_name, safe='/')}/participants",
            token, params,
        )
        if body is None or not isinstance(body.get("participants", []), list):
            return None
        people.extend(body.get("participants", []))
        if len(people) > _MAX_PARTICIPANTS:
            return None
        page_token = body.get("nextPageToken")
        if page_token is not None and not isinstance(page_token, str):
            raise _ProviderUnavailable
        if not page_token:
            return people
    return None


async def _person_email(client, token: str, account_id: str) -> str | None:
    params = [("personFields", "emailAddresses"), ("sources", "READ_SOURCE_TYPE_PROFILE")]
    person = await _get_json(
        client, f"https://people.googleapis.com/v1/people/{quote(account_id, safe='')}",
        token, params,
    )
    return _email(person, account_id) if person else None


async def lookup_google_meet_attendees(user_id: int, meeting: dict,
                                       configs: list[dict]) -> tuple[list[str] | None, bool]:
    """Return verified attendance emails (None without a roster) and whether to retry.

    The event-linked Google grant is tried first; other Google grants for this same owner are a
    valid fallback for link-only meetings. Meet's records list is organizer-scoped, so a non-host
    grant naturally returns no matching record.
    """
    if meeting.get("platform") != "google_meet":
        return None, False
    code = meeting.get("native_meeting_id")
    start = _time(meeting.get("start_time"))
    end = _time(meeting.get("end_time"))
    if (not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9-]{5,64}", code)
            or start is None or end is None or end <= start):
        return None, False

    sources = meeting.get("calendar_sources")
    source_ids = {str(item.get("id")) for item in sources if isinstance(item, dict) and item.get("id")} \
        if isinstance(sources, list) else set()
    candidates = [cfg for cfg in configs or []
                  if str(cfg.get("user_id")) == str(user_id) and cfg.get("provider") == "google"
                  and not cfg.get("deleted") and not cfg.get("paused")
                  and isinstance(cfg.get("google_refresh_token"), str)]
    candidates.sort(key=lambda cfg: str(cfg.get("calendar_id")) not in source_ids)
    unique, seen = [], set()
    for config in candidates:
        refresh_token = config["google_refresh_token"]
        if refresh_token not in seen:
            seen.add(refresh_token)
            unique.append(config)
    if not unique:
        return None, False

    import httpx

    emails = None
    retryable = False
    try:
        # Leave time for Identity discovery and the gateway's 30-second request deadline.
        async with asyncio.timeout(20), httpx.AsyncClient(timeout=8.0) as client:
            for config in unique:
                token, _ = await _google_access_token(config, client)
                if not token:
                    continue
                try:
                    record_name = await _conference(client, token, code, start)
                    participants = await _participants(client, token, record_name) if record_name else None
                except _ProviderUnavailable as exc:
                    retryable |= exc.retryable
                    continue
                if participants is None:
                    continue
                account_ids = list(dict.fromkeys(
                    account_id for item in participants if isinstance(item, dict)
                    if (account_id := _account_id(item))
                ))
                semaphore = asyncio.Semaphore(8)
                emails = {}
                pending = False

                async def resolve(account_id: str):
                    nonlocal pending
                    try:
                        async with semaphore:
                            address = await _person_email(client, token, account_id)
                    except _ProviderUnavailable as exc:
                        pending |= exc.retryable
                    else:
                        if address:
                            emails[account_id] = address

                await asyncio.gather(*(resolve(account_id) for account_id in account_ids))
                return list(dict.fromkeys(emails.values())), pending
    except TimeoutError:
        retryable = True
    return (list(dict.fromkeys(emails.values())) if emails is not None else None), retryable
