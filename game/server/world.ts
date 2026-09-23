// 권위 서버의 게임 월드. 네트워크와 분리된 순수 상태 머신으로, 시간(now)과 난수(rng)를 주입받는다.
import {
  ATTACK_INTERVAL_MS, CHAT_MAX, GROUND_ITEM_TTL_MS, INVENTORY_SIZE, ITEMS, MONSTER_AGGRO_RANGE, MONSTER_ATTACK_MS,
  MONSTER_CHASE_MS, MONSTER_LEASH_RANGE, MONSTER_WANDER_MS, MONSTERS, MOVE_INTERVAL_MS, PLAYER_RESPAWN_MS,
  REGEN_INTERVAL_MS, REGEN_RATIO, SHOP_RANGE, SKILLS, STACK_MAX, TALK_RANGE, type MonsterDef,
} from "../shared/balance";
import { MAPS, START_MAP, isBlocked, portalAt, type MapData, type NpcDef } from "../shared/maps";
import { addExp, calcDamage, computeStats, deathExp, makeRng, randInt, type Rng } from "../shared/rules";
import {
  DIR_DELTA, DIRS, type ClientMsg, type Dir, type FxMsg, type InvSlot, type ItemView, type Job, type MonsterView,
  type PlayerView, type SelfMsg, type ServerMsg, type SnapshotMsg, type Stats, type WelcomeMsg,
} from "../shared/types";

export interface CharacterSave {
  name: string;
  job: Job;
  level: number;
  exp: number;
  hp: number;
  mp: number;
  map: string;
  x: number;
  y: number;
  dir: Dir;
  gold: number;
  inventory: (InvSlot | null)[];
  weapon: string | null;
}

export interface Player extends CharacterSave {
  id: number;
  dead: boolean;
  deadAt: number;
  lastMoveAt: number;
  pendingDir: Dir | null;
  lastAttackAt: number;
  lastRegenAt: number;
  cooldowns: Record<number, number>;
  dirty: boolean;
}

export interface Monster {
  id: number;
  kind: string;
  def: MonsterDef;
  map: string;
  x: number;
  y: number;
  dir: Dir;
  hp: number;
  alive: boolean;
  respawnAt: number;
  nextActAt: number;
  lastAttackAt: number;
  targetId: number | null;
  spawn: { x: number; y: number; w: number; h: number } | null;
}

export interface GroundItem {
  id: number;
  item: string;
  qty: number;
  map: string;
  x: number;
  y: number;
  expiresAt: number;
}

export type Outgoing = { to: "player"; id: number; msg: ServerMsg } | { to: "map"; map: string; msg: ServerMsg };

export interface WorldOptions {
  rng?: Rng;
  now?: number;
  testHooks?: boolean;
  spawnMonsters?: boolean;
}

const dist = (ax: number, ay: number, bx: number, by: number) => Math.abs(ax - bx) + Math.abs(ay - by);
const cheb = (ax: number, ay: number, bx: number, by: number) => Math.max(Math.abs(ax - bx), Math.abs(ay - by));

export class World {
  readonly players = new Map<number, Player>();
  readonly monsters = new Map<number, Monster>();
  readonly items = new Map<number, GroundItem>();
  readonly rng: Rng;
  readonly testHooks: boolean;
  tickCount = 0;
  private nextId = 1;
  private outbox: Outgoing[] = [];
  /** 맵별 몬스터 점유 격자 (칸 → 몬스터 id, 0 은 빈칸) */
  private occ = new Map<string, Int32Array>();

  constructor(opts: WorldOptions = {}) {
    this.rng = opts.rng ?? makeRng(Date.now() & 0xffffffff);
    this.testHooks = opts.testHooks ?? false;
    for (const m of Object.values(MAPS)) this.occ.set(m.id, new Int32Array(m.width * m.height));
    if (opts.spawnMonsters !== false) this.spawnAllMonsters(opts.now ?? 0);
  }

  // ---------- 캐릭터 ----------

