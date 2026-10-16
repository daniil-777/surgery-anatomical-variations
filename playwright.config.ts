import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5174",
    viewport: { width: 1600, height: 1000 },
    video: "on",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      args:
        process.platform === "darwin"
          ? ["--use-gl=angle", "--use-angle=metal"]
          : [],
    },
  },
  webServer: [
    {
      command:
        ".venv/bin/python -m uvicorn services.api.app:app --host 127.0.0.1 --port 8000",
      url: "http://127.0.0.1:8000/api/health",
      reuseExistingServer: true,
    },
    {
      command:
        "node node_modules/vite/bin/vite.js --config apps/studio/vite.config.ts",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: true,
    },
  ],
});
