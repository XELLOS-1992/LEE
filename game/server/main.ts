// 서버 진입점: PORT, DATA_DIR, TEST_HOOKS 환경변수를 읽어 서버를 띄운다.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGameServer } from "./server";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(here, "../../data"));

const game = await createGameServer({
  port,
  dataDir,
  staticDir: path.join(here, "../client"),
  testHooks: process.env.TEST_HOOKS === "1",
});
console.log(`풍운록 서버 실행 중: http://localhost:${game.port}  (데이터: ${dataDir})`);

let stopping = false;
const shutdown = (sig: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${sig} 수신 — 접속 중인 캐릭터 저장 후 종료`);
  try {
    game.saveAll();
  } catch (e) {
    console.error("저장 실패:", e);
  }
  process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
