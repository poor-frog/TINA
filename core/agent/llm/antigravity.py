"""Antigravity CLI harness adapter.

The CLI's headless NDJSON protocol is normalized into TINA UnitEvents here. Workspace access is
limited to the dispatch's explicit mounts; TINA still owns commits and schema validation.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

from llm.errors import looks_like_auth_failure
from llm.model_capabilities import agy_builtin_model, normalized_effort
from llm.ports import HarnessExec, harness_env_overrides, harness_subprocess_env


_TOOL_NAMES = {
    "read_file": "Read",
    "list_directory": "Glob",
    "search_file_content": "Grep",
    "write_to_file": "Write",
    "replace_file_content": "Edit",
    "run_command": "Bash",
    "web_search": "WebSearch",
    "fetch_url": "WebFetch",
}


def _short(value: object, limit: int = 160) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    for key_name in ("GEMINI_API_KEY", "TINA_LLM_API_KEY"):
        if secret := os.environ.get(key_name):
            text = text.replace(secret, "[redacted]")
    return " ".join(text.split())[:limit]


def _tool_name(value: object) -> str:
    name = str(value or "")
    if name.startswith("mcp__"):
        return name
    return _TOOL_NAMES.get(name, name)


def parse_stream_json(lines: Iterable[str]) -> Iterator[dict]:
    """Normalize Antigravity CLI stream-json events to TINA's frozen UnitEvent shapes."""
    conversation_id = ""
    streamed_text = False
    started_tools: set[str] = set()
    saw_result = False
    diagnostics: list[str] = []

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            diagnostics.append(_short(line, 200))
            diagnostics[:] = diagnostics[-3:]
            continue

        event_type = event.get("event")
        if event_type == "init":
            conversation_id = str(
                event.get("conversation_id")
                or (event.get("init") or {}).get("conversation_id")
                or conversation_id
            )
        elif event_type == "step_update":
            step = event.get("step_update") or {}
            conversation_id = str(step.get("conversation_id") or conversation_id)
            step_type = step.get("step_type")
            if step_type == "agent_response":
                text = step.get("text_delta")
                if isinstance(text, str) and text:
                    streamed_text = True
                    yield {"type": "message-delta", "text": text}
            elif step_type == "tool":
                step_index = step.get("step_index")
                call_id = f"{conversation_id}:{step_index}"
                info = step.get("tool_info") or {}
                name = _tool_name(info.get("name") or step.get("tool_name"))
                args = info.get("parameters")
                if not isinstance(args, dict):
                    args = {}
                if call_id not in started_tools:
                    started_tools.add(call_id)
                    yield {"type": "tool-call", "tool": name, "args": args, "callId": call_id}
                if step.get("state") == "DONE":
                    error = info.get("error")
                    summary = _short(error.get("message") if isinstance(error, dict) else
                                     (error or info.get("output") or ""))
                    yield {
                        "type": "tool-result",
                        "callId": call_id,
                        "ok": not bool(error),
                        "summary": summary,
                    }
                    started_tools.discard(call_id)
        elif event_type == "result":
            result = event.get("result") or {}
            conversation_id = str(result.get("conversation_id") or conversation_id)
            response = result.get("response")
            response = response if isinstance(response, str) else ""
            for key_name in ("GEMINI_API_KEY", "TINA_LLM_API_KEY"):
                if secret := os.environ.get(key_name):
                    response = response.replace(secret, "[redacted]")
            if response and not streamed_text:
                yield {"type": "message-delta", "text": response}
            status = str(result.get("status") or "ERROR").upper()
            ok = status == "SUCCESS"
            detail = _short(result.get("error") or "")
            if not ok and looks_like_auth_failure(detail):
                reply = (
                    "Antigravity CLI could not authenticate. Headless runs require an existing "
                    "Antigravity CLI login, or a Gemini API key configured for this TINA user."
                )
            else:
                reply = response or detail or f"Antigravity CLI ended with status {status}."
            yield {
                "type": "done",
                "reply": reply,
                "sessionId": conversation_id or None,
                "ok": ok,
                **({"detail": detail} if detail else {}),
            }
            saw_result = True

    if not saw_result:
        detail = "; ".join(diagnostics)
        reply = "Antigravity CLI exited without a result event."
        if detail and not looks_like_auth_failure(detail):
            reply = f"{reply} {detail}"
        elif detail:
            reply = (
                "Antigravity CLI could not authenticate. Headless runs require an existing "
                "Antigravity CLI login, or a Gemini API key configured for this TINA user."
            )
        yield {
            "type": "done",
            "reply": reply,
            "sessionId": conversation_id or None,
            "ok": False,
            **({"detail": detail} if detail else {}),
        }


