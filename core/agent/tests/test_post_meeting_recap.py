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
