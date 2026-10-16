import { defineConfig } from "@playwright/test";

/** Start the API and Studio separately so this exercises their real artifacts. */
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "atlas-physics-live.spec.ts", workers: 1, fullyParallel: false,
  timeout: 240000, expect: { timeout: 60000 }, reporter: [["list"], ["json", { outputFile: "test-results/physics-live/results.json" }]], outputDir: "test-results/physics-live",
  use: {
    baseURL: process.env.VISCERA_PHYSICS_STUDIO_URL ?? "http://127.0.0.1:5198",
    viewport: { width: 1500, height: 1100 }, screenshot: "only-on-failure", trace: "retain-on-failure", video: { mode: "on", size: { width: 1500, height: 1100 } },
    launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] },
  },
});
