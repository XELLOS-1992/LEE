// 맵 JSON 생성: npm run maps
import fs from "node:fs";
import path from "node:path";
import { generateAll } from "../shared/mapgen";

const outDir = path.resolve("shared/maps");
fs.mkdirSync(outDir, { recursive: true });
for (const m of generateAll()) {
  fs.writeFileSync(path.join(outDir, `${m.id}.json`), serializeMap(m));
  console.log(`wrote ${m.id}.json (${m.width}x${m.height})`);
}

function serializeMap(m: object): string {
  // 2차원 배열은 한 행씩 한 줄로 저장해 diff 가 읽기 쉽게 한다.
  return JSON.stringify(m, null, 1).replace(/\[\s+([\d,\s]+?)\s+\]/g, (_, body: string) => `[${body.replace(/\s+/g, "")}]`) + "\n";
}
