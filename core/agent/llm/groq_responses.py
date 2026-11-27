"""Worker-local compatibility boundary between Codex and Groq's Responses API.

Codex owns the agent loop, workspace sandbox and tool approvals. This proxy adapts
instruction roles and removes unsupported request features; it never adds a tool or forwards
to a caller-selected endpoint. The listener exists only for a harness turn.
"""
from __future__ import annotations

from contextlib import contextmanager
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
from typing import Iterator

import httpx

from llm.errors import LLMConfigError


GROQ_RESPONSES_URL = "https://api.groq.com/openai/v1/responses"
MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_ERROR_BYTES = 64 * 1024
_UNSUPPORTED_FIELDS = frozenset({
    "previous_response_id", "store", "truncation", "include", "safety_identifier",
    "prompt_cache_key", "prompt", "client_metadata",
})
_REACH_NAMESPACE = 'mcp__tina_reach'
_WORKSPACE_NAMESPACE = 'mcp__tina_workspace'
_FLATTENED_NAMESPACE_TOOLS: dict[str, tuple[str, str]] = {
    **{
        f'{_REACH_NAMESPACE}__reach_{channel}_{action}': (_REACH_NAMESPACE, f'reach_{channel}_{action}')
        for channel in ('web', 'github') for action in ('search', 'read')
    },
    **{
        f'{_WORKSPACE_NAMESPACE}__{tool}': (_WORKSPACE_NAMESPACE, tool)
        for tool in ('list_wiki', 'search_wiki', 'read_wiki', 'create_wiki', 'update_wiki', 'move_wiki', 'delete_wiki')
    },
}
_FLATTENED_NAMESPACES = frozenset({_REACH_NAMESPACE, _WORKSPACE_NAMESPACE})


def _reach_call(item, *, restore=False):
    if not isinstance(item, dict) or item.get('type') != 'function_call':
        return item
    if restore and item.get('name') in _FLATTENED_NAMESPACE_TOOLS:
        namespace, tool_name = _FLATTENED_NAMESPACE_TOOLS[item['name']]
        return item | {'name': tool_name, 'namespace': namespace}
    namespace = item.get('namespace')
    if not restore and namespace in _FLATTENED_NAMESPACES:
        name = f"{namespace}__{item.get('name')}"
        if name in _FLATTENED_NAMESPACE_TOOLS:
            return {k: v for k, v in (item | {'name': name}).items() if k != 'namespace'}
    return item


def restore_reach_event(body):
    """Restore the exact namespace selected by Codex, never introducing a new tool."""
    if not isinstance(body, dict): return body
    if isinstance(body.get('item'), dict): body = body | {'item': _reach_call(body['item'], restore=True)}
    response = body.get('response')
    if isinstance(response, dict) and isinstance(response.get('output'), list):
        body = body | {'response': response | {'output': [_reach_call(i, restore=True) for i in response['output']]}}
    return body


def sanitize_responses_request(payload: dict) -> dict:
    """Return Groq's supported subset without changing the original request.

    Groq does not persist response state; Codex already supplies conversation
    history in ``input``. Granted Reach and built-in ``tina-workspace`` MCP functions
    flatten their namespace for Groq; other namespace/custom/built-in tools are omitted.
    Grants still come from Codex.
    """
    cleaned = {key: value for key, value in payload.items() if key not in _UNSUPPORTED_FIELDS}
    if "tools" in cleaned:
        tools = cleaned["tools"]
        cleaned["tools"] = [dict(tool) for tool in tools
                            if isinstance(tool, dict) and tool.get("type") == "function"] \
            if isinstance(tools, list) else []
        for namespace in tools if isinstance(tools, list) else []:
            ns_name = namespace.get('name') if isinstance(namespace, dict) else None
            if not isinstance(namespace, dict) or namespace.get('type') != 'namespace' or ns_name not in _FLATTENED_NAMESPACES:
                continue
            functions = namespace.get('tools')
            for tool in functions if isinstance(functions, list) else []:
                if not isinstance(tool, dict) or tool.get('type') != 'function': continue
                name = f"{ns_name}__{tool.get('name')}"
                if name in _FLATTENED_NAMESPACE_TOOLS: cleaned['tools'].append(tool | {'name': name})
    if isinstance(cleaned.get('input'), list):
        cleaned['input'] = [_reach_call(item) for item in cleaned['input']]
    # Codex uses developer messages for workspace/sandbox instructions. Groq's
    # non-GPT-OSS chat templates (including Qwen) accept system, not developer.
    # Preserve their position, content and tool history; never turn them into user text.
    if not str(cleaned.get("model", "")).startswith("openai/gpt-oss-"):
        items = cleaned.get("input")
        if isinstance(items, list):
            cleaned["input"] = [
                {**item, "role": "system"}
                if isinstance(item, dict) and item.get("role") == "developer" else item
                for item in items
            ]
    # Auto applies even when Codex supplies its own default effort. Groq owns the default,
    # and non-reasoning models must never inherit a GPT-OSS-specific reasoning parameter.
    cleaned.pop("reasoning", None)
    # Groq's default GPT-OSS models support function calls but not parallel
    # calls. Serial execution also works for models that support both shapes.
    cleaned["parallel_tool_calls"] = False
    return cleaned


class _LoopbackServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False

    def handle_error(self, request, client_address) -> None:
        # Do not print request/exception details from the credential-bearing hop.
        pass


