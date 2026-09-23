"""Model registry and downloader.

The sherpa-onnx models come from GitHub releases; the MLX Whisper model comes
from Hugging Face and is fetched by mlx-whisper itself (we pre-fetch it so the
UI can show progress).
"""
from __future__ import annotations

import logging
import os
import shutil
import tarfile
import threading
from pathlib import Path

import httpx

from . import config

log = logging.getLogger("meetnote.models")

GH = "https://github.com/k2-fsa/sherpa-onnx/releases/download"

REGISTRY: dict[str, dict] = {
    "vad": {
        "name": "음성 구간 검출 (Silero VAD)",
        "url": f"{GH}/asr-models/silero_vad.onnx",
        "path": "silero_vad.onnx",
        "size": 643_854,
        "required": True,
    },
    "sensevoice": {
        "name": "SenseVoice 음성인식 (빠름 · 실시간 자막)",
        "url": f"{GH}/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2",
        "path": "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17",
        "size": 163_002_883,
        "required": True,
    },
    "diar-seg": {
        "name": "화자 분리 · 구간 모델 (pyannote 3.0)",
        "url": f"{GH}/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
        "path": "sherpa-onnx-pyannote-segmentation-3-0",
        "size": 6_958_444,
        "required": True,
    },
    "diar-emb": {
        "name": "화자 분리 · 목소리 특징 모델 (CAM++)",
        "url": f"{GH}/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
        "path": "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx",
        "size": 28_281_164,
        "required": True,
    },
}

MLX_REPOS = {
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3": "mlx-community/whisper-large-v3-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "small": "mlx-community/whisper-small-mlx",
}

_status: dict[str, dict] = {}
_lock = threading.Lock()


def path(key: str) -> Path:
    return config.MODELS_DIR / REGISTRY[key]["path"]


def installed(key: str) -> bool:
    p = path(key)
    return p.exists() and (p.is_file() or any(p.iterdir()))


def mlx_available() -> bool:
    if not config.IS_APPLE_SILICON:
        return False
    try:
        import mlx_whisper  # noqa: F401
        return True
    except Exception:
        return False


def faster_whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _hf_cached(repo: str) -> bool:
    try:
        from huggingface_hub import try_to_load_from_cache
        r = try_to_load_from_cache(repo, "config.json")
        return isinstance(r, str)
    except Exception:
        return False


def status() -> dict:
    items = []
    for key, m in REGISTRY.items():
        st = _status.get(key, {})
        items.append({
            "key": key, "name": m["name"], "size": m["size"], "required": m["required"],
            "installed": installed(key),
            "downloading": st.get("state") == "downloading",
            "progress": st.get("progress", 0.0),
            "error": st.get("error", ""),
        })
    s = config.load_settings()
    repo = MLX_REPOS.get(s["whisper_model"], MLX_REPOS["large-v3-turbo"])
    mst = _status.get("whisper-mlx", {})
    return {
        "models": items,
        "mlx": {
            "supported": config.IS_APPLE_SILICON,
            "available": mlx_available(),
            "repo": repo,
            "installed": _hf_cached(repo) if mlx_available() else False,
            "downloading": mst.get("state") == "downloading",
            "progress": mst.get("progress", 0.0),
            "error": mst.get("error", ""),
        },
        "faster_whisper": faster_whisper_available(),
        "dir": str(config.MODELS_DIR),
    }


def _set(key: str, **kw) -> None:
    with _lock:
        _status.setdefault(key, {}).update(kw)


def download(key: str, block: bool = False) -> None:
    if key == "whisper-mlx":
        t = threading.Thread(target=_download_mlx, daemon=True)
    else:
        if key not in REGISTRY:
            raise KeyError(key)
        if _status.get(key, {}).get("state") == "downloading":
            return
        t = threading.Thread(target=_download, args=(key,), daemon=True)
    _set(key, state="downloading", progress=0.0, error="")
    t.start()
    if block:
        t.join()


def ensure_required(block: bool = True) -> None:
    for key, m in REGISTRY.items():
        if m["required"] and not installed(key):
            download(key, block=block)


def _download(key: str) -> None:
    m = REGISTRY[key]
    url = m["url"]
    dest_dir = config.MODELS_DIR
    tmp = dest_dir / (Path(url).name + ".part")
    try:
        with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
            r.raise_for_status()
            total = int(r.headers.get("content-length") or m["size"])
            done = 0
            with open(tmp, "wb") as f:
                for chunk in r.iter_bytes(1 << 20):
                    f.write(chunk)
                    done += len(chunk)
                    _set(key, progress=min(0.99, done / total))
        if url.endswith(".tar.bz2"):
            with tarfile.open(tmp, "r:bz2") as tf:
                try:
                    tf.extractall(dest_dir, filter="data")
                except TypeError:  # Python < 3.12
                    tf.extractall(dest_dir)
            tmp.unlink()
            _prune(key)
        else:
            os.replace(tmp, dest_dir / m["path"])
        _set(key, state="done", progress=1.0)
        log.info("model %s ready", key)
    except Exception as e:  # network etc.
        log.exception("download %s failed", key)
        _set(key, state="error", error=str(e))
        tmp.unlink(missing_ok=True)


def _prune(key: str) -> None:
    """Drop files we never load (test wavs, fp32 duplicates) to save disk."""
    p = path(key)
    shutil.rmtree(p / "test_wavs", ignore_errors=True)
    for extra in ("export-onnx.py",):
        (p / extra).unlink(missing_ok=True)


def _download_mlx() -> None:
    s = config.load_settings()
    repo = MLX_REPOS.get(s["whisper_model"], MLX_REPOS["large-v3-turbo"])
    try:
        from huggingface_hub import snapshot_download
        stop = threading.Event()

        def watch():
            # huggingface_hub has no simple progress hook; estimate from cache size.
            expected = 1.6e9 if "large" in repo else 5e8
            from huggingface_hub.constants import HF_HUB_CACHE
            d = Path(HF_HUB_CACHE) / ("models--" + repo.replace("/", "--"))
            while not stop.wait(1.0):
                size = sum(f.stat().st_size for f in d.rglob("*") if f.is_file()) if d.exists() else 0
                _set("whisper-mlx", progress=min(0.99, size / expected))

        w = threading.Thread(target=watch, daemon=True)
        w.start()
        snapshot_download(repo)
        stop.set()
        _set("whisper-mlx", state="done", progress=1.0)
    except Exception as e:
        log.exception("mlx download failed")
        _set("whisper-mlx", state="error", error=str(e))
