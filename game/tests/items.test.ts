import { describe, expect, it } from "vitest";
import { INVENTORY_SIZE, ITEMS, STACK_MAX } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { addPlayer, errors, makeWorld, openSpot, place, spawn } from "./helpers";

describe("AC-12 아이템", () => {
  it("AC-12 몬스터는 드롭 테이블에 따라 물건을 떨어뜨린다", () => {
    const w = makeWorld({ rng: () => 0 }); // 모든 드롭 확률 통과
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const m = spawn(w, "squirrel", "field", s.x + 1, s.y);
    m.hp = 1;
    w.attack(p, 1000);
    const dropped = [...w.items.values()].map((i) => i.item).sort();
    expect(dropped).toEqual(["potion_red", "squirrel_tail"]);
    expect(w.snapshot("field").items).toHaveLength(2);
  });

  it("AC-12 확률이 빗나가면 떨어뜨리지 않는다", () => {
    const w = makeWorld({ rng: () => 0.99 });
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const m = spawn(w, "squirrel", "field", s.x + 1, s.y);
    m.hp = 1;
    w.attack(p, 1000);
    expect(w.items.size).toBe(0);
  });

  it("AC-12 바라보는 칸의 물건을 주워 인벤토리에 넣고, 같은 물건은 겹친다", () => {
    const w = makeWorld({ rng: () => 0 });
    const p = addPlayer(w);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    const m = spawn(w, "squirrel", "field", s.x + 1, s.y);
    m.hp = 1;
    w.attack(p, 1000);
    const potions0 = p.inventory.find((x) => x?.item === "potion_red")!.qty;
    w.pickup(p);
    expect(w.items.size).toBe(0);
    expect(p.inventory.find((x) => x?.item === "potion_red")!.qty).toBe(potions0 + 1);
    expect(p.inventory.find((x) => x?.item === "squirrel_tail")?.qty).toBe(1);
    w.drain();
    w.pickup(p);
    expect(errors(w, p.id)).toContain("nothing");
  });

  it("AC-12 인벤토리 칸 수 제한: 가득 차면 줍지 못하고 물건은 땅에 남는다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    expect(p.inventory).toHaveLength(INVENTORY_SIZE);
    for (let i = 0; i < INVENTORY_SIZE; i++) p.inventory[i] = { item: "wood_sword", qty: 1 };
    expect(w.addItem(p, "iron_sword", 1)).toBe(false);
    expect(w.addItem(p, "potion_blue", 1)).toBe(false);
    p.inventory[0] = { item: "potion_blue", qty: STACK_MAX - 1 };
    expect(w.addItem(p, "potion_blue", 2)).toBe(false);
    expect(w.addItem(p, "potion_blue", 1)).toBe(true);
    expect(p.inventory[0]!.qty).toBe(STACK_MAX);
    const s = openSpot("field");
    place(p, "field", s.x, s.y, "right");
    w.items.set(999, { id: 999, item: "fox_pelt", qty: 1, map: "field", x: s.x + 1, y: s.y, expiresAt: 1e9 });
    w.drain();
    w.pickup(p);
    expect(errors(w, p.id)).toContain("inventory_full");
    expect(w.items.has(999)).toBe(true);
  });

  it("AC-12 물약을 마시면 체력이 회복되고 개수가 줄어든다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const max = w.stats(p).maxHp;
    p.hp = 1;
    const slot = p.inventory.findIndex((x) => x?.item === "potion_red");
    const qty = p.inventory[slot]!.qty;
    w.use(p, slot);
    expect(p.hp).toBe(Math.min(max, 1 + ITEMS.potion_red.heal!));
    expect(p.inventory[slot]!.qty).toBe(qty - 1);
    p.hp = max;
    w.drain();
    w.use(p, slot);
    expect(errors(w, p.id)).toContain("no_effect");
    expect(p.inventory[slot]!.qty).toBe(qty - 1);
  });

  it("AC-12 무기를 장착하면 공격력이 오르고, 해제하면 돌아온다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const atk0 = w.stats(p).atk;
    p.inventory[5] = { item: "iron_sword", qty: 1 };
    w.use(p, 5);
    expect(p.weapon).toBe("iron_sword");
    expect(p.inventory[5]).toBeNull();
    expect(w.stats(p).atk).toBe(atk0 + ITEMS.iron_sword.atk!);
    p.inventory[6] = { item: "wood_sword", qty: 1 };
    w.use(p, 6);
    expect(p.weapon).toBe("wood_sword");
    expect(p.inventory[6]).toEqual({ item: "iron_sword", qty: 1 });
    w.unequip(p);
    expect(p.weapon).toBeNull();
    expect(w.stats(p).atk).toBe(atk0);
  });

  it("AC-12 무기를 장착하면 실제 데미지가 커진다", () => {
    const run = (weapon: string | null) => {
      const w = makeWorld({ rng: () => 0.5 });
      const p = addPlayer(w);
      p.weapon = weapon;
      const s = openSpot("field");
      place(p, "field", s.x, s.y, "right");
      const m = spawn(w, "goblin", "field", s.x + 1, s.y);
      w.attack(p, 1000);
      return m.def.hp - m.hp;
    };
    expect(run("iron_sword")).toBeGreaterThan(run(null));
  });

  it("AC-12 재료는 사용할 수 없다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    p.inventory[3] = { item: "fox_pelt", qty: 2 };
    w.drain();
    w.use(p, 3);
    expect(errors(w, p.id)).toContain("not_usable");
  });
});

