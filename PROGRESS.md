# 진행 현황

실행 방식: 중첩 에이전트(`claude -p`, 권한 우회 모드)는 이 실행 환경의 안전 정책에서 차단되어,
이 세션의 에이전트가 마스터 프롬프트의 루프(테스트 먼저 → 구현 → verify → 자기 비판 → 외부 심판)를 직접 수행했다.
외부 심판 `harness/judge.mjs`는 수정하지 않았다(해시 확인).

## AC 현황

| AC | 상태 | 증거(테스트 파일:이름) |
|---|---|---|
| AC-01 | ✅ | tests/integration.test.ts: "AC-01 네 직업 모두 로그인하면 welcome 을 받는다" 외 2 |
| AC-02 | ✅ | tests/maps.test.ts: "AC-02 마을 1개와 사냥터 2개 이상, 각 40×40 이상" 외 3 |
| AC-03 | ✅ | tests/movement.test.ts: "AC-03 이동 속도 제한 …" 외 4 |
| AC-04 | ✅ | tests/maps.test.ts: "AC-04 마을 동문 포털을 밟으면 …" 외 2 |
| AC-05 | ✅ | tests/integration.test.ts: "AC-05 두 클라이언트가 서로의 위치를 1초 이내에 본다" 외 1 |
| AC-06 | ✅ | tests/integration.test.ts: "AC-06 같은 맵의 모두에게 전달되고 …" 외 1 |
| AC-07 | ✅ | tests/combat.test.ts: "AC-07 사냥터에만 몬스터가 스폰되고 4종 이상 …" 외 2 |
| AC-08 | ✅ | tests/combat.test.ts: "AC-08 데미지 공식(순수 함수) …" 외 4 |
| AC-09 | ✅ | tests/combat.test.ts: "AC-09 HP 0 → 사망 → 행동 불가 → …" 외 1 |
| AC-10 | ✅ | tests/progression.test.ts: "AC-10 경험치 테이블 …" 외 3 |
| AC-11 | ✅ | tests/progression.test.ts: "AC-11 주술사 화염구 …" 외 7 |
| AC-12 | ✅ | tests/items.test.ts: "AC-12 인벤토리 칸 수 제한 …" 외 7 |
| AC-13 | ✅ | tests/items.test.ts 5개 + e2e/game.spec.ts: "AC-13 주모에게 말을 걸어 물약을 산다 (UI)" |
| AC-14 | ✅ | tests/storage.test.ts 5개 + tests/integration.test.ts: "AC-14 재접속 시 …" |
| AC-15 | ✅ | tests/client.test.ts 4개 + e2e/game.spec.ts: "AC-15 캔버스에 맵·캐릭터 …" |
| AC-16 | ✅ | tests/client.test.ts 2개 + e2e/game.spec.ts: "AC-16 키보드 입력 …" |
| AC-17 | ✅ | tests/validate.test.ts 6개 + tests/integration.test.ts 3개 |
| AC-18 | ✅ | tests/perf.test.ts: 봇 50 + 몬스터 200, 틱 평균 약 0.55ms (기준 20ms) |
| AC-19 | ✅ | e2e/game.spec.ts: "AC-19 브라우저로 접속→이동→채팅→공격 …" (스크린샷 test-results/screens/) |
| AC-20 | ✅ | tests/docs.test.ts: README 섹션·키·스킬·맵 이름 일치 검사 |

## 결정 기록

- 기술 스택은 프롬프트 고정안 그대로: TypeScript strict, Node `http` + `ws`, Canvas 2D, esbuild, Vitest, Playwright, 파일 기반 JSON 저장.
- Playwright 는 설치된 Chromium(revision 1194)과 맞는 `@playwright/test` 1.56.1 로 고정 — 브라우저 다운로드 없음.
- 게임 제목 "풍운록", 지명은 졸본성·비류수·흑림 동굴(역사 지명 + 창작). 원작 리소스·명칭 미사용.
- 이동은 서버가 칸당 200ms 간격을 강제하고, 간격 내 입력은 마지막 방향 하나만 예약(과속 입력 무시).
- E2E 에서 공격을 검증하려고 `TEST_HOOKS=1` 일 때만 켜지는 `debug spawn` 명령을 두었다. 운영 모드에서 거부되는지 통합 테스트(AC-17)로 확인.
- 맵은 시드 고정 생성기로 만들고 JSON 으로 저장. 생성 결과와 저장 파일의 일치를 테스트(AC-02)로 강제.

## 반복 기록

### 반복 1 — 목표: 스캐폴딩, AC-17/01/02/03, 서버 전체
- 한 일: 공유 타입·밸런스·규칙·맵 생성기·검증기, World(이동·전투·AI·아이템·상점·스킬), 네트워크 서버, 저장소 구현.
- judge 결과(테스트 작성 전, 라이브 검사만): L1~L13 13/13 통과, S3·S5 실패(테스트 없음).
- 다음 반복 계획: AC별 테스트 작성.

### 반복 2 — 목표: AC-02~AC-13 단위 테스트
- verify 결과: 47개 중 2개 실패.
- 실패 원인 분석: ① `expToNext(10)` 기대값을 손으로 잘못 계산(15×10^1.8 = 946.4 → 946, 947로 적음) ② 들판에 9×9 빈 공간이 없어 테스트 배치 실패 → 마을 광장으로 배치.
- 자기 비판: "원거리 스킬은 벽을 넘지 못한다" 테스트가 벽 너머에 몬스터가 없어 구현이 틀려도 통과하는 약한 테스트였음 → 벽 너머에 실제 몬스터를 두도록 강화.

### 반복 3 — 목표: AC-01/05/06/14/17/18 통합·부하 테스트
- verify 결과: 76개 중 9개 실패.
- 실패 원인 분석: 테스트 정리 순서가 데이터 폴더 삭제 → 서버 종료여서, 종료 시 저장이 예외를 던짐. 동시에 실제 결함 2건 발견:
  서버 `close()`/연결 종료 시 저장 실패가 예외로 전파됨, 서버를 닫은 뒤 늦게 도착한 close 이벤트가 한 번 더 저장을 시도함.
- 수정: 정리 순서 교정, `safeSave` 로 저장 실패를 로그로 격리, `close()` 에서 세션을 먼저 분리(저장+제거) 후 종료.

### 반복 4 — 목표: AC-15/16/19 E2E, AC-20 문서, verify 파이프라인
- 한 일: Playwright E2E 4개(접속·이동·채팅·공격·픽셀 확인, 렌더 통계·카메라 추적, 키 입력, UI 상점 구매), README, verify.mjs.
- 스크린샷 검토에서 상태창 글자가 박스 밖으로 넘치는 것을 발견 → 상태창 폭 확대.
- verify 결과: typecheck ✅ lint ✅ build ✅ test 78/78 e2e 4/4 (합계 82/82), AC-01~AC-20 전부 pass.
- 뮤테이션 점검: 12가지 결함 주입(속도 제한 제거, 원거리 벽 무시, 방어력 무시, 리스폰 없음, 사망 패널티 없음, 공백 채팅 허용,
  상점 거리 무시, 인벤토리 제한 무시, 레벨업 성장 없음, 몬스터 칸 통과, 쿨다운 무시, 무기 공격력 미반영) → 12/12 테스트가 잡아냄.
- judge 결과: `npm ci` 포함 전체 모드 25/25 통과, 코드 변경 없이 재실행 25/25 통과 (연속 2회).
