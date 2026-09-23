// 코드로 생성하는 픽셀아트 (외부 이미지 없음). 16×16 논리 픽셀을 2배로 확대해 32×32 로 그린다.
import { T } from "../shared/mapgen";
import type { Dir, Job } from "../shared/types";

export const TILE = 32;
const P = 2; // 논리 픽셀 크기

type Ctx = CanvasRenderingContext2D;

function canvas(w = TILE, h = TILE): [HTMLCanvasElement, Ctx] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

const px = (g: Ctx, x: number, y: number, w: number, h: number, color: string) => {
  g.fillStyle = color;
  g.fillRect(x * P, y * P, w * P, h * P);
};

function hash(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

function speckle(g: Ctx, seed: number, colors: string[], count: number) {
  for (let i = 0; i < count; i++) {
    const x = Math.floor(hash(seed * 131 + i * 7) * 16);
    const y = Math.floor(hash(seed * 71 + i * 13 + 5) * 16);
    px(g, x, y, 1, 1, colors[i % colors.length]);
  }
}

// ---------- 타일 ----------

function grass(g: Ctx, v: number) {
  px(g, 0, 0, 16, 16, "#5b9b3c");
  speckle(g, 10 + v, ["#4d8a32", "#6cae48", "#4d8a32"], 22);
  px(g, (v * 5) % 14, (v * 3 + 4) % 14, 1, 2, "#79bb52");
}

function drawTile(g: Ctx, t: number, v: number) {
  switch (t) {
    case T.GRASS:
      grass(g, v);
      break;
    case T.FLOWER: {
      grass(g, v);
      const colors = ["#e84a5f", "#f7d64a", "#f4f1ea", "#b26ee0"];
      for (let i = 0; i < 3; i++) {
        const x = 2 + Math.floor(hash(v * 17 + i) * 12), y = 2 + Math.floor(hash(v * 29 + i * 3) * 12);
        px(g, x, y, 1, 1, colors[(v + i) % 4]);
        px(g, x, y + 1, 1, 1, "#3f7a28");
      }
      break;
    }
    case T.ROAD:
      px(g, 0, 0, 16, 16, "#a89a7c");
      for (const [x, y, w, h] of [[0, 0, 7, 5], [8, 0, 8, 4], [0, 6, 5, 5], [6, 5, 6, 6], [13, 5, 3, 6], [0, 12, 8, 4], [9, 12, 7, 4]]) {
        px(g, x, y, w, h, v % 2 ? "#bcae8e" : "#b6a888");
        px(g, x, y, w, 1, "#cfc3a5");
      }
      break;
    case T.DIRT:
      px(g, 0, 0, 16, 16, "#9b7648");
      speckle(g, 40 + v, ["#8a6840", "#ad8756"], 18);
      break;
    case T.WATER:
      px(g, 0, 0, 16, 16, "#3469b0");
      speckle(g, 60 + v, ["#2d5d9e"], 10);
      px(g, (v * 3) % 10, 4, 5, 1, "#6fa1dc");
      px(g, (v * 7 + 4) % 10, 11, 4, 1, "#6fa1dc");
      break;
    case T.BRIDGE:
      px(g, 0, 0, 16, 16, "#8a5a2c");
      for (let y = 0; y < 16; y += 4) px(g, 0, y, 16, 1, "#6b4420");
      px(g, 0, 0, 16, 1, "#5a3818");
      px(g, 0, 15, 16, 1, "#5a3818");
      break;
    case T.TREE:
      grass(g, v);
      px(g, 7, 11, 2, 5, "#6b4423");
      px(g, 3, 3, 10, 9, "#2f6b25");
      px(g, 4, 1, 8, 2, "#2f6b25");
      px(g, 2, 5, 12, 5, "#2f6b25");
      px(g, 4, 3, 4, 3, "#3f8a32");
      px(g, 5, 2, 2, 1, "#56a444");
      px(g, 9, 8, 3, 2, "#27591f");
      break;
    case T.WALL:
      px(g, 0, 0, 16, 16, "#7d7d78");
      for (let y = 0; y < 16; y += 4) {
        px(g, 0, y, 16, 1, "#5e5e5a");
        const off = (y / 4) % 2 ? 4 : 0;
        for (let x = off; x < 16; x += 8) px(g, x, y, 1, 4, "#5e5e5a");
      }
      px(g, 0, 1, 16, 1, "#999993");
      break;
    case T.THATCH:
      px(g, 0, 0, 16, 16, "#c9a24e");
      for (let y = 1; y < 16; y += 3) px(g, 0, y, 16, 1, "#a8823a");
      speckle(g, 80 + v, ["#dcb862", "#b48d3f"], 14);
      break;
    case T.GIWA:
      px(g, 0, 0, 16, 16, "#434b5a");
      for (let y = 0; y < 16; y += 4) {
        px(g, 0, y + 3, 16, 1, "#2c3240");
        for (let x = 0; x < 16; x += 4) px(g, x + 1, y, 2, 3, "#566074");
      }
      break;
    case T.PORTAL:
      px(g, 0, 0, 16, 16, "#a89a7c");
      px(g, 3, 3, 10, 10, "#5a3fa8");
      px(g, 5, 5, 6, 6, "#8f6fe8");
      px(g, 7, 7, 2, 2, "#e6dcff");
      break;
    case T.CAVE:
      px(g, 0, 0, 16, 16, "#4a4038");
      speckle(g, 90 + v, ["#3d352e", "#574c43"], 16);
      break;
    case T.ROCK:
      px(g, 0, 0, 16, 16, "#4a4038");
      px(g, 2, 4, 12, 10, "#6e6862");
      px(g, 3, 3, 9, 2, "#6e6862");
      px(g, 4, 4, 5, 3, "#8a847d");
      px(g, 2, 13, 12, 1, "#39322c");
      break;
    default:
      px(g, 0, 0, 16, 16, "#ff00ff");
  }
}

/** 맵 전체를 한 장의 캔버스에 미리 그려 둔다. */
export function renderMapCanvas(tiles: number[][]): HTMLCanvasElement {
  const h = tiles.length, w = tiles[0].length;
  const [c, g] = canvas(w * TILE, h * TILE);
  const [tc, tg] = canvas();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      tg.clearRect(0, 0, TILE, TILE);
      drawTile(tg, tiles[y][x], Math.floor(hash(x * 928371 + y * 1237) * 8));
      g.drawImage(tc, x * TILE, y * TILE);
    }
  return c;
}

