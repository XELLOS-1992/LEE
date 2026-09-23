"""Whisper engines backed by MLX (Apple Silicon GPU) or faster-whisper (CPU)."""
from __future__ import annotations

import threading

from .. import config, models
from .base import SR, Engine, clean_text, is_hallucination, split_sentences, vad_regions, windows

_lock = threading.Lock()
_fw_model = None
_fw_name = ""


def _segments_from_whisper(raw_segments, offset: float, win_end: float) -> list[dict]:
    out = []
    for seg in raw_segments:
        get = seg.get if isinstance(seg, dict) else (lambda k, d=None, s=seg: getattr(s, k, d))
        text = clean_text(get("text", ""))
        if not text or is_hallucination(text):
            continue
        if get("no_speech_prob", 0) > 0.8 and get("avg_logprob", 0) < -1.0:
            continue
        words = []
        for w in get("words", None) or []:
            wg = w.get if isinstance(w, dict) else (lambda k, d=None, x=w: getattr(x, k, d))
            token = (wg("word", "") or "").strip()
            if token:
                words.append({"w": token, "s": round(offset + float(wg("start", 0)), 2),
                              "e": round(offset + float(wg("end", 0)), 2)})
        s = round(offset + float(get("start", 0)), 2)
        e = round(min(win_end, offset + float(get("end", 0))), 2)
        item = {"start": s, "end": max(e, s + 0.1), "text": text, "words": words}
        if words:
            item["text"] = " ".join(w["w"] for w in words)
        out.extend(split_sentences(item))
    return out


def _prompt(hint: str, language: str, previous: str = "") -> str | None:
    # A short in-language prompt nudges Whisper toward punctuated, formal
    # transcripts; user keywords help it spell names and jargon.
    base = {"ko": "다음은 회의 녹음입니다.", "en": "The following is a meeting recording.",
            "ja": "以下は会議の録音です。"}.get(language, "")
    hint = (hint or "").strip()
    if hint:
        base = f"{base} 주요 용어: {hint}." if language == "ko" else f"{base} Terms: {hint}."
    # The end of the previous window keeps names, terms and style consistent
    # across the 30-second chunks Whisper works in.
    if previous:
        base = f"{base} {previous[-160:]}".strip()
    return base or None


class WhisperMLXEngine(Engine):
    name = "whisper-mlx"

    @property
    def label(self):
        return f"Whisper {config.load_settings()['whisper_model']} (MLX · Apple GPU)"

    def transcribe(self, audio, language="ko", hint="", progress=None):
        import mlx_whisper

        repo = models.MLX_REPOS.get(config.load_settings()["whisper_model"], models.MLX_REPOS["large-v3-turbo"])
        total = len(audio) / SR
        wins = windows(vad_regions(audio, max_speech=28.0), total, max_len=28.0, max_gap=1.5)
        out = []
        prev = ""
        for i, (s, e) in enumerate(wins):
            chunk = audio[int(s * SR):int(e * SR)]
            with _lock:
                res = mlx_whisper.transcribe(
                    chunk, path_or_hf_repo=repo,
                    language=None if language == "auto" else language,
                    word_timestamps=True, condition_on_previous_text=False,
                    initial_prompt=_prompt(hint, language, prev), verbose=None,
                )
            segs = _segments_from_whisper(res.get("segments", []), s, e)
            out.extend(segs)
            prev = " ".join(x["text"] for x in segs) if segs else ""
            # After a long pause the topic may have changed; start fresh.
            if i + 1 < len(wins) and wins[i + 1][0] - e > 8.0:
                prev = ""
            if progress:
                progress((i + 1) / max(1, len(wins)))
        return out


class FasterWhisperEngine(Engine):
    name = "faster-whisper"
    label = "faster-whisper (CPU)"

    def _model(self):
        global _fw_model, _fw_name
        from faster_whisper import WhisperModel

        name = config.load_settings()["whisper_model"]
        with _lock:
            if _fw_model is None or _fw_name != name:
                _fw_model = WhisperModel(name, device="auto", compute_type="int8")
                _fw_name = name
        return _fw_model

    def transcribe(self, audio, language="ko", hint="", progress=None):
        model = self._model()
        total = len(audio) / SR
        wins = windows(vad_regions(audio, max_speech=28.0), total, max_len=28.0, max_gap=1.5)
        out = []
        prev = ""
        for i, (s, e) in enumerate(wins):
            chunk = audio[int(s * SR):int(e * SR)]
            segs, _info = model.transcribe(
                chunk, language=None if language == "auto" else language, beam_size=5,
                word_timestamps=True, condition_on_previous_text=False,
                initial_prompt=_prompt(hint, language, prev), vad_filter=False,
            )
            got = _segments_from_whisper(list(segs), s, e)
            out.extend(got)
            prev = " ".join(x["text"] for x in got) if got else ""
            if progress:
                progress((i + 1) / max(1, len(wins)))
        return out
