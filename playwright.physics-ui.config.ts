import { defineConfig } from "@playwright/test";
const port = Number(process.env.VISCERA_UI_TEST_PORT ?? 5187);
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({ testDir: "./tests/e2e", testMatch: "atlas-physics-ui.spec.ts", fullyParallel: false, workers: 1,
  timeout: 60000, expect: { timeout: 15000 }, reporter: [["list"], ["json", { outputFile: "test-results/physics-ui/results.json" }]], outputDir: process.env.VISCERA_UI_TEST_OUTPUT_DIR ?? "test-results/physics-ui",
  use: { baseURL, viewport: { width: 1500, height: 1100 }, screenshot: "only-on-failure", trace: "retain-on-failure",
    launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] } },
  webServer: { command: `node node_modules/vite/bin/vite.js --config apps/studio/vite.disease-qa.config.ts --port ${port}`, url: baseURL, reuseExistingServer: false } });
