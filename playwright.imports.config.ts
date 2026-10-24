import { defineConfig } from "@playwright/test";

const output = process.env.IMPORTS_OUTPUT ?? "artifacts/imported-models-2026-10-20/browser";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "imported-models.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 25_000 },
  reporter: [["list"], ["json", { outputFile: `${output}/results.json` }]],
  outputDir: `${output}/test-results`,
  use: {
    baseURL: process.env.IMPORTS_URL ?? "http://127.0.0.1:5174",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: Number(process.env.IMPORTS_DPR ?? "1"),
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.platform === "darwin"
        ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}),
      args: [
        ...(process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : []),
        // Chromium's explicitly synthetic device; tests never use a person's microphone.
        "--use-fake-device-for-media-stream",
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
});
