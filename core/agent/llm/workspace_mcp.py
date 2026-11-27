"""Scoped stdio MCP server exposing bounded TINA workspace Markdown tools.

Used when the host container cannot create Linux user namespaces (for example AWS ECS Fargate),
so Codex disables its shell sandbox and interacts with authorized workspace mounts exclusively
through this server's allowlisted, symlink-safe, mount-scoped Markdown operations.
"""
from __future__ import annotations

import argparse
import functools
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Iterable
from urllib.parse import quote, unquote

# Harnesses scrub PYTHONPATH; this installed bridge must also launch from a workspace cwd.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from llm.bedrock_workspace import (
    _WRITE_TOOLS,
    _extract_title,
    _iter_workspace_files,
    _read_regular_file,
    _wiki_parent,
    _wiki_tool,
)

_MAX_RPC_LINE_BYTES = 131072
_MAX_WRITES_PER_SESSION = 16
_MAX_RESOURCES = 100
_RESOURCE_PREFIX = "tina-workspace://"
SERVER_NAME = "tina-workspace"

READ_TOOLS: tuple[str, ...] = ("list_wiki", "search_wiki", "read_wiki")
WRITE_TOOLS: tuple[str, ...] = ("create_wiki", "update_wiki", "move_wiki", "delete_wiki")


@functools.lru_cache(maxsize=1)
def _probe_linux_userns() -> bool:
    """Check once in a short-lived child whether Linux unprivileged user+mount namespaces work."""
    probe = (
        "import ctypes, sys; "
        "libc = ctypes.CDLL(None, use_errno=True); "
        "sys.exit(0 if libc.unshare(0x10000000 | 0x00020000) == 0 else 1)"
    )
    try:
        result = subprocess.run(
            [sys.executable, "-c", probe],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=False,
        )
        return result.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def shell_sandbox_available(*, mocked_runner: bool = False) -> bool:
    """Return False when the container runtime blocks Linux user namespaces (e.g. AWS ECS Fargate)."""
    if (
        os.environ.get("TINA_WORKSPACE_SYNC_SIDECAR") == "1"
        or os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
        or os.environ.get("ECS_CONTAINER_METADATA_URI")
    ):
        return False
    if sys.platform != "linux":
        return True
    if mocked_runner:
        return True
    return _probe_linux_userns()


def select_workspace_tools(allowed: Iterable[str], *, read_only: bool) -> list[str]:
    """Select allowed workspace MCP tools matching TINA's turn policy."""
    granted = set(allowed)
    selected: list[str] = []
    if {"Read", "Glob", "Grep", "Bash"}.intersection(granted):
        selected.extend(READ_TOOLS)
    if not read_only and {"Write", "Edit"}.intersection(granted):
        selected.extend(WRITE_TOOLS)
    return selected


def build_server_spec(mounts_file: Path, tools: list[str], *, read_only: bool) -> dict:
    """Return the stdio MCP server descriptor launching workspace_mcp.py for one turn."""
    args = [
        "-B",
        str(Path(__file__).resolve()),
        "--mounts-file", str(mounts_file),
        "--tools", *tools,
    ]
    if read_only:
        args.append("--readonly")
    return {"command": sys.executable, "args": args}


def workspace_mcp_instructions(
    mounts: dict[str, dict],
    tools: list[str],
    *,
    read_only: bool,
) -> str:
    """Concise guidance telling a CLI harness to use tina-workspace MCP instead of shell tools."""
    mount_summary = ", ".join(
        f"'{slug}' ({m.get('role')}, {'writable' if m.get('write') else 'read-only'})"
        for slug, m in mounts.items()
    )
    tool_list = ", ".join(tools)
    mode_note = (
        "This turn is read-only; do not attempt to modify files."
        if read_only
        else (
            "For writes, use create_wiki, update_wiki (mode='append' or 'replace' after read_wiki), "
            "move_wiki, or delete_wiki on writable workspaces only. Files under "
            "kg/entities/<type>/<slug>.md (except index.md/log.md) must start with YAML frontmatter "
            "containing type, id, and title."
        )
    )
    return (
        "## Workspace access (MCP)\n"
        "Shell execution is disabled in this container runtime. Do NOT call shell or apply_patch tools. "
        f"Use the connected `{SERVER_NAME}` MCP tools ({tool_list}) to inspect and work with "
        "workspace Markdown files.\n"
        f"Authorized workspaces: {mount_summary}.\n"
        "Pass an exact workspace slug above (or 'personal' for your private space, or '*' with search_wiki) "
        "and a relative Markdown path under kg/, wiki/, notes/, sources/, concepts/, docs/, README.md, "
        "or onboarding.md (read-only; CLAUDE.md and mail/*.md are also readable in '_global').\n"
        + mode_note
    )

