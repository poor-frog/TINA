from __future__ import annotations

import json
import tomllib
from contextlib import contextmanager
from pathlib import Path

import pytest

from llm.codex import CodexHarness


class _Stdout:
    def __init__(self):
        self.lines = []

    def readline(self):
        return self.lines.pop(0) if self.lines else ""


class _Stdin:
    def __init__(self, proc):
        self.proc = proc

    def write(self, line):
        request = json.loads(line)
        self.proc.requests.append(request)
        method = request.get("method")
        if method == "initialize":
            self.proc.stdout.lines.append(json.dumps({"id": request["id"], "result": {}}) + "\n")
        elif method == "configRequirements/read":
            self.proc.stdout.lines.append(json.dumps({
                "id": request["id"], "result": {"requirements": self.proc.requirements},
            }) + "\n")
        elif method == "thread/start":
            self.proc.stdout.lines.append(json.dumps({
                "id": request["id"], "result": {"thread": {"id": "thread-readonly"}},
            }) + "\n")
        elif method == "thread/resume":
            self.proc.stdout.lines.append(json.dumps({"id": request["id"], "result": {}}) + "\n")
        elif method == "turn/start":
            self.proc.stdout.lines.append(json.dumps({"id": request["id"], "result": {"turn": {"id": "turn-citations"}}}) + "\n")
            self.proc.stdout.lines.extend(json.dumps(event) + "\n" for event in self.proc.notifications)
            turn = {"status": self.proc.turn_status}
            if self.proc.turn_error:
                turn["error"] = {"message": self.proc.turn_error}
            self.proc.stdout.lines.append(json.dumps({
                "method": "turn/completed", "params": {"turn": turn},
            }) + "\n")

    def flush(self):
        pass

    def close(self):
        pass


class _FakeCodexProcess:
    def __init__(self, *, notifications=(), turn_status="completed", turn_error=None, requirements=None):
        self.requests = []
        self.notifications = list(notifications)
        self.turn_status = turn_status
        self.turn_error = turn_error
        self.requirements = requirements
        self.stdout = _Stdout()
        self.stdin = _Stdin(self)

    def poll(self):
        return None

    def terminate(self):
        pass

    def wait(self, timeout=None):
        return 0

    def kill(self):
        pass


def test_groq_codex_requires_its_own_key(monkeypatch):
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setenv("TINA_CODEX_AUTH_MODE", "groq")
    monkeypatch.setenv("OPENAI_API_KEY", "foreign-key")
    monkeypatch.delenv("TINA_LLM_API_KEY", raising=False)
    assert "Groq API key is missing" in CodexHarness().preflight()


def test_groq_codex_does_not_replace_a_rejected_model_with_its_own_default(monkeypatch, tmp_path):
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setenv("TINA_CODEX_AUTH_MODE", "groq")
    monkeypatch.setenv("TINA_LLM_API_KEY", "groq-secret")
    monkeypatch.setenv("TINA_AGENT_MODEL", "")
    result = list(CodexHarness().run_turn(tmp_path, "hello"))
    assert result[-1]["ok"] is False
    assert "approved Groq chat model" in result[-1]["reply"]


def test_groq_text_only_model_fails_helpfully_before_starting_a_cli(monkeypatch, tmp_path):
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setenv("TINA_CODEX_AUTH_MODE", "groq")
    monkeypatch.setenv("TINA_LLM_API_KEY", "groq-secret")
    result = list(CodexHarness().run_turn(tmp_path, "hello", model="allam-2-7b"))
    assert result[-1]["ok"] is False
    assert "does not support tool calling" in result[-1]["reply"]
    assert "Meeting model" in result[-1]["reply"]
    assert "groq-secret" not in json.dumps(result)


