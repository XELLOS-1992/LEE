"""Start MeetNote: `python -m meetnote [--no-window] [--port N]`.

The Mac app (scripts/build_app.sh) runs this with --no-window and shows the UI
in its own window. Run directly, it opens the UI in a Chromium app window if
one is installed, otherwise in the default browser.
"""
from __future__ import annotations

import argparse
import logging
import os
import socket
import subprocess
import sys
import threading
import time
import webbrowser

import httpx

from . import config

DEFAULT_PORT = 8765


def _running(port: int) -> bool:
    try:
        r = httpx.get(f"http://127.0.0.1:{port}/api/state", timeout=1.0)
        return r.status_code == 200 and "version" in r.json()
    except Exception:
        return False


def _port_free(port: int) -> bool:
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def _serve(port: int) -> None:
    import uvicorn

    from .server import app

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


def _wait_up(port: int, timeout: float = 30) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if _running(port):
            return True
        time.sleep(0.2)
    return False


def _chrome_app(url: str) -> bool:
    """Open in a Chromium browser's app mode: no tabs or address bar, own window."""
    if sys.platform != "darwin":
        return False
    for app in ("Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium", "Arc"):
        if os.path.exists(f"/Applications/{app}.app") or os.path.exists(os.path.expanduser(f"~/Applications/{app}.app")):
            profile = config.HOME / "browser-profile"
            subprocess.Popen(["open", "-na", app, "--args", f"--app={url}", f"--user-data-dir={profile}",
                              "--no-first-run", "--window-size=1440,920"])
            return True
    return False


def main() -> None:
    ap = argparse.ArgumentParser(prog="meetnote")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MEETNOTE_PORT", DEFAULT_PORT)))
    ap.add_argument("--browser", action="store_true", help="open in the default browser, not a Chromium app window")
    ap.add_argument("--no-window", action="store_true", help="run the server only")
    ap.add_argument("--download-models", action="store_true", help="download required models and exit")
    ap.add_argument("--with-whisper", action="store_true", help="with --download-models: also fetch the MLX Whisper model")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s",
                        handlers=[logging.FileHandler(config.LOG_PATH, encoding="utf-8"), logging.StreamHandler()])

    if args.download_models:
        from . import models
        for key, m in models.REGISTRY.items():
            if m["required"] and not models.installed(key):
                print(f"다운로드: {m['name']} ({m['size'] / 1e6:.0f}MB)")
                models.download(key, block=True)
                print("  완료" if models.installed(key) else "  실패")
        if args.with_whisper and models.mlx_available():
            st = models.status()["mlx"]
            if not st["installed"]:
                print(f"다운로드: Whisper ({st['repo']}, 약 1.6GB) — Apple GPU 고정확도 인식")
                models.download("whisper-mlx", block=True)
                print("  완료" if models.status()["mlx"]["installed"] else "  실패 (첫 변환 때 다시 시도합니다)")
        return

    port = args.port
    url = f"http://127.0.0.1:{port}/"
    already = _running(port)
    if not already:
        if not _port_free(port):
            if args.no_window:  # the Mac app expects this exact port
                print(f"포트 {port}를 다른 프로그램이 쓰고 있습니다.")
                sys.exit(2)
            port = next(p for p in range(port + 1, port + 50) if _port_free(p))
            url = f"http://127.0.0.1:{port}/"
        threading.Thread(target=_serve, args=(port,), daemon=True).start()
        if not _wait_up(port):
            print("서버를 시작하지 못했습니다. 로그:", config.LOG_PATH)
            sys.exit(1)

    if args.no_window:
        print(f"MeetNote 실행 중: {url}")
        if not already:
            threading.Event().wait()
        return

    if args.browser or not _chrome_app(url):
        webbrowser.open(url)
    if not already:
        print(f"MeetNote 실행 중: {url}  (종료: 앱 메뉴 > 종료 또는 Ctrl+C)")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
