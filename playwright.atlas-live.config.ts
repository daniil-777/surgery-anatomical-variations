import { defineConfig } from "@playwright/test";

// Integration checks against the running Atlas API and its real reference meshes.
export default defineConfig({
  testDir: "./tests/e2e", testMatch: "atlas-live.spec.ts", workers: 1,
  timeout: 120000, expect: { timeout: 30000 },
  use: { baseURL: process.env.VISCERA_STUDIO_URL ?? "http://127.0.0.1:5175", viewport: { width: 1600, height: 1100 }, screenshot: "only-on-failure", launchOptions: { args: ["--use-gl=angle", "--use-angle=metal"] } },
  reporter: [["list"]],
});
