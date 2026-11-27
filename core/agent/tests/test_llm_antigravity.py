from __future__ import annotations

import json
import subprocess
from pathlib import Path

from llm.antigravity import AntigravityHarness, build_argv, parse_stream_json
from llm.ports import run_harness_turn


def _event(value: dict) -> str:
    return json.dumps(value) + "\n"


def test_gemini_api_uses_native_provider_without_consumer_oauth_ack(monkeypatch, tmp_path):
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "gemini-api")
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-own-key")
    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "")
    monkeypatch.setenv("TINA_AGENT_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("TINA_LLM_BASE_URL", "https://generativelanguage.googleapis.com/v1beta/openai")
    captured = {}

    def execute(argv, _cwd):
        captured["model"] = argv[argv.index("--model") + 1]
        path = Path(argv[argv.index("--settings") + 1])
        captured["settings"] = json.loads(path.read_text())
        return [_event({"event": "result", "result": {"status": "SUCCESS", "response": "OK"}})]

    harness = AntigravityHarness(exec_fn=execute)
    harness.prepare(tmp_path)
    assert harness.preflight() is None
    events = list(harness.run_turn(tmp_path, "hello", model="gemini-3.8-flash", allowed_tools=["Read"]))
    assert events[-1]["ok"] is True
    assert captured["model"] == "gemini-3.8-flash"
    assert captured["settings"]["modelProvider"] == "gemini"
    assert "gemini-own-key" not in json.dumps(captured)
    monkeypatch.setenv("TINA_AGENT_MODEL", "")
    assert "approved Gemini chat model" in harness.preflight()
    monkeypatch.delenv("GEMINI_API_KEY")
    assert "Gemini API key is missing" in harness.preflight()


def test_gemini_api_error_redacts_its_credential(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-own-key")
    events = list(parse_stream_json([_event({"event": "result", "result": {
        "status": "ERROR", "error": "HTTP 401: invalid gemini-own-key",
    }})]))
    assert not events[-1]["ok"]
    assert "gemini-own-key" not in json.dumps(events)


def test_parse_stream_json_normalizes_text_tools_and_session():
    events = list(parse_stream_json([
        _event({"event": "init", "conversation_id": "conv-1"}),
        _event({"event": "step_update", "step_update": {
            "step_type": "agent_response", "text_delta": "hello ",
        }}),
        _event({"event": "step_update", "step_update": {
            "step_type": "tool", "step_index": 3, "state": "ACTIVE",
            "tool_info": {"name": "run_command", "parameters": {"command": "pwd"}},
        }}),
        _event({"event": "step_update", "step_update": {
            "step_type": "tool", "step_index": 3, "state": "DONE",
            "tool_info": {"name": "run_command", "parameters": {"command": "pwd"},
                          "output": "/workspace", "error": None},
        }}),
        _event({"event": "result", "result": {
            "conversation_id": "conv-1", "response": "hello ", "status": "SUCCESS",
        }}),
    ]))

    assert events == [
        {"type": "message-delta", "text": "hello "},
        {"type": "tool-call", "tool": "Bash", "args": {"command": "pwd"},
         "callId": "conv-1:3"},
        {"type": "tool-result", "callId": "conv-1:3", "ok": True, "summary": "/workspace"},
        {"type": "done", "reply": "hello ", "sessionId": "conv-1", "ok": True},
    ]


def test_parse_stream_json_maps_auth_failure_and_missing_result():
    auth = list(parse_stream_json([
        _event({"event": "result", "result": {
            "conversation_id": "conv-auth", "status": "ERROR",
            "error": "Not logged in. Run agy auth login.",
        }}),
    ]))
    assert auth[-1]["ok"] is False
    assert auth[-1]["sessionId"] == "conv-auth"
    assert "could not authenticate" in auth[-1]["reply"]

    missing = list(parse_stream_json(["unexpected CLI output\n"]))
    assert missing[-1]["ok"] is False
    assert "exited without a result event" in missing[-1]["reply"]


def test_build_argv_uses_headless_sandbox_continuity_and_model():
    argv = build_argv(
        "inspect safely", session="conv-2", model="gemini-3.8-flash",
        effort="high", settings_path="/tmp/tina-agy.json",
        extra_dirs=["/workspaces/system", "/workspaces/shared"],
    )

    assert argv[:7] == [
        "agy", "-p", "inspect safely", "--output-format", "stream-json",
        "--sandbox", "--mode",
    ]
    assert "accept-edits" in argv
    assert argv[argv.index("--conversation") + 1] == "conv-2"
    assert argv[argv.index("--model") + 1] == "gemini-3.8-flash"
    assert argv[argv.index("--settings") + 1] == "/tmp/tina-agy.json"
    assert "--effort" not in argv
    assert argv.count("--add-dir") == 2


class _Stdout:
    def __init__(self, lines: list[str]):
        self._lines = list(lines)

    def __iter__(self):
        return iter(self._lines)


class _Process:
    def __init__(self, lines: list[str]):
        self.stdout = _Stdout(lines)

    def wait(self):
        return 0


def test_run_turn_applies_mount_permissions_and_only_auto_ungated_mcp(
    monkeypatch, tmp_path: Path,
):
    work = tmp_path / "workspace"
    system = tmp_path / "system"
    shared = tmp_path / "shared"
    private = tmp_path / "private"
    for directory in (work, system, shared, private):
        directory.mkdir()
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "gemini-api")
    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "true")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("TINA_CHAT_SESSION", "thread-1")
    monkeypatch.setenv("TINA_AGENT_EFFORT", "medium")
    monkeypatch.setenv("REDIS_URL", "redis://secret")
    monkeypatch.setenv("TINA_AGENT_IDENTITY_TOKEN", "identity-secret")
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"path": str(work), "write": True, "primary": True},
        {"path": str(system), "write": True},
        {"path": str(shared), "write": False},
    ]))
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")

    stream = [
        _event({"event": "init", "conversation_id": "conv-3"}),
        _event({"event": "result", "result": {
            "conversation_id": "conv-3", "status": "SUCCESS", "response": "done",
        }}),
    ]
    captured: dict = {}

    def popen(argv, *, cwd, env, **_kwargs):
        captured["argv"] = argv
        captured["cwd"] = cwd
        captured["env"] = env
        home = Path(env["HOME"])
        captured["settings"] = json.loads(
            (home / ".gemini" / "antigravity-cli" / "settings.json").read_text(),
        )
        mcp_path = home / ".gemini" / "config" / "mcp_config.json"
        captured["mcp"] = json.loads(mcp_path.read_text()) if mcp_path.exists() else {}
        return _Process(stream)

    monkeypatch.setattr("llm.antigravity.subprocess.Popen", popen)
    harness = AntigravityHarness()
    harness.prepare(work, chat_root=private)
    events = list(harness.run_turn(
        work,
        "write a note",
        allowed_tools=["Read", "Write", "Edit", "Bash", "mcp__notes", "mcp__gated",
                       "mcp__credentialed"],
        session="conv-previous",
        model="gemini-flash",
        gated_mcp_servers=["gated"],
        mcp_servers={
            "notes": {"command": "notes-mcp", "args": []},
            "gated": {"command": "gated-mcp", "args": []},
            "credentialed": {"command": "private-mcp", "env_vars": ["SECRET"]},
        },
        mcp_env={"SECRET": "never-persist"},
        mcp_tools={
            "notes": ["search"],
            "gated": ["send"],
            "credentialed": ["read"],
        },
    ))

    settings = captured["settings"]
    assert captured["cwd"] == str(work)
    assert captured["env"]["HOME"] == str(harness._home)
    assert "REDIS_URL" not in captured["env"]
    assert "TINA_AGENT_IDENTITY_TOKEN" not in captured["env"]
    assert captured["argv"][captured["argv"].index("--conversation") + 1] == "conv-previous"
    assert captured["argv"][captured["argv"].index("--model") + 1] == "gemini-flash"
    assert captured["argv"][captured["argv"].index("--add-dir") + 1] == str(system)
    assert captured["argv"][captured["argv"].index("--add-dir", captured["argv"].index("--add-dir") + 1) + 1] == str(shared)
    assert settings["agentMode"] == "accept-edits"
    assert settings["modelProvider"] == "gemini"
    assert f"read_file({shared})" in settings["permissions"]["allow"]
    assert f"write_file({work})" in settings["permissions"]["allow"]
    assert f"write_file({system})" in settings["permissions"]["allow"]
    assert not any(f"write_file({shared})" == rule for rule in settings["permissions"]["allow"])
    assert "mcp(notes/search)" in settings["permissions"]["allow"]
    assert captured["mcp"] == {"mcpServers": {
        "notes": {"enabledTools": ["search"], "command": "notes-mcp", "args": []},
    }}
    assert events[-1] == {
        "type": "done", "reply": "done", "sessionId": "conv-3", "ok": True,
    }
    assert not (
        private / ".claude" / "antigravity-home" / ".gemini" / "antigravity-cli"
        / "settings.json"
    ).exists()


