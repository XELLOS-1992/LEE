// 네트워크 계층: HTTP(정적 파일, /health) + WebSocket(/ws). 게임 규칙은 World 에 있다.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { AUTOSAVE_MS, RATE_LIMIT_BURST, RATE_LIMIT_PER_SEC, TICK_MS } from "../shared/balance";
import type { ServerMsg } from "../shared/types";
import { MAX_MESSAGE_BYTES, parseClientMessage } from "../shared/validate";
import { Storage } from "./storage";
import { World, type CharacterSave } from "./world";

export interface GameServerOptions {
  port: number;
  dataDir: string;
  staticDir?: string;
  testHooks?: boolean;
  world?: World;
}

export interface GameServer {
  port: number;
  world: World;
  saveAll(): void;
  close(): Promise<void>;
}

interface Session {
  ws: WebSocket;
  playerId: number | null;
  tokens: number;
  refillAt: number;
  lastRateErr: number;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

export function createGameServer(opts: GameServerOptions): Promise<GameServer> {
  const storage = new Storage(opts.dataDir);
  const world = opts.world ?? new World({ testHooks: opts.testHooks, now: Date.now() });
  const sessions = new Set<Session>();
  const byPlayer = new Map<number, Session>();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, players: world.players.size, tick: world.tickCount }));
      return;
    }
    if (!opts.staticDir) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end('<!doctype html><title>풍운록</title><canvas id="game"></canvas>');
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(opts.staticDir, rel);
    if (!file.startsWith(path.resolve(opts.staticDir) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server, path: "/ws", maxPayload: MAX_MESSAGE_BYTES * 2 });

  const send = (s: Session, msg: ServerMsg | string) => {
    if (s.ws.readyState === WebSocket.OPEN) s.ws.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  };

  const flush = () => {
    const now = Date.now();
    for (const o of world.drain()) {
      const json = JSON.stringify(o.msg);
      if (o.to === "player") {
        const s = byPlayer.get(o.id);
        if (s) send(s, json);
      } else {
        for (const [pid, s] of byPlayer) if (world.players.get(pid)?.map === o.map) send(s, json);
      }
    }
    for (const [pid, s] of byPlayer) {
      const p = world.players.get(pid);
      if (p?.dirty) {
        p.dirty = false;
        send(s, world.selfMsg(p, now));
      }
    }
  };

  const safeSave = (save: CharacterSave) => {
    try {
      storage.save(save);
    } catch (e) {
      console.error(`[server] ${save.name} 저장 실패:`, e);
    }
  };

  const savePlayer = (pid: number) => {
    const p = world.players.get(pid);
    if (p) safeSave(world.toSave(p));
  };

  const detach = (s: Session) => {
    if (s.playerId === null) return;
    const save = world.removePlayer(s.playerId);
    if (save) safeSave(save);
    byPlayer.delete(s.playerId);
    s.playerId = null;
  };

  wss.on("connection", (ws) => {
    const s: Session = { ws, playerId: null, tokens: RATE_LIMIT_BURST, refillAt: Date.now(), lastRateErr: 0 };
    sessions.add(s);
    ws.on("message", (data, isBinary) => {
      const now = Date.now();
      s.tokens = Math.min(RATE_LIMIT_BURST, s.tokens + ((now - s.refillAt) / 1000) * RATE_LIMIT_PER_SEC);
      s.refillAt = now;
      if (s.tokens < 1) {
        if (now - s.lastRateErr > 1000) {
          s.lastRateErr = now;
          send(s, { t: "error", code: "rate_limited", message: "요청이 너무 많습니다" });
        }
        return;
      }
      s.tokens -= 1;
      const parsed = parseClientMessage(isBinary ? null : data.toString());
      if (!parsed.ok) {
        send(s, { t: "error", code: parsed.code, message: parsed.message });
        return;
      }
      const msg = parsed.msg;
      try {
        if (msg.t === "login") {
          if (s.playerId !== null) {
            send(s, { t: "error", code: "already_logged_in", message: "이미 접속 중입니다" });
            return;
          }
          // 같은 이름이 접속 중이면 기존 연결을 끊고 이어받는다.
          const existing = world.findPlayerByName(msg.name);
          if (existing) {
            const old = byPlayer.get(existing.id);
            if (old) {
              send(old, { t: "error", code: "duplicate_login", message: "다른 곳에서 접속하여 연결을 종료합니다" });
              detach(old);
              old.ws.close();
            }
          }
          const save = storage.load(msg.name) ?? World.newCharacter(msg.name, msg.job);
          const p = world.addPlayer(save, now);
          s.playerId = p.id;
          byPlayer.set(p.id, s);
          send(s, world.welcome(p));
          send(s, world.snapshot(p.map));
          flush();
          return;
        }
        if (s.playerId === null) {
          send(s, { t: "error", code: "not_logged_in", message: "먼저 로그인하세요" });
          return;
        }
        world.handle(s.playerId, msg, now);
        flush();
      } catch (e) {
        console.error("[server] 메시지 처리 오류:", e);
        send(s, { t: "error", code: "server_error", message: "서버 오류" });
      }
    });
    ws.on("close", () => {
      detach(s);
      sessions.delete(s);
    });
    ws.on("error", () => ws.close());
  });

  let lastAutosave = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    try {
      world.tick(now);
      const maps = new Map<string, string>();
      for (const [pid, s] of byPlayer) {
        const p = world.players.get(pid);
        if (!p) continue;
        let snap = maps.get(p.map);
        if (!snap) {
          snap = JSON.stringify(world.snapshot(p.map));
          maps.set(p.map, snap);
        }
        send(s, snap);
      }
      flush();
      if (now - lastAutosave >= AUTOSAVE_MS) {
        lastAutosave = now;
        for (const pid of byPlayer.keys()) savePlayer(pid);
      }
    } catch (e) {
      console.error("[server] 틱 오류:", e);
    }
  }, TICK_MS);

  const saveAll = () => {
    for (const pid of byPlayer.keys()) savePlayer(pid);
  };

  return new Promise((resolve) => {
    server.listen(opts.port, () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        port,
        world,
        saveAll,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(timer);
            for (const s of sessions) {
              detach(s); // 저장 후 월드에서 제거 — 이후 도착하는 close 이벤트는 아무것도 하지 않는다
              s.ws.terminate();
            }
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}
