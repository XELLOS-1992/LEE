import { WebSocket } from "ws";
import { MONSTERS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { makeRng, type Rng } from "../shared/rules";
import type { Dir, Job, ServerMsg } from "../shared/types";
import { World, type Monster, type Player } from "../server/world";

export function makeWorld(opts: { rng?: Rng; spawnMonsters?: boolean; testHooks?: boolean } = {}): World {
  return new World({ rng: opts.rng ?? makeRng(42), now: 0, spawnMonsters: opts.spawnMonsters ?? false, testHooks: opts.testHooks });
}

let nameSeq = 0;
export function addPlayer(w: World, job: Job = "warrior", name?: string): Player {
  return w.addPlayer(World.newCharacter(name ?? `시험${++nameSeq}`, job), 0);
}

/** 플레이어를 map 의 (x,y) 에 두고 dir 방향을 보게 한다. */
export function place(p: Player, map: string, x: number, y: number, dir: Dir = "down") {
  p.map = map;
  p.x = x;
  p.y = y;
  p.dir = dir;
}

export function spawn(w: World, kind: string, map: string, x: number, y: number): Monster {
  return w.spawnMonster(MONSTERS[kind], map, x, y, null, 0);
}

/** 사방이 트인 빈 칸을 찾는다 (테스트 배치용). */
export function openSpot(mapId: string, radius = 2): { x: number; y: number } {
  const m = MAPS[mapId];
  for (let y = radius + 1; y < m.height - radius - 1; y++)
    for (let x = radius + 1; x < m.width - radius - 1; x++) {
      let ok = true;
      for (let j = -radius; j <= radius && ok; j++)
        for (let i = -radius; i <= radius && ok; i++) if (m.collision[y + j][x + i] || m.portals.some((p) => p.x === x + i && p.y === y + j)) ok = false;
      if (ok) return { x, y };
    }
  throw new Error("open spot not found");
}

export function errors(w: World, id: number): string[] {
  return w
    .drain()
    .filter((o) => o.to === "player" && o.id === id && o.msg.t === "error")
    .map((o) => (o.msg as { code: string }).code);
}

// ---------- 통합 테스트용 WebSocket 클라이언트 ----------

export class TestClient {
  readonly msgs: ServerMsg[] = [];
  private waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  readonly ws: WebSocket;
  readonly open: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.open = new Promise((res, rej) => {
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
    });
    this.ws.on("message", (d) => {
      const m = JSON.parse(d.toString()) as ServerMsg;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.res(m), false) : true));
    });
  }

  send(o: unknown) {
    this.ws.send(typeof o === "string" ? o : JSON.stringify(o));
  }

  wait<T extends ServerMsg = ServerMsg>(pred: (m: ServerMsg) => boolean, ms = 3000, from = 0): Promise<T> {
    const hit = this.msgs.slice(from).find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((res, rej) => {
      const w = { pred, res: res as (m: ServerMsg) => void };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        rej(new Error(`timeout waiting for message (${ms}ms)`));
      }, ms);
    });
  }

  close() {
    this.ws.close();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
