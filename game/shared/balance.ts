// 밸런스 상수 모음. 게임 수치는 여기서만 조정한다.
import type { Job } from "./types";

export const TILE = 32;
export const TICK_MS = 100;
export const MOVE_INTERVAL_MS = 200;
export const ATTACK_INTERVAL_MS = 350;
export const PLAYER_RESPAWN_MS = 3000;
export const REGEN_INTERVAL_MS = 3000;
export const REGEN_RATIO = 0.04;
export const DEATH_EXP_PENALTY = 0.05; // 다음 레벨 필요 경험치의 5% 손실
export const MAX_LEVEL = 99;
export const INVENTORY_SIZE = 20;
export const STACK_MAX = 99;
export const GROUND_ITEM_TTL_MS = 60_000;
export const CHAT_MAX = 200;
export const TALK_RANGE = 2;
export const SHOP_RANGE = 3;
export const AUTOSAVE_MS = 10_000;
export const RATE_LIMIT_PER_SEC = 30;
export const RATE_LIMIT_BURST = 80;

export const MONSTER_WANDER_MS = 1400;
export const MONSTER_CHASE_MS = 450;
export const MONSTER_ATTACK_MS = 1200;
export const MONSTER_AGGRO_RANGE = 5;
export const MONSTER_LEASH_RANGE = 12;

export interface JobDef {
  hp: number;
  mp: number;
  atk: number;
  def: number;
  mag: number;
  grow: { hp: number; mp: number; atk: number; def: number; mag: number };
}

export const JOB_DEFS: Record<Job, JobDef> = {
  warrior: { hp: 60, mp: 12, atk: 9, def: 5, mag: 2, grow: { hp: 14, mp: 2, atk: 3, def: 2, mag: 0.5 } },
  rogue: { hp: 46, mp: 16, atk: 8, def: 3, mag: 3, grow: { hp: 10, mp: 3, atk: 3.5, def: 1.2, mag: 0.8 } },
  mage: { hp: 34, mp: 40, atk: 4, def: 2, mag: 10, grow: { hp: 7, mp: 8, atk: 1, def: 1, mag: 3.5 } },
  poet: { hp: 40, mp: 36, atk: 5, def: 3, mag: 8, grow: { hp: 8, mp: 7, atk: 1.2, def: 1.2, mag: 3 } },
};

export type SkillKind = "melee" | "sweep" | "ranged" | "aoe" | "heal" | "dash";

export interface SkillDef {
  id: string;
  name: string;
  kind: SkillKind;
  mp: number;
  cooldownMs: number;
  mult: number;
  range: number;
  stat: "atk" | "mag";
}

export const SKILLS: Record<Job, SkillDef[]> = {
  warrior: [
    { id: "smash", name: "강타", kind: "melee", mp: 5, cooldownMs: 2000, mult: 2.0, range: 1, stat: "atk" },
    { id: "whirl", name: "회전베기", kind: "sweep", mp: 10, cooldownMs: 4000, mult: 1.3, range: 1, stat: "atk" },
  ],
  rogue: [
    { id: "vital", name: "급소찌르기", kind: "melee", mp: 6, cooldownMs: 2500, mult: 2.6, range: 1, stat: "atk" },
    { id: "shadowstep", name: "비영보", kind: "dash", mp: 8, cooldownMs: 5000, mult: 0, range: 3, stat: "atk" },
  ],
  mage: [
    { id: "fireball", name: "화염구", kind: "ranged", mp: 8, cooldownMs: 1500, mult: 1.8, range: 6, stat: "mag" },
    { id: "frost", name: "빙결진", kind: "aoe", mp: 16, cooldownMs: 5000, mult: 1.4, range: 2, stat: "mag" },
  ],
  poet: [
    { id: "heal", name: "치유", kind: "heal", mp: 10, cooldownMs: 3000, mult: 2.0, range: 3, stat: "mag" },
    { id: "thunder", name: "뇌격", kind: "ranged", mp: 8, cooldownMs: 2000, mult: 1.5, range: 4, stat: "mag" },
  ],
};