def test_groq_codex_uses_compatibility_boundary_for_the_whole_sandboxed_turn(monkeypatch, tmp_path):
    proc = _FakeCodexProcess()
    captured = {}
    proxy_states = []

    @contextmanager
    def proxy(key):
        assert key == "groq-secret"
        proxy_states.append("started")
        try:
            yield "http://127.0.0.1:12345/v1"
        finally:
            proxy_states.append("stopped")

    def spawn(argv, **kwargs):
        assert proxy_states == ["started"]
        captured.update(argv=argv, env=kwargs["env"])
        profile_arg = next(arg for arg in argv if arg.startswith("model_catalog_json="))
        profile_path = Path(json.loads(profile_arg.partition("=")[2]))
        captured["profile"] = json.loads(profile_path.read_text())["models"][0]
        return proc

    monkeypatch.setattr("llm.groq_responses.groq_responses_proxy", proxy)
    monkeypatch.setattr("llm.codex.subprocess.Popen", spawn)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setenv("TINA_CODEX_AUTH_MODE", "groq")
    monkeypatch.setenv("TINA_LLM_API_KEY", "groq-secret")
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([{
        "path": str(tmp_path), "write": True, "role": "private",
    }]))

    events = list(CodexHarness().run_turn(tmp_path, "summarize this meeting", allowed_tools=["Read"]))

    assert proxy_states == ["started", "stopped"]
    settings = "\n".join(captured["argv"])
    assert 'model_provider="groq"' in settings
    assert 'model_providers.groq.base_url="http://127.0.0.1:12345/v1"' in settings
    assert 'model_providers.groq.env_key="TINA_LLM_API_KEY"' in settings
    assert 'model_providers.groq.requires_openai_auth=false' in settings
    assert 'features.multi_agent=false' in settings
    assert captured["profile"]["apply_patch_tool_type"] is None
    assert "apply_patch" not in captured["profile"]["base_instructions"]
    assert "You are TINA" in captured["profile"]["base_instructions"]
    assert "groq-secret" not in settings
    assert "shell_environment_policy.ignore_default_excludes=false" in settings
    assert "model_context_window=131072" in settings
    assert "model_auto_compact_token_limit=100000" in settings
    by_method = {request.get("method"): request for request in proc.requests}
    assert by_method["turn/start"]["params"]["permissions"] == "tina-offline"
    assert by_method["thread/start"]["params"]["permissions"] == "tina-offline"
    config = tomllib.loads("\n".join(captured["argv"][i + 1] for i, arg in enumerate(captured["argv"]) if arg == "-c"))
    assert config["permissions"]["tina-offline"]["network"]["enabled"] is False
    assert config["permissions"]["tina-offline"]["filesystem"] == {":root": "read"}
    assert events[-1]["ok"] is True


def test_groq_codex_auth_errors_redact_the_key_and_name_the_right_provider(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(turn_status="failed", turn_error="HTTP 401: groq-secret is invalid")

    @contextmanager
    def proxy(_key):
        yield "http://127.0.0.1:12345/v1"

    monkeypatch.setattr("llm.groq_responses.groq_responses_proxy", proxy)
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setenv("TINA_CODEX_AUTH_MODE", "groq")
    monkeypatch.setenv("TINA_LLM_API_KEY", "groq-secret")
    events = list(CodexHarness().run_turn(tmp_path, "hello"))
    assert events[-1]["ok"] is False
    assert "Groq" in events[-1]["reply"]
    assert "groq-secret" not in json.dumps(events)


@pytest.mark.parametrize("session", [None, "thread-existing"])
def test_codex_uses_read_only_sandbox_when_only_read_tools_are_allowed(
    monkeypatch, tmp_path, session,
):
    proc = _FakeCodexProcess()
    (tmp_path / "CLAUDE.md").write_text("TINA workspace rules")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([{
        "slug": "workspace-1", "path": str(tmp_path), "role": "private", "write": True,
    }]))
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    events = list(CodexHarness().run_turn(
        tmp_path, "triage this event",
        allowed_tools=["Read", "Glob", "Grep", "WebSearch", "WebFetch"],
        session=session,
    ))

    by_method = {request.get("method"): request for request in proc.requests}
    if session is None:
        assert by_method["thread/start"]["params"]["permissions"] == "tina-offline"
        assert by_method["thread/start"]["params"]["developerInstructions"].startswith("TINA workspace rules")
    else:
        assert by_method["thread/resume"]["params"]["developerInstructions"].startswith("TINA workspace rules")
    assert by_method["turn/start"]["params"]["permissions"] == "tina-offline"
    assert events[-1]["type"] == "done" and events[-1]["ok"] is True


