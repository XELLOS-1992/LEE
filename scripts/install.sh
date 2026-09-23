#!/bin/bash
# 회의노트 설치: Python 환경, 음성 모델, Mac 앱(~/Applications/회의노트.app)을 준비합니다.
# 다시 실행하면 업데이트합니다.  옵션: SKIP_WHISPER=1 (Whisper 1.6GB 미리 받기 생략)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bold() { printf "\033[1m%s\033[0m\n" "$*"; }

bold "회의노트 설치를 시작합니다"
echo "설치 위치: $ROOT"

# 1) uv: Python 설치·관리 도구 (시스템 Python을 건드리지 않습니다)
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
if ! command -v uv >/dev/null 2>&1; then
  bold "▸ uv 설치 중"
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

# 2) 전용 Python 3.12 가상환경 + 패키지
if [ ! -x "$ROOT/.venv/bin/python" ]; then
  bold "▸ Python 환경 만드는 중"
  uv venv --python 3.12 "$ROOT/.venv"
fi
bold "▸ 패키지 설치 중 (처음에는 몇 분 걸립니다)"
uv pip install --python "$ROOT/.venv/bin/python" -r "$ROOT/requirements.txt"

# 3) 음성 인식 · 화자 분리 모델 (약 200MB, GitHub에서 받음)
bold "▸ 음성 모델 받는 중"
if [ "${SKIP_WHISPER:-0}" = 1 ]; then
  "$ROOT/.venv/bin/python" -m meetnote --download-models
else
  "$ROOT/.venv/bin/python" -m meetnote --download-models --with-whisper
fi

# 4) Mac 앱 만들기
if [ "$(uname)" = "Darwin" ]; then
  bold "▸ 회의노트.app 만드는 중"
  bash "$ROOT/scripts/build_app.sh"
  bold "✓ 설치 완료 — Launchpad 또는 ~/Applications 에서 '회의노트'를 실행하세요."
  echo "  처음 녹음할 때 마이크 권한을 묻습니다. '허용'을 눌러 주세요."
  [ -n "${CI:-}" ] || open "$HOME/Applications/회의노트.app" || true
else
  bold "✓ 설치 완료 — 실행: $ROOT/.venv/bin/python -m meetnote"
fi
