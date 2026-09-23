// 코드로 그리는 그래픽 (외부 이미지 없음).
// 밝고 선명한 색, 굵은 외곽선, 머리가 큰 2등신 캐릭터의 "귀여운 만화풍". 모두 3배 해상도로 미리 그려 캐시한다.
import { T } from "../shared/mapgen";
import type { Dir, Job } from "../shared/types";
import type { Building } from "./scenery";

export const TILE = 32;
const RES = 3;
const INK = "#2b1d1a"; // 외곽선

type G = CanvasRenderingContext2D;

export interface Sprite {
  c: HTMLCanvasElement;
  w: number;
  h: number;
  /** 기준점(발밑 등) — 그릴 때 이 점을 목표 좌표에 맞춘다 */
  ax: number;
  ay: number;
}

const cache = new Map<string, Sprite>();

function make(key: string, w: number, h: number, ax: number, ay: number, draw: (g: G) => void): Sprite {
  let s = cache.get(key);
  if (s) return s;
  const c = document.createElement("canvas");
  c.width = Math.ceil(w * RES);
  c.height = Math.ceil(h * RES);
  const g = c.getContext("2d")!;
  g.scale(RES, RES);
  g.lineJoin = "round";
  g.lineCap = "round";
  draw(g);
  s = { c, w, h, ax, ay };
  cache.set(key, s);
  return s;
}

function hash(n: number): number {
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

// ---------- 도형 도우미 ----------

function ellipse(g: G, x: number, y: number, rx: number, ry: number, fill: string, stroke: string | null = INK, lw = 1.3) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.lineWidth = lw;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function rrect(g: G, x: number, y: number, w: number, h: number, r: number | number[], fill: string, stroke: string | null = INK, lw = 1.3) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.lineWidth = lw;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function poly(g: G, pts: number[][], fill: string, stroke: string | null = INK, lw = 1.3) {
  g.beginPath();
  g.moveTo(pts[0][0], pts[0][1]);
  for (const [x, y] of pts.slice(1)) g.lineTo(x, y);
  g.closePath();
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.lineWidth = lw;
    g.strokeStyle = stroke;
    g.stroke();
  }
}

function shadow(g: G, x: number, y: number, rx: number, ry = rx * 0.32) {
  g.beginPath();
  g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  g.fillStyle = "rgba(20,40,20,0.28)";
  g.fill();
}

/** 반짝이는 큰 눈 */
function eye(g: G, x: number, y: number, w = 2.4, h = 3.4, iris = "#2b1d1a") {
  ellipse(g, x, y, w, h, iris, null);
  ellipse(g, x - w * 0.35, y - h * 0.4, w * 0.45, w * 0.45, "#ffffff", null);
  ellipse(g, x + w * 0.35, y + h * 0.35, w * 0.22, w * 0.22, "rgba(255,255,255,0.8)", null);
}

function blush(g: G, x: number, y: number) {
  ellipse(g, x, y, 2.2, 1.3, "rgba(255,120,140,0.45)", null);
}

// ---------- 지면 타일 ----------

const GROUND: Record<number, string> = {
  [T.GRASS]: "#7ecb5c",
  [T.FLOWER]: "#7ecb5c",
  [T.ROAD]: "#efd9a6",
  [T.DIRT]: "#d6ab6c",
  [T.WATER]: "#5bbcec",
  [T.BRIDGE]: "#5bbcec",
  [T.WALL]: "#d3c7b1",
  [T.PORTAL]: "#efd9a6",
  [T.CAVE]: "#8a7b9c",
};

function grass(g: G, v: number) {
  g.fillStyle = GROUND[T.GRASS];
  g.fillRect(0, 0, TILE, TILE);
  for (let i = 0; i < 5; i++) {
    const x = 3 + hash(v * 31 + i) * 26, y = 4 + hash(v * 17 + i * 7) * 24;
    g.strokeStyle = i % 2 ? "#6bb84c" : "#9ddf78";
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(x - 2, y);
    g.lineTo(x, y - 3);
    g.lineTo(x + 2, y);
    g.stroke();
  }
}