@pytest.mark.parametrize('structured', [False, True])
def test_output_schema_is_opt_in_and_voice_uses_only_the_completed_final_message(monkeypatch, tmp_path, structured):
    body = {'tool_calls': []}
    notifications = [
        {'method': 'item/agentMessage/delta', 'params': {'delta': 'I will inspect the sources.'}},
        {'method': 'item/completed', 'params': {'item': {'type': 'agentMessage', 'phase': 'final_answer', 'text': json.dumps(body)}}},
    ]
    proc = _FakeCodexProcess(notifications=notifications)
    monkeypatch.setenv('OPENAI_API_KEY', 'synthetic')
    monkeypatch.delenv('TINA_CODEX_AUTH_MODE', raising=False)
    monkeypatch.setenv('TINA_MOUNTS', '[]')
    monkeypatch.setattr('llm.codex.shutil.which', lambda _: '/usr/bin/codex')
    monkeypatch.setattr('llm.codex.subprocess.Popen', lambda *a, **k: proc)
    schema = {'type': 'object', 'properties': {'tool_calls': {'type': 'array'}}}
    options = {'output_schema': schema} if structured else {}
    events = list(CodexHarness().run_turn(tmp_path, 'synthetic', **options))
    params = next(r['params'] for r in proc.requests if r.get('method') == 'turn/start')
    assert events[-1]['ok'] is True
    if structured:
        assert params['outputSchema'] == schema and json.loads(events[-1]['reply']) == body
    else:
        assert 'outputSchema' not in params and events[-1]['reply'] == 'I will inspect the sources.'


@pytest.mark.parametrize("session", [None, "thread-existing"])
@pytest.mark.parametrize("trigger,tools,web_mode,network", [
    ("message", ["Read", "Write", "Bash", "WebSearch", "WebFetch"], "live", True),
    ("scheduled", ["Read", "Write", "Bash", "WebSearch", "WebFetch"], "live", True),
    ("message", ["Read", "Write", "Bash", "WebSearch"], "cached", False),
    ("message", ["Read", "Write", "WebSearch", "WebFetch"], "live", False),
    ("message", ["Read", "Write", "Bash", "WebFetch"], "disabled", True),
    ("message", ["Read", "WebSearch", "WebFetch"], "live", False),
    ("event", ["Read", "Write", "Bash", "WebSearch", "WebFetch"], "disabled", False),
    ("transcription", ["Read", "Write", "Bash", "WebSearch", "WebFetch"], "disabled", False),
    ("unknown", ["Read", "Write", "Bash", "WebSearch", "WebFetch"], "disabled", False),
])
def test_codex_web_and_shell_network_follow_turn_grants(
    monkeypatch, tmp_path, session, trigger, tools, web_mode, network,
):
    proc = _FakeCodexProcess(requirements={"network": {
        "enabled": None, "managedAllowedDomainsOnly": True,
        "allowLocalBinding": False, "allowUpstreamProxy": False,
        "dangerouslyAllowNonLoopbackProxy": False, "dangerouslyAllowAllUnixSockets": False,
    }})
    spawned = {}

    def spawn(argv, **_kwargs):
        spawned["argv"] = argv
        return proc

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setenv("TINA_UNIT_TRIGGER", trigger)
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([{
        "slug": "private", "path": str(tmp_path), "write": True,
    }]))
    monkeypatch.setattr("llm.codex.shutil.which", lambda _: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", spawn)

    events = list(CodexHarness().run_turn(tmp_path, "research this repo", allowed_tools=tools, session=session))

    requests = {request.get("method"): request for request in proc.requests}
    assert requests["initialize"]["params"]["capabilities"]["experimentalApi"] is True
    thread = requests["thread/resume" if session else "thread/start"]["params"]
    assert thread["config"]["web_search"] == web_mode
    assert f'web_search="{web_mode}"' in spawned["argv"]
    assert "features.network_proxy=true" in spawned["argv"]
    assert requests["turn/start"]["params"]["permissions"] == ("tina-online" if network else "tina-offline")
    assert thread["permissions"] == ("tina-online" if network else "tina-offline")
    settings = tomllib.loads("\n".join(spawned["argv"][i + 1] for i, arg in enumerate(spawned["argv"]) if arg == "-c"))
    filesystem = settings["permissions"]["tina-offline"]["filesystem"]
    assert filesystem[":root"] == "read"
    assert (filesystem.get(str(tmp_path)) == "write") is (trigger in ("message", "scheduled") and "Write" in tools)
    assert events[-1]["ok"] is True


@pytest.mark.parametrize("override", [
    None, {"enabled": False}, {"enabled": True}, {"managedAllowedDomainsOnly": False},
    {"allowLocalBinding": True}, {"allowUpstreamProxy": True},
    {"dangerouslyAllowNonLoopbackProxy": True}, {"dangerouslyAllowAllUnixSockets": True},
    {"allowUnixSockets": ["/var/run/docker.sock"]}, {"unixSockets": {"/var/run/docker.sock": "allow"}},
])
def test_codex_never_enables_unfiltered_shell_network(monkeypatch, tmp_path, override):
    policy = {
        "enabled": None, "managedAllowedDomainsOnly": True,
        "allowLocalBinding": False, "allowUpstreamProxy": False,
        "dangerouslyAllowNonLoopbackProxy": False, "dangerouslyAllowAllUnixSockets": False,
    }
    if override:
        policy.update(override)
    proc = _FakeCodexProcess(requirements={"network": policy} if override is not None else None)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setenv("TINA_UNIT_TRIGGER", "message")
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([{"path": str(tmp_path), "write": True}]))
    monkeypatch.setattr("llm.codex.shutil.which", lambda _: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    events = list(CodexHarness().run_turn(
        tmp_path, "fetch repo", allowed_tools=["Read", "Write", "Bash", "WebFetch"],
    ))

    if override == {"enabled": True}:
        assert not any(request.get("method") == "turn/start" for request in proc.requests)
        assert events[-1]["ok"] is False
        assert "enabled unset" in events[-1]["reply"]
    else:
        turn = next(request for request in proc.requests if request.get("method") == "turn/start")
        assert turn["params"]["permissions"] == "tina-offline"
        assert events[-1]["ok"] is True


def test_codex_keeps_workspace_write_sandbox_for_write_tools(monkeypatch, tmp_path):
    proc = _FakeCodexProcess()
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setenv("TINA_AGENT_EFFORT", "medium")
    workspace = tmp_path / "workspace-1"
    system = tmp_path / ".system" / "17"
    viewer = tmp_path / "shared-view"
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "workspace-1", "path": str(workspace), "role": "private", "write": True},
        {"slug": "_system", "path": str(system), "role": "system", "write": True},
        {"slug": "shared-view", "path": str(viewer), "role": "shared", "write": False},
    ]))
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    list(CodexHarness().run_turn(
        workspace, "write a note",
        allowed_tools=["Read", "Write", "Edit", "Bash"],
        model="gpt-5",
    ))

    by_method = {request.get("method"): request for request in proc.requests}
    assert by_method["thread/start"]["params"]["permissions"] == "tina-offline"
    assert by_method["turn/start"]["params"]["permissions"] == "tina-offline"
    argv = CodexHarness()._argv(writable_roots=[str(workspace), str(system)])
    settings = tomllib.loads("\n".join(argv[i + 1] for i, arg in enumerate(argv) if arg == "-c"))
    for name, profile in settings["permissions"].items():
        assert profile["filesystem"][str(workspace)] == "write"
        assert profile["filesystem"][str(system)] == "write"
        assert str(viewer) not in profile["filesystem"]
        assert profile["filesystem"][str(workspace / ".git")] == "read"
        assert profile["network"]["enabled"] is (name == "tina-online")
    assert "effort" not in by_method["turn/start"]["params"]


