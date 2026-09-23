"""HTTP API + recording WebSocket + static UI."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import queue
import re
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import numpy as np
from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import audio, config, db, engines, export, models, pipeline, summarize

log = logging.getLogger("meetnote.server")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
ALLOWED_HOSTS = {"127.0.0.1", "localhost", "[::1]"}

app = FastAPI(title="MeetNote", docs_url=None, redoc_url=None)


@app.middleware("http")
async def guard(request: Request, call_next):
    # Only this machine may talk to the app: reject other Host names (DNS
    # rebinding) and require a custom header on writes, which a cross-site
    # form or fetch cannot send without a CORS preflight we never allow.
    host = (request.headers.get("host") or "").rsplit(":", 1)[0]
    if host not in ALLOWED_HOSTS and not os.environ.get("MEETNOTE_ALLOW_ANY_HOST"):
        return JSONResponse({"detail": "forbidden host"}, status_code=403)
    if request.url.path.startswith("/api/") and request.method not in ("GET", "HEAD", "OPTIONS"):
        if request.headers.get("x-meetnote") != "1":
            return JSONResponse({"detail": "missing header"}, status_code=403)
    return await call_next(request)


@app.on_event("startup")
def _startup() -> None:
    db.init()
    _recover_recordings()
    pipeline.start()


# ------------------------------------------------------------------ helpers

def _note_or_404(nid: str) -> dict:
    n = db.get_note(nid)
    if not n:
        raise HTTPException(404, "노트를 찾을 수 없습니다.")
    return n


def _full(nid: str) -> dict:
    n = _note_or_404(nid)
    n["segments"] = db.get_segments(nid)
    n["speakers"] = db.get_speakers(nid)
    n["bookmarks"] = db.list_bookmarks(nid)
    return n


def _default_title(prefix: str = "") -> str:
    now = datetime.now()
    ampm = "오전" if now.hour < 12 else "오후"
    h = now.hour % 12 or 12
    return f"{prefix}{now:%m월 %d일} {ampm} {h}:{now:%M}".strip()


# ------------------------------------------------------------------ app state

@app.get("/api/state")
def state():
    s = config.load_settings()
    return {
        "version": config.VERSION,
        "counts": db.counts(),
        "folders": db.list_folders(),
        "settings": config.public_settings(),
        "engine": engines.resolve(),
        "engines": engines.available(),
        "summary_provider": summarize.resolve_provider(s),
        "models_ready": all(models.installed(k) for k, m in models.REGISTRY.items() if m["required"]),
        "platform": sys.platform,
        "data_dir": str(config.HOME),
    }


@app.get("/api/settings")
def get_settings():
    return config.public_settings()


@app.patch("/api/settings")
def patch_settings(patch: dict = Body(...)):
    if "anthropic_api_key" in patch and not patch["anthropic_api_key"]:
        patch.pop("anthropic_api_key")  # empty field in the form means "unchanged"
    if patch.get("clear_api_key"):
        patch["anthropic_api_key"] = ""
    config.save_settings(patch)
    return config.public_settings()


@app.get("/api/ollama/models")
def ollama_models():
    s = config.load_settings()
    return {"ok": summarize.ollama_ok(s), "models": summarize.ollama_models(s)}


@app.get("/api/models")
def models_status():
    return models.status()


@app.post("/api/models/{key}/download")
def models_download(key: str):
    if key != "whisper-mlx" and key not in models.REGISTRY:
        raise HTTPException(404)
    models.download(key)
    return {"ok": True}


# ------------------------------------------------------------------ notes

@app.get("/api/notes")
def list_notes(view: str = "all", folder: str | None = None, q: str = "", sort: str = "recent"):
    return db.list_notes(view=view, folder=folder, q=q.strip(), sort=sort)


@app.get("/api/notes/{nid}")
def get_note(nid: str):
    return _full(nid)


@app.get("/api/notes/{nid}/status")
def note_status(nid: str):
    n = _note_or_404(nid)
    return {k: n[k] for k in ("status", "stage", "progress", "error", "summary_status", "summary_error",
                              "updated_at", "title", "duration")}


@app.patch("/api/notes/{nid}")
def patch_note(nid: str, patch: dict = Body(...)):
    _note_or_404(nid)
    fields = {k: v for k, v in patch.items()
              if k in {"title", "memo", "favorite", "folder_id", "note_type", "language", "num_speakers", "hint"}}
    if "title" in fields:
        fields["title"] = (fields["title"] or "").strip() or "제목 없음"
        fields["title_locked"] = 1
    if "favorite" in fields:
        fields["favorite"] = 1 if fields["favorite"] else 0
    touch = set(fields) - {"favorite"} != set()
    db.update_note(nid, touch=touch, **fields)
    return _note_or_404(nid)


@app.post("/api/notes/{nid}/trash")
def trash_note(nid: str):
    _note_or_404(nid)
    db.update_note(nid, touch=False, deleted_at=time.time())
    return {"ok": True}


@app.post("/api/notes/{nid}/restore")
def restore_note(nid: str):
    _note_or_404(nid)
    db.update_note(nid, touch=False, deleted_at=None)
    return {"ok": True}


@app.delete("/api/notes/{nid}")
def delete_note(nid: str):
    audio_file = db.delete_note_forever(nid)
    if audio_file:
        (config.AUDIO_DIR / audio_file).unlink(missing_ok=True)
    return {"ok": True}


@app.post("/api/trash/empty")
def empty_trash():
    for n in db.list_notes(view="trash"):
        delete_note(n["id"])
    return {"ok": True}


@app.post("/api/notes/{nid}/reprocess")
def reprocess(nid: str, opts: dict = Body(default={})):
    n = _note_or_404(nid)
    if n["status"] in ("recording",):
        raise HTTPException(409, "녹음 중인 노트입니다.")
    fields = {k: opts[k] for k in ("num_speakers", "language", "hint") if k in opts}
    if fields:
        db.update_note(nid, touch=False, **fields)
    if opts.get("engine"):
        config.save_settings({"asr_engine": opts["engine"]})
    pipeline.enqueue(nid)
    return {"ok": True}


@app.post("/api/notes/{nid}/summarize")
def resummarize(nid: str):
    _note_or_404(nid)
    pipeline.enqueue(nid, "summary")
    return {"ok": True}


@app.put("/api/notes/{nid}/summary")
def save_summary(nid: str, data: dict = Body(...)):
    _note_or_404(nid)
    db.update_note(nid, summary=json.dumps(data, ensure_ascii=False))
    return {"ok": True}


# ------------------------------------------------------------------ upload

@app.post("/api/notes/upload")
async def upload(file: UploadFile = File(...), language: str = Form("ko"), num_speakers: int = Form(0),
                 note_type: str = Form("meeting"), hint: str = Form(""), folder_id: str = Form(""),
                 title: str = Form("")):
    name = file.filename or "audio"
    ext = Path(name).suffix.lower() or ".bin"
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", ext):
        ext = ".bin"
    note = db.create_note(title=title.strip() or Path(name).stem[:60] or _default_title(),
                          title_locked=1 if title.strip() else 0, source="upload", status="queued",
                          language=language, num_speakers=num_speakers, note_type=note_type, hint=hint,
                          folder_id=folder_id or None, original_name=name, recorded_at=time.time())
    nid = note["id"]
    raw = config.AUDIO_DIR / f"{nid}{ext}"
    with open(raw, "wb") as f:
        while chunk := await file.read(1 << 20):
            f.write(chunk)
    if raw.stat().st_size == 0:
        db.delete_note_forever(nid)
        raw.unlink(missing_ok=True)
        raise HTTPException(400, "빈 파일입니다.")
    db.update_note(nid, touch=False, audio_file=raw.name, duration=audio.probe_duration(raw))
    await asyncio.to_thread(_make_playable, nid, raw)
    pipeline.enqueue(nid)
    return _note_or_404(nid)


def _make_playable(nid: str, raw: Path) -> None:
    """Keep files the player understands; convert anything else (webm, ogg, flac…) to m4a."""
    if raw.suffix.lower() in audio.PLAYABLE:
        db.update_note(nid, touch=False, audio_mime=audio.PLAYABLE[raw.suffix.lower()])
        return
    try:
        samples = audio.decode(raw)
        out = raw.with_suffix(".m4a")
        audio.encode_m4a(samples, out)
        raw.unlink(missing_ok=True)
        db.update_note(nid, touch=False, audio_file=out.name, audio_mime="audio/mp4",
                       duration=len(samples) / audio.SR)
    except Exception as e:
        db.update_note(nid, touch=False, status="error", error=f"지원하지 않는 파일 형식입니다: {e}")


# ------------------------------------------------------------------ recording

@app.post("/api/notes/record")
def start_record(opts: dict = Body(default={})):
    note = db.create_note(title=opts.get("title") or _default_title(), source="record", status="recording",
                          stage="녹음 중", language=opts.get("language") or config.load_settings()["language"],
                          num_speakers=int(opts.get("num_speakers") or 0),
                          note_type=opts.get("note_type") or "meeting", hint=opts.get("hint") or "",
                          folder_id=opts.get("folder_id") or None, recorded_at=time.time())
    return note


class Recorder:
    """Appends PCM to disk as it arrives so nothing is lost if the app dies."""

    def __init__(self, nid: str, language: str, send):
        self.nid = nid
        self.pcm_path = config.AUDIO_DIR / f"{nid}.pcm"
        self.f = open(self.pcm_path, "ab")
        self.samples = 0
        self.send = send
        self.q: "queue.Queue[np.ndarray | None]" = queue.Queue()
        self.live = None
        if config.load_settings()["live_transcription"] and models.installed("sensevoice") and models.installed("vad"):
            try:
                from .engines.sherpa import LiveTranscriber
                self.live = LiveTranscriber(language, on_text=self._on_text)
            except Exception:
                log.exception("live transcription unavailable")
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _on_text(self, item):
        self.send({"type": "live", **item})

    def _run(self):
        while True:
            x = self.q.get()
            if x is None:
                break
            if self.live:
                try:
                    self.live.feed(x)
                except Exception:
                    log.exception("live feed failed")
                    self.live = None
        if self.live:
            try:
                self.live.flush()
            except Exception:
                pass

    def write(self, b: bytes):
        if len(b) % 2:
            b = b[:-1]
        self.f.write(b)
        self.samples += len(b) // 2
        self.q.put(audio.pcm16_to_float(b))

    def close(self):
        self.f.close()
        self.q.put(None)
        self.thread.join(timeout=30)


def finalize_recording(nid: str) -> None:
    pcm = config.AUDIO_DIR / f"{nid}.pcm"
    if not pcm.exists() or pcm.stat().st_size < 3200:  # < 0.1 s
        pcm.unlink(missing_ok=True)
        db.update_note(nid, status="error", stage="", error="녹음된 소리가 없습니다.")
        return
    samples = audio.pcm16_to_float(pcm.read_bytes())
    out = config.AUDIO_DIR / f"{nid}.m4a"
    audio.encode_m4a(samples, out)
    if config.load_settings().get("keep_recording_wav"):
        import soundfile as sf
        sf.write(config.AUDIO_DIR / f"{nid}.wav", samples, audio.SR)
    pcm.unlink(missing_ok=True)
    db.update_note(nid, audio_file=out.name, audio_mime="audio/mp4", duration=len(samples) / audio.SR,
                   peaks=json.dumps(audio.peaks(samples)))
    pipeline.enqueue(nid)


def _recover_recordings() -> None:
    for r in db.conn().execute("SELECT id FROM notes WHERE status='recording'").fetchall():
        try:
            finalize_recording(r["id"])
        except Exception:
            log.exception("recover %s", r["id"])


@app.websocket("/ws/record/{nid}")
async def ws_record(ws: WebSocket, nid: str):
    origin = ws.headers.get("origin", "")
    host = (ws.headers.get("host") or "").rsplit(":", 1)[0]
    if host not in ALLOWED_HOSTS or (origin and not re.match(r"^https?://(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$", origin)):
        await ws.close(code=4403)
        return
    note = db.get_note(nid)
    if not note or note["status"] != "recording":
        await ws.close(code=4404)
        return
    await ws.accept()
    loop = asyncio.get_running_loop()
    outbox: asyncio.Queue = asyncio.Queue()

    def send(msg):
        loop.call_soon_threadsafe(outbox.put_nowait, msg)

    async def pump():
        while True:
            msg = await outbox.get()
            try:
                await ws.send_text(json.dumps(msg, ensure_ascii=False))
            except Exception:
                return

    rec = await asyncio.to_thread(Recorder, nid, note["language"], send)
    pump_task = asyncio.create_task(pump())
    finished = False
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes"):
                rec.write(msg["bytes"])
                continue
            data = json.loads(msg.get("text") or "{}")
            kind = data.get("type")
            if kind == "bookmark":
                t = data.get("t", rec.samples / audio.SR)
                b = db.add_bookmark(nid, float(t), data.get("label", ""))
                send({"type": "bookmark", **b})
            elif kind == "memo":
                db.update_note(nid, touch=False, memo=data.get("memo", ""))
            elif kind == "stop":
                finished = True
                break
            elif kind == "cancel":
                finished = True
                await asyncio.to_thread(rec.close)
                (config.AUDIO_DIR / f"{nid}.pcm").unlink(missing_ok=True)
                db.delete_note_forever(nid)
                await ws.send_text(json.dumps({"type": "cancelled"}))
                pump_task.cancel()
                await ws.close()
                return
    except WebSocketDisconnect:
        pass
    finally:
        if not rec.f.closed:
            await asyncio.to_thread(rec.close)
    # Stop or a dropped connection both keep what was recorded.
    await asyncio.sleep(0.05)
    await asyncio.to_thread(finalize_recording, nid)
    if finished:
        try:
            await ws.send_text(json.dumps({"type": "saved", "id": nid}))
            await ws.close()
        except Exception:
            pass
    pump_task.cancel()


# ------------------------------------------------------------------ transcript edits

@app.patch("/api/notes/{nid}/segments/{sid}")
def patch_segment(nid: str, sid: int, patch: dict = Body(...)):
    _note_or_404(nid)
    db.update_segment(nid, sid, **patch)
    return {"ok": True}


@app.post("/api/notes/{nid}/segments/{sid}/merge-next")
def merge_segment(nid: str, sid: int):
    db.merge_segment_with_next(nid, sid)
    return {"ok": True}


@app.post("/api/notes/{nid}/replace")
def replace_text(nid: str, body: dict = Body(...)):
    """Find & replace across the transcript (e.g. fix a name everywhere)."""
    find, repl = body.get("find", ""), body.get("replace", "")
    if not find:
        raise HTTPException(400)
    n = 0
    for s in db.get_segments(nid):
        if find in s["text"]:
            db.update_segment(nid, s["id"], text=s["text"].replace(find, repl))
            n += 1
    return {"count": n}


@app.put("/api/notes/{nid}/speakers/{idx}")
def rename_speaker(nid: str, idx: int, body: dict = Body(...)):
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "이름을 입력하세요.")
    db.rename_speaker(nid, idx, name[:40])
    return {"ok": True}


@app.post("/api/notes/{nid}/speakers")
def add_speaker(nid: str, body: dict = Body(default={})):
    return {"idx": db.add_speaker(nid, body.get("name"))}


@app.post("/api/notes/{nid}/speakers/merge")
def merge_speakers(nid: str, body: dict = Body(...)):
    db.merge_speakers(nid, int(body["src"]), int(body["dst"]))
    return {"ok": True}


# ------------------------------------------------------------------ bookmarks

@app.post("/api/notes/{nid}/bookmarks")
def add_bookmark(nid: str, body: dict = Body(...)):
    _note_or_404(nid)
    return db.add_bookmark(nid, float(body.get("t", 0)), body.get("label", ""))


@app.patch("/api/notes/{nid}/bookmarks/{bid}")
def patch_bookmark(nid: str, bid: str, body: dict = Body(...)):
    db.update_bookmark(nid, bid, body.get("label", ""))
    return {"ok": True}


@app.delete("/api/notes/{nid}/bookmarks/{bid}")
def delete_bookmark(nid: str, bid: str):
    db.delete_bookmark(nid, bid)
    return {"ok": True}


# ------------------------------------------------------------------ chat (AI Q&A)

@app.get("/api/notes/{nid}/chat")
def get_chat(nid: str):
    return db.list_chats(nid)


@app.post("/api/notes/{nid}/chat")
async def post_chat(nid: str, body: dict = Body(...)):
    note = _note_or_404(nid)
    q = (body.get("question") or "").strip()
    if not q:
        raise HTTPException(400)
    history = db.list_chats(nid)
    db.add_chat(nid, "user", q)
    segs = db.get_segments(nid)
    speakers = {s["idx"]: s["name"] for s in db.get_speakers(nid)}
    try:
        ans = await asyncio.to_thread(summarize.answer, note, segs, speakers, history, q)
    except Exception as e:
        log.exception("chat failed")
        ans = f"답변을 만들지 못했습니다: {e}\n\n" + summarize.local_answer(segs, speakers, q)
    return db.add_chat(nid, "assistant", ans)


@app.delete("/api/notes/{nid}/chat")
def clear_chat(nid: str):
    db.clear_chats(nid)
    return {"ok": True}


# ------------------------------------------------------------------ media & export

@app.get("/api/notes/{nid}/audio")
def get_audio(nid: str):
    n = _note_or_404(nid)
    p = config.AUDIO_DIR / (n["audio_file"] or "_")
    if not n["audio_file"] or not p.exists():
        raise HTTPException(404)
    return FileResponse(p, media_type=n["audio_mime"] or "application/octet-stream")


def _safe_name(title: str) -> str:
    return re.sub(r'[\\/:*?"<>|\n\r]+', " ", title).strip()[:80] or "note"


@app.get("/api/notes/{nid}/export")
def export_note(nid: str, fmt: str = "txt", summary: int = 1, transcript: int = 1):
    n = _note_or_404(nid)
    segs = db.get_segments(nid)
    sp = db.get_speakers(nid)
    name = _safe_name(n["title"])
    if fmt == "txt":
        body, mime, ext = export.to_txt(n, segs, sp, include_summary=bool(summary)).encode(), "text/plain; charset=utf-8", "txt"
    elif fmt == "md":
        body, mime, ext = export.to_md(n, segs, sp).encode(), "text/markdown; charset=utf-8", "md"
    elif fmt == "minutes":
        body, mime, ext = export.minutes_md(n, segs, sp).encode(), "text/markdown; charset=utf-8", "md"
    elif fmt == "docx":
        body = export.to_docx(n, segs, sp, include_transcript=bool(transcript))
        mime, ext = "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"
    elif fmt == "srt":
        body, mime, ext = export.to_srt(n, segs, sp).encode(), "application/x-subrip; charset=utf-8", "srt"
    elif fmt == "vtt":
        body, mime, ext = export.to_vtt(n, segs, sp).encode(), "text/vtt; charset=utf-8", "vtt"
    elif fmt == "json":
        body, mime, ext = export.to_json(n, segs, sp, db.list_bookmarks(nid)).encode(), "application/json", "json"
    elif fmt == "audio":
        p = config.AUDIO_DIR / n["audio_file"]
        return FileResponse(p, media_type=n["audio_mime"] or "application/octet-stream",
                            filename=f"{name}{p.suffix}")
    else:
        raise HTTPException(400, "unknown format")
    fname = f"{name}.{ext}"
    return Response(body, media_type=mime, headers={
        "Content-Disposition": f"attachment; filename=\"note.{ext}\"; filename*=UTF-8''{quote(fname)}"})


# ------------------------------------------------------------------ folders

@app.get("/api/folders")
def list_folders():
    return db.list_folders()


@app.post("/api/folders")
def create_folder(body: dict = Body(...)):
    name = (body.get("name") or "").strip() or "새 폴더"
    return db.create_folder(name[:40])


@app.patch("/api/folders/{fid}")
def rename_folder(fid: str, body: dict = Body(...)):
    db.rename_folder(fid, (body.get("name") or "").strip()[:40] or "폴더")
    return {"ok": True}


@app.delete("/api/folders/{fid}")
def delete_folder(fid: str):
    db.delete_folder(fid)
    return {"ok": True}


# ------------------------------------------------------------------ app control

@app.post("/api/app/reveal")
def reveal_data():
    if sys.platform == "darwin":
        subprocess.Popen(["open", str(config.HOME)])
    return {"path": str(config.HOME)}


@app.post("/api/app/open-browser")
def open_browser(request: Request):
    import webbrowser
    webbrowser.open(str(request.base_url))
    return {"ok": True}


@app.post("/api/app/quit")
def quit_app():
    threading.Timer(0.3, lambda: os._exit(0)).start()
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})


app.mount("/assets", StaticFiles(directory=WEB_DIR / "assets"), name="assets")
