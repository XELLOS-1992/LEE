import { describe, expect, it } from "vitest";
import { MAX_LEVEL, MONSTERS, SKILLS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { addExp, baseStats, expToNext } from "../shared/rules";
import { JOBS } from "../shared/types";
import { addPlayer, errors, makeWorld, openSpot, place, spawn } from "./helpers";

describe("AC-10 성장", () => {
  it("AC-10 경험치 테이블: 고정값과 단조 증가", () => {
    expect(expToNext(1)).toBe(15);
    expect(expToNext(2)).toBe(52);
    expect(expToNext(10)).toBe(946);
    for (let lv = 1; lv < MAX_LEVEL - 1; lv++) expect(expToNext(lv + 1)).toBeGreaterThan(expToNext(lv));
    expect(expToNext(MAX_LEVEL)).toBe(Infinity);
  });

  it("AC-10 경험치가 넘치면 여러 레벨을 한 번에 올리고 남은 경험치를 이월한다", () => {
    expect(addExp(1, 0, 10)).toEqual({ level: 1, exp: 10, levelsGained: 0 });
    expect(addExp(1, 10, 5)).toEqual({ level: 2, exp: 0, levelsGained: 1 });
    expect(addExp(1, 0, 15 + 52 + 3)).toEqual({ level: 3, exp: 3, levelsGained: 2 });
    expect(addExp(MAX_LEVEL - 1, 0, 10 ** 9).level).toBe(MAX_LEVEL);
  });

  it("AC-10 레벨이 오르면 직업별로 HP·MP·능력치가 오른다", () => {
    for (const job of JOBS) {
      const a = baseStats(job, 1), b = baseStats(job, 5);
      expect(b.maxHp).toBeGreaterThan(a.maxHp);
      expect(b.maxMp).toBeGreaterThan(a.maxMp);
      expect(b.atk + b.mag).toBeGreaterThan(a.atk + a.mag);
    }
    expect(baseStats("warrior", 10).maxHp).toBeGreaterThan(baseStats("mage", 10).maxHp);
    expect(baseStats("mage", 10).mag).toBeGreaterThan(baseStats("warrior", 10).mag);
  });

  it("AC-10 몬스터를 쓰러뜨리면 경험치와 전을 얻고, 레벨업 시 체력이 가득 찬다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const gold0 = p.gold;
    p.exp = 14;
    p.hp = 5;
    const m = spawn(w, "squirrel", "field", s.x + 1, s.y);
    m.hp = 1;
    w.attack(p, 1000);
    expect(m.alive).toBe(false);
    expect(p.level).toBe(2);
    expect(p.exp).toBe(14 + MONSTERS.squirrel.exp - 15);
    expect(p.gold).toBeGreaterThanOrEqual(gold0 + MONSTERS.squirrel.gold[0]);
    expect(p.hp).toBe(w.stats(p).maxHp);
    expect(w.stats(p).maxHp).toBe(baseStats("warrior", 2).maxHp);
    const fx = w.drain().map((o) => o.msg);
    expect(fx.some((m) => m.t === "fx" && m.kind === "levelup")).toBe(true);
  });
});