def test_codex_stays_read_only_when_no_mount_has_a_write_grant(monkeypatch, tmp_path):
    proc = _FakeCodexProcess()
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setenv("TINA_MOUNTS", json.dumps([
        {"slug": "viewer", "path": str(tmp_path), "role": "private", "write": False},
    ]))
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    list(CodexHarness().run_turn(
        tmp_path, "inspect only", allowed_tools=["Read", "Write", "Edit", "Bash"],
    ))

    by_method = {request.get("method"): request for request in proc.requests}
    assert by_method["thread/start"]["params"]["permissions"] == "tina-offline"
    assert by_method["turn/start"]["params"]["permissions"] == "tina-offline"


def test_codex_prepare_exposes_workspace_skills_without_overwriting_user_agents(tmp_path):
    work = tmp_path / "workspace"
    skills = work / "skills"
    (skills / "scheduling").mkdir(parents=True)
    (skills / "scheduling" / "SKILL.md").write_text("# Schedule safely\n")
    codex_home = tmp_path / "private" / ".codex"

    CodexHarness().prepare(work, chat_root=tmp_path / "private")

    link = work / ".agents" / "skills"
    assert link.is_symlink()
    assert link.resolve() == skills.resolve()
    assert codex_home.exists()

    custom = work / "custom-workspace"
    (custom / "skills").mkdir(parents=True)
    existing = custom / ".agents" / "skills"
    existing.mkdir(parents=True)
    (existing / "user-skill.md").write_text("keep")
    CodexHarness().prepare(custom, chat_root=tmp_path / "other-private")

    assert not existing.is_symlink()
    assert (existing / "user-skill.md").read_text() == "keep"


