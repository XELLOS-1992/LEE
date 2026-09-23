// 맵 타일에서 그림용 개체(건물·나무·바위)와 가장자리 정보를 뽑는다. DOM 을 쓰지 않는 순수 함수.
import { T } from "../shared/mapgen";

export interface Building {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: "thatch" | "giwa";
}

export interface Prop {
  x: number;
  y: number;
  kind: "tree" | "rock";
  variant: number;
}

/** 같은 지붕 타일로 이루어진 직사각형 덩어리를 건물 한 채로 묶는다. */
export function findBuildings(tiles: number[][]): Building[] {
  const h = tiles.length, w = tiles[0].length;
  const seen = new Set<string>();
  const out: Building[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = tiles[y][x];
      if ((t !== T.THATCH && t !== T.GIWA) || seen.has(`${x},${y}`)) continue;
      let bw = 0;
      while (x + bw < w && tiles[y][x + bw] === t && !seen.has(`${x + bw},${y}`)) bw++;
      let bh = 0;
      while (y + bh < h && tiles[y + bh].slice(x, x + bw).every((v) => v === t)) bh++;
      for (let j = y; j < y + bh; j++) for (let i = x; i < x + bw; i++) seen.add(`${i},${j}`);
      out.push({ x, y, w: bw, h: bh, kind: t === T.GIWA ? "giwa" : "thatch" });
    }
  return out;
}

export function findProps(tiles: number[][]): Prop[] {
  const out: Prop[] = [];
  tiles.forEach((row, y) =>
    row.forEach((t, x) => {
      if (t === T.TREE) out.push({ x, y, kind: "tree", variant: (x * 7 + y * 13) % 4 });
      else if (t === T.ROCK) out.push({ x, y, kind: "rock", variant: (x * 5 + y * 3) % 3 });
    }),
  );
  return out;
}

/** 이웃 칸이 같은 무리인지 4비트(위1·오른2·아래4·왼8)로 나타낸다. 맵 밖은 같은 것으로 본다. */
export function edgeMask(tiles: number[][], x: number, y: number, same: (t: number) => boolean): number {
  const at = (i: number, j: number) => (tiles[j]?.[i] === undefined ? true : same(tiles[j][i]));
  return (at(x, y - 1) ? 1 : 0) | (at(x + 1, y) ? 2 : 0) | (at(x, y + 1) ? 4 : 0) | (at(x - 1, y) ? 8 : 0);
}

/** 지면으로 그릴 타일 종류: 건물·나무 아래는 풀, 바위 아래는 동굴 바닥. */
export function groundOf(t: number, cave: boolean): number {
  if (t === T.THATCH || t === T.GIWA || t === T.TREE) return T.GRASS;
  if (t === T.ROCK) return cave ? T.CAVE : T.GRASS;
  return t;
}
