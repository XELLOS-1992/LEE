import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SKILLS } from "../shared/balance";
import { MAPS } from "../shared/maps";
import { JOBS } from "../shared/types";

const readme = fs.readFileSync("README.md", "utf8");

describe("AC-20 문서", () => {
  it("AC-20 README 에 실행 방법·조작법·구조도가 있다", () => {
    expect(readme).toMatch(/^## 실행 방법/m);
    expect(readme).toMatch(/^## 조작법/m);
    expect(readme).toMatch(/^## 구조/m);
    expect(readme).toContain("npm install");
    expect(readme).toContain("npm start");
    for (const env of ["PORT", "DATA_DIR"]) expect(readme).toContain(env);
  });

  it("AC-20 문서화된 조작 키·스킬·맵 이름이 실제 게임과 일치한다", () => {
    for (const key of ["방향키", "Space", "Ctrl", "Enter", "`I`", "`Z`", "`T`", "`Q`", "Esc"]) expect(readme).toContain(key);
    for (const job of JOBS) for (const s of SKILLS[job]) expect(readme).toContain(s.name);
    for (const m of Object.values(MAPS)) expect(readme).toContain(m.name);
  });
});
