"""L2: the claude-code harness adapter — stream-json normalization (relocated from
test_unit_foundation), the generic run_harness_turn commit orchestration driven through the
adapter with a fake exec, and the transcript-size accounting behind resume ids."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from llm import run_harness_turn
from llm.claude_code import ClaudeCodeHarness, build_argv, parse_stream_json
from llm.ports import harness_subprocess_env


def _git(d: Path, *a: str) -> None:
    subprocess.run(["git", *a], cwd=str(d), check=True, capture_output=True, text=True)


def _init_repo(d: Path) -> None:
    _git(d, "init", "-q")
    _git(d, "config", "user.email", "t@t")
    _git(d, "config", "user.name", "t")
    (d / "AGENT.md").write_text("seed\n")
    _git(d, "add", "-A")
    _git(d, "commit", "-q", "-m", "seed")


def _entity(fm: dict, body: str = "body") -> str:
    return "---\n" + yaml.safe_dump(fm, sort_keys=True).strip() + "\n---\n" + body


GOOD = {"type": "person", "id": "jane-liu", "title": "Jane Liu"}
BAD = {"title": "no type or id"}  # missing required type + id → workspace.v1 violation


# ── stream-json normalization ────────────────────────────────────────────────

def test_deepseek_harness_requires_own_key_and_reports_provider_auth_failure(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://api.deepseek.com/anthropic")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "foreign-credential")
    harness = ClaudeCodeHarness()
    assert "DeepSeek API key is missing" in harness.preflight()
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "deepseek-own-key")
    monkeypatch.setenv("TINA_AGENT_MODEL", "deepseek-flash")
    assert harness.preflight() is None
    done, = parse_stream_json([json.dumps({"type": "result", "is_error": True,
                                        "result": "HTTP 401: deepseek-own-key invalid"})])
    assert not done["ok"] and "DeepSeek" in done["reply"]
    assert "deepseek-own-key" not in json.dumps(done)
    monkeypatch.setenv("TINA_AGENT_MODEL", "")
    assert "approved DeepSeek chat model" in harness.preflight()


def test_parse_stream_json_normalizes():
    lines = [
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "hello"}]}}),
        json.dumps({"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Write", "input": {"path": "x"}, "id": "t1"}]}}),
        json.dumps({"type": "user", "message": {"content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}),
        json.dumps({"type": "result", "subtype": "success", "result": "done", "session_id": "s1"}),
        "not json — skipped",
    ]
    evs = list(parse_stream_json(lines))
    assert [e["type"] for e in evs] == ["message-delta", "tool-call", "tool-result", "done"]
    assert evs[0]["text"] == "hello"
    assert evs[1]["tool"] == "Write" and evs[1]["callId"] == "t1"
    assert evs[2]["ok"] is True
    assert evs[3]["sessionId"] == "s1" and evs[3]["ok"] is True


def test_native_schema_and_structured_result_are_opt_in_for_voice(tmp_path):
    schema = {'type': 'object', 'properties': {'tool_calls': {'type': 'array'}}}
    response = {'type': 'result', 'subtype': 'success', 'result': 'Ordinary chat prose.',
                'structured_output': {'tool_calls': []}}
    seen = []
    def execute(argv, cwd):
        seen.append(argv)
        return [json.dumps(response)]
    harness = ClaudeCodeHarness(exec_fn=execute)
    voice = list(run_harness_turn(tmp_path, 'voice', harness, commit=False, output_schema=schema))[-1]
    assert json.loads(seen[0][seen[0].index('--json-schema') + 1]) == schema
    assert json.loads(voice['reply']) == response['structured_output']
    chat = list(run_harness_turn(tmp_path, 'chat', harness, commit=False))[-1]
    assert '--json-schema' not in seen[1] and chat['reply'] == response['result']
    failed = list(parse_stream_json([json.dumps(response | {'is_error': True})], structured_output=True))[-1]
    assert failed['ok'] is False and failed['reply'] == response['result']
    failed = list(parse_stream_json([json.dumps(response | {'subtype':'error_max_structured_output_retries'})], structured_output=True))[-1]
    assert failed['ok'] is False


def test_parse_stream_json_partial_messages_stream_incrementally():
    # Captured --include-partial-messages JSONL shape: stream_event(content_block_delta/text_delta)*
    # then the consolidated assistant text block, then result. The deltas must surface incrementally
    # AND the trailing full block must NOT re-emit (else the text doubles).
    lines = [
        json.dumps({"type": "stream_event", "event": {"type": "message_start"}}),
        json.dumps({"type": "stream_event", "event": {"type": "content_block_start", "index": 0}}),
        json.dumps({"type": "stream_event", "event": {
            "type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Hel"}}}),
        json.dumps({"type": "stream_event", "event": {
            "type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "lo "}}}),
        json.dumps({"type": "stream_event", "event": {
            "type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "world"}}}),
        json.dumps({"type": "stream_event", "event": {"type": "content_block_stop", "index": 0}}),
        # the consolidated assistant message the CLI emits at block close — must be suppressed:
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "Hello world"}]}}),
        json.dumps({"type": "result", "subtype": "success", "result": "Hello world", "session_id": "s2"}),
    ]
    evs = list(parse_stream_json(lines))
    assert [e["type"] for e in evs] == ["message-delta", "message-delta", "message-delta", "done"]
    assert [e["text"] for e in evs[:3]] == ["Hel", "lo ", "world"]
    # incremental deltas concatenate to the full text with no duplication:
    assert "".join(e["text"] for e in evs[:3]) == "Hello world"
    # the result still carries the full reply (commit messages / non-streaming consumers):
    assert evs[3]["reply"] == "Hello world"


def test_parse_stream_json_rewrites_cli_auth_failure():
    # A credential-less/expired CLI ends the turn with its OWN auth text — an adapter internal
    # ("/login" doesn't exist for an API consumer). The done frame must carry the platform's
    # actionable message instead, with the raw CLI text preserved in `detail`.
    lines = [json.dumps({"type": "result", "subtype": "error", "is_error": True,
                         "result": "Not logged in · Please run /login", "session_id": "s3"})]
    (done,) = parse_stream_json(lines)
    assert done["type"] == "done" and done["ok"] is False
    assert "Not logged in" not in done["reply"] and "/login" not in done["reply"]
    for key in ("HOST_CLAUDE_CREDENTIALS", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
                "CLAUDE_CODE_OAUTH_TOKEN", "TINA_LLM_API_KEY"):
        assert key in done["reply"]
    assert "Settings → Models" in done["reply"]
    assert done["detail"] == "Not logged in · Please run /login"


def test_parse_stream_json_keeps_non_auth_failure_verbatim():
    # Only auth signatures are rewritten — any other failure text passes through untouched.
    lines = [json.dumps({"type": "result", "subtype": "error", "is_error": True,
                         "result": "context window exceeded", "session_id": "s4"})]
    (done,) = parse_stream_json(lines)
    assert done["ok"] is False
    assert done["reply"] == "context window exceeded"
    assert "detail" not in done


# ── the argv (the CLI contract) ──────────────────────────────────────────────

def test_build_argv_core_flags_and_session_model():
    argv = build_argv("hi", allowed_tools=["Read"], session="s1", model="m1")
    assert argv[:3] == ["claude", "-p", "hi"]
    assert "--output-format" in argv and "stream-json" in argv
    assert "--allowedTools" in argv and "Read" in argv
    assert "--resume" in argv and "s1" in argv
    assert "--model" in argv and "m1" in argv
    # unset effort ⇒ NO --effort flag (the CLI's own default behaviour is preserved byte-for-byte)
    assert "--effort" not in argv


def test_build_argv_ignores_legacy_effort_pin():
    argv = build_argv("hi", effort="medium")
    assert "--effort" not in argv

# ── the untrusted-subprocess env scrub (data-plane tenancy) ──────────────────
# The model-driven harness CLI exposes a Bash tool. It must NOT inherit the worker's REDIS_URL (which
# reaches the SHARED redis — another tenant's tc:meeting:* / unit:*:in) nor the minted per-dispatch
# bearer token. Filesystem tenancy is mount-enforced; the data plane is enforced HERE, at the launch env.

def test_harness_subprocess_env_strips_data_plane_secrets(monkeypatch):
    monkeypatch.setenv("REDIS_URL", "redis://the-shared-bus:6379/0")
    monkeypatch.setenv("TINA_AGENT_IDENTITY_TOKEN", "minted.bearer.jwt")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-model-cred")   # the subprocess DOES need its model cred
    monkeypatch.setenv("GIT_DIR", "/hook/.git")                # git-discovery scrub still composes
    monkeypatch.setenv("PATH", "/usr/bin")
    env = harness_subprocess_env()
    assert "REDIS_URL" not in env, "REDIS_URL must not reach the model's Bash (cross-tenant redis reach)"
    assert "TINA_AGENT_IDENTITY_TOKEN" not in env, "the per-dispatch bearer token must not leak in"
    assert "GIT_DIR" not in env, "the git repo-discovery scrub still composes"
    assert env["ANTHROPIC_API_KEY"] == "sk-model-cred", "model credentials must survive"
    assert env["PATH"] == "/usr/bin", "benign vars pass through untouched"


def test_exec_subprocess_launches_with_scrubbed_env(monkeypatch):
    """The DEFAULT runner (real launch path) must pass the scrubbed env to the actual subprocess —
    negative control: before the fix REDIS_URL/token WOULD ride ``scrubbed_git_env`` into the child."""
    from llm import claude_code

    monkeypatch.setenv("REDIS_URL", "redis://the-shared-bus:6379/0")
    monkeypatch.setenv("TINA_AGENT_IDENTITY_TOKEN", "minted.bearer.jwt")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-model-cred")
    captured: dict = {}

    class _FakeProc:
        import io
        stdout = io.StringIO('')
        class stdin:
            @staticmethod
            def write(value): captured['prompt'] = value
            @staticmethod
            def close(): pass

        def wait(self, timeout=None):
            return 0

    def _fake_popen(argv, **kwargs):
        captured["env"] = kwargs.get("env")
        captured['argv'] = argv
        return _FakeProc()

    monkeypatch.setattr(claude_code.subprocess, "Popen", _fake_popen)
    list(claude_code._exec_subprocess(["claude", "-p", "hi"], "/tmp"))
    assert "REDIS_URL" not in captured["env"]
    assert "TINA_AGENT_IDENTITY_TOKEN" not in captured["env"]
    assert captured["env"]["ANTHROPIC_API_KEY"] == "sk-model-cred"  # model cred still delivered
    assert captured['prompt'] == 'hi' and captured['argv'] == ['claude','-p']


@pytest.mark.parametrize('read_input',[True,False])
def test_real_pipes_drain_startup_output_and_early_cli_errors(monkeypatch,read_input):
    import sys
    import threading
    from llm import claude_code
    real=subprocess.Popen;processes=[];lines=[];errors=[]
    code=("import json,sys,os;" + ("" if read_input else "os.close(0);") +
          "sys.stdout.write(json.dumps({'notice':'x'*200000})+'\\n');sys.stdout.flush();" +
          ("assert len(sys.stdin.read())==200000;" if read_input else "") +
          "print(json.dumps({'type':'result','result':'synthetic result','is_error':"+str(not read_input)+"}))")
    def spawn(argv,**kwargs):
        process=real([sys.executable,'-c',code],**kwargs);processes.append(process);return process
    def consume():
        try:lines.extend(claude_code._exec_subprocess(['claude','-p','p'*200000],'/tmp'))
        except Exception as error:errors.append(type(error).__name__)
    monkeypatch.setattr(claude_code.subprocess,'Popen',spawn)
    thread=threading.Thread(target=consume,daemon=True);thread.start()
    try:
        thread.join(5)
        assert not thread.is_alive(), 'stdin/stdout must make progress concurrently'
        assert not errors
        result=json.loads(lines[-1])
        assert result['result']=='synthetic result' and result['is_error'] is not read_input
    finally:
        for process in processes:
            if process.poll() is None:process.kill()
        thread.join(3)


# ── run_harness_turn: entity schema validation before commits ────────────────

def test_run_harness_turn_commits_conformant(tmp_path: Path):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)

    def fake_exec(argv, cwd):  # the "model" writes a conformant entity via its tools, then finishes
        f = Path(cwd) / "kg/entities/person/jane-liu.md"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(_entity(GOOD))
        yield json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "wrote jane"}]}})
        yield json.dumps({"type": "result", "subtype": "success", "result": "wrote jane", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "create jane", ClaudeCodeHarness(exec_fn=fake_exec)))
    assert any(e["type"] == "commit" for e in evs)
    assert (repo / "kg/entities/person/jane-liu.md").exists()
    log = subprocess.run(["git", "log", "--oneline"], cwd=str(repo), capture_output=True, text=True).stdout
    assert "wrote jane" in log


@pytest.mark.parametrize("content", [
    _entity(BAD),
    "---\ntype: [invalid\n---\n",
])
def test_run_harness_turn_rejects_nonconformant_entities(tmp_path: Path, content: str):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip()

    def fake_exec(argv, cwd):
        f = Path(cwd) / "kg/entities/person/bad.md"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(content)
        yield json.dumps({"type": "result", "subtype": "success", "result": "x", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "create bad", ClaudeCodeHarness(exec_fn=fake_exec)))
    assert not any(e["type"] == "commit" for e in evs)
    assert not (repo / "kg/entities/person/bad.md").exists()
    assert subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip() == base


@pytest.mark.parametrize("bypass_guard", [False, True])
def test_run_harness_turn_reverts_a_self_committed_nonconformant_entity(tmp_path: Path, bypass_guard: bool):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip()

    def fake_exec(argv, cwd):
        f = Path(cwd) / "kg/entities/person/self-committed-bad.md"
        valid = Path(cwd) / "kg/entities/person/valid.md"
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(_entity(BAD))
        valid.write_text(_entity(GOOD))
        git = shutil.which("git") if bypass_guard else "git"
        env = harness_subprocess_env()
        subprocess.run([git, "add", "-A"], cwd=cwd, env=env, check=True, capture_output=True)
        commit = subprocess.run([git, "commit", "-q", "-m", "agent self commit"],
                                cwd=cwd, env=env, capture_output=True)
        assert (commit.returncode == 0) is bypass_guard
        yield json.dumps({"type": "result", "subtype": "success", "result": "x", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "create bad", ClaudeCodeHarness(exec_fn=fake_exec)))
    invalid_path = "kg/entities/person/self-committed-bad.md"
    assert not (repo / invalid_path).exists()
    history = subprocess.run(["git", "log", "--all", "--format=%H", "--", invalid_path], cwd=str(repo),
                             capture_output=True, text=True, check=True).stdout.strip()
    assert not history, "invalid self-committed entity must not remain in reachable history"
    assert (repo / "kg/entities/person/valid.md").exists()
    assert subprocess.run(["git", "rev-parse", "HEAD^"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip() == base
    assert any(e["type"] == "commit" for e in evs)


@pytest.mark.parametrize("filename", ["jane-liu.md", 'jane "liu".md'])
def test_run_harness_turn_rejects_invalid_tracked_entity_paths(tmp_path: Path, filename: str):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)
    rel = Path("kg/entities/person") / filename
    entity_path = repo / rel
    entity_path.parent.mkdir(parents=True)
    valid = _entity(GOOD)
    entity_path.write_text(valid)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "add tracked entity")
    base = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip()

    def fake_exec(argv, cwd):
        (Path(cwd) / rel).write_text(_entity(BAD))
        yield json.dumps({"type": "result", "subtype": "success", "result": "changed Jane", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "change Jane", ClaudeCodeHarness(exec_fn=fake_exec)))

    assert entity_path.read_text() == valid
    assert subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(repo),
                          capture_output=True, text=True, check=True).stdout.strip() == base
    assert not any(e["type"] == "commit" for e in evs)


def test_run_harness_turn_keeps_valid_writes_and_rejects_invalid_entity_neighbor(tmp_path: Path):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)

    def fake_exec(argv, cwd):
        valid = Path(cwd) / "kg/entities/person/jane-liu.md"
        invalid = Path(cwd) / "kg/entities/person/bad.md"
        valid.parent.mkdir(parents=True, exist_ok=True)
        valid.write_text(_entity(GOOD))
        invalid.write_text(_entity(BAD))
        (Path(cwd) / "meeting-notes.md").write_text("valid non-entity write")
        yield json.dumps({"type": "result", "subtype": "success", "result": "done", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "create entities", ClaudeCodeHarness(exec_fn=fake_exec)))

    assert (repo / "kg/entities/person/jane-liu.md").exists()
    assert not (repo / "kg/entities/person/bad.md").exists()
    assert (repo / "meeting-notes.md").exists()
    assert any(e["type"] == "commit" for e in evs)


def test_run_harness_turn_rejects_entity_symlinks(tmp_path: Path):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)
    outside = tmp_path / "outside.md"
    outside.write_text(_entity(GOOD))
    link = repo / "kg/entities/person/linked.md"

    def fake_exec(argv, cwd):
        target = Path(cwd) / "kg/entities/person/linked.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.symlink_to(outside)
        yield json.dumps({"type": "result", "subtype": "success", "result": "done", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "link entity", ClaudeCodeHarness(exec_fn=fake_exec)))

    assert not link.is_symlink()
    assert outside.exists()
    assert not any(e["type"] == "commit" for e in evs)


def test_run_harness_turn_propose_only_touches_no_git(tmp_path: Path):
    repo = tmp_path / "ws"
    repo.mkdir()
    _init_repo(repo)

    def fake_exec(argv, cwd):
        yield json.dumps({"type": "result", "subtype": "success", "result": "looked", "session_id": "s1"})

    evs = list(run_harness_turn(repo, "look", ClaudeCodeHarness(exec_fn=fake_exec), commit=False))
    assert [e["type"] for e in evs] == ["done"]  # no commit event on the propose-only path


# ── per-mount commit + attribution (WP-A1.2 / D4) ────────────────────────────

def _author_of(repo: Path) -> tuple[str, str, str, str]:
    """(author name, author email, committer name, committer email) of HEAD."""
    fmt = "%an%n%ae%n%cn%n%ce"
    out = subprocess.run(["git", "log", "-1", f"--pretty=format:{fmt}"], cwd=str(repo),
                         capture_output=True, text=True).stdout.splitlines()
    return tuple(out)  # type: ignore[return-value]


def test_run_harness_turn_commits_each_changed_mount_independently(tmp_path: Path):
    """The active mount set → ONE commit per changed mount (WP-A1.2). The primary and an extra mount
    are separate repos: a turn that writes both yields TWO commit events, one landing in each repo."""
    private = tmp_path / "private"; private.mkdir(); _init_repo(private)
    shared = tmp_path / "shared"; shared.mkdir(); _init_repo(shared)

    def fake_exec(argv, cwd):  # the "model" writes into BOTH mounts
        (Path(cwd) / "note.md").write_text("private note")
        (shared / "doc.md").write_text("shared doc")
        yield json.dumps({"type": "result", "subtype": "success", "result": "wrote both", "session_id": "s1"})

    evs = list(run_harness_turn(private, "write both", ClaudeCodeHarness(exec_fn=fake_exec),
                                extra_mounts=[shared]))
    commits = [e for e in evs if e["type"] == "commit"]
    assert len(commits) == 2, "one commit per changed mount"
    # each mount got its OWN commit (distinct repos, distinct HEADs)
    assert (private / "note.md").exists() and (shared / "doc.md").exists()
    assert "wrote both" in subprocess.run(["git", "log", "--oneline"], cwd=str(private), capture_output=True, text=True).stdout
    assert "wrote both" in subprocess.run(["git", "log", "--oneline"], cwd=str(shared), capture_output=True, text=True).stdout


def test_run_harness_turn_only_commits_the_mount_that_changed(tmp_path: Path):
    """An extra mount with NO writes must not get an empty commit — only the changed mount commits."""
    private = tmp_path / "private"; private.mkdir(); _init_repo(private)
    shared = tmp_path / "shared"; shared.mkdir(); _init_repo(shared)
    shared_head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(shared), capture_output=True, text=True).stdout.strip()

    def fake_exec(argv, cwd):  # writes ONLY the private mount
        (Path(cwd) / "note.md").write_text("only private")
        yield json.dumps({"type": "result", "subtype": "success", "result": "one", "session_id": "s1"})

    evs = list(run_harness_turn(private, "write private", ClaudeCodeHarness(exec_fn=fake_exec),
                                extra_mounts=[shared]))
    assert len([e for e in evs if e["type"] == "commit"]) == 1
    # shared HEAD is unmoved (no empty commit)
    assert subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(shared), capture_output=True, text=True).stdout.strip() == shared_head


def test_run_harness_turn_attributes_commit_to_the_principal(tmp_path: Path):
    """Attribution (D4): author = the dispatch principal, committer = the platform — on EACH mount."""
    private = tmp_path / "private"; private.mkdir(); _init_repo(private)
    shared = tmp_path / "shared"; shared.mkdir(); _init_repo(shared)

    def fake_exec(argv, cwd):
        (Path(cwd) / "n.md").write_text("p")
        (shared / "d.md").write_text("s")
        yield json.dumps({"type": "result", "subtype": "success", "result": "x", "session_id": "s1"})

    list(run_harness_turn(private, "write", ClaudeCodeHarness(exec_fn=fake_exec),
                          author=("Jane Doe", "jane@example.com"), extra_mounts=[shared]))
    for repo in (private, shared):
        an, ae, cn, ce = _author_of(repo)
        assert (an, ae) == ("Jane Doe", "jane@example.com"), "author = principal"
        assert (cn, ce) == ("TINA", "platform@tina.local"), "committer = platform"


# ── transcript-size accounting (resume-cost cap) ─────────────────────────────

def test_transcript_bytes_sums_matching_session_files(tmp_path: Path):
    proj = tmp_path / ".claude" / "projects" / "-workspace"
    proj.mkdir(parents=True)
    (proj / "sid-1.jsonl").write_text("x" * 100)
    (proj / "other.jsonl").write_text("y" * 999)
    other = tmp_path / ".claude" / "projects" / "-elsewhere"
    other.mkdir(parents=True)
    (other / "sid-1.jsonl").write_text("x" * 23)
    h = ClaudeCodeHarness()
    assert h.transcript_bytes(tmp_path, "sid-1") == 123
    assert h.transcript_bytes(tmp_path, "missing") == 0


# ── ~/.claude/projects linking — must NEVER destroy real transcripts ─────────

def _prepare_with_home(monkeypatch, home: Path, work: Path) -> Path:
    """Run prepare() against an explicit fake HOME; returns the ``~/.claude/projects`` path."""
    monkeypatch.setenv("HOME", str(home))
    ClaudeCodeHarness().prepare(work)
    return home / ".claude" / "projects"


def test_prepare_refuses_to_delete_real_transcripts(tmp_path: Path, monkeypatch):
    # Regression for the 2026-07-03 incident: a host test run pointed prepare() at the developer's
    # real HOME and rmtree'd every Claude Code transcript. A non-empty projects dir was not created
    # by this adapter — it must survive prepare() byte-for-byte, with the link skipped.
    home = tmp_path / "home"
    transcript = home / ".claude" / "projects" / "-real-project" / "s1.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text('{"precious": true}')
    link = _prepare_with_home(monkeypatch, home, work=tmp_path / "ws")
    assert link.is_dir() and not link.is_symlink()  # still the real dir, not a link
    assert transcript.read_text() == '{"precious": true}'


def test_prepare_links_fresh_and_empty_homes(tmp_path: Path, monkeypatch):
    ws = tmp_path / "ws"
    target = str(ws / ".claude" / "projects")
    # fresh container HOME (no projects dir at all) → link created
    link = _prepare_with_home(monkeypatch, tmp_path / "h1", ws)
    assert link.is_symlink() and os.readlink(link) == target
    # an EMPTY dir (the CLI pre-creates one) holds nothing → safe to replace with the link
    home2 = tmp_path / "h2"
    (home2 / ".claude" / "projects").mkdir(parents=True)
    link = _prepare_with_home(monkeypatch, home2, ws)
    assert link.is_symlink() and os.readlink(link) == target


def test_prepare_repoints_stale_symlink_and_is_idempotent(tmp_path: Path, monkeypatch):
    ws = tmp_path / "ws"
    target = str(ws / ".claude" / "projects")
    home = tmp_path / "home"
    old_ws = tmp_path / "old"
    (old_ws / ".claude" / "projects").mkdir(parents=True)
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "projects").symlink_to(old_ws / ".claude" / "projects")
    link = _prepare_with_home(monkeypatch, home, ws)  # stale link from a previous workspace → repointed
    assert os.readlink(link) == target
    link = _prepare_with_home(monkeypatch, home, ws)  # second turn, already correct → no-op
    assert os.readlink(link) == target
