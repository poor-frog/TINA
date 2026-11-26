"""Bounded, content-free ASR timings; all durations use monotonic clocks."""
import math
import time
from collections import deque

SOURCES = {"meeting-bot", "extension", "dictation", "unknown"}
TIMINGS = ("audio_ms", "capture_ms", "queue_ms", "inference_ms", "total_ms")


def duration(value):
    try:
        number = float(value)
    except (ValueError, TypeError):
        return None
    return round(number, 3) if math.isfinite(number) and 0 <= number <= 3_600_000 else None


class AsrMetrics:
    def __init__(self):
        self.started_at_ms = int(time.time() * 1000)
        self.recent = deque(maxlen=100)
        self.total = 0
        self.errors = 0

    def record(self, sample):
        self.total += 1
        self.errors += int(not 200 <= sample["http_status"] < 300)
        self.recent.append({
            "request_id": sample["request_id"],
            "at_ms": sample["at_ms"],
            "source": sample["source"] if sample["source"] in SOURCES else "unknown",
            "http_status": sample["http_status"],
            **{key: duration(sample.get(key)) for key in TIMINGS},
        })

    def snapshot(self):
        latency = {}
        for key in TIMINGS:
            values = sorted(row[key] for row in self.recent if row[key] is not None)
            latency[key] = {
                "count": len(values),
                "p50_ms": values[math.ceil(len(values) * .5) - 1] if values else None,
                "p95_ms": values[math.ceil(len(values) * .95) - 1] if values else None,
            }
        return {
            "started_at_ms": self.started_at_ms,
            "requests": {"total": self.total, "errors": self.errors},
            "latency": latency,
            "recent": list(reversed(self.recent)),
        }
