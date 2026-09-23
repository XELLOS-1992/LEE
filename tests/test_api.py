"""HTTP API, security guard, exports, and the full pipeline on real speech."""
import io
import time

import pytest
from fastapi.testclient import TestClient

from meetnote import db, export
from meetnote.server import app

from .conftest import FIXTURES, needs_models
from .test_text import meeting_segments

H = {"X-MeetNote": "1"}


@pytest.fixture(scope="module")
def client():
    with TestClient(app, base_url="http://127.0.0.1:8765") as c:
        yield c


def test_guard_rejects_foreign_host_and_missing_header(client):
    assert client.get("/api/state", headers={"host": "evil.example"}).status_code == 403
    assert client.post("/api/folders", json={"name": "x"}).status_code == 403
    assert client.post("/api/folders", json={"name": "x"}, headers=H).status_code == 200


def test_state_and_settings_mask_key(client):
    r = client.patch("/api/settings", json={"anthropic_api_key": "sk-ant-test-123456789"}, headers=H)
    body = r.json()
    assert body["anthropic_api_key"] == "" and body["anthropic_api_key_set"] and body["anthropic_api_key_hint"] == "…6789"
    client.patch("/api/settings", json={"clear_api_key": True}, headers=H)
    st = client.get("/api/state").json()
    assert st["summary_provider"] in ("local", "ollama")


def _note_with_transcript():
    n = db.create_note(title="예산 회의", title_locked=1, status="done", duration=64.0)
    segs = meeting_segments()
    db.replace_transcript(n["id"], segs, ["참석자 1", "참석자 2"])
    return n["id"]


def test_edit_flow_and_exports(client):
    nid = _note_with_transcript()
    note = client.get(f"/api/notes/{nid}").json()
    seg = note["segments"][2]
    client.patch(f"/api/notes/{nid}/segments/{seg['id']}", json={"text": "정식 출시일은 언제인가요?", "highlight": True}, headers=H)
    client.put(f"/api/notes/{nid}/speakers/0", json={"name": "김팀장"}, headers=H)
    client.post(f"/api/notes/{nid}/bookmarks", json={"t": 29.0, "label": "출시일 확정"}, headers=H)
    r = client.post(f"/api/notes/{nid}/replace", json={"find": "오천만", "replace": "5천만"}, headers=H)
    assert r.json()["count"] == 1
    client.post(f"/api/notes/{nid}/summarize", headers=H)
    for _ in range(50):
        if db.get_note(nid)["summary_status"] == "done":
            break
        time.sleep(0.1)
    note = client.get(f"/api/notes/{nid}").json()
    assert note["segments"][2]["text"] == "정식 출시일은 언제인가요?" and note["segments"][2]["highlight"]
    assert note["speakers"][0]["name"] == "김팀장"
    assert note["bookmarks"][0]["label"] == "출시일 확정"
    assert note["summary"]["decisions"]
    assert note["title"] == "예산 회의"  # a title the user set is never replaced by the AI title

    for fmt, needle in [("txt", "김팀장 00:00"), ("md", "## 전체 대화"), ("minutes", "## 결정 사항"),
                        ("srt", "00:00:00,000 -->"), ("vtt", "WEBVTT"), ("json", '"segments"')]:
        r = client.get(f"/api/notes/{nid}/export?fmt={fmt}")
        assert r.status_code == 200, fmt
        assert needle in r.text, fmt
    r = client.get(f"/api/notes/{nid}/export?fmt=docx")
    from docx import Document
    doc = Document(io.BytesIO(r.content))
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "결정 사항" in text and "전체 대화" in text and "5천만" in text

    hits = client.get("/api/notes", params={"q": "기획안"}).json()
    assert hits and hits[0]["id"] == nid and hits[0]["match"]["t"] == 50.0

    client.post(f"/api/notes/{nid}/trash", headers=H)
    assert nid not in [n["id"] for n in client.get("/api/notes").json()]
    assert nid in [n["id"] for n in client.get("/api/notes", params={"view": "trash"}).json()]
    client.post(f"/api/notes/{nid}/restore", headers=H)
    client.delete(f"/api/notes/{nid}", headers=H)
    assert client.get(f"/api/notes/{nid}").status_code == 404


def test_srt_splits_long_paragraphs():
    n = {"title": "t", "created_at": 0, "recorded_at": 0, "duration": 10, "note_type": "meeting", "summary": None, "memo": ""}
    words = [{"w": f"단어{i}", "s": i * 0.5, "e": i * 0.5 + 0.4} for i in range(30)]
    segs = [{"speaker": 0, "start": 0, "end": 15, "text": " ".join(w["w"] for w in words), "words": words}]
    srt = export.to_srt(n, segs, [{"idx": 0, "name": "A"}])
    assert srt.count("-->") > 3


@needs_models
def test_upload_transcribes_two_speakers(client):
    from meetnote import config
    config.save_settings({"asr_engine": "sensevoice"})
    with open(FIXTURES / "two_speakers_ko.m4a", "rb") as f:
        r = client.post("/api/notes/upload", files={"file": ("회의.m4a", f, "audio/mp4")},
                        data={"language": "ko", "num_speakers": "0"}, headers=H)
    assert r.status_code == 200, r.text
    nid = r.json()["id"]
    for _ in range(240):
        st = client.get(f"/api/notes/{nid}/status").json()
        if st["status"] in ("done", "error") and st["summary_status"] != "running":
            break
        time.sleep(0.5)
    assert st["status"] == "done", st
    note = client.get(f"/api/notes/{nid}").json()
    speakers = [s["speaker"] for s in note["segments"]]
    starts = [round(s["start"]) for s in note["segments"]]
    assert len(set(speakers)) == 2, note["segments"]
    # Turns: A, B, A, B, A, B
    assert speakers == [0, 1, 0, 1, 0, 1], list(zip(starts, speakers))
    text = " ".join(s["text"] for s in note["segments"])
    for phrase in ("조금만 생각을 하면서", "부모가 저지르는 큰 실수", "지하철에서"):
        assert phrase in text
    assert note["summary"] and note["summary"]["keywords"]
    assert client.get(f"/api/notes/{nid}/audio").status_code == 200
    r = client.get(f"/api/notes/{nid}/audio", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100
