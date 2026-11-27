"""Fill precompiled React Email templates with escaped meeting recap copy and insights."""
from __future__ import annotations

from html import escape
import json
from pathlib import Path
import re
from string import Template
from typing import Any
from urllib.parse import urlsplit

TEMPLATES = Path(__file__).parent / "templates"
LOGO_CID = "tina-logo@tina"
LOGO_PATH = TEMPLATES / "tina-logo.png"

_BOILERPLATE_PARAGRAPHS = frozenset({
    "xin chào,",
    "cảm ơn bạn đã sử dụng tina.",
    "trân trọng,\ntina",
})
_BOLD_PREFIX_RE = re.compile(r"^\*\*([^*]{2,64}?)\*\*\s*[:：]\s*(.+)$")
_PLAIN_PREFIX_RE = re.compile(r"^([^:：\n]{2,48}?)\s*[:：]\s+(.+)$")


def _validate_http_url(link: str) -> tuple[str, str]:
    url = urlsplit(link)
    if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password:
        raise ValueError("Email artifact links must be absolute HTTP(S) URLs")
    return url.scheme, url.netloc


def _clip(text: str, limit: int = 320) -> str:
    cleaned = " ".join(str(text or "").split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 1].rstrip() + "…"


def _parse_overview_from_report(report: str, max_items: int = 6) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    for raw_line in (report or "").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        line = re.sub(r"^(?:[-*•]|\d+[.)])\s+", "", line).strip()
        if not line:
            continue
        bold_match = _BOLD_PREFIX_RE.match(line)
        if bold_match:
            title = _clip(bold_match.group(1).strip(" :–—-"), 64)
            text = _clip(bold_match.group(2).replace("**", ""), 320)
            if text:
                items.append({"title": title, "text": text})
        else:
            clean = line.replace("**", "")
            plain_match = _PLAIN_PREFIX_RE.match(clean)
            if plain_match and "http://" not in plain_match.group(1) and "https://" not in plain_match.group(1):
                title = _clip(plain_match.group(1).strip(" :–—-"), 48)
                text = _clip(plain_match.group(2), 320)
                if text:
                    items.append({"title": title, "text": text})
            else:
                text = _clip(clean, 320)
                if text:
                    items.append({"title": "", "text": text})
        if len(items) >= max_items:
            break
    return items


def _normalize_overview(report: str, insights: dict[str, Any] | None) -> list[dict[str, str]]:
    items: list[dict[str, str]] = []
    raw_overview = insights.get("overview") if isinstance(insights, dict) else None
    if isinstance(raw_overview, list):
        for entry in raw_overview:
            if not isinstance(entry, dict):
                continue
            title = _clip(str(entry.get("title") or "").strip(" :–—-"), 64)
            text = _clip(str(entry.get("text") or ""), 320)
            if text:
                items.append({"title": title, "text": text})
            if len(items) >= 6:
                break
    if not items and report:
        items = _parse_overview_from_report(report, max_items=6)
    return items


