import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e", testMatch: process.env.VISCERA_JOINT_LIVE === "1" ? "atlas-joint-live.spec.ts" : ["atlas-joint-ui.spec.ts", "atlas-models-ui.spec.ts"], workers: 1,
  timeout: 180000, expect: { timeout: 15000 }, reporter: "list",
  outputDir: process.env.VISCERA_JOINT_QA_DIR ?? "test-results/joint",
  use: { baseURL: process.env.VISCERA_STUDIO_URL ?? "http://127.0.0.1:5174",
    viewport: { width: 1600, height: 1100 }, screenshot: "only-on-failure", trace: "retain-on-failure",
    launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] } },
});