def test_run_turn_readonly_policy_disables_mutations(monkeypatch, tmp_path: Path):
    work = tmp_path / "workspace"
    work.mkdir()
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"path": str(work), "write": True, "primary": True},
    ]))
    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "true")
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")
    captured: dict = {}

    def popen(argv, *, cwd, env, **_kwargs):
        captured["argv"] = argv
        home = Path(env["HOME"])
        captured["settings"] = json.loads(
            (home / ".gemini" / "antigravity-cli" / "settings.json").read_text(),
        )
        return _Process([_event({"event": "result", "result": {
            "conversation_id": "readonly", "status": "SUCCESS", "response": "inspected",
        }})])

    monkeypatch.setattr("llm.antigravity.subprocess.Popen", popen)
    harness = AntigravityHarness()
    harness.prepare(work)

    events = list(harness.run_turn(work, "inspect", allowed_tools=["Read", "Glob"]))

    assert "--mode" in captured["argv"]
    assert captured["argv"][captured["argv"].index("--mode") + 1] == "plan"
    assert captured["settings"]["permissions"]["deny"] == [
        "write_file(*)", "command(*)", "read_url(*)",
    ]
    assert events[-1]["ok"] is True


def test_preflight_requires_the_terms_acknowledgment_and_api_key_when_selected(
    monkeypatch,
):
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")
    harness = AntigravityHarness()
    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "")
    assert "Terms warning" in harness.preflight()

    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "true")
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "gemini-api")
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    assert "Gemini API key is missing" in harness.preflight()

    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "oauth")
    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "true")
    assert harness.preflight() is None


