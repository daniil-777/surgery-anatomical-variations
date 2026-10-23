#!/usr/bin/env node
// Development-only native renderer gate. Run alone on the GPU after source freeze.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { capturePublicBuildSources } from "./stage_public_assets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root,
  "artifacts/liver-bleeding-2026-10-20", `renderer-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
await fs.mkdir(out, { recursive: true });
// Reserve the receipt before opening a browser; never reuse previous evidence.
const receipt = await fs.open(path.join(out, "renderer.json"), "wx");
const started = performance.now(), hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Use the same complete authored-source/config/lock inventory as the motion
// and production gates. A new imported module (for example runoffContact.ts)
// must not silently fall outside verification because a manual list is stale.
const sourceHashes = async () => {
  const inventory = capturePublicBuildSources(root);
  const entries = inventory.map(file => [file.path, file.sha256]);
  entries.push([path.relative(root, import.meta.filename), hash(await fs.readFile(import.meta.filename))]);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
};
const report = { schema: "viscera.liver-renderer-verification/v1", status: "RUNNING", baseURL: base.href,
  startedAt: new Date().toISOString(), browserErrors: [], warnings: [], failedRequests: [], images: [],
  nativeGPU: true, modelAndRealismCertified: false };
let browser;
try {
  if (process.platform !== "darwin") throw new Error("This gate requires native macOS Chrome/Metal.");
  report.sourceHashes = await sourceHashes();
  browser = await chromium.launch({ headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--use-gl=angle", "--use-angle=metal"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => report.browserErrors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") report.browserErrors.push(message.text());
    if (message.type() === "warning") report.warnings.push(message.text());
  });
  page.on("response", response => {
    if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() });
  });
  page.on("requestfailed", request =>
    report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.goto(new URL("src/blood/blood.css", base).href);
  const result = await page.evaluate(async () =>
    (await import("/src/blood/liver/renderBench.ts")).liverRendererBench());
  for (const capture of result.captures ?? []) {
    if (!/^[a-z0-9-]+$/.test(capture.name) || !capture.dataUrl.startsWith("data:image/png;base64,"))
      throw new Error("Invalid renderer capture");
    const bytes = Buffer.from(capture.dataUrl.split(",")[1], "base64"), filename = `${capture.name}.png`;
    await fs.writeFile(path.join(out, filename), bytes, { flag: "wx" });
    report.images.push({ filename, bytes: bytes.length, sha256: hash(bytes) });
  }
  delete result.captures; report.result = result;
  report.sourceHashesAfter = await sourceHashes();
  if (JSON.stringify(report.sourceHashesAfter) !== JSON.stringify(report.sourceHashes))
    throw new Error("Renderer source changed during verification.");
  if (result.status !== "PASS" || report.browserErrors.length || report.failedRequests.length)
    throw new Error(`Renderer gate failed: ${JSON.stringify(result.checks?.filter(check => !check.passed))}`);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  try { await browser?.close(); }
  catch (error) { report.status = "FAIL"; report.cleanupError = String(error); process.exitCode = 1; }
  report.durationSeconds = (performance.now() - started) / 1000;
  report.finishedAt = new Date().toISOString();
  await receipt.writeFile(`${JSON.stringify(report, null, 2)}\n`); await receipt.close();
  console.log(JSON.stringify({ status: report.status, checks: report.result?.checks?.length ?? 0,
    failed: report.result?.checks?.filter(check => !check.passed), errors: report.browserErrors,
    receipt: path.join(out, "renderer.json") }, null, 2));
}