describe("AC-13 NPC와 상점", () => {
  const jumo = MAPS.town.npcs.find((n) => n.id === "jumo")!;
  const elder = MAPS.town.npcs.find((n) => n.id === "elder")!;

  it("AC-13 가까운 NPC 에게 말을 걸면 대화와 상점 목록을 받는다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "town", jumo.x, jumo.y + 1, "up");
    w.drain();
    w.talk(p);
    const d = w.drain().find((o) => o.msg.t === "dialog")!.msg as { t: "dialog"; name: string; shop: { item: string; price: number }[] };
    expect(d.name).toBe("주모");
    expect(d.shop.map((s) => s.item)).toContain("potion_red");
    expect(d.shop.find((s) => s.item === "potion_red")!.price).toBe(ITEMS.potion_red.price);
    place(p, "town", elder.x + 1, elder.y, "left");
    w.talk(p);
    const e = w.drain().find((o) => o.msg.t === "dialog")!.msg as { name: string; shop: unknown };
    expect(e.name).toBe("촌장");
    expect(e.shop).toBeNull();
  });

  it("AC-13 멀리 있으면 대화할 수 없다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "town", 40, 23);
    w.drain();
    w.talk(p);
    expect(errors(w, p.id)).toContain("no_npc");
  });

  it("AC-13 전(錢)으로 물건을 산다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "town", jumo.x, jumo.y + 1, "up");
    p.gold = 100;
    w.buy(p, "jumo", "potion_blue", 2);
    expect(p.gold).toBe(100 - 2 * ITEMS.potion_blue.price);
    expect(p.inventory.find((s) => s?.item === "potion_blue")?.qty).toBe(2);
  });

  it("AC-13 돈이 모자라거나, 팔지 않는 물건이거나, 상점에서 멀면 살 수 없다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    place(p, "town", jumo.x, jumo.y + 1, "up");
    p.gold = 10;
    w.drain();
    w.buy(p, "jumo", "potion_red", 1);
    expect(errors(w, p.id)).toContain("no_gold");
    p.gold = 10_000;
    w.buy(p, "jumo", "iron_sword", 1);
    expect(errors(w, p.id)).toContain("not_sold");
    place(p, "town", 40, 23);
    w.buy(p, "jumo", "potion_red", 1);
    expect(errors(w, p.id)).toContain("no_shop");
    expect(p.gold).toBe(10_000);
  });

  it("AC-13 소지품을 상점에 팔면 판매가만큼 전을 받는다", () => {
    const w = makeWorld();
    const p = addPlayer(w);
    const smith = MAPS.town.npcs.find((n) => n.id === "smith")!;
    place(p, "town", smith.x, smith.y + 1, "up");
    p.gold = 0;
    p.inventory[4] = { item: "wolf_fang", qty: 3 };
    w.sell(p, "smith", 4, 2);
    expect(p.gold).toBe(2 * ITEMS.wolf_fang.sell);
    expect(p.inventory[4]).toEqual({ item: "wolf_fang", qty: 1 });
    w.drain();
    w.sell(p, "smith", 4, 5);
    expect(errors(w, p.id)).toContain("bad_qty");
    w.sell(p, "elder", 4, 1);
    expect(errors(w, p.id)).toContain("no_shop");
  });
});
