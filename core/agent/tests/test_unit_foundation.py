"""Foundation L2 tests — the unit dispatcher over fakes, plus the unit.v1 seam validation.

(The harness-turn governance + stream-json normalization tests moved to test_llm_claude_code.py
with the llm module split.)
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
from pathlib import Path

import pytest

import contracts
from control_plane import dispatch
from shared.adapters import LocalIdentityMinter
from shared.config import load_settings


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


VALID_INV = {
    "identity": {"subject": "u_jane", "launcher": "user:u_jane"},
    "runner": "claude-code",
    "workspaces": [{"id": "u_jane", "mode": "rw"}],
    "trigger": "message",
    "context": {"kind": "none"},
    "start": {"entrypoint": {"inline": "hi"}},
}


# ── unit.v1 seam ─────────────────────────────────────────────────────────────

def test_validate_unit_invocation_ok():
    contracts.validate_unit_invocation(VALID_INV)  # must not raise


def test_validate_unit_invocation_rejects_missing_identity():
    bad = {k: v for k, v in VALID_INV.items() if k != "identity"}
    with pytest.raises(Exception):
        contracts.validate_unit_invocation(bad)


# ── the dispatcher: unit.v1 → runtime.v1 spawn, quota keyed on the person ─────

class _FakeRuntime:
    def __init__(self):
        self.spawned = []

    def spawn(self, workload_id, profile, env):
        self.spawned.append((workload_id, profile, env))
        return workload_id

    def await_done(self, workload_id, timeout_sec=0.0):
        return "completed"


class _FakeIdentity:
    def mint(self, subject, launcher, workspaces, tools):
        return "tok"


def test_dispatcher_spawns_isolated_container_with_minted_token():
    settings = load_settings()
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    wid = d.dispatch(VALID_INV)
    assert wid and rt.spawned
    _, profile, env = rt.spawned[0]
    assert profile == settings.agent_profile
    assert env["TINA_OWNER"] == "u_jane"                       # quota axis = the person
    assert env["TINA_LAUNCHER"] == "user:u_jane"
    assert env["TINA_AGENT_IDENTITY_TOKEN"] == "tok"           # the per-dispatch minted token, injected
    assert env["TINA_UNIT_TRIGGER"] == "message"
    assert '"id": "u_jane"' in env["TINA_WORKSPACES"] and '"mode": "rw"' in env["TINA_WORKSPACES"]
    assert env["TINA_UNIT_OUT_TOPIC"] == f"unit:{wid}:out"


def test_dispatcher_resolve_model_config_tristate():
    """The public seam the chat credential preflight reads: ``{}`` = no resolver wired / resolved
    empty; the dict passthrough; ``None`` = the lookup FAILED (callers fail OPEN)."""
    settings = load_settings()

    class _Resolver:
        def __init__(self, cfg):
            self._cfg = cfg

        def resolve(self, subject):
            if isinstance(self._cfg, Exception):
                raise self._cfg
            return self._cfg

    assert dispatch.Dispatcher(settings, _FakeRuntime(), _FakeIdentity()).resolve_model_config("u") == {}
    cfg = {"mode": "custom", "base_url": "https://gw.example.com"}
    d = dispatch.Dispatcher(settings, _FakeRuntime(), _FakeIdentity(), model_config=_Resolver(cfg))
    assert d.resolve_model_config("u") == cfg
    d = dispatch.Dispatcher(settings, _FakeRuntime(), _FakeIdentity(), model_config=_Resolver(None))
    assert d.resolve_model_config("u") == {}                     # resolved-empty normalizes to {}
    d = dispatch.Dispatcher(settings, _FakeRuntime(), _FakeIdentity(),
                            model_config=_Resolver(RuntimeError("admin-api down")))
    assert d.resolve_model_config("u") is None


def test_dispatcher_worker_env_carries_configured_model():
    settings = load_settings(agent_model="deepseek/deepseek-v4-pro")
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_AGENT_MODEL"] == "deepseek/deepseek-v4-pro"


def test_dispatcher_worker_env_carries_configured_meeting_model():
    settings = load_settings(meeting_model="openrouter/free")
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_MEETING_MODEL"] == "openrouter/free"


def test_dispatcher_worker_env_carries_meeting_transcript_cursor():
    settings = load_settings()
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    inv = {
        **VALID_INV,
        "trigger": "transcription",
        "identity": {"subject": "u_jane", "launcher": "integration:meetings"},
        "workspaces": [{"id": "u_jane", "mode": "ro"}],
        "context": {"kind": "meeting", "meeting": {
            "meeting_id": "abc-defg-hij",
            "session_uid": "abc-defg-hij",
            "platform": "google_meet",
            "transcript_start_id": "42-0",
        }},
    }
    d.dispatch(inv, trusted_live_meeting=True)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_TRANSCRIPT_STREAM"] == "tc:meeting:abc-defg-hij"
    assert env["TINA_TRANSCRIPT_START_ID"] == "42-0"
    assert env["TINA_IDLE_TIMEOUT_SEC"] == str(4 * 60 * 60)


def test_local_identity_minter_emits_signed_dispatch_claims():
    token = LocalIdentityMinter("secret", ttl_sec=60).mint(
        "u_jane",
        "user:u_jane",
        [{"id": "u_jane", "mode": "rw"}],
        ["workspace.write"],
    )
    header, payload, signature = token.split(".")
    claims = json.loads(_b64u_decode(payload))
    assert claims["sub"] == "u_jane"
    assert claims["lch"] == "user:u_jane"
    assert claims["ws"] == [{"id": "u_jane", "mode": "rw"}]
    assert claims["tools"] == ["workspace.write"]
    assert claims["exp"] - claims["iat"] == 60
    expected = hmac.new(b"secret", f"{header}.{payload}".encode("ascii"), hashlib.sha256).digest()
    assert hmac.compare_digest(expected, _b64u_decode(signature))


def test_dispatcher_rejects_nonconformant_invocation():
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity())
    with pytest.raises(Exception):
        d.dispatch({"trigger": "message"})  # missing required fields
    assert not rt.spawned


def test_dispatcher_worker_env_carries_numeric_meeting_id():
    """`numeric_meeting_id` (the meetings-domain ROW id — unique per meeting run, unlike the native
    id a re-sent bot reuses) is an INTERNAL routing hint: it must reach the worker env
    (TINA_MEETING_NUMERIC_ID → the proc:meeting:{numeric} processed-notes key the meeting-api
    db-writer persists) while being STRIPPED before the sealed unit.v1 check
    (MeetingRef is additionalProperties:false) — exactly like transcript_start_id."""
    settings = load_settings()
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    inv = {
        **VALID_INV,
        "trigger": "transcription",
        "identity": {"subject": "u_jane", "launcher": "integration:meetings"},
        "workspaces": [{"id": "u_jane", "mode": "ro"}],
        "context": {"kind": "meeting", "meeting": {
            "meeting_id": "abc-defg-hij",
            "session_uid": "abc-defg-hij",
            "platform": "google_meet",
            "numeric_meeting_id": "17",
        }},
    }
    d.dispatch(inv, trusted_live_meeting=True)  # trusted router hint must stay off the sealed contract
    _, _profile, env = rt.spawned[0]
    assert env["TINA_MEETING_NUMERIC_ID"] == "17"
    # P0 (cross-tenant leak fix): the transcript carrier keys on the meetings-domain ROW id
    # (numeric_meeting_id) — unique per run — NOT the native id (which collides across tenants +
    # a user's re-sends). The native id rides SEPARATELY as TINA_MEETING_ID (the readable kg doc name).
    assert env["TINA_TRANSCRIPT_STREAM"] == "tc:meeting:17"          # carrier keys on the ROW id
    assert env["TINA_MEETING_ID"] == "abc-defg-hij"                 # native survives for display only

# ── model-auth passthrough: agent-api env → worker spec env (the k8s/helm credential seam) ────

def test_dispatcher_worker_env_passes_model_auth_allowlist(monkeypatch):
    """Every allowlisted model-auth var set on agent-api lands in the worker spec env — this is the
    ONLY credential path on the k8s/process backends (no bind-mount, no runtime brokering)."""
    for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST:
        monkeypatch.setenv(key, f"val-{key}")
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST:
        if key in {"GEMINI_API_KEY", "TINA_ANTIGRAVITY_AUTH_MODE",
                   "TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED"}:
            assert key not in env
        else:
            assert env[key] == f"val-{key}"


def test_dispatcher_antigravity_mode_stamps_only_its_model_credentials(monkeypatch):
    for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("GEMINI_API_KEY", "deployment-gemini-key")
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(
        load_settings(), rt, _FakeIdentity(),
        model_config=_FakeModelConfig({
            "mode": "antigravity",
            "antigravity_terms_acknowledged": "true",
        }),
    )

    d.dispatch(VALID_INV)

    _, _profile, env = rt.spawned[0]
    assert env["TINA_RUNNER"] == "antigravity"
    assert env["GEMINI_API_KEY"] == "deployment-gemini-key"
    assert env["TINA_ANTIGRAVITY_AUTH_MODE"] == "gemini-api"
    assert env["TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED"] == "true"


def test_dispatcher_worker_env_omits_unset_model_auth(monkeypatch):
    """Unset (or blank) auth stays ABSENT — a creds-less CI stack must boot fine; the worker fails
    at inference with the existing actionable auth/preflight error, not a poisoned empty var."""
    for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")  # blank-only value must be skipped too
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert not any(key in env for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST)


def test_dispatcher_worker_env_forwards_only_the_allowlist(monkeypatch):
    """No blanket env forwarding (P14/P15): a non-allowlisted secret in agent-api's environment
    never reaches the worker."""
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "never-forward-me")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "sub-token")
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert "AWS_SECRET_ACCESS_KEY" not in env
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sub-token"


# ── the additive mount set in the dispatch (WP-A1.1) ──────────────────────────

def _seed_ws(root, subject, marker="SEED"):
    """A seeded private baseline at <root>/<subject> (mirrors the workspace_attach test helper)."""
    from shared.seeding import seed_workspace
    ws = root / subject
    ws.mkdir(parents=True)
    (ws / "CLAUDE.md").write_text(marker)
    seed_workspace(ws, None)
    return ws


def test_dispatcher_worker_env_carries_the_baseline_plus_system_tier(tmp_path):
    """No activated extras, no _global configured → TINA_MOUNTS is the three-tier stack degraded to the
    private baseline + the always-present PRIVATE SYSTEM tier (AMENDMENT 4). The active portion is exactly
    today's single-workspace behavior; _system is appended (create-if-absent, read-write)."""
    settings = load_settings(workspaces_dir=str(tmp_path / "workspaces"))
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    mounts = json.loads(env["TINA_MOUNTS"])
    assert [m["role"] for m in mounts] == ["private", "system"]  # no _global (unconfigured)
    assert mounts[0]["primary"] is True and mounts[0]["path"].endswith("/u_jane")
    sysm = mounts[-1]
    assert sysm["slug"] == "_system" and sysm["write"] is True and sysm["primary"] is False