def _exec_subprocess(argv: list[str], cwd: str) -> Iterator[str]:
    proc = subprocess.Popen(
        argv,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=harness_subprocess_env(),
    )
    assert proc.stdout is not None
    try:
        yield from proc.stdout
    finally:
        proc.wait()


def _mounts(work: Path) -> list[dict]:
    raw = os.environ.get("TINA_MOUNTS")
    if not raw:
        return [{"path": str(work.resolve()), "write": True}]
    try:
        mounts = json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError("TINA_MOUNTS is not valid JSON") from exc
    if not isinstance(mounts, list):
        raise ValueError("TINA_MOUNTS must be a list")
    clean: list[dict] = []
    for mount in mounts:
        if not isinstance(mount, dict) or not isinstance(mount.get("path"), str):
            continue
        path = Path(mount["path"])
        if path.is_absolute():
            clean.append({"path": str(path), "write": mount.get("write") is True})
    if not any(Path(item["path"]) == work for item in clean):
        clean.insert(0, {"path": str(work.resolve()), "write": False})
    return clean


def _permission_settings(mounts: list[dict], allowed_tools: set[str],
                         mcp_rules: list[str]) -> dict:
    readable = list(dict.fromkeys(item["path"] for item in mounts)) if 'Read' in allowed_tools else []
    writable = (
        list(dict.fromkeys(item["path"] for item in mounts if item["write"]))
        if {"Write", "Edit"}.intersection(allowed_tools) else []
    )
    permissions = {
        "allow": [*(f"read_file({path})" for path in readable),
                  *(f"write_file({path})" for path in writable), *mcp_rules],
        "deny": [],
    }
    if not writable:
        permissions["deny"].append("write_file(*)")
    if "Bash" not in allowed_tools:
        permissions["deny"].append("command(*)")
    if not allowed_tools:
        permissions["deny"].append("read_file(*)")
    if "WebSearch" not in allowed_tools and "WebFetch" not in allowed_tools:
        permissions["deny"].append("read_url(*)")
    return {
        "agentMode": "accept-edits" if writable else "plan",
        "toolPermission": "proceed-in-sandbox",
        "enableTerminalSandbox": True,
        "allowNonWorkspaceAccess": False,
        "permissions": permissions,
    }


def build_argv(
    prompt: str,
    *,
    executable: str = "agy",
    session: Optional[str] = None,
    model: Optional[str] = None,
    effort: Optional[str] = None,
    settings_path: Optional[str] = None,
    extra_dirs: Iterable[str] = (),
    read_only: bool = False,
) -> list[str]:
    """Build a headless, sandboxed Antigravity CLI invocation."""
    argv = [
        executable, "-p", prompt, "--output-format", "stream-json",
        "--sandbox", "--mode", "plan" if read_only else "accept-edits",
    ]
    if settings_path:
        argv.extend(["--settings", settings_path])
    for path in extra_dirs:
        argv.extend(["--add-dir", path])
    if session:
        argv.extend(["--conversation", session])
    if model:
        argv.extend(["--model", model])
    selected_effort = normalized_effort("gemini", model or "", effort)
    if selected_effort:
        argv.extend(["--effort", selected_effort])
    return argv


