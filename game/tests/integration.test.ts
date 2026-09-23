// 실제 HTTP/WebSocket 서버를 띄워 프로토콜 계약을 검증한다.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGameServer, type GameServer } from "../server/server";
import type { ChatMsg, ErrorMsg, SelfMsg, SnapshotMsg, WelcomeMsg } from "../shared/types";
import { TestClient, sleep } from "./helpers";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(dataDir?: string): Promise<{ game: GameServer; url: string; dataDir: string }> {
  const dir = dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pungun-it-"));
  if (!dataDir) cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const game = await createGameServer({ port: 0, dataDir: dir });
  cleanup.push(() => game.close());
  return { game, url: `ws://127.0.0.1:${game.port}/ws`, dataDir: dir };
}

async function login(url: string, name: string, job = "warrior") {
  const c = new TestClient(url);
  cleanup.push(() => c.close());
  await c.open;
  c.send({ t: "login", name, job });
  const w = await c.wait<WelcomeMsg>((m) => m.t === "welcome");
  return { c, w };
}

const snapWith = (id: number, pred: (p: { x: number; y: number }) => boolean = () => true) => (m: { t: string }) =>
  m.t === "snapshot" && (m as SnapshotMsg).players.some((p) => p.id === id && pred(p));

describe("AC-01 접속", () => {
  it("AC-01 네 직업 모두 로그인하면 welcome 을 받는다", async () => {
    const { url } = await start();
    for (const job of ["warrior", "rogue", "mage", "poet"]) {
      const { w } = await login(url, `직업${job.slice(0, 3)}`, job);
      expect(w).toMatchObject({ t: "welcome", job, map: "town" });
      expect(Number.isInteger(w.x) && Number.isInteger(w.y)).toBe(true);
      for (const k of ["level", "exp", "hp", "maxHp", "mp", "maxMp"] as const) expect(typeof w.stats[k]).toBe("number");
    }
  });

  it("AC-01 잘못된 로그인과 로그인 전 명령은 error 로 거부된다", async () => {
    const { url } = await start();
    const c = new TestClient(url);
    cleanup.push(() => c.close());
    await c.open;
    c.send({ t: "move", dir: "up" });
    expect((await c.wait<ErrorMsg>((m) => m.t === "error")).code).toBe("not_logged_in");
    c.send({ t: "login", name: "x", job: "warrior" });
    expect((await c.wait<ErrorMsg>((m) => m.t === "error" && m.code === "bad_login")).code).toBe("bad_login");
  });

  it("AC-01 같은 이름으로 다시 접속하면 이전 연결을 대체한다", async () => {
    const { url, game } = await start();
    const a = await login(url, "중복이");
    const b = await login(url, "중복이");
    await a.c.wait((m) => m.t === "error" && (m as ErrorMsg).code === "duplicate_login");
    expect(b.w.name).toBe("중복이");
    expect([...game.world.players.values()].filter((p) => p.name === "중복이")).toHaveLength(1);
  });
});

