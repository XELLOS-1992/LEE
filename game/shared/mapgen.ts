// 결정적(시드 고정) 맵 생성기. `npm run maps`로 shared/maps/*.json 을 다시 만든다.
import { makeRng, type Rng } from "./rules";

export const T = {
  GRASS: 0,
  ROAD: 1,
  WATER: 2,
  TREE: 3,
  WALL: 4,
  THATCH: 5,
  GIWA: 6,
  PORTAL: 7,
  CAVE: 8,
  ROCK: 9,
  BRIDGE: 10,
  FLOWER: 11,
  DIRT: 12,
} as const;

export const SOLID_TILES: ReadonlySet<number> = new Set([T.WATER, T.TREE, T.WALL, T.THATCH, T.GIWA, T.ROCK]);

export interface Portal { x: number; y: number; to: string; tx: number; ty: number; label: string }
export interface SpawnArea { kind: string; count: number; area: { x: number; y: number; w: number; h: number } }
export interface NpcDef { id: string; name: string; x: number; y: number; dir: "down" | "up" | "left" | "right"; text: string; shop: string[] | null; look: string }

export interface MapData {
  id: string;
  name: string;
  kind: "town" | "hunt";
  width: number;
  height: number;
  entry: { x: number; y: number };
  tiles: number[][];
  collision: number[][];
  portals: Portal[];
  spawns: SpawnArea[];
  npcs: NpcDef[];
}

const W = 48;
const H = 48;

function grid(fill: number): number[][] {
  return Array.from({ length: H }, () => Array<number>(W).fill(fill));
}

function rect(g: number[][], x: number, y: number, w: number, h: number, v: number) {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (g[j]?.[i] !== undefined) g[j][i] = v;
}

function scatter(g: number[][], rng: Rng, v: number, density: number, canPlace: (x: number, y: number) => boolean) {
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) if (rng() < density && canPlace(x, y)) g[y][x] = v;
}

/** 시작점에서 도달할 수 없는 이동 가능 칸을 막아 맵 전체를 연결 상태로 만든다. */
function sealUnreachable(g: number[][], start: { x: number; y: number }, fill: number, blocked: Set<string>) {
  const seen = new Set<string>();
  const q: [number, number][] = [[start.x, start.y]];
  seen.add(`${start.x},${start.y}`);
  while (q.length) {
    const [x, y] = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      const k = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen.has(k)) continue;
      if (SOLID_TILES.has(g[ny][nx]) || blocked.has(k)) continue;
      seen.add(k);
      if (g[ny][nx] !== T.PORTAL) q.push([nx, ny]);
    }
  }
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (!SOLID_TILES.has(g[y][x]) && !seen.has(`${x},${y}`) && !blocked.has(`${x},${y}`)) g[y][x] = fill;
}

function finish(m: Omit<MapData, "collision" | "width" | "height">): MapData {
  const collision = m.tiles.map((row) => row.map((t) => (SOLID_TILES.has(t) ? 1 : 0)));
  for (const n of m.npcs) collision[n.y][n.x] = 1;
  return { ...m, width: W, height: H, collision };
}

function nearRoad(g: number[][], x: number, y: number, r: number): boolean {
  for (let j = y - r; j <= y + r; j++)
    for (let i = x - r; i <= x + r; i++) {
      const t = g[j]?.[i];
      if (t === T.ROAD || t === T.DIRT || t === T.BRIDGE || t === T.PORTAL) return true;
    }
  return false;
}

export function genTown(): MapData {
  const rng = makeRng(1001);
  const g = grid(T.GRASS);
  // 성벽
  rect(g, 0, 0, W, 1, T.WALL); rect(g, 0, H - 1, W, 1, T.WALL);
  rect(g, 0, 0, 1, H, T.WALL); rect(g, W - 1, 0, 1, H, T.WALL);
  // 십자 돌길과 광장
  rect(g, 1, 23, W - 2, 2, T.ROAD);
  rect(g, 23, 1, 2, H - 2, T.ROAD);
  rect(g, 19, 19, 10, 10, T.ROAD);
  // 동문 (사냥터로 가는 포털)
  g[23][W - 1] = T.PORTAL; g[24][W - 1] = T.PORTAL;
  // 관청(기와집)과 민가(초가집)
  rect(g, 27, 3, 10, 5, T.GIWA);
  rect(g, 4, 4, 5, 3, T.GIWA);
  for (const [x, y] of [[12, 5], [4, 12], [12, 13], [30, 12], [38, 13], [4, 30], [12, 30], [4, 38], [13, 39], [30, 30], [30, 38]])
    rect(g, x, y, 4, 3, T.THATCH);
  // 연못
  for (let y = 34; y <= 42; y++) for (let x = 36; x <= 44; x++) if ((x - 40) ** 2 + (y - 38) ** 2 <= 11) g[y][x] = T.WATER;
  const free = (x: number, y: number) => g[y][x] === T.GRASS && !nearRoad(g, x, y, 1);
  scatter(g, rng, T.TREE, 0.05, free);
  scatter(g, rng, T.FLOWER, 0.05, (x, y) => g[y][x] === T.GRASS);
  const npcs: NpcDef[] = [
    { id: "jumo", name: "주모", x: 20, y: 20, dir: "down", look: "jumo", shop: ["potion_red", "potion_blue"],
      text: "어서 오시오, 나그네. 사냥 가기 전에 물약 몇 병 챙기시게." },
    { id: "smith", name: "대장장이", x: 27, y: 20, dir: "down", look: "smith", shop: ["wood_sword", "oak_staff", "iron_sword"],
      text: "쇠 두드리는 소리가 좋지 않소? 무기가 필요하면 말하시오." },
    { id: "elder", name: "촌장", x: 20, y: 27, dir: "right", look: "elder", shop: null,
      text: "졸본성에 온 것을 환영하네. 동문을 나서면 비류수 들판이 있고, 그 너머 흑림 동굴에는 도깨비가 산다네." },
  ];
  const entry = { x: 24, y: 26 };
  sealUnreachable(g, entry, T.TREE, new Set(npcs.map((n) => `${n.x},${n.y}`)));
  return finish({
    id: "town", name: "졸본성", kind: "town", entry, tiles: g,
    portals: [
      { x: W - 1, y: 23, to: "field", tx: 1, ty: 23, label: "비류수 들판" },
      { x: W - 1, y: 24, to: "field", tx: 1, ty: 24, label: "비류수 들판" },
    ],
    spawns: [], npcs,
  });
}

