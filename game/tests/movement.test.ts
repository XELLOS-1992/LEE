import { describe, expect, it } from "vitest";
import { MOVE_INTERVAL_MS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { addPlayer, makeWorld, openSpot, place, spawn } from "./helpers";

describe("AC-03 이동", () => {
  it("AC-03 4방향으로 한 칸씩 이동한다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("town");
    place(p, "town", s.x, s.y);
    let t = 1000;
    const expected: Record<string, [number, number]> = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };
    for (const [dir, [dx, dy]] of Object.entries(expected)) {
      const bx = p.x, by = p.y;
      expect(w.requestMove(p, dir as "up", t)).toBe(true);
      expect([p.x - bx, p.y - by]).toEqual([dx, dy]);
      expect(p.dir).toBe(dir);
      t += MOVE_INTERVAL_MS;
    }
  });

  it("AC-03 벽 타일로는 이동할 수 없고 방향만 바뀐다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "town", 1, 23, "right");
    expect(MAPS.town.collision[23][0]).toBe(1);
    expect(w.requestMove(p, "left", 1000)).toBe(false);
    expect([p.x, p.y, p.dir]).toEqual([1, 23, "left"]);
  });

  it("AC-03 맵 밖으로는 이동할 수 없다", () => {
    const w = makeWorld();
    expect(w.playerCanEnter("town", -1, 5)).toBe(false);
    expect(w.playerCanEnter("town", 5, -1)).toBe(false);
    expect(w.playerCanEnter("town", MAPS.town.width, 5)).toBe(false);
    expect(w.playerCanEnter("town", 5, MAPS.town.height)).toBe(false);
  });

  it("AC-03 몬스터와 NPC 가 있는 칸으로는 이동할 수 없다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y);
    spawn(w, "squirrel", "field", s.x + 1, s.y);
    expect(w.requestMove(p, "right", 1000)).toBe(false);
    expect(p.x).toBe(s.x);
    const jumo = MAPS.town.npcs.find((n) => n.id === "jumo")!;
    place(p, "town", jumo.x, jumo.y + 1);
    expect(w.requestMove(p, "up", 2000)).toBe(false);
  });

  it("AC-03 이동 속도 제한: 과속 입력은 무시되고 마지막 방향 하나만 예약된다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("town", 3);
    place(p, "town", s.x, s.y);
    const t0 = 10_000;
    for (let i = 0; i < 50; i++) w.requestMove(p, i % 2 ? "right" : "down", t0 + i);
    expect(Math.abs(p.x - s.x) + Math.abs(p.y - s.y)).toBe(1);
    w.tick(t0 + MOVE_INTERVAL_MS / 2);
    expect(Math.abs(p.x - s.x) + Math.abs(p.y - s.y)).toBe(1);
    w.tick(t0 + MOVE_INTERVAL_MS);
    expect(Math.abs(p.x - s.x) + Math.abs(p.y - s.y)).toBe(2);
    w.tick(t0 + MOVE_INTERVAL_MS * 3);
    expect(Math.abs(p.x - s.x) + Math.abs(p.y - s.y)).toBe(2);
  });
});
