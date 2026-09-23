// 파일 기반 캐릭터 저장소. 캐릭터 하나당 JSON 파일 하나, 임시 파일에 쓴 뒤 rename 해 원자적으로 교체한다.
import fs from "node:fs";
import path from "node:path";
import { JOBS, type Job } from "../shared/types";
import type { CharacterSave } from "./world";

export class Storage {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "characters");
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, `${encodeURIComponent(name)}.json`);
  }

  load(name: string): CharacterSave | null {
    let raw: string;
    try {
      raw = fs.readFileSync(this.file(name), "utf8");
    } catch {
      return null;
    }
    try {
      const c = JSON.parse(raw) as CharacterSave;
      if (c.name !== name || !JOBS.includes(c.job as Job) || !Number.isInteger(c.level)) return null;
      return c;
    } catch (e) {
      console.error(`[storage] ${name} 저장 파일 손상:`, e);
      return null;
    }
  }

  save(c: CharacterSave): void {
    const target = this.file(c.name);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c));
    fs.renameSync(tmp, target);
  }
}
