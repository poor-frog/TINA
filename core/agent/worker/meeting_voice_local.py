"""Run the existing meeting-knowledge worker with stdin and local output."""

import json
import sys

from shared.units import MEETING_KNOWLEDGE_PREFIX
from worker.engine import _run_meeting_knowledge


class Output:
    def xadd(self, topic, row):
        event = json.loads(row["event"])
        if event["type"] == "message-delta":
            sys.stdout.write(event["text"])

    def expire(self, topic, seconds):
        pass


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    inline = MEETING_KNOWLEDGE_PREFIX + json.dumps(payload, ensure_ascii=False)
    _run_meeting_knowledge(Output(), "local", {"entrypoint": {"inline": inline}})
