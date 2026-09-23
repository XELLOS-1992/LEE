"""Paths and user settings.

All data lives in one folder so it is easy to back up or move:
  macOS:  ~/Library/Application Support/MeetNote
  other:  ~/.meetnote
Set MEETNOTE_HOME to override (the tests do this).
"""
from __future__ import annotations

import json
import os
import platform
import sys
import threading
from pathlib import Path

APP_NAME = "MeetNote"
APP_NAME_KO = "회의노트"
VERSION = "1.0.0"


def _default_home() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APP_NAME
    return Path.home() / ".meetnote"


HOME = Path(os.environ.get("MEETNOTE_HOME") or _default_home()).expanduser()
AUDIO_DIR = HOME / "audio"
MODELS_DIR = Path(os.environ.get("MEETNOTE_MODELS") or (HOME / "models")).expanduser()
DB_PATH = HOME / "meetnote.db"
SETTINGS_PATH = HOME / "settings.json"
LOG_PATH = HOME / "meetnote.log"

for _d in (HOME, AUDIO_DIR, MODELS_DIR):
    _d.mkdir(parents=True, exist_ok=True)

IS_APPLE_SILICON = sys.platform == "darwin" and platform.machine() == "arm64"

DEFAULTS: dict = {
    # speech recognition
    "asr_engine": "auto",            # auto | whisper-mlx | faster-whisper | sensevoice
    "whisper_model": "large-v3-turbo",
    "language": "ko",                # ko | en | ja | zh | auto
    "live_transcription": True,      # show text while recording (SenseVoice)
    # speaker separation
    "diarization": True,
    "diarization_threshold": 0.65,
    # AI summary
    "llm_provider": "auto",          # auto | claude | ollama | local
    "claude_model": "claude-opus-5",
    "anthropic_api_key": "",
    "ollama_url": "http://localhost:11434",
    "ollama_model": "exaone3.5:7.8b",
    "auto_summary": True,
    # app
    "theme": "system",               # system | light | dark
    "skip_seconds": 5,
    "keep_recording_wav": False,
}

_lock = threading.Lock()


def load_settings() -> dict:
    data = dict(DEFAULTS)
    if SETTINGS_PATH.exists():
        try:
            data.update(json.loads(SETTINGS_PATH.read_text("utf-8")))
        except (OSError, ValueError):
            pass
    return data


def save_settings(patch: dict) -> dict:
    with _lock:
        data = load_settings()
        for k, v in patch.items():
            if k in DEFAULTS:
                data[k] = v
        SETTINGS_PATH.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
        try:
            os.chmod(SETTINGS_PATH, 0o600)  # holds the API key
        except OSError:
            pass
        return data


def public_settings() -> dict:
    """Settings safe to send to the UI (API key masked)."""
    s = load_settings()
    key = s.get("anthropic_api_key") or ""
    s["anthropic_api_key"] = ""
    s["anthropic_api_key_set"] = bool(key or os.environ.get("ANTHROPIC_API_KEY"))
    s["anthropic_api_key_hint"] = f"…{key[-4:]}" if len(key) > 8 else ""
    return s
