import { describe, expect, it } from "vitest";
import { ATTACK_INTERVAL_MS, MONSTER_ATTACK_MS, MONSTERS, PLAYER_RESPAWN_MS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { calcDamage, expToNext, makeRng } from "../shared/rules";
import { addPlayer, errors, makeWorld, openSpot, place, spawn } from "./helpers";

describe("AC-07 몬스터", () => {
  it("AC-07 사냥터에만 몬스터가 스폰되고 4종 이상, 레벨이 차등된다", () => {
    const w = makeWorld({ spawnMonsters: true });
    const all = [...w.monsters.values()];
    expect(all.filter((m) => m.map === "town")).toHaveLength(0);
    expect(all.filter((m) => m.map === "field").length).toBeGreaterThan(20);
    expect(all.filter((m) => m.map === "cave").length).toBeGreaterThan(10);
    const kinds = new Set(all.map((m) => m.kind));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    const levels = new Set([...kinds].map((k) => MONSTERS[k].level));
    expect(levels.size).toBeGreaterThanOrEqual(4);
    for (const m of all) expect(MAPS[m.map].collision[m.y][m.x]).toBe(0);
  });

  it("AC-07 몬스터는 시간이 지나면 배회한다 (벽을 통과하지 않음)", () => {
    const w = makeWorld({ spawnMonsters: true });
    const before = new Map([...w.monsters.values()].map((m) => [m.id, `${m.x},${m.y}`]));
    for (let t = 100; t <= 10_000; t += 100) w.tick(t);
    const moved = [...w.monsters.values()].filter((m) => before.get(m.id) !== `${m.x},${m.y}`);
    expect(moved.length).toBeGreaterThan(10);
    for (const m of w.monsters.values()) expect(MAPS[m.map].collision[m.y][m.x]).toBe(0);
    const occupied = new Set([...w.monsters.values()].filter((m) => m.alive).map((m) => `${m.map}:${m.x},${m.y}`));
    expect(occupied.size).toBe([...w.monsters.values()].filter((m) => m.alive).length);
  });

  it("AC-07 쓰러진 몬스터는 일정 시간 뒤 스폰 영역에 리스폰한다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field", 3);
    const area = { x: s.x - 2, y: s.y - 2, w: 5, h: 5 };
    place(p, "field", s.x, s.y, "right");
    const mon = w.spawnMonster(MONSTERS.squirrel, "field", s.x + 1, s.y, area, 0);
    mon.hp = 1;
    w.attack(p, 1000);
    expect(mon.alive).toBe(false);
    expect(w.monsterAt("field", s.x + 1, s.y)).toBeUndefined();
    w.tick(1000 + mon.def.respawnMs - 100);
    expect(mon.alive).toBe(false);
    w.tick(1000 + mon.def.respawnMs);
    expect(mon.alive).toBe(true);
    expect(mon.hp).toBe(mon.def.hp);
    expect(mon.x >= area.x && mon.x < area.x + area.w && mon.y >= area.y && mon.y < area.y + area.h).toBe(true);
    expect(w.monsterAt("field", mon.x, mon.y)).toBe(mon);
  });
});

