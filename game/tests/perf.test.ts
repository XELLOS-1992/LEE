import { describe, expect, it } from "vitest";
import { MONSTERS, TICK_MS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { makeRng } from "../shared/rules";
import { DIRS } from "../shared/types";
import { World } from "../server/world";

describe("AC-18 성능", () => {
  it("AC-18 플레이어 봇 50명 + 몬스터 200마리에서 서버 틱 평균 20ms 미만", () => {
    const rng = makeRng(99);
    const w = new World({ rng, now: 0 });
    // 몬스터를 200마리까지 채운다
    const kinds = Object.keys(MONSTERS);
    for (let i = 0; w.monsters.size < 200 && i < 10_000; i++) {
      const map = i % 2 ? MAPS.field : MAPS.cave;
      const x = 2 + Math.floor(rng() * (map.width - 4)), y = 2 + Math.floor(rng() * (map.height - 4));
      if (!map.collision[y][x] && !w.monsterAt(map.id, x, y) && !map.portals.some((p) => p.x === x && p.y === y))
        w.spawnMonster(MONSTERS[kinds[i % kinds.length]], map.id, x, y, { x: x - 3, y: y - 3, w: 7, h: 7 }, 0);
    }
    expect(w.monsters.size).toBe(200);
    // 봇 50명을 사냥터에 흩어 놓는다
    const bots = [];
    for (let i = 0; i < 50; i++) {
      const p = w.addPlayer(World.newCharacter(`봇${i}`, (["warrior", "rogue", "mage", "poet"] as const)[i % 4]), 0);
      const map = i % 2 ? MAPS.field : MAPS.cave;
      p.map = map.id;
      p.x = map.entry.x + 1;
      p.y = map.entry.y;
      p.level = 30; // 오래 버티도록
      p.hp = w.stats(p).maxHp;
      bots.push(p);
    }
    const TICKS = 300;
    let total = 0;
    let now = 0;
    for (let t = 0; t < TICKS; t++) {
      now += TICK_MS;
      const start = performance.now();
      for (const b of bots) {
        const r = rng();
        if (r < 0.5) w.handle(b.id, { t: "move", dir: DIRS[Math.floor(rng() * 4)] }, now);
        else if (r < 0.8) w.handle(b.id, { t: "attack" }, now);
        else if (r < 0.9) w.handle(b.id, { t: "skill", slot: 1 + Math.floor(rng() * 2) }, now);
      }
      w.tick(now);
      for (const id of ["field", "cave", "town"]) JSON.stringify(w.snapshot(id));
      for (const b of bots) JSON.stringify(w.selfMsg(b, now));
      w.drain();
      total += performance.now() - start;
    }
    const avg = total / TICKS;
    console.log(`평균 틱 처리 시간: ${avg.toFixed(3)}ms`);
    expect(avg).toBeLessThan(20);
  });
});
