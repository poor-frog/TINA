"""claude_code.py — the Claude Code harness ADAPTER (vendor-named like runtime's docker_backend.py).

Everything this codebase knows about the ``claude`` CLI lives in THIS file: the headless argv, the
``--output-format stream-json`` parser, the ``~/.claude`` continuity/skills wiring, and the
Anthropic-credential preflight. The rest of the system sees only ``HarnessPort`` UnitEvents.

This is the proven ``claude -p --allowedTools --resume`` pattern (stream-json → SSE). The
subprocess is an INJECTED runner (``HarnessExec``), so the parser is offline-provable with a fake.

Credentials: ``ANTHROPIC_API_KEY`` / ``ANTHROPIC_AUTH_TOKEN`` / ``ANTHROPIC_BASE_URL`` (or the
``HOST_CLAUDE_CREDENTIALS`` subscription mount brokered by the runtime) — this adapter's concern
only; other runners declare their own.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional

from llm.errors import looks_like_auth_failure, preflight_provider_guard
from llm.model_capabilities import normalized_effort
from llm.ports import HarnessExec, harness_subprocess_env


def _short(content: object, n: int = 80) -> str:
    s = content if isinstance(content, str) else json.dumps(content, default=str)
    for key_name in ("ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "TINA_LLM_API_KEY", "AWS_BEARER_TOKEN_BEDROCK"):
        if secret := os.environ.get(key_name):
            s = s.replace(secret, "[redacted]")
    s = " ".join(s.split())
    return s[:n]


def parse_stream_json(lines: Iterable[str], *, structured_output: bool = False) -> Iterator[dict]:
    """Normalize Claude Code `--output-format stream-json` JSONL into UnitEvent dicts.

    assistant text → message-delta · assistant tool_use → tool-call · user tool_result →
    tool-result · result → done. Malformed lines are skipped (fail-soft on the wire, P18 keeps the
    structured ones).

    With ``--include-partial-messages`` the stream also carries ``stream_event`` lines wrapping the
    Anthropic streaming events; each ``content_block_delta`` with ``delta.type=="text_delta"`` becomes
    an INCREMENTAL message-delta so the UI renders token-by-token. When partial deltas have been
    emitted, the consolidated full ``text`` block on the trailing ``assistant`` message is SUPPRESSED
    (else the prose doubles). The ``result`` event still carries the full ``reply``.
    """
    streamed_partial = False  # saw any text_delta → don't re-emit the consolidated assistant text
    for raw in lines:
        raw = raw.strip()
        if not raw:
            continue
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            continue
        t = obj.get("type")
        if t == "stream_event":
            event = obj.get("event", {}) or {}
            if event.get("type") == "content_block_delta":
                delta = event.get("delta", {}) or {}
                if delta.get("type") == "text_delta" and delta.get("text"):
                    streamed_partial = True
                    yield {"type": "message-delta", "text": delta["text"]}
        elif t == "assistant":
            for block in obj.get("message", {}).get("content", []) or []:
                bt = block.get("type")
                if bt == "text" and block.get("text"):
                    if not streamed_partial:  # no partials → emit the whole block (back-compat)
                        yield {"type": "message-delta", "text": block["text"]}
                elif bt == "tool_use":
                    yield {
                        "type": "tool-call",
                        "tool": block.get("name", ""),
                        "args": block.get("input", {}),
                        "callId": block.get("id", ""),
                    }
        elif t == "user":
            for block in obj.get("message", {}).get("content", []) or []:
                if block.get("type") == "tool_result":
                    yield {
                        "type": "tool-result",
                        "callId": block.get("tool_use_id", ""),
                        "ok": not block.get("is_error", False),
                        "summary": _short(block.get("content")),
                    }
        elif t == "result":
            reply = obj.get("result", "")
            failed = obj.get('is_error') is True or obj.get('subtype') == 'error'
            if structured_output and str(obj.get('subtype', '')).startswith('error'):
                failed = True
            if structured_output and isinstance(obj.get('structured_output'), dict) and not failed:
                reply = json.dumps(obj['structured_output'], ensure_ascii=False)
            if obj.get("is_error") or obj.get("subtype") == "error":
                reply = _short(reply, max(400, len(str(reply))))
            done = {
                "type": "done",
                "reply": reply,
                "sessionId": obj.get("session_id"),
                "ok": not failed,
            }
            if not done["ok"] and looks_like_auth_failure(reply):
                # The CLI's own auth text ("Not logged in · Please run /login") is an internal of
                # THIS adapter — /login doesn't exist for an API consumer. Rewrite to the
                # platform-actionable message; the raw text rides along in `detail` (additive).
                done["detail"] = _short(reply, 200)
                done["reply"] = (
                    "Model credentials are missing or expired for this deployment. "
                    "Set or refresh one of HOST_CLAUDE_CREDENTIALS, ANTHROPIC_API_KEY, "
                    "ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN or TINA_LLM_API_KEY, "
                    "or configure a model under Settings → Models."
                )
                if os.environ.get("ANTHROPIC_BASE_URL", "").rstrip("/") == "https://api.deepseek.com/anthropic":
                    done["reply"] = "DeepSeek could not authenticate. Check the DeepSeek API key in Settings → Models."
            yield done


def build_argv(
    prompt: str,
    *,
    allowed_tools: Iterable[str] = (),
    session: Optional[str] = None,
    model: Optional[str] = None,
    mcp_config: Optional[str] = None,
    effort: Optional[str] = None,
    output_schema: Optional[dict] = None,
) -> list[str]:
    """The headless Claude Code argv — `claude -p <prompt> --output-format stream-json [...]`.

    `--permission-mode acceptEdits` auto-accepts Read/Edit/Write so the turn runs fully headless; the
    `--allowedTools` scope is the capability gate (the model writes entities, `run_harness_turn`
    does the git commit). `--mcp-config <file>` + `--strict-mcp-config` attach EXACTLY the unit's
    granted MCP tools (the toolbelt) and nothing else. The container sandbox is the other
    enforcement layer.

    `effort` is retained as a compatibility argument and ignored. All providers use automatic
    thinking; old settings must never reintroduce a manual CLI effort pin.
    """
    argv = ["claude", "-p", prompt, "--output-format", "stream-json", "--verbose",
            "--include-partial-messages", "--permission-mode", "acceptEdits"]
    tools = list(allowed_tools)
    if tools:
        argv += ["--allowedTools", ",".join(tools)]
    else:
        argv += ["--tools", ""]
    if mcp_config:
        argv += ["--mcp-config", mcp_config, "--strict-mcp-config"]
    if session:
        argv += ["--resume", session]
    if model:
        argv += ["--model", model]
    if output_schema is not None:
        argv += ["--json-schema", json.dumps(output_schema, ensure_ascii=False)]
    # The compatibility argument is deliberately ignored: thinking is always automatic.
    return argv


def _exec_subprocess(argv: list[str], cwd: str) -> Iterator[str]:
    # harness_subprocess_env: the model's Bash tool runs INSIDE this subprocess, so it must not inherit
    # the worker's data-plane secrets — ``REDIS_URL`` (which would let Bash reach the shared redis and
    # read/write another tenant's tc:meeting:* / unit:*:in streams, crossing the tenancy boundary the
    # mounts enforce on the filesystem) nor the minted per-dispatch bearer token. It also drops the
    # git repo-discovery redirects (a hook-exported GIT_DIR would re-point the workspace's git ops).
    # Feed the prompt on stdin so large authorized evidence packs do not exceed argv limits.
    command = [*argv[:2], *argv[3:]]
    proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
                            env=harness_subprocess_env())
    assert proc.stdout is not None
    assert proc.stdin is not None
    input_errors = []
    def send_prompt():
        try:
            proc.stdin.write(argv[2])
        except BrokenPipeError:
            pass  # Preserve the CLI's structured startup/auth error on stdout.
        except Exception:
            input_errors.append(True)
        finally:
            try: proc.stdin.close()
            except BrokenPipeError: pass
            except Exception: input_errors.append(True)
    writer = threading.Thread(target=send_prompt, daemon=True)
    writer.start()
    finished = False
    try:
        yield from proc.stdout
        finished = True
    finally:
        if not finished and proc.poll() is None: proc.terminate()
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait(timeout=3)
        writer.join(timeout=3)
        proc.stdout.close()
        if writer.is_alive() or input_errors:
            raise RuntimeError('Claude prompt input could not complete')


def _link_chat_into_workspace(work: Path) -> None:
    """Save + resume chats FROM THE WORKSPACE. claude-code stores a conversation's transcript at
    ``~/.claude/projects/<cwd-slug>/<session>.jsonl`` — inside the container, so it is wiped when the
    per-turn container is recreated (no memory). Symlink that dir into the workspace's ``.claude/projects``
    so the chat is written to the durable git folder and ``--resume`` reads it back across turns. We keep
    it under ``.claude`` (excluded from the governance ``git clean``) so a rejected turn never wipes the
    history; it persists on the workspace volume.

    SAFETY: only the disposable per-turn container HOME may be rewritten. Outside the container
    (a host test run, a developer shell) ``~/.claude/projects`` holds the developer's REAL session
    transcripts — this function must never delete data it didn't create. A pre-existing directory
    is therefore replaced only when EMPTY (``rmdir``, which cannot destroy content); a non-empty
    one is left alone and the link is skipped — the turn still works, without cross-turn resume."""
    ws_projects = work / ".claude" / "projects"
    home_claude = Path(os.environ.get("HOME", "/root")) / ".claude"
    link = home_claude / "projects"
    if link == ws_projects:
        # The S3 worker uses the private continuity root as HOME.
        if link.is_symlink() and os.readlink(link) == str(link):
            link.unlink()
        ws_projects.mkdir(parents=True, exist_ok=True)
        return
    ws_projects.mkdir(parents=True, exist_ok=True)
    home_claude.mkdir(parents=True, exist_ok=True)
    try:
        if link.is_symlink():
            if os.readlink(link) == str(ws_projects):
                return
            link.unlink()
        elif link.is_dir():
            if any(link.iterdir()):
                return  # real transcripts live here — never delete, skip the link
            link.rmdir()  # empty dir: safe to replace, nothing can be lost
        elif link.exists():
            return  # some other filesystem object — don't clobber
        link.symlink_to(ws_projects, target_is_directory=True)
    except OSError:
        pass  # best-effort; a fresh turn still works, just without cross-turn resume


def _link_skills_into_workspace(work: Path) -> None:
    """Expose the user's GOVERNED skills to the CLI. Skills live as VISIBLE, git-tracked files under the
    workspace's ``skills/<name>/SKILL.md`` (the ``skills/`` tree mirrors the ``agents/`` config home —
    not a dotfile, so it shows in the Files surface and is committed). claude-code auto-discovers skills
    from ``.claude/skills``, which is governance-excluded; so we point ``.claude/skills`` at the real
    ``skills/`` dir via a symlink. The real files stay durable + committed; the CLI finds them through
    the link. Idempotent: create ``skills/`` if absent, then (re)point a stale/wrong symlink — but never
    clobber a real ``.claude/skills`` directory."""
    skills = work / "skills"
    skills.mkdir(parents=True, exist_ok=True)
    link = work / ".claude" / "skills"
    link.parent.mkdir(parents=True, exist_ok=True)
    try:
        if link.is_symlink():
            if os.readlink(link) == str(skills):
                return
            link.unlink()
        elif link.exists():
            return  # a real dir already there — don't clobber
        link.symlink_to(skills, target_is_directory=True)
    except OSError:
        pass  # best-effort; the turn still works, just without workspace skills


class ClaudeCodeHarness:
    """``HarnessPort`` adapter for the Claude Code CLI. ``exec_fn`` is injectable for tests."""

    name = "claude-code"

    def __init__(self, exec_fn: Optional[HarnessExec] = None) -> None:
        self._exec: HarnessExec = exec_fn or _exec_subprocess

    def run_turn(self, work: Path, prompt: str, *, allowed_tools: Iterable[str] = (),
                 session: Optional[str] = None, model: Optional[str] = None,
                 mcp_config: Optional[str] = None, gated_mcp_servers: Iterable[str] = (),
                 mcp_servers: Optional[dict] = None, mcp_env: Optional[dict[str, str]] = None,
                 mcp_tools: Optional[dict[str, list[str]]] = None,
                 output_schema: Optional[dict] = None,
                 approval_handler: Optional[Callable[[dict], Optional[bool]]] = None) -> Iterator[dict]:
        mode = "bedrock" if os.environ.get("CLAUDE_CODE_USE_BEDROCK") == "1" else (
            "deepseek" if os.environ.get("ANTHROPIC_BASE_URL", "").rstrip("/") == "https://api.deepseek.com/anthropic"
            else "custom" if os.environ.get("ANTHROPIC_BASE_URL") else "subscription")
        effort = normalized_effort(mode, model or os.environ.get("TINA_AGENT_MODEL", ""), os.environ.get("TINA_AGENT_EFFORT"))
        reach = (mcp_servers or {}).get('tina-reach')
        if (mcp_config is None and isinstance(reach, dict) and 'mcp__tina-reach' in allowed_tools
                and 'tina-reach' not in gated_mcp_servers and (mcp_tools or {}).get('tina-reach')):
            # Public retrieval has no secret environment and its bridge advertises only granted tools.
            with tempfile.TemporaryDirectory(prefix='tina-reach-mcp-') as directory:
                config = Path(directory) / 'mcp.json'
                config.write_text(json.dumps({'mcpServers': {'tina-reach': {
                    'command': reach['command'], 'args': reach['args']}}}))
                argv = build_argv(prompt, allowed_tools=allowed_tools, session=session, model=model,
                                  effort=effort or None, mcp_config=str(config), output_schema=output_schema)
                yield from parse_stream_json(self._exec(argv, str(work)), structured_output=output_schema is not None)
            return
        argv = build_argv(prompt, allowed_tools=allowed_tools, session=session, model=model,
                          effort=effort or None,
                          mcp_config=mcp_config, output_schema=output_schema)
        yield from parse_stream_json(self._exec(argv, str(work)), structured_output=output_schema is not None)

    def prepare(self, work: Path, chat_root: Optional[Path] = None) -> None:
        # chats are saved to / resumed from the PRIVATE continuity root (the _system mount when the
        # dispatch declares one — the flat model can make the cwd a SHARED workspace, and chats are
        # private), not ~/.claude; skills stay cwd-scoped (.claude/skills → <work>/skills)
        _link_chat_into_workspace(chat_root or work)
        _link_skills_into_workspace(work)

    def transcript_bytes(self, work: Path, session_id: str) -> int:
        total = 0
        for path in (work / ".claude" / "projects").glob(f"*/{session_id}.jsonl"):
            try:
                total += path.stat().st_size
            except OSError:
                continue
        return total

    def preflight(self) -> Optional[str]:
        if os.environ.get("CLAUDE_CODE_USE_BEDROCK") == "1":
            if not os.environ.get("AWS_BEARER_TOKEN_BEDROCK"):
                return "Bedrock API key is missing. Add it in Settings → Models."
            if not os.environ.get("AWS_REGION") or not os.environ.get("TINA_AGENT_MODEL"):
                return "Choose a Bedrock region and an approved model in Settings → Models."
            return None
        if os.environ.get("ANTHROPIC_BASE_URL", "").rstrip("/") == "https://api.deepseek.com/anthropic":
            if not os.environ.get("ANTHROPIC_AUTH_TOKEN"):
                return "DeepSeek API key is missing. Add it in Settings → Models."
            if "TINA_AGENT_MODEL" in os.environ and not os.environ["TINA_AGENT_MODEL"].strip():
                return "No approved DeepSeek chat model is selected. Choose an allowed model in Settings → Models."
        return preflight_provider_guard()