/** 이웃과 연결되지 않은 변만 안쪽으로 들이고 테두리를 둘러 둥근 가장자리를 만든다 */
function patch(g: G, mask: number, fill: string, rim: string, inset = 2.5) {
  const shape = (d: number) => {
    const up = mask & 1, right = mask & 2, down = mask & 4, left = mask & 8;
    const l = left ? 0 : inset + d, t = up ? 0 : inset + d, r = right ? TILE : TILE - inset - d, b = down ? TILE : TILE - inset - d;
    const R = Math.max(1, 7 - d);
    g.beginPath();
    g.roundRect(l, t, r - l, b - t, [!up && !left ? R : 0, !up && !right ? R : 0, !down && !right ? R : 0, !down && !left ? R : 0]);
  };
  shape(0);
  g.fillStyle = rim;
  g.fill();
  shape(1.5);
  g.fillStyle = fill;
  g.fill();
}

export function groundSprite(t: number, v: number, mask: number, frame: number): Sprite {
  return make(`g:${t}:${v}:${mask}:${frame}`, TILE, TILE, 0, 0, (g) => {
    switch (t) {
      case T.GRASS:
        grass(g, v);
        break;
      case T.FLOWER: {
        grass(g, v);
        const petals = ["#ff7aa2", "#ffd84a", "#ffffff", "#b58cff"][v % 4];
        for (let i = 0; i < 2; i++) {
          const x = 7 + hash(v * 13 + i) * 18, y = 8 + hash(v * 29 + i * 5) * 16;
          for (let k = 0; k < 5; k++) {
            const a = (k / 5) * Math.PI * 2;
            ellipse(g, x + Math.cos(a) * 2, y + Math.sin(a) * 2, 1.6, 1.6, petals, null);
          }
          ellipse(g, x, y, 1.2, 1.2, "#ffb830", null);
        }
        break;
      }
      case T.ROAD:
      case T.PORTAL:
        grass(g, v);
        patch(g, mask, GROUND[T.ROAD], "#c9ae78");
        for (let i = 0; i < 3; i++)
          ellipse(g, 6 + hash(v * 7 + i) * 20, 6 + hash(v * 11 + i * 3) * 20, 1.8, 1.2, "#dcc28c", null);
        break;
      case T.DIRT:
        grass(g, v);
        patch(g, mask, GROUND[T.DIRT], "#a8804a");
        for (let i = 0; i < 3; i++)
          ellipse(g, 6 + hash(v * 5 + i) * 20, 6 + hash(v * 3 + i * 9) * 20, 1.5, 1, "#bf935a", null);
        break;
      case T.WATER:
      case T.BRIDGE: {
        g.fillStyle = GROUND[T.WATER];
        g.fillRect(0, 0, TILE, TILE);
        const off = frame * 5;
        g.strokeStyle = "rgba(255,255,255,0.55)";
        g.lineWidth = 1.3;
        for (let i = 0; i < 2; i++) {
          const x = ((hash(v + i * 3) * 20 + off) % 24) + 2, y = 8 + i * 13;
          g.beginPath();
          g.arc(x, y, 3, Math.PI * 1.1, Math.PI * 1.9);
          g.arc(x + 6, y, 3, Math.PI * 1.1, Math.PI * 1.9);
          g.stroke();
        }
        // 물가 거품
        g.fillStyle = "rgba(235,250,255,0.85)";
        if (!(mask & 1)) g.fillRect(0, 0, TILE, 3);
        if (!(mask & 2)) g.fillRect(TILE - 3, 0, 3, TILE);
        if (!(mask & 4)) g.fillRect(0, TILE - 3, TILE, 3);
        if (!(mask & 8)) g.fillRect(0, 0, 3, TILE);
        if (t === T.BRIDGE) {
          for (let x = 0; x < TILE; x += 8) rrect(g, x + 0.5, 3, 7, TILE - 6, 1.5, x % 16 ? "#c98a4e" : "#b97a40", "#6b4020", 1);
          g.fillStyle = "#6b4020";
          g.fillRect(0, 2, TILE, 2);
          g.fillRect(0, TILE - 4, TILE, 2);
        }
        break;
      }
      case T.WALL:
        g.fillStyle = "#b8ab94";
        g.fillRect(0, 0, TILE, TILE);
        for (let row = 0; row < 4; row++)
          for (let col = -1; col < 3; col++) {
            const x = col * 14 + (row % 2) * 7, y = row * 8;
            rrect(g, x + 1, y + 1, 12, 6.5, 2, row === 0 ? "#e6dcc6" : "#d3c7b1", "#7a6c58", 1);
          }
        break;
      case T.CAVE:
        g.fillStyle = GROUND[T.CAVE];
        g.fillRect(0, 0, TILE, TILE);
        for (let i = 0; i < 4; i++)
          ellipse(g, 4 + hash(v * 19 + i) * 24, 4 + hash(v * 23 + i * 5) * 24, 2.2, 1.5, i % 2 ? "#9b8cae" : "#7a6b8c", null);
        break;
      default:
        grass(g, v);
    }
  });
}