def test_codex_transcript_bytes_counts_rollouts_for_one_thread(tmp_path: Path):
    work = tmp_path / "workspace"
    work.mkdir()
    chat_root = tmp_path / "private"
    harness = CodexHarness()
    harness.prepare(work, chat_root=chat_root)
    home = harness._codex_home
    assert home is not None
    sessions = home / "sessions" / "2026" / "10" / "29"
    archived = home / "archived_sessions"
    sessions.mkdir(parents=True)
    archived.mkdir(parents=True)
    (sessions / "rollout-2026-10-29T10-00-00-thread-1.jsonl").write_text("a" * 4)
    (sessions / "rollout-2026-10-29T10-01-00-thread-1_retry.jsonl").write_text("b" * 5)
    (sessions / "rollout-2026-10-29T10-02-00-thread-10.jsonl").write_text("c" * 7)
    (archived / "rollout-2026-10-29T10-03-00-thread-1.jsonl").write_text("d" * 6)

    assert harness.transcript_bytes(work, "thread-1") == 15


def test_oversized_codex_rollout_starts_fresh_without_deleting_thread(
    tmp_path: Path, monkeypatch,
):
    from worker.engine import _resume_id

    work = tmp_path / "workspace"
    work.mkdir()
    harness = CodexHarness()
    harness.prepare(work, chat_root=tmp_path / "private")

    session_file = work / ".claude" / "sessions" / "chat.session"
    session_file.parent.mkdir(parents=True)
    session_file.write_text("thread-1")
    assert harness._codex_home is not None
    rollout_dir = harness._codex_home / "sessions" / "2026" / "10" / "29"
    rollout_dir.mkdir(parents=True)
    rollout = rollout_dir / "rollout-2026-10-29T10-00-00-thread-1.jsonl"
    rollout.write_text("x" * 9)
    monkeypatch.setenv("TINA_CHAT_RESUME_MAX_BYTES", "8")

    assert _resume_id(work, session_file, harness) is None
    assert session_file.read_text() == "thread-1"
    assert rollout.stat().st_size == 9


def test_codex_mcp_config_uses_auto_and_prompt_approval_modes(tmp_path):
    work = tmp_path / "workspace"
    work.mkdir()
    harness = CodexHarness()
    harness.prepare(work)
    source = tmp_path / "mcp.json"
    source.write_text(json.dumps({"mcpServers": {
        "tina-email": {"command": "email-read", "args": []},
        "tina-email-send": {"command": "email-send", "args": []},
    }}))

    config, _excluded_env = harness._prepare_mcp_config(
        str(source), ["mcp__tina-email"], {}, gated_mcp_servers=["tina-email-send"],
        mcp_tools={"tina-email": ["search"], "tina-email-send": ["send"]},
    )

    assert config is not None
    content = config.read_text()
    assert '[mcp_servers."tina-email"]' in content
    assert '[mcp_servers."tina-email-send"]' in content
    assert 'default_tools_approval_mode = "auto"' in content
    assert 'default_tools_approval_mode = "prompt"' in content
    assert 'enabled_tools = ["search"]' in content
    assert 'enabled_tools = ["send"]' in content


def test_codex_stdio_mcp_environment_is_scoped_per_server(tmp_path):
    harness = CodexHarness()
    harness.prepare(tmp_path, chat_root=tmp_path / "private")
    env = {}
    mcp_env = {
        "MCP_SERVICE_A_TOKEN": "token-a",
        "MCP_SERVICE_B_TOKEN": "token-b",
        "UNUSED_SERVICE_TOKEN": "unused",
    }

    config, excluded = harness._prepare_mcp_config(
        None,
        ["mcp__service-a", "mcp__service-b"],
        env,
        mcp_servers={
            "service-a": {
                "command": "service-a",
                "args": [],
                "env": {"SERVICE_AUTH": "configured-a"},
                "env_vars": ["MCP_SERVICE_A_TOKEN"],
            },
            "service-b": {
                "command": "service-b",
                "args": [],
                "env": {"SERVICE_AUTH": "configured-b"},
                "env_vars": ["MCP_SERVICE_B_TOKEN"],
            },
        },
        mcp_tools={"service-a": ["read"], "service-b": ["send"]},
        mcp_env=mcp_env,
    )

    assert config is not None
    servers = tomllib.loads(config.read_text())["mcp_servers"]
    assert servers["service-a"]["env"] == {"SERVICE_AUTH": "configured-a"}
    assert servers["service-b"]["env"] == {"SERVICE_AUTH": "configured-b"}
    assert servers["service-a"]["env_vars"] == ["MCP_SERVICE_A_TOKEN"]
    assert servers["service-b"]["env_vars"] == ["MCP_SERVICE_B_TOKEN"]
    assert env == {
        "MCP_SERVICE_A_TOKEN": "token-a",
        "MCP_SERVICE_B_TOKEN": "token-b",
    }
    assert excluded == ["MCP_SERVICE_A_TOKEN", "MCP_SERVICE_B_TOKEN"]


