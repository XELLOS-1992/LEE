"""sherpa-onnx SenseVoice engine (fast, word times) and the live transcriber."""
from __future__ import annotations

import os
import threading

import numpy as np

from .. import korean, models
from .base import (SR, Engine, align_words, clean_text, is_hallucination, split_sentences,
                   vad_regions, windows)

THREADS = max(1, min(8, (os.cpu_count() or 4)))
_cache: dict[str, object] = {}
_cache_lock = threading.Lock()

SV_LANGS = {"ko", "en", "ja", "zh", "yue", "auto"}


def sensevoice_recognizer(language: str = "ko"):
    import sherpa_onnx

    lang = language if language in SV_LANGS else "auto"
    key = f"sv:{lang}"
    with _cache_lock:
        if key not in _cache:
            d = models.path("sensevoice")
            _cache[key] = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=str(d / "model.int8.onnx"), tokens=str(d / "tokens.txt"),
                language=lang, use_itn=True, num_threads=THREADS,
            )
        return _cache[key]


class SenseVoiceEngine(Engine):
    name = "sensevoice"
    label = "SenseVoice"

    def transcribe(self, audio, language="ko", hint="", progress=None):
        rec = sensevoice_recognizer(language)
        total = len(audio) / SR
        # SenseVoice is trained on short utterances: feed each VAD region on its own.
        wins = windows(vad_regions(audio, min_silence=0.3, max_speech=20.0, threshold=0.5), total, max_len=20.0, max_gap=0.0, pad=0.15)
        out: list[dict] = []
        batch = 8
        for b in range(0, len(wins), batch):
            group = wins[b:b + batch]
            streams = []
            for s, e in group:
                st = rec.create_stream()
                st.accept_waveform(SR, audio[int(s * SR):int(e * SR)])
                streams.append(st)
            rec.decode_streams(streams)
            for (s, e), st in zip(group, streams):
                r = st.result
                text = korean.punctuate(korean.fix_spacing(clean_text(r.text)))
                if not text or is_hallucination(text):
                    continue
                words = align_words(text, r.tokens, r.timestamps, s, e)
                seg = {"start": round(s, 2), "end": round(e, 2), "text": text, "words": words}
                if words:
                    seg["start"], seg["end"] = words[0]["s"], words[-1]["e"]
                out.extend(split_sentences(seg))
            if progress:
                progress(min(1.0, (b + len(group)) / max(1, len(wins))))
        return out


class LiveTranscriber:
    """Streams PCM from the recorder, emits text for each finished utterance.

    Runs VAD on the incoming audio; every time a pause closes an utterance the
    utterance goes through SenseVoice, which takes ~50 ms per sentence.
    """

    def __init__(self, language: str = "ko", on_text=None):
        import sherpa_onnx

        self.on_text = on_text
        self.rec = sensevoice_recognizer(language)
        cfg = sherpa_onnx.VadModelConfig()
        cfg.silero_vad.model = str(models.path("vad"))
        cfg.silero_vad.min_silence_duration = 0.35
        cfg.silero_vad.max_speech_duration = 12.0
        cfg.sample_rate = SR
        self.vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=60)
        self.offset = 0  # samples fed so far
        self.buf = np.zeros(0, dtype=np.float32)
        self.lock = threading.Lock()

    def feed(self, samples: np.ndarray, time_base: float = 0.0) -> None:
        with self.lock:
            self.buf = np.concatenate([self.buf, samples])
            while len(self.buf) >= 512:
                self.vad.accept_waveform(self.buf[:512])
                self.buf = self.buf[512:]
            self._drain(time_base)

    def flush(self, time_base: float = 0.0) -> None:
        with self.lock:
            self.vad.flush()
            self._drain(time_base)

    def _drain(self, time_base: float) -> None:
        while not self.vad.empty():
            seg = self.vad.front
            samples = np.array(seg.samples, dtype=np.float32)
            start = time_base + seg.start / SR
            self.vad.pop()
            st = self.rec.create_stream()
            st.accept_waveform(SR, samples)
            self.rec.decode_stream(st)
            text = korean.punctuate(korean.fix_spacing(clean_text(st.result.text)))
            if text and not is_hallucination(text) and self.on_text:
                self.on_text({"start": round(start, 2), "end": round(start + len(samples) / SR, 2),
                              "text": text})