@pytest.mark.parametrize("event", [
    {
        "name": "email.received", "subject": "u_jane",
        "plan": {"prompt": "Triage this email."},
    },
    {
        "name": "meeting.completed", "subject": "u_jane",
        "meeting": {"meeting_id": "m1", "session_uid": "s1"},
        "plan": {"prompt": "Summarize this meeting."},
    },
])
def test_untrusted_event_dispatch_makes_every_mount_read_only(tmp_path, event):
    from control_plane.events import event_to_invocation

    settings = load_settings(workspaces_dir=str(tmp_path / "workspaces"))
    rt = _FakeRuntime()
    invocation = event_to_invocation(event)
    dispatch.Dispatcher(settings, rt, _FakeIdentity()).dispatch(invocation)

    mounts = json.loads(rt.spawned[0][2]["TINA_MOUNTS"])
    assert mounts
    assert all(mount["write"] is False for mount in mounts)


def _meeting_transcription_invocation():
    from shared.units import entrypoint, make_dispatch

    return make_dispatch(
        subject="u_jane",
        trigger="transcription",
        start=entrypoint(inline="summarize the meeting"),
        context={"kind": "meeting", "meeting": {
            "meeting_id": "42", "session_uid": "42", "numeric_meeting_id": "42",
            "native_id": "abc-defg-hij", "platform": "google_meet",
        }},
    )


