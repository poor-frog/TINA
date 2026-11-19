"""Pinned Codex → Groq adapter → tool → follow-up, without a network or real key.

Run in the worker image with its Codex seccomp settings by setting
``TINA_CODEX_WORKER_WIRE_TEST=1``. A host Codex binary does not prove that the
worker's pinned CLI and sandbox are available. The upstream stub checks the
real CLI request, not a hand-written approximation of the developer messages.
"""
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import httpx

from llm.codex import CodexHarness
from llm.groq_responses import groq_responses_proxy


def _stream_response(item):
    def event(name, **body):
        return f"event: {name}\ndata: " + json.dumps({"type": name, **body}) + "\n\n"

    response = {"id": "resp_wire", "object": "response", "model": "qwen/qwen3.8-27b",
                "status": "in_progress", "output": []}
    wire = event("response.created", response=response)
    if item["type"] == "function_call":
        wire += event("response.output_item.added", output_index=0, item={**item, "arguments": ""})
        wire += event("response.function_call_arguments.delta", output_index=0,
                      item_id=item["id"], delta=item["arguments"])
        wire += event("response.function_call_arguments.done", output_index=0,
                      item_id=item["id"], arguments=item["arguments"])
    else:
        part = item["content"][0]
        wire += event("response.output_item.added", output_index=0, item={**item, "content": []})
        wire += event("response.content_part.added", output_index=0, content_index=0,
                      item_id=item["id"], part={**part, "text": ""})
        wire += event("response.output_text.delta", output_index=0, content_index=0,
                      item_id=item["id"], delta=part["text"])
        wire += event("response.output_text.done", output_index=0, content_index=0,
                      item_id=item["id"], text=part["text"])
        wire += event("response.content_part.done", output_index=0, content_index=0,
                      item_id=item["id"], part=part)
    wire += event("response.output_item.done", output_index=0, item=item)
    wire += event("response.completed", response={**response, "status": "completed", "output": [item],
                  "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15}})
    return httpx.Response(200, headers={"Content-Type": "text/event-stream"}, content=wire)


@unittest.skipUnless(shutil.which("codex") and sys.platform == "linux"
                     and os.environ.get("TINA_CODEX_WORKER_WIRE_TEST") == "1",
                     "requires the pinned worker CLI with the worker's Codex sandbox settings")
class GroqCliWireTest(unittest.TestCase):
    def test_qwen_agent_keeps_instructions_and_consumes_real_read_tool_result(self):
        requests = []
        nonce = "groq-read-tool-round-trip"

        def upstream(request):
            payload = json.loads(request.content)
            requests.append(payload)
            self.assertEqual(str(request.url), "https://api.groq.com/openai/v1/responses")
            self.assertEqual(request.headers["Authorization"], "Bearer dummy-offline-key")
            self.assertNotIn("reasoning", payload)
            self.assertNotIn("apply_patch", payload.get("instructions", ""))
            self.assertIn("You are TINA", payload.get("instructions", ""))
            self.assertTrue(all(tool.get("type") == "function" for tool in payload["tools"]))
            self.assertFalse(any(tool.get("name") == "apply_patch" for tool in payload["tools"]))
            roles = [item.get("role") for item in payload["input"]]
            self.assertIn("system", roles)
            self.assertNotIn("developer", roles)
            if len(requests) == 1:
                self.assertTrue(any(tool["name"] == "exec_command" for tool in payload["tools"]))
                return _stream_response({"id": "fc_wire", "type": "function_call", "status": "completed",
                    "call_id": "call_wire", "name": "exec_command",
                    "arguments": json.dumps({"cmd": "cat note.txt", "workdir": str(work), "max_output_tokens": 100})})
            outputs = [item for item in payload["input"] if item.get("type") == "function_call_output"]
            self.assertTrue(any(item.get("call_id") == "call_wire" and nonce in str(item.get("output"))
                                for item in outputs), outputs)
            return _stream_response({"id": "msg_wire", "type": "message", "role": "assistant",
                "status": "completed", "content": [{"type": "output_text", "text": nonce, "annotations": []}]})

        proxy = groq_responses_proxy
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "TINA_CODEX_AUTH_MODE": "groq", "TINA_LLM_API_KEY": "dummy-offline-key",
            "TINA_AGENT_EFFORT": "xhigh", "TINA_MOUNTS": "[]",
        }), patch("llm.groq_responses.groq_responses_proxy",
                  lambda key: proxy(key, transport=httpx.MockTransport(upstream))):
            work = Path(directory)
            (work / "note.txt").write_text(nonce)
            (work / "CLAUDE.md").write_text("Read-only workspace. Preserve these instructions.")
            harness = CodexHarness()
            harness.prepare(work)
            events = list(harness.run_turn(work, "Read note.txt and reply with its content.",
                                          model="qwen/qwen3.8-27b", allowed_tools=["Read"]))
            done = next(event for event in reversed(events) if event["type"] == "done")
            self.assertTrue(done["ok"], done.get("reply"))
            self.assertEqual(done["reply"], nonce)
            self.assertEqual(len(requests), 2)


if __name__ == "__main__":
    unittest.main()