// ---------- 캐릭터 ----------

const cache = new Map<string, HTMLCanvasElement>();
function cached(key: string, draw: (g: Ctx) => void): HTMLCanvasElement {
  let c = cache.get(key);
  if (!c) {
    const [cv, g] = canvas();
    draw(g);
    cache.set(key, cv);
    c = cv;
  }
  return c;
}

interface Look {
  coat: string;
  trim: string;
  pants: string;
  hair: string;
  hat?: "gat" | "band" | "bun" | "topknot";
  beard?: boolean;
  apron?: boolean;
}

const JOB_LOOK: Record<Job, Look> = {
  warrior: { coat: "#a8362b", trim: "#e0b04a", pants: "#4a3a2a", hair: "#1c1612", hat: "topknot" },
  rogue: { coat: "#2f3545", trim: "#7a8499", pants: "#23262f", hair: "#1c1612", hat: "band" },
  mage: { coat: "#5c3a94", trim: "#c7a4f0", pants: "#2e2240", hair: "#1c1612", hat: "gat" },
  poet: { coat: "#e9e4d6", trim: "#3f6fb0", pants: "#c9c2ae", hair: "#1c1612", hat: "topknot" },
};

const NPC_LOOK: Record<string, Look> = {
  jumo: { coat: "#f0e6d0", trim: "#c0392b", pants: "#c0392b", hair: "#1c1612", hat: "bun", apron: true },
  smith: { coat: "#6b4a2e", trim: "#3a2a1a", pants: "#3a2a1a", hair: "#1c1612", hat: "band" },
  elder: { coat: "#f4f1ea", trim: "#9a948a", pants: "#e0dccf", hair: "#d8d8d8", hat: "gat", beard: true },
};

