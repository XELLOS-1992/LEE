"""SQLite storage for notes, transcripts, speakers, bookmarks and folders."""
from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  folder_id TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  recorded_at REAL,
  duration REAL DEFAULT 0,
  source TEXT DEFAULT 'upload',           -- record | upload
  status TEXT DEFAULT 'queued',           -- recording | queued | processing | done | error
  stage TEXT DEFAULT '',
  progress REAL DEFAULT 0,
  error TEXT DEFAULT '',
  language TEXT DEFAULT 'ko',
  num_speakers INTEGER DEFAULT 0,         -- 0 = auto
  note_type TEXT DEFAULT 'meeting',       -- meeting | interview | lecture | call | memo
  hint TEXT DEFAULT '',                   -- vocabulary / keywords to help recognition
  audio_file TEXT DEFAULT '',
  audio_mime TEXT DEFAULT '',
  original_name TEXT DEFAULT '',
  peaks TEXT DEFAULT '[]',
  favorite INTEGER DEFAULT 0,
  deleted_at REAL,
  memo TEXT DEFAULT '',
  summary TEXT DEFAULT '',                -- JSON
  summary_status TEXT DEFAULT '',         -- '' | running | done | error
  summary_provider TEXT DEFAULT '',
  summary_error TEXT DEFAULT '',
  engine TEXT DEFAULT '',
  title_locked INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS speakers (
  note_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (note_id, idx)
);
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  pos INTEGER NOT NULL,
  speaker INTEGER NOT NULL DEFAULT 0,
  start REAL NOT NULL,
  end REAL NOT NULL,
  text TEXT NOT NULL,
  words TEXT DEFAULT '[]',
  highlight INTEGER DEFAULT 0,
  edited INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_segments_note ON segments(note_id, pos);