  static newCharacter(name: string, job: Job): CharacterSave {
    const m = MAPS[START_MAP];
    const s = computeStats(job, 1, 0, Infinity, Infinity, null);
    return {
      name, job, level: 1, exp: 0, hp: s.maxHp, mp: s.maxMp, map: m.id, x: m.entry.x, y: m.entry.y, dir: "down",
      gold: 50, inventory: [{ item: "potion_red", qty: 3 }, ...Array<null>(INVENTORY_SIZE - 1).fill(null)], weapon: null,
    };
  }

  addPlayer(save: CharacterSave, now: number): Player {
    let map = MAPS[save.map] ? save.map : START_MAP;
    let { x, y } = save;
    const m = MAPS[map];
    if (!Number.isInteger(x) || !Number.isInteger(y) || isBlocked(m, x, y) || portalAt(m, x, y)) {
      map = START_MAP;
      ({ x, y } = MAPS[START_MAP].entry);
    }
    const inventory = Array.from({ length: INVENTORY_SIZE }, (_, i) => {
      const s = save.inventory?.[i];
      return s && ITEMS[s.item] && s.qty > 0 ? { item: s.item, qty: Math.min(s.qty, STACK_MAX) } : null;
    });
    const p: Player = {
      ...save, map, x, y, inventory,
      weapon: save.weapon && ITEMS[save.weapon]?.type === "weapon" ? save.weapon : null,
      id: this.nextId++, dead: false, deadAt: 0, lastMoveAt: -Infinity, pendingDir: null, lastAttackAt: -Infinity,
      lastRegenAt: now, cooldowns: {}, dirty: true,
    };
    const st = this.stats(p);
    if (p.hp <= 0) p.hp = st.maxHp;
    p.hp = Math.min(p.hp, st.maxHp);
    p.mp = Math.min(Math.max(0, p.mp), st.maxMp);
    this.players.set(p.id, p);
    return p;
  }

  removePlayer(id: number): CharacterSave | null {
    const p = this.players.get(id);
    if (!p) return null;
    this.players.delete(id);
    for (const m of this.monsters.values()) if (m.targetId === id) m.targetId = null;
    return this.toSave(p);
  }

  findPlayerByName(name: string): Player | undefined {
    for (const p of this.players.values()) if (p.name === name) return p;
    return undefined;
  }

  toSave(p: Player): CharacterSave {
    // 사망 상태로 저장되면 마을에서 부활한 상태로 기록한다.
    if (p.dead) {
      const st = this.stats(p);
      const e = MAPS[START_MAP].entry;
      return { ...this.plain(p), hp: st.maxHp, mp: st.maxMp, map: START_MAP, x: e.x, y: e.y };
    }
    return this.plain(p);
  }

  private plain(p: Player): CharacterSave {
    return {
      name: p.name, job: p.job, level: p.level, exp: p.exp, hp: p.hp, mp: p.mp, map: p.map, x: p.x, y: p.y, dir: p.dir,
      gold: p.gold, inventory: p.inventory.map((s) => (s ? { ...s } : null)), weapon: p.weapon,
    };
  }

  stats(p: Player): Stats {
    return computeStats(p.job, p.level, p.exp, p.hp, p.mp, p.weapon);
  }

  welcome(p: Player): WelcomeMsg {
    return { t: "welcome", id: p.id, name: p.name, job: p.job, map: p.map, x: p.x, y: p.y, dir: p.dir, stats: this.stats(p) };
  }

  selfMsg(p: Player, now: number): SelfMsg {
    const cooldowns: Record<number, number> = {};
    for (const [slot, readyAt] of Object.entries(p.cooldowns)) cooldowns[Number(slot)] = Math.max(0, readyAt - now);
    return {
      t: "self", map: p.map, x: p.x, y: p.y, dir: p.dir, dead: p.dead, stats: this.stats(p), gold: p.gold,
      inventory: p.inventory.map((s) => (s ? { ...s } : null)), weapon: p.weapon, cooldowns,
    };
  }