// ---------- 건물·나무·바위 ----------

/** 건물은 (블록 왼쪽 위 - 4, 위 - 16) 에서 그린다 */
export function buildingSprite(b: Building): Sprite {
  const W = b.w * TILE, H = b.h * TILE;
  return make(`b:${b.kind}:${b.w}x${b.h}`, W + 8, H + 20, 4, 16, (g) => {
    const ox = 4, oy = 16;
    shadow(g, ox + W / 2, oy + H - 1, W / 2 + 2, 5);
    // 벽
    const wallTop = oy + H * 0.5;
    rrect(g, ox + 3, wallTop, W - 6, H * 0.5 - 2, 2, "#fbf1dc");
    g.fillStyle = "#9a6a3e";
    for (const x of [ox + 3, ox + W / 2 - 2, ox + W - 7]) g.fillRect(x, wallTop, 4, H * 0.5 - 2);
    g.strokeStyle = INK;
    g.lineWidth = 1.3;
    g.strokeRect(ox + 3, wallTop, W - 6, H * 0.5 - 2);
    // 문과 창
    const dw = 12, dh = Math.min(16, H * 0.36);
    rrect(g, ox + W / 2 - dw / 2, oy + H - 2 - dh, dw, dh, [5, 5, 0, 0], "#8a5530");
    ellipse(g, ox + W / 2 + 3, oy + H - 2 - dh / 2, 1, 1, "#ffd166", null);
    for (const x of [ox + W * 0.22, ox + W * 0.78]) {
      rrect(g, x - 5, wallTop + 4, 10, 8, 1.5, "#fff8e8");
      g.strokeStyle = "#b08050";
      g.lineWidth = 0.8;
      g.beginPath();
      g.moveTo(x, wallTop + 4);
      g.lineTo(x, wallTop + 12);
      g.moveTo(x - 5, wallTop + 8);
      g.lineTo(x + 5, wallTop + 8);
      g.stroke();
    }
    // 지붕
    const roofBottom = wallTop + 4;
    if (b.kind === "giwa") {
      g.beginPath();
      g.moveTo(ox - 4, roofBottom);
      g.quadraticCurveTo(ox + 4, roofBottom - 4, ox + 8, oy + 4);
      g.lineTo(ox + W - 8, oy + 4);
      g.quadraticCurveTo(ox + W - 4, roofBottom - 4, ox + W + 4, roofBottom);
      g.quadraticCurveTo(ox + W / 2, roofBottom - 6, ox - 4, roofBottom);
      g.closePath();
      g.fillStyle = "#4f6488";
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = INK;
      g.stroke();
      g.save();
      g.clip();
      g.strokeStyle = "#7489ad";
      g.lineWidth = 1.4;
      for (let x = ox; x < ox + W + 4; x += 5) {
        g.beginPath();
        g.moveTo(x, oy);
        g.lineTo(x, roofBottom);
        g.stroke();
      }
      g.restore();
      rrect(g, ox + 6, oy + 1, W - 12, 5, 2.5, "#34445f");
    } else {
      g.beginPath();
      g.moveTo(ox - 3, roofBottom);
      g.bezierCurveTo(ox - 3, oy - 6, ox + W + 3, oy - 6, ox + W + 3, roofBottom);
      g.quadraticCurveTo(ox + W / 2, roofBottom + 3, ox - 3, roofBottom);
      g.closePath();
      g.fillStyle = "#f0c864";
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = "#7a5520";
      g.stroke();
      g.save();
      g.clip();
      g.strokeStyle = "#d4a843";
      g.lineWidth = 1;
      for (let i = 0; i < 26; i++) {
        const x = ox + hash(i * 7 + b.w) * W, y = oy + hash(i * 3 + b.h) * (roofBottom - oy);
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + 2, y + 5);
        g.stroke();
      }
      g.strokeStyle = "#b8862e";
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(ox, oy + (roofBottom - oy) * 0.45);
      g.quadraticCurveTo(ox + W / 2, oy + (roofBottom - oy) * 0.3, ox + W, oy + (roofBottom - oy) * 0.45);
      g.stroke();
      g.restore();
    }
  });
}

