"""Codex app-server harness adapter for OpenAI API keys and ChatGPT plan tokens.

Codex owns the agent loop and its workspace sandbox. TINA keeps ownership of the
workspace mounts and maps the resulting assistant text into the existing UnitEvent stream.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

from llm.errors import LLMError, looks_like_auth_failure
from llm.model_capabilities import groq_chat_model_error, normalized_effort
from llm.ports import harness_subprocess_env
from llm.citations import render_citations, web_sources


_CLIENT = {"name": "tina", "title": "TINA", "version": "0.12.0"}


class CodexHarness:
    """Drive one Codex app-server thread turn over stdio JSON-RPC."""

    name = "codex"

    def __init__(self, *, executable: str = "codex") -> None:
        self._executable = executable
        self._codex_home: Optional[Path] = None

    def prepare(self, work: Path, chat_root: Optional[Path] = None) -> None:
        # Keep resumable Codex rollout data in TINA's private chat workspace, not the shared cwd.
        root = chat_root or work
        home = root / ".codex"
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        try:
            home.chmod(0o700)
        except OSError:
            pass
        self._codex_home = home
        self._link_workspace_skills(work)

    @staticmethod
    def _link_workspace_skills(work: Path) -> None:
        """Expose TINA's governed skills through Codex's repo-local ``.agents/skills`` root."""
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
                return  # never replace a user-authored Codex skill directory
            link.symlink_to(target, target_is_directory=True)
        except (OSError, RuntimeError):
            return

    def transcript_bytes(self, work: Path, session_id: str) -> int:
        """Size Codex's local rollout JSONL files for TINA's session-resume budget."""
        if self._codex_home is None or not session_id:
            return 0
        safe_id = glob.escape(session_id)
        patterns = (f"rollout-*-{safe_id}.jsonl", f"rollout-*-{safe_id}_*.jsonl")
        roots = (self._codex_home / "sessions", self._codex_home / "archived_sessions")
        files = {
            path
            for root in roots if root.is_dir()
            for pattern in patterns
            for path in root.rglob(pattern)
        }
        total = 0
        for path in files:
            try:
                total += path.stat().st_size
            except OSError:
                continue
        return total

    def _save_sources(self, thread_id: str, turn_id: str, sources: list[dict]) -> bool:
        if not sources or self._codex_home is None:
            return True
        if not all(re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value) for value in (thread_id, turn_id)):
            return False
        root = self._codex_home.resolve()
        target = root / 'tina-sources' / thread_id / f'{turn_id}.json'
        if root not in target.resolve().parents:
            return False
        try:
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(dir=target.parent, mode='w', encoding='utf-8', delete=False) as out:
                temporary = Path(out.name)
                json.dump(sources[:50], out, ensure_ascii=False)
            try:
                os.replace(temporary, target)
            finally:
                temporary.unlink(missing_ok=True)
            return True
        except OSError:
            return False

    @staticmethod
    def _workspace_instructions(work: Path) -> Optional[str]:
        """Feed the workspace's Claude-authored conventions to Codex as developer instructions."""
        try:
            workspace = Path(work).resolve()
            instructions = (workspace / "CLAUDE.md").resolve()
            if workspace not in instructions.parents or not instructions.is_file():
                return None
            return instructions.read_text(encoding="utf-8")
        except (OSError, RuntimeError):
            return None

    def preflight(self) -> Optional[str]:
        if not shutil.which(self._executable):
            return "Codex runner is selected but the codex CLI is missing from the agent-worker image."
        mode = (os.environ.get("TINA_CODEX_AUTH_MODE") or "api-key").strip()
        if mode == "chatgpt-plan" and not os.environ.get("ACCESS_TOKEN"):
            return "ChatGPT plan credentials are not connected for this TINA user."
        if mode == "api-key" and not os.environ.get("OPENAI_API_KEY"):
            return "OpenAI API key is missing for this TINA user."
        if mode == "groq" and not os.environ.get("TINA_LLM_API_KEY"):
            return "Groq API key is missing. Add it in Settings → Models."
        return None

    @staticmethod
    def _toml_string(value: str) -> str:
        # JSON string escapes are valid TOML basic-string escapes.
        return json.dumps(value, ensure_ascii=False)

    def _prepare_mcp_config(self, path: Optional[str], allowed_tools: Iterable[str],
                            env: dict[str, str], *,
                            gated_mcp_servers: Iterable[str] = (),
                            mcp_servers: Optional[dict] = None,
                            mcp_env: Optional[dict[str, str]] = None,
                            mcp_tools: Optional[dict[str, list[str]]] = None) -> tuple[Optional[Path], list[str]]:
        if self._codex_home is None:
            return None, []
        allowed = set(allowed_tools)
        gated = set(gated_mcp_servers)
        servers: dict = {}
        if mcp_servers is not None:
            servers = mcp_servers
        elif path and Path(path).is_file():
            try:
                raw = json.loads(Path(path).read_text(encoding="utf-8"))
                servers = raw.get("mcpServers", {}) if isinstance(raw, dict) else {}
            except (OSError, json.JSONDecodeError):
                servers = {}
        lines = ["[mcp_servers]"]
        shell_environment_excludes: set[str] = set()
        for name, spec in sorted(servers.items()):
            if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", name):
                continue
            selected_tools = (mcp_tools or {}).get(name)
            if not isinstance(selected_tools, list) or not selected_tools:
                continue
            is_auto = f"mcp__{name}" in allowed
            is_gated = name in gated
            if not is_auto and not is_gated:
                continue
            if not isinstance(spec, dict):
                continue
            lines.extend([
                "", f"[mcp_servers.{self._toml_string(name)}]", "enabled = true",
                f'default_tools_approval_mode = "{"prompt" if is_gated else "auto"}"',
                f"enabled_tools = {json.dumps([tool for tool in selected_tools if isinstance(tool, str)])}",
            ])
            command = spec.get("command")
            url = spec.get("url")
            if isinstance(command, str) and command:
                lines.append(f"command = {self._toml_string(command)}")
                args = spec.get("args") if isinstance(spec.get("args"), list) else []
                lines.append(f"args = {json.dumps([str(x) for x in args])}")
                child_env = spec.get("env") if isinstance(spec.get("env"), dict) else {}
                safe_child_env = {
                    str(key): str(value)
                    for key, value in child_env.items()
                    if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", str(key))
                }
                if safe_child_env:
                    assignments = ", ".join(
                        f"{self._toml_string(key)} = {self._toml_string(value)}"
                        for key, value in sorted(safe_child_env.items())
                    )
                    lines.append(f"env = {{ {assignments} }}")
                declared_env_vars = spec.get("env_vars")
                if not isinstance(declared_env_vars, list):
                    declared_env_vars = []
                names: list[str] = []
                for key in declared_env_vars:
                    if (
                        isinstance(key, str)
                        and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
                        and key in (mcp_env or {})
                    ):
                        if key in safe_child_env:
                            raise ValueError(f"MCP server {name} declares {key} in both env and env_vars")
                        env[key] = str(mcp_env[key])
                        names.append(key)
                        shell_environment_excludes.add(key)
                if names:
                    lines.append(f"env_vars = {json.dumps(sorted(set(names)))}")
                if spec.get("cwd"):
                    lines.append(f"cwd = {self._toml_string(str(spec['cwd']))}")
            elif isinstance(url, str) and url.startswith(("http://", "https://")):
                lines.append(f"url = {self._toml_string(url)}")
                bearer_env = spec.get("bearer_token_env_var")
                if isinstance(bearer_env, str) and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", bearer_env):
                    if bearer_env in (mcp_env or {}):
                        env[bearer_env] = str(mcp_env[bearer_env])
                        shell_environment_excludes.add(bearer_env)
                    lines.append(f"bearer_token_env_var = {self._toml_string(bearer_env)}")
                header_vars = spec.get("env_http_headers")
                if isinstance(header_vars, dict):
                    configured_headers: dict[str, str] = {}
                    for header, env_name in header_vars.items():
                        if (
                            isinstance(header, str)
                            and isinstance(env_name, str)
                            and re.fullmatch(r"[A-Za-z0-9-]{1,128}", header)
                            and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", env_name)
                            and env_name in (mcp_env or {})
                        ):
                            env[env_name] = str(mcp_env[env_name])
                            shell_environment_excludes.add(env_name)
                            configured_headers[header] = env_name
                    if configured_headers:
                        header_table = ", ".join(
                            f"{self._toml_string(header)} = {self._toml_string(env_name)}"
                            for header, env_name in sorted(configured_headers.items())
                        )
                        lines.append(f"env_http_headers = {{ {header_table} }}")
            else:
                continue
            lines.append("required = true")
        config = self._codex_home / "config.toml"
        config.write_text("\n".join(lines) + "\n", encoding="utf-8")
        try:
            config.chmod(0o600)
        except OSError:
            pass
        return config, sorted(shell_environment_excludes)

    def _argv(self, shell_environment_excludes: Iterable[str] = (), *, web_search: str = "disabled",
              writable_roots: Iterable[str] = (), groq_base_url: Optional[str] = None,
              groq_model_catalog: Optional[Path] = None, no_tools: bool = False) -> list[str]:
        mode = (os.environ.get("TINA_CODEX_AUTH_MODE") or "api-key").strip()
        argv = [self._executable, "app-server", "--listen", "stdio://"]
        if mode == "groq":
            settings = {
                "model_provider": '"groq"',
                "model_providers.groq.name": '"Groq"',
                "model_providers.groq.base_url": self._toml_string(
                    groq_base_url or "https://api.groq.com/openai/v1"),
                "model_providers.groq.env_key": '"TINA_LLM_API_KEY"',
                "model_providers.groq.wire_api": '"responses"',
                "model_providers.groq.requires_openai_auth": "false",
                "model_providers.groq.supports_websockets": "false",
                "model_context_window": "131072",
                "model_auto_compact_token_limit": "100000",
                # Groq accepts function tools, not Codex's freeform/namespace tools.
                # Use a matching model profile so instructions and advertised tools agree.
                "features.multi_agent": "false",
            }
            if groq_model_catalog is not None:
                settings["model_catalog_json"] = self._toml_string(str(groq_model_catalog))
        elif mode == "chatgpt-plan":
            settings = {
                "model_provider": '"openai_chatgpt_plan"',
                "model_providers.openai_chatgpt_plan.name": '"ChatGPT plan"',
                "model_providers.openai_chatgpt_plan.base_url": '"https://api.openai.com/v1"',
                "model_providers.openai_chatgpt_plan.env_key": '"ACCESS_TOKEN"',
                "model_providers.openai_chatgpt_plan.wire_api": '"responses"',
                "model_providers.openai_chatgpt_plan.requires_openai_auth": "false",
                "model_providers.openai_chatgpt_plan.supports_websockets": "false",
            }
        else:
            settings = {
                "model_provider": '"openai_api_key"',
                "model_providers.openai_api_key.name": '"OpenAI API"',
                "model_providers.openai_api_key.base_url": '"https://api.openai.com/v1"',
                "model_providers.openai_api_key.env_key": '"OPENAI_API_KEY"',
                "model_providers.openai_api_key.wire_api": '"responses"',
                "model_providers.openai_api_key.requires_openai_auth": "false",
                "model_providers.openai_api_key.supports_websockets": "false",
            }
        # Codex tool subprocesses must not inherit provider keys or OAuth bearer tokens.
        # With default exclusions enabled, names containing KEY, SECRET, or TOKEN are scrubbed.
        settings["shell_environment_policy.ignore_default_excludes"] = "false"
        if shell_environment_excludes:
            settings["shell_environment_policy.exclude"] = json.dumps(
                sorted(set(shell_environment_excludes)),
            )
        # Keep Codex on its default bubblewrap sandbox. TINA's Codex worker is configured to permit
        # nested user namespaces; the legacy Landlock path cannot isolate app-server Unix sockets.
        settings["features.use_legacy_landlock"] = "false"
        settings["features.network_proxy"] = "true"
        settings["web_search"] = self._toml_string(web_search)
        filesystem = {":root": "read"}
        for root in writable_roots:
            filesystem[root] = "write"
            for metadata in (".git", ".codex", ".agents"):
                filesystem[str(Path(root) / metadata)] = "read"
        rules = "{" + ", ".join(f"{self._toml_string(path)} = {self._toml_string(access)}"
                                  for path, access in filesystem.items()) + "}"
        settings["default_permissions"] = '"tina-offline"'
        if no_tools:
            for feature in ('shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use',
                            'multi_agent', 'view_image', 'image_generation', 'skill_search', 'code_mode_host'):
                settings[f'features.{feature}'] = 'false'
        for profile in ("tina-offline", "tina-online"):
            settings[f"permissions.{profile}.filesystem"] = rules
            settings[f"permissions.{profile}.network.enabled"] = "true" if profile == "tina-online" else "false"
        for key, value in settings.items():
            argv.extend(["-c", f"{key}={value}"])
        return argv

    @staticmethod
    def _write_groq_model_catalog(directory: Path, model: str) -> Path:
        """Configure the pinned CLI natively for Groq's function-only tool contract.

        Dropping apply_patch at the HTTP boundary alone leaves GPT-specific instructions
        telling the model to call it. Codex 0.149 only supports a freeform patch tool;
        disable that tool in its model profile and retain sandboxed exec for file edits.
        No credential or caller-selected endpoint is written here.
        """
        info = {
            "slug": model, "display_name": model, "description": "TINA through Groq",
            "base_instructions": (
                "You are TINA, a meeting and workspace assistant served through Groq. "
                "Follow the workspace instructions and the user's request. "
                "Use only the function tools provided in the current request. "
                "Read or edit files with exec_command inside the granted sandbox roots. "
                "Never call a tool that is absent from the available tools. "
                "Preserve existing user changes and report what you actually verified."
            ),
            "model_messages": None, "apply_patch_tool_type": None,
            "supported_reasoning_levels": [], "supports_reasoning_effort_updates": False,
            "default_reasoning_summary": "none", "support_verbosity": False,
            "shell_type": "unified_exec", "visibility": "list", "supported_in_api": True,
            "priority": 0, "upgrade": None,
            "truncation_policy": {"mode": "tokens", "limit": 10000},
            "context_window": 131072, "effective_context_window_percent": 95,
            "experimental_supported_tools": [], "input_modalities": ["text"],
        }
        path = directory / "models.json"
        path.write_text(json.dumps({"models": [info]}), encoding="utf-8")
        return path

    @staticmethod
    def _content_text(item: dict) -> str:
        if isinstance(item.get('text'), str):
            return item['text']
        chunks: list[str] = []
        for part in item.get("content", []) or []:
            if part.get("type") in ("output_text", "text") and isinstance(part.get("text"), str):
                chunks.append(part["text"])
        return "".join(chunks)

    @staticmethod
    def _tool_call_event(item: dict) -> Optional[dict]:
        item_type = item.get("type")
        call_id = item.get("id")
        if not isinstance(call_id, str) or not call_id:
            return None
        if item_type == "commandExecution":
            tool = "Bash"
            args = {"command": item.get("command", ""), "cwd": item.get("cwd")}
        elif item_type == "fileChange":
            tool = "FileChange"
            args = {"changes": item.get("changes", [])}
        elif item_type == "mcpToolCall":
            server = str(item.get("server") or "")
            name = str(item.get("tool") or "")
            tool = f"mcp__{server}__{name}" if server and name else name or server
            args = {"arguments": item.get("arguments") or {}}
        elif item_type == "webSearch":
            tool = "WebSearch"
            args = {"query": item.get("query") or ""}
        else:
            return None
        return {"type": "tool-call", "tool": tool, "args": args, "callId": call_id}

    @classmethod
    def _tool_result_event(cls, item: dict) -> Optional[dict]:
        call_id = item.get("id")
        if not isinstance(call_id, str) or not call_id:
            return None
        item_type = item.get("type")
        if item_type not in ("commandExecution", "fileChange", "mcpToolCall", "webSearch"):
            return None
        status = item.get("status")
        ok = status == "completed"
        if item_type == "commandExecution" and item.get("exitCode") not in (None, 0):
            ok = False
        result = item.get("result")
        if isinstance(result, dict) and result.get("isError") is True:
            ok = False
        if item.get("error"):
            ok = False
        summary_value = (
            item.get("aggregatedOutput")
            or item.get("error")
            or (cls._content_text(result) if isinstance(result, dict) else result)
            or item.get("changes")
            or status
            or ""
        )
        summary = " ".join(str(summary_value).split())[:160]
        return {"type": "tool-result", "callId": call_id, "ok": ok, "summary": summary}

    @staticmethod
    def _redact_secrets(text: str) -> str:
        for secret in (os.environ.get("ACCESS_TOKEN", ""), os.environ.get("OPENAI_API_KEY", ""),
                       os.environ.get("TINA_LLM_API_KEY", "")):
            if secret:
                text = text.replace(secret, "[redacted]")
        return text

    @staticmethod
    def _auth_failure_reply() -> str:
        mode = (os.environ.get("TINA_CODEX_AUTH_MODE") or "api-key").strip()
        if mode == "chatgpt-plan":
            return (
                "Codex could not authenticate with the ChatGPT plan. Reconnect the ChatGPT account "
                "in Settings → Models and retry."
            )
        if mode == "groq":
            return "Groq could not authenticate. Check the Groq API key in Settings → Models and retry."
        return (
            "Codex could not authenticate with the OpenAI API key. Check the key in Settings → Models "
            "or connect a ChatGPT plan."
        )

    def run_turn(self, work: Path, prompt: str, *, allowed_tools: Iterable[str] = (),
                 session: Optional[str] = None, model: Optional[str] = None,
                 mcp_config: Optional[str] = None, gated_mcp_servers: Iterable[str] = (),
                 mcp_servers: Optional[dict] = None, mcp_env: Optional[dict[str, str]] = None,
                 mcp_tools: Optional[dict[str, list[str]]] = None,
                 approval_handler: Optional[Callable[[dict], Optional[bool]]] = None) -> Iterator[dict]:
        kwargs = dict(allowed_tools=allowed_tools, session=session, model=model,
                      mcp_config=mcp_config, gated_mcp_servers=gated_mcp_servers,
                      mcp_servers=mcp_servers, mcp_env=mcp_env, mcp_tools=mcp_tools,
                      approval_handler=approval_handler)
        if (os.environ.get("TINA_CODEX_AUTH_MODE") or "").strip() != "groq":
            yield from self._run_turn(work, prompt, **kwargs)
            return
        preflight = self.preflight()
        if preflight:
            yield {"type": "done", "ok": False, "reply": preflight}
            return
        # An explicit empty dispatch value means the operator's allowlist rejected the model.
        # Never let Codex substitute its OpenAI default in a Groq turn.
        target = model or os.environ.get("TINA_AGENT_MODEL")
        if target is None:
            target = "openai/gpt-oss-20b"
        if not target.strip():
            yield {"type": "done", "ok": False,
                   "reply": "No approved Groq chat model is selected. Choose an allowed model in Settings → Models."}
            return
        if problem := groq_chat_model_error(target):
            yield {"type": "done", "ok": False, "reply": problem}
            return
        kwargs["model"] = target
        # Keep the compatibility boundary alive for the entire turn, including tool follow-ups.
        # Codex retains its existing sandbox, MCP approval bridge, and local session history.
        from llm.groq_responses import groq_responses_proxy
        try:
            with tempfile.TemporaryDirectory(prefix="tina-groq-model-") as directory:
                catalog = self._write_groq_model_catalog(Path(directory), target)
                with groq_responses_proxy(os.environ["TINA_LLM_API_KEY"]) as base:
                    yield from self._run_turn(work, prompt, groq_base_url=base,
                                              groq_model_catalog=catalog, **kwargs)
        except Exception as exc:  # normalize proxy startup/cleanup failures without leaking a key
            detail = self._redact_secrets(str(exc))[:400]
            yield {"type": "done", "ok": False,
                   "reply": f"Could not prepare Groq model connection: {detail}"}

    def _run_turn(self, work: Path, prompt: str, *, groq_base_url: Optional[str] = None,
                 groq_model_catalog: Optional[Path] = None,
                 allowed_tools: Iterable[str] = (),
                 session: Optional[str] = None, model: Optional[str] = None,
                 mcp_config: Optional[str] = None,
                 gated_mcp_servers: Iterable[str] = (),
                 mcp_servers: Optional[dict] = None,
                 mcp_env: Optional[dict[str, str]] = None,
                 mcp_tools: Optional[dict[str, list[str]]] = None,
                 approval_handler: Optional[Callable[[dict], Optional[bool]]] = None) -> Iterator[dict]:
        preflight = self.preflight()
        if preflight:
            yield {"type": "done", "ok": False, "reply": preflight}
            return
        env = harness_subprocess_env()
        if self._codex_home is not None:
            env["CODEX_HOME"] = str(self._codex_home)
        allowed = set(allowed_tools)
        trusted_trigger = os.environ.get("TINA_UNIT_TRIGGER", "message") in {"message", "scheduled"}
        web_search = (
            ("live" if "WebFetch" in allowed else "cached")
            if trusted_trigger and "WebSearch" in allowed else "disabled"
        )
        try:
            mounts = json.loads(os.environ.get("TINA_MOUNTS", "[]"))
        except (TypeError, ValueError):
            mounts = []
        writable_roots = list(dict.fromkeys(
            mount["path"]
            for mount in mounts if isinstance(mount, dict)
            and mount.get("write") is True
            and isinstance(mount.get("path"), str)
            and Path(mount["path"]).is_absolute()
        )) if isinstance(mounts, list) else []
        read_only = (
            not trusted_trigger
            or not {"Write", "Edit", "Bash"}.intersection(allowed)
            or not writable_roots
        )
        developer_instructions = self._workspace_instructions(work)
        if web_search != 'disabled':
            developer_instructions = (developer_instructions or '') + (
                '\n\nFor web research, include a Sources list with direct Markdown links and page titles '
                'for the sources you actually used. Do not rely only on opaque provider citation ids. '
                'If a URL or title is unavailable, say so instead of inventing it.'
            )
        gated_servers = set(gated_mcp_servers)
        config_path, shell_environment_excludes = self._prepare_mcp_config(
            mcp_config, allowed, env, gated_mcp_servers=gated_servers,
            mcp_servers=mcp_servers, mcp_env=mcp_env, mcp_tools=mcp_tools,
        )
        # Tool allowlists do not constrain Codex's built-in shell. Match the filesystem sandbox to
        # the TINA turn policy so a read-only event cannot write through that shell.
        try:
            proc = subprocess.Popen(
                self._argv(shell_environment_excludes, web_search=web_search,
                           writable_roots=[] if read_only else writable_roots,
                           groq_base_url=groq_base_url, groq_model_catalog=groq_model_catalog, no_tools=not allowed),
                cwd=str(work), env=env, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1,
            )
        except OSError as exc:
            yield {"type": "done", "ok": False, "reply": f"Could not start Codex app-server: {exc}"}
            return

        request_id = 0

        def send(message: dict) -> None:
            if proc.stdin is None:
                raise LLMError("Codex app-server stdin is unavailable")
            proc.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
            proc.stdin.flush()

        def receive_until(response_id: int) -> dict:
            assert proc.stdout is not None
            while True:
                raw = proc.stdout.readline()
                if not raw:
                    code = proc.poll()
                    raise LLMError(f"Codex app-server exited before response (status {code})")
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if message.get("id") == response_id:
                    if message.get("error"):
                        raise LLMError(str(message["error"].get("message") or "Codex request failed"))
                    return message.get("result") or {}

        try:
            send({"method": "initialize", "id": request_id,
                  "params": {"clientInfo": _CLIENT, "capabilities": {"experimentalApi": True}}})
            receive_until(request_id)
            request_id += 1
            send({"method": "initialized", "params": {}})

            send({"method": "configRequirements/read", "id": request_id, "params": {}})
            requirements = receive_until(request_id).get("requirements") or {}
            network = requirements.get("network") or {}
            # A globally forced proxy in Codex 0.149 overrides offline turns; refuse that policy.
            if network.get("enabled") is True:
                raise LLMError("Codex managed network policy must leave enabled unset so offline turns stay offline.")
            network_access = (
                not read_only and {"Bash", "WebFetch"}.issubset(allowed)
                and network.get("enabled") is None
                and network.get("managedAllowedDomainsOnly") is True
                and not network.get("allowUnixSockets")
                and not any(access == "allow" for access in (network.get("unixSockets") or {}).values())
                and all(network.get(key) is False for key in (
                    "allowLocalBinding", "allowUpstreamProxy",
                    "dangerouslyAllowNonLoopbackProxy", "dangerouslyAllowAllUnixSockets",
                ))
            )
            profile = "tina-online" if network_access else "tina-offline"
            request_id += 1

            if session:
                params = {"threadId": session, "excludeTurns": True, "permissions": profile,
                          "config": {"web_search": web_search}}
                if developer_instructions:
                    params["developerInstructions"] = developer_instructions
                send({"method": "thread/resume", "id": request_id, "params": params})
                receive_until(request_id)
                thread_id = session
            else:
                params: dict = {
                    "cwd": str(work), "approvalPolicy": "never",
                    "permissions": profile,
                    "config": {"web_search": web_search},
                    "serviceName": "tina",
                }
                if developer_instructions:
                    params["developerInstructions"] = developer_instructions
                if model:
                    params["model"] = model
                send({"method": "thread/start", "id": request_id, "params": params})
                thread = receive_until(request_id).get("thread") or {}
                thread_id = str(thread.get("id") or "")
                if not thread_id:
                    raise LLMError("Codex app-server did not return a thread id")
            request_id += 1

            turn_params: dict = {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt}],
                "cwd": str(work),
                "approvalPolicy": "never",
                "permissions": profile,
            }
            effort_mode = "groq" if os.environ.get("TINA_CODEX_AUTH_MODE") == "groq" else "openai-api"
            effort = normalized_effort(effort_mode, model or os.environ.get("TINA_AGENT_MODEL", ""),
                                       os.environ.get("TINA_AGENT_EFFORT"))
            if effort:
                turn_params["effort"] = effort
            if model:
                turn_params["model"] = model
            send({"method": "turn/start", "id": request_id, "params": turn_params})
            started = receive_until(request_id)
            turn_id = str((started.get('turn') or {}).get('id') or '')

            reply_parts: list[str] = []
            saw_delta = False
            started_tools: set[str] = set()
            sources: list[dict] = []
            assert proc.stdout is not None
            while True:
                raw = proc.stdout.readline()
                if not raw:
                    raise LLMError("Codex app-server closed the stream before turn/completed")
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                method = message.get("method")
                params = message.get("params") or {}
                if method == "mcpServer/elicitation/request" and "id" in message:
                    meta = params.get("_meta")
                    server = params.get("serverName")
                    tool = meta.get("tool_name") if isinstance(meta, dict) else None
                    approved: Optional[bool] = None
                    if (
                        server in gated_servers
                        and params.get("threadId") == thread_id
                        and isinstance(tool, str)
                        and tool in (mcp_tools or {}).get(server, [])
                        and meta.get("codex_approval_kind") == "mcp_tool_call"
                        and approval_handler is not None
                    ):
                        display = meta.get("tool_params_display")
                        request = {
                            "server": server,
                            "tool": tool,
                            "title": str(meta.get("tool_title") or tool)[:160],
                            "description": str(meta.get("tool_description") or "")[:500],
                            "message": str(params.get("message") or "")[:500],
                            "parameters": display[:20] if isinstance(display, list) else [],
                            "turn_id": params.get("turnId"),
                        }
                        approved = approval_handler(request)
                    send({
                        "id": message["id"],
                        "result": {
                            "action": "accept" if approved is True else "decline" if approved is False else "cancel",
                            "content": None,
                            "_meta": None,
                        },
                    })
                elif method == "item/started":
                    item = params.get("item") or {}
                    event = self._tool_call_event(item)
                    if event:
                        started_tools.add(event["callId"])
                        yield event
                elif method == "item/agentMessage/delta":
                    delta = params.get("delta")
                    if isinstance(delta, str) and delta:
                        saw_delta = True
                        reply_parts.append(delta)
                        yield {"type": "message-delta", "text": delta}
                elif method == "item/completed":
                    item = params.get("item") or {}
                    sources = [*sources, *web_sources(item)][:50]
                    if item.get("type") == "agentMessage" and not saw_delta:
                        text = self._content_text(item)
                        if text:
                            reply_parts.append(text)
                            yield {"type": "message-delta", "text": text}
                    else:
                        call_id = item.get("id")
                        if isinstance(call_id, str) and call_id not in started_tools:
                            event = self._tool_call_event(item)
                            if event:
                                yield event
                        event = self._tool_result_event(item)
                        if event:
                            started_tools.discard(event["callId"])
                            yield event
                elif method == "turn/completed":
                    turn = params.get("turn") or {}
                    ok = turn.get("status") == "completed"
                    detail = self._redact_secrets(str((turn.get("error") or {}).get("message") or ""))
                    reply = render_citations("".join(reply_parts), sources)
                    if not self._save_sources(thread_id, turn_id, sources):
                        reply += '\n\nKhông lưu được metadata nguồn; liên kết có thể thiếu sau khi tải lại.'
                    if not ok:
                        if looks_like_auth_failure(detail):
                            reply = self._auth_failure_reply()
                        elif detail:
                            # ChatStream surfaces `reply` on done(ok=false), not the additive
                            # `detail` field; preserve the provider/sandbox reason for the user.
                            reply = detail
                        elif not reply:
                            reply = f"Codex turn ended with status {turn.get('status') or 'failed'}."
                    yield {"type": "done", "reply": reply,
                           "sessionId": thread_id, "ok": ok, **({"detail": detail} if detail else {})}
                    return
        except Exception as exc:  # noqa: BLE001 — normalize the app-server boundary to UnitEvents
            detail = self._redact_secrets(str(exc))[:400]
            reply = self._auth_failure_reply() if looks_like_auth_failure(detail) else f"Codex app-server failed: {detail}"
            yield {"type": "done", "reply": reply, "ok": False,
                   **({"detail": detail} if detail else {})}
        finally:
            try:
                if proc.stdin:
                    proc.stdin.close()
                proc.terminate()
                proc.wait(timeout=3)
            except Exception:
                try:
                    proc.kill()
                except OSError:
                    pass
            if config_path is not None:
                try:
                    config_path.unlink()
                except OSError:
                    pass
