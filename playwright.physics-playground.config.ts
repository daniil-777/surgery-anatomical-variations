import { defineConfig } from "@playwright/test";

/** Start the real API and Studio first; this suite deliberately does not mock physics. */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "atlas-physics-playground.spec.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 120000,
  expect: { timeout: 30000 },
  reporter: [["list"], ["json", { outputFile: "test-results/physics-playground/results.json" }]],
  outputDir: "test-results/physics-playground",
  use: {
    baseURL: process.env.VISCERA_PHYSICS_STUDIO_URL ?? "http://127.0.0.1:5198",
    viewport: { width: 1500, height: 1100 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: { mode: "on", size: { width: 1500, height: 1100 } },
    launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] },
  },
});
