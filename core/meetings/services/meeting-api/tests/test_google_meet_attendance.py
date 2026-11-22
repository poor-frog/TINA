import httpx
import pytest
from fastapi.testclient import TestClient

from meeting_api import create_app
from meeting_api.calendar_sync import attendance
from meeting_api.collector.fakes import InMemoryTranscriptStore


MEETING = {
    "platform": "google_meet", "native_meeting_id": "abc-defg-hij",
    "start_time": "2026-11-19T09:05:00Z", "end_time": "2026-11-19T09:30:00Z",
}
CONFIGS = [{"user_id": 7, "provider": "google", "google_refresh_token": "fake"}]
MATCH = {
    "name": "conferenceRecords/match", "startTime": "2026-11-19T09:00:00Z",
    "endTime": "2026-11-19T09:29:00Z",
}


def _google(monkeypatch, handler):
    real_client = httpx.AsyncClient

    async def access_token(*_):
        return "test-token", None

    monkeypatch.setattr(attendance, "_google_access_token", access_token)
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(
        transport=httpx.MockTransport(handler), **kwargs))


@pytest.mark.parametrize("other, retryable", [
    ([{**MATCH, "endTime": "2026-11-19T09:04:59Z"}], False),
    ([MATCH, {**MATCH, "name": "conferenceRecords/other"}], False),
    ([{**MATCH, "endTime": None}], True),
])
async def test_meet_requires_one_ended_conference_covering_admission(monkeypatch, other, retryable):
    def provider(request):
        assert request.url.path == "/v2/conferenceRecords"
        return httpx.Response(200, json={"conferenceRecords": other})

    _google(monkeypatch, provider)
    assert await attendance.lookup_google_meet_attendees(7, MEETING, CONFIGS) == (None, retryable)


def _field(address, account_id, source="PROFILE", *, verified=True, primary=True):
    return {"value": address, "metadata": {"verified": verified, "primary": primary,
                                         "source": {"type": source, "id": account_id}}}


async def test_meet_preserves_verified_addresses_when_another_lookup_is_throttled(monkeypatch):
    seen = set()

    def provider(request):
        path = request.url.path
        if path == "/v2/conferenceRecords":
            return httpx.Response(200, json={"conferenceRecords": [MATCH]})
        if path == "/v2/conferenceRecords/match/participants":
            return httpx.Response(200, json={"participants": [
                {"signedinUser": {"user": f"users/{account}", "displayName": "Same Name"}}
                for account in ("123", "456", "789")
            ] + [{"anonymousUser": {"displayName": "Same Name"}}]})
        assert request.url.host == "people.googleapis.com"
        assert request.url.params.get_list("sources") == ["READ_SOURCE_TYPE_PROFILE"]
        account = path.rsplit("/", 1)[-1]
        seen.add(account)
        if account == "456":
            return httpx.Response(429)
        addresses = [
            _field("contact@example.test", account, "CONTACT"),
            _field("unverified@example.test", account, verified=False),
            _field("other-account@example.test", "999"),
        ]
        if account == "123":
            addresses.append(_field("attendee@example.test", account, primary=False))
        return httpx.Response(200, json={"emailAddresses": addresses})

    _google(monkeypatch, provider)
    assert await attendance.lookup_google_meet_attendees(7, MEETING, CONFIGS) == (["attendee@example.test"], True)
    assert seen == {"123", "456", "789"}


def test_owner_participant_route_returns_verified_partial_result():
    store = InMemoryTranscriptStore()
    mid = store.seed_meeting(user_id=7, platform="google_meet", native_meeting_id="abc-defg-hij")

    async def lookup(uid, meeting):
        assert (uid, meeting["meeting_id"]) == (7, mid)
        return ["attendee@example.test"], True

    client = TestClient(create_app(transcript_store=store, attendee_email_lookup=lookup))
    url = f"/meetings/google_meet/abc-defg-hij/participants?meeting_id={mid}"
    assert client.get(url, headers={"x-user-id": "8"}).status_code == 404
    body = client.get(url, headers={"x-user-id": "7"}).json()
    assert body["observed_roster"] == "recorded" and body["attendance_retryable"] is True
    assert body["participants"] == [{"name": None, "email": "attendee@example.test", "source": "attendance"}]
