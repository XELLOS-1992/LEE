// 순수 함수로 분리한 게임 규칙: 난수, 데미지, 경험치·레벨, 능력치 계산.
import { DEATH_EXP_PENALTY, ITEMS, JOB_DEFS, MAX_LEVEL } from "./balance";
import type { Job, Stats } from "./types";

export type Rng = () => number;

/** 시드 고정 난수 (mulberry32) */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 데미지 = (공격력 × 배율 − 방어력 × 0.5) × 0.9~1.1, 최소 1 */
export function calcDamage(attack: number, defense: number, rng: Rng, mult = 1): number {
  const base = attack * mult - defense * 0.5;
  const spread = 0.9 + rng() * 0.2;
  return Math.max(1, Math.round(base * spread));
}

/** 다음 레벨까지 필요한 경험치 */
export function expToNext(level: number): number {
  if (level >= MAX_LEVEL) return Infinity;
  return Math.round(15 * Math.pow(level, 1.8));
}

/** 경험치를 더하고 레벨업을 처리한다. 여러 레벨을 한 번에 올릴 수 있다. */
export function addExp(level: number, exp: number, gained: number): { level: number; exp: number; levelsGained: number } {
  let lv = level;
  let e = exp + Math.max(0, gained);
  let ups = 0;
  while (lv < MAX_LEVEL && e >= expToNext(lv)) {
    e -= expToNext(lv);
    lv++;
    ups++;
  }
  if (lv >= MAX_LEVEL) e = 0;
  return { level: lv, exp: e, levelsGained: ups };
}

/** 사망 시 경험치 손실 (레벨은 내려가지 않음) */
export function deathExp(level: number, exp: number): number {
  const loss = Math.floor(expToNext(level) * DEATH_EXP_PENALTY);
  return Math.max(0, exp - loss);
}

export function baseStats(job: Job, level: number): { maxHp: number; maxMp: number; atk: number; def: number; mag: number } {
  const d = JOB_DEFS[job];
  const n = level - 1;
  return {
    maxHp: Math.floor(d.hp + d.grow.hp * n),
    maxMp: Math.floor(d.mp + d.grow.mp * n),
    atk: Math.floor(d.atk + d.grow.atk * n),
    def: Math.floor(d.def + d.grow.def * n),
    mag: Math.floor(d.mag + d.grow.mag * n),
  };
}

export function computeStats(job: Job, level: number, exp: number, hp: number, mp: number, weapon: string | null): Stats {
  const b = baseStats(job, level);
  const w = weapon ? ITEMS[weapon] : undefined;
  return {
    level,
    exp,
    expNext: expToNext(level),
    hp: Math.min(hp, b.maxHp),
    maxHp: b.maxHp,
    mp: Math.min(mp, b.maxMp),
    maxMp: b.maxMp,
    atk: b.atk + (w?.atk ?? 0),
    def: b.def,
    mag: b.mag + (w?.mag ?? 0),
  };
}