class AntigravityHarness:
    """HarnessPort adapter for Google's `agy` CLI."""

    name = "antigravity"

    def __init__(self, exec_fn: Optional[HarnessExec] = None, *, executable: str = "agy") -> None:
        self._exec: HarnessExec = exec_fn or _exec_subprocess
        self._executable = executable
        self._home: Optional[Path] = None

    def prepare(self, work: Path, chat_root: Optional[Path] = None) -> None:
        root = (chat_root or work).resolve()
        private = root / ".claude"
        if private.is_symlink():
            raise OSError("Antigravity private state cannot use a symlinked .claude directory")
        private.mkdir(mode=0o700, parents=True, exist_ok=True)
        session_scope = (
            os.environ.get("TINA_CHAT_SESSION")
            or os.environ.get("TINA_AGENT_ID")
            or "default"
        )
        session_hash = hashlib.sha256(session_scope.encode("utf-8")).hexdigest()[:24]
        home_root = private / "antigravity-home"
        home_root.mkdir(mode=0o700, exist_ok=True)
        home = home_root / session_hash
        home.mkdir(mode=0o700, exist_ok=True)
        try:
            home.chmod(0o700)
        except OSError:
            pass
        self._home = home
        self._link_workspace_skills(work)

    @staticmethod
    def _link_workspace_skills(work: Path) -> None:
        """Expose governed TINA skills via Antigravity's `.agents/skills` discovery path."""
        try:
            workspace = Path(work).resolve()
            skills = (workspace / "skills").resolve()
            if workspace not in skills.parents or not skills.is_dir():
                return
            agents = workspace / ".agents"
            if agents.is_symlink():
                return
            agents.mkdir(parents=True, exist_ok=True)
            link = agents / "skills"
            target = os.path.relpath(skills, agents)
            if link.is_symlink():
                if link.resolve() == skills:
                    return
                link.unlink()
            elif link.exists():
                return
            link.symlink_to(target, target_is_directory=True)
        except (OSError, RuntimeError):
            return

    def _write_settings(self, mounts: list[dict], allowed_tools: set[str],
                        mcp_rules: list[str], *, model: Optional[str] = None) -> Path:
        if self._home is None:
            raise RuntimeError("Antigravity harness was not prepared")
        settings_dir = self._home / ".gemini" / "antigravity-cli"
        settings_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        settings = _permission_settings(mounts, allowed_tools, mcp_rules)
        auth_mode = (os.environ.get("TINA_ANTIGRAVITY_AUTH_MODE") or "").strip()
        if auth_mode == "gemini-api" or (not auth_mode and os.environ.get("GEMINI_API_KEY")):
            settings["modelProvider"] = "gemini"
            model = (model or os.environ.get("TINA_AGENT_MODEL") or "").strip()
            if model and not agy_builtin_model(model):
                # Provider-listed API models need not exist in agy's bundled model registry.
                # Register the exact selected ID without assigning unsupported CLI effort tiers.
                if not re.fullmatch(r"[A-Za-z0-9._-]{1,200}", model):
                    raise ValueError("Invalid Gemini model ID")
                settings["customModelsConfig"] = {"customModels": {model: {
                    # In pinned agy 1.4.11, Gemini-provider requests pass modelName to the
                    # native SDK. A URI here becomes part of /models/... and returns 404.
                    # The Gemini provider owns the base URL and API version, not this ID.
                    "modelName": model,
                    "label": model,
                    "toolFormatterType": "TOOL_FORMATTER_TYPE_NONE",
                }}}
        path = settings_dir / "settings.json"
        path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return path

    def _write_mcp_config(
        self,
        servers: Optional[dict],
        allowed_tools: set[str],
        gated_servers: set[str],
        mcp_env: Optional[dict[str, str]],
        mcp_tools: Optional[dict[str, list[str]]],
    ) -> tuple[Optional[Path], list[str]]:
        if self._home is None or not servers:
            return None, []
        selected: dict[str, dict] = {}
        permission_rules: list[str] = []
        for name, spec in sorted(servers.items()):
            if (not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name)
                    or name in gated_servers or f"mcp__{name}" not in allowed_tools
                    or not isinstance(spec, dict)):
                continue
            tools = (mcp_tools or {}).get(name)
            if not isinstance(tools, list) or not tools:
                continue
            # Headless mode cannot service TINA's per-call approval callback. It also has no
            # documented environment-variable interpolation for MCP config. Do not expose a
            # gated server or persist bearer/header secrets into the model-readable workspace.
            if spec.get("env") or spec.get("env_vars") or spec.get("bearer_token_env_var") \
                    or spec.get("env_http_headers"):
                continue
            server: dict = {"enabledTools": [tool for tool in tools if isinstance(tool, str)]}
            command = spec.get("command")
            url = spec.get("url")
            if isinstance(command, str) and command:
                server["command"] = command
                args = spec.get("args")
                if isinstance(args, list):
                    server["args"] = [str(arg) for arg in args]
                if spec.get("cwd"):
                    server["cwd"] = str(spec["cwd"])
            elif isinstance(url, str) and url.startswith(("http://", "https://")):
                server["serverUrl"] = url
            else:
                continue
            selected[name] = server
            permission_rules.extend(f"mcp({name}/{tool})" for tool in server["enabledTools"])
        if not selected:
            return None, []
        config_dir = self._home / ".gemini" / "config"
        config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        path = config_dir / "mcp_config.json"
        path.write_text(json.dumps({"mcpServers": selected}, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return path, permission_rules

    def transcript_bytes(self, work: Path, session_id: str) -> int:
        # The CLI exposes opaque conversation ids but no stable local transcript path.
        return 0

    def preflight(self) -> Optional[str]:
        if not shutil.which(self._executable):
            return "Antigravity runner is selected but the agy CLI is missing from the agent-worker image."
        auth_mode = (os.environ.get("TINA_ANTIGRAVITY_AUTH_MODE") or "").strip()
        if auth_mode == "gemini-api":
            if not os.environ.get("GEMINI_API_KEY"):
                return "Gemini API key is missing for this TINA user."
            if ("TINA_AGENT_MODEL" in os.environ and not os.environ["TINA_AGENT_MODEL"].strip()
                    and os.environ.get("TINA_LLM_BASE_URL") == "https://generativelanguage.googleapis.com/v1beta/openai"):
                return "No approved Gemini chat model is selected. Choose an allowed model in Settings → Models."
            return None
        if os.environ.get("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED") != "true":
            return (
                "Antigravity is disabled until its Terms warning is acknowledged in Settings → Models. "
                "Google says third-party software access violates its Terms and could lead to account suspension."
            )
        return None

    def run_turn(self, work: Path, prompt: str, *, allowed_tools: Iterable[str] = (),
                 session: Optional[str] = None, model: Optional[str] = None,
                 mcp_config: Optional[str] = None, gated_mcp_servers: Iterable[str] = (),
                 mcp_servers: Optional[dict] = None, mcp_env: Optional[dict[str, str]] = None,
                 mcp_tools: Optional[dict[str, list[str]]] = None,
                 approval_handler: Optional[Callable[[dict], Optional[bool]]] = None) -> Iterator[dict]:
        del mcp_config, mcp_env, approval_handler
        preflight = self.preflight()
        if preflight:
            yield {"type": "done", "ok": False, "reply": preflight}
            return
        try:
            mounts = _mounts(work)
            allowed = set(allowed_tools)
            gated = set(gated_mcp_servers)
            mcp_path, mcp_rules = self._write_mcp_config(
                mcp_servers, allowed, gated, None, mcp_tools,
            )
            settings_path = self._write_settings(mounts, allowed, mcp_rules, model=model)
            dirs = [item["path"] for item in mounts if Path(item["path"]) != work]
            writable = bool({"Write", "Edit"}.intersection(allowed)) and any(
                item["write"] for item in mounts
            )
            argv = build_argv(
                prompt,
                executable=self._executable,
                session=session,
                model=model,
                effort=os.environ.get("TINA_AGENT_EFFORT"),
                settings_path=str(settings_path),
                extra_dirs=dirs,
                read_only=not writable,
            )
            home = str(self._home) if self._home else ""
        except (OSError, ValueError, RuntimeError) as exc:
            yield {"type": "done", "ok": False,
                   "reply": f"Could not prepare Antigravity runner: {exc}"}
            return
        try:
            with harness_env_overrides({"HOME": home} if home else {}):
                yield from parse_stream_json(self._exec(argv, str(work)))
        except Exception as exc:  # noqa: BLE001 — normalize CLI failures at the HarnessPort boundary
            detail = _short(str(exc), 400)
            if looks_like_auth_failure(detail):
                reply = (
                    "Antigravity CLI could not authenticate. Headless runs require an existing "
                    "Antigravity CLI login, or a Gemini API key configured for this TINA user."
                )
            else:
                reply = f"Antigravity CLI failed: {detail}"
            yield {"type": "done", "reply": reply, "ok": False,
                   **({"detail": detail} if detail else {})}
        finally:
            if mcp_path is not None:
                try:
                    mcp_path.unlink()
                except OSError:
                    pass
            # Settings are generated from TINA's turn grants. Remove them so a concurrent or later
            # turn cannot inherit a broader permission set.
            try:
                settings_path.unlink()
            except OSError:
                pass
