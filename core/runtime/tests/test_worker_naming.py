"""Pure unit tests (no docker daemon) for the cosmetic worker container naming + grouping labels.

Agent-dispatch workers get a ``tina-worker-*`` container name (the workload id / Stream topics / reaper
keys are untouched) and ``tina.role``/``tina.kind`` labels; non-agent workloads pass through unchanged.
"""
from runtime_kernel.docker_backend import DockerBackend, _is_ephemeral_oneshot_worker, _worker_naming
from runtime_kernel.profiles import Runnable


def test_meet_worker_named_and_labelled():
    leaf, labels = _worker_naming("agent-meet-abc123")
    assert leaf == "worker-meet-abc123"
    assert labels == {"tina.role": "worker", "tina.kind": "meet"}


def test_chat_worker_named_and_labelled():
    leaf, labels = _worker_naming("agent-alice-chat")
    assert leaf == "worker-alice-chat"
    assert labels == {"tina.role": "worker", "tina.kind": "chat"}


def test_event_worker_named_and_labelled():
    leaf, labels = _worker_naming("agent-alice-scheduled-deadbeef12")
    assert leaf == "worker-alice-scheduled-deadbeef12"
    assert labels == {"tina.role": "worker", "tina.kind": "event"}


def test_non_agent_workload_unchanged():
    leaf, labels = _worker_naming("meeting-bot-xyz")
    assert leaf == "meeting-bot-xyz"
    assert labels == {}


def test_cname_applies_prefix_and_rename():
    b = DockerBackend()
    assert b._cname("agent-meet-abc123") == "tina-worker-meet-abc123"
    assert b._cname("agent-alice-chat") == "tina-worker-alice-chat"
    assert b._cname("rt-dockertest") == "tina-rt-dockertest"  # non-agent: prefix only


def test_ephemeral_oneshot_worker_sets_autoremove():
    assert _is_ephemeral_oneshot_worker("agent-4-chat-dictation-translate-abc", {"TINA_DICTATION_TRANSLATE": "1"})
    assert _is_ephemeral_oneshot_worker("agent-meet-canonical-123", {"TINA_CANONICAL_NOTES_TRUSTED": "1"})
    assert _is_ephemeral_oneshot_worker("agent-4-chat-knowledge-1", {"TINA_MEETING_KNOWLEDGE": "1"})
    assert not _is_ephemeral_oneshot_worker("agent-4-chat", {"TINA_CHAT_SESSION": "main"})
    assert not _is_ephemeral_oneshot_worker("mtg-28-abc", {"TINA_DICTATION_TRANSLATE": "1"})

    created_payloads = []

    class _FakeResp:
        def __init__(self, status_code, body=None):
            self.status_code = status_code
            self._body = body or {}
            self.text = ""
        def json(self):
            return self._body

    class _FakeSession:
        def request(self, method, url, **kw):
            if method == "POST" and "/containers/create" in url:
                created_payloads.append(kw.get("json"))
                return _FakeResp(201, {"Id": "cid-1"})
            if method == "POST" and "/start" in url:
                return _FakeResp(204)
            return _FakeResp(200)

    b = DockerBackend()
    b._session = _FakeSession()
    b.start("agent-4-chat-dictation-translate-abc", Runnable(image="tina/v012-agent-worker:dev"), {"TINA_DICTATION_TRANSLATE": "1"})
    b.start("agent-4-chat", Runnable(image="tina/v012-agent-worker:dev"), {"TINA_CHAT_SESSION": "main"})
    b.start("mtg-1-xyz", Runnable(image="tina/tina-bot:dev"), {})

    assert created_payloads[0]["HostConfig"].get("AutoRemove") is True
    assert "AutoRemove" not in created_payloads[1]["HostConfig"]
    assert "AutoRemove" not in created_payloads[2]["HostConfig"]