  snapshot(mapId: string): SnapshotMsg {
    const players: PlayerView[] = [];
    for (const p of this.players.values()) {
      if (p.map !== mapId) continue;
      const st = this.stats(p);
      players.push({ id: p.id, name: p.name, x: p.x, y: p.y, dir: p.dir, hp: p.hp, maxHp: st.maxHp, level: p.level, job: p.job, dead: p.dead });
    }
    const monsters: MonsterView[] = [];
    for (const m of this.monsters.values())
      if (m.alive && m.map === mapId) monsters.push({ id: m.id, kind: m.kind, x: m.x, y: m.y, hp: m.hp, maxHp: m.def.hp, dir: m.dir });
    const items: ItemView[] = [];
    for (const it of this.items.values()) if (it.map === mapId) items.push({ id: it.id, item: it.item, qty: it.qty, x: it.x, y: it.y });
    return { t: "snapshot", map: mapId, tick: this.tickCount, players, monsters, items };
  }

  drain(): Outgoing[] {
    const o = this.outbox;
    this.outbox = [];
    return o;
  }

  private toPlayer(id: number, msg: ServerMsg) { this.outbox.push({ to: "player", id, msg }); }
  private toMap(map: string, msg: ServerMsg) { this.outbox.push({ to: "map", map, msg }); }
  private error(id: number, code: string, message: string) { this.toPlayer(id, { t: "error", code, message }); }
  private fx(map: string, fx: Omit<FxMsg, "t">) { this.toMap(map, { t: "fx", ...fx }); }

  // ---------- 입력 처리 ----------

  handle(id: number, msg: ClientMsg, now: number): void {
    const p = this.players.get(id);
    if (!p) return;
    if (msg.t === "chat") return this.chat(p, msg.text);
    if (p.dead && msg.t !== "login") return this.error(id, "dead", "사망 상태입니다. 잠시 후 마을에서 부활합니다");
    switch (msg.t) {
      case "login": return this.error(id, "already_logged_in", "이미 접속 중입니다");
      case "move": this.requestMove(p, msg.dir, now); return;
      case "attack": return this.attack(p, now);
      case "skill": return this.skill(p, msg.slot, now);
      case "pickup": return this.pickup(p);
      case "use": return this.use(p, msg.slot);
      case "unequip": return this.unequip(p);
      case "talk": return this.talk(p);
      case "buy": return this.buy(p, msg.npc, msg.item, msg.qty);
      case "sell": return this.sell(p, msg.npc, msg.slot, msg.qty);
      case "debug": return this.debug(p, msg.kind, now);
    }
  }

  private chat(p: Player, raw: string) {
    const text = raw.trim();
    if (!text || raw.length > CHAT_MAX) return this.error(p.id, "bad_chat", "채팅 내용이 올바르지 않습니다");
    this.toMap(p.map, { t: "chat", from: p.name, text });
  }

  // ---------- 이동 ----------

  /** 이동 요청: 이동 간격이 지나지 않았으면 마지막 방향 하나만 예약한다(과속 입력 무시). */
  requestMove(p: Player, dir: Dir, now: number): boolean {
    if (now - p.lastMoveAt < MOVE_INTERVAL_MS) {
      p.pendingDir = dir;
      return false;
    }
    return this.step(p, dir, now);
  }

  private step(p: Player, dir: Dir, now: number): boolean {
    p.pendingDir = null;
    if (p.dir !== dir) { p.dir = dir; p.dirty = true; }
    const [dx, dy] = DIR_DELTA[dir];
    const nx = p.x + dx, ny = p.y + dy;
    if (!this.playerCanEnter(p.map, nx, ny)) return false;
    p.x = nx; p.y = ny; p.lastMoveAt = now; p.dirty = true;
    const portal = portalAt(MAPS[p.map], nx, ny);
    if (portal) this.teleport(p, portal.to, portal.tx, portal.ty);
    return true;
  }