/** 나무는 기준점(칸 아래쪽 가운데)에 맞춰 그린다 */
export function treeSprite(v: number, blossom: boolean): Sprite {
  return make(`t:${v}:${blossom}`, 48, 60, 24, 54, (g) => {
    shadow(g, 24, 54, 13, 4);
    rrect(g, 20, 36, 8, 18, 3, "#9a6436");
    const leaf = blossom ? ["#ffb3cf", "#ff8fb7", "#ffd6e6"] : [["#4cb85a", "#3a9a48", "#86dc78"], ["#5cc062", "#459c4c", "#9ae28a"], ["#3fae5e", "#2f8e4a", "#7ad49a"], ["#58bb52", "#3f9a40", "#98e07c"]][v];
    ellipse(g, 14, 30, 11, 10, leaf[1]);
    ellipse(g, 34, 30, 11, 10, leaf[1]);
    ellipse(g, 24, 20, 15, 14, leaf[0]);
    ellipse(g, 24, 32, 13, 8, leaf[0], null);
    ellipse(g, 19, 14, 5, 3.5, leaf[2], null);
    ellipse(g, 30, 22, 3, 2, leaf[2], null);
    if (!blossom && v === 1) for (const [x, y] of [[16, 26], [30, 16], [33, 30]]) ellipse(g, x, y, 2.3, 2.3, "#ff5a5a", INK, 0.8);
  });
}

export function rockSprite(v: number): Sprite {
  return make(`r:${v}`, 40, 36, 20, 31, (g) => {
    shadow(g, 20, 31, 15, 4);
    const base = ["#a79cb8", "#9a90ab", "#b3a8c2"][v];
    ellipse(g, 20, 22, 15, 10, base);
    ellipse(g, 14, 17, 7, 5, base, null);
    ellipse(g, 13, 16, 4, 2.5, "rgba(255,255,255,0.55)", null);
    g.strokeStyle = "#6c6280";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(24, 16);
    g.lineTo(27, 22);
    g.lineTo(25, 27);
    g.stroke();
  });
}

// ---------- 사람 ----------

interface Look {
  skin: string;
  coat: string;
  trim: string;
  pants: string;
  hair: string;
  hat?: "gat" | "band" | "bun" | "topknot";
  band?: string;
  beard?: boolean;
  apron?: boolean;
  skirt?: string;
}

const JOB_LOOK: Record<Job, Look> = {
  warrior: { skin: "#ffdcbf", coat: "#e5483e", trim: "#ffd166", pants: "#5b4636", hair: "#4a2c18", hat: "topknot" },
  rogue: { skin: "#ffdcbf", coat: "#3f4a78", trim: "#9ad0ff", pants: "#2b2f48", hair: "#2a2238", hat: "band", band: "#ff5a7a" },
  mage: { skin: "#ffe2c8", coat: "#9a62e0", trim: "#ffd6f5", pants: "#503a80", hair: "#35224a", hat: "gat" },
  poet: { skin: "#ffdcbf", coat: "#f7f3ea", trim: "#4f9ae6", pants: "#d9d1bd", hair: "#4a2c18", hat: "topknot" },
};

const NPC_LOOK: Record<string, Look> = {
  jumo: { skin: "#ffdcbf", coat: "#fff4e0", trim: "#e5483e", pants: "#e5483e", hair: "#2a1a10", hat: "bun", apron: true, skirt: "#e5483e" },
  smith: { skin: "#e8b48c", coat: "#9a6436", trim: "#4a3020", pants: "#4a3020", hair: "#2a1a10", hat: "band", band: "#f0f0f0" },
  elder: { skin: "#ffdcbf", coat: "#fbfaf5", trim: "#9a948a", pants: "#e8e4d8", hair: "#e8e8e8", hat: "gat", beard: true },
};

