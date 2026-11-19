from html.parser import HTMLParser

import pytest
from flows_steps import emailx, notify
from flows_steps.email_design import LOGO_CID, LOGO_PATH, render_followup


SUMMARY = "https://tina.example/meetings/41?tshare=41.secret&view=1#meeting-summary-41"
RECORDING = "https://tina.example/meetings/41?tshare=41.secret&view=1#meeting-recording-41"
BODY = f"Xin chào,\n\nCảm ơn bạn đã sử dụng Tina.\n\nXem tóm tắt cuộc họp:\n{SUMMARY}\n\nXem bản ghi cuộc họp:\n{RECORDING}"


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
    assert [attrs["href"] for tag, attrs in parsed.tags if tag == "a"] == [SUMMARY, RECORDING]
    assert sum(tag == "h1" for tag, _ in parsed.tags) == 1
    assert all(attrs.get("role") == "presentation" for tag, attrs in parsed.tags if tag == "table")
    assert ("html", {"lang": "vi", "dir": "ltr"}) in parsed.tags
    assert all(attrs.get("lang") == "vi" for tag, attrs in parsed.tags if tag == "body")
    assert sum(tag == "title" for tag, _ in parsed.tags) == 1
    assert "#176B5B" in html and "#F7F8F3" in html
    assert "display:flex" not in html and "<script" not in html
    assert [(attrs["src"], attrs["alt"]) for tag, attrs in parsed.tags if tag == "img"] == [(f"cid:{LOGO_CID}", "Logo Tina")]
    assert "TINA" not in html and "Cuộc họp khép lại" not in html and "Hiện diện nhiều hơn" not in html
    assert "@keyframes" not in html and "gradient(" not in html and "box-shadow" not in html
    assert "Báo cáo sẵn sàng" not in html and "pulse-dot" not in html
    assert "Xem tóm tắt" in html and "Xem bản ghi" in html
    assert len(html.encode("utf-8")) < 102_000


def test_user_copy_is_text_and_preview_notice_is_explicit():
    html = render_followup('Subject <script>', '<img src=x onerror="alert(1)">',
                           BODY + "\n\n<script>untrusted</script>", SUMMARY, RECORDING,
                           preview_notice="Bản mẫu. Các link chưa hoạt động.")
    assert "&lt;img" in html and "&lt;script&gt;untrusted&lt;/script&gt;" in html
    assert '<img src=x' not in html and "<script" not in html
    assert "Bản mẫu. Các link chưa hoạt động." in html


def test_brand_text_and_buttons_meet_aa_contrast():
    def luminance(color):
        values = [int(color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
        linear = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]
        return sum(v * weight for v, weight in zip(linear, (0.2126, 0.7152, 0.0722)))

    for foreground, background in [("#173B36", "#FFFFFF"), ("#526860", "#FFFFFF"),
                                    ("#FFFFFF", "#176B5B"), ("#526860", "#F7F8F3")]:
        lighter, darker = sorted((luminance(foreground), luminance(background)), reverse=True)
        assert (lighter + 0.05) / (darker + 0.05) >= 4.5


@pytest.mark.parametrize("url", ["javascript:alert(1)", "/meetings/41", "https://name:secret@host.test/"])
def test_unsafe_artifact_urls_are_refused(url):
    with pytest.raises(ValueError, match="HTTP"):
        render_followup("Subject", "Meeting", BODY, url, RECORDING)


def test_copy_and_links_are_substituted_once_without_reinterpreting_template_syntax():
    text = "Customer $meeting {{meeting}} & <draft>\nSecond line"
    html = render_followup("Subject", text, BODY + "\n\n" + text, SUMMARY, RECORDING)
    assert html.count("Customer $meeting {{meeting}} &amp; &lt;draft&gt;") == 2
    assert "&lt;draft&gt;<br>Second line" in html
    assert "$content" not in html and "$url" not in html and "$text" not in html


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