def test_codex_passes_scoped_token_to_mcp_but_excludes_it_from_shell(monkeypatch, tmp_path):
    proc = _FakeCodexProcess()
    spawned = {}
    harness = CodexHarness()

    def fake_popen(argv, **kwargs):
        spawned["argv"] = argv
        spawned["env"] = kwargs["env"]
        assert harness._codex_home is not None
        spawned["config"] = (harness._codex_home / "config.toml").read_text()
        return proc

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("REDIS_URL", "redis://private")
    monkeypatch.setenv("TINA_AGENT_IDENTITY_TOKEN", "scoped-tool-token")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", fake_popen)
    harness.prepare(tmp_path, chat_root=tmp_path / "private")

    list(harness.run_turn(
        tmp_path, "send the approved email",
        allowed_tools=["Read"],
        mcp_servers={"tina-email-send": {
            "command": "email-send", "args": [], "env_vars": ["TINA_AGENT_IDENTITY_TOKEN"],
        }},
        mcp_tools={"tina-email-send": ["send"]},
        gated_mcp_servers=["tina-email-send"],
        mcp_env={"TINA_AGENT_IDENTITY_TOKEN": "scoped-tool-token"},
    ))

    assert spawned["env"]["TINA_AGENT_IDENTITY_TOKEN"] == "scoped-tool-token"
    assert "REDIS_URL" not in spawned["env"]
    assert any(
        "shell_environment_policy.exclude" in spawned["argv"][i]
        and "TINA_AGENT_IDENTITY_TOKEN" in spawned["argv"][i]
        for i in range(len(spawned["argv"]))
    )
    assert 'env_vars = ["TINA_AGENT_IDENTITY_TOKEN"]' in spawned["config"]
    assert "scoped-tool-token" not in spawned["config"]


def test_codex_http_mcp_uses_bearer_env_without_persisting_token(tmp_path):
    harness = CodexHarness()
    harness.prepare(tmp_path, chat_root=tmp_path / "private")
    env = {}

    config, excluded = harness._prepare_mcp_config(
        None,
        [],
        env,
        gated_mcp_servers=["tina-remote"],
        mcp_servers={
            "tina-remote": {
                "url": "https://mcp.example.test/tools",
                "bearer_token_env_var": "TINA_AGENT_IDENTITY_TOKEN",
            },
        },
        mcp_tools={"tina-remote": ["send"]},
        mcp_env={"TINA_AGENT_IDENTITY_TOKEN": "scoped-token"},
    )

    assert config is not None
    content = config.read_text()
    assert 'url = "https://mcp.example.test/tools"' in content
    assert 'bearer_token_env_var = "TINA_AGENT_IDENTITY_TOKEN"' in content
    assert "scoped-token" not in content
    assert env["TINA_AGENT_IDENTITY_TOKEN"] == "scoped-token"
    assert excluded == ["TINA_AGENT_IDENTITY_TOKEN"]


def test_codex_http_mcp_header_map_is_valid_toml(tmp_path):
    harness = CodexHarness()
    harness.prepare(tmp_path, chat_root=tmp_path / "private")
    env = {}

    config, excluded = harness._prepare_mcp_config(
        None,
        [],
        env,
        gated_mcp_servers=["tina-remote"],
        mcp_servers={
            "tina-remote": {
                "url": "https://mcp.example.test/tools",
                "env_http_headers": {"X-TINA-Identity": "TINA_AGENT_IDENTITY_TOKEN"},
            },
        },
        mcp_tools={"tina-remote": ["send"]},
        mcp_env={"TINA_AGENT_IDENTITY_TOKEN": "scoped-token"},
    )

    assert config is not None
    server = tomllib.loads(config.read_text())["mcp_servers"]["tina-remote"]
    assert server["env_http_headers"] == {"X-TINA-Identity": "TINA_AGENT_IDENTITY_TOKEN"}
    assert "scoped-token" not in config.read_text()
    assert env == {"TINA_AGENT_IDENTITY_TOKEN": "scoped-token"}
    assert excluded == ["TINA_AGENT_IDENTITY_TOKEN"]