def test_caller_supplied_meeting_context_does_not_create_a_live_transcript_stream(tmp_path):
    settings = load_settings(workspaces_dir=str(tmp_path / "workspaces"))
    rt = _FakeRuntime()
    dispatch.Dispatcher(settings, rt, _FakeIdentity()).dispatch(_meeting_transcription_invocation())

    env = rt.spawned[0][2]
    assert "TINA_TRANSCRIPT_STREAM" not in env
    assert "TINA_MEETING_ID" not in env


def test_only_trusted_live_meeting_dispatches_receive_the_transcript_stream(tmp_path):
    settings = load_settings(workspaces_dir=str(tmp_path / "workspaces"))
    rt = _FakeRuntime()
    dispatch.Dispatcher(settings, rt, _FakeIdentity()).dispatch(
        _meeting_transcription_invocation(), trusted_live_meeting=True,
    )

    env = rt.spawned[0][2]
    assert env["TINA_TRANSCRIPT_STREAM"] == "tc:meeting:42"
    assert env["TINA_MEETING_ID"] == "abc-defg-hij"


def test_worker_cwd_always_uses_a_declared_mount():
    from control_plane.dispatch import worker_cwd

    shared_viewer = {
        "slug": "team-room", "path": "/workspaces/team-room", "role": "shared",
        "write": False, "primary": False,
    }
    system = {
        "slug": "_system", "path": "/workspaces/.system/u_jane", "role": "system",
        "write": True, "primary": False,
    }

    assert worker_cwd("/workspaces", "u_jane", [shared_viewer, system]) == shared_viewer["path"]
    assert worker_cwd("/workspaces", "u_jane", [system]) == system["path"]
    with pytest.raises(ValueError, match="workspace mount"):
        worker_cwd("/workspaces", "u_jane", [])