def _normalize_topics(insights: dict[str, Any] | None) -> list[str]:
    raw_topics = insights.get("topics") if isinstance(insights, dict) else None
    if not isinstance(raw_topics, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in raw_topics:
        if not isinstance(item, str):
            continue
        label = _clip(item.strip(" ,;:.–—-"), 40)
        if not label:
            continue
        key = label.casefold()
        if key not in seen:
            seen.add(key)
            out.append(label)
            if len(out) >= 8:
                break
    return out


def _normalize_action_items(insights: dict[str, Any] | None) -> list[str]:
    raw_actions = insights.get("action_items") if isinstance(insights, dict) else None
    if not isinstance(raw_actions, list):
        return []
    out: list[str] = []
    for item in raw_actions:
        text = _clip(str(item if isinstance(item, str) else ""), 240)
        if text:
            out.append(text)
            if len(out) >= 4:
                break
    return out


def _safe_nonneg_int(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    try:
        num = int(value)
    except (TypeError, ValueError):
        return 0
    return num if num > 0 else 0


def render_followup(
    subject: str,
    meeting: str,
    body: str,
    summary_link: str,
    recording_link: str,
    *,
    preview_notice: str = "",
    organizer_name: str = "",
    organizer_email: str = "",
    meeting_time: str = "",
    calendar_day: str = "",
    report: str = "",
    insights: dict[str, Any] | None = None,
    app_link: str = "",
    settings_link: str = "",
) -> str:
    scheme, netloc = _validate_http_url(summary_link)
    _validate_http_url(recording_link)
    origin = f"{scheme}://{netloc}"
    resolved_app = app_link or origin
    resolved_settings = settings_link or f"{origin}/?nav=settings&settingsSection=account"
    _validate_http_url(resolved_app)
    _validate_http_url(resolved_settings)

    fragments = json.loads((TEMPLATES / "meeting-followup.parts.json").read_text(encoding="utf-8"))
    artifact_urls = {summary_link, recording_link}

    clean_org_name = _clip(organizer_name, 100)
    clean_org_email = _clip(organizer_email, 254)
    if clean_org_name and clean_org_email and clean_org_name.casefold() != clean_org_email.casefold():
        organizer_block = Template(fragments["organizer"]).substitute(
            name=escape(clean_org_name), email=escape(clean_org_email),
        )
    elif clean_org_email or clean_org_name:
        organizer_block = Template(fragments["organizer_email_only"]).substitute(
            email=escape(clean_org_email or clean_org_name),
        )
    else:
        organizer_block = ""

    clean_time = _clip(meeting_time, 80)
    meeting_time_block = (
        Template(fragments["meeting_time"]).substitute(text=escape(clean_time))
        if clean_time else ""
    )

    clean_day = "".join(ch for ch in str(calendar_day or "").strip() if ch.isalnum())[:2] or "T"

    overview_items = _normalize_overview(report, insights)
    topics = _normalize_topics(insights)
    action_items = _normalize_action_items(insights)
    question_count = _safe_nonneg_int(insights.get("question_count") if isinstance(insights, dict) else 0)
    action_count = max(
        _safe_nonneg_int(insights.get("action_item_count") if isinstance(insights, dict) else 0),
        len(action_items),
    )

    stat_labels: list[str] = []
    if question_count > 0:
        stat_labels.append(f"{question_count} câu hỏi được đặt ra")
    if action_count > 0:
        stat_labels.append(f"{action_count} việc cần làm được ghi nhận")
    if len(stat_labels) == 1 and len(overview_items) > 0:
        stat_labels.append(f"{len(overview_items)} ý chính được ghi nhận")
    elif len(stat_labels) == 0 and len(topics) > 0 and len(overview_items) > 0:
        stat_labels.append(f"{len(overview_items)} ý chính được ghi nhận")
        stat_labels.append(f"{len(topics)} chủ đề đã thảo luận")

    if len(stat_labels) >= 2:
        stats_html = Template(fragments["stats_pair"]).substitute(
            left_text=escape(stat_labels[0]), right_text=escape(stat_labels[1]),
        )
    elif len(stat_labels) == 1:
        stats_html = Template(fragments["stat_single"]).substitute(text=escape(stat_labels[0]))
    else:
        stats_html = ""

    topics_html = ""
    if topics:
        visible = topics[:4]
        extra = len(topics) - len(visible)
        chips = [Template(fragments["topic_chip"]).substitute(text=escape(t)) for t in visible]
        if extra > 0:
            chips.append(Template(fragments["topic_chip"]).substitute(text=escape(f"+{extra} chủ đề khác")))
        topics_html = Template(fragments["topics_block"]).substitute(chips="".join(chips))

    if stats_html or topics_html:
        insights_section = Template(fragments["insights_section"]).substitute(
            stats=stats_html, topics=topics_html, url=escape(summary_link, quote=True),
        )
    else:
        insights_section = ""

    if overview_items:
        rendered_items = []
        for entry in overview_items:
            if entry["title"]:
                rendered_items.append(Template(fragments["overview_item_titled"]).substitute(
                    title=escape(entry["title"]), text=escape(entry["text"]),
                ))
            else:
                rendered_items.append(Template(fragments["overview_item_plain"]).substitute(
                    text=escape(entry["text"]),
                ))
        actions_html = ""
        if action_items:
            action_lis = "".join(
                Template(fragments["overview_item_plain"]).substitute(text=escape(a))
                for a in action_items
            )
            actions_html = Template(fragments["actions_block"]).substitute(items=action_lis)
        overview_section = Template(fragments["overview_section"]).substitute(
            items="".join(rendered_items), actions=actions_html, url=escape(summary_link, quote=True),
        )
    else:
        overview_section = ""

    extra_blocks: list[str] = []
    for paragraph in (body or "").strip().split("\n\n"):
        stripped = paragraph.strip()
        if not stripped:
            continue
        if any(line.strip() in artifact_urls for line in stripped.splitlines()):
            continue
        if overview_section and stripped.casefold() in _BOILERPLATE_PARAGRAPHS:
            continue
        text = escape(stripped).replace("\n", "<br>")
        extra_blocks.append(Template(fragments["paragraph"]).substitute(text=text))

    content_html = ""
    if extra_blocks:
        spacer = '<div style="margin-top:18px">' + "".join(extra_blocks) + "</div>"
        content_html = spacer

    notice = Template(fragments["notice"]).substitute(text=escape(preview_notice)) if preview_notice else ""
    preheader = f"Bản tóm tắt cuộc họp {meeting} đã sẵn sàng trên Tina."
    template = Template((TEMPLATES / "meeting-followup.html").read_text(encoding="utf-8"))
    return template.substitute(
        subject=escape(subject),
        preheader=escape(preheader),
        meeting=escape(meeting),
        logo=f"cid:{LOGO_CID}",
        calendar_day=escape(clean_day),
        summary_url=escape(summary_link, quote=True),
        recording_url=escape(recording_link, quote=True),
        app_url=escape(resolved_app, quote=True),
        settings_url=escape(resolved_settings, quote=True),
        notice=notice,
        organizer_block=organizer_block,
        meeting_time_block=meeting_time_block,
        insights_section=insights_section,
        overview_section=overview_section,
        content=content_html,
    )