describe("AC-08 전투", () => {
  it("AC-08 데미지 공식(순수 함수): 최소 1, 공격력↑ 데미지↑, 방어력↓, 배율 반영, 결정적", () => {
    const r = () => 0.5; // 변동폭 중앙값 1.0
    expect(calcDamage(10, 0, r)).toBe(10);
    expect(calcDamage(10, 4, r)).toBe(8);
    expect(calcDamage(10, 4, r, 2)).toBe(18);
    expect(calcDamage(1, 100, r)).toBe(1);
    expect(calcDamage(20, 0, () => 0)).toBe(18);
    expect(calcDamage(20, 0, () => 0.999999)).toBe(22);
    const a = makeRng(7), b = makeRng(7);
    for (let i = 0; i < 20; i++) expect(calcDamage(30, 5, a)).toBe(calcDamage(30, 5, b));
    for (let atk = 5; atk < 50; atk += 5) expect(calcDamage(atk + 5, 3, r)).toBeGreaterThan(calcDamage(atk, 3, r));
  });

  it("AC-08 바라보는 방향의 인접 칸만 공격한다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const front = spawn(w, "bear", "field", s.x + 1, s.y);
    const back = spawn(w, "bear", "field", s.x - 1, s.y);
    w.attack(p, 1000);
    expect(front.hp).toBeLessThan(front.def.hp);
    expect(back.hp).toBe(back.def.hp);
    expect(front.targetId).toBe(p.id);
  });

  it("AC-08 공격 간격 제한: 너무 빠른 연속 공격은 무시된다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const m = spawn(w, "goblin", "field", s.x + 1, s.y);
    w.attack(p, 1000);
    const after1 = m.hp;
    w.attack(p, 1000 + ATTACK_INTERVAL_MS - 1);
    expect(m.hp).toBe(after1);
    w.attack(p, 1000 + ATTACK_INTERVAL_MS);
    expect(m.hp).toBeLessThan(after1);
  });

  it("AC-08 선공 몬스터는 다가와서 플레이어를 공격한다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field", 3);
    place(p, "field", s.x, s.y);
    const fox = spawn(w, "fox", "field", s.x + 3, s.y);
    const hp0 = p.hp;
    for (let t = 100; t <= 5000; t += 100) w.tick(t);
    expect(Math.abs(fox.x - p.x) + Math.abs(fox.y - p.y)).toBe(1);
    expect(p.hp).toBeLessThan(hp0);
  });

  it("AC-08 비선공 몬스터는 맞으면 반격한다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const sq = spawn(w, "squirrel", "field", s.x + 1, s.y);
    sq.hp = 1000;
    const hpStart = p.hp;
    for (let t = 100; t <= 3000; t += 100) w.tick(t);
    expect(p.hp).toBe(hpStart); // 공격하기 전에는 먼저 덤비지 않는다
    const hpBefore = p.hp;
    w.attack(p, 3100);
    for (let t = 3200; t <= 3200 + MONSTER_ATTACK_MS * 3; t += 100) w.tick(t);
    expect(p.hp).toBeLessThan(hpBefore);
  });
});

describe("AC-09 사망과 부활", () => {
  it("AC-09 HP 0 → 사망 → 행동 불가 → 일정 시간 후 마을 부활, 경험치 소량 손실", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    p.level = 3;
    p.exp = 100;
    p.hp = 1;
    w.damagePlayer(p, 5, 1000);
    expect(p.dead).toBe(true);
    expect(p.hp).toBe(0);
    expect(p.exp).toBe(100 - Math.floor(expToNext(3) * 0.05));
    expect(p.level).toBe(3);
    w.drain();
    w.handle(p.id, { t: "move", dir: "up" }, 1100);
    expect(errors(w, p.id)).toContain("dead");
    expect([p.x, p.y]).toEqual([s.x, s.y]);
    w.tick(1000 + PLAYER_RESPAWN_MS - 100);
    expect(p.dead).toBe(true);
    w.tick(1000 + PLAYER_RESPAWN_MS);
    expect(p.dead).toBe(false);
    expect([p.map, p.x, p.y]).toEqual(["town", MAPS.town.entry.x, MAPS.town.entry.y]);
    expect(p.hp).toBe(w.stats(p).maxHp);
  });

  it("AC-09 사망한 플레이어는 몬스터의 표적에서 풀린다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y);
    const wolf = spawn(w, "wolf", "field", s.x + 1, s.y);
    wolf.targetId = p.id;
    w.damagePlayer(p, 9999, 500);
    expect(wolf.targetId).toBeNull();
    expect(p.exp).toBe(0);
  });
});
