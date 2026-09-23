"""The Claude provider, exercised against a fake client (no network)."""
import json
from types import SimpleNamespace

from meetnote import config, summarize

from .test_text import meeting_segments


class FakeStream:
    def __init__(self, calls, kwargs):
        self.calls, self.kwargs = calls, kwargs

    def __enter__(self):
        self.calls.append(self.kwargs)
        return self

    def __exit__(self, *a):
        return False

    def get_final_message(self):
        body = {
            "title": "신제품 출시 일정 및 마케팅 예산 논의",
            "one_line": "출시일을 다음 달 말로 확정하고 마케팅 예산 집행 계획을 정리함",
            "overview": "요약 문단", "key_points": ["핵심"],
            "topics": [{"title": "출시 일정", "time": "00:16", "points": ["다음 달 말 출시"]}],
            "decisions": ["출시일 다음 달 말 확정"],
            "action_items": [{"task": "오프라인 행사 기획안 공유", "owner": "이대리", "due": "다음 주 금요일", "time": "00:50"}],
            "open_issues": [], "keywords": ["출시", "마케팅 예산"],
            "participants": [{"name": "김팀장", "summary": "회의 진행"}],
        }
        return SimpleNamespace(stop_reason="end_turn",
                               content=[SimpleNamespace(type="text", text=json.dumps(body, ensure_ascii=False))])


def fake_client(calls):
    messages = SimpleNamespace(stream=lambda **kw: FakeStream(calls, kw))
    return SimpleNamespace(messages=messages, beta=SimpleNamespace(messages=messages))


def test_claude_summary_request_and_parse(monkeypatch):
    calls = []
    monkeypatch.setattr(summarize, "_claude_client", lambda s: fake_client(calls))
    config.save_settings({"llm_provider": "claude", "claude_model": "claude-opus-5"})
    try:
        segs = meeting_segments()
        data, label = summarize.summarize({"note_type": "meeting", "language": "ko", "memo": "예산 재확인"},
                                          segs, {0: "김팀장", 1: "이대리"})
    finally:
        config.save_settings({"llm_provider": "auto"})
    assert label == "Claude (claude-opus-5)"
    assert data["topics"][0]["start"] == 16
    assert data["action_items"][0]["start"] == 50 and data["action_items"][0]["done"] is False
    req = calls[0]
    assert req["model"] == "claude-opus-5"
    assert req["thinking"] == {"type": "adaptive"}
    assert req["output_config"]["format"]["type"] == "json_schema"
    assert "[00:35] 이대리: 마케팅 예산은" in req["messages"][0]["content"]
    assert "예산 재확인" in req["messages"][0]["content"]


def test_schema_is_strict():
    def walk(node):
        if node.get("type") == "object":
            assert node["additionalProperties"] is False
            assert set(node["required"]) == set(node["properties"])
            for v in node["properties"].values():
                walk(v)
        if node.get("type") == "array":
            walk(node["items"])
    walk(summarize.SCHEMA)
