"""Speaker diarization (who spoke when) and merging with the transcript."""
from __future__ import annotations

import os
import threading
from collections import Counter, defaultdict

import numpy as np

from . import models

SR = 16000
_lock = threading.Lock()
_cache: dict[tuple, object] = {}


def _diarizer(num_speakers: int, threshold: float):
    import sherpa_onnx

    key = (num_speakers, round(threshold, 3))
    with _lock:
        if key not in _cache:
            threads = max(1, min(8, os.cpu_count() or 4))
            cfg = sherpa_onnx.OfflineSpeakerDiarizationConfig(
                segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                    pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                        model=str(models.path("diar-seg") / "model.onnx")),
                    num_threads=threads),
                embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=str(models.path("diar-emb")), num_threads=threads),
                clustering=sherpa_onnx.FastClusteringConfig(
                    num_clusters=num_speakers if num_speakers > 0 else -1, threshold=threshold),
                min_duration_on=0.3, min_duration_off=0.5,
            )
            _cache.clear()  # keep only one loaded config around
            _cache[key] = sherpa_onnx.OfflineSpeakerDiarization(cfg)
        return _cache[key]


def diarize(audio: np.ndarray, num_speakers: int = 0, threshold: float = 0.65,
            progress=None) -> list[tuple[float, float, int]]:
    """Return speaker turns [(start, end, speaker)] with speakers numbered by first appearance."""
    if len(audio) < SR * 2:
        return [(0.0, len(audio) / SR, 0)]
    d = _diarizer(num_speakers, threshold)

    def cb(done, total):
        if progress and total:
            progress(done / total)
        return 0

    res = d.process(audio, callback=cb).sort_by_start_time()
    turns = [(float(r.start), float(r.end), int(r.speaker)) for r in res]
    return _tidy(turns, forced=num_speakers > 0)


def _tidy(turns, forced: bool):
    if not turns:
        return turns
    talk = defaultdict(float)
    for s, e, k in turns:
        talk[k] += e - s
    total = sum(talk.values()) or 1.0
    # Clusters with almost no speech are usually a voice caught on a cough or
    # overlap; fold them into the neighbouring speaker (unless count was fixed).
    if not forced and len(talk) > 1:
        tiny = {k for k, v in talk.items() if v < 1.0 or (total > 120 and v / total < 0.015)}
        if tiny and len(tiny) < len(talk):
            fixed = []
            for i, (s, e, k) in enumerate(turns):
                if k in tiny:
                    k = _neighbour(turns, i, tiny)
                fixed.append((s, e, k))
            turns = fixed
    order: dict[int, int] = {}
    for _, _, k in turns:
        order.setdefault(k, len(order))
    return [(s, e, order[k]) for s, e, k in turns]


def _neighbour(turns, i, tiny):
    s, e, _ = turns[i]
    best, dist = None, 1e9
    for j, (s2, e2, k2) in enumerate(turns):
        if k2 in tiny or j == i:
            continue
        d = max(0.0, s - e2, s2 - e)
        if d < dist:
            best, dist = k2, d
    return best if best is not None else turns[i][2]


def _speaker_at(turns, s: float, e: float) -> int:
    best, best_ov = None, 0.0
    for ts, te, k in turns:
        if te < s - 0.01:
            continue
        if ts > e + 0.01:
            break
        ov = min(e, te) - max(s, ts)
        if ov > best_ov:
            best, best_ov = k, ov
    if best is not None:
        return best
    mid = (s + e) / 2
    return min(turns, key=lambda t: min(abs(t[0] - mid), abs(t[1] - mid)))[2]


def assign(segments: list[dict], turns: list[tuple[float, float, int]]) -> list[dict]:
    """Attach a speaker to every transcript piece, splitting where the speaker changes."""
    if not turns:
        return [dict(s, speaker=0) for s in segments]
    out = []
    for seg in segments:
        words = seg.get("words") or []
        if len(words) < 2:
            out.append(dict(seg, speaker=_speaker_at(turns, seg["start"], seg["end"])))
            continue
        labels = [_speaker_at(turns, w["s"], max(w["e"], w["s"] + 0.05)) for w in words]
        labels = _smooth(labels)
        cur = [words[0]]
        cur_lab = labels[0]
        for w, lab in zip(words[1:], labels[1:]):
            if lab != cur_lab:
                out.append(_piece(cur, cur_lab))
                cur, cur_lab = [w], lab
            else:
                cur.append(w)
        out.append(_piece(cur, cur_lab))
    return out


def _smooth(labels: list[int], min_run: int = 3) -> list[int]:
    """Short runs (a word or two) between the same speaker are alignment noise."""
    if len(labels) < 3:
        return labels
    runs = []
    for lab in labels:
        if runs and runs[-1][0] == lab:
            runs[-1][1] += 1
        else:
            runs.append([lab, 1])
    changed = True
    while changed and len(runs) > 1:
        changed = False
        for i, (lab, n) in enumerate(runs):
            if n < min_run:
                left = runs[i - 1] if i > 0 else None
                right = runs[i + 1] if i + 1 < len(runs) else None
                tgt = max((r for r in (left, right) if r), key=lambda r: r[1])
                tgt[1] += n
                runs.pop(i)
                changed = True
                break
        merged = []
        for lab, n in runs:
            if merged and merged[-1][0] == lab:
                merged[-1][1] += n
            else:
                merged.append([lab, n])
        runs = merged
    out = []
    for lab, n in runs:
        out += [lab] * n
    return out


def _piece(words, speaker):
    return {"start": words[0]["s"], "end": words[-1]["e"], "speaker": speaker,
            "text": " ".join(w["w"] for w in words), "words": words}


def paragraphs(pieces: list[dict], max_gap: float = 2.5, max_len: float = 75.0) -> list[dict]:
    """Merge consecutive pieces by the same speaker into readable paragraphs."""
    out: list[dict] = []
    for p in sorted(pieces, key=lambda x: x["start"]):
        if (out and out[-1]["speaker"] == p["speaker"]
                and p["start"] - out[-1]["end"] <= max_gap
                and p["end"] - out[-1]["start"] <= max_len):
            last = out[-1]
            last["end"] = max(last["end"], p["end"])
            last["text"] = (last["text"] + " " + p["text"]).strip()
            last["words"] = last["words"] + (p.get("words") or [])
        else:
            out.append({"start": p["start"], "end": p["end"], "speaker": p["speaker"],
                        "text": p["text"], "words": list(p.get("words") or [])})
    return out


def renumber(paras: list[dict]) -> tuple[list[dict], int]:
    order: dict[int, int] = {}
    for p in paras:
        order.setdefault(p["speaker"], len(order))
    for p in paras:
        p["speaker"] = order[p["speaker"]]
    return paras, max(1, len(order))


def talk_time(paras: list[dict]) -> dict[int, float]:
    c: Counter = Counter()
    for p in paras:
        c[p["speaker"]] += p["end"] - p["start"]
    return dict(c)
