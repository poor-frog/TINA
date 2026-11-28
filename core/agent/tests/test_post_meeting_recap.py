"""Tests for structured post-meeting recap extraction and validation."""
import json

import pytest

from shared.meeting_knowledge import (
    PREFIX,
    count_transcript_questions,
    recap_schema,
    validate_recap_answer,
)


SOURCES = [
    {"id": "s0", "quote": "Chúng ta cần kiểm tra giới hạn token cho 10.000 người dùng như thế nào?"},
    {"id": "s1", "quote": "Minh sẽ cập nhật bộ lọc Prompt Injection trước thứ Sáu. Còn câu hỏi nào về chi phí không?"},
]


def test_validate_recap_answer_parses_structured_recap_and_fences():
    raw = """```json
    {
      "claims": [
        {"topic": "Vấn đề kỹ thuật:", "text": "Thảo luận giới hạn token cho 10.000 người dùng.", "source_ids": ["s0", "s0"]},
        {"topic": "An toàn hệ thống", "text": "Cần cập nhật bộ lọc Prompt Injection trước thứ Sáu.", "source_ids": ["s1"]}
      ],
      "topics": ["Token", "Prompt Injection", "token", "  "],
      "action_items": [
        {"text": "Minh cập nhật bộ lọc Prompt Injection trước thứ Sáu.", "source_ids": ["s1"]}
      ],
      "questions": [
        {"text": "Kiểm tra giới hạn token cho 10.000 người dùng như thế nào?", "source_ids": ["s0"]}
      ]
    }
    ```"""
    recap = validate_recap_answer(raw, SOURCES)
    assert recap["claims"] == [
        {"topic": "Vấn đề kỹ thuật", "text": "Thảo luận giới hạn token cho 10.000 người dùng.", "source_ids": ["s0"]},
        {"topic": "An toàn hệ thống", "text": "Cần cập nhật bộ lọc Prompt Injection trước thứ Sáu.", "source_ids": ["s1"]},
    ]
    assert recap["topics"] == ["Token", "Prompt Injection"]
    assert len(recap["action_items"]) == 1
    assert len(recap["questions"]) == 1


def test_validate_recap_answer_accepts_legacy_claims_only_payload():
    raw = json.dumps({"claims": [{"text": "Chốt lịch phát hành vào thứ Sáu.", "source_ids": ["s1"]}]})
    recap = validate_recap_answer(raw, SOURCES)
    assert recap["claims"] == [{"text": "Chốt lịch phát hành vào thứ Sáu.", "source_ids": ["s1"]}]
    assert recap["topics"] == []
    assert recap["action_items"] == []
    assert recap["questions"] == []


def test_validate_recap_answer_rejects_uncited_action_or_question():
    bad = json.dumps({
        "claims": [{"topic": "Kỹ thuật", "text": "Nội dung hợp lệ.", "source_ids": ["s0"]}],
        "topics": ["Token"],
        "action_items": [{"text": "Việc bịa đặt không có nguồn.", "source_ids": ["s99"]}],
        "questions": [],
    })
    with pytest.raises(ValueError, match="Invalid citation"):
        validate_recap_answer(bad, SOURCES)


def test_count_transcript_questions_counts_distinct_non_trivial_questions():
    assert count_transcript_questions(SOURCES) == 2
    assert count_transcript_questions([{"quote": "Ok? ??? Hả? Đây là câu hỏi thật sự về ngân sách?"}]) == 1


def test_recap_schema_constrains_source_ids():
    schema = recap_schema(SOURCES)
    assert set(schema["required"]) == {"claims", "topics", "action_items", "questions"}
    assert schema["properties"]["claims"]["items"]["properties"]["source_ids"]["items"]["enum"] == ["s0", "s1"]


def test_worker_post_meeting_recap_mode_uses_structured_schema(monkeypatch):
    from worker import engine

    captured = {}
    emitted = []

    class FakeReply:
        def __init__(self, text):
            self.text = text

    class FakeProvider:
        def complete_structured(self, prompt, *, system, schema):
            captured["system"] = system
            captured["schema"] = schema
            return FakeReply(json.dumps({
                "claims": [{"topic": "Kỹ thuật", "text": "Thảo luận giới hạn token.", "source_ids": ["s0"]}],
                "topics": ["Token"],
                "action_items": [{"text": "Minh cập nhật bộ lọc trước thứ Sáu.", "source_ids": ["s1"]}],
                "questions": [{"text": "Còn câu hỏi nào về chi phí không?", "source_ids": ["s1"]}],
            }, ensure_ascii=False))

    class FakeStream:
        def xadd(self, topic, fields):
            emitted.append((topic, json.loads(fields["event"])))

        def expire(self, topic, ttl):
            pass

    req_id = "recap-test-1"
    monkeypatch.setenv("TINA_CHAT_SESSION", f"meeting-knowledge-{req_id}")
    monkeypatch.setattr(engine, "completion_from_env", lambda timeout=45: FakeProvider())
    payload = {
        "request_id": req_id,
        "text": json.dumps({"mode": "post_meeting_recap", "question": "Summarize", "sources": SOURCES}),
    }
    engine._run_meeting_knowledge(FakeStream(), "out", {"entrypoint": {"inline": PREFIX + json.dumps(payload)}})
    assert "action_items" in captured["schema"]["required"]
    deltas = [ev for _topic, ev in emitted if ev.get("type") == "message-delta"]
    assert len(deltas) == 1
    parsed = json.loads(deltas[0]["text"])
    assert parsed["topics"] == ["Token"]
    assert len(parsed["action_items"]) == 1


