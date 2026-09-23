"""Audio decoding, encoding and waveform peaks (PyAV bundles FFmpeg, no brew needed)."""
from __future__ import annotations

from pathlib import Path

import av
import numpy as np

SR = 16000

# Formats the app's web view can play directly (WebKit and Chromium both).
PLAYABLE = {".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
            ".mp4": "video/mp4", ".mov": "video/quicktime"}


def decode(path: str | Path, sr: int = SR) -> np.ndarray:
    """Decode any audio/video file to mono float32 at `sr`."""
    chunks = []
    with av.open(str(path)) as container:
        stream = next((s for s in container.streams if s.type == "audio"), None)
        if stream is None:
            raise ValueError("오디오 트랙이 없는 파일입니다.")
        resampler = av.AudioResampler(format="flt", layout="mono", rate=sr)
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray().reshape(-1))
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray().reshape(-1))
    if not chunks:
        return np.zeros(0, dtype=np.float32)
    return np.concatenate(chunks).astype(np.float32)


def probe_duration(path: str | Path) -> float:
    try:
        with av.open(str(path)) as c:
            if c.duration:
                return c.duration / 1_000_000
    except Exception:
        pass
    return 0.0


def encode_m4a(samples: np.ndarray, out_path: str | Path, sr: int = SR, bitrate: int = 64000) -> None:
    """Encode mono float32 samples to AAC in an .m4a container."""
    samples = np.clip(samples, -1.0, 1.0).astype(np.float32)
    with av.open(str(out_path), "w", format="mp4") as container:
        stream = container.add_stream("aac", rate=sr)
        stream.bit_rate = bitrate
        try:
            stream.layout = "mono"
        except Exception:
            pass
        frame_size = 1024
        pts = 0
        for i in range(0, len(samples), frame_size):
            chunk = samples[i:i + frame_size]
            frame = av.AudioFrame.from_ndarray(chunk.reshape(1, -1), format="flt", layout="mono")
            frame.sample_rate = sr
            frame.pts = pts
            pts += len(chunk)
            for packet in stream.encode(frame):
                container.mux(packet)
        for packet in stream.encode(None):
            container.mux(packet)


def peaks(samples: np.ndarray, n: int = 1200) -> list[float]:
    """Normalised peak envelope for drawing the waveform."""
    if len(samples) == 0:
        return []
    n = max(1, min(n, len(samples)))
    usable = len(samples) - len(samples) % n
    blocks = np.abs(samples[:usable]).reshape(n, -1)
    p = np.sqrt((blocks ** 2).mean(axis=1))  # RMS reads better than raw max
    top = float(np.percentile(p, 99)) or 1.0
    return [round(float(min(1.0, v / top)), 3) for v in p]


def pcm16_to_float(b: bytes) -> np.ndarray:
    return np.frombuffer(b, dtype="<i2").astype(np.float32) / 32768.0