/** 40×50 캔버스, 발밑 기준점 (20, 46) */
function drawPerson(g: G, L: Look, dir: Dir, frame: number) {
  const side = dir === "left" || dir === "right";
  if (dir === "left") {
    g.translate(40, 0);
    g.scale(-1, 1);
  }
  const step = [0, 1, 0, -1][frame];
  const bob = frame % 2 ? -0.8 : 0;
  shadow(g, 20, 46, 9, 2.8);
  g.translate(0, bob);
  // 다리·신발
  const legs = side ? [[17, step], [21, -step]] : [[15.5, step], [21.5, -step]];
  for (const [x, s] of legs) {
    rrect(g, x, 37, 4, 6 - s * 0.6, 1.5, L.pants);
    ellipse(g, x + 2 + (side ? 1 : 0), 43.2 - s * 0.6, 3, 1.8, "#3a2a24");
  }
  // 몸통
  if (L.skirt) rrect(g, 12, 32, 16, 10, [3, 3, 6, 6], L.skirt);
  rrect(g, 13, 27, 14, 12, 4, L.coat);
  if (dir === "down") {
    // 한복 깃과 고름
    poly(g, [[17, 27.5], [20, 32], [23, 27.5]], "#ffffff", INK, 1);
    rrect(g, 19.5, 31, 2, 6, 1, L.trim, null);
    ellipse(g, 20.5, 31.5, 1.8, 1.4, L.trim, null);
  }
  if (L.apron && dir !== "up") rrect(g, 15, 32, 10, 8, 2, "#ffffff", INK, 1);
  g.fillStyle = L.trim;
  g.fillRect(13.6, 35.5, 12.8, 1.6);
  // 팔
  const swing = side ? step * 1.5 : 0;
  if (!side || dir === "right") {
    ellipse(g, side ? 20 - swing : 12.5, 32, 2.6, 4.2, L.coat);
    ellipse(g, side ? 20 - swing : 12.5, 36, 1.8, 1.8, L.skin, INK, 1);
  }
  if (!side) {
    ellipse(g, 27.5, 32, 2.6, 4.2, L.coat);
    ellipse(g, 27.5, 36, 1.8, 1.8, L.skin, INK, 1);
  }
  // 머리
  ellipse(g, 20, 17, 11.5, 11, L.skin);
  if (dir === "up") {
    ellipse(g, 20, 16, 11.8, 11.2, L.hair);
  } else {
    // 앞머리
    g.beginPath();
    g.ellipse(20, 15, 11.8, 10.2, 0, Math.PI, 0);
    if (side) g.lineTo(31.5, 16);
    g.quadraticCurveTo(side ? 22 : 26, 12, side ? 14 : 20, 14);
    if (!side) g.quadraticCurveTo(14, 12, 8.2, 15);
    g.closePath();
    g.fillStyle = L.hair;
    g.fill();
    g.lineWidth = 1.3;
    g.strokeStyle = INK;
    g.stroke();
    if (side) {
      ellipse(g, 12, 16, 4, 6, L.hair, null);
      eye(g, 25, 19);
      blush(g, 26.5, 23);
      g.strokeStyle = INK;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(28, 23, 1.2, 0.2, Math.PI * 0.8);
      g.stroke();
    } else {
      eye(g, 16, 19);
      eye(g, 24, 19);
      blush(g, 12.8, 23);
      blush(g, 27.2, 23);
      g.strokeStyle = INK;
      g.lineWidth = 1;
      g.beginPath();
      g.arc(20, 23, 1.6, 0.2, Math.PI - 0.2);
      g.stroke();
    }
    if (L.beard) {
      g.beginPath();
      g.moveTo(side ? 22 : 15, 23);
      g.quadraticCurveTo(side ? 28 : 20, 33, side ? 31 : 25, 23);
      g.fillStyle = "#f4f4f4";
      g.fill();
      g.lineWidth = 1;
      g.strokeStyle = INK;
      g.stroke();
    }
  }
  // 모자·머리 장식
  switch (L.hat) {
    case "gat":
      ellipse(g, 20, 8.5, 16, 3.6, "rgba(30,24,30,0.85)");
      rrect(g, 14, 0.5, 12, 8, [5, 5, 1, 1], "#1e181e");
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(8, 8);
      g.lineTo(32, 8);
      g.stroke();
      break;
    case "topknot":
      ellipse(g, dir === "up" ? 20 : side ? 17 : 20, 5, 3.6, 3.2, L.hair);
      rrect(g, (side ? 17 : 20) - 3, 7, 6, 1.8, 1, L.trim, INK, 0.8);
      break;
    case "band":
      rrect(g, 8.5, 9.5, 23, 3, 1.5, L.band ?? L.trim, INK, 1);
      if (dir !== "down") {
        rrect(g, side ? 5 : 21, 11, 5, 2, 1, L.band ?? L.trim, INK, 0.8);
        rrect(g, side ? 4 : 23, 13.5, 5, 2, 1, L.band ?? L.trim, INK, 0.8);
      }
      break;
    case "bun":
      ellipse(g, side ? 11 : 20, side ? 10 : 4.5, 4.5, 4, L.hair);
      rrect(g, (side ? 11 : 20) - 5, (side ? 10 : 4.5) - 0.8, 10, 1.6, 0.8, "#ffd166", INK, 0.7);
      break;
  }
}

