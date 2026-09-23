import type { MapData, NpcDef, Portal } from "./mapgen";
import town from "./maps/town.json";
import field from "./maps/field.json";
import cave from "./maps/cave.json";

export type { MapData, NpcDef, Portal };
export { T, SOLID_TILES } from "./mapgen";

export const MAPS: Record<string, MapData> = {
  town: town as unknown as MapData,
  field: field as unknown as MapData,
  cave: cave as unknown as MapData,
};

export const START_MAP = "town";

export function inBounds(m: MapData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < m.width && y < m.height;
}

/** 지형 충돌(벽·물·나무·건물·NPC). 맵 밖도 막힌 것으로 본다. */
export function isBlocked(m: MapData, x: number, y: number): boolean {
  return !inBounds(m, x, y) || m.collision[y][x] === 1;
}

export function portalAt(m: MapData, x: number, y: number): Portal | undefined {
  return m.portals.find((p) => p.x === x && p.y === y);
}
