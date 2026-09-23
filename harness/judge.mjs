#!/usr/bin/env node
// 외부 심판(Judge): 에이전트와 독립적으로 game/ 을 빌드·실행하고 프로토콜 계약으로 직접 접속해 검사한다.
// 에이전트는 이 파일을 수정하면 안 된다. 의존성 없이 Node 22 내장 기능(fetch, WebSocket)만 사용한다.
//
// 사용법: node harness/judge.mjs            (전체 검사)
// 환경변수: JUDGE_SKIP_INSTALL=1  npm 설치 생략
//           JUDGE_SKIP_VERIFY=1   npm run verify 생략 (심판 자체 점검용)
//           GAME_DIR=경로          검사 대상 (기본: <repo>/game)

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";

const HARNESS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HARNESS, "..");
const GAME = path.resolve(process.env.GAME_DIR ?? path.join(ROOT, "game"));
const STATE_FILE = path.join(HARNESS, ".judge-state.json");
const LOG_FILE = path.join(HARNESS, "last-judge.log");
const RESULT_FILE = path.join(HARNESS, "judge-result.json");
const AC_IDS = Array.from({ length: 20 }, (_, i) => `AC-${String(i + 1).padStart(2, "0")}`);
const JOBS = ["warrior", "rogue", "mage", "poet"];
const DIRS = ["up", "down", "left", "right"];

const results = [];
const logLines = [];
const log = (s) => { logLines.push(s); console.log(s); };
function record(id, ok, detail = "") {
  results.push({ id, ok, detail });
  log(`${ok ? "PASS" : "FAIL"}  ${id}${detail ? "  — " + detail : ""}`);
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 40) => String(s ?? "").split("\n").slice(-n).join("\n");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: GAME, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? (r.error ? -1 : 1), out: (r.stdout ?? "") + (r.stderr ?? "") + (r.error ? String(r.error) : "") };
}

