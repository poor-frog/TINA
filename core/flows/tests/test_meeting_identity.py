"""THE REPORT IS ABOUT THE RIGHT MEETING — the flows-identity rows that are not about the mailbox.

R-B06 · R-B10 · R-B19 from the 2026-09-02 release backlog (R-B02 and R-B17 are proved in
`test_mail_authz.py` and `test_room_read.py`). All three are one shape: a value that is nearly the
right one, used where only the right one works, with no noise when it is wrong.

Each fails on `origin/minutes-mcp-viewer` @ b25733d12: `email_minutes` minted the organiser's link
against `refs["meeting_id"]`, `parse_ics` read a floating `DTSTART` with `time.mktime`, and the
grounding gate read the ref and could not tell an unreadable transcript from a silent meeting.
"""
from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import flows_defs.production as production
import flows_steps.meeting as mt
import pytest
from flows import Registry, StepError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from test_link_loop import FakeChannel, FakeScaffolds, _ctx, _StubDB  # noqa: E402
import flows_steps.notify as notify_mod  # noqa: E402


@pytest.fixture(autouse=True)
def scaffolds(monkeypatch):
    fake = FakeScaffolds()
    monkeypatch.setattr(production, "mint_scaffold", fake)
    return fake


def teardown_function():
    notify_mod.use(None)


# ── R-B06 · the organiser's link names the ROW ───────────────────────────────────────────────
def test_the_minutes_link_is_minted_against_the_row_not_the_ref(monkeypatch, scaffolds):
    """`email_attendees` resolves the row two steps later and states the reason in capitals — *"By
    ROW id, never by (platform, native)"*, the row-97 incident — and `process_meeting` resolves it
    too. This step, THE ONE MAIL THAT ALWAYS SENDS, was the site that did not: a ref carrying a
    native id mints a link into a chat that cannot see the meeting the mail is about."""
    reg = Registry()
    production.build(reg, _StubDB())
    notify_mod.use(FakeChannel())
    monkeypatch.setattr(production, "setting", lambda uid, key: True)
    monkeypatch.setattr(production.mt, "meeting_row",
                        lambda uid, m, native=None: {"id": 97})
    ctx = _ctx({"uid": "7", "organizer": "a@bank.test", "title": "T",
                "meeting_id": "96088138284", "native": ""},
               prior={"process_meeting": {"report": "the report"}})
    reg.steps["email_minutes"](ctx)
    assert scaffolds.for_("a@bank.test")["meeting"] == "97"


def test_it_degrades_to_the_ref_rather_than_failing_to_send(monkeypatch, scaffolds):
    """A lookup that cannot run is not a reason to withhold the minutes: the ref is a weaker link
    than the row and both beat no mail. (`mint_scaffold` still refuses to mint onto nothing.)"""
    reg = Registry()
    production.build(reg, _StubDB())
    notify_mod.use(FakeChannel())
    monkeypatch.setattr(production, "setting", lambda uid, key: True)
    monkeypatch.setattr(production.mt, "meeting_row", lambda uid, m, native=None: None)
    ctx = _ctx({"uid": "7", "organizer": "a@bank.test", "title": "T", "meeting_id": 41,
                "native": "abc"},
               prior={"process_meeting": {"report": "the report"}})
    reg.steps["email_minutes"](ctx)
    assert scaffolds.for_("a@bank.test")["meeting"] == "41"


# ── R-B10 · a floating DTSTART is UTC, never the server's zone ───────────────────────────────
FLOATING = ("BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:u-1\nDTSTART:20300302T140000\n"
            "ORGANIZER:mailto:a@bank.test\nSUMMARY:Pilot\n"
            "LOCATION:https://meet.google.com/abc-defg-hij\nEND:VEVENT\nEND:VCALENDAR\n")