def test_dispatcher_mount_stack_is_global_then_active_then_system(tmp_path):
    """The full THREE-TIER stack (AMENDMENT 4): _global (RO) first, then the ORDERED active set (private
    baseline + the activated extra), then _system (RW) last — TINA_MOUNTS is the whole stack, a LIST."""
    from control_plane.workspace_attach import activate_workspace
    import subprocess
    root = tmp_path / "workspaces"
    _seed_ws(root, "u_jane")
    # a local git repo to activate as a second, additive workspace (no network)
    origin = tmp_path / "shared"
    origin.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=origin, check=True, capture_output=True)
    run("init", "-q", "-b", "main"); run("config", "user.email", "t@t"); run("config", "user.name", "t")
    (origin / "CLAUDE.md").write_text("SHARED"); run("add", "-A"); run("commit", "-q", "-m", "s")
    slug = activate_workspace(root, "u_jane", str(origin), "main").slug
    # a platform-owned _global repo, mounted READ-ONLY into every worker
    gdir = tmp_path / "global"
    gdir.mkdir()
    grun = lambda *a: subprocess.run(["git", *a], cwd=gdir, check=True, capture_output=True)
    grun("init", "-q", "-b", "main"); grun("config", "user.email", "p@p"); grun("config", "user.name", "p")
    (gdir / "CLAUDE.md").write_text("GLOBAL"); grun("add", "-A"); grun("commit", "-q", "-m", "g")

    settings = load_settings(workspaces_dir=str(root), global_system_workspace_path=str(gdir))
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    mounts = json.loads(env["TINA_MOUNTS"])
    roles = [m["role"] for m in mounts]
    assert roles == ["global", "private", "private", "system"]  # the three-tier stack, in order
    g, base, extra, sysm = mounts
    # tier 1 — _global: READ-ONLY, its own host source, absent from the active-set commit path
    assert g["slug"] == "_global" and g["write"] is False and g["source"] == str(gdir)
    assert g["path"] == str(root / "_global")
    # tier 2 — the active set: private baseline (in place) + the activated extra (store slot)
    assert base["primary"] is True and base["path"] == str(root / "u_jane")
    assert extra["slug"] == slug and extra["primary"] is False
    assert extra["path"] == str(root / ".attached" / "u_jane" / slug)
    # tier 3 — _system: read-write, per-user, always last
    assert sysm["slug"] == "_system" and sysm["write"] is True


