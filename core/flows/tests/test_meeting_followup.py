from dataclasses import replace
from urllib.parse import parse_qs, urlsplit

import pytest
from flows import Done, StepError
from test_link_loop import FakeChannel, _ctx


@pytest.fixture
def world(registry, monkeypatch):
    # Resolve modules after the cold-start test clears flows_steps from sys.modules.
    from flows_steps import common, mailtext, meeting, notify

    reg, channel = registry, FakeChannel()
    monkeypatch.setattr(notify, "channel", lambda: channel)
    row = {"id": 41, "data": {"title": "Họp dự án", "attendees": [
        {"email": "Anna@bank.test"}, {"email": "ben@outside.test"},
        {"email": "BEN@outside.test"}, {"email": "declined@bank.test", "partstat": "DECLINED"},
        {"email": "invalid\nBcc: injected@bank.test"}, {"email": "tina@bank.test"},
    ]}}
    writes, shares = [], []
    monkeypatch.setattr(meeting, "meeting_row", lambda *_: row)
    monkeypatch.setattr(common, "setting", lambda *_: True)
    monkeypatch.setattr(common, "user_api_key", lambda *_: "test-key")
    monkeypatch.setenv("TINA_MAIL_ADDR", "tina@bank.test")
    monkeypatch.setenv("TINA_UI_URL", "https://app.test")
    monkeypatch.setenv("TINA_FLOWS_ATTENDEE_DOMAINS", "outside.test")
    monkeypatch.setattr(mailtext, "ws_file", lambda *_: None)

    def http(method, url, headers, body=None):
        if method == "GET" and url.endswith("/admin/users/7"):
            return 200, {"id": 7, "email": "anna@bank.test"}
        assert method == "POST" and url.endswith("/meetings/41/annotate")
        writes.append(body)
        return 200, {}

    def mint(uid, mid, address, **kwargs):
        assert (uid, mid, kwargs) == ("7", 41, {"include_recordings": True})
        shares.append(address)
        return "41.recipient-bound-secret"

    monkeypatch.setattr(common, "http", http)
    monkeypatch.setattr(meeting, "mint_transcript_share", mint)
    ctx = _ctx({"uid": "7", "meeting_id": "41", "native": "abc-defg-hij"},
               {"process_meeting": {"report": "Quyết định: phát hành vào thứ Sáu."}})
    return reg, channel, ctx, writes, shares


def test_allowed_emails_get_thanks_and_two_working_meeting_links(world):
    reg, channel, ctx, writes, shares = world
    result = reg.steps["email_meeting_followup"](ctx)
    assert isinstance(result, Done) and result.result["sent"] == 2
    assert [m["to"] for m in channel.sent] == ["anna@bank.test", "ben@outside.test"]
    assert shares == ["ben@outside.test"]
    assert writes == [{"summary": ctx.prior["process_meeting"]["report"]}]
    for message in channel.sent:
        assert "Cảm ơn bạn đã sử dụng Tina" in message["body"]
        assert 'lang="vi"' in message["html_body"]
        assert "#176B5B" in message["html_body"]
        urls = [line for line in message["body"].splitlines() if line.startswith("https://")]
        assert len(urls) == 2
        assert [urlsplit(u).fragment for u in urls] == ["meeting-summary-41", "meeting-recording-41"]
        assert all(urlsplit(u).path == "/meetings/41" for u in urls)
        if message["to"] != "anna@bank.test":
            assert parse_qs(urlsplit(urls[0]).query) == {"tshare": ["41.recipient-bound-secret"]}
    ctx.prior["email_meeting_followup"] = result.result
    assert reg.steps["email_minutes"](ctx).result["skipped"]
    assert reg.steps["email_attendees"](ctx).result["sent"] == 2
    assert len(channel.sent) == 2

    from flows_timeline.model import event_from_receipt
    event = event_from_receipt({"step": "email_meeting_followup", "state": "confirmed",
                               "attempted_at": 1700000000, "result": result.result}, ctx.refs)
    assert event.kind == "report.delivered"
    assert event.produced["message_id"].startswith("<fake-")


@pytest.mark.parametrize("flow_override", [False, True])
def test_attendee_domain_policy_blocks_mail_and_share_minting(world, monkeypatch, flow_override):
    reg, channel, ctx, _, shares = world
    if flow_override:
        ctx.flow = replace(reg.flows[("post_meeting", 5)], params=(("attendee_domains", '["BANK.TEST"]'),))
    else:
        monkeypatch.delenv("TINA_FLOWS_ATTENDEE_DOMAINS")
    assert reg.steps["email_meeting_followup"](ctx).result["sent"] == 1
    assert [message["to"] for message in channel.sent] == ["anna@bank.test"]
    assert not shares


def test_retry_keeps_successes_and_minted_links_after_a_partial_failure(world, monkeypatch):
    from flows_steps import followup

    reg, channel, ctx, writes, shares = world
    real_notify = followup.notify
    checkpoints = []
    ctx.checkpoint = lambda: checkpoints.append(list(ctx.scratch.get("sent", [])))

    def flaky(address, *args, **kwargs):
        if address == "ben@outside.test":
            raise OSError("temporary SMTP failure")
        return real_notify(address, *args, **kwargs)

    monkeypatch.setattr(followup, "notify", flaky)
    with pytest.raises(StepError, match="1 recipient"):
        reg.steps["email_meeting_followup"](ctx)
    assert ctx.scratch["sent"] == ["anna@bank.test"]
    monkeypatch.setattr(followup, "notify", real_notify)
    assert reg.steps["email_meeting_followup"](ctx).result["sent"] == 2
    assert [m["to"] for m in channel.sent] == ["anna@bank.test", "ben@outside.test"]
    assert shares == ["ben@outside.test"] and len(writes) == 1 and checkpoints


