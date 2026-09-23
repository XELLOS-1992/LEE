"""Speech recognition engine selection."""
from __future__ import annotations

from .. import config, models
from .base import Engine


def available() -> list[dict]:
    return [
        {"key": "whisper-mlx", "label": "Whisper large-v3-turbo · Apple GPU (MLX)",
         "desc": "Apple Silicon에서 가장 정확하고 빠름. 첫 사용 시 약 1.6GB 다운로드",
         "ok": models.mlx_available()},
        {"key": "sensevoice", "label": "SenseVoice · 초고속",
         "desc": "1시간 녹음을 1~2분에 변환. 한국어·영어·일본어·중국어",
         "ok": models.installed("sensevoice")},
        {"key": "faster-whisper", "label": "faster-whisper · CPU",
         "desc": "Intel Mac 대안 (pip install faster-whisper 필요)",
         "ok": models.faster_whisper_available()},
    ]


def resolve(name: str | None = None) -> str:
    name = name or config.load_settings()["asr_engine"]
    ok = {e["key"]: e["ok"] for e in available()}
    if name != "auto" and ok.get(name):
        return name
    for cand in ("whisper-mlx", "sensevoice"):
        if ok.get(cand):
            return cand
    return "sensevoice"


def get(name: str | None = None) -> Engine:
    key = resolve(name)
    if key == "whisper-mlx":
        from .whisper import WhisperMLXEngine
        return WhisperMLXEngine()
    if key == "faster-whisper":
        from .whisper import FasterWhisperEngine
        return FasterWhisperEngine()
    from .sherpa import SenseVoiceEngine
    return SenseVoiceEngine()