function freePort() {
  return new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
    s.on("error", rej);
  });
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", "build", ".git", "data", "test-results", "playwright-report"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// ---------- 1. 정적 검사 ----------
function staticChecks() {
  const pkgPath = path.join(GAME, "package.json");
  if (!record("S1 game/package.json 존재", fs.existsSync(pkgPath))) return false;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch (e) { return record("S2 package.json 파싱", false, String(e)); }
  const missing = ["build", "test", "e2e", "start", "verify"].filter((s) => !pkg.scripts?.[s]);
  record("S2 필수 npm 스크립트", missing.length === 0, missing.length ? `누락: ${missing.join(", ")}` : "");

  const testFiles = walk(GAME).filter((f) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(f));
  const src = testFiles.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  const count = (src.match(/\b(?:it|test)\s*(?:\.each\s*\([^)]*\)\s*)?\(/g) ?? []).length;
  record("S3 테스트 파일 존재", testFiles.length > 0, `${testFiles.length}개 파일, 약 ${count}개 테스트`);

  const cheats = src.match(/\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo|fixme)\b|\bx(?:it|describe|test)\s*\(/g) ?? [];
  record("S4 skip/only/todo 금지", cheats.length === 0, cheats.length ? `발견: ${[...new Set(cheats)].join(", ")}` : "");

  const missingAc = AC_IDS.filter((id) => !src.includes(id));
  record("S5 모든 AC에 테스트 존재", missingAc.length === 0, missingAc.length ? `누락: ${missingAc.join(", ")}` : "");

  let prev = { maxTests: 0 };
  try { prev = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  const shrink = count < prev.maxTests;
  record("S6 테스트 수 감소 없음", !shrink, `현재 ${count} / 이전 최대 ${prev.maxTests}`);
  if (!shrink) fs.writeFileSync(STATE_FILE, JSON.stringify({ maxTests: Math.max(count, prev.maxTests) }));

  const forbidden = walk(GAME).filter((f) => /\.(ts|tsx|js|json|html|md)$/.test(f))
    .filter((f) => /바람의\s*나라|Kingdom of the Winds|nexon|넥슨/i.test(fs.readFileSync(f, "utf8")));
  record("S7 원작 명칭 미사용", forbidden.length === 0, forbidden.map((f) => path.relative(GAME, f)).join(", "));
  return true;
}

// ---------- 2. 빌드·검증 파이프라인 ----------
function pipeline() {
  if (!process.env.JUDGE_SKIP_INSTALL) {
    const hasLock = fs.existsSync(path.join(GAME, "package-lock.json"));
    const r = run("npm", [hasLock ? "ci" : "install", "--no-audit", "--no-fund"], { timeout: 600_000 });
    if (!record("P1 npm 설치", r.code === 0, r.code ? tail(r.out) : "")) return false;
  }
  if (!process.env.JUDGE_SKIP_VERIFY) {
    const started = Date.now();
    const r = run("npm", ["run", "verify"], { timeout: 1_200_000, env: { ...process.env, CI: "1" } });
    record("P2 npm run verify 종료코드 0", r.code === 0, r.code ? tail(r.out) : "");
    const repPath = path.join(GAME, "verify-report.json");
    let rep = null;
    try { rep = JSON.parse(fs.readFileSync(repPath, "utf8")); } catch (e) { record("P3 verify-report.json 읽기", false, String(e)); }
    if (rep) {
      const fresh = fs.statSync(repPath).mtimeMs >= started - 1000;
      record("P3 verify-report.json 이번 실행에서 생성", fresh);
      const bad = AC_IDS.filter((id) => rep.acceptance?.[id] !== "pass");
      record("P4 AC-01~AC-20 전부 pass", bad.length === 0, bad.map((id) => `${id}=${rep.acceptance?.[id] ?? "없음"}`).join(", "));
      const t = rep.tests ?? {};
      record("P5 실패·스킵 테스트 0", t.total > 0 && t.failed === 0 && t.skipped === 0, JSON.stringify(t));
    }
  } else {
    const r = run("npm", ["run", "build"], { timeout: 600_000 });
    if (!record("P2 npm run build", r.code === 0, r.code ? tail(r.out) : "")) return false;
  }
  return true;
}

// ---------- 3. 라이브 프로토콜 검사 ----------
async function startServer(port, dataDir) {
  const child = spawn("npm", ["start"], {
    cwd: GAME, env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "production" },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return { child, out: () => out };
    } catch {}
    if (child.exitCode !== null) break;
    await sleep(300);
  }
  stopServer(child, "SIGKILL");
  throw new Error("서버가 30초 안에 /health 응답을 하지 않음\n" + tail(out));
}

function stopServer(child, sig = "SIGTERM") {
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
  return new Promise((r) => { if (child.exitCode !== null) r(); else { child.once("exit", r); setTimeout(r, 5000); } });
}

class Client {
  constructor(url) {
    this.msgs = [];
    this.waiters = [];
    this.ws = new WebSocket(url);
    this.closed = false;
    this.ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
    };
    this.ws.onclose = () => (this.closed = true);
    this.open = new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = () => rej(new Error("WebSocket 연결 실패")); });
  }
  send(obj) { this.ws.send(typeof obj === "string" ? obj : JSON.stringify(obj)); }
  wait(pred, ms = 3000, fromIndex = 0) {
    const hit = this.msgs.slice(fromIndex).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error("타임아웃")); }, ms);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function login(url, name, job) {
  const c = new Client(url);
  await c.open;
  c.send({ t: "login", name, job });
  const w = await c.wait((m) => m.t === "welcome", 5000);
  return { c, w };
}

