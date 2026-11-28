"""Run the existing meeting-knowledge worker with stdin and local output (one-shot or warm daemon)."""

import json
import os
import sys
import tempfile

from shared.units import MEETING_KNOWLEDGE_PREFIX
from worker.engine import _run_meeting_knowledge


class Output:
    def __init__(self, sink=None):
        self._sink = sink

    def xadd(self, topic, row):
        event = json.loads(row["event"])
        if event["type"] == "message-delta":
            if self._sink is not None:
                self._sink.append(event["text"])
            else:
                sys.stdout.write(event["text"])

    def expire(self, topic, seconds):
        pass


def _prewarm_imports() -> None:
    """Import heavy runtime modules once when starting a warm voice worker process."""
    try:
        import httpx  # noqa: F401
        import jsonschema  # noqa: F401
        import redis  # noqa: F401
        import llm.errors  # noqa: F401
        import llm.registry  # noqa: F401
        import shared.voice_knowledge  # noqa: F401
        if (os.environ.get("TINA_LLM_PROVIDER") or "").strip() == "bedrock-converse":
            import boto3  # noqa: F401
            import llm.bedrock_converse  # noqa: F401
    except Exception:
        pass


def _run_daemon() -> None:
    _prewarm_imports()
    proto_fd = os.dup(1)
    proto_out = os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
    saved_err_fd = os.dup(2)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            out_chunks: list[str] = []
            stderr_text = ""
            returncode = 0
            try:
                req = json.loads(line)
                payload = req["payload"]
                session = req["session"]
                inline = MEETING_KNOWLEDGE_PREFIX + json.dumps(payload, ensure_ascii=False)
            except Exception as exc:
                proto_out.write(json.dumps({
                    "stdout": "",
                    "stderr": f"{type(exc).__name__}\n",
                    "returncode": 1,
                }, ensure_ascii=False) + "\n")
                proto_out.flush()
                continue

            with tempfile.TemporaryFile(mode="w+b") as err_file:
                os.environ["TINA_CHAT_SESSION"] = session
                sys.stderr.flush()
                os.dup2(err_file.fileno(), 2)
                try:
                    _run_meeting_knowledge(Output(out_chunks), "local", {"entrypoint": {"inline": inline}})
                except Exception as exc:
                    returncode = 1
                    try:
                        os.write(2, f"{type(exc).__name__}\n".encode("ascii", errors="replace"))
                    except OSError:
                        pass
                finally:
                    sys.stderr.flush()
                    os.dup2(saved_err_fd, 2)
                    os.environ.pop("TINA_CHAT_SESSION", None)
                err_file.seek(0)
                stderr_text = err_file.read(262_144).decode("utf-8", errors="replace")

            proto_out.write(json.dumps({
                "stdout": "".join(out_chunks),
                "stderr": stderr_text,
                "returncode": returncode,
            }, ensure_ascii=False) + "\n")
            proto_out.flush()
    finally:
        os.close(saved_err_fd)
        proto_out.close()


if __name__ == "__main__":
    if "--daemon" in sys.argv[1:]:
        _run_daemon()
    else:
        payload = json.load(sys.stdin)
        inline = MEETING_KNOWLEDGE_PREFIX + json.dumps(payload, ensure_ascii=False)
        _run_meeting_knowledge(Output(), "local", {"entrypoint": {"inline": inline}})