@pytest.mark.parametrize(("approved", "expected_action"), [(True, "accept"), (False, "decline")])
def test_codex_routes_gate_mcp_elicitation_through_approval_handler(
    monkeypatch, tmp_path, approved, expected_action,
):
    proc = _FakeCodexProcess(notifications=[{
        "id": "mcp-approval-1",
        "method": "mcpServer/elicitation/request",
        "params": {
            "threadId": "thread-readonly",
            "turnId": "turn-1",
            "serverName": "tina-email-send",
            "mode": "form",
            "_meta": {
                "codex_approval_kind": "mcp_tool_call",
                "tool_name": "send",
                "tool_title": "Send email",
                "tool_description": "Send the prepared email",
                "tool_params_display": [
                    {"name": "to", "display_name": "To", "value": "jane@example.test"},
                ],
            },
            "message": "Allow sending this email?",
            "requestedSchema": {"type": "object", "properties": {}},
        },
    }])
    approvals = []
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    events = list(CodexHarness().run_turn(
        tmp_path, "send the email",
        allowed_tools=["Read", "Write", "Edit", "Bash"],
        gated_mcp_servers=["tina-email-send"],
        mcp_tools={"tina-email-send": ["send"]},
        approval_handler=lambda request: approvals.append(request) or approved,
    ))

    reply = next(request for request in proc.requests if request.get("id") == "mcp-approval-1")
    assert reply["result"] == {"action": expected_action, "content": None, "_meta": None}
    assert approvals == [{
        "server": "tina-email-send",
        "tool": "send",
        "title": "Send email",
        "description": "Send the prepared email",
        "message": "Allow sending this email?",
        "parameters": [
            {"name": "to", "display_name": "To", "value": "jane@example.test"},
        ],
        "turn_id": "turn-1",
    }]
    assert events[-1]["type"] == "done"


