// 서버·클라이언트 번들 빌드 (esbuild)
import { build } from "esbuild";
import fs from "node:fs";

fs.rmSync("dist/server", { recursive: true, force: true });
fs.rmSync("dist/client", { recursive: true, force: true });
await build({
  entryPoints: ["server/main.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  outfile: "dist/server/main.js",
  logLevel: "warning",
});
await build({
  entryPoints: ["client/main.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  sourcemap: true,
  outfile: "dist/client/bundle.js",
  logLevel: "warning",
});
fs.copyFileSync("client/index.html", "dist/client/index.html");
console.log("build ok: dist/server/main.js, dist/client/{index.html,bundle.js}");
