"""The outbound-channel PORT — what a recipe says, not how it travels.

Steps used to call ``emailx.send`` by name, so every recipe in ``flows_defs`` hard-coded SMTP:
the sentence "tell this person X" could not be written without also deciding that telling means
mail. That is the wrong seam. A step's business is WHO to tell, WHAT to say, and the ONE link
that carries them onward; which channel delivers it is a deployment fact, exactly like the SMTP
host ``emailx`` already reads from the environment.

``notify(person, subject, body, link=...)`` selects the deployment's delivery adapter:
``SmtpNotifier`` for the existing mailbox transport, or ``ResendNotifier`` for authenticated
Resend SMTPS. Both keep the same MIME message and thread handle; recipes do not change.

Mirrors ``core/agent/llm/ports.py``'s ``HarnessPort``: a Protocol, a concrete adapter, and a
module-level selector — the same shape the agent tier already uses for its swappable runner.
"""
from __future__ import annotations

import os
from typing import Optional, Protocol


class NotifyPort(Protocol):
    """One outbound message to one person.

    ``link`` is the message's single call to action — passed apart from ``body`` because a
    channel renders it differently (SMTP appends a line; a chat transport would attach a button),
    and because a step that hands over a URL should not also decide its typography.

    ``in_reply_to`` is an opaque per-channel conversation handle — a Message-ID over SMTP, a
    thread id elsewhere. Returns the handle of the message just sent, which the caller registers
    in ``mail_thread`` so replies route by THREAD (the wrong-mail-answered-onboarding lesson).
    """

    name: str

    def send(self, to: str, subject: str, body: str, *, link: Optional[str] = None,
             in_reply_to: Optional[str] = None, html_body: Optional[str] = None) -> str: ...


def compose(body: str, link: Optional[str]) -> str:
    """Body plus the one line that is the call to action.

    Deliberately not a template: the link is the LAST thing in the message and its own paragraph,
    because a URL buried mid-paragraph is a URL nobody clicks. A body that already ends in the
    link is left alone — a step that composed its own is not overridden here.
    """
    body = (body or "").rstrip()
    if not link:
        return body + "\n"
    if link in body:
        return body + "\n"
    return f"{body}\n\n{link}\n"


class SmtpNotifier:
    """Real SMTP via ``emailx``, which already resolves host, port
    and From from the environment (``TINA_MAIL_SMTP_HOST`` / ``_PORT`` / ``TINA_MAIL_ADDR``).
    This class adds no transport of its own — it exists so the recipes stop naming one."""

    name = "smtp"

    def send(self, to: str, subject: str, body: str, *, link: Optional[str] = None,
             in_reply_to: Optional[str] = None, html_body: Optional[str] = None) -> str:
        from . import emailx as mx
        if html_body is not None:
            return mx.send(to, subject, compose(body, link), in_reply_to=in_reply_to, html_body=html_body)
        return mx.send(to, subject, compose(body, link), in_reply_to=in_reply_to)


class ResendNotifier:
    """Resend's SMTP endpoint keeps HTML, inline logo and RFC Message-ID threading intact."""

    name = "resend"

    def send(self, to: str, subject: str, body: str, *, link: Optional[str] = None,
             in_reply_to: Optional[str] = None, html_body: Optional[str] = None) -> str:
        from . import emailx as mx
        return mx.send_resend(to, subject, compose(body, link), in_reply_to=in_reply_to, html_body=html_body)


class SesNotifier:
    """Amazon SES SMTPS endpoint keeps HTML, inline logo and RFC Message-ID threading intact."""

    name = "ses"

    def send(self, to: str, subject: str, body: str, *, link: Optional[str] = None,
             in_reply_to: Optional[str] = None, html_body: Optional[str] = None) -> str:
        from . import emailx as mx
        return mx.send_ses(to, subject, compose(body, link), in_reply_to=in_reply_to, html_body=html_body)


_CHANNEL: Optional[NotifyPort] = None


def channel() -> NotifyPort:
    """The process's outbound channel. Env-selected so a deployment, not a recipe, decides:
    ``TINA_NOTIFY_CHANNEL`` names it; unsupported channels are refused loudly rather than
    silently falling back, because a notification that quietly went nowhere is the worst
    failure this module can have."""
    global _CHANNEL
    if _CHANNEL is None:
        want = os.environ.get("TINA_NOTIFY_CHANNEL", "smtp").strip().lower()
        if want == "smtp":
            _CHANNEL = SmtpNotifier()
        elif want == "resend":
            _CHANNEL = ResendNotifier()
        elif want == "ses":
            _CHANNEL = SesNotifier()
        else:
            raise ValueError(f"unknown notify channel {want!r} — choose 'smtp', 'resend', or 'ses'")
    return _CHANNEL


def use(port: Optional[NotifyPort]) -> None:
    """Install a channel (fixtures, the storm, a future transport). ``None`` restores the
    env-selected default on the next call."""
    global _CHANNEL
    _CHANNEL = port


def notify(person: str, subject: str, body: str, *, link: Optional[str] = None,
           in_reply_to: Optional[str] = None, html_body: Optional[str] = None) -> str:
    """Tell one person one thing. Returns the channel's handle for the message sent."""
    if html_body is not None:
        return channel().send(person, subject, body, link=link, in_reply_to=in_reply_to, html_body=html_body)
    return channel().send(person, subject, body, link=link, in_reply_to=in_reply_to)
