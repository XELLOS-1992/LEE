"""Background worker: audio → transcript → speakers → AI summary."""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import traceback

from . import audio, config, db, diarize, engines, models, summarize

log = logging.getLogger("meetnote.pipeline")

_jobs: "queue.Queue[tuple[str, str]]" = queue.Queue()
_queued: set[tuple[str, str]] = set()
_qlock = threading.Lock()
_started = False

STAGES = {
    "prepare": ("준비 중", 0.0, 0.05),
    "models": ("모델 준비 중", 0.05, 0.08),
    "asr": ("음성을 텍스트로 변환 중", 0.08, 0.72),
    "diarize": ("화자 구분 중", 0.72, 0.90),
    "finish": ("정리 중", 0.90, 1.0),
}


def enqueue(note_id: str, kind: str = "transcribe") -> None:
    key = (note_id, kind)
    with _qlock:
        if key in _queued:
            return
        _queued.add(key)
    if kind == "transcribe":
        db.update_note(note_id, touch=False, status="queued", stage="대기 중", progress=0, error="")
    else:
        db.update_note(note_id, touch=False, summary_status="running", summary_error="")
    _jobs.put(key)


def start() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_worker, name="meetnote-worker", daemon=True).start()
    # Resume anything that was waiting when the app last quit.
    for n in db.conn().execute("SELECT id FROM notes WHERE status='queued' AND deleted_at IS NULL").fetchall():
        enqueue(n["id"])


def _worker() -> None:
    while True:
        nid, kind = _jobs.get()
        with _qlock:
            _queued.discard((nid, kind))
        try:
            if kind == "transcribe":
                process(nid)
            else:
                run_summary(nid)
        except Exception as e:  # keep the worker alive whatever happens
            log.error("job %s %s failed: %s", kind, nid, traceback.format_exc())
            if kind == "transcribe":
                db.update_note(nid, touch=False, status="error", error=str(e) or e.__class__.__name__, stage="")
            else:
                db.update_note(nid, touch=False, summary_status="error", summary_error=str(e))


def _stage(nid: str, key: str, frac: float = 0.0) -> None:
    label, a, b = STAGES[key]
    db.update_note(nid, touch=False, status="processing", stage=label, progress=round(a + (b - a) * frac, 4))


def process(nid: str) -> None:
    note = db.get_note(nid)
    if not note or note["deleted_at"]:
        return
    settings = config.load_settings()
    t0 = time.time()
    _stage(nid, "prepare")
    samples = audio.decode(config.AUDIO_DIR / note["audio_file"])
    duration = len(samples) / audio.SR
    db.update_note(nid, touch=False, duration=duration, peaks=json.dumps(audio.peaks(samples)))
    if duration < 0.5:
        raise ValueError("녹음이 너무 짧습니다.")

    _stage(nid, "models")
    missing = [k for k, m in models.REGISTRY.items() if m["required"] and not models.installed(k)]
    for i, k in enumerate(missing):
        db.update_note(nid, touch=False, stage=f"모델 다운로드 중: {models.REGISTRY[k]['name']}")
        models.download(k, block=True)
        if not models.installed(k):
            raise RuntimeError(f"모델을 내려받지 못했습니다: {models.REGISTRY[k]['name']} (인터넷 연결 확인)")
    engine = engines.get()
    if engine.name == "whisper-mlx" and not models.status()["mlx"]["installed"]:
        db.update_note(nid, touch=False, stage="Whisper 모델 다운로드 중 (최초 1회, 약 1.6GB)")
        models.download("whisper-mlx", block=True)
    db.update_note(nid, touch=False, engine=engine.label)

    _stage(nid, "asr")
    lang = note["language"] or settings["language"]
    try:
        pieces = engine.transcribe(samples, language=lang, hint=note["hint"],
                                   progress=lambda f: _stage(nid, "asr", f))
    except Exception:
        if engine.name == "sensevoice":
            raise
        # Never leave the user without a transcript: fall back to SenseVoice.
        log.error("engine %s failed, falling back to SenseVoice: %s", engine.name, traceback.format_exc())
        engine = engines.get("sensevoice")
        db.update_note(nid, touch=False, engine=engine.label + " (대체)")
        _stage(nid, "asr")
        pieces = engine.transcribe(samples, language=lang, hint=note["hint"],
                                   progress=lambda f: _stage(nid, "asr", f))
    log.info("asr %s: %d pieces in %.1fs", nid, len(pieces), time.time() - t0)

    turns = []
    if settings["diarization"] and note["num_speakers"] != 1 and pieces:
        _stage(nid, "diarize")
        turns = diarize.diarize(samples, num_speakers=note["num_speakers"] or 0,
                                threshold=float(settings["diarization_threshold"]),
                                progress=lambda f: _stage(nid, "diarize", f))
    _stage(nid, "finish")
    assigned = diarize.assign(pieces, turns)
    paras, n_spk = diarize.renumber(diarize.paragraphs(assigned))
    old = {s["idx"]: s["name"] for s in db.get_speakers(nid)}
    names = [old.get(i, f"참석자 {i + 1}") for i in range(n_spk)]
    db.replace_transcript(nid, paras, names)
    db.update_note(nid, status="done", stage="", progress=1.0, error="")
    log.info("note %s done in %.1fs (%.0fs audio)", nid, time.time() - t0, duration)

    if settings["auto_summary"] and paras:
        run_summary(nid)


def run_summary(nid: str) -> None:
    note = db.get_note(nid)
    if not note:
        return
    segs = db.get_segments(nid)
    speakers = {s["idx"]: s["name"] for s in db.get_speakers(nid)}
    db.update_note(nid, touch=False, summary_status="running", summary_error="")
    try:
        data, label = summarize.summarize(note, segs, speakers)
    except Exception as e:
        log.warning("summary via provider failed, using offline summary: %s", e)
        data = summarize.normalize(summarize.local_summary(note, segs, speakers), segs)
        label = "내장 요약 (오프라인)"
        db.update_note(nid, touch=False, summary_error=f"AI 요약 실패로 내장 요약을 사용했습니다: {e}")
    # Keep checkbox state of action items the user already ticked.
    prev = note.get("summary") or {}
    done = {a.get("task") for a in prev.get("action_items", []) if a.get("done")}
    for a in data["action_items"]:
        a["done"] = a["task"] in done
    fields = {"summary": json.dumps(data, ensure_ascii=False), "summary_status": "done",
              "summary_provider": label}
    if not note["title_locked"] and data.get("title"):
        fields["title"] = data["title"]
    db.update_note(nid, **fields)
