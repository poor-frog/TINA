from html.parser import HTMLParser

import pytest
from flows_steps import emailx, notify
from flows_steps.email_design import LOGO_CID, LOGO_PATH, render_followup


SUMMARY = "https://tina.example/meetings/41?tshare=41.secret&view=1#meeting-summary-41"
RECORDING = "https://tina.example/meetings/41?tshare=41.secret&view=1#meeting-recording-41"
APP_URL = "https://tina.example"
SETTINGS_URL = "https://tina.example/?nav=settings&settingsSection=account"
BODY = f"Xin chào,\n\nCảm ơn bạn đã sử dụng Tina.\n\nXem tóm tắt cuộc họp:\n{SUMMARY}\n\nXem bản ghi cuộc họp:\n{RECORDING}"

SAMPLE_INSIGHTS = {
    "question_count": 11,
    "action_item_count": 2,
    "topics": ["Token", "Mô hình bịa thông tin", "Prompt Injection", "Kiến thức Việt Nam", "Bộ nhớ hội thoại"],
    "overview": [
        {"title": "Vấn đề kỹ thuật", "text": "Thảo luận token, mô hình bịa thông tin và giới hạn ngữ cảnh."},
        {"title": "An toàn hệ thống", "text": "Đề cập Prompt Injection và chặn tác vụ nguy hiểm."},
    ],
    "action_items": [
        "Kiểm tra hóa đơn token cho 10.000 người dùng trước thứ Sáu.",
        "Cập nhật bộ nhớ hội thoại khi người dùng hỏi lại.",
    ],
}


