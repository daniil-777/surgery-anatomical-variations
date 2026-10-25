import { defineConfig } from "@playwright/test";

const output = process.env.MODEL_NAMES_OUTPUT ?? "artifacts/model-names/browser";
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: ["model-names.spec.ts", "atlas-models-ui.spec.ts", "atlas-joint-ui.spec.ts"],
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  reporter: [["list"], ["json", { outputFile: `${output}/results.json` }]],
  outputDir: `${output}/test-results`,
  use: {
    baseURL: process.env.MODEL_NAMES_URL ?? "http://127.0.0.1:5177",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: {
      ...(process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {}),
      args: process.platform === "darwin" ? ["--use-angle=metal"] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
    },
  },
});