describe("AC-05 멀티플레이 동기화", () => {
  it("AC-05 두 클라이언트가 서로의 위치를 1초 이내에 본다", async () => {
    const { url } = await start();
    const A = await login(url, "동기A");
    const B = await login(url, "동기B");
    await B.c.wait(snapWith(A.w.id), 1000);
    await A.c.wait(snapWith(B.w.id), 1000);
    const from = B.c.msgs.length;
    const started = Date.now();
    A.c.send({ t: "move", dir: "up" });
    await B.c.wait(snapWith(A.w.id, (p) => p.y === A.w.y - 1), 1000, from);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("AC-05 자기 상태(self)에 인벤토리·전·능력치가 전달된다", async () => {
    const { url } = await start();
    const A = await login(url, "상태왕");
    const s = await A.c.wait<SelfMsg>((m) => m.t === "self");
    expect(s.inventory).toHaveLength(20);
    expect(s.gold).toBe(50);
    expect(s.stats.maxHp).toBe(A.w.stats.maxHp);
  });
});

describe("AC-06 채팅", () => {
  it("AC-06 같은 맵의 모두에게 전달되고, 다른 맵에는 전달되지 않는다", async () => {
    const { url, game } = await start();
    const A = await login(url, "채팅A");
    const B = await login(url, "채팅B");
    const C = await login(url, "채팅C");
    const pc = game.world.players.get(C.w.id)!;
    game.world.teleport(pc, "field", 1, 23);
    const fromB = B.c.msgs.length, fromC = C.c.msgs.length;
    A.c.send({ t: "chat", text: "  들판으로 가자  " });
    const got = await B.c.wait<ChatMsg>((m) => m.t === "chat", 2000, fromB);
    expect(got).toEqual({ t: "chat", from: "채팅A", text: "들판으로 가자" });
    await sleep(300);
    expect(C.c.msgs.slice(fromC).some((m) => m.t === "chat")).toBe(false);
  });

  it("AC-06 200자 초과·빈 채팅은 거부되고 전달되지 않는다", async () => {
    const { url } = await start();
    const A = await login(url, "거부A");
    const B = await login(url, "거부B");
    const fromB = B.c.msgs.length, fromA = A.c.msgs.length;
    A.c.send({ t: "chat", text: "가".repeat(201) });
    A.c.send({ t: "chat", text: "   " });
    await A.c.wait((m) => m.t === "error" && (m as ErrorMsg).code === "bad_chat", 1000, fromA);
    await sleep(300);
    expect(B.c.msgs.slice(fromB).some((m) => m.t === "chat")).toBe(false);
  });
});

describe("AC-14 서버 재시작 후 저장 유지", () => {
  it("AC-14 재접속 시 레벨·경험치·위치·인벤토리가 유지된다", async () => {
    const first = await start();
    const A = await login(first.url, "기억왕", "mage");
    const p = first.game.world.players.get(A.w.id)!;
    first.game.world.gainExp(p, 80);
    p.inventory[9] = { item: "bear_paw", qty: 2 };
    A.c.send({ t: "move", dir: "up" });
    await A.c.wait(snapWith(A.w.id, (q) => q.y === A.w.y - 1));
    const level = p.level, exp = p.exp;
    expect(level).toBeGreaterThan(1);
    await first.game.close();
    A.c.close();
    await sleep(100);

    const second = await start(first.dataDir);
    const again = await login(second.url, "기억왕", "warrior");
    expect(again.w).toMatchObject({ job: "mage", map: "town", x: A.w.x, y: A.w.y - 1 });
    expect(again.w.stats.level).toBe(level);
    expect(again.w.stats.exp).toBe(exp);
    const self = await again.c.wait<SelfMsg>((m) => m.t === "self");
    expect(self.inventory[9]).toEqual({ item: "bear_paw", qty: 2 });
  });
});

describe("AC-17 서버 견고성", () => {
  it("AC-17 잘못된 JSON·바이너리·알 수 없는 타입에도 서버가 죽지 않고 error 로 응답한다", async () => {
    const { url, game } = await start();
    const A = await login(url, "견고왕");
    A.c.send("{not json");
    A.c.send({ t: "하하" });
    A.c.send({ t: "move", dir: { evil: true } });
    A.c.ws.send(Buffer.from([0, 1, 2, 3]), { binary: true });
    A.c.send({ t: "use", slot: 99 });
    A.c.send({ t: "debug", cmd: "spawn", kind: "goblin" }); // 운영 모드에서는 비활성
    await sleep(300);
    const codes = A.c.msgs.filter((m) => m.t === "error").map((m) => (m as ErrorMsg).code);
    expect(codes).toEqual(expect.arrayContaining(["bad_json", "unknown_type", "bad_dir", "bad_slot"]));
    expect([...game.world.monsters.values()].some((m) => m.map === "town")).toBe(false);
    const res = await fetch(`http://127.0.0.1:${game.port}/health`);
    expect(await res.json()).toMatchObject({ ok: true });
    A.c.send({ t: "chat", text: "여전히 살아있다" });
    await A.c.wait((m) => m.t === "chat");
  });

  it("AC-17 초당 요청 수를 제한한다", async () => {
    const { url } = await start();
    const A = await login(url, "도배왕");
    for (let i = 0; i < 200; i++) A.c.send({ t: "attack" });
    await A.c.wait((m) => m.t === "error" && (m as ErrorMsg).code === "rate_limited", 2000);
  });

  it("AC-17 정적 파일 경로 탈출을 막는다", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pungun-static-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<canvas></canvas>");
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const game = await createGameServer({ port: 0, dataDir: dir, staticDir: path.join(dir) });
    cleanup.push(() => game.close());
    const ok = await fetch(`http://127.0.0.1:${game.port}/`);
    expect(await ok.text()).toContain("<canvas");
    const bad = await fetch(`http://127.0.0.1:${game.port}/..%2f..%2fetc%2fpasswd`);
    expect([403, 404]).toContain(bad.status);
  });
});
