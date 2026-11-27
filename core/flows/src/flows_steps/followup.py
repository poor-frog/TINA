"""Post-meeting email: one recipient-bound link to each saved artifact, with durable progress."""
from __future__ import annotations

import datetime
import re
from urllib.parse import quote, urlencode, urlsplit

from flows import Done, StepError
from . import common, mailtext, meeting
from .notify import notify
from .email_design import render_followup

_ICT = datetime.timezone(datetime.timedelta(hours=7))


def _meeting_time_meta(row: dict) -> tuple[str, str]:
    """Format the meeting timestamp in ICT (UTC+7) plus a 2-char calendar day badge."""
    for key in ("start_time", "scheduled_at", "created_at"):
        raw = row.get(key)
        if not raw:
            continue
        try:
            dt = datetime.datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=datetime.timezone.utc)
            local = dt.astimezone(_ICT)
            label = f"{local.day:02d} Thg {local.month:02d} lúc {local.hour:02d}:{local.minute:02d} ICT"
            return label, f"{local.day:02d}"
        except Exception:  # noqa: BLE001
            continue
    return "", ""


def _address(value) -> str:
    value = str(value or "").strip().lower()
    return value if len(value) <= 254 and re.fullmatch(r'[^\s@<>;,:()\[\]"\\]+@[^\s@<>;,:()\[\]"\\]+', value) else ""