class Markup(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = []

    def handle_starttag(self, tag, attrs):
        self.tags.append((tag, dict(attrs)))


def test_branded_email_has_accessible_structure_and_both_recipient_links():
    html = render_followup("Tóm tắt", "Họp dự án", BODY, SUMMARY, RECORDING)
    parsed = Markup()
    parsed.feed(html)
    hrefs = [attrs["href"] for tag, attrs in parsed.tags if tag == "a"]
    assert SUMMARY in hrefs and RECORDING in hrefs
    assert set(hrefs) <= {SUMMARY, RECORDING, APP_URL, SETTINGS_URL}
    assert sum(tag == "h1" for tag, _ in parsed.tags) == 1
    assert all(attrs.get("role") == "presentation" for tag, attrs in parsed.tags if tag == "table")
    assert ("html", {"lang": "vi", "dir": "ltr"}) in parsed.tags
    assert all(attrs.get("lang") == "vi" for tag, attrs in parsed.tags if tag == "body")
    assert sum(tag == "title" for tag, _ in parsed.tags) == 1
    assert "#176B5B" in html and "#F7F8F3" in html
    assert "display:flex" not in html and "display:grid" not in html and "<script" not in html
    imgs = [(attrs["src"], attrs["alt"]) for tag, attrs in parsed.tags if tag == "img"]
    assert imgs and all(pair == (f"cid:{LOGO_CID}", "Logo Tina") for pair in imgs)
    assert "TINA" not in html and "Cuộc họp khép lại" not in html and "Hiện diện nhiều hơn" not in html
    assert "@keyframes" not in html and "gradient(" not in html and "box-shadow" not in html
    assert "Báo cáo sẵn sàng" not in html and "pulse-dot" not in html
    assert "Xem tóm tắt cuộc họp" in html and "Xem bản ghi cuộc họp" in html
    assert len(html.encode("utf-8")) < 102_000


def test_rich_recap_renders_insights_topics_overview_actions_and_banner():
    html = render_followup(
        "Tina — Tóm tắt và bản ghi: Test email Tina",
        "Test email Tina",
        BODY,
        SUMMARY,
        RECORDING,
        organizer_name="Quang Thanh",
        organizer_email="lethanhquang094@gmail.com",
        meeting_time="20 Thg 11 lúc 17:45 ICT",
        calendar_day="20",
        report="- **Vấn đề kỹ thuật:** Thảo luận token.",
        insights=SAMPLE_INSIGHTS,
        app_link=APP_URL,
        settings_link=SETTINGS_URL,
    )
    assert "Bản tóm tắt cuộc họp" in html and "đã sẵn sàng" in html
    assert "Quang Thanh" in html and "lethanhquang094@gmail.com" in html
    assert "20 Thg 11 lúc 17:45 ICT" in html
    assert "Trong cuộc họp này" in html
    assert "11 câu hỏi được đặt ra" in html
    assert "2 việc cần làm được ghi nhận" in html
    assert "Token" in html and "Prompt Injection" in html and "+1 chủ đề khác" in html
    assert "Tổng quan cuộc họp" in html
    assert "Vấn đề kỹ thuật:" in html and "An toàn hệ thống:" in html
    assert "Việc cần làm" in html and "10.000 người dùng" in html
    assert "Xem toàn bộ ghi chú cuộc họp" in html
    assert "Hỏi Tina ngay sau cuộc họp" in html
    assert "Cài đặt thông báo email" in html
    assert "TINA" not in html
    assert len(html.encode("utf-8")) < 102_000


def test_overview_falls_back_to_markdown_report_when_insights_missing():
    report = (
        "- **Kiến trúc:** Chốt triển khai trên AWS Fargate.\n"
        "- **Kế hoạch:** Hoàn tất kiểm thử trước thứ Sáu.\n"
        "- Mục không có tiêu đề rõ ràng."
    )
    html = render_followup("Tóm tắt", "Họp kỹ thuật", BODY, SUMMARY, RECORDING, report=report)
    assert "Tổng quan cuộc họp" in html
    assert "Kiến trúc:" in html and "Chốt triển khai trên AWS Fargate." in html
    assert "Kế hoạch:" in html and "Mục không có tiêu đề rõ ràng." in html
    assert "Trong cuộc họp này" not in html


def test_user_copy_is_text_and_preview_notice_is_explicit():
    html = render_followup(
        "Subject <script>",
        '<img src=x onerror="alert(1)">',
        BODY + "\n\n<script>untrusted</script>",
        SUMMARY,
        RECORDING,
        preview_notice="Bản mẫu. Các link chưa hoạt động.",
        organizer_name="<b>Host</b>",
        organizer_email="host@example.test",
        meeting_time="<script>x</script>",
        insights={
            "question_count": 1,
            "action_item_count": 1,
            "topics": ["<img src=y>"],
            "overview": [{"title": "<b>Tiêu đề</b>", "text": "<script>evil()</script>"}],
            "action_items": ["<a href=javascript:alert(1)>click</a>"],
        },
    )
    assert "&lt;img" in html and "&lt;script&gt;untrusted&lt;/script&gt;" in html
    assert "&lt;b&gt;Host&lt;/b&gt;" in html and "&lt;b&gt;Tiêu đề&lt;/b&gt;" in html
    assert "&lt;script&gt;evil()&lt;/script&gt;" in html
    assert '<img src=x' not in html and '<img src=y' not in html and "<script" not in html
    assert "Bản mẫu. Các link chưa hoạt động." in html


def test_brand_text_and_buttons_meet_aa_contrast():
    def luminance(color):
        values = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
        return sum(v * weight for v, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    for foreground, background in [
        ("#173B36", "#FFFFFF"),
        ("#526860", "#FFFFFF"),
        ("#FFFFFF", "#176B5B"),
        ("#176B5B", "#EAF1EC"),
        ("#62542B", "#F4EBCF"),
        ("#526860", "#F7F8F3"),
        ("#FFFFFF", "#173B36"),
        ("#DCF0E4", "#173B36"),
        ("#ECF5EE", "#173330"),
        ("#B6CCC0", "#173330"),
        ("#246143", "#E2F1E6"),
    ]:
        lighter, darker = sorted((luminance(foreground), luminance(background)), reverse=True)
        assert (lighter + 0.05) / (darker + 0.05) >= 4.5


@pytest.mark.parametrize("url", ["javascript:alert(1)", "/meetings/41", "https://name:secret@host.test/"])
def test_unsafe_artifact_urls_are_refused(url):
    with pytest.raises(ValueError, match="HTTP"):
        render_followup("Subject", "Meeting", BODY, url, RECORDING)
    with pytest.raises(ValueError, match="HTTP"):
        render_followup("Subject", "Meeting", BODY, SUMMARY, RECORDING, settings_link=url)


def test_copy_and_links_are_substituted_once_without_reinterpreting_template_syntax():
    text = "Customer $meeting {{meeting}} & <draft>\nSecond line"
    html = render_followup("Subject", text, BODY + "\n\n" + text, SUMMARY, RECORDING)
    assert "Customer $meeting {{meeting}} &amp; &lt;draft&gt;" in html
    assert "&lt;draft&gt;<br>Second line" in html
    assert "$content" not in html and "$url" not in html and "$text" not in html and "$insights_section" not in html


def test_smtp_sends_html_with_the_existing_plain_text_fallback(monkeypatch):
    sent = []

    class Smtp:
        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def send_message(self, message):
            sent.append(message)

    monkeypatch.setattr(emailx, "creds", lambda **_: ("tina@example.test", ""))
    monkeypatch.setattr(emailx, "_needs_login", lambda: False)
    monkeypatch.setattr(emailx, "_smtp", lambda: (Smtp(), False))
    html = render_followup("Tóm tắt", "Họp dự án", BODY, SUMMARY, RECORDING)
    notify.SmtpNotifier().send("guest@example.test", "Tóm tắt", BODY, html_body=html)
    assert sent[0].get_content_type() == "multipart/alternative"
    assert sent[0].get_body(preferencelist=("plain",)).get_content().strip() == BODY
    assert sent[0].get_body(preferencelist=("html",)).get_content().strip() == html.strip()
    logo = next(part for part in sent[0].walk() if part.get_content_type() == "image/png")
    assert logo["Content-ID"] == f"<{LOGO_CID}>"
    assert logo.get_content_disposition() == "inline"
    assert logo.get_payload(decode=True) == LOGO_PATH.read_bytes()
    assert logo.get_payload(decode=True).startswith(b"\x89PNG\r\n\x1a\n")
    assert str(sent[0]["From"]).startswith("Tina <")
    notify.SmtpNotifier().send("guest@example.test", "Legacy", "plain only")
    assert sent[1].get_content_type() == "text/plain"
    notify.SmtpNotifier().send("guest@example.test", "Other HTML", "plain", html_body="<p>Other</p>")
    assert not any(part.get_content_maintype() == "image" for part in sent[2].walk())
