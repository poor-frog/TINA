"""Source-only Fargate entrypoint for authorized post-meeting drafts."""
import json
import os
import signal
from urllib.parse import quote

import redis

from shared.meeting_knowledge import PREFIX
from worker.engine import _run_meeting_knowledge, start_prompt


def main() -> None:
    # Bound provider work independently of the API connection and ECS task startup time.
    signal.alarm(90)
    start = json.loads(os.environ["TINA_START"])
    inline = start_prompt(start) or ""
    if not inline.startswith(PREFIX):
        raise ValueError("Missing draft entrypoint")
    payload = json.loads(inline[len(PREFIX):])
    if payload.keys() != {"request_id", "text"}:
        raise ValueError("Unexpected draft envelope")
    source = json.loads(payload["text"])
    if source.keys() != {"question", "sources"} or not 1 <= len(source["sources"]) <= 18:
        raise ValueError("Unexpected draft sources")
    if {entry["kind"] for entry in source["sources"]} != {"transcript", "document"}:
        raise ValueError("Draft requires transcript and document sources")

    host = os.environ["VALKEY_HOST"]
    password = quote(os.environ.pop("VALKEY_PASSWORD"), safe="")
    url = f"rediss://:{password}@{host}:6379/0?ssl_check_hostname=True&ssl_cert_reqs=required"
    with redis.from_url(url, decode_responses=True, socket_timeout=5, socket_connect_timeout=5) as client:
        _run_meeting_knowledge(client, os.environ["TINA_UNIT_OUT_TOPIC"], start)


if __name__ == "__main__":
    main()
