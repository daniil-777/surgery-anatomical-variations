import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
const evidence = fileURLToPath(new URL("./benchmarks/results/whole-scene-quality-2026-10-08/", import.meta.url));
const iteration = process.env.VISCERA_QUALITY_ITERATION ?? "current";
const port = Number(process.env.VISCERA_QUALITY_PORT ?? 5198);
const baseURL = process.env.VISCERA_QUALITY_URL ?? `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "whole-scene-quality.spec.ts", workers: 1,
  timeout: 120_000, expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: `${evidence}/${iteration}/browser-results.json` }]],
  outputDir: `${evidence}/${iteration}/browser`,
  use: { baseURL, channel: process.env.VISCERA_WHOLE_SCENE_BROWSER ?? "chrome", viewport: { width: 1600, height: 1100 }, screenshot: "only-on-failure", trace: "retain-on-failure", launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] } },
  ...(process.env.VISCERA_QUALITY_URL ? {} : { webServer: { command: `"${process.execPath}" node_modules/vite/bin/vite.js --config apps/studio/vite.disease-qa.config.ts --port ${port}`, url: baseURL, reuseExistingServer: false } }),
});
