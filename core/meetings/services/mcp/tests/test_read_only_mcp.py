import httpx
from fastapi.testclient import TestClient

from tina_mcp.app import create_app


def test_read_only_transport_exposes_three_tools_and_binds_session_to_owner(monkeypatch):
    monkeypatch.setenv("TINA_MCP_READ_ONLY", "1")
    monkeypatch.setenv("TINA_MCP_TRANSPORT_HOST", "mcp.test")
    monkeypatch.setenv("TINA_MCP_PUBLIC_ORIGIN", "https://tina.test")
    headers = {"Accept": "application/json, text/event-stream", "X-User-Id": "1", "X-User-Scopes": "tx",
               "X-API-Key": "resolved-key", "Authorization": "Bearer unused-key"}
    initialize = {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                  "params": {"protocolVersion": "2025-03-26", "capabilities": {},
                             "clientInfo": {"name": "fixture", "version": "1"}}}
    listing = {"jsonrpc": "2.0", "id": 2, "method": "tools/list"}
    def upstream(request):
        assert request.headers["X-API-Key"] == "resolved-key"
        return httpx.Response(200, json={"meetings": []})

    with TestClient(create_app(transport=httpx.MockTransport(upstream)), base_url="http://mcp.test") as client:
        assert client.post("/mcp", json=initialize).status_code == 403
        assert client.post("/mcp", json=initialize, headers=headers | {"Origin": "https://other.test"}).status_code == 403
        ready = client.post("/mcp", json=initialize, headers=headers)
        assert ready.status_code == 200
        session = headers | {"Mcp-Session-Id": ready.headers["mcp-session-id"]}
        client.post("/mcp", headers=session, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
        tools = client.post("/mcp", json=listing, headers=session).json()["result"]["tools"]
        assert {tool["name"] for tool in tools} == {"list_meetings", "search_transcripts", "get_meeting_transcript"}
        call = {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "list_meetings", "arguments": {}}}
        assert not client.post("/mcp", json=call, headers=session).json()["result"].get("isError")
        assert client.post("/mcp", json=listing, headers=session | {"X-User-Id": "2"}).status_code == 404
