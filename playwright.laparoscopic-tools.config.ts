import { defineConfig } from "@playwright/test";

/** Requires the actual API and Studio; no geometry or physics network mocks. */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["atlas-laparoscopic-tools.spec.ts", "atlas-physics-playground.spec.ts"],
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 30000 },
  reporter: [["list"], ["json", { outputFile: "test-results/laparoscopic-tools/results.json" }]],
  outputDir: "test-results/laparoscopic-tools",
  use: {
    baseURL: process.env.VISCERA_PHYSICS_STUDIO_URL ?? "http://127.0.0.1:5198",
    viewport: { width: 1500, height: 1100 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: { mode: "on", size: { width: 1500, height: 1100 } },
    launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] },
  },
});
