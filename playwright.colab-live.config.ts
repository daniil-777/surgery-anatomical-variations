import { defineConfig } from "@playwright/test";

// No mocks or automatic server changes: exercise the imported Colab models.
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "atlas-colab-live.spec.ts", workers: 1,
  timeout: 180000, expect: { timeout: 30000 }, reporter: "list",
  outputDir: process.env.VISCERA_COLAB_QA_DIR ?? "test-results/colab-live",
  use: { baseURL: process.env.VISCERA_STUDIO_URL ?? "http://127.0.0.1:5174",
    viewport: { width: 1600, height: 1100 }, screenshot: "only-on-failure", trace: "retain-on-failure",
    launchOptions: { args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] } },
});