@contextmanager
def groq_responses_proxy(api_key: str, *,
                         transport: httpx.BaseTransport | None = None) -> Iterator[str]:
    """Yield an authenticated loopback base URL for one Codex harness turn.

    ``transport`` permits offline protocol tests. Production always uses the
    fixed HTTPS Groq endpoint with redirects and ambient proxy settings disabled.
    Incoming authentication is checked but never used to choose upstream auth.
    """
    if not api_key or any(ord(char) < 33 or ord(char) > 126 for char in api_key):
        raise LLMConfigError("A valid Groq API key is required for the Groq runner.")
    expected_auth = ("Bearer " + api_key).encode("ascii")
    client = httpx.Client(
        transport=transport, timeout=httpx.Timeout(120.0, connect=15.0),
        follow_redirects=False, trust_env=False,
    )

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(30.0)

        def log_message(self, format, *args) -> None:
            pass

        def _json_error(self, status: int, message: str) -> None:
            body = json.dumps({"error": {"message": message, "type": "groq_proxy_error"}}).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(body)
            self.wfile.flush()
            # A close with a tiny unread body can reset TCP before the client
            # receives this response (notably on Windows). Drain only bounded
            # small bodies, with a short deadline; never consume an oversized
            # upload just to refuse it.
            length = self.headers.get("Content-Length", "")
            if (not getattr(self, "_request_body_read", False) and length.isdigit()
                    and int(length) <= MAX_ERROR_BYTES):
                try:
                    self.connection.settimeout(0.25)
                    self.rfile.read(int(length))
                except (OSError, ValueError):
                    pass

        def do_GET(self) -> None:
            self._json_error(404, "Unknown Groq proxy endpoint.")

        def do_POST(self) -> None:
            headers_sent = False
            self.close_connection = True
            self._request_body_read = False
            try:
                if self.path != "/v1/responses":
                    self._json_error(404, "Unknown Groq proxy endpoint.")
                    return
                auth_values = self.headers.get_all("Authorization", [])
                supplied_auth = auth_values[0].encode("utf-8") if len(auth_values) == 1 else b""
                if not hmac.compare_digest(supplied_auth, expected_auth):
                    self._json_error(401, "Groq proxy authentication failed.")
                    return
                if self.headers.get("Transfer-Encoding"):
                    self._json_error(400, "A fixed request content length is required.")
                    return
                lengths = self.headers.get_all("Content-Length", [])
                if len(lengths) != 1 or not lengths[0].isdigit():
                    self._json_error(400, "A fixed request content length is required.")
                    return
                length = int(lengths[0])
                if length > MAX_REQUEST_BYTES:
                    self._json_error(413, "Groq request exceeds the proxy size limit.")
                    return
                try:
                    self._request_body_read = True
                    body = self.rfile.read(length)
                    if len(body) != length:
                        raise ValueError("incomplete body")
                    payload = json.loads(body)
                    if not isinstance(payload, dict):
                        raise ValueError("not an object")
                    payload = sanitize_responses_request(payload)
                except (ValueError, UnicodeError):
                    self._json_error(400, "Expected a JSON Responses request object.")
                    return
                with client.stream(
                    "POST", GROQ_RESPONSES_URL, json=payload,
                    headers={"Authorization": "Bearer " + api_key,
                             "Accept": "text/event-stream, application/json",
                             "Accept-Encoding": "identity"},
                ) as response:
                    if response.status_code >= 400:
                        error = bytearray()
                        for chunk in response.iter_bytes():
                            error.extend(chunk[:MAX_ERROR_BYTES + 1 - len(error)])
                            if len(error) > MAX_ERROR_BYTES:
                                break
                        if len(error) > MAX_ERROR_BYTES:
                            self._json_error(response.status_code, "Groq returned an oversized error response.")
                            return
                        data = bytes(error).replace(api_key.encode("ascii"), b"[REDACTED]")
                        self.send_response(response.status_code)
                        self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                        self.send_header("Content-Length", str(len(data)))
                        if retry_after := response.headers.get("Retry-After"):
                            self.send_header("Retry-After", retry_after)
                        self.send_header("Connection", "close")
                        self.end_headers()
                        headers_sent = True
                        self.wfile.write(data)
                        return
                    self.send_response(response.status_code)
                    self.send_header("Content-Type", response.headers.get("Content-Type", "text/event-stream"))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    headers_sent = True
                    if 'text/event-stream' in response.headers.get('Content-Type', ''):
                        for line in response.iter_lines():
                            if line.startswith('data:'):
                                try:
                                    event = json.loads(line[5:].strip())
                                    restored = restore_reach_event(event)
                                    if restored != event: line = 'data: ' + json.dumps(restored)
                                except ValueError: pass
                            self.wfile.write((line + '\n').encode('utf-8'))
                            self.wfile.flush()
                    else:
                        for chunk in response.iter_bytes():
                            self.wfile.write(chunk)
                            self.wfile.flush()
            except httpx.TimeoutException:
                if not headers_sent:
                    self._json_error(504, "Groq Responses endpoint timed out.")
            except (httpx.HTTPError, ValueError):
                if not headers_sent:
                    self._json_error(502, "Groq Responses endpoint is unavailable.")
            except (ConnectionError, OSError):
                # A cancelled harness turn closes its local response socket.
                pass

    try:
        server = _LoopbackServer(("127.0.0.1", 0), Handler)
    except BaseException:
        client.close()
        raise
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                              name="groq-responses-proxy", daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/v1"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2.0)
        client.close()
