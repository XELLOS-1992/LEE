"""Shared pieces for speech recognition engines.

Every engine returns a list of segments:
  {"start": float, "end": float, "text": str, "words": [{"w": str, "s": float, "e": float}]}
Times are seconds from the start of the recording.
"""
from __future__ import annotations

import re
from typing import Callable, Iterable

import numpy as np

from .. import models

SR = 16000
Progress = Callable[[float], None]

# Phrases Whisper tends to invent on silence or music (Korean YouTube subtitles).
HALLUCINATIONS = [
    "시청해 주셔서 감사합니다", "시청해주셔서 감사합니다", "구독과 좋아요", "구독 좋아요",
    "좋아요와 구독", "MBC 뉴스", "KBS 뉴스", "SBS 뉴스", "자막 제공", "자막 by", "한글자막",
    "다음 영상에서 만나요", "Thanks for watching", "thank you for watching", "Subtitles by",
    "ご視聴ありがとうございました", "请不吝点赞",
]


def vad_regions(audio: np.ndarray, min_silence: float = 0.4, max_speech: float = 20.0,
                threshold: float = 0.45) -> list[tuple[float, float]]:
    """Speech regions (seconds) found by Silero VAD."""
    import sherpa_onnx

    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(models.path("vad"))
    cfg.silero_vad.threshold = threshold
    cfg.silero_vad.min_silence_duration = min_silence
    cfg.silero_vad.min_speech_duration = 0.2
    cfg.silero_vad.max_speech_duration = max_speech
    cfg.sample_rate = SR
    cfg.num_threads = 1
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=max(60, int(len(audio) / SR) + 10))
    out: list[tuple[float, float]] = []

    def drain():
        while not vad.empty():
            seg = vad.front
            s = seg.start / SR
            out.append((s, s + len(seg.samples) / SR))
            vad.pop()

    win = 512
    for i in range(0, len(audio), win * 200):
        block = audio[i:i + win * 200]
        for j in range(0, len(block), win):
            vad.accept_waveform(block[j:j + win])
        drain()
    vad.flush()
    drain()
    return out


def windows(regions: list[tuple[float, float]], total: float, max_len: float = 28.0,
            max_gap: float = 1.5, pad: float = 0.25) -> list[tuple[float, float]]:
    """Group VAD regions into windows of at most `max_len` seconds.

    Regions closer than `max_gap` are merged (gaps measured before padding);
    long silences between windows are skipped, which is what stops Whisper
    from hallucinating on quiet stretches. Padding never crosses into the
    neighbouring window.
    """
    groups: list[list[float]] = []
    for s, e in regions:
        if groups and (s - groups[-1][1] <= max_gap) and (e - groups[-1][0] <= max_len):
            groups[-1][1] = max(groups[-1][1], e)
        else:
            groups.append([s, e])
    out = []
    for i, (s, e) in enumerate(groups):
        lo = (groups[i - 1][1] + s) / 2 if i else 0.0
        hi = (e + groups[i + 1][0]) / 2 if i + 1 < len(groups) else total
        s, e = max(lo, s - pad), min(hi, e + pad)
        # A single region can exceed max_len when VAD never saw a pause.
        while e - s > max_len + 0.5:
            out.append((s, s + max_len))
            s += max_len
        out.append((s, e))
    return out


def clean_text(text: str) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    text = _collapse_repeats(text)
    return text


def _collapse_repeats(text: str) -> str:
    """'네 네 네 네 네 네' -> '네 네', and looping phrases -> one copy."""
    words = text.split(" ")
    if len(words) < 6:
        return text
    for n in range(1, 8):
        i, out = 0, []
        while i < len(words):
            gram = words[i:i + n]
            reps = 1
            while words[i + reps * n:i + (reps + 1) * n] == gram and len(gram) == n:
                reps += 1
            keep = 2 if n == 1 else 1
            if reps >= 3:
                out.extend(gram * keep)
                i += reps * n
            else:
                out.append(words[i])
                i += 1
        words = out
    return " ".join(words)


def is_hallucination(text: str) -> bool:
    t = text.strip().strip(".!?,~ ")
    if not t:
        return True
    low = t.lower()
    return any(h.lower() in low for h in HALLUCINATIONS) and len(t) < 40