TOOLS: dict[str, dict] = {
    "list_wiki": {
        "description": (
            "List Markdown files in an authorized workspace (pass the exact mounted workspace slug, "
            "or 'personal' for your private space)."
        ),
        "required": ("workspace",),
        "optional": ("prefix",),
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    "search_wiki": {
        "description": (
            "Search Markdown pages by title or keyword across one workspace slug or '*' "
            "for all authorized workspaces."
        ),
        "required": ("query",),
        "optional": ("workspace",),
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    "read_wiki": {
        "description": (
            "Read one Markdown file from an authorized workspace using a relative path under "
            "kg/, wiki/, notes/, sources/, concepts/, or docs/ (or README.md; CLAUDE.md and mail/*.md in _global)."
        ),
        "required": ("workspace", "path"),
        "optional": (),
        "annotations": {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False},
    },
    "create_wiki": {
        "description": (
            "Create a new Markdown page under kg/, wiki/, notes/, sources/, concepts/, or docs/ "
            "in a writable workspace. Files under kg/entities/<type>/<slug>.md must start with YAML "
            "frontmatter containing type, id, and title."
        ),
        "required": ("workspace", "path", "text"),
        "optional": (),
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    "update_wiki": {
        "description": (
            "Update an existing Markdown page under kg/, wiki/, notes/, sources/, concepts/, or docs/ "
            "in a writable workspace. Use mode='append' to add content or mode='replace' to rewrite the "
            "full page (call read_wiki first before replace). Never use update_wiki to delete a file."
        ),
        "required": ("workspace", "path", "mode", "text"),
        "optional": (),
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    "move_wiki": {
        "description": (
            "Move or rename an existing Markdown page within a writable workspace from path to destination "
            "(both under kg/, wiki/, notes/, sources/, concepts/, or docs/)."
        ),
        "required": ("workspace", "path", "destination"),
        "optional": (),
        "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False},
    },
    "delete_wiki": {
        "description": (
            "Delete an existing Markdown page under kg/, wiki/, notes/, sources/, concepts/, or docs/ "
            "in a writable workspace when the user explicitly asks to delete or remove it."
        ),
        "required": ("workspace", "path"),
        "optional": (),
        "annotations": {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False},
    },
}


def load_mounts(raw_mounts: object, *, read_only: bool = False) -> dict[str, dict]:
    """Filter TINA mount descriptors to authorized Knowledge mounts (excluding _system)."""
    if not isinstance(raw_mounts, list):
        return {}
    result: dict[str, dict] = {}
    for entry in raw_mounts:
        if not isinstance(entry, dict):
            continue
        slug = str(entry.get("slug") or "").strip()
        path = entry.get("path")
        if not slug or slug == "_system" or not isinstance(path, str) or not Path(path).is_absolute():
            continue
        role = str(entry.get("role") or "private").strip()
        if role not in ("private", "shared", "global"):
            continue
        writable = (not read_only) and role != "global" and entry.get("write") is True
        cleaned = dict(entry)
        cleaned["slug"] = slug
        cleaned["role"] = role
        cleaned["write"] = writable
        result[slug] = cleaned
    return result


def _tool_schema(spec: dict) -> dict:
    properties = {
        key: {"type": "string"}
        for key in (*spec["required"], *spec["optional"])
    }
    return {
        "type": "object",
        "properties": properties,
        "required": list(spec["required"]),
        "additionalProperties": False,
    }


def _list_resources(mounts: dict[str, dict]) -> list[dict]:
    resources: list[dict] = []
    for slug, mount in mounts.items():
        remaining = _MAX_RESOURCES - len(resources)
        if remaining <= 0:
            break
        for rel, _full_path in _iter_workspace_files(mount, limit=remaining):
            try:
                with _wiki_parent(mount["path"], rel) as (directory, file):
                    head = _read_regular_file(directory, file, max_bytes=512)
                title = _extract_title(head, rel)
            except (OSError, ValueError):
                title = _extract_title("", rel)
            uri = f"{_RESOURCE_PREFIX}{quote(slug, safe='')}/{quote(rel, safe='/')}"
            resources.append({
                "uri": uri,
                "name": title,
                "description": f"{slug}/{rel}",
                "mimeType": "text/markdown",
            })
            if len(resources) >= _MAX_RESOURCES:
                break
    return resources


def _read_resource(mounts: dict[str, dict], uri: object) -> dict:
    if not isinstance(uri, str) or not uri.startswith(_RESOURCE_PREFIX):
        raise ValueError("Unknown workspace resource URI.")
    remainder = uri[len(_RESOURCE_PREFIX):]
    if "/" not in remainder:
        raise ValueError("Invalid workspace resource URI.")
    raw_slug, raw_rel = remainder.split("/", 1)
    slug = unquote(raw_slug)
    rel = unquote(raw_rel)
    data = _wiki_tool(mounts, "read_wiki", {"workspace": slug, "path": rel}, "")
    return {
        "contents": [{
            "uri": uri,
            "mimeType": "text/markdown",
            "text": data["text"],
        }]
    }


def handle(
    message: dict,
    mounts: dict[str, dict],
    allowed: tuple[str, ...] | list[str] | set[str] = READ_TOOLS,
    *,
    read_only: bool = False,
    state: dict | None = None,
) -> dict:
    """Handle one MCP JSON-RPC request against authorized workspace mounts."""
    allowed_set = {
        name for name in allowed
        if name in TOOLS and not (read_only and name in _WRITE_TOOLS)
    }
    can_read = bool(allowed_set.intersection(READ_TOOLS))
    method = message.get("method")

    if method == "initialize":
        capabilities: dict[str, dict] = {"tools": {}}
        if can_read:
            capabilities["resources"] = {}
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        return {
            "protocolVersion": params.get("protocolVersion", "2024-11-05"),
            "capabilities": capabilities,
            "serverInfo": {"name": "tina-workspace", "version": "0.1.0"},
        }
    if method == "ping":
        return {}
    if method == "prompts/list":
        return {"prompts": []}
    if method == "resources/templates/list":
        return {"resourceTemplates": []}
    if method == "resources/list":
        return {"resources": _list_resources(mounts) if can_read else []}
    if method == "resources/read":
        if not can_read:
            raise ValueError("Workspace read access is not granted.")
        params = message.get("params") or {}
        return _read_resource(mounts, params.get("uri"))
    if method == "tools/list":
        return {
            "tools": [
                {
                    "name": name,
                    "description": spec["description"],
                    "annotations": dict(spec["annotations"]),
                    "inputSchema": _tool_schema(spec),
                }
                for name, spec in TOOLS.items()
                if name in allowed_set
            ]
        }
    if method == "tools/call":
        params = message.get("params") or {}
        name = params.get("name")
        args = params.get("arguments")
        if args is None:
            args = {}
        if name not in allowed_set or not isinstance(args, dict):
            raise ValueError("Unknown workspace tool or invalid arguments.")
        spec = TOOLS[name]
        allowed_keys = set(spec["required"]) | set(spec["optional"])
        if not set(args).issubset(allowed_keys):
            raise ValueError("Unexpected workspace tool argument.")
        if not set(spec["required"]).issubset(args):
            missing = ", ".join(sorted(set(spec["required"]) - set(args)))
            raise ValueError(f"Missing required argument(s): {missing}.")
        if any(not isinstance(val, str) for val in args.values()):
            raise ValueError("Workspace tool arguments must be strings.")
        if name in _WRITE_TOOLS and state is not None:
            if state.get("writes", 0) >= _MAX_WRITES_PER_SESSION:
                return {
                    "content": [{"type": "text", "text": json.dumps({"error": "Write limit per turn reached."})}],
                    "isError": True,
                }
        try:
            result = _wiki_tool(mounts, name, args, "", external_taint=False)
        except (ValueError, KeyError, TypeError, OSError) as exc:
            detail = str(exc).strip() or "Workspace tool action denied."
            return {
                "content": [{"type": "text", "text": json.dumps({"error": detail[:240]}, ensure_ascii=False)}],
                "isError": True,
            }
        if name in _WRITE_TOOLS and state is not None:
            state["writes"] = state.get("writes", 0) + 1
        return {
            "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
            "isError": False,
        }
    raise ValueError("Unsupported MCP method.")


def _load_raw_mounts(mounts_file: str | None) -> object:
    if mounts_file:
        try:
            return json.loads(Path(mounts_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
    try:
        return json.loads(os.environ.get("TINA_MOUNTS", "[]"))
    except ValueError:
        return []


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mounts-file", default=None)
    parser.add_argument("--tools", nargs="+", choices=sorted(TOOLS), required=True)
    parser.add_argument("--readonly", action="store_true")
    args = parser.parse_args()

    mounts = load_mounts(_load_raw_mounts(args.mounts_file), read_only=args.readonly)
    state = {"writes": 0}
    while line := sys.stdin.buffer.readline(_MAX_RPC_LINE_BYTES + 1):
        if len(line) > _MAX_RPC_LINE_BYTES:
            return
        message: dict = {}
        try:
            parsed = json.loads(line)
            if not isinstance(parsed, dict):
                raise ValueError("Invalid message")
            message = parsed
            if "id" not in message:
                continue
            response = {"result": handle(message, mounts, args.tools, read_only=args.readonly, state=state)}
        except (ValueError, TypeError, AttributeError) as exc:
            response = {"error": {"code": -32602, "message": str(exc)[:200] or "Invalid workspace request"}}
        print(
            json.dumps({"jsonrpc": "2.0", "id": message.get("id"), **response}, ensure_ascii=False),
            flush=True,
        )


if __name__ == "__main__":
    main()
