#!/usr/bin/env bash
# 자가 보완 루프: 에이전트 실행 → 외부 심판 검증 → 실패 로그를 다음 반복에 주입 → 통과할 때까지 반복.
#
# 사용법:  harness/run-until-done.sh [최대반복수=30]
# 환경변수: CLAUDE_BIN (기본 claude)
#          CLAUDE_FLAGS (기본: --permission-mode bypassPermissions — 반드시 격리된 컨테이너/VM에서만 실행)
#          REQUIRED_STREAK (연속 통과 횟수, 기본 2)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
MAX_ITER="${1:-30}"
CLAUDE_BIN="${CLAUDE_BIN:-claude}"
read -r -a FLAGS <<< "${CLAUDE_FLAGS:---permission-mode bypassPermissions}"
REQUIRED_STREAK="${REQUIRED_STREAK:-2}"
PROMPT_FILE="$ROOT/prompts/baram-master-prompt.md"
LOG_DIR="$ROOT/harness/logs"
mkdir -p "$LOG_DIR"

# 에이전트가 harness/ 를 건드렸는지 감지하기 위한 지문 (심판 무결성)
harness_hash() { sha256sum "$ROOT/harness/judge.mjs" "$ROOT/harness/run-until-done.sh" | sha256sum | cut -d' ' -f1; }
BASELINE_HASH="$(harness_hash)"

stuck_sig=""
stuck_count=0

for ((i = 1; i <= MAX_ITER; i++)); do
  echo "================ 반복 $i / $MAX_ITER ================"

  feedback=""
  if [[ -f harness/last-judge.log ]]; then
    feedback+=$'\n\n## 직전 외부 심판 결과 (harness/last-judge.log)\n```\n'
    feedback+="$(tail -n 80 harness/last-judge.log)"
    feedback+=$'\n```\n'
  fi
  if (( stuck_count >= 3 )); then
    feedback+=$'\n\n## ⚠ 스턱 감지\n같은 실패 조합이 '"$stuck_count"$'회 연속 반복되었다. 지금까지의 접근을 버리고 6장 "막혔을 때의 규칙"에 따라 근본적으로 다른 방법을 택하라.\n'
  fi

  prompt="$(cat "$PROMPT_FILE")"
  prompt+=$'\n\n---\n# 하네스 정보\n- 현재 반복 번호: '"$i"$'\n- 이번 세션에서 가능한 한 많은 AC를 진행하되, 세션을 끝내기 전에 반드시 npm run verify 를 실행하고 PROGRESS.md 기록과 git commit 을 마쳐라.\n- 세션 종료 후 하네스가 node harness/judge.mjs 로 독립 검증한다. 너의 자기 보고보다 심판 결과가 우선한다.'
  prompt+="$feedback"

  "$CLAUDE_BIN" -p "$prompt" "${FLAGS[@]}" --output-format text > "$LOG_DIR/agent-$i.log" 2>&1
  echo "에이전트 종료 (코드 $?) — 로그: harness/logs/agent-$i.log"
  sed -n '/<<<STATUS/,/STATUS>>>/p' "$LOG_DIR/agent-$i.log" | tail -n 9

  # 심판 무결성 확인: 변조되었으면 git 으로 원복
  if [[ "$(harness_hash)" != "$BASELINE_HASH" ]]; then
    echo "⚠ 에이전트가 harness/ 를 수정함 → 원복"
    git checkout -- harness/judge.mjs harness/run-until-done.sh 2>/dev/null
    echo "- 반복 $i: 에이전트가 harness/ 를 수정하여 원복됨 (규칙 위반)" >> harness/violations.log
  fi

  node harness/judge.mjs > "$LOG_DIR/judge-$i.log" 2>&1
  judge=$?
  tail -n 1 "$LOG_DIR/judge-$i.log"

  if (( judge == 0 )); then
    stuck_count=0
    streak=1
    # 코드 변경 없이 재검증만 반복해 플레이키(비결정적) 통과를 배제
    while (( streak < REQUIRED_STREAK )); do
      node harness/judge.mjs > "$LOG_DIR/judge-$i-recheck$streak.log" 2>&1 || break
      streak=$((streak + 1))
    done
    echo "✅ 심판 통과 (연속 $streak / $REQUIRED_STREAK)"
    if (( streak >= REQUIRED_STREAK )) && [[ -f DONE ]]; then
      echo "🎉 완료: 심판 연속 ${streak}회 통과 + DONE 파일 확인"
      exit 0
    fi
    (( streak < REQUIRED_STREAK )) && echo "⚠ 재검증 실패 → 플레이키 테스트 존재. 다음 반복에서 수정"
    [[ -f DONE ]] || echo "ℹ 심판은 통과했지만 에이전트가 DONE 을 만들지 않음 → 다음 반복에서 마무리"
  else
    streak=0
    [[ -f DONE ]] && { echo "⚠ 심판 실패인데 DONE 파일이 있음 → 삭제"; rm -f DONE; }
    sig="$(grep '^FAIL' harness/last-judge.log | cut -c1-40 | sort | sha256sum | cut -c1-16)"
    if [[ "$sig" == "$stuck_sig" ]]; then stuck_count=$((stuck_count + 1)); else stuck_sig="$sig"; stuck_count=1; fi
    echo "❌ 심판 실패 (동일 실패 연속 $stuck_count 회)"
  fi
done

echo "최대 반복($MAX_ITER) 도달 — 미완료. harness/last-judge.log 와 PROGRESS.md 를 확인하세요."
exit 1