export function playerSprite(job: Job, dir: Dir, frame: number): Sprite {
  return make(`p:${job}:${dir}:${frame}`, 40, 50, 20, 46, (g) => drawPerson(g, JOB_LOOK[job], dir, frame));
}

export function npcSprite(look: string, dir: Dir): Sprite {
  return make(`n:${look}:${dir}`, 40, 50, 20, 46, (g) => drawPerson(g, NPC_LOOK[look] ?? NPC_LOOK.elder, dir, 0));
}

// ---------- 몬스터 ----------

/** 기본은 오른쪽을 본다. 48×44 캔버스, 발밑 기준점 (24, 40) */
function drawMonster(g: G, kind: string, frame: number) {
  const f = frame % 2;
  switch (kind) {
    case "squirrel":
      shadow(g, 24, 40, 9);
      ellipse(g, 13, 24 - f, 7, 11, "#c47a3c");
      ellipse(g, 13, 22 - f, 3, 7, "#e8a868", null);
      ellipse(g, 24, 33, 8, 7, "#d8894a");
      ellipse(g, 25, 35, 4.5, 4, "#fff0d8", null);
      ellipse(g, 30, 24, 7, 6.5, "#d8894a");
      poly(g, [[27, 19], [28.5, 13], [31, 18.5]], "#d8894a");
      eye(g, 32, 23.5, 1.8, 2.6);
      ellipse(g, 36.5, 26, 1.2, 1, "#5a2e1a", null);
      blush(g, 33.5, 27.5);
      ellipse(g, 21, 39.5, 2.5, 1.5, "#b86a30");
      ellipse(g, 28, 39.5, 2.5, 1.5, "#b86a30");
      break;
    case "rabbit":
      shadow(g, 24, 40, 10);
      ellipse(g, 21, 11 + f, 2.8, 8, "#ffffff");
      ellipse(g, 21, 11 + f, 1.2, 5.5, "#ffb6c8", null);
      ellipse(g, 27, 10 + f, 2.8, 8, "#ffffff");
      ellipse(g, 27, 10 + f, 1.2, 5.5, "#ffb6c8", null);
      ellipse(g, 24, 30 + f * 0.5, 11, 10 - f * 0.5, "#ffffff");
      ellipse(g, 13.5, 32, 3, 3, "#ffffff");
      eye(g, 22, 27, 1.9, 2.7, "#8a2a3a");
      eye(g, 29, 27, 1.9, 2.7, "#8a2a3a");
      ellipse(g, 25.5, 31, 1.3, 1, "#ff8aa8", null);
      blush(g, 19, 31);
      blush(g, 32, 31);
      break;
    case "fox":
      shadow(g, 24, 40, 11);
      g.save();
      g.translate(10, 28);
      g.rotate(-0.5 + f * 0.15);
      ellipse(g, 0, 0, 5.5, 10, "#f28a2e");
      ellipse(g, 0, -7, 3.5, 3.5, "#ffffff", null);
      g.restore();
      ellipse(g, 23, 32, 10, 7, "#f28a2e");
      ellipse(g, 25, 34, 5, 4, "#fff4e4", null);
      ellipse(g, 32, 23, 8, 7, "#f28a2e");
      poly(g, [[26, 19], [27, 10], [31, 17]], "#f28a2e");
      poly(g, [[33, 17], [37, 10], [38, 19]], "#f28a2e");
      ellipse(g, 36, 26, 4.5, 3.2, "#fff4e4");
      ellipse(g, 40, 25.5, 1.3, 1, INK, null);
      g.strokeStyle = INK;
      g.lineWidth = 1.4;
      g.beginPath();
      g.arc(33, 22, 2, Math.PI * 1.1, Math.PI * 1.9);
      g.stroke();
      for (const x of [18, 28]) rrect(g, x, 36, 3.5, 4, 1.5, "#5a3020");
      break;
    case "wolf":
      shadow(g, 24, 40, 13);
      ellipse(g, 9, 26 - f, 4.5, 7, "#7f899a");
      ellipse(g, 22, 30, 12, 8, "#8d97a8");
      ellipse(g, 22, 25, 10, 3.5, "#6c7686", null);
      ellipse(g, 24, 34, 6, 3.5, "#c9d0da", null);
      ellipse(g, 34, 22, 8.5, 7.5, "#8d97a8");
      poly(g, [[28, 18], [29, 9], [33, 15]], "#8d97a8");
      poly(g, [[35, 15], [39, 8], [40, 17]], "#8d97a8");
      ellipse(g, 39.5, 25.5, 5, 3.5, "#c9d0da");
      ellipse(g, 43.5, 24.5, 1.4, 1.1, INK, null);
      eye(g, 36, 21, 1.8, 2.4, "#c23a2a");
      g.strokeStyle = INK;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(33, 17.5);
      g.lineTo(38.5, 19);
      g.stroke();
      poly(g, [[38.5, 28], [39.5, 30.5], [40.5, 28]], "#ffffff", INK, 0.8);
      for (const x of [14, 19, 25, 30]) rrect(g, x, 35, 3.5, 5, 1.5, "#6c7686");
      break;
    case "bear":
      shadow(g, 24, 41, 15);
      ellipse(g, 22, 29 + f * 0.5, 15, 12 - f * 0.5, "#9a6038");
      ellipse(g, 23, 32, 8, 7, "#c89468", null);
      ellipse(g, 32, 17, 9.5, 9, "#9a6038");
      ellipse(g, 26, 9, 3.5, 3.5, "#9a6038");
      ellipse(g, 26, 9, 1.8, 1.8, "#c89468", null);
      ellipse(g, 37, 9, 3.5, 3.5, "#9a6038");
      ellipse(g, 37, 9, 1.8, 1.8, "#c89468", null);
      ellipse(g, 36, 21, 4.5, 3.5, "#e6c29c");
      ellipse(g, 38, 19.5, 1.6, 1.2, INK, null);
      eye(g, 29, 15.5, 1.6, 2.2);
      eye(g, 35.5, 15, 1.6, 2.2);
      for (const x of [11, 29]) ellipse(g, x, 39, 4.5, 2.5, "#7a4a28");
      break;
    case "goblin":
      shadow(g, 24, 41, 12);
      // 방망이
      g.save();
      g.translate(38, 30);
      g.rotate(-0.4 + f * 0.25);
      rrect(g, -2, -4, 4, 14, 2, "#8a5a2a");
      rrect(g, -4.5, -18, 9, 16, 4.5, "#b07a3a");
      for (const [x, y] of [[-2, -14], [2, -10], [-1, -6]]) ellipse(g, x, y, 1, 1, "#f4f0e0", INK, 0.6);
      g.restore();
      ellipse(g, 22, 27 + f * 0.5, 12, 13 - f * 0.5, "#4a86e0");
      poly(g, [[20, 13], [22, 3], [25, 13]], "#ffd84a");
      rrect(g, 12, 30, 20, 6, 2, "#ffc83a");
      for (const x of [15, 20, 25, 29]) {
        g.fillStyle = INK;
        g.fillRect(x, 30.5, 1.6, 5);
      }
      eye(g, 18, 22, 2.6, 3.2, "#1a1a1a");
      eye(g, 27, 22, 2.6, 3.2, "#1a1a1a");
      g.beginPath();
      g.moveTo(16, 27);
      g.quadraticCurveTo(22.5, 32, 29, 27);
      g.closePath();
      g.fillStyle = "#8a1a2a";
      g.fill();
      g.strokeStyle = INK;
      g.lineWidth = 1.2;
      g.stroke();
      poly(g, [[18, 27.5], [19.5, 29.5], [21, 28.2]], "#ffffff", null);
      poly(g, [[24, 28.2], [25.5, 29.5], [27, 27.5]], "#ffffff", null);
      for (const x of [15, 26]) ellipse(g, x + 2, 39.5, 3.5, 2, "#3a6ac0");
      break;
    default:
      shadow(g, 24, 40, 10);
      ellipse(g, 24, 30, 10, 9, "#c040c0");
  }
}

