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

// 단일 파일판: 서버 없이 브라우저 안에서 월드를 돌린다. 스크립트를 HTML 에 인라인한다.
const offline = await build({
  entryPoints: ["client/offline.ts"],
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  minify: true,
  write: false,
  logLevel: "warning",
});
const js = offline.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");
const html = fs.readFileSync("client/index.html", "utf8");
const inlined = html.replace('<script src="bundle.js"></script>', () => `<script>${js}</script>`);
fs.rmSync("dist/offline", { recursive: true, force: true });
fs.mkdirSync("dist/offline", { recursive: true });
fs.writeFileSync("dist/offline/pungunrok.html", inlined);
// 게시용: 문서 골격(doctype/html/head/body)을 뺀 본문만
const head = /<head>([\s\S]*?)<\/head>/.exec(inlined)[1].replace(/<meta[^>]*>\s*/g, "");
const body = /<body>([\s\S]*)<\/body>/.exec(inlined)[1];
fs.writeFileSync("dist/offline/artifact.html", `${head.trim()}\n${body.trim()}\n`);
console.log("build ok: dist/server/main.js, dist/client/{index.html,bundle.js}, dist/offline/pungunrok.html");