def words_from_tokens(tokens: Iterable[str], stamps: Iterable[float], offset: float,
                      end: float) -> list[dict]:
    """Join sub-word tokens (a leading space starts a new word) into timed words."""
    words: list[dict] = []
    tokens, stamps = list(tokens), list(stamps)
    new_word = True
    for tok, ts in zip(tokens, stamps):
        t = offset + float(ts)
        if not tok.strip():
            new_word = True  # a bare space token separates words
            continue
        if tok.startswith(" ") or tok.startswith("▁") or new_word or not words:
            words.append({"w": tok.replace("▁", " ").strip(), "s": round(t, 2), "e": round(t, 2)})
        else:
            words[-1]["w"] += tok
        new_word = False
    for i, w in enumerate(words):
        nxt = words[i + 1]["s"] if i + 1 < len(words) else end
        w["e"] = round(max(w["s"] + 0.05, min(nxt, w["s"] + 2.0)), 2)
    return words


def align_words(text: str, tokens, stamps, offset: float, end: float) -> list[dict]:
    """Time the words of the model's formatted text using its token timestamps.

    The formatted text has proper spacing and punctuation; tokens carry the
    timing. Match them character by character (spaces ignored). If the text
    was rewritten (e.g. number normalisation) fall back to proportional timing
    for the part that no longer lines up.
    """
    chars: list[tuple[str, float]] = []
    for tok, ts in zip(tokens, stamps):
        for ch in tok.replace("▁", "").strip():
            chars.append((ch, offset + float(ts)))
    words = text.split()
    if not words:
        return []
    out: list[dict] = []
    ci = 0
    for w in words:
        start = None
        for ch in w:
            # advance to the next matching char (skips tokens ITN rewrote)
            j = ci
            while j < len(chars) and j - ci < 4 and chars[j][0] != ch:
                j += 1
            if j < len(chars) and chars[j][0] == ch:
                if start is None:
                    start = chars[j][1]
                ci = j + 1
        out.append({"w": w, "s": start})
    # fill gaps by interpolation, then derive ends
    known = [i for i, w in enumerate(out) if w["s"] is not None]
    if not known:
        return estimate_words(text, offset, end)
    for i, w in enumerate(out):
        if w["s"] is None:
            prev = max((k for k in known if k < i), default=None)
            nxt = min((k for k in known if k > i), default=None)
            a = out[prev]["s"] if prev is not None else offset
            b = out[nxt]["s"] if nxt is not None else end
            lo = prev if prev is not None else -1
            hi = nxt if nxt is not None else len(out)
            w["s"] = a + (b - a) * (i - lo) / max(1, hi - lo)
    for i, w in enumerate(out):
        s = round(max(offset, w["s"]), 2)
        nxt = out[i + 1]["s"] if i + 1 < len(out) else end
        w["s"] = s
        w["e"] = round(max(s + 0.05, min(nxt, s + 2.0)), 2)
    return out


def estimate_words(text: str, start: float, end: float) -> list[dict]:
    """Spread words over [start, end] by length when an engine gives no word times."""
    parts = text.split()
    if not parts:
        return []
    weights = [len(p) + 1 for p in parts]
    total = float(sum(weights))
    out, t = [], start
    for p, w in zip(parts, weights):
        d = (end - start) * w / total
        out.append({"w": p, "s": round(t, 2), "e": round(t + d, 2)})
        t += d
    return out


SENT_END = re.compile(r"[.?!。？！]$")


def split_sentences(seg: dict, max_len: float = 30.0) -> list[dict]:
    """Break a segment into sentence-sized pieces using its word times."""
    words = seg.get("words") or []
    if len(words) < 2:
        return [seg]
    out, cur = [], []
    for i, w in enumerate(words):
        cur.append(w)
        long_enough = cur[-1]["e"] - cur[0]["s"] >= max_len
        if SENT_END.search(w["w"]) or long_enough or i == len(words) - 1:
            out.append({
                "start": cur[0]["s"], "end": cur[-1]["e"],
                "text": " ".join(x["w"] for x in cur), "words": cur,
            })
            cur = []
    return out


class Engine:
    name = "base"
    label = ""

    def transcribe(self, audio: np.ndarray, language: str = "ko", hint: str = "",
                   progress: Progress | None = None) -> list[dict]:
        raise NotImplementedError
