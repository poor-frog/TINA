import smtplib
import ssl

import pytest

import flows_config
from flows_steps import emailx, notify
from flows_steps.email_design import LOGO_CID


@pytest.fixture(autouse=True)
def isolated_channel(monkeypatch):
    notify.use(None)
    monkeypatch.setenv("TINA_NOTIFY_CHANNEL", "ses")
    monkeypatch.setenv("TINA_SES_SMTP_USER", "AKIAEXAMPLEUSER")
    monkeypatch.setenv("TINA_SES_SMTP_PASSWORD", "test-ses-smtp-secret")
    monkeypatch.setenv("TINA_SES_FROM", "tina@meettina.site")
    monkeypatch.setenv("TINA_SES_REGION", "us-east-1")
    monkeypatch.delenv("TINA_MAIL_APP_PASSWORD", raising=False)
    monkeypatch.delenv("TINA_MAIL_ADDR", raising=False)
    yield
    notify.use(None)


def test_ses_uses_verified_tls_auth_and_preserves_mime_and_threading(monkeypatch):
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
            assert (username, password) == ("AKIAEXAMPLEUSER", "test-ses-smtp-secret")

        def send_message(self, message):
            sent.append(message)

    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", Smtp)
    monkeypatch.setenv("TINA_MAIL_ADDR", "inbox@meettina.site")
    assert notify.channel().name == "ses"
    html = f'<p>Meeting summary</p><img src="cid:{LOGO_CID}" alt="Logo Tina">'
    receipt = notify.notify("guest@example.test", "Summary", "Plain copy",
                            in_reply_to="<parent@example.test>", html_body=html)
    message = sent[0]
    assert calls == [("email-smtp.us-east-1.amazonaws.com", 465, 20)]
    assert str(message["From"]) == "Tina <tina@meettina.site>"
    assert message["Reply-To"] == "inbox@meettina.site"
    assert message["To"] == "guest@example.test"
    assert message["In-Reply-To"] == message["References"] == "<parent@example.test>"
    assert message["Message-ID"] == receipt
    assert message.get_body(preferencelist=("plain",)).get_content().strip() == "Plain copy"
    assert message.get_body(preferencelist=("html",)).get_content().strip() == html
    assert any(p["Content-ID"] == f"<{LOGO_CID}>" for p in message.walk())
    notify.notify("guest@example.test", "Legacy", "Body", link="https://meettina.site/meeting")
    assert sent[1].get_content_type() == "text/plain"
    assert "https://meettina.site/meeting" in sent[1].get_content()


@pytest.mark.parametrize("missing", ["TINA_SES_SMTP_USER", "TINA_SES_SMTP_PASSWORD", "TINA_SES_FROM"])
def test_missing_ses_configuration_fails_before_connecting(monkeypatch, missing):
    monkeypatch.delenv(missing)
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw: pytest.fail("connected without credentials"))
    with pytest.raises(flows_config.ConfigError, match=missing):
        notify.notify("guest@example.test", "Subject", "Body")


@pytest.mark.parametrize("sender", ["Tina <tina@meettina.site>", "not-an-email", "tina@meettina.site\r\nBcc: other@example.test"])
def test_ses_sender_is_a_bare_address_and_cannot_inject_headers(monkeypatch, sender):
    monkeypatch.setenv("TINA_SES_FROM", sender)
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw: pytest.fail("connected with invalid sender"))
    with pytest.raises((flows_config.ConfigError, ValueError)):
        notify.notify("guest@example.test", "Subject", "Body")


@pytest.mark.parametrize("region", ["us-east-1.evil.test", "US_EAST_1", "us-east-1/foo"])
def test_ses_region_is_validated_before_connecting(monkeypatch, region):
    monkeypatch.setenv("TINA_SES_REGION", region)
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw: pytest.fail("connected with invalid region"))
    with pytest.raises(flows_config.ConfigError, match="TINA_SES_REGION"):
        notify.notify("guest@example.test", "Subject", "Body")


def test_ses_provider_errors_do_not_echo_credentials(monkeypatch):
    monkeypatch.setattr(emailx.smtplib, "SMTP_SSL", lambda *a, **kw:
                        (_ for _ in ()).throw(smtplib.SMTPAuthenticationError(535, b"test-ses-smtp-secret AKIAEXAMPLEUSER")))
    with pytest.raises(RuntimeError, match="SMTPAuthenticationError") as error:
        notify.notify("guest@example.test", "Subject", "Body")
    assert "test-ses-smtp-secret" not in str(error.value)
    assert "AKIAEXAMPLEUSER" not in str(error.value)
    assert "TINA_SES_SMTP_USER" in flows_config.SECRETS
    assert "TINA_SES_SMTP_PASSWORD" in flows_config.SECRETS
