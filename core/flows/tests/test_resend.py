import smtplib
import ssl

import pytest

import flows_config
from flows_steps import emailx, notify
from flows_steps.email_design import LOGO_CID


@pytest.fixture(autouse=True)
def isolated_channel(monkeypatch):
    notify.use(None)
    monkeypatch.setenv("TINA_NOTIFY_CHANNEL", "resend")
    monkeypatch.setenv("TINA_RESEND_API_KEY", "test-resend-secret")
    monkeypatch.setenv("TINA_RESEND_FROM", "hello@example.test")
    monkeypatch.delenv("TINA_MAIL_APP_PASSWORD", raising=False)
    monkeypatch.delenv("TINA_MAIL_ADDR", raising=False)
    yield
    notify.use(None)


def test_resend_uses_verified_tls_auth_and_preserves_mime_and_threading(monkeypatch):
    sent, calls = [], []

    class Smtp:
        def __init__(self, host, port, *, timeout, context):
            calls.append((host, port, timeout))
            assert context.verify_mode == ssl.CERT_REQUIRED and context.check_hostname

        def __enter__(self):
            return self

        def __exit__(self, *_):
            return False

        def login(self, username, password):
            assert (username, password) == ("resend", "test-resend-secret")

        def send_message(self, message):
            sent.append(message)

    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", Smtp)
    monkeypatch.setenv("TINA_MAIL_ADDR", "inbox@example.test")
    assert notify.channel().name == "resend"
    html = f'<p>Meeting summary</p><img src="cid:{LOGO_CID}" alt="Logo Tina">'
    receipt = notify.notify("guest@example.test", "Summary", "Plain copy", in_reply_to="<parent@example.test>", html_body=html)
    message = sent[0]
    assert calls == [("smtp.resend.com", 465, 20)]
    assert str(message["From"]) == "Tina <hello@example.test>"
    assert message["Reply-To"] == "inbox@example.test"
    assert message["To"] == "guest@example.test"
    assert message["In-Reply-To"] == message["References"] == "<parent@example.test>"
    assert message["Message-ID"] == receipt
    assert message.get_body(preferencelist=("plain",)).get_content().strip() == "Plain copy"
    assert message.get_body(preferencelist=("html",)).get_content().strip() == html
    assert any(p["Content-ID"] == f"<{LOGO_CID}>" for p in message.walk())
    notify.notify("guest@example.test", "Legacy", "Body", link="https://example.test/meeting")
    assert sent[1].get_content_type() == "text/plain"
    assert "https://example.test/meeting" in sent[1].get_content()


@pytest.mark.parametrize("missing", ["TINA_RESEND_API_KEY", "TINA_RESEND_FROM"])
def test_missing_resend_configuration_fails_before_connecting(monkeypatch, missing):
    monkeypatch.delenv(missing)
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw: pytest.fail("connected without credentials"))
    with pytest.raises(flows_config.ConfigError, match=missing):
        notify.notify("guest@example.test", "Subject", "Body")


@pytest.mark.parametrize("sender", ["Tina <hello@example.test>", "not-an-email", "hello@example.test\r\nBcc: other@example.test"])
def test_sender_is_a_bare_address_and_cannot_inject_headers(monkeypatch, sender):
    monkeypatch.setenv("TINA_RESEND_FROM", sender)
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw: pytest.fail("connected with invalid sender"))
    with pytest.raises((flows_config.ConfigError, ValueError)):
        notify.notify("guest@example.test", "Subject", "Body")


def test_provider_errors_do_not_echo_api_keys(monkeypatch):
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw:
                        (_ for _ in ()).throw(smtplib.SMTPAuthenticationError(535, b"test-resend-secret")))
    with pytest.raises(RuntimeError, match="SMTPAuthenticationError") as error:
        notify.notify("guest@example.test", "Subject", "Body")
    assert "test-resend-secret" not in str(error.value)
    assert "TINA_RESEND_API_KEY" in flows_config.SECRETS