def test_dispatcher_stamps_principal_for_attribution(monkeypatch):
    """The dispatch principal (TINA_PRINCIPAL_*) is stamped for per-mount commit attribution (D4).
    Absent an explicit principal it defaults to the subject."""
    monkeypatch.delenv("TINA_PRINCIPAL_NAME", raising=False)
    monkeypatch.delenv("TINA_PRINCIPAL_EMAIL", raising=False)
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_PRINCIPAL_NAME"] == "u_jane"
    assert env["TINA_PRINCIPAL_EMAIL"] == "u_jane@tina.local"


def test_dispatcher_principal_env_wins_over_subject(monkeypatch):
    monkeypatch.setenv("TINA_PRINCIPAL_NAME", "Jane Doe")
    monkeypatch.setenv("TINA_PRINCIPAL_EMAIL", "jane@example.com")
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_PRINCIPAL_NAME"] == "Jane Doe"
    assert env["TINA_PRINCIPAL_EMAIL"] == "jane@example.com"


# ── Settings → Models: the per-subject model-config overlay (user pref > platform > env) ──────

class _FakeModelConfig:
    def __init__(self, config=None, error=None):
        self._config, self._error = config or {}, error
        self.asked: list[str] = []

    def resolve(self, subject):
        self.asked.append(subject)
        if self._error:
            raise self._error
        return self._config


def test_dispatcher_model_config_overrides_deployment_models():
    """The subject's configured models beat the deployment defaults (Settings → Models wins)."""
    settings = load_settings(agent_model="deployment-default", meeting_model="deployment-meeting")
    rt = _FakeRuntime()
    mc = _FakeModelConfig({"model": "my-model", "meeting_model": "my-meeting"})
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity(), model_config=mc)
    d.dispatch(VALID_INV)
    assert mc.asked == ["u_jane"]
    _, _profile, env = rt.spawned[0]
    assert env["TINA_AGENT_MODEL"] == "my-model"
    assert env["TINA_LLM_MODEL"] == "my-model"          # completion default follows the chat model
    assert env["TINA_MEETING_MODEL"] == "my-meeting"


def test_dispatcher_uses_auto_even_with_a_legacy_reasoning_effort():
    """Old saved effort pins must not override automatic provider thinking."""
    rt = _FakeRuntime()
    mc = _FakeModelConfig({"model": "my-model", "effort": "medium"})
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), model_config=mc)
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_AGENT_EFFORT"] == ""
    # no effort configured ⇒ no env key at all (unset must mean "don't touch the CLI default")
    rt2 = _FakeRuntime()
    d2 = dispatch.Dispatcher(load_settings(), rt2, _FakeIdentity(),
                           model_config=_FakeModelConfig({"model": "my-model"}))
    d2.dispatch(VALID_INV)
    _, _profile2, env2 = rt2.spawned[0]
    assert env2["TINA_AGENT_EFFORT"] == ""


def test_dispatcher_antigravity_mode_isolates_agent_model_and_requires_ack(monkeypatch):
    for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST:
        monkeypatch.delenv(key, raising=False)
    env = {}
    dispatch.overlay_model_config(env, {
        "mode": "antigravity",
        "model": "gemini-3.1-pro",
        "meeting_model": "gemini-meeting",
        "api_key": "gemini-api-key",
        "antigravity_terms_acknowledged": "true",
    })

    assert env["TINA_RUNNER"] == "antigravity"
    assert env["TINA_AGENT_MODEL"] == "gemini-3.1-pro"
    assert "TINA_LLM_MODEL" not in env
    assert "TINA_MEETING_MODEL" not in env
    assert env["TINA_ANTIGRAVITY_AUTH_MODE"] == "gemini-api"
    assert env["TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED"] == "true"
    assert env["GEMINI_API_KEY"] == "gemini-api-key"
    assert env["ANTHROPIC_API_KEY"] == ""
    assert env["OPENAI_API_KEY"] == ""

    env_without_ack = {}
    dispatch.overlay_model_config(env_without_ack, {"mode": "antigravity"})
    assert env_without_ack["TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED"] == ""