def test_antigravity_turn_uses_tina_commit_and_author_governance(monkeypatch, tmp_path: Path):
    work = tmp_path / "workspace"
    private = tmp_path / "private"
    work.mkdir()
    private.mkdir()
    subprocess.run(["git", "init"], cwd=work, check=True, capture_output=True)
    subprocess.run([
        "git", "-c", "user.name=TINA", "-c", "user.email=platform@tina.local",
        "commit", "--allow-empty", "-m", "baseline",
    ], cwd=work, check=True, capture_output=True)
    monkeypatch.setenv("TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED", "true")
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "oauth")
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")

    def execute(_argv, cwd):
        (Path(cwd) / "agent-note.md").write_text("Antigravity output\n")
        return [
            _event({"event": "init", "conversation_id": "governed-conv"}),
            _event({"event": "result", "result": {
                "conversation_id": "governed-conv", "status": "SUCCESS", "response": "done",
            }}),
        ]

    harness = AntigravityHarness(exec_fn=execute)
    harness.prepare(work, chat_root=private)
    events = list(run_harness_turn(
        work, "write a note", harness, allowed_tools=["Read", "Write", "Edit"],
        author=("Alice", "alice@example.test"),
    ))

    assert events[-1]["type"] == "commit"
    assert (work / "agent-note.md").read_text() == "Antigravity output\n"
    assert subprocess.run(
        ["git", "show", "-s", "--format=%an|%ae|%cn", "HEAD"],
        cwd=work, check=True, capture_output=True, text=True,
    ).stdout.strip() == "Alice|alice@example.test|TINA"


def test_prepare_links_governed_skills_without_overwriting_existing_agents(tmp_path: Path):
    work = tmp_path / "workspace"
    skills = work / "skills"
    (skills / "notes").mkdir(parents=True)
    (skills / "notes" / "SKILL.md").write_text("# Notes\n")
    AntigravityHarness().prepare(work)
    link = work / ".agents" / "skills"
    assert link.is_symlink()
    assert link.resolve() == skills.resolve()

    custom = tmp_path / "custom"
    existing = custom / ".agents" / "skills"
    existing.mkdir(parents=True)
    (existing / "mine.md").write_text("keep")
    AntigravityHarness().prepare(custom)
    assert not existing.is_symlink()
    assert (existing / "mine.md").read_text() == "keep"


def test_prepare_isolates_cli_state_per_tina_chat_session(monkeypatch, tmp_path: Path):
    work = tmp_path / "workspace"
    private = tmp_path / "private"
    work.mkdir()
    private.mkdir()

    monkeypatch.setenv("TINA_CHAT_SESSION", "chat-a")
    first = AntigravityHarness()
    first.prepare(work, chat_root=private)
    monkeypatch.setenv("TINA_CHAT_SESSION", "chat-b")
    second = AntigravityHarness()
    second.prepare(work, chat_root=private)

    assert first._home is not None and second._home is not None
    assert first._home != second._home
    assert first._home.parent == second._home.parent