function drawPerson(g: Ctx, look: Look, dir: Dir, frame: number) {
  const skin = "#f0c79c";
  const bob = frame ? 0 : 0;
  // 그림자
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.beginPath();
  g.ellipse(16, 30, 9, 3, 0, 0, Math.PI * 2);
  g.fill();
  // 다리
  if (frame) { px(g, 5, 12, 2, 3, look.pants); px(g, 9, 12, 2, 2, look.pants); }
  else { px(g, 5, 12, 2, 2, look.pants); px(g, 9, 12, 2, 3, look.pants); }
  px(g, 5, 14 + (frame ? 1 : 0) - 1, 2, 1, "#1a1a1a");
  px(g, 9, 14 - (frame ? 1 : 0), 2, 1, "#1a1a1a");
  // 몸통(저고리)
  px(g, 4, 7 + bob, 8, 6, look.coat);
  px(g, 3, 8, 1, 4, look.coat);
  px(g, 12, 8, 1, 4, look.coat);
  px(g, 3, 12, 1, 1, skin);
  px(g, 12, 12, 1, 1, skin);
  px(g, 4, 11, 8, 1, look.trim); // 허리띠
  if (dir === "down") { px(g, 7, 7, 2, 3, look.trim); }
  if (look.apron && dir !== "up") px(g, 5, 10, 6, 3, "#f8f8f0");
  // 머리
  px(g, 5, 2, 6, 5, skin);
  px(g, 5, 1, 6, 2, look.hair);
  if (dir === "up") px(g, 5, 2, 6, 5, look.hair);
  else if (dir === "down") {
    px(g, 6, 4, 1, 1, "#1a1a1a");
    px(g, 9, 4, 1, 1, "#1a1a1a");
    px(g, 7, 6, 2, 1, "#c98d6e");
  } else {
    const ex = dir === "left" ? 6 : 9;
    px(g, ex, 4, 1, 1, "#1a1a1a");
    px(g, dir === "left" ? 9 : 5, 2, 2, 3, look.hair);
  }
  if (look.beard && dir !== "up") px(g, 6, 6, 4, 2, "#e8e8e8");
  switch (look.hat) {
    case "gat":
      px(g, 2, 1, 12, 1, "#141414");
      px(g, 5, -1 + 1, 6, 1, "#141414");
      px(g, 6, 0, 4, 1, "#141414");
      break;
    case "topknot":
      px(g, 7, 0, 2, 1, look.hair);
      px(g, 5, 1, 6, 1, look.trim);
      break;
    case "band":
      px(g, 5, 2, 6, 1, look.trim);
      break;
    case "bun":
      px(g, 6, 0, 4, 1, look.hair);
      px(g, dir === "left" ? 10 : 4, 3, 2, 2, look.hair);
      break;
  }
}

export function playerSprite(job: Job, dir: Dir, frame: number): HTMLCanvasElement {
  return cached(`p:${job}:${dir}:${frame}`, (g) => drawPerson(g, JOB_LOOK[job], dir, frame));
}

export function npcSprite(look: string, dir: Dir): HTMLCanvasElement {
  return cached(`n:${look}:${dir}`, (g) => drawPerson(g, NPC_LOOK[look] ?? NPC_LOOK.elder, dir, 0));
}

// ---------- 몬스터 ----------

function shadow(g: Ctx, w = 8) {
  g.fillStyle = "rgba(0,0,0,0.25)";
  g.beginPath();
  g.ellipse(16, 29, w, 3, 0, 0, Math.PI * 2);
  g.fill();
}

