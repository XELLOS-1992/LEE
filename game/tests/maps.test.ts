import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { generateAll, SOLID_TILES, T } from "../shared/mapgen";
import { MAPS, START_MAP, isBlocked, portalAt } from "../shared/maps";
import { addPlayer, makeWorld, place } from "./helpers";

function reachable(mapId: string, from: { x: number; y: number }): Set<string> {
  const m = MAPS[mapId];
  const seen = new Set([`${from.x},${from.y}`]);
  const q = [from];
  while (q.length) {
    const { x, y } = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy, k = `${nx},${ny}`;
      if (seen.has(k) || isBlocked(m, nx, ny)) continue;
      seen.add(k);
      if (!portalAt(m, nx, ny)) q.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe("AC-02 타일 맵", () => {
  it("AC-02 마을 1개와 사냥터 2개 이상, 각 40×40 이상", () => {
    const maps = Object.values(MAPS);
    expect(maps.length).toBeGreaterThanOrEqual(3);
    expect(maps.filter((m) => m.kind === "town").length).toBeGreaterThanOrEqual(1);
    expect(maps.filter((m) => m.kind === "hunt").length).toBeGreaterThanOrEqual(2);
    for (const m of maps) {
      expect(m.width).toBeGreaterThanOrEqual(40);
      expect(m.height).toBeGreaterThanOrEqual(40);
      expect(m.tiles).toHaveLength(m.height);
      for (const row of m.tiles) expect(row).toHaveLength(m.width);
    }
  });

  it("AC-02 충돌 레이어가 지형과 NPC 위치에 맞게 존재한다", () => {
    for (const m of Object.values(MAPS)) {
      expect(m.collision).toHaveLength(m.height);
      for (let y = 0; y < m.height; y++)
        for (let x = 0; x < m.width; x++) {
          const npc = m.npcs.some((n) => n.x === x && n.y === y);
          expect(m.collision[y][x]).toBe(SOLID_TILES.has(m.tiles[y][x]) || npc ? 1 : 0);
        }
    }
    const town = MAPS.town;
    expect(town.tiles[0][0]).toBe(T.WALL);
    expect(isBlocked(town, 0, 0)).toBe(true);
    expect(isBlocked(town, town.entry.x, town.entry.y)).toBe(false);
  });

  it("AC-02 맵 파일은 생성기로 재현 가능하다", () => {
    for (const m of generateAll()) {
      const saved = JSON.parse(fs.readFileSync(`shared/maps/${m.id}.json`, "utf8"));
      expect(saved).toEqual(JSON.parse(JSON.stringify(m)));
    }
  });

  it("AC-02 사냥터에는 몬스터 스폰 영역, 마을에는 NPC 가 있다", () => {
    expect(MAPS.town.npcs.length).toBeGreaterThanOrEqual(3);
    expect(MAPS.field.spawns.length).toBeGreaterThan(0);
    expect(MAPS.cave.spawns.length).toBeGreaterThan(0);
  });
});

describe("AC-04 맵 이동(포털)", () => {
  it("AC-04 모든 맵에서 입구로부터 모든 포털에 걸어서 도달할 수 있다", () => {
    for (const m of Object.values(MAPS)) {
      const seen = reachable(m.id, m.entry);
      for (const p of m.portals) expect(seen.has(`${p.x},${p.y}`), `${m.id} portal ${p.x},${p.y}`).toBe(true);
      for (const p of m.portals) {
        expect(MAPS[p.to]).toBeDefined();
        expect(isBlocked(MAPS[p.to], p.tx, p.ty)).toBe(false);
        expect(portalAt(MAPS[p.to], p.tx, p.ty)).toBeUndefined();
      }
    }
  });

  it("AC-04 마을 동문 포털을 밟으면 비류수 들판의 지정 좌표로 이동한다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "town", 46, 23, "right");
    expect(w.requestMove(p, "right", 1000)).toBe(true);
    expect(p.map).toBe("field");
    expect([p.x, p.y]).toEqual([1, 23]);
  });

  it("AC-04 들판 → 동굴 → 들판 → 마을 왕복", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "field", 46, 24, "right");
    w.requestMove(p, "right", 1000);
    expect([p.map, p.x, p.y]).toEqual(["cave", 1, 24]);
    w.requestMove(p, "left", 2000);
    expect([p.map, p.x, p.y]).toEqual(["field", 46, 24]);
    place(p, "field", 1, 23, "left");
    w.requestMove(p, "left", 3000);
    expect([p.map, p.x, p.y]).toEqual([START_MAP, 46, 23]);
  });
});
