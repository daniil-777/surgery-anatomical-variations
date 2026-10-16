import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const evidence = process.env.VISCERA_WHOLE_SCENE_EVIDENCE_DIR
  ? resolve(process.env.VISCERA_WHOLE_SCENE_EVIDENCE_DIR)
  : fileURLToPath(new URL("./benchmarks/results/whole-scene-2026-10-08/", import.meta.url));

const port = Number(process.env.VISCERA_WHOLE_SCENE_PORT ?? 5196);
const baseURL = process.env.VISCERA_WHOLE_SCENE_URL ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "whole-scene.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: `${evidence}/browser-results.json` }]],
  outputDir: `${evidence}/browser`,
  use: {
    baseURL,
    channel: process.env.VISCERA_WHOLE_SCENE_BROWSER,
    viewport: { width: 1600, height: 1100 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [],
    },
  },
  ...(process.env.VISCERA_WHOLE_SCENE_URL ? {} : {
    webServer: {
      command: `"${process.execPath}" node_modules/vite/bin/vite.js --config apps/studio/vite.disease-qa.config.ts --port ${port}`,
      url: baseURL,
      reuseExistingServer: false,
    },
  }),
});