export function genField(): MapData {
  const rng = makeRng(2002);
  const g = grid(T.GRASS);
  rect(g, 0, 0, W, 1, T.TREE); rect(g, 0, H - 1, W, 1, T.TREE);
  rect(g, 0, 0, 1, H, T.TREE); rect(g, W - 1, 0, 1, H, T.TREE);
  // 강과 다리
  for (let y = 1; y < H - 1; y++) {
    const off = Math.round(Math.sin(y / 6) * 2);
    rect(g, 30 + off, y, 3, 1, T.WATER);
  }
  rect(g, 1, 23, W - 2, 2, T.DIRT);
  for (let x = 26; x <= 36; x++) for (const y of [23, 24]) if (g[y][x] === T.WATER) g[y][x] = T.BRIDGE;
  g[23][0] = T.PORTAL; g[24][0] = T.PORTAL;
  g[23][W - 1] = T.PORTAL; g[24][W - 1] = T.PORTAL;
  scatter(g, rng, T.TREE, 0.08, (x, y) => g[y][x] === T.GRASS && !nearRoad(g, x, y, 1));
  scatter(g, rng, T.FLOWER, 0.06, (x, y) => g[y][x] === T.GRASS);
  const entry = { x: 1, y: 23 };
  sealUnreachable(g, entry, T.TREE, new Set());
  return finish({
    id: "field", name: "비류수 들판", kind: "hunt", entry, tiles: g,
    portals: [
      { x: 0, y: 23, to: "town", tx: W - 2, ty: 23, label: "졸본성" },
      { x: 0, y: 24, to: "town", tx: W - 2, ty: 24, label: "졸본성" },
      { x: W - 1, y: 23, to: "cave", tx: 1, ty: 23, label: "흑림 동굴" },
      { x: W - 1, y: 24, to: "cave", tx: 1, ty: 24, label: "흑림 동굴" },
    ],
    spawns: [
      { kind: "squirrel", count: 14, area: { x: 2, y: 2, w: 25, h: 19 } },
      { kind: "rabbit", count: 12, area: { x: 2, y: 27, w: 25, h: 19 } },
      { kind: "fox", count: 10, area: { x: 34, y: 2, w: 12, h: 44 } },
    ],
    npcs: [],
  });
}

export function genCave(): MapData {
  const rng = makeRng(3003);
  const g = grid(T.CAVE);
  rect(g, 0, 0, W, 1, T.ROCK); rect(g, 0, H - 1, W, 1, T.ROCK);
  rect(g, 0, 0, 1, H, T.ROCK); rect(g, W - 1, 0, 1, H, T.ROCK);
  rect(g, 1, 23, 30, 2, T.DIRT);
  g[23][0] = T.PORTAL; g[24][0] = T.PORTAL;
  // 바위 무더기
  for (let k = 0; k < 26; k++) {
    const cx = 3 + Math.floor(rng() * 42), cy = 3 + Math.floor(rng() * 42), r = 1 + Math.floor(rng() * 2);
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++)
        if (g[y]?.[x] === T.CAVE && !nearRoad(g, x, y, 1) && rng() < 0.8) g[y][x] = T.ROCK;
  }
  // 지하수 웅덩이
  for (let y = 5; y <= 11; y++) for (let x = 36; x <= 43; x++) if ((x - 39.5) ** 2 + (y - 8) ** 2 <= 9) g[y][x] = T.WATER;
  const entry = { x: 1, y: 23 };
  sealUnreachable(g, entry, T.ROCK, new Set());
  return finish({
    id: "cave", name: "흑림 동굴", kind: "hunt", entry, tiles: g,
    portals: [
      { x: 0, y: 23, to: "field", tx: W - 2, ty: 23, label: "비류수 들판" },
      { x: 0, y: 24, to: "field", tx: W - 2, ty: 24, label: "비류수 들판" },
    ],
    spawns: [
      { kind: "wolf", count: 10, area: { x: 2, y: 2, w: 44, h: 19 } },
      { kind: "bear", count: 7, area: { x: 2, y: 27, w: 22, h: 19 } },
      { kind: "goblin", count: 5, area: { x: 26, y: 27, w: 20, h: 19 } },
    ],
    npcs: [],
  });
}

export function generateAll(): MapData[] {
  return [genTown(), genField(), genCave()];
}