def test_disabled_owner_email_and_meeting_sharing_are_respected(world, monkeypatch):
    from flows_steps import common

    reg, channel, ctx, _, shares = world
    monkeypatch.setattr(common, "setting", lambda *_: False)
    ctx.refs["share"] = False
    assert reg.steps["email_meeting_followup"](ctx).result["sent"] == 0
    assert channel.sent == [] and shares == []


def test_no_email_is_sent_when_the_summary_cannot_be_saved(world, monkeypatch):
    from flows_steps import common

    reg, channel, ctx, _, shares = world
    real_http = common.http
    monkeypatch.setattr(common, "http", lambda method, *a, **kw:
                        (503, {}) if method == "POST" else real_http(method, *a, **kw))
    with pytest.raises(StepError, match="save meeting summary"):
        reg.steps["email_meeting_followup"](ctx)
    assert channel.sent == [] and shares == []


def test_declined_attendee_cannot_be_reintroduced_by_event_participants(world):
    from flows_steps import meeting

    reg, channel, ctx, _, shares = world
    row = meeting.meeting_row("7", 41)
    row["data"]["attendees"][1]["partstat"] = "DECLINED"
    ctx.refs["participants"] = ["ben@outside.test"]
    result = reg.steps["email_meeting_followup"](ctx)
    assert result.result["sent"] == 1
    assert [message["to"] for message in channel.sent] == ["anna@bank.test"]
    assert shares == []


def test_meeting_row_does_not_depend_on_the_first_meetings_page(monkeypatch):
    from flows_steps import meeting

    monkeypatch.setattr(meeting, "meetings_door", lambda: "http://gateway.test")
    monkeypatch.setattr(meeting, "user_api_key", lambda _: "test-key")
    target = {"id": 41, "data": {"title": "Older meeting"}}
    calls = []

    def http(method, url, headers):
        calls.append(url)
        return (200, target) if url.endswith("/meetings/41") else (200, {"meetings": [{"id": 42}]})

    monkeypatch.setattr(meeting, "http", http)
    assert meeting.meeting_row("7", 41) == target
    assert calls == ["http://gateway.test/meetings/41"]


def test_missing_meeting_row_never_falls_back_to_a_reused_meet_link(monkeypatch):
    from flows_steps import meeting

    monkeypatch.setattr(meeting, "meetings_door", lambda: "http://gateway.test")
    monkeypatch.setattr(meeting, "user_api_key", lambda _: "test-key")
    other_row = {"id": 42, "native_meeting_id": "abc-defg-hij"}
    monkeypatch.setattr(meeting, "http", lambda _method, url, _headers:
                        (404, {}) if url.endswith("/41") else (200, {"meetings": [other_row]}))
    assert meeting.meeting_row("7", 41, "abc-defg-hij") is None
    assert meeting.meeting_row("7", None, "abc-defg-hij") == other_row


def test_meet_sends_verified_partial_roster_and_retries_without_duplicate_mail(world, monkeypatch):
    from flows_steps import meeting

    reg, channel, ctx, writes, shares = world
    meeting.meeting_row("7", 41).update(platform="google_meet", native_meeting_id="abc-defg-hij")
    completed = False

    def roster(uid, mid, platform, native):
        assert (uid, mid, platform, native) == ("7", 41, "google_meet", "abc-defg-hij")
        participants = [
            {"email": "ben@outside.test", "source": "invite"},
            {"email": "joined-via-link@outside.test", "source": "attendance"},
            {"email": "not-allowed@other.test", "source": "attendance"},
        ]
        if completed:
            participants.append({"email": "recovered@outside.test", "source": "attendance"})
        return {"observed_roster": "recorded", "attendance_retryable": not completed,
                "participants": participants}

    monkeypatch.setattr(meeting, "meeting_participants", roster)
    step = reg.steps["email_meeting_followup"]
    with pytest.raises(StepError, match="waiting for Google attendance lookup") as error:
        step(ctx)
    assert error.value.retryable
    assert ctx.scratch["sent"] == ["anna@bank.test", "joined-via-link@outside.test"]
    completed = True
    assert step(ctx).result["sent"] == 3
    assert shares == ["joined-via-link@outside.test", "recovered@outside.test"]
    assert [m["to"] for m in channel.sent] == ["anna@bank.test", *shares]
    assert len(writes) == 1


def test_new_post_meeting_version_sends_before_workspace_delivery(world):
    reg, *_ = world
    flow = reg.flows[("post_meeting", 5)]
    assert flow.version == 5
    names = list(flow.steps)
    assert names.index("process_meeting") < names.index("email_meeting_followup") < names.index("drop_to_attendees")


def test_duplicate_completion_event_creates_one_followup_delivery(world):
    from flows import FakeClock, admit, tick
    from sqlite_double import SqliteDB

    reg, channel, _, _, _ = world
    reg.steps["process_meeting"] = lambda ctx: Done({"report": "Quyết định: phát hành thứ Sáu."})
    reg.steps["drop_to_attendees"] = lambda ctx: Done({"dropped": 0})
    db, clock = SqliteDB(), FakeClock()
    event = dict(source_event_id="done-41", event_type="meeting.completed",
                 subject_refs={"uid": "7", "meeting_id": "41", "native": "abc-defg-hij"})
    admit(db, reg, clock, **event)
    admit(db, reg, clock, **event)
    for _ in range(8):
        if not tick(db, reg, clock):
            break
    assert len(db.execute("SELECT 1 FROM reaction WHERE flow='post_meeting'")) == 1
    assert len(channel.sent) == 2