export type ItemType = "consumable" | "weapon" | "material";

export interface ItemDef {
  id: string;
  name: string;
  type: ItemType;
  price: number; // 상점 구매가
  sell: number; // 상점 판매가
  heal?: number;
  mana?: number;
  atk?: number;
  mag?: number;
}

export const ITEMS: Record<string, ItemDef> = {
  potion_red: { id: "potion_red", name: "빨간 물약", type: "consumable", price: 20, sell: 8, heal: 50 },
  potion_blue: { id: "potion_blue", name: "파란 물약", type: "consumable", price: 25, sell: 10, mana: 30 },
  wood_sword: { id: "wood_sword", name: "목검", type: "weapon", price: 60, sell: 25, atk: 4 },
  iron_sword: { id: "iron_sword", name: "철검", type: "weapon", price: 240, sell: 100, atk: 10 },
  oak_staff: { id: "oak_staff", name: "참나무 지팡이", type: "weapon", price: 80, sell: 30, atk: 1, mag: 5 },
  goblin_club: { id: "goblin_club", name: "도깨비 방망이", type: "weapon", price: 0, sell: 300, atk: 16, mag: 4 },
  squirrel_tail: { id: "squirrel_tail", name: "다람쥐 꼬리", type: "material", price: 0, sell: 4 },
  rabbit_fur: { id: "rabbit_fur", name: "토끼 털", type: "material", price: 0, sell: 7 },
  fox_pelt: { id: "fox_pelt", name: "여우 가죽", type: "material", price: 0, sell: 18 },
  wolf_fang: { id: "wolf_fang", name: "늑대 송곳니", type: "material", price: 0, sell: 30 },
  bear_paw: { id: "bear_paw", name: "곰 발바닥", type: "material", price: 0, sell: 55 },
};

export interface MonsterDef {
  kind: string;
  name: string;
  level: number;
  hp: number;
  atk: number;
  def: number;
  exp: number;
  gold: [number, number];
  aggressive: boolean;
  respawnMs: number;
  drops: { item: string; chance: number }[];
}

export const MONSTERS: Record<string, MonsterDef> = {
  squirrel: { kind: "squirrel", name: "다람쥐", level: 1, hp: 18, atk: 5, def: 0, exp: 6, gold: [1, 3], aggressive: false, respawnMs: 6000,
    drops: [{ item: "squirrel_tail", chance: 0.5 }, { item: "potion_red", chance: 0.1 }] },
  rabbit: { kind: "rabbit", name: "토끼", level: 2, hp: 28, atk: 7, def: 1, exp: 10, gold: [2, 5], aggressive: false, respawnMs: 7000,
    drops: [{ item: "rabbit_fur", chance: 0.5 }, { item: "potion_red", chance: 0.12 }] },
  fox: { kind: "fox", name: "여우", level: 4, hp: 50, atk: 11, def: 3, exp: 22, gold: [4, 9], aggressive: true, respawnMs: 9000,
    drops: [{ item: "fox_pelt", chance: 0.4 }, { item: "potion_red", chance: 0.15 }, { item: "wood_sword", chance: 0.04 }] },
  wolf: { kind: "wolf", name: "늑대", level: 7, hp: 95, atk: 19, def: 6, exp: 48, gold: [8, 15], aggressive: true, respawnMs: 10000,
    drops: [{ item: "wolf_fang", chance: 0.4 }, { item: "potion_blue", chance: 0.12 }, { item: "iron_sword", chance: 0.03 }] },
  bear: { kind: "bear", name: "곰", level: 10, hp: 170, atk: 27, def: 10, exp: 95, gold: [12, 24], aggressive: true, respawnMs: 14000,
    drops: [{ item: "bear_paw", chance: 0.35 }, { item: "potion_red", chance: 0.2 }] },
  goblin: { kind: "goblin", name: "도깨비", level: 13, hp: 240, atk: 35, def: 14, exp: 160, gold: [20, 40], aggressive: true, respawnMs: 18000,
    drops: [{ item: "goblin_club", chance: 0.08 }, { item: "potion_blue", chance: 0.2 }] },
};