@pytest.mark.parametrize("tz", ["UTC", "Pacific/Kiritimati", "Pacific/Niue", "Europe/Vienna"])
def test_a_floating_dtstart_reads_the_same_wherever_the_worker_runs(monkeypatch, tz):
    """`refs.start` drives the bot dispatch and the note filename — the two things that must not
    move when the process does. `time.mktime` read the tuple in whatever zone the worker happened
    to be in, so the same invite parsed 26 hours apart across the two ends of the map."""
    monkeypatch.setenv("TZ", tz)
    time.tzset()
    try:
        from flows_integrations.mailbox import parse_ics
        assert parse_ics(FLOATING, "tina@acme.test")["start"] == 1_898_690_400.0
    finally:
        monkeypatch.delenv("TZ", raising=False)
        time.tzset()


def test_a_zoned_and_a_zulu_dtstart_are_untouched():
    """The floating branch is the only one that moved; the guarded ones were already right."""
    from flows_integrations.mailbox import parse_ics
    zulu = FLOATING.replace("DTSTART:20300302T140000", "DTSTART:20300302T140000Z")
    vienna = FLOATING.replace("DTSTART:20300302T140000",
                              "DTSTART;TZID=Europe/Vienna:20300302T140000")
    assert parse_ics(zulu, "v@a.test")["start"] == 1_898_690_400.0
    assert parse_ics(vienna, "v@a.test")["start"] == 1_898_686_800.0


# ── R-B19 · the grounding gate ───────────────────────────────────────────────────────────────
def _process_rig(monkeypatch, *, code, body, row_id=412):
    reg = Registry()
    production.build(reg, _StubDB())
    seen = {}
    monkeypatch.setattr(production, "prompt_for", lambda ctx, name: "fixture prompt")
    monkeypatch.setattr(production.mt, "meeting_row",
                        lambda uid, m, native=None: {"id": row_id} if row_id else None)
    monkeypatch.setattr(production._common, "agent_door", lambda: "http://agent")
    monkeypatch.setattr(production._common, "require_internal_secret", lambda: "fixture")

    def report(method, url, headers, payload, timeout):
        seen.update(method=method, url=url, headers=headers)
        return code, body

    monkeypatch.setattr(production._common, "http", report)
    return reg, seen


def test_an_unreadable_transcript_is_loud_and_not_a_pass(monkeypatch):
    reg, _seen = _process_rig(monkeypatch, code=503, body={"detail": "Meeting unavailable"})
    ctx = _ctx({"uid": "7", "meeting_id": 412, "native": ""}, scratch={})
    with pytest.raises(StepError, match="HTTP 503"):
        reg.steps["process_meeting"](ctx)


def test_a_valid_summary_unavailable_notice_still_allows_followup(monkeypatch):
    notice = "TINA could not generate a grounded summary. Open the meeting for its artifacts."
    reg, _seen = _process_rig(monkeypatch, code=200, body={"report": notice})
    ctx = _ctx({"uid": "7", "meeting_id": 412, "native": "abc"}, scratch={})
    assert reg.steps["process_meeting"](ctx).result["report"] == notice


def test_the_report_uses_the_resolved_row_not_the_ref(monkeypatch):
    reg, seen = _process_rig(monkeypatch, code=200, body={"report": "The vote was deferred."})
    ctx = _ctx({"uid": "7", "meeting_id": "96088138284", "native": ""}, scratch={})
    reg.steps["process_meeting"](ctx)
    assert seen == {
        "method": "POST",
        "url": "http://agent/internal/post-meeting/report/412",
        "headers": {"X-User-Id": "7", "X-Internal-Secret": "fixture"},
    }


def test_transcript_text_separates_unreadable_from_empty(monkeypatch):
    """The unit under both branches above."""
    monkeypatch.setattr(mt, "user_api_key", lambda uid: "k")
    monkeypatch.setattr(mt, "http", lambda *a, **k: (200, {"segments": []}))
    assert mt.transcript_text("7", 1) == ""
    monkeypatch.setattr(mt, "http", lambda *a, **k: (404, {"detail": "no such meeting"}))
    assert mt.transcript_text("7", 1) is None

    def boom(*a, **k):
        raise StepError("gateway down")
    monkeypatch.setattr(mt, "http", boom)
    assert mt.transcript_text("7", 1) is None
