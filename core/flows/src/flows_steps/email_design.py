"""Fill precompiled React Email templates with escaped meeting copy."""
from html import escape
import json
from pathlib import Path
from string import Template
from urllib.parse import urlsplit

TEMPLATES = Path(__file__).parent / "templates"
LOGO_CID = "tina-logo@tina"
LOGO_PATH = TEMPLATES / "tina-logo.png"


def render_followup(subject: str, meeting: str, body: str, summary_link: str,
                    recording_link: str, *, preview_notice: str = "") -> str:
    for link in (summary_link, recording_link):
        url = urlsplit(link)
        if url.scheme not in ("http", "https") or not url.netloc or url.username or url.password:
            raise ValueError("Email artifact links must be absolute HTTP(S) URLs")
    fragments = json.loads((TEMPLATES / "meeting-followup.parts.json").read_text(encoding="utf-8"))
    artifacts = {summary_link: "summary", recording_link: "recording"}
    blocks = []
    for paragraph in body.strip().split("\n\n"):
        url = next((line for line in paragraph.splitlines() if line in artifacts), None)
        if url:
            blocks.append(Template(fragments[artifacts[url]]).substitute(url=escape(url, quote=True)))
        else:
            text = escape(paragraph).replace("\n", "<br>")
            blocks.append(Template(fragments["paragraph"]).substitute(text=text))
    notice = Template(fragments["notice"]).substitute(text=escape(preview_notice)) if preview_notice else ""
    template = Template((TEMPLATES / "meeting-followup.html").read_text(encoding="utf-8"))
    return template.substitute(subject=escape(subject), meeting=escape(meeting), content="".join(blocks),
                               notice=notice, logo=f"cid:{LOGO_CID}")