  teleport(p: Player, map: string, x: number, y: number) {
    const from = p.map;
    p.map = map; p.x = x; p.y = y; p.dirty = true;
    for (const m of this.monsters.values()) if (m.targetId === p.id) m.targetId = null;
    if (from !== map) this.fx(map, { kind: "portal", x, y, text: MAPS[map].name });
  }

  playerCanEnter(map: string, x: number, y: number): boolean {
    const m = MAPS[map];
    return !isBlocked(m, x, y) && this.monsterAt(map, x, y) === undefined;
  }

  private monsterCanEnter(map: string, x: number, y: number): boolean {
    const m = MAPS[map];
    if (isBlocked(m, x, y) || portalAt(m, x, y) || this.monsterAt(map, x, y)) return false;
    for (const p of this.players.values()) if (p.map === map && p.x === x && p.y === y && !p.dead) return false;
    return true;
  }

  monsterAt(map: string, x: number, y: number): Monster | undefined {
    const m = MAPS[map];
    if (x < 0 || y < 0 || x >= m.width || y >= m.height) return undefined;
    const id = this.occ.get(map)![y * m.width + x];
    return id ? this.monsters.get(id) : undefined;
  }

  private setOcc(mon: Monster, on: boolean) {
    const m = MAPS[mon.map];
    this.occ.get(mon.map)![mon.y * m.width + mon.x] = on ? mon.id : 0;
  }

  private moveMonster(mon: Monster, x: number, y: number) {
    this.setOcc(mon, false);
    mon.x = x; mon.y = y;
    this.setOcc(mon, true);
  }

  // ---------- 전투 ----------

  private facing(p: { x: number; y: number; dir: Dir }): [number, number] {
    const [dx, dy] = DIR_DELTA[p.dir];
    return [p.x + dx, p.y + dy];
  }

  attack(p: Player, now: number) {
    if (now - p.lastAttackAt < ATTACK_INTERVAL_MS) return;
    p.lastAttackAt = now;
    const [tx, ty] = this.facing(p);
    const mon = this.monsterAt(p.map, tx, ty);
    if (!mon) {
      this.fx(p.map, { kind: "miss", x: tx, y: ty, target: `p:${p.id}` });
      return;
    }
    const dmg = calcDamage(this.stats(p).atk, mon.def.def, this.rng);
    this.hitMonster(mon, p, dmg, now);
  }

  private hitMonster(mon: Monster, p: Player, dmg: number, now: number) {
    mon.hp -= dmg;
    mon.targetId = p.id;
    this.fx(mon.map, { kind: "hit", x: mon.x, y: mon.y, amount: dmg, target: `m:${mon.id}` });
    if (mon.hp <= 0) this.killMonster(mon, p, now);
  }

  private killMonster(mon: Monster, killer: Player, now: number) {
    mon.alive = false;
    mon.hp = 0;
    mon.targetId = null;
    this.setOcc(mon, false);
    if (mon.spawn) mon.respawnAt = now + mon.def.respawnMs;
    else this.monsters.delete(mon.id);
    this.fx(mon.map, { kind: "kill", x: mon.x, y: mon.y, target: `m:${mon.id}`, text: mon.def.name });
    this.gainExp(killer, mon.def.exp);
    killer.gold += randInt(this.rng, mon.def.gold[0], mon.def.gold[1]);
    killer.dirty = true;
    for (const d of mon.def.drops) {
      if (this.rng() < d.chance) {
        const id = this.nextId++;
        this.items.set(id, { id, item: d.item, qty: 1, map: mon.map, x: mon.x, y: mon.y, expiresAt: now + GROUND_ITEM_TTL_MS });
      }
    }
  }

  gainExp(p: Player, amount: number) {
    const r = addExp(p.level, p.exp, amount);
    p.level = r.level;
    p.exp = r.exp;
    p.dirty = true;
    if (r.levelsGained > 0) {
      const st = this.stats(p);
      p.hp = st.maxHp;
      p.mp = st.maxMp;
      this.fx(p.map, { kind: "levelup", x: p.x, y: p.y, target: `p:${p.id}`, amount: p.level });
    }
  }

