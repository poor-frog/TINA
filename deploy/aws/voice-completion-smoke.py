"""Check the deployed voice worker's role and Redis lease using synthetic data."""

import json
import os
import time
from urllib.parse import quote
from uuid import uuid4

from fastapi import HTTPException
import redis

from control_plane.meeting_voice_completion import complete

host = os.environ["VALKEY_HOST"]
password = quote(os.environ["VALKEY_PASSWORD"], safe="")
url = f"rediss://:{password}@{host}:6379/0"
client = redis.from_url(url, socket_connect_timeout=3, socket_timeout=3)
request_id = uuid4().hex
meeting_id = int(request_id[:7], 16) + 1_000_000_000
key = f"meeting:voice:{meeting_id}:lock"
holder = "staging-voice-smoke:" + request_id
source = {
    "mode": "voice_source_intent",
    "question": "Trong cuộc họp, ai phụ trách phần thử nghiệm?",
}
payload = {
    "request_id": request_id,
    "text": json.dumps(source, ensure_ascii=False),
    "voice_turn": {"meeting_id": meeting_id, "holder": holder},
}
assert client.set(key, holder, nx=True, ex=120)
try:
    start = time.monotonic()
    answer = json.loads(complete(payload, source, url))
    elapsed = time.monotonic() - start
    assert answer == {"route": "meeting"}, answer.keys()
    print(f"Voice intent + Bedrock Nova Lite passed in {elapsed:.2f}s", flush=True)
    source = {
        "mode": "voice", "question": "Ai làm bản demo?",
        "sources": [{"id": "s0", "quote": "Lan làm bản demo."}], "tools_remaining": 0,
    }
    start = time.monotonic()
    output = json.loads(complete(payload | {"text": json.dumps(source, ensure_ascii=False)}, source, url))
    assert any("lan" in row["text"].lower() and "s0" in row["source_ids"] for row in output["claims"])
    print(f"Grounded voice answer + verification passed in {time.monotonic() - start:.2f}s", flush=True)
    try:
        complete(payload, source | {"use_sandbox_agent": True}, url)
    except HTTPException as exc:
        assert exc.status_code == 409
    else:
        raise AssertionError("A sandbox request reached the transcript-only worker")
finally:
    client.eval("if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
                1, key, holder)
    client.close()