CREATE TABLE IF NOT EXISTS bookmarks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  t REAL NOT NULL,
  label TEXT DEFAULT '',
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bookmarks_note ON bookmarks(note_id);
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT,
  kind TEXT NOT NULL,                     -- summary | chat
  model TEXT NOT NULL,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_write_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at REAL NOT NULL
);
"""

_local = threading.local()
_write_lock = threading.RLock()


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(config.DB_PATH, timeout=30, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        _local.conn = c
    return c


@contextmanager
def tx():
    with _write_lock:
        c = conn()
        try:
            yield c
            c.commit()
        except Exception:
            c.rollback()
            raise


def init() -> None:
    with tx() as c:
        c.executescript(SCHEMA)
        # Anything left mid-flight by a crash gets re-queued on start.
        c.execute("UPDATE notes SET status='queued', stage='', progress=0 WHERE status='processing'")
        c.execute("UPDATE notes SET summary_status='' WHERE summary_status='running'")


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def now() -> float:
    return time.time()


# ---------------------------------------------------------------- notes

NOTE_FIELDS = {
    "title", "folder_id", "recorded_at", "duration", "source", "status", "stage", "progress",
    "error", "language", "num_speakers", "note_type", "hint", "audio_file", "audio_mime",
    "original_name", "peaks", "favorite", "deleted_at", "memo", "summary", "summary_status",
    "summary_provider", "summary_error", "engine", "title_locked",
}


def create_note(**fields) -> dict:
    nid = new_id()
    t = now()
    fields = {k: v for k, v in fields.items() if k in NOTE_FIELDS}
    fields.setdefault("title", "새 노트")
    cols = ["id", "created_at", "updated_at", *fields.keys()]
    vals = [nid, t, t, *fields.values()]
    with tx() as c:
        c.execute(
            f"INSERT INTO notes ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", vals
        )
    return get_note(nid)


def update_note(nid: str, touch: bool = True, **fields) -> None:
    fields = {k: v for k, v in fields.items() if k in NOTE_FIELDS}
    if not fields:
        return
    if touch:
        fields["updated_at"] = now()
    sets = ",".join(f"{k}=?" for k in fields)
    with tx() as c:
        c.execute(f"UPDATE notes SET {sets} WHERE id=?", [*fields.values(), nid])


def _note_row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["summary"] = json.loads(d["summary"]) if d.get("summary") else None
    d["peaks"] = json.loads(d["peaks"] or "[]")
    d["favorite"] = bool(d["favorite"])
    return d


def get_note(nid: str) -> dict | None:
    r = conn().execute("SELECT * FROM notes WHERE id=?", (nid,)).fetchone()
    return _note_row(r) if r else None


def list_notes(view: str = "all", folder: str | None = None, q: str = "", sort: str = "recent") -> list[dict]:
    where, args = [], []
    if view == "trash":
        where.append("n.deleted_at IS NOT NULL")
    else:
        where.append("n.deleted_at IS NULL")
    if view == "favorites":
        where.append("n.favorite=1")
    if folder:
        where.append("n.folder_id=?")
        args.append(folder)
    if q:
        like = f"%{q}%"
        where.append(
            "(n.title LIKE ? OR n.memo LIKE ? OR n.summary LIKE ? OR EXISTS "
            "(SELECT 1 FROM segments s WHERE s.note_id=n.id AND s.text LIKE ?))"
        )
        args += [like, like, like, like]
    order = {
        "recent": "n.created_at DESC",
        "oldest": "n.created_at ASC",
        "title": "n.title COLLATE NOCASE ASC",
        "duration": "n.duration DESC",
        "updated": "n.updated_at DESC",
    }.get(sort, "n.created_at DESC")
    rows = conn().execute(
        f"SELECT n.id, n.title, n.folder_id, n.created_at, n.updated_at, n.recorded_at, n.duration, "
        f"n.source, n.status, n.stage, n.progress, n.error, n.favorite, n.deleted_at, n.summary, "
        f"n.note_type, n.language, "
        f"(SELECT COUNT(*) FROM speakers sp WHERE sp.note_id=n.id) AS speaker_count "
        f"FROM notes n WHERE {' AND '.join(where)} ORDER BY {order}",
        args,
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        summ = json.loads(d.pop("summary") or "null")
        d["preview"] = ""
        d["keywords"] = []
        if summ:
            d["preview"] = summ.get("one_line") or summ.get("overview", "")[:160]
            d["keywords"] = (summ.get("keywords") or [])[:5]
        if not d["preview"]:
            first = conn().execute(
                "SELECT text FROM segments WHERE note_id=? ORDER BY pos LIMIT 3", (d["id"],)
            ).fetchall()
            d["preview"] = " ".join(x["text"] for x in first)[:160]
        if q:
            hit = conn().execute(
                "SELECT start, text FROM segments WHERE note_id=? AND text LIKE ? ORDER BY pos LIMIT 1",
                (d["id"], f"%{q}%"),
            ).fetchone()
            if hit:
                d["match"] = {"t": hit["start"], "text": hit["text"]}
        d["favorite"] = bool(d["favorite"])
        out.append(d)
    return out


def delete_note_forever(nid: str) -> str | None:
    note = get_note(nid)
    with tx() as c:
        for t in ("segments", "speakers", "bookmarks", "chats"):
            c.execute(f"DELETE FROM {t} WHERE note_id=?", (nid,))
        c.execute("DELETE FROM notes WHERE id=?", (nid,))
    return note["audio_file"] if note else None


# ---------------------------------------------------------------- transcript

def get_segments(nid: str) -> list[dict]:
    rows = conn().execute(
        "SELECT id, pos, speaker, start, end, text, words, highlight, edited FROM segments "
        "WHERE note_id=? ORDER BY pos",
        (nid,),
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["words"] = json.loads(d["words"] or "[]")
        d["highlight"] = bool(d["highlight"])
        d["edited"] = bool(d["edited"])
        out.append(d)
    return out


def replace_transcript(nid: str, segments: list[dict], speakers: list[str]) -> None:
    with tx() as c:
        c.execute("DELETE FROM segments WHERE note_id=?", (nid,))
        c.execute("DELETE FROM speakers WHERE note_id=?", (nid,))
        for i, name in enumerate(speakers):
            c.execute("INSERT INTO speakers (note_id, idx, name) VALUES (?,?,?)", (nid, i, name))
        c.executemany(
            "INSERT INTO segments (note_id, pos, speaker, start, end, text, words) VALUES (?,?,?,?,?,?,?)",
            [
                (nid, i, s["speaker"], s["start"], s["end"], s["text"],
                 json.dumps(s.get("words") or [], ensure_ascii=False))
                for i, s in enumerate(segments)
            ],
        )


def update_segment(nid: str, sid: int, **fields) -> None:
    allowed = {k: v for k, v in fields.items() if k in {"text", "speaker", "highlight"}}
    if "text" in allowed:
        allowed["edited"] = 1
        allowed["words"] = "[]"  # word timings no longer match edited text
    if "highlight" in allowed:
        allowed["highlight"] = 1 if allowed["highlight"] else 0
    if not allowed:
        return
    sets = ",".join(f"{k}=?" for k in allowed)
    with tx() as c:
        c.execute(f"UPDATE segments SET {sets} WHERE id=? AND note_id=?", [*allowed.values(), sid, nid])
        c.execute("UPDATE notes SET updated_at=? WHERE id=?", (now(), nid))


def merge_segment_with_next(nid: str, sid: int) -> None:
    segs = get_segments(nid)
    for i, s in enumerate(segs[:-1]):
        if s["id"] == sid:
            nxt = segs[i + 1]
            with tx() as c:
                c.execute(
                    "UPDATE segments SET end=?, text=?, words=? WHERE id=?",
                    (nxt["end"], (s["text"] + " " + nxt["text"]).strip(),
                     json.dumps(s["words"] + nxt["words"], ensure_ascii=False), sid),
                )
                c.execute("DELETE FROM segments WHERE id=?", (nxt["id"],))
            return


def get_speakers(nid: str) -> list[dict]:
    rows = conn().execute(
        "SELECT idx, name FROM speakers WHERE note_id=? ORDER BY idx", (nid,)
    ).fetchall()
    return [dict(r) for r in rows]


def rename_speaker(nid: str, idx: int, name: str) -> None:
    with tx() as c:
        c.execute(
            "INSERT INTO speakers (note_id, idx, name) VALUES (?,?,?) "
            "ON CONFLICT(note_id, idx) DO UPDATE SET name=excluded.name",
            (nid, idx, name),
        )
        c.execute("UPDATE notes SET updated_at=? WHERE id=?", (now(), nid))


def add_speaker(nid: str, name: str | None = None) -> int:
    sp = get_speakers(nid)
    idx = (max(s["idx"] for s in sp) + 1) if sp else 0
    rename_speaker(nid, idx, name or f"참석자 {idx + 1}")
    return idx


def merge_speakers(nid: str, src: int, dst: int) -> None:
    with tx() as c:
        c.execute("UPDATE segments SET speaker=? WHERE note_id=? AND speaker=?", (dst, nid, src))
        c.execute("DELETE FROM speakers WHERE note_id=? AND idx=?", (nid, src))


# ---------------------------------------------------------------- bookmarks

def add_bookmark(nid: str, t: float, label: str = "") -> dict:
    b = {"id": new_id(), "note_id": nid, "t": float(t), "label": label, "created_at": now()}
    with tx() as c:
        c.execute(
            "INSERT INTO bookmarks (id, note_id, t, label, created_at) VALUES (?,?,?,?,?)",
            (b["id"], nid, b["t"], label, b["created_at"]),
        )
    return b


def list_bookmarks(nid: str) -> list[dict]:
    return [dict(r) for r in conn().execute(
        "SELECT * FROM bookmarks WHERE note_id=? ORDER BY t", (nid,)).fetchall()]


def update_bookmark(nid: str, bid: str, label: str) -> None:
    with tx() as c:
        c.execute("UPDATE bookmarks SET label=? WHERE id=? AND note_id=?", (label, bid, nid))


def delete_bookmark(nid: str, bid: str) -> None:
    with tx() as c:
        c.execute("DELETE FROM bookmarks WHERE id=? AND note_id=?", (bid, nid))


# ---------------------------------------------------------------- folders

def list_folders() -> list[dict]:
    rows = conn().execute(
        "SELECT f.*, (SELECT COUNT(*) FROM notes n WHERE n.folder_id=f.id AND n.deleted_at IS NULL) AS count "
        "FROM folders f ORDER BY f.created_at"
    ).fetchall()
    return [dict(r) for r in rows]


def create_folder(name: str) -> dict:
    f = {"id": new_id(), "name": name, "created_at": now()}
    with tx() as c:
        c.execute("INSERT INTO folders (id, name, created_at) VALUES (?,?,?)", (f["id"], name, f["created_at"]))
    return f


def rename_folder(fid: str, name: str) -> None:
    with tx() as c:
        c.execute("UPDATE folders SET name=? WHERE id=?", (name, fid))


def delete_folder(fid: str) -> None:
    with tx() as c:
        c.execute("UPDATE notes SET folder_id=NULL WHERE folder_id=?", (fid,))
        c.execute("DELETE FROM folders WHERE id=?", (fid,))


def counts() -> dict:
    c = conn()
    return {
        "all": c.execute("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL").fetchone()[0],
        "favorites": c.execute("SELECT COUNT(*) FROM notes WHERE deleted_at IS NULL AND favorite=1").fetchone()[0],
        "trash": c.execute("SELECT COUNT(*) FROM notes WHERE deleted_at IS NOT NULL").fetchone()[0],
        "processing": c.execute("SELECT COUNT(*) FROM notes WHERE status IN ('queued','processing')").fetchone()[0],
    }


# ---------------------------------------------------------------- chats

def add_chat(nid: str, role: str, content: str) -> dict:
    t = now()
    with tx() as c:
        cur = c.execute(
            "INSERT INTO chats (note_id, role, content, created_at) VALUES (?,?,?,?)", (nid, role, content, t)
        )
    return {"id": cur.lastrowid, "role": role, "content": content, "created_at": t}


def list_chats(nid: str) -> list[dict]:
    return [dict(r) for r in conn().execute(
        "SELECT id, role, content, created_at FROM chats WHERE note_id=? ORDER BY id", (nid,)).fetchall()]


def clear_chats(nid: str) -> None:
    with tx() as c:
        c.execute("DELETE FROM chats WHERE note_id=?", (nid,))


# ---------------------------------------------------------------- API usage

def add_usage(note_id, kind, model, inp, out, cw, cr, cost) -> None:
    with tx() as c:
        c.execute(
            "INSERT INTO usage (note_id, kind, model, input_tokens, output_tokens, cache_write_tokens, "
            "cache_read_tokens, cost_usd, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (note_id, kind, model, inp, out, cw, cr, cost, now()),
        )


def usage_summary(note_id: str | None = None) -> dict:
    import datetime as _dt
    month = _dt.datetime.now().replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
    q = ("SELECT COUNT(*) n, COALESCE(SUM(input_tokens+cache_write_tokens+cache_read_tokens),0) inp, "
         "COALESCE(SUM(output_tokens),0) out, COALESCE(SUM(cost_usd),0) cost FROM usage WHERE ")
    c = conn()
    if note_id:
        return dict(c.execute(q + "note_id=?", (note_id,)).fetchone())
    return {
        "month": dict(c.execute(q + "created_at>=?", (month,)).fetchone()),
        "all": dict(c.execute(q + "1=1").fetchone()),
    }