export function monsterSprite(kind: string, dir: Dir, frame: number): Sprite {
  const d = dir === "left" ? "left" : "right";
  return make(`m:${kind}:${d}:${frame % 2}`, 48, 44, 24, 40, (g) => {
    if (d === "left") {
      g.translate(48, 0);
      g.scale(-1, 1);
    }
    drawMonster(g, kind, frame);
  });
}

// ---------- 아이템 ----------

function drawItem(g: G, item: string) {
  switch (item) {
    case "potion_red":
    case "potion_blue": {
      const c = item === "potion_red" ? "#ff4a5a" : "#4a8aff";
      rrect(g, 13, 5, 6, 5, 1.5, "#d8b890");
      ellipse(g, 16, 18, 8, 8, c);
      ellipse(g, 13, 15, 2.5, 3, "rgba(255,255,255,0.7)", null);
      break;
    }
    case "wood_sword":
    case "iron_sword": {
      g.save();
      g.translate(16, 16);
      g.rotate(-Math.PI / 4);
      rrect(g, -2.5, -13, 5, 18, [2.5, 2.5, 0, 0], item === "iron_sword" ? "#e4ecf6" : "#d9a868");
      rrect(g, -6, 4, 12, 3, 1.5, "#ffd166");
      rrect(g, -1.8, 7, 3.6, 6, 1, "#7a4a28");
      g.restore();
      break;
    }
    case "oak_staff":
      g.save();
      g.translate(16, 16);
      g.rotate(Math.PI / 5);
      rrect(g, -1.8, -8, 3.6, 22, 1.5, "#a8703c");
      ellipse(g, 0, -11, 5, 5, "#6fe0b0");
      ellipse(g, -1.5, -12.5, 1.5, 1.5, "#ffffff", null);
      g.restore();
      break;
    case "goblin_club":
      g.save();
      g.translate(16, 17);
      g.rotate(-0.5);
      rrect(g, -2, 2, 4, 11, 2, "#8a5a2a");
      rrect(g, -5, -13, 10, 17, 5, "#b07a3a");
      g.restore();
      break;
    default: {
      const colors: Record<string, string> = {
        squirrel_tail: "#c47a3c", rabbit_fur: "#ffffff", fox_pelt: "#f28a2e", wolf_fang: "#f4f0e0", bear_paw: "#9a6038",
      };
      rrect(g, 7, 10, 18, 15, 6, "#d8b27a");
      rrect(g, 11, 6, 10, 6, 3, "#c49a5a");
      ellipse(g, 16, 18, 4.5, 4, colors[item] ?? "#aaa");
    }
  }
}

export function itemSprite(item: string): Sprite {
  return make(`i:${item}`, 32, 32, 16, 24, (g) => drawItem(g, item));
}

/** 소지품 창용 아이콘: 32×32 캔버스 (1배 크기) */
export function itemIcon(item: string): HTMLCanvasElement {
  const s = itemSprite(item);
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  c.getContext("2d")!.drawImage(s.c, 0, 0, 64, 64);
  return c;
}

/** 스프라이트를 기준점이 (x, y) 에 오도록 그린다. sx/sy 로 통통 튀는 변형을 줄 수 있다. */
export function drawSprite(ctx: CanvasRenderingContext2D, s: Sprite, x: number, y: number, sx = 1, sy = 1) {
  if (sx === 1 && sy === 1) {
    ctx.drawImage(s.c, x - s.ax, y - s.ay, s.w, s.h);
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(sx, sy);
  ctx.drawImage(s.c, -s.ax, -s.ay, s.w, s.h);
  ctx.restore();
}
