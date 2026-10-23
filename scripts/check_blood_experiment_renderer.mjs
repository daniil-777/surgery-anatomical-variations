#!/usr/bin/env node
// Development-only real-WebGL lifecycle/appearance/native-buffer regression.
// Run serially with other GPU jobs. No application import exposes the bench.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ??
  path.join(root, "artifacts/blood-experiments-2026-10-20/renderer"));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal"],
} : {}) });
const browserErrors = [], warnings = [], failedRequests = [];
let result;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => browserErrors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") browserErrors.push(message.text());
    if (message.type() === "warning") warnings.push(message.text());
  });
  page.on("response", response => {
    if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() });
  });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.goto(new URL("src/blood/blood.css", base).href);
  result = await page.evaluate(async () =>
    (await import("/src/blood/experiments/renderBench.ts")).bloodExperimentRendererBench());
  const images = [];
  for (const capture of result.captures ?? []) {
    if (!/^[a-z0-9-]+$/.test(capture.name) || !capture.dataUrl.startsWith("data:image/png;base64,"))
      throw new Error("Unexpected bench capture");
    const bytes = Buffer.from(capture.dataUrl.split(",")[1], "base64"), file = `${capture.name}.png`;
    await fs.writeFile(path.join(out, file), bytes);
    images.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  delete result.captures; result.images = images;
  if (result.status !== "PASS" || browserErrors.length || failedRequests.length) process.exitCode = 1;
  console.log(JSON.stringify({ status: result.status, checks: result.checks.length, browserErrors,
    failedRequests, failed: result.checks.filter(check => !check.passed) }, null, 2));
} catch (error) {
  browserErrors.push(error instanceof Error ? error.stack : String(error)); process.exitCode = 1;
} finally {
  const sourceHashes = {};
  for (const name of ["apps/studio/src/blood/experiments/renderBench.ts",
    "apps/studio/src/blood/experiments/renderer.ts", "apps/studio/src/blood/experiments/appearance.ts",
    "apps/studio/src/blood/experiments/geometry.ts", "apps/studio/src/blood/experiments/bloodAppearanceOptics.ts",
    "apps/studio/src/blood/experiments/bloodAppearanceLut.generated.ts",
    "apps/studio/src/blood/experiments/tankSolver.ts", "apps/studio/src/blood/experiments/vesselSolver.ts",
    "apps/studio/src/blood/experiments/vesselFlow.ts", "apps/studio/src/blood/experiments/jetBreakup.ts",
    "apps/studio/src/blood/experiments/jetCollision.ts",
    "apps/studio/src/blood/experiments/breakupGeometry.ts", "apps/studio/src/blood/experiments/collector.ts",
    "apps/studio/src/blood/experiments/collectorThinFilm.ts", "apps/studio/src/blood/experiments/cardiovascular.ts",
    "packages/render/src/sceneRecording.ts",
    "scripts/check_blood_experiment_renderer.mjs"]) {
    try { sourceHashes[name] = createHash("sha256").update(await fs.readFile(path.join(root, name))).digest("hex"); }
    catch { sourceHashes[name] = "unavailable"; }
  }
  await fs.writeFile(path.join(out, "renderer.json"), JSON.stringify({
    ...result, status: process.exitCode ? "FAIL" : result?.status, browserErrors, warnings, failedRequests,
    baseURL: base.href, sourceHashes,
  }, null, 2));
  await browser.close();
}
