// 전체 검증 파이프라인: typecheck → lint → build → test → e2e
// 테스트 결과(JSON 리포터)에서 AC 번호를 파싱해 verify-report.json 을 자동 생성한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const AC_IDS = Array.from({ length: 20 }, (_, i) => `AC-${String(i + 1).padStart(2, "0")}`);
const STEPS = [
  ["typecheck", "npx", ["tsc", "--noEmit"]],
  ["lint", "npx", ["eslint", "."]],
  ["build", "node", ["scripts/build.mjs"]],
  ["test", "npx", ["vitest", "run"]],
  ["e2e", "npx", ["playwright", "test"]],
];

fs.rmSync("reports", { recursive: true, force: true });
fs.mkdirSync("reports", { recursive: true });

const steps = {};
for (const [name, cmd, args] of STEPS) {
  console.log(`\n━━━ ${name}: ${cmd} ${args.join(" ")}`);
  const started = Date.now();
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, FORCE_COLOR: "0" } });
  steps[name] = r.status === 0 ? "pass" : "fail";
  console.log(`━━━ ${name}: ${steps[name]} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

/** @type {{ title: string; status: "passed" | "failed" | "skipped" }[]} */
const results = [];

try {
  const v = JSON.parse(fs.readFileSync("reports/vitest.json", "utf8"));
  for (const file of v.testResults ?? [])
    for (const a of file.assertionResults ?? [])
      results.push({ title: a.fullName ?? a.title, status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped" });
} catch (e) {
  console.error("vitest 리포트를 읽지 못함:", e.message);
}

try {
  const p = JSON.parse(fs.readFileSync("reports/e2e.json", "utf8"));
  const walk = (suite, prefix) => {
    for (const spec of suite.specs ?? [])
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        const st = last?.status === "passed" ? "passed" : last?.status === "skipped" || !last ? "skipped" : "failed";
        results.push({ title: `${prefix} ${spec.title}`.trim(), status: st });
      }
    for (const s of suite.suites ?? []) walk(s, `${prefix} ${s.title}`);
  };
  for (const s of p.suites ?? []) walk(s, "");
} catch (e) {
  console.error("e2e 리포트를 읽지 못함:", e.message);
}

const acceptance = {};
for (const id of AC_IDS) {
  const mine = results.filter((r) => r.title.includes(id));
  acceptance[id] = mine.length === 0 ? "missing" : mine.every((r) => r.status === "passed") ? "pass" : "fail";
}

const tests = {
  total: results.length,
  passed: results.filter((r) => r.status === "passed").length,
  failed: results.filter((r) => r.status === "failed").length,
  skipped: results.filter((r) => r.status === "skipped").length,
};

const report = { timestamp: new Date().toISOString(), steps, tests, acceptance };
fs.writeFileSync("verify-report.json", JSON.stringify(report, null, 2) + "\n");

console.log("\n━━━ 검증 요약");
console.log(Object.entries(steps).map(([k, v]) => `${k} ${v === "pass" ? "✅" : "❌"}`).join("  "));
console.log(`테스트 ${tests.passed}/${tests.total} 통과 (실패 ${tests.failed}, 스킵 ${tests.skipped})`);
const bad = AC_IDS.filter((id) => acceptance[id] !== "pass");
console.log(bad.length ? `미통과 AC: ${bad.map((id) => `${id}=${acceptance[id]}`).join(", ")}` : "AC-01 ~ AC-20 전부 통과");

const ok = Object.values(steps).every((s) => s === "pass") && bad.length === 0 && tests.failed === 0 && tests.skipped === 0 && tests.total > 0;
process.exit(ok ? 0 : 1);