def send(ctx):
    uid = str(ctx.refs["uid"])
    row = meeting.meeting_row(uid, ctx.refs.get("meeting_id"), ctx.refs.get("native"))
    if not row or not str(row.get("id", "")).isdigit():
        raise StepError("Cannot send meeting follow-up: owned meeting is unavailable")
    mid = row["id"]
    data = row.get("data") or {}
    if row.get("shared") is True or data.get("artifact_deletion"):
        raise StepError("Cannot send follow-up for an unowned or deleted meeting", retryable=False)
    status, owner = common.http(
        "GET", f"{common.ADMIN_API}/admin/users/{quote(uid, safe='')}", common._admin_headers())
    if status != 200 or not isinstance(owner, dict) or not _address(owner.get("email")):
        raise StepError("Cannot resolve meeting owner's email", retryable=status >= 500)
    organizer = _address(owner["email"])
    organizer_name = " ".join(str(owner.get("name") or "").split())[:100]
    meeting_time, calendar_day = _meeting_time_meta(row)
    title = " ".join(str(data.get("title") or ctx.refs.get("title") or ctx.refs.get("native") or "Cuộc họp").split())[:512]
    participants = [organizer]
    followup = ctx.flow.param("attendee_followup") if ctx.flow else None
    attendee_followup_on = (ctx.refs.get("share") is not False
                            and (followup is None or str(followup).strip().lower()
                                 not in ("off", "none", "false", "0")))
    platform = row.get("platform") or ctx.refs.get("platform")
    attendance_lookup = None
    attendance_retryable = False
    if platform == "google_meet":
        attendees = []
        attendance_lookup = "not_requested"
        if attendee_followup_on:
            attendance_lookup = "unavailable"
            native = row.get("native_meeting_id") or ctx.refs.get("native")
            try:
                roster = (meeting.meeting_participants(uid, mid, platform, str(native))
                          if native else None)
                if roster:
                    attendance_lookup = str(roster.get("observed_roster") or "unavailable")
                    attendance_retryable = roster.get("attendance_retryable") is True
                    if attendance_lookup == "recorded":
                        rows = roster.get("participants")
                        attendees = [p.get("email") for p in rows if isinstance(p, dict)
                                     and p.get("source") == "attendance"] if isinstance(rows, list) else []
            except StepError as error:
                attendance_retryable = error.retryable
            for attendee in attendees:
                address = _address(attendee)
                if address and address not in participants:
                    participants.append(address)
    else:
        attendees = list(data.get("attendees") or []) + list(ctx.refs.get("participants") or [])
        declined = {_address(a.get("email")) for a in attendees
                    if isinstance(a, dict) and str(a.get("partstat", "")).upper() == "DECLINED"}
        for attendee in attendees:
            if isinstance(attendee, dict):
                if str(attendee.get("partstat", "")).upper() == "DECLINED":
                    continue
                attendee = attendee.get("email")
            address = _address(attendee)
            if address and address not in declined and address not in participants:
                participants.append(address)
    mailbox = _address(mailtext.mailbox_address())
    allowed_domains = common.attendee_domains(ctx, organizer)
    participants = [a for a in participants if a != mailbox
                    and (a == organizer or a.rsplit("@", 1)[-1] in allowed_domains)]
    recipients = [organizer] if organizer in participants and common.setting(uid, "mail_minutes") else []
    if attendee_followup_on:
        recipients.extend(a for a in participants if a != organizer)

    report = str(ctx.prior["process_meeting"]["report"]).strip()
    insights = ctx.prior["process_meeting"].get("insights")
    if not isinstance(insights, dict):
        insights = None
    if not report:
        raise StepError("Cannot send meeting follow-up without a summary", retryable=False)
    if not ctx.scratch.get("summary_saved"):
        status, _ = common.http(
            "POST", f"{common.meetings_door()}/meetings/{mid}/annotate",
            {"X-API-Key": common.user_api_key(uid)}, {"summary": report})
        if status != 200:
            raise StepError("Cannot save meeting summary", retryable=status >= 500)
        ctx.scratch["summary_saved"] = True
        ctx.checkpoint()

    base = common.UI_URL
    parsed = urlsplit(base)
    if parsed.scheme not in ("https", "http") or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise StepError("TINA_UI_URL must be an absolute HTTP(S) application URL", retryable=False)
    sent = ctx.scratch.setdefault("sent", [])
    drops = ctx.scratch.setdefault("drops", [])
    links = ctx.scratch.setdefault("links", {})
    failed = 0
    errors = set()
    for address in recipients:
        if address in sent:
            continue
        try:
            if address not in links:
                token = "" if address == organizer else meeting.mint_transcript_share(
                    uid, mid, address, include_recordings=True)
                query = f"?{urlencode({'tshare': token})}" if token else ""
                links[address] = f"{base}/meetings/{mid}{query}"
                ctx.checkpoint()
            link = links[address]
            subject, body = mailtext.render("meeting-followup", uid, {
                "meeting": title,
                "summary_link": link + f"#meeting-summary-{mid}",
                "recording_link": link + f"#meeting-recording-{mid}",
            })
            html_body = render_followup(
                subject,
                title,
                body,
                link + f"#meeting-summary-{mid}",
                link + f"#meeting-recording-{mid}",
                organizer_name=organizer_name,
                organizer_email=organizer,
                meeting_time=meeting_time,
                calendar_day=calendar_day,
                report=report,
                insights=insights,
                app_link=base,
                settings_link=f"{base}/?nav=settings&settingsSection=account",
            )
            message_id = notify(address, " ".join(subject.split()), body, html_body=html_body)
            # shortcut: SMTP cannot deduplicate a crash after acceptance; use an idempotent provider if required.
            sent.append(address)
            drops.append({"to": address, "link": link, "message_id": message_id})
        except Exception as exc:
            # Keep recipient details, restricted tokens and provider errors out of the reaction error.
            failed += 1
            errors.add(type(exc).__name__)
        ctx.checkpoint()
    if failed:
        raise StepError(f"Meeting follow-up pending for {failed} recipient(s): {', '.join(sorted(errors))}")
    if attendance_retryable:
        raise StepError("Meeting follow-up is waiting for Google attendance lookup")
    result = {"sent": len(sent), "to": list(sent), "drops": list(drops),
              "organizer": organizer, "participants": participants,
              "title": title, "link": links.get(organizer), "owner_link": links.get(organizer),
              "message_id": drops[0]["message_id"] if drops else None, "followup": "on"}
    if platform == "google_meet":
        result["attendance_lookup"] = attendance_lookup
    return Done(result)
