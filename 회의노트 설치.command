#!/bin/bash
# Finder에서 더블클릭하면 터미널에서 설치를 진행합니다.
cd "$(dirname "$0")"
bash scripts/install.sh
echo
read -n 1 -s -r -p "아무 키나 누르면 창을 닫습니다…"
