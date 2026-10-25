import { defineConfig } from "@playwright/test";

const production = process.env.TISSUE_PRODUCTION_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["tissue-lab.spec.ts", "tissue-neural.spec.ts", "tissue-learned.spec.ts", "tissue-repair.spec.ts"],
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 45_000 },
  reporter: [["list"]],
  outputDir: `${process.env.TISSUE_TEST_OUTPUT ?? "artifacts/tissue-lab-v3"}/test-results`,
  use: {
    baseURL: production ? new URL(".", production).href : "http://127.0.0.1:5176/",
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: process.platform === "darwin" ? {
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args: ["--use-gl=angle", "--use-angle=metal"],
    } : {},
  },
  webServer: production ? undefined : {
    command: "node node_modules/vite/bin/vite.js --config apps/studio/vite.config.ts --host 127.0.0.1 --port 5176 --strictPort",
    url: "http://127.0.0.1:5176",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