def test_dispatcher_model_config_custom_mode_stamps_both_call_shapes():
    """mode:custom points the harness (ANTHROPIC_*) AND the completion adapters (TINA_LLM_*) at
    the supplied gateway. Dispatch-stamped keys WIN downstream (docker_backend copies its own env
    only for keys absent here)."""
    rt = _FakeRuntime()
    mc = _FakeModelConfig({"mode": "custom", "base_url": "https://gw.example.com",
                           "api_key": "sk-user", "model": "qwen3"})
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), model_config=mc)
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["ANTHROPIC_BASE_URL"] == "https://gw.example.com"
    assert env["ANTHROPIC_AUTH_TOKEN"] == "sk-user"
    assert env["TINA_LLM_PROVIDER"] == "openai-compat"
    assert env["TINA_LLM_BASE_URL"] == "https://gw.example.com"
    assert env["TINA_LLM_API_KEY"] == "sk-user"
    assert env["TINA_AGENT_MODEL"] == "qwen3"


def test_groq_overlay_routes_chat_and_summaries_with_isolated_credentials(monkeypatch):
    monkeypatch.setenv("TINA_LLM_API_KEY", "deployment-secret")
    env = {key: "other-provider-secret" for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST}
    env.update(TINA_AGENT_MODEL="sonnet", TINA_MEETING_MODEL="haiku")
    dispatch.overlay_model_config(env, {"mode": "groq", "api_key": "groq-user-key",
                                        "base_url": "https://unrelated.invalid"})

    assert env["TINA_RUNNER"] == "codex"
    assert env["TINA_CODEX_AUTH_MODE"] == "groq"
    assert env["TINA_LLM_PROVIDER"] == "openai-compat"
    assert env["TINA_LLM_BASE_URL"] == "https://api.groq.com/openai/v1"
    assert env["TINA_LLM_API_KEY"] == "groq-user-key"
    assert env["TINA_AGENT_MODEL"] == "openai/gpt-oss-20b"
    assert env["TINA_LLM_MODEL"] == "openai/gpt-oss-20b"
    assert env["TINA_MEETING_MODEL"] == "openai/gpt-oss-20b"
    for key in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
                "OPENAI_API_KEY", "ACCESS_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "GEMINI_API_KEY"):
        assert env[key] == ""

    dispatch.overlay_model_config(env, {"mode": "groq"})
    assert env["TINA_LLM_API_KEY"] == ""  # no deployment/provider credential fallback


def test_groq_overlay_preserves_meeting_override_and_honors_model_allowlist():
    env = {}
    dispatch.overlay_model_config(env, {"mode": "groq", "model": "openai/gpt-oss-120b",
                                        "meeting_model": "llama-3.3-70b-versatile"})
    assert env["TINA_AGENT_MODEL"] == "openai/gpt-oss-120b"
    assert env["TINA_MEETING_MODEL"] == "llama-3.3-70b-versatile"
    dispatch.overlay_model_config(env, {"mode": "groq", "model": "denied-model"},
                                  allowlist="allowed-model")
    assert env["TINA_AGENT_MODEL"] == ""
    assert env["TINA_MEETING_MODEL"] == ""


@pytest.mark.parametrize("mode,runner,base,default", [
    ("deepseek", "claude-code", "https://api.deepseek.com", "deepseek-flash"),
    ("gemini", "antigravity", "https://generativelanguage.googleapis.com/v1beta/openai", "gemini-3.5-flash"),
])
def test_api_providers_route_both_call_shapes_and_isolate_defaults(mode, runner, base, default):
    env = {key: "foreign-secret" for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST}
    env.update(TINA_AGENT_MODEL="foreign-chat", TINA_MEETING_MODEL="foreign-summary")
    dispatch.overlay_model_config(env, {"mode": mode, "api_key": "own-key"})
    assert env["TINA_RUNNER"] == runner
    assert env["TINA_LLM_PROVIDER"] == "openai-compat"
    assert env["TINA_LLM_BASE_URL"] == base
    assert env["TINA_LLM_API_KEY"] == "own-key"
    assert env["TINA_AGENT_MODEL"] == env["TINA_MEETING_MODEL"] == default
    assert env["OPENAI_API_KEY"] == env["ACCESS_TOKEN"] == env["CLAUDE_CODE_OAUTH_TOKEN"] == ""
    if mode == "deepseek":
        assert env["ANTHROPIC_BASE_URL"] == "https://api.deepseek.com/anthropic"
        assert env["ANTHROPIC_AUTH_TOKEN"] == "own-key"
        assert env["ANTHROPIC_API_KEY"] == env["GEMINI_API_KEY"] == ""
        assert env["ANTHROPIC_DEFAULT_SONNET_MODEL"] == default
    else:
        assert env["GEMINI_API_KEY"] == "own-key"
        assert env["TINA_ANTIGRAVITY_AUTH_MODE"] == "gemini-api"
        assert env["TINA_ANTIGRAVITY_TERMS_ACKNOWLEDGED"] == ""
        assert env["ANTHROPIC_BASE_URL"] == env["ANTHROPIC_AUTH_TOKEN"] == ""

    dispatch.overlay_model_config(env, {"mode": mode, "model": "chat-override",
                                        "meeting_model": "summary-override"})
    assert env["TINA_AGENT_MODEL"] == "chat-override"
    assert env["TINA_MEETING_MODEL"] == "summary-override"
    assert env["TINA_LLM_API_KEY"] == ""
    dispatch.overlay_model_config(env, {"mode": mode}, allowlist="another-model")
    assert env["TINA_AGENT_MODEL"] == env["TINA_MEETING_MODEL"] == ""