def test_antigravity_excludes_system_mount_locks_global_and_respects_untrusted_trigger(
    monkeypatch, tmp_path: Path,
):
    shared_ro = tmp_path / "shared-ro"
    global_dir = tmp_path / "_global"
    system_dir = tmp_path / "_system"
    for d in (shared_ro, global_dir, system_dir):
        d.mkdir()
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "gemini-api")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "team", "path": str(shared_ro), "role": "shared", "write": False},
        {"slug": "_global", "path": str(global_dir), "role": "global", "write": True},
        {"slug": "_system", "path": str(system_dir), "role": "system", "write": True},
    ]))
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")

    captured: dict = {}

    def execute(argv, _cwd):
        captured["argv"] = argv
        captured["settings"] = json.loads(Path(argv[argv.index("--settings") + 1]).read_text())
        return [_event({"event": "result", "result": {"status": "SUCCESS", "response": "ok"}})]

    harness = AntigravityHarness(exec_fn=execute)
    harness.prepare(shared_ro, chat_root=system_dir)
    events = list(harness.run_turn(shared_ro, "inspect", allowed_tools=["Read", "Write", "Edit", "Bash"]))
    assert events[-1]["ok"] is True
    assert captured["argv"][captured["argv"].index("--mode") + 1] == "plan"
    assert str(system_dir) not in captured["argv"]
    allow = captured["settings"]["permissions"]["allow"]
    assert not any(str(system_dir) in rule for rule in allow)
    assert not any(rule.startswith("write_file(") for rule in allow)
    assert "write_file(*)" in captured["settings"]["permissions"]["deny"]

    # Untrusted event trigger forces read-only even on a writable private mount.
    priv = tmp_path / "priv"
    priv.mkdir()
    monkeypatch.setenv("TINA_UNIT_TRIGGER", "event")
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "2", "path": str(priv), "role": "private", "write": True},
    ]))
    harness.prepare(priv, chat_root=system_dir)
    list(harness.run_turn(priv, "event turn", allowed_tools=["Read", "Write", "Edit"]))
    assert captured["argv"][captured["argv"].index("--mode") + 1] == "plan"
    assert "write_file(*)" in captured["settings"]["permissions"]["deny"]


import pytest


@pytest.mark.parametrize("read_only_turn", [False, True])
def test_antigravity_fargate_disables_sandbox_and_attaches_workspace_mcp(
    monkeypatch, tmp_path: Path, read_only_turn: bool,
):
    private = tmp_path / "2"
    global_dir = tmp_path / "_global"
    system_dir = tmp_path / "_system"
    for d in (private, global_dir, system_dir):
        d.mkdir()
    monkeypatch.setenv("TINA_ANTIGRAVITY_AUTH_MODE", "gemini-api")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    monkeypatch.setenv("TINA_WORKSPACE_SYNC_SIDECAR", "1")
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "2", "path": str(private), "role": "private", "write": True, "primary": True},
        {"slug": "_global", "path": str(global_dir), "role": "global", "write": False},
        {"slug": "_system", "path": str(system_dir), "role": "system", "write": True},
    ]))
    monkeypatch.setattr("llm.antigravity.shutil.which", lambda _name: "/usr/local/bin/agy")

    captured: dict = {}

    def execute(argv, _cwd):
        captured["argv"] = argv
        captured["settings"] = json.loads(Path(argv[argv.index("--settings") + 1]).read_text())
        assert harness._home is not None
        mcp_path = harness._home / ".gemini" / "config" / "mcp_config.json"
        captured["mcp"] = json.loads(mcp_path.read_text())
        mounts_files = list(harness._home.glob("tina-mounts-*.json"))
        assert len(mounts_files) == 1
        captured["mounts_file"] = mounts_files[0]
        return [_event({"event": "result", "result": {"status": "SUCCESS", "response": "ok"}})]

    harness = AntigravityHarness(exec_fn=execute)
    harness.prepare(private, chat_root=system_dir)
    tools = ["Read", "Bash"] if read_only_turn else ["Read", "Write", "Edit", "Bash"]
    events = list(harness.run_turn(private, "Summarize Jane Liu", allowed_tools=tools))
    assert events[-1]["ok"] is True
    assert "--sandbox" not in captured["argv"]
    assert captured["settings"]["enableTerminalSandbox"] is False
    assert "command(*)" in captured["settings"]["permissions"]["deny"]
    assert "write_file(*)" in captured["settings"]["permissions"]["deny"]
    assert "mcp(tina-workspace/search_wiki)" in captured["settings"]["permissions"]["allow"]
    assert "tina-workspace" in captured["mcp"]["mcpServers"]
    ws_args = captured["mcp"]["mcpServers"]["tina-workspace"]["args"]
    if read_only_turn:
        assert captured["argv"][captured["argv"].index("--mode") + 1] == "plan"
        assert captured["settings"]["agentMode"] == "plan"
        assert "mcp(tina-workspace/create_wiki)" not in captured["settings"]["permissions"]["allow"]
        assert "--readonly" in ws_args
    else:
        assert captured["argv"][captured["argv"].index("--mode") + 1] == "accept-edits"
        assert captured["settings"]["agentMode"] == "accept-edits"
        assert "mcp(tina-workspace/create_wiki)" in captured["settings"]["permissions"]["allow"]
        assert "--readonly" not in ws_args
    assert "tina-workspace" in captured["argv"][captured["argv"].index("-p") + 1]
    assert not captured["mounts_file"].exists()