describe("AC-11 직업과 스킬", () => {
  it("AC-11 모든 직업은 스킬을 2개 이상 가진다", () => {
    for (const job of JOBS) {
      expect(SKILLS[job].length).toBeGreaterThanOrEqual(2);
      for (const s of SKILLS[job]) {
        expect(s.mp).toBeGreaterThan(0);
        expect(s.cooldownMs).toBeGreaterThan(0);
      }
    }
  });

  it("AC-11 주술사 화염구: 원거리 공격, 마력 소모, 쿨다운", () => {
    const w = makeWorld();
    const p = addPlayer(w, "mage");
    const s = openSpot("town", 4);
    place(p, "town", s.x, s.y - 2, "down");
    const m = spawn(w, "bear", "town", s.x, s.y + 2);
    const mp0 = p.mp;
    w.skill(p, 1, 1000);
    expect(m.hp).toBeLessThan(m.def.hp);
    expect(p.mp).toBe(mp0 - SKILLS.mage[0].mp);
    const hp1 = m.hp;
    w.drain();
    w.skill(p, 1, 1000 + SKILLS.mage[0].cooldownMs - 1);
    expect(errors(w, p.id)).toContain("cooldown");
    expect(m.hp).toBe(hp1);
    expect(p.mp).toBe(mp0 - SKILLS.mage[0].mp);
    w.skill(p, 1, 1000 + SKILLS.mage[0].cooldownMs);
    expect(m.hp).toBeLessThan(hp1);
  });

  it("AC-11 마력이 부족하면 사용할 수 없다", () => {
    const w = makeWorld();
    const p = addPlayer(w, "mage");
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const m = spawn(w, "bear", "field", s.x + 1, s.y);
    p.mp = 1;
    w.drain();
    w.skill(p, 1, 1000);
    expect(errors(w, p.id)).toContain("no_mp");
    expect(m.hp).toBe(m.def.hp);
  });

  it("AC-11 대상이 없으면 마력을 쓰지 않는다", () => {
    const w = makeWorld();
    const p = addPlayer(w, "warrior");
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const mp0 = p.mp;
    w.drain();
    w.skill(p, 1, 1000);
    expect(errors(w, p.id)).toContain("no_target");
    expect(p.mp).toBe(mp0);
  });

  it("AC-11 전사 회전베기는 주변 몬스터를 모두 벤다", () => {
    const w = makeWorld();
    const p = addPlayer(w, "warrior");
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const a = spawn(w, "bear", "field", s.x + 1, s.y);
    const b = spawn(w, "bear", "field", s.x - 1, s.y + 1);
    const far = spawn(w, "bear", "field", s.x + 2, s.y);
    w.skill(p, 2, 1000);
    expect(a.hp).toBeLessThan(a.def.hp);
    expect(b.hp).toBeLessThan(b.def.hp);
    expect(far.hp).toBe(far.def.hp);
  });

  it("AC-11 도사 치유는 자신과 주변 동료의 체력을 회복한다", () => {
    const w = makeWorld();
    const poet = addPlayer(w, "poet");
    const ally = addPlayer(w, "warrior");
    const s = openSpot("town");
    place(poet, "town", s.x, s.y);
    place(ally, "town", s.x + 1, s.y);
    poet.hp = 5;
    ally.hp = 5;
    w.skill(poet, 1, 1000);
    expect(poet.hp).toBeGreaterThan(5);
    expect(ally.hp).toBeGreaterThan(5);
  });

  it("AC-11 도적 비영보는 앞으로 여러 칸 이동한다", () => {
    const w = makeWorld();
    const p = addPlayer(w, "rogue");
    const s = openSpot("town", 3);
    place(p, "town", s.x - 3, s.y, "right");
    const x0 = p.x;
    w.skill(p, 2, 1000);
    expect(p.x - x0).toBe(3);
  });

  it("AC-11 원거리 스킬은 막힌 지형 너머의 몬스터를 맞히지 못한다", () => {
    const w = makeWorld();
    const p = addPlayer(w, "mage");
    const m = MAPS.field;
    // [빈칸][막힘][빈칸] 가로 패턴 찾기
    let spot: { x: number; y: number } | undefined;
    for (let y = 1; y < m.height - 1 && !spot; y++)
      for (let x = 1; x < m.width - 3 && !spot; x++)
        if (!m.collision[y][x] && m.collision[y][x + 1] && !m.collision[y][x + 2]) spot = { x, y };
    place(p, "field", spot!.x, spot!.y, "right");
    const behind = spawn(w, "bear", "field", spot!.x + 2, spot!.y);
    w.drain();
    w.skill(p, 1, 1000);
    expect(errors(w, p.id)).toContain("no_target");
    expect(behind.hp).toBe(behind.def.hp);
  });
});