  damagePlayer(p: Player, dmg: number, now: number) {
    if (p.dead) return;
    p.hp = Math.max(0, p.hp - dmg);
    p.dirty = true;
    this.fx(p.map, { kind: "hit", x: p.x, y: p.y, amount: dmg, target: `p:${p.id}` });
    if (p.hp === 0) {
      p.dead = true;
      p.deadAt = now;
      p.pendingDir = null;
      p.exp = deathExp(p.level, p.exp);
      for (const m of this.monsters.values()) if (m.targetId === p.id) m.targetId = null;
      this.fx(p.map, { kind: "death", x: p.x, y: p.y, target: `p:${p.id}` });
    }
  }

  private respawnPlayer(p: Player) {
    const st = this.stats(p);
    p.dead = false;
    p.hp = st.maxHp;
    p.mp = st.maxMp;
    const e = MAPS[START_MAP].entry;
    this.teleport(p, START_MAP, e.x, e.y);
    p.dir = "down";
  }

  skill(p: Player, slot: number, now: number) {
    const def = SKILLS[p.job][slot - 1];
    if (!def) return this.error(p.id, "bad_skill", "배우지 않은 스킬입니다");
    if ((p.cooldowns[slot] ?? 0) > now) return this.error(p.id, "cooldown", `${def.name}: 재사용 대기 중`);
    if (p.mp < def.mp) return this.error(p.id, "no_mp", "마력이 부족합니다");
    const st = this.stats(p);
    const power = def.stat === "atk" ? st.atk : st.mag;
    let targets: Monster[] = [];
    const m = MAPS[p.map];
    switch (def.kind) {
      case "melee": {
        const [tx, ty] = this.facing(p);
        const t = this.monsterAt(p.map, tx, ty);
        if (t) targets = [t];
        break;
      }
      case "sweep":
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const t = (dx || dy) ? this.monsterAt(p.map, p.x + dx, p.y + dy) : undefined;
            if (t) targets.push(t);
          }
        break;
      case "ranged": {
        const [dx, dy] = DIR_DELTA[p.dir];
        for (let i = 1; i <= def.range; i++) {
          const x = p.x + dx * i, y = p.y + dy * i;
          if (isBlocked(m, x, y)) break;
          const t = this.monsterAt(p.map, x, y);
          if (t) { targets = [t]; break; }
        }
        break;
      }
      case "aoe":
        for (const t of this.monsters.values())
          if (t.alive && t.map === p.map && cheb(t.x, t.y, p.x, p.y) <= def.range) targets.push(t);
        break;
      case "heal":
      case "dash":
        break;
    }
    if ((def.kind === "melee" || def.kind === "sweep" || def.kind === "ranged" || def.kind === "aoe") && targets.length === 0)
      return this.error(p.id, "no_target", `${def.name}: 대상이 없습니다`);
    if (def.kind === "dash") {
      let moved = 0;
      for (let i = 0; i < def.range; i++) {
        const before = p.map;
        if (!this.step(p, p.dir, now)) break;
        moved++;
        if (p.map !== before) break;
      }
      if (moved === 0) return this.error(p.id, "blocked", "앞이 막혀 있습니다");
    }
    p.mp -= def.mp;
    p.cooldowns[slot] = now + def.cooldownMs;
    p.dirty = true;
    this.fx(p.map, { kind: "skill", x: p.x, y: p.y, target: `p:${p.id}`, text: def.name });
    if (def.kind === "heal") {
      const amount = Math.round(power * def.mult + 10);
      for (const o of this.players.values()) {
        if (o.map !== p.map || o.dead || cheb(o.x, o.y, p.x, p.y) > def.range) continue;
        const max = this.stats(o).maxHp;
        const healed = Math.min(amount, max - o.hp);
        o.hp += healed;
        o.dirty = true;
        this.fx(o.map, { kind: "heal", x: o.x, y: o.y, amount: healed, target: `p:${o.id}` });
      }
      return;
    }
    for (const t of targets) this.hitMonster(t, p, calcDamage(power, t.def.def, this.rng, def.mult), now);
  }

  // ---------- 아이템 ----------

  /** 인벤토리에 넣는다. 전부 들어갈 수 있을 때만 넣고 true 를 반환한다. */
  addItem(p: Player, item: string, qty: number): boolean {
    const def = ITEMS[item];
    if (!def || qty <= 0) return false;
    const inv = p.inventory.map((s) => (s ? { ...s } : null));
    let left = qty;
    if (def.type !== "weapon") {
      for (const s of inv) {
        if (!left) break;
        if (s && s.item === item && s.qty < STACK_MAX) {
          const add = Math.min(left, STACK_MAX - s.qty);
          s.qty += add;
          left -= add;
        }
      }
    }
    for (let i = 0; i < inv.length && left > 0; i++) {
      if (inv[i]) continue;
      const add = def.type === "weapon" ? 1 : Math.min(left, STACK_MAX);
      inv[i] = { item, qty: add };
      left -= add;
    }
    if (left > 0) return false;
    p.inventory = inv;
    p.dirty = true;
    return true;
  }

  private removeFromSlot(p: Player, slot: number, qty: number) {
    const s = p.inventory[slot]!;
    s.qty -= qty;
    if (s.qty <= 0) p.inventory[slot] = null;
    p.dirty = true;
  }

  pickup(p: Player) {
    const [fx, fy] = this.facing(p);
    let got = 0, full = false;
    for (const it of [...this.items.values()]) {
      if (it.map !== p.map || !((it.x === p.x && it.y === p.y) || (it.x === fx && it.y === fy))) continue;
      if (this.addItem(p, it.item, it.qty)) {
        this.items.delete(it.id);
        got++;
        this.fx(p.map, { kind: "pickup", x: it.x, y: it.y, target: `p:${p.id}`, text: ITEMS[it.item].name });
      } else full = true;
    }
    if (full) this.error(p.id, "inventory_full", "인벤토리가 가득 찼습니다");
    else if (!got) this.error(p.id, "nothing", "주울 물건이 없습니다");
  }

  use(p: Player, slot: number) {
    const s = p.inventory[slot];
    if (!s) return this.error(p.id, "empty_slot", "빈 칸입니다");
    const def = ITEMS[s.item];
    if (def.type === "consumable") {
      const st = this.stats(p);
      if ((def.heal && p.hp < st.maxHp) || (def.mana && p.mp < st.maxMp)) {
        if (def.heal) p.hp = Math.min(st.maxHp, p.hp + def.heal);
        if (def.mana) p.mp = Math.min(st.maxMp, p.mp + def.mana);
        this.removeFromSlot(p, slot, 1);
        this.fx(p.map, { kind: "heal", x: p.x, y: p.y, amount: def.heal ?? def.mana, target: `p:${p.id}` });
        return;
      }
      return this.error(p.id, "no_effect", "지금은 효과가 없습니다");
    }
    if (def.type === "weapon") {
      const old = p.weapon;
      p.weapon = def.id;
      p.inventory[slot] = old ? { item: old, qty: 1 } : null;
      p.dirty = true;
      return;
    }
    this.error(p.id, "not_usable", "사용할 수 없는 물건입니다");
  }

  unequip(p: Player) {
    if (!p.weapon) return this.error(p.id, "no_weapon", "장착한 무기가 없습니다");
    const free = p.inventory.findIndex((s) => !s);
    if (free < 0) return this.error(p.id, "inventory_full", "인벤토리가 가득 찼습니다");
    p.inventory[free] = { item: p.weapon, qty: 1 };
    p.weapon = null;
    p.dirty = true;
  }

  // ---------- NPC·상점 ----------

  private npcNear(p: Player, range: number, id?: string): NpcDef | undefined {
    const npcs = MAPS[p.map].npcs.filter((n) => (id === undefined || n.id === id) && cheb(n.x, n.y, p.x, p.y) <= range);
    const [fx, fy] = this.facing(p);
    return npcs.find((n) => n.x === fx && n.y === fy) ?? npcs[0];
  }

  talk(p: Player) {
    const n = this.npcNear(p, TALK_RANGE);
    if (!n) return this.error(p.id, "no_npc", "가까이에 말을 걸 사람이 없습니다");
    this.toPlayer(p.id, {
      t: "dialog", npc: n.id, name: n.name, text: n.text,
      shop: n.shop ? n.shop.map((item) => ({ item, price: ITEMS[item].price })) : null,
    });
  }

  buy(p: Player, npcId: string, item: string, qty: number) {
    const n = this.npcNear(p, SHOP_RANGE, npcId);
    if (!n || !n.shop) return this.error(p.id, "no_shop", "상점 주인이 가까이 없습니다");
    if (!n.shop.includes(item)) return this.error(p.id, "not_sold", "팔지 않는 물건입니다");
    const cost = ITEMS[item].price * qty;
    if (p.gold < cost) return this.error(p.id, "no_gold", "전(錢)이 부족합니다");
    if (!this.addItem(p, item, qty)) return this.error(p.id, "inventory_full", "인벤토리가 가득 찼습니다");
    p.gold -= cost;
    p.dirty = true;
  }

  sell(p: Player, npcId: string, slot: number, qty: number) {
    const n = this.npcNear(p, SHOP_RANGE, npcId);
    if (!n || !n.shop) return this.error(p.id, "no_shop", "상점 주인이 가까이 없습니다");
    const s = p.inventory[slot];
    if (!s) return this.error(p.id, "empty_slot", "빈 칸입니다");
    if (qty > s.qty) return this.error(p.id, "bad_qty", "수량이 부족합니다");
    p.gold += ITEMS[s.item].sell * qty;
    this.removeFromSlot(p, slot, qty);
  }

  private debug(p: Player, kind: string, now: number) {
    if (!this.testHooks) return this.error(p.id, "unknown_type", "알 수 없는 메시지 종류입니다");
    const def = MONSTERS[kind];
    const [x, y] = this.facing(p);
    if (!def || !this.monsterCanEnter(p.map, x, y)) return this.error(p.id, "bad_debug", "소환할 수 없습니다");
    this.spawnMonster(def, p.map, x, y, null, now);
  }

  // ---------- 몬스터 ----------

  spawnMonster(def: MonsterDef, map: string, x: number, y: number, spawn: Monster["spawn"], now: number): Monster {
    const mon: Monster = {
      id: this.nextId++, kind: def.kind, def, map, x, y, dir: "down", hp: def.hp, alive: true, respawnAt: 0,
      nextActAt: now + this.rng() * MONSTER_WANDER_MS, lastAttackAt: -Infinity, targetId: null, spawn,
    };
    this.monsters.set(mon.id, mon);
    this.setOcc(mon, true);
    return mon;
  }

  private spawnAllMonsters(now: number) {
    for (const m of Object.values(MAPS))
      for (const s of m.spawns)
        for (let i = 0; i < s.count; i++) {
          const pos = this.freeTileIn(m, s.area);
          if (pos) this.spawnMonster(MONSTERS[s.kind], m.id, pos.x, pos.y, s.area, now);
        }
  }

  private freeTileIn(m: MapData, a: { x: number; y: number; w: number; h: number }): { x: number; y: number } | null {
    for (let tries = 0; tries < 200; tries++) {
      const x = a.x + Math.floor(this.rng() * a.w), y = a.y + Math.floor(this.rng() * a.h);
      if (this.monsterCanEnter(m.id, x, y)) return { x, y };
    }
    return null;
  }

  private monsterStepToward(mon: Monster, tx: number, ty: number): boolean {
    const dx = Math.sign(tx - mon.x), dy = Math.sign(ty - mon.y);
    const opts: Dir[] = [];
    const h: Dir | null = dx > 0 ? "right" : dx < 0 ? "left" : null;
    const v: Dir | null = dy > 0 ? "down" : dy < 0 ? "up" : null;
    if (Math.abs(tx - mon.x) >= Math.abs(ty - mon.y)) { if (h) opts.push(h); if (v) opts.push(v); }
    else { if (v) opts.push(v); if (h) opts.push(h); }
    for (const d of opts) if (this.tryMonsterStep(mon, d)) return true;
    return false;
  }

  private tryMonsterStep(mon: Monster, d: Dir, area?: Monster["spawn"]): boolean {
    mon.dir = d;
    const [dx, dy] = DIR_DELTA[d];
    const nx = mon.x + dx, ny = mon.y + dy;
    if (area && (nx < area.x - 2 || ny < area.y - 2 || nx >= area.x + area.w + 2 || ny >= area.y + area.h + 2)) return false;
    if (!this.monsterCanEnter(mon.map, nx, ny)) return false;
    this.moveMonster(mon, nx, ny);
    return true;
  }

  private monsterAct(mon: Monster, now: number) {
    let target = mon.targetId !== null ? this.players.get(mon.targetId) : undefined;
    if (target && (target.dead || target.map !== mon.map || dist(target.x, target.y, mon.x, mon.y) > MONSTER_LEASH_RANGE)) {
      target = undefined;
      mon.targetId = null;
    }
    if (!target && mon.def.aggressive) {
      let best = MONSTER_AGGRO_RANGE + 1;
      for (const p of this.players.values()) {
        if (p.map !== mon.map || p.dead) continue;
        const d = dist(p.x, p.y, mon.x, mon.y);
        if (d < best) { best = d; target = p; }
      }
      if (target) mon.targetId = target.id;
    }
    if (target) {
      mon.nextActAt = now + MONSTER_CHASE_MS;
      if (dist(target.x, target.y, mon.x, mon.y) === 1) {
        mon.dir = target.x > mon.x ? "right" : target.x < mon.x ? "left" : target.y > mon.y ? "down" : "up";
        if (now - mon.lastAttackAt >= MONSTER_ATTACK_MS) {
          mon.lastAttackAt = now;
          this.damagePlayer(target, calcDamage(mon.def.atk, this.stats(target).def, this.rng), now);
        }
      } else this.monsterStepToward(mon, target.x, target.y);
      return;
    }
    mon.nextActAt = now + MONSTER_WANDER_MS * (0.6 + this.rng() * 0.8);
    if (this.rng() < 0.5) this.tryMonsterStep(mon, DIRS[Math.floor(this.rng() * 4)], mon.spawn);
  }

  // ---------- 틱 ----------

  tick(now: number): void {
    this.tickCount++;
    for (const p of this.players.values()) {
      if (p.dead) {
        if (now - p.deadAt >= PLAYER_RESPAWN_MS) this.respawnPlayer(p);
        continue;
      }
      if (p.pendingDir && now - p.lastMoveAt >= MOVE_INTERVAL_MS) this.step(p, p.pendingDir, now);
      if (now - p.lastRegenAt >= REGEN_INTERVAL_MS) {
        p.lastRegenAt = now;
        const st = this.stats(p);
        if (p.hp < st.maxHp || p.mp < st.maxMp) {
          p.hp = Math.min(st.maxHp, p.hp + Math.ceil(st.maxHp * REGEN_RATIO));
          p.mp = Math.min(st.maxMp, p.mp + Math.ceil(st.maxMp * REGEN_RATIO));
          p.dirty = true;
        }
      }
    }
    for (const mon of this.monsters.values()) {
      if (!mon.alive) {
        if (mon.spawn && now >= mon.respawnAt) {
          const pos = this.freeTileIn(MAPS[mon.map], mon.spawn);
          if (pos) {
            Object.assign(mon, { x: pos.x, y: pos.y, hp: mon.def.hp, alive: true, targetId: null, nextActAt: now + 500 });
            this.setOcc(mon, true);
          }
        }
        continue;
      }
      if (now >= mon.nextActAt) this.monsterAct(mon, now);
    }
    for (const it of this.items.values()) if (now >= it.expiresAt) this.items.delete(it.id);
  }
}