async function live() {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "judge-data-"));
  const base = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}/ws`;
  let srv;
  try { srv = await startServer(port, dataDir); } catch (e) { return record("L1 서버 기동 + /health", false, e.message); }
  const clients = [];
  try {
    const h = await (await fetch(`${base}/health`)).json().catch(() => null);
    record("L1 서버 기동 + /health", h?.ok === true, JSON.stringify(h));
    const html = await (await fetch(`${base}/`)).text();
    record("L2 GET / 에 <canvas> 포함", /<canvas/i.test(html) || /createElement\(\s*["']canvas/.test(html));

    const suffix = Math.random().toString(36).slice(2, 6);
    const nameA = `심판A${suffix}`.slice(0, 12), nameB = `심판B${suffix}`.slice(0, 12);
    let A, B;
    try {
      A = await login(wsUrl, nameA, JOBS[0]); clients.push(A.c);
      B = await login(wsUrl, nameB, JOBS[3]); clients.push(B.c);
      const w = A.w;
      const shapeOk = w.id != null && typeof w.map === "string" && Number.isInteger(w.x) && Number.isInteger(w.y)
        && ["level", "exp", "hp", "maxHp", "mp", "maxMp"].every((k) => typeof w.stats?.[k] === "number");
      record("L3 login → welcome 형식", shapeOk, JSON.stringify(w).slice(0, 300));
    } catch (e) { return record("L3 login → welcome 형식", false, e.message); }

    // 서로 보이는가
    const sees = (c, id, extra = () => true) => (m) => m.t === "snapshot" && Array.isArray(m.players) && m.players.some((p) => p.id === id && extra(p));
    try { await B.c.wait(sees(B.c, A.w.id), 2000); record("L4 B가 snapshot에서 A를 봄", true); }
    catch { record("L4 B가 snapshot에서 A를 봄", false, "2초 내 A가 포함된 snapshot 없음 (같은 시작 맵이어야 함)"); }

    // 이동 → 서버 반영 → 상대방에게 1초 내 전파
    let pos = { x: A.w.x, y: A.w.y }, moved = null;
    for (const dir of DIRS) {
      const idx = A.c.msgs.length;
      A.c.send({ t: "move", dir });
      try {
        const m = await A.c.wait((m) => m.t === "snapshot" && m.players?.some((p) => p.id === A.w.id && (p.x !== pos.x || p.y !== pos.y)), 1200, idx);
        moved = m.players.find((p) => p.id === A.w.id);
        const d = Math.abs(moved.x - pos.x) + Math.abs(moved.y - pos.y);
        record("L5 move 1칸 이동", d === 1, `${dir}: (${pos.x},${pos.y})→(${moved.x},${moved.y})`);
        break;
      } catch { await sleep(300); }
    }
    if (!moved) record("L5 move 1칸 이동", false, "4방향 모두 위치 변화 없음");
    else {
      try {
        await B.c.wait(sees(B.c, A.w.id, (p) => p.x === moved.x && p.y === moved.y), 1000, 0);
        record("L6 B가 1초 내 A의 새 위치를 봄", true);
      } catch { record("L6 B가 1초 내 A의 새 위치를 봄", false); }
    }

    // 과속 입력: 한 번에 50개 이동 명령 → 서버가 제한해야 함
    {
      const start = moved ?? pos;
      for (let i = 0; i < 50; i++) A.c.send({ t: "move", dir: DIRS[i % 2 === 0 ? 1 : 3] });
      await sleep(300);
      const last = [...A.c.msgs].reverse().find((m) => m.t === "snapshot" && m.players?.some((p) => p.id === A.w.id));
      const p = last?.players.find((p) => p.id === A.w.id);
      const d = p ? Math.abs(p.x - start.x) + Math.abs(p.y - start.y) : 0;
      record("L7 이동 속도 제한 (0.3초에 50칸 요청 → 10칸 이하)", d <= 10, `이동 거리 ${d}`);
      await sleep(700);
    }

    // 채팅
    {
      const text = `안녕 ${suffix}`;
      const idx = B.c.msgs.length;
      A.c.send({ t: "chat", text });
      try { const m = await B.c.wait((m) => m.t === "chat" && m.text === text, 2000, idx); record("L8 채팅 전파", m.from === nameA, JSON.stringify(m)); }
      catch { record("L8 채팅 전파", false, "B가 chat 수신 못함"); }
      const idx2 = B.c.msgs.length;
      A.c.send({ t: "chat", text: "   " });
      A.c.send({ t: "chat", text: "가".repeat(500) });
      await sleep(600);
      const leaked = B.c.msgs.slice(idx2).filter((m) => m.t === "chat" && (!String(m.text).trim() || String(m.text).length > 200));
      record("L9 빈 채팅/200자 초과 거부", leaked.length === 0);
    }

    // 몬스터 존재 (사냥터가 아닐 수 있으므로 snapshot 형식만 확인)
    {
      const snap = [...A.c.msgs].reverse().find((m) => m.t === "snapshot");
      record("L10 snapshot.monsters 배열", Array.isArray(snap?.monsters));
    }

    // 잘못된 입력에 서버가 죽지 않음
    {
      const evil = new Client(wsUrl); clients.push(evil);
      await evil.open;
      evil.send("{not json");
      evil.send({ t: "하하하" });
      evil.send({ t: "move", dir: "diagonal" });
      evil.send({ t: "login", name: "", job: "god" });
      evil.send({ t: "login", name: { $gt: "" }, job: ["warrior"] });
      evil.send(JSON.stringify({ t: "chat", text: 12345 }));
      await sleep(800);
      const gotErr = evil.msgs.some((m) => m.t === "error" && m.code != null);
      record("L11 잘못된 메시지에 error 응답", gotErr);
      const alive = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
      record("L12 악성 입력 후에도 서버 생존", alive && srv.child.exitCode === null);
    }

    // 저장: A 위치 기억 → 종료 → 서버 재시작 → 재접속
    const lastA = [...A.c.msgs].reverse().find((m) => m.t === "snapshot" && m.players?.some((p) => p.id === A.w.id));
    const savedPos = lastA ? lastA.players.find((p) => p.id === A.w.id) : null;
    const savedMap = lastA?.map;
    for (const c of clients) c.close();
    clients.length = 0;
    await sleep(1500);
    await stopServer(srv.child, "SIGTERM");
    try { srv = await startServer(port, dataDir); }
    catch (e) { return record("L13 서버 재시작 후 캐릭터 유지", false, e.message); }
    try {
      const again = await login(wsUrl, nameA, JOBS[0]); clients.push(again.c);
      const ok = savedPos && again.w.x === savedPos.x && again.w.y === savedPos.y && again.w.map === savedMap;
      record("L13 서버 재시작 후 캐릭터 유지", !!ok,
        `저장 전 ${savedMap}(${savedPos?.x},${savedPos?.y}) / 재접속 ${again.w.map}(${again.w.x},${again.w.y})`);
    } catch (e) { record("L13 서버 재시작 후 캐릭터 유지", false, e.message); }
  } finally {
    for (const c of clients) c.close();
    await stopServer(srv.child, "SIGKILL");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  return true;
}

// ---------- main ----------
log(`# judge ${new Date().toISOString()}  GAME=${GAME}`);
try {
  if (staticChecks() && pipeline()) await live();
} catch (e) {
  record("X 심판 실행 중 예외", false, e?.stack ?? String(e));
}
const failed = results.filter((r) => !r.ok);
log(`\n결과: ${results.length - failed.length}/${results.length} 통과${failed.length ? " — 실패: " + failed.map((f) => f.id.split(" ")[0]).join(", ") : ""}`);
fs.writeFileSync(LOG_FILE, logLines.join("\n") + "\n");
fs.writeFileSync(RESULT_FILE, JSON.stringify({ timestamp: new Date().toISOString(), pass: failed.length === 0, results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