def test_dispatcher_model_config_subscription_mode_keeps_deployment_credentials(monkeypatch):
    """mode:subscription (or unset) never stamps endpoint/credential env — the deployment's
    brokered credential (mounted subscription / deployment key) stays in charge."""
    for key in dispatch.MODEL_AUTH_ENV_ALLOWLIST:  # isolate from the test-runner's own env
        monkeypatch.delenv(key, raising=False)
    rt = _FakeRuntime()
    mc = _FakeModelConfig({"mode": "subscription", "model": "opus",
                           "base_url": "https://ignored.example.com", "api_key": "sk-ignored"})
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), model_config=mc)
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_AGENT_MODEL"] == "opus"
    assert "ANTHROPIC_BASE_URL" not in env
    assert "TINA_LLM_API_KEY" not in env


def test_dispatcher_model_config_allowlist_gates_models_not_endpoint():
    """A non-allowlisted model is DROPPED (deployment default applies) — never an error; the
    custom endpoint itself is not the allowlist's business."""
    settings = load_settings(agent_model="deployment-default", model_allowlist="sonnet,haiku")
    rt = _FakeRuntime()
    mc = _FakeModelConfig({"mode": "custom", "base_url": "https://gw.example.com",
                           "model": "not-allowed", "meeting_model": "haiku"})
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity(), model_config=mc)
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_AGENT_MODEL"] == "deployment-default"   # gated pref falls through
    assert env["TINA_MEETING_MODEL"] == "haiku"              # allowlisted pref applies
    assert env["ANTHROPIC_BASE_URL"] == "https://gw.example.com"


def test_dispatcher_model_config_failure_dispatches_on_env_defaults():
    """A down identity service must never block a turn (fail soft, like the membership index)."""
    settings = load_settings(agent_model="deployment-default")
    rt = _FakeRuntime()
    mc = _FakeModelConfig(error=RuntimeError("identity down"))
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity(), model_config=mc)
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_AGENT_MODEL"] == "deployment-default"


# ── warm delivery (the lost-turn fix): message prompts pre-deliver to unit:in ─────────────────────

class _WarmFake:
    """A minimal in-memory redis facade for the Dispatcher's warm-delivery seam."""

    def __init__(self):
        self.streams: dict[str, list] = {}
        self._seq = 0

    def xadd(self, name, fields):
        self._seq += 1
        eid = f"{self._seq}-0"
        self.streams.setdefault(name, []).append((eid, fields))
        return eid

    def xrevrange(self, name, count=1):
        return list(reversed(self.streams.get(name, [])))[:count]

    def xrange(self, name, start, end, count=200):
        entries = self.streams.get(name, [])
        if start.startswith("("):  # exclusive start id
            floor = int(start[1:].split("-")[0])
            return [e for e in entries if int(e[0].split("-")[0]) > floor][:count]
        return entries[:count]


def _in_topic_msgs(warm, wid):
    return [json.loads(f["turn"]) for _id, f in warm.streams.get(f"unit:{wid}:in", [])]