function drawMonster(g: Ctx, kind: string, dir: Dir, frame: number) {
  const b = frame; // 들썩임
  const flip = dir === "left";
  if (flip) {
    g.translate(TILE, 0);
    g.scale(-1, 1);
  }
  switch (kind) {
    case "squirrel":
      shadow(g, 6);
      px(g, 3, 5 - b, 3, 7, "#a0622d"); // 꼬리
      px(g, 2, 4 - b, 2, 3, "#c07a3a");
      px(g, 6, 8, 6, 5, "#b06a30");
      px(g, 10, 6, 4, 4, "#b06a30");
      px(g, 12, 7, 1, 1, "#111");
      px(g, 11, 5, 1, 1, "#8a4f22");
      px(g, 7, 10, 3, 2, "#e8c69a");
      break;
    case "rabbit":
      shadow(g, 6);
      px(g, 5, 8 + b, 7, 5, "#f2f2ee");
      px(g, 10, 6 + b, 4, 4, "#f2f2ee");
      px(g, 10, 1 + b, 1, 5, "#f2f2ee");
      px(g, 12, 1 + b, 1, 5, "#f2f2ee");
      px(g, 12, 2 + b, 1, 3, "#f0b0b8");
      px(g, 12, 7 + b, 1, 1, "#c0303a");
      px(g, 4, 9 + b, 1, 2, "#ffffff");
      break;
    case "fox":
      shadow(g, 8);
      px(g, 1, 7 - b, 4, 3, "#e07a26");
      px(g, 1, 9 - b, 2, 1, "#fff");
      px(g, 4, 7, 8, 5, "#e07a26");
      px(g, 5, 11, 1, 3, "#3a2a1a");
      px(g, 10, 11, 1, 3, "#3a2a1a");
      px(g, 10, 4, 5, 4, "#e07a26");
      px(g, 10, 3, 1, 1, "#e07a26");
      px(g, 13, 3, 1, 1, "#e07a26");
      px(g, 11, 6, 4, 2, "#fff");
      px(g, 13, 5, 1, 1, "#111");
      break;
    case "wolf":
      shadow(g, 9);
      px(g, 1, 6 - b, 3, 2, "#7a7f86");
      px(g, 3, 6, 9, 6, "#7a7f86");
      px(g, 3, 9, 9, 2, "#9aa0a8");
      px(g, 4, 11, 2, 4, "#5a5f66");
      px(g, 10, 11, 2, 4, "#5a5f66");
      px(g, 10, 3, 5, 5, "#7a7f86");
      px(g, 10, 2, 1, 2, "#5a5f66");
      px(g, 12, 2, 1, 2, "#5a5f66");
      px(g, 14, 6, 2, 2, "#5a5f66");
      px(g, 13, 4, 1, 1, "#f0d040");
      break;
    case "bear":
      shadow(g, 11);
      px(g, 2, 5 + b, 12, 8, "#5a3a22");
      px(g, 3, 12, 3, 3, "#4a2e1a");
      px(g, 10, 12, 3, 3, "#4a2e1a");
      px(g, 9, 2 + b, 6, 6, "#5a3a22");
      px(g, 9, 1 + b, 2, 2, "#5a3a22");
      px(g, 13, 1 + b, 2, 2, "#5a3a22");
      px(g, 13, 5 + b, 2, 2, "#c8a078");
      px(g, 12, 4 + b, 1, 1, "#111");
      break;
    case "goblin":
      shadow(g, 9);
      px(g, 4, 6 + b, 8, 7, "#3a70b8");
      px(g, 4, 10 + b, 8, 2, "#e0c040"); // 호피 허리
      px(g, 5, 13, 2, 3, "#3a70b8");
      px(g, 9, 13, 2, 3, "#3a70b8");
      px(g, 5, 1 + b, 6, 5, "#3a70b8");
      px(g, 7, 0 + b, 2, 1, "#f0e8d0"); // 뿔
      px(g, 6, 3 + b, 1, 1, "#ffea00");
      px(g, 9, 3 + b, 1, 1, "#ffea00");
      px(g, 6, 5 + b, 4, 1, "#fff");
      px(g, 12, 4 + b, 2, 8, "#7a4a22"); // 방망이
      px(g, 12, 3 + b, 3, 3, "#8a5a2a");
      break;
    default:
      shadow(g);
      px(g, 4, 4, 8, 8, "#c040c0");
  }
}

export function monsterSprite(kind: string, dir: Dir, frame: number): HTMLCanvasElement {
  const d = dir === "left" ? "left" : "right";
  return cached(`m:${kind}:${d}:${frame}`, (g) => drawMonster(g, kind, d, frame));
}

// ---------- 아이템 아이콘 ----------

function drawItem(g: Ctx, item: string) {
  switch (item) {
    case "potion_red":
    case "potion_blue": {
      const c = item === "potion_red" ? "#d8323a" : "#3a6ad8";
      px(g, 7, 4, 2, 2, "#c8b89a");
      px(g, 5, 6, 6, 7, c);
      px(g, 6, 7, 1, 2, "#ffffffaa");
      break;
    }
    case "wood_sword":
    case "iron_sword": {
      const blade = item === "iron_sword" ? "#d8dde6" : "#b88a52";
      for (let i = 0; i < 8; i++) px(g, 4 + i, 11 - i, 2, 2, blade);
      px(g, 3, 10, 4, 1, "#6b4423");
      px(g, 2, 12, 2, 2, "#6b4423");
      break;
    }
    case "oak_staff":
      for (let i = 0; i < 10; i++) px(g, 4 + i, 13 - i, 1, 1, "#8a5a2c");
      px(g, 12, 2, 3, 3, "#6fd0a0");
      break;
    case "goblin_club":
      for (let i = 0; i < 6; i++) px(g, 3 + i, 13 - i, 2, 2, "#6b4423");
      px(g, 8, 3, 5, 5, "#8a5a2a");
      px(g, 9, 4, 1, 1, "#ddd");
      px(g, 11, 6, 1, 1, "#ddd");
      break;
    default: {
      const colors: Record<string, string> = {
        squirrel_tail: "#a0622d", rabbit_fur: "#f2f2ee", fox_pelt: "#e07a26", wolf_fang: "#eeeede", bear_paw: "#5a3a22",
      };
      px(g, 4, 6, 8, 7, "#b89a6a");
      px(g, 6, 5, 4, 1, "#8a6a3a");
      px(g, 6, 8, 4, 3, colors[item] ?? "#aaa");
    }
  }
}

export function itemSprite(item: string): HTMLCanvasElement {
  return cached(`i:${item}`, (g) => drawItem(g, item));
}
