import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 4391);

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "reports/e2e.json" }]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1000, height: 700 },
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "node scripts/build.mjs && node dist/server/main.js",
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { PORT: String(PORT), DATA_DIR: "test-results/e2e-data", TEST_HOOKS: "1" },
  },
});