def test_codex_cancels_gate_elicitation_for_an_unselected_tool(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(notifications=[{
        "id": "mcp-approval-unselected",
        "method": "mcpServer/elicitation/request",
        "params": {
            "threadId": "thread-readonly",
            "turnId": "turn-1",
            "serverName": "tina-email-send",
            "mode": "form",
            "_meta": {
                "codex_approval_kind": "mcp_tool_call",
                "tool_name": "send",
            },
            "message": "Allow sending this email?",
            "requestedSchema": {"type": "object", "properties": {}},
        },
    }])
    approvals = []
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    list(CodexHarness().run_turn(
        tmp_path, "send the email",
        allowed_tools=["Read", "Write", "Edit", "Bash"],
        gated_mcp_servers=["tina-email-send"],
        mcp_tools={"tina-email-send": ["search"]},
        approval_handler=lambda request: approvals.append(request) or True,
    ))

    reply = next(request for request in proc.requests if request.get("id") == "mcp-approval-unselected")
    assert reply["result"]["action"] == "cancel"
    assert approvals == []


def test_codex_cancels_unapproved_mcp_elicitation_without_ui_handler(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(notifications=[{
        "id": "mcp-approval-unknown",
        "method": "mcpServer/elicitation/request",
        "params": {
            "threadId": "thread-readonly",
            "turnId": "turn-1",
            "serverName": "ungranted-server",
            "mode": "form",
            "_meta": {
                "codex_approval_kind": "mcp_tool_call",
                "tool_name": "send",
            },
            "message": "Allow sending this email?",
            "requestedSchema": {"type": "object", "properties": {}},
        },
    }])
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    list(CodexHarness().run_turn(tmp_path, "send the email"))

    reply = next(request for request in proc.requests if request.get("id") == "mcp-approval-unknown")
    assert reply["result"]["action"] == "cancel"


def test_codex_emits_tool_call_and_result_events(monkeypatch, tmp_path):
    notifications = [
        {"method": "item/started", "params": {"item": {
            "id": "cmd-1", "type": "commandExecution", "command": "git status",
            "cwd": "/workspaces/u1", "status": "inProgress",
        }}},
        {"method": "item/completed", "params": {"item": {
            "id": "cmd-1", "type": "commandExecution", "command": "git status",
            "cwd": "/workspaces/u1", "status": "completed", "exitCode": 0,
            "aggregatedOutput": "clean",
        }}},
        {"method": "item/completed", "params": {"item": {
            "id": "file-1", "type": "fileChange", "status": "completed",
            "changes": [{"path": "notes.md", "kind": "add"}],
        }}},
        {"method": "item/started", "params": {"item": {
            "id": "mcp-1", "type": "mcpToolCall", "server": "tina-email",
            "tool": "search", "arguments": {"query": "TINA"}, "status": "inProgress",
        }}},
        {"method": "item/completed", "params": {"item": {
            "id": "mcp-1", "type": "mcpToolCall", "server": "tina-email",
            "tool": "search", "arguments": {"query": "TINA"}, "status": "completed",
            "result": {"content": [{"type": "text", "text": "one message"}]},
        }}},
    ]
    proc = _FakeCodexProcess(notifications=notifications)
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    unit_events = list(CodexHarness().run_turn(
        tmp_path, "inspect the workspace",
        allowed_tools=["Read", "Write", "Edit", "Bash"],
    ))

    calls = [event for event in unit_events if event["type"] == "tool-call"]
    results = [event for event in unit_events if event["type"] == "tool-result"]
    assert [event["tool"] for event in calls] == ["Bash", "FileChange", "mcp__tina-email__search"]
    assert [event["callId"] for event in calls] == ["cmd-1", "file-1", "mcp-1"]
    assert [event["callId"] for event in results] == ["cmd-1", "file-1", "mcp-1"]
    assert all(event["ok"] for event in results)


def test_codex_rewrites_auth_failures_to_settings_guidance(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(turn_status="failed", turn_error="401 Unauthorized")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    events = list(CodexHarness().run_turn(
        tmp_path, "answer",
        allowed_tools=["Read", "Write", "Edit", "Bash"],
        model="gpt-test",
    ))

    done = events[-1]
    assert done["type"] == "done" and done["ok"] is False
    assert "OpenAI API key" in done["reply"] and "Settings → Models" in done["reply"]
    assert done["detail"] == "401 Unauthorized"


def test_codex_surfaces_non_auth_turn_failure_detail(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(turn_status="failed", turn_error="Codex workspace policy rejected the turn")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("TINA_CODEX_AUTH_MODE", raising=False)
    monkeypatch.setattr("llm.codex.shutil.which", lambda _executable: "/usr/bin/codex")
    monkeypatch.setattr("llm.codex.subprocess.Popen", lambda *_args, **_kwargs: proc)

    events = list(CodexHarness().run_turn(
        tmp_path, "inspect workspace", allowed_tools=["Read"],
    ))

    done = events[-1]
    assert done["type"] == "done" and done["ok"] is False
    assert "Codex workspace policy rejected the turn" in done["reply"]
    assert done["detail"] == "Codex workspace policy rejected the turn"


def test_codex_resolves_final_citations_and_persists_private_sources(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(notifications=[
        {'method': 'item/completed', 'params': {'item': {
            'type': 'webSearch', 'id': 'web-1', 'query': 'pathlib',
            'results': [{'url': 'https://docs.python.org/3/library/pathlib.html',
                         'title': 'Python pathlib', 'ref_id': 'turn0search0'}],
        }}},
        {'method': 'item/agentMessage/delta', 'params': {'delta': 'Verified. citeturn0search0'}},
    ])
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    monkeypatch.delenv('TINA_CODEX_AUTH_MODE', raising=False)
    monkeypatch.setattr('llm.codex.shutil.which', lambda _: '/usr/bin/codex')
    monkeypatch.setattr('llm.codex.subprocess.Popen', lambda *_args, **_kwargs: proc)
    harness = CodexHarness()
    harness.prepare(tmp_path, chat_root=tmp_path / 'private')
    events = list(harness.run_turn(tmp_path, 'research', allowed_tools=['Read', 'WebSearch']))
    assert '[Python pathlib](https://docs.python.org/3/library/pathlib.html)' in events[-1]['reply']
    assert 'cite' not in events[-1]['reply']
    path = tmp_path / 'private/.codex/tina-sources/thread-readonly/turn-citations.json'
    assert json.loads(path.read_text())[0]['refs'] == ['turn0search0']
    assert not (tmp_path / '.codex/tina-sources').exists()


def test_codex_uses_completed_native_text_when_no_deltas_arrive(monkeypatch, tmp_path):
    proc = _FakeCodexProcess(notifications=[{'method': 'item/completed', 'params': {'item': {
        'id': 'message-1', 'type': 'agentMessage', 'text': 'Native complete text. citeturn0search0',
    }}}])
    monkeypatch.setenv('OPENAI_API_KEY', 'test-key')
    monkeypatch.delenv('TINA_CODEX_AUTH_MODE', raising=False)
    monkeypatch.setattr('llm.codex.shutil.which', lambda _: '/usr/bin/codex')
    monkeypatch.setattr('llm.codex.subprocess.Popen', lambda *_args, **_kwargs: proc)
    events = list(CodexHarness().run_turn(tmp_path, 'research', allowed_tools=['Read']))
    assert events[-1]['reply'] == 'Native complete text. [Nguồn chưa có liên kết]'
