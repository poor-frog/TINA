"""Unit and stdio integration tests for the scoped tina-workspace MCP server."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from llm import workspace_mcp
from llm.groq_responses import restore_reach_event, sanitize_responses_request


def _seed_mounts(tmp_path: Path) -> tuple[Path, Path, Path, list[dict]]:
    private = tmp_path / "2"
    global_dir = tmp_path / "_global"
    system_dir = tmp_path / "_system"
    (private / "kg" / "entities" / "person").mkdir(parents=True)
    (private / "kg" / "entities" / "meeting").mkdir(parents=True)
    (private / "policy").mkdir(parents=True)
    (private / ".git").mkdir(parents=True)
    (private / "README.md").write_text("# My Space\nPrivate notes.\n", encoding="utf-8")
    (private / "onboarding.md").write_text("# Onboarding\nWelcome to TINA.\n", encoding="utf-8")
    (private / "kg" / "entities" / "person" / "jane-liu.md").write_text(
        "---\ntype: person\nid: person-jane-liu\ntitle: Jane Liu\n---\n\n"
        "# Jane Liu\nVP of Engineering at [[Acme Corp]]. Met during [[Acme intro call]].\n",
        encoding="utf-8",
    )
    (private / "kg" / "entities" / "meeting" / "2026-06-12-acme-intro.md").write_text(
        "---\ntype: meeting\nid: meeting-acme-intro\ntitle: Acme intro call\n---\n\n"
        "# Acme intro call\nIntro call with [[Jane Liu]].\n",
        encoding="utf-8",
    )
    (private / "policy" / "members.md").write_text("# Policy\nrestricted\n", encoding="utf-8")
    (private / ".git" / "config").write_text("[core]\n", encoding="utf-8")

    (global_dir / "docs").mkdir(parents=True)
    (global_dir / "README.md").write_text("# Global KB\n", encoding="utf-8")
    (global_dir / "CLAUDE.md").write_text("Global instructions\n", encoding="utf-8")
    (global_dir / "docs" / "guide.md").write_text("# Guide\nShared guide.\n", encoding="utf-8")

    (system_dir / ".codex").mkdir(parents=True)
    (system_dir / "kg").mkdir(parents=True)
    (system_dir / "kg" / "secret.md").write_text("# System secret\n", encoding="utf-8")

    raw_mounts = [
        {"slug": "2", "path": str(private), "role": "private", "write": True, "primary": True},
        {"slug": "_global", "path": str(global_dir), "role": "global", "write": False},
        {"slug": "_system", "path": str(system_dir), "role": "system", "write": True},
    ]
    return private, global_dir, system_dir, raw_mounts


def test_workspace_mcp_stdio_round_trip_with_scrubbed_pythonpath(tmp_path: Path):
    private, _global_dir, _system_dir, raw_mounts = _seed_mounts(tmp_path)
    mounts_file = tmp_path / "mounts.json"
    mounts_file.write_text(json.dumps(raw_mounts), encoding="utf-8")

    messages = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2024-11-05"}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {"jsonrpc": "2.0", "id": 3, "method": "resources/list"},
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "search_wiki", "arguments": {"query": "Jane Liu", "workspace": "*"},
        }},
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {
            "name": "read_wiki", "arguments": {"workspace": "2", "path": "kg/entities/person/jane-liu.md"},
        }},
        {"jsonrpc": "2.0", "id": 6, "method": "resources/read", "params": {
            "uri": "tina-workspace://2/kg/entities/person/jane-liu.md",
        }},
        {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {
            "name": "create_wiki", "arguments": {
                "workspace": "2",
                "path": "notes/summary.md",
                "text": "# Summary\nJane Liu leads engineering at Acme Corp.\n",
            },
        }},
        {"jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": {
            "name": "update_wiki", "arguments": {
                "workspace": "2",
                "path": "notes/summary.md",
                "mode": "append",
                "text": "Follow-up scheduled.",
            },
        }},
        {"jsonrpc": "2.0", "id": 9, "method": "tools/call", "params": {
            "name": "move_wiki", "arguments": {
                "workspace": "2",
                "path": "notes/summary.md",
                "destination": "notes/jane-summary.md",
            },
        }},
        {"jsonrpc": "2.0", "id": 10, "method": "tools/call", "params": {
            "name": "delete_wiki", "arguments": {
                "workspace": "2",
                "path": "notes/jane-summary.md",
            },
        }},
    ]
    run = subprocess.run(
        [
            sys.executable,
            str(Path(workspace_mcp.__file__).resolve()),
            "--mounts-file", str(mounts_file),
            "--tools", *workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS,
        ],
        cwd=private,
        env={"PATH": os.defpath},
        input="".join(json.dumps(m) + "\n" for m in messages),
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert run.returncode == 0, run.stderr
    by_id = {row["id"]: row["result"] for row in (json.loads(line) for line in run.stdout.splitlines())}

    assert by_id[1]["serverInfo"]["name"] == "tina-workspace"
    assert "tools" in by_id[1]["capabilities"] and "resources" in by_id[1]["capabilities"]

    tool_names = [t["name"] for t in by_id[2]["tools"]]
    assert set(tool_names) == set(workspace_mcp.READ_TOOLS) | set(workspace_mcp.WRITE_TOOLS)
    assert all(t["annotations"]["openWorldHint"] is False for t in by_id[2]["tools"])

    uris = [r["uri"] for r in by_id[3]["resources"]]
    assert "tina-workspace://2/kg/entities/person/jane-liu.md" in uris
    assert "tina-workspace://_global/docs/guide.md" in uris
    assert not any("_system" in uri or "policy/" in uri or ".git/" in uri for uri in uris)

    search_payload = json.loads(by_id[4]["content"][0]["text"])
    assert by_id[4]["isError"] is False
    assert any(m["path"] == "kg/entities/person/jane-liu.md" for m in search_payload["matches"])

    read_payload = json.loads(by_id[5]["content"][0]["text"])
    assert "VP of Engineering" in read_payload["text"]
    assert "VP of Engineering" in by_id[6]["contents"][0]["text"]

    assert by_id[7]["isError"] is False
    assert by_id[8]["isError"] is False
    assert by_id[9]["isError"] is False
    assert by_id[10]["isError"] is False
    assert not (private / "notes" / "summary.md").exists()
    assert not (private / "notes" / "jane-summary.md").exists()


def test_workspace_mcp_enforces_readonly_security_and_frontmatter(tmp_path: Path):
    private, _global_dir, _system_dir, raw_mounts = _seed_mounts(tmp_path)
    outside = tmp_path / "secret.md"
    outside.write_text("TOP SECRET", encoding="utf-8")
    (private / "kg" / "escape.md").symlink_to(outside)

    mounts = workspace_mcp.load_mounts(raw_mounts, read_only=False)
    assert "_system" not in mounts
    assert mounts["2"]["write"] is True
    assert mounts["_global"]["write"] is False

    # onboarding.md is readable (matches Pages & Notes UI) but remains non-writable.
    onboarding_read = workspace_mcp.handle(
        {"method": "tools/call", "params": {
            "name": "read_wiki", "arguments": {"workspace": "2", "path": "onboarding.md"},
        }},
        mounts,
        (*workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS),
    )
    assert onboarding_read["isError"] is False
    assert "Welcome to TINA." in onboarding_read["content"][0]["text"]
    onboarding_write = workspace_mcp.handle(
        {"method": "tools/call", "params": {
            "name": "update_wiki", "arguments": {
                "workspace": "2", "path": "onboarding.md", "mode": "append", "text": "denied",
            },
        }},
        mounts,
        (*workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS),
    )
    assert onboarding_write["isError"] is True

    # Symlink escape, policy/, and _global write are all denied.
    for call in (
        {"name": "read_wiki", "arguments": {"workspace": "2", "path": "kg/escape.md"}},
        {"name": "read_wiki", "arguments": {"workspace": "2", "path": "policy/members.md"}},
        {"name": "read_wiki", "arguments": {"workspace": "2", "path": "../secret.md"}},
        {"name": "read_wiki", "arguments": {"workspace": "_system", "path": "kg/secret.md"}},
        {"name": "create_wiki", "arguments": {"workspace": "_global", "path": "docs/new.md", "text": "# No"}},
        {"name": "create_wiki", "arguments": {
            "workspace": "2", "path": "kg/entities/person/bad.md", "text": "# Missing frontmatter",
        }},
    ):
        res = workspace_mcp.handle(
            {"method": "tools/call", "params": call},
            mounts,
            (*workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS),
        )
        assert res["isError"] is True, call

    # --readonly hides and rejects write tools even if listed in allowed.
    ro_mounts = workspace_mcp.load_mounts(raw_mounts, read_only=True)
    assert ro_mounts["2"]["write"] is False
    ro_tools = workspace_mcp.handle(
        {"method": "tools/list"},
        ro_mounts,
        (*workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS),
        read_only=True,
    )["tools"]
    assert [t["name"] for t in ro_tools] == list(workspace_mcp.READ_TOOLS)
    with pytest.raises(ValueError):
        workspace_mcp.handle(
            {"method": "tools/call", "params": {
                "name": "create_wiki",
                "arguments": {"workspace": "2", "path": "notes/no.md", "text": "# Blocked"},
            }},
            ro_mounts,
            (*workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS),
            read_only=True,
        )

    # Write budget cap stops runaway mutations cleanly.
    state = {"writes": workspace_mcp._MAX_WRITES_PER_SESSION}
    capped = workspace_mcp.handle(
        {"method": "tools/call", "params": {
            "name": "create_wiki",
            "arguments": {"workspace": "2", "path": "notes/capped.md", "text": "# Capped"},
        }},
        mounts,
        (*workspace_mcp.READ_TOOLS, *workspace_mcp.WRITE_TOOLS),
        state=state,
    )
    assert capped["isError"] is True
    assert "Write limit" in capped["content"][0]["text"]


def test_groq_workspace_mcp_namespace_round_trip():
    fn = {"type": "function", "name": "search_wiki", "parameters": {"type": "object"}}
    call = {
        "type": "function_call",
        "namespace": "mcp__tina_workspace",
        "name": "search_wiki",
        "call_id": "call-ws-1",
        "arguments": '{"query":"Jane Liu","workspace":"*"}',
    }
    original = {
        "tools": [
            {"type": "namespace", "name": "mcp__tina_workspace", "tools": [fn]},
            {"type": "namespace", "name": "unknown_ns", "tools": [fn]},
        ],
        "input": [call],
    }
    clean = sanitize_responses_request(original)
    flat = "mcp__tina_workspace__search_wiki"
    assert [t["name"] for t in clean["tools"]] == [flat]
    assert clean["input"][0]["name"] == flat and "namespace" not in clean["input"][0]
    restored = restore_reach_event({"type": "response.output_item.done", "item": clean["input"][0]})
    assert restored["item"] == call
    assert restore_reach_event({"response": {"output": [clean["input"][0]]}})["response"]["output"] == [call]
