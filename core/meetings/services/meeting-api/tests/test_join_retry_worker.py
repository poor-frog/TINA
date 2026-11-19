from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from meeting_api import create_app
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.service import request_bot
from meeting_api.bot_spawn.ports import DuplicateMeeting, MeetingStopped
from meeting_api.bot_spawn.join_retry import join_retry_tick


def test_due_retry_reuses_the_same_meeting_and_publishes_status():
    async def run():
        now = datetime(2026, 11, 17, tzinfo=timezone.utc)
        repo = InMemoryMeetingRepo()
        repo._meetings[9] = {
            "id": 9, "user_id": 7, "platform": "google_meet",
            "native_meeting_id": "abc-defg-hij", "status": "failed",
            "data": {
                "constructed_meeting_url": "https://meet.google.com/abc-defg-hij",
                "auto_retry": {"state": "scheduled", "attempt": 1, "max_attempts": 3,
                               "next_at": (now - timedelta(seconds=1)).isoformat()},
                "_auto_retry_request": {"bot_name": "TINA", "max_concurrent": 2},
            },
        }
        published = []

        async def publish_status(**frame):
            published.append(frame)

        with patch("meeting_api.bot_spawn.join_retry.request_bot", new=AsyncMock(
            return_value={"id": 9, "status": "requested"}
        )) as spawn:
            result = await join_retry_tick(repo, object(), now=now, publish_status=publish_status)

        assert result == {"due": 1, "sent": 1, "superseded": 0, "failed": 0}
        assert spawn.await_args.kwargs["expected_meeting_id"] == 9
        assert spawn.await_args.kwargs["auto_retry_attempt"] == 2
        assert spawn.await_args.kwargs["continue_meeting"] is True
        assert spawn.await_args.kwargs["meeting_url"] == "https://meet.google.com/abc-defg-hij"
        assert published[0]["status"] == "requested"

    asyncio.run(run())


@pytest.fixture
async def retry_room(monkeypatch):
    monkeypatch.setattr('meeting_api.bot_spawn.service._fetch_bot_context', AsyncMock(return_value={}))
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    meeting = await request_bot(repo, runtime, user_id=7, platform='google_meet',
        native_meeting_id='abc-defg-hij', transcribe_enabled=False, token_secret='test-retry')
    app = create_app(meeting_repo=repo, runtime=runtime)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        yield repo, runtime, meeting['id'], client


async def fail_join(repo, mid, client):
    session = repo.sessions[-1]['session_uid']
    for status in ['joining', 'failed']:
        event = {'connection_id': session, 'status': status, 'timestamp': datetime.now(timezone.utc).isoformat()}
        if status == 'failed':
            event.update(completion_reason='join_failure', reason='transient network error')
        response = await client.post('/bots/internal/callback/lifecycle', json=event)
        assert response.status_code == 200, response.text
    return event


async def test_callback_worker_and_restart_keep_three_bounded_sessions(retry_room):
    repo, runtime, mid, client = retry_room
    for attempt in range(1, 4):
        event = await fail_join(repo, mid, client)
        retry = repo._meetings[mid]['data']['auto_retry']
        assert retry['attempt'] == attempt
        # A callback replay must not postpone or add another retry.
        await client.post('/bots/internal/callback/lifecycle', json=event)
        assert repo._meetings[mid]['data']['auto_retry'] == retry
        if attempt == 3:
            assert retry['state'] == 'exhausted'
            break
        assert retry['state'] == 'scheduled'
        due = datetime.fromisoformat(retry['next_at'])
        before = await join_retry_tick(repo, runtime, now=due-timedelta(seconds=1), token_secret='test-retry')
        assert before['due'] == 0
        # Fresh worker invocation has no in-memory scheduler state.
        result = await join_retry_tick(repo, runtime, now=due, token_secret='test-retry')
        assert result['sent'] == 1
        assert len(repo._meetings) == 1
    assert len(repo.sessions) == 3
    assert (await join_retry_tick(repo, runtime, now=datetime.now(timezone.utc)+timedelta(days=1)))['due'] == 0


async def test_cancel_pending_retry_is_owner_scoped_and_prevents_respawn(retry_room):
    repo, runtime, mid, client = retry_room
    await fail_join(repo, mid, client)
    url = '/bots/google_meet/abc-defg-hij'
    assert (await client.delete(url, headers={'x-user-id':'8'})).status_code == 404
    assert repo._meetings[mid]['data']['auto_retry']['state'] == 'scheduled'
    result = await client.delete(url, headers={'x-user-id':'7'})
    assert result.status_code == 200
    assert result.json()['cancelled'] == [mid]
    assert repo._meetings[mid]['data']['stop_requested'] is True
    assert repo._meetings[mid]['data']['auto_retry']['state'] == 'cancelled'
    assert (await join_retry_tick(repo, runtime, now=datetime.now(timezone.utc)+timedelta(days=1)))['due'] == 0
    # A worker that read the old candidate before Stop cannot reopen it afterwards.
    with pytest.raises(MeetingStopped):
        await repo.reopen_meeting(meeting_id=mid, data_patch={'auto_retry':{'attempt':2}})
    assert len(repo.sessions) == 1


async def test_deleted_retry_never_falls_back_to_new_meeting(retry_room):
    repo, runtime, mid, client = retry_room
    await fail_join(repo, mid, client)
    repo._meetings[mid]['data']['artifact_deletion'] = {'state':'completed'}
    result = await join_retry_tick(repo, runtime, now=datetime.now(timezone.utc)+timedelta(days=1), token_secret='test-retry')
    assert result['sent'] == 0
    assert len(repo._meetings) == len(repo.sessions) == 1


async def test_retry_reopen_rechecks_eligibility_under_lock(retry_room):
    repo, runtime, mid, client = retry_room
    await fail_join(repo, mid, client)
    repo._meetings[mid]['data']['auto_retry']['state'] = 'cancelled'
    with pytest.raises(DuplicateMeeting):
        await repo.reopen_meeting(meeting_id=mid, data_patch={'auto_retry':{'attempt':2}})
    assert repo._meetings[mid]['status'] == 'failed'


@pytest.mark.parametrize('interruption', ['cancel', 'delete'])
async def test_retry_cannot_reopen_after_racing_cancel_or_deletion(retry_room, monkeypatch, interruption):
    repo, runtime, mid, client = retry_room
    await fail_join(repo, mid, client)
    reopen = repo.reopen_meeting

    async def interrupted_reopen(**kwargs):
        if interruption == 'cancel':
            await repo.cancel_join_retries(7, 'google_meet', 'abc-defg-hij')
        else:
            repo._meetings[mid]['data']['artifact_deletion'] = {'state': 'pending'}
        return await reopen(**kwargs)

    monkeypatch.setattr(repo, 'reopen_meeting', interrupted_reopen)
    result = await join_retry_tick(repo, runtime, now=datetime.now(timezone.utc)+timedelta(days=1), token_secret='test-retry')
    assert result['sent'] == 0
    assert len(repo._meetings) == len(repo.sessions) == 1
    if interruption == 'cancel':
        assert repo._meetings[mid]['data']['auto_retry']['state'] == 'cancelled'
