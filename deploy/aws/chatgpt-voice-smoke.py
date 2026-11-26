"""Verify the ChatGPT plan pilot with a synthetic, lease-bound transcript on ECS."""

import json
import os
import time
from urllib.parse import quote
from uuid import uuid4

import redis
from control_plane.meeting_voice_completion import complete

password = quote(os.environ["VALKEY_PASSWORD"], safe="")
url = f"rediss://:{password}@{os.environ['VALKEY_HOST']}:6379/0"
request_id = uuid4().hex
meeting_id = int(request_id[:7], 16) + 2_000_000_000
holder = f"chatgpt-plan-smoke:{request_id}"
key = f"meeting:voice:{meeting_id}:lock"
payload = {"request_id": request_id, "voice_turn": {"meeting_id": meeting_id, "holder": holder}}
source = {
    "mode": "voice", "question": "Ai phụ trách kiểm thử?",
    "sources": [{"id": "s0", "quote": "Bảo phụ trách phần kiểm thử."}], "tools_remaining": 0,
}

with redis.from_url(url, socket_timeout=2, socket_connect_timeout=2) as connection:
    assert connection.set(key, holder, nx=True, ex=60)
    try:
        start = time.monotonic()
        result = json.loads(complete(
            payload | {"text": json.dumps(source, ensure_ascii=False)}, source, url, chatgpt_plan=True,
        ))
        assert "approved" in result["verification"]
        assert any("bảo" in claim["text"].lower() and "s0" in claim["source_ids"] for claim in result["claims"])
        print(f"ChatGPT plan grounded answer verified in {time.monotonic()-start:.2f} s", flush=True)
    finally:
        connection.eval(
            "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end",
            1, key, holder,
        )
