import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MAPS } from "../shared/maps";
import { Storage } from "../server/storage";
import { World } from "../server/world";
import { addPlayer, makeWorld, openSpot, place } from "./helpers";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "pungun-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("AC-14 저장", () => {
  it("AC-14 캐릭터를 저장하고 그대로 불러온다", () => {
    const st = new Storage(tmp());
    const c = { ...World.newCharacter("저장왕", "mage"), level: 7, exp: 123, gold: 999, map: "field", x: 3, y: 23, weapon: "oak_staff" };
    c.inventory[2] = { item: "wolf_fang", qty: 4 };
    st.save(c);
    expect(st.load("저장왕")).toEqual(c);
    expect(st.load("없는사람")).toBeNull();
  });

  it("AC-14 손상된 저장 파일은 무시한다", () => {
    const dir = tmp();
    const st = new Storage(dir);
    fs.writeFileSync(path.join(dir, "characters", `${encodeURIComponent("망가짐")}.json`), "{oops");
    expect(st.load("망가짐")).toBeNull();
  });

  it("AC-14 월드에서 뺀 캐릭터를 다시 넣으면 레벨·경험치·위치·인벤토리가 유지된다", () => {
    const w = makeWorld();
    const p = addPlayer(w, "rogue", "유지왕");
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "left");
    p.level = 5;
    p.exp = 40;
    p.gold = 321;
    p.inventory[7] = { item: "fox_pelt", qty: 9 };
    p.weapon = "wood_sword";
    const save = w.removePlayer(p.id)!;
    const w2 = makeWorld();
    const q = w2.addPlayer(JSON.parse(JSON.stringify(save)), 0);
    expect([q.map, q.x, q.y, q.dir, q.level, q.exp, q.gold, q.weapon]).toEqual(["field", s.x, s.y, "left", 5, 40, 321, "wood_sword"]);
    expect(q.inventory[7]).toEqual({ item: "fox_pelt", qty: 9 });
  });

  it("AC-14 사망 중에 저장되면 마을에서 부활한 상태로 저장된다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "cave", 5, 23);
    w.damagePlayer(p, 99999, 0);
    const save = w.toSave(p);
    expect([save.map, save.x, save.y]).toEqual(["town", MAPS.town.entry.x, MAPS.town.entry.y]);
    expect(save.hp).toBeGreaterThan(0);
  });

  it("AC-14 잘못된 저장 데이터(막힌 칸·없는 아이템)는 안전하게 보정한다", () => {
    const w = makeWorld();
    const bad = { ...World.newCharacter("보정", "poet"), map: "nowhere", x: 0, y: 0, weapon: "potion_red" };
    bad.inventory[1] = { item: "dragon_ball", qty: 3 };
    const p = w.addPlayer(bad, 0);
    expect([p.map, p.x, p.y]).toEqual(["town", MAPS.town.entry.x, MAPS.town.entry.y]);
    expect(p.inventory[1]).toBeNull();
    expect(p.weapon).toBeNull();
  });
});
