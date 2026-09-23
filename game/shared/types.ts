// 서버·클라이언트가 공유하는 타입과 프로토콜 정의.
// 프로토콜 계약(t: login/move/attack/skill/chat, welcome/snapshot/chat/error)은 변경 금지 — 필드 추가만 허용.

export type Dir = "up" | "down" | "left" | "right";
export const DIRS: readonly Dir[] = ["up", "down", "left", "right"];
export const DIR_DELTA: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export type Job = "warrior" | "rogue" | "mage" | "poet";
export const JOBS: readonly Job[] = ["warrior", "rogue", "mage", "poet"];
export const JOB_NAMES: Record<Job, string> = { warrior: "전사", rogue: "도적", mage: "주술사", poet: "도사" };

export interface Stats {
  level: number;
  exp: number;
  expNext: number;
  hp: number;
  maxHp: number;
  mp: number;
  maxMp: number;
  atk: number;
  def: number;
  mag: number;
}

export interface InvSlot {
  item: string;
  qty: number;
}

// ---------- 클라이언트 → 서버 ----------
export type ClientMsg =
  | { t: "login"; name: string; job: Job }
  | { t: "move"; dir: Dir }
  | { t: "attack" }
  | { t: "skill"; slot: number }
  | { t: "chat"; text: string }
  | { t: "pickup" }
  | { t: "use"; slot: number }
  | { t: "unequip" }
  | { t: "talk" }
  | { t: "buy"; npc: string; item: string; qty: number }
  | { t: "sell"; npc: string; slot: number; qty: number }
  | { t: "debug"; cmd: "spawn"; kind: string };

// ---------- 서버 → 클라이언트 ----------
export interface PlayerView {
  id: number;
  name: string;
  x: number;
  y: number;
  dir: Dir;
  hp: number;
  maxHp: number;
  level: number;
  job: Job;
  dead: boolean;
}

export interface MonsterView {
  id: number;
  kind: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  dir: Dir;
}

export interface ItemView {
  id: number;
  item: string;
  qty: number;
  x: number;
  y: number;
}

export interface WelcomeMsg {
  t: "welcome";
  id: number;
  name: string;
  job: Job;
  map: string;
  x: number;
  y: number;
  dir: Dir;
  stats: Stats;
}

export interface SnapshotMsg {
  t: "snapshot";
  map: string;
  tick: number;
  players: PlayerView[];
  monsters: MonsterView[];
  items: ItemView[];
}

export interface SelfMsg {
  t: "self";
  map: string;
  x: number;
  y: number;
  dir: Dir;
  dead: boolean;
  stats: Stats;
  gold: number;
  inventory: (InvSlot | null)[];
  weapon: string | null;
  cooldowns: Record<number, number>;
}

export interface ChatMsg {
  t: "chat";
  from: string;
  text: string;
}

export interface ErrorMsg {
  t: "error";
  code: string;
  message: string;
}

export interface DialogMsg {
  t: "dialog";
  npc: string;
  name: string;
  text: string;
  shop: { item: string; price: number }[] | null;
}

export type FxKind = "hit" | "miss" | "kill" | "levelup" | "death" | "heal" | "skill" | "portal" | "pickup" | "info";

export interface FxMsg {
  t: "fx";
  kind: FxKind;
  x: number;
  y: number;
  amount?: number;
  target?: string;
  text?: string;
}

export type ServerMsg = WelcomeMsg | SnapshotMsg | SelfMsg | ChatMsg | ErrorMsg | DialogMsg | FxMsg;
