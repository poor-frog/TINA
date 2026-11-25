"""Run a single tool-less CompletionPort job locally via stdin/stdout."""
from __future__ import annotations

import json
import sys


class _LocalOutput:
    def __init__(self) -> None:
        self.parts: list[str] = []
        self.complete = False
        self.translation_error: str | None = None

    def xadd(self, _topic: str, row: dict) -> None:
        event = json.loads(row["event"])
        kind = event.get("type")
        if kind == "message-delta":
            text = event.get("text")
            if isinstance(text, str):
                self.parts.append(text)
        elif kind == "turn-complete":
            self.complete = True
            err = event.get("translation_error")
            if isinstance(err, str):
                self.translation_error = err

    def expire(self, _topic: str, _seconds: int) -> None:
        pass


def run_job(task: str, inline: str) -> dict:
    from worker import engine

    output = _LocalOutput()
    start = {"entrypoint": {"inline": inline}}
    if task == "polish":
        engine._run_dictation_polish(output, "local", start)
    elif task == "translate":
        engine._run_dictation_translate(output, "local", start)
    elif task == "knowledge":
        engine._run_meeting_knowledge(output, "local", start)
    elif task == "discussion":
        from worker.discussion_review import run as run_discussion_review
        run_discussion_review(output, "local", start)
    else:
        raise ValueError(f"Unsupported local completion task: {task}")
    result: dict = {"text": "".join(output.parts), "complete": output.complete}
    if output.translation_error is not None:
        result["translation_error"] = output.translation_error
    return result


if __name__ == "__main__":
    request = json.load(sys.stdin)
    envelope = run_job(request["task"], request["inline"])
    sys.stdout.write(json.dumps(envelope, ensure_ascii=False))