def test_message_dispatch_predelivers_prompt_to_the_in_topic():
    """The runtime's create is a TOUCH for a live workload (env discarded) — the prompt must ride
    the in topic so a warm worker's serve() loop takes the turn instead of it dispatching nowhere."""
    rt = _FakeRuntime()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), warm_stream=_WarmFake())
    wid = d.dispatch(VALID_INV)
    assert rt.spawned  # the spawn/touch still fires
    msgs = _in_topic_msgs(d._warm_stream, wid)
    assert len(msgs) == 1
    assert msgs[0]["type"] == "message" and msgs[0]["prompt"] == "hi" and msgs[0]["nonce"]


def test_non_message_triggers_do_not_predeliver():
    rt = _FakeRuntime()
    warm = _WarmFake()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), warm_stream=warm)
    inv = {**VALID_INV, "trigger": "scheduled", "identity": {"subject": "u_jane", "launcher": "schedule:r1"}}
    d.dispatch(inv)
    assert warm.streams == {}  # nothing on any in topic


def test_watchdog_respawns_once_when_the_worker_exited_without_taking_the_message(monkeypatch):
    """The idle-exit race: XADD landed after the worker's final read; the touch saw it still
    running. No turn-accepted + workload gone ⇒ respawn (the fresh worker's entrypoint re-runs
    the prompt; the stale in-topic copy is behind its boot anchor)."""
    import time as _time

    monkeypatch.setattr(dispatch.Dispatcher, "_ACK_DEADLINE_SEC", 0.6)
    monkeypatch.setattr(dispatch.Dispatcher, "_ACK_POLL_SEC", 0.05)
    rt = _FakeRuntime()  # await_done returns "completed" → workload gone
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), warm_stream=_WarmFake())
    d.dispatch(VALID_INV)
    deadline = _time.monotonic() + 3.0
    while len(rt.spawned) < 2 and _time.monotonic() < deadline:
        _time.sleep(0.02)
    assert len(rt.spawned) == 2  # exactly one respawn
    _time.sleep(0.2)
    assert len(rt.spawned) == 2  # …and never more


def test_watchdog_stays_quiet_when_the_worker_acks(monkeypatch):
    monkeypatch.setattr(dispatch.Dispatcher, "_ACK_DEADLINE_SEC", 0.6)
    monkeypatch.setattr(dispatch.Dispatcher, "_ACK_POLL_SEC", 0.05)
    import time as _time

    rt = _FakeRuntime()
    warm = _WarmFake()
    d = dispatch.Dispatcher(load_settings(), rt, _FakeIdentity(), warm_stream=warm)
    wid = d.dispatch(VALID_INV)
    # the (warm) worker picks the message up and acks
    warm.xadd(f"unit:{wid}:out", {"event": json.dumps({"type": "turn-accepted", "turn_id": "t3"})})
    _time.sleep(0.8)
    assert len(rt.spawned) == 1  # no respawn


def test_message_dispatch_stamps_the_chat_idle_window():
    rt = _FakeRuntime()
    settings = load_settings()
    d = dispatch.Dispatcher(settings, rt, _FakeIdentity(), warm_stream=_WarmFake())
    d.dispatch(VALID_INV)
    _, _profile, env = rt.spawned[0]
    assert env["TINA_IDLE_TIMEOUT_SEC"] == str(settings.chat_idle_timeout_sec)


@pytest.mark.parametrize("translation,allowlist,expected", [("luna", "", "luna"), ("", "", "meeting"), ("blocked", "sol,meeting", "meeting")])
def test_translation_model_isolated_from_chat_and_meeting(translation, allowlist, expected):
    from shared.units import DICTATION_TRANSLATE_PREFIX
    settings = load_settings(model_allowlist=allowlist)
    config = {"mode": "openai-api", "model": "sol", "meeting_model": "meeting", "translation_model": translation}
    regular = dispatch.build_unit_env(settings, VALID_INV, unit_id="regular", token="test", model_config=config)
    invocation = {**VALID_INV, "context": {"kind": "none", "session": "dictation-translate-test"},
                  "start": {"entrypoint": {"inline": DICTATION_TRANSLATE_PREFIX + "{}"}}}
    translated = dispatch.build_unit_env(settings, invocation, unit_id="translated", token="test", model_config=config)
    assert regular["TINA_MEETING_MODEL"] == "meeting"
    assert translated["TINA_MEETING_MODEL"] == expected
    assert translated["TINA_AGENT_MODEL"] == regular["TINA_AGENT_MODEL"] == "sol"