def test_internal_post_meeting_report_works_with_require_gateway_identity(tmp_path, monkeypatch):
    """Regression: staging enables TINA_REQUIRE_GATEWAY_IDENTITY=1 while flows calls
    POST /internal/post-meeting/report/{id} directly with X-Internal-Secret + X-User-Id."""
    from fastapi.testclient import TestClient

    from control_plane import api as agent_api
    from control_plane import local_completion, meeting_knowledge
    from control_plane.dispatch import Dispatcher
    from control_plane.workspace_reader import WorkspaceReader
    from shared.config import load_settings

    monkeypatch.setenv("TINA_REQUIRE_GATEWAY_IDENTITY", "1")
    monkeypatch.setenv("TINA_INTERNAL_API_SECRET", "staging-internal-secret")
    monkeypatch.setenv("TINA_LOCAL_COMPLETION_POOL", "1")

    class _FakeRuntime:
        def spawn(self, workload_id, profile, env):
            return workload_id

        def await_done(self, workload_id, timeout_sec=0.0):
            return "completed"

    class _FakeIdentity:
        def mint(self, subject, launcher, workspaces, tools):
            return "tok"

    class _FakeStreamReader:
        def read(self, unit_id, resume="0-0"):
            return iter(())

    def _fake_meeting_get(_base, subject, meeting_id, path):
        assert subject == "2"
        assert meeting_id == 43
        if path == "/meetings/43":
            return {"id": 43, "user_id": 2, "status": "completed", "shared": False, "data": {}}
        if path == "/transcripts/by-id/43/canonical":
            return {
                "segments": [
                    {
                        "segment_id": "seg-1",
                        "revision": 0,
                        "speaker_name": "Quang Thanh",
                        "speaker_revision": 0,
                        "start_ms": 1000,
                        "end_ms": 5000,
                        "text": "Chốt lịch deploy bản vá vào chiều nay nhé?",
                    }
                ]
            }
        raise AssertionError(f"unexpected path: {path}")

    def _fake_local_complete(*, task, inline, session_id, label, timeout_seconds, model_env):
        assert task == "knowledge"
        payload = json.loads(inline.removeprefix(PREFIX))
        inner = json.loads(payload["text"])
        assert inner["mode"] == "post_meeting_recap"
        sid = inner["sources"][0]["id"]
        return json.dumps({
            "claims": [{"topic": "Kế hoạch", "text": "Chốt lịch deploy bản vá vào chiều nay.", "source_ids": [sid]}],
            "topics": ["Deploy"],
            "action_items": [{"text": "Deploy bản vá vào chiều nay.", "source_ids": [sid]}],
            "questions": [{"text": "Chốt lịch deploy bản vá vào chiều nay nhé?", "source_ids": [sid]}],
        }, ensure_ascii=False)

    monkeypatch.setattr(meeting_knowledge, "meeting_get", _fake_meeting_get)
    monkeypatch.setattr(local_completion, "complete", _fake_local_complete)

    settings = load_settings()
    app = agent_api.create_app(
        Dispatcher(settings, _FakeRuntime(), _FakeIdentity()),
        stream_reader=_FakeStreamReader(),
        reader=WorkspaceReader(str(tmp_path)),
    )
    client = TestClient(app)

    # Missing or wrong internal secret must fail closed with 403 (never reach subject_of).
    r_bad = client.post("/internal/post-meeting/report/43", headers={"X-User-Id": "2", "X-Internal-Secret": "wrong"})
    assert r_bad.status_code == 403

    # Valid internal secret without X-User-Id still fails closed with 401.
    r_no_uid = client.post(
        "/internal/post-meeting/report/43",
        headers={"X-Internal-Secret": "staging-internal-secret"},
    )
    assert r_no_uid.status_code == 401

    # Valid internal secret + X-User-Id (without X-Gateway-Verified, exactly as flows sends it) succeeds.
    r_ok = client.post(
        "/internal/post-meeting/report/43",
        headers={"X-User-Id": "2", "X-Internal-Secret": "staging-internal-secret"},
    )
    assert r_ok.status_code == 200, r_ok.text
    body = r_ok.json()
    assert "Chốt lịch deploy bản vá vào chiều nay." in body["report"]
    assert body["insights"]["topics"] == ["Deploy"]
    assert body["insights"]["action_item_count"] == 1
    assert body["insights"]["question_count"] >= 1
