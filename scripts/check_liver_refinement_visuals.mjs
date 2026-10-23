#!/usr/bin/env node
// Run alone on native Chrome/Metal after source freeze. No server is started
// or stopped. Existing evidence is never overwritten.
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { capturePublicBuildSources } from "./stage_public_assets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root,
  "artifacts/liver-bleeding-2026-10-20",
  `refinement-visuals-${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
const width = Number(process.env.LIVER_COMPARISON_WIDTH ?? 1920);
const height = Number(process.env.LIVER_COMPARISON_HEIGHT ?? 1080);
const timesSeconds = (process.env.LIVER_COMPARISON_TIMES ?? "0.5,1,2").split(",").map(Number);
const budgetMs = Number(process.env.BLOOD_BUDGET_MS ?? 480000);
if (!Number.isFinite(budgetMs) || budgetMs < 1000 || budgetMs > 900000)
  throw new RangeError("BLOOD_BUDGET_MS must be within 1000–900000.");
await fs.mkdir(out, { recursive: true });
const receiptPath = path.join(out, "visual-comparison.json");
const receipt = await fs.open(receiptPath, "wx"), started = performance.now();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
// Use the same complete authored-source/config/lock inventory as the motion
// and production gates. A new imported module (for example runoffContact.ts)
// must not silently fall outside verification because a manual list is stale.
const sourceHashes = async () => {
  const inventory = capturePublicBuildSources(root);
  const entries = inventory.map(file => [file.path, file.sha256]);
  entries.push([path.relative(root, import.meta.filename), hash(await fs.readFile(import.meta.filename))]);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
};
const report = {
  schema: "viscera.liver-refinement-visual-comparison/v1", status: "RUNNING", baseURL: base.href,
  startedAt: new Date().toISOString(), requested: { width, height, timesSeconds, budgetMs },
  browserErrors: [], warnings: [], failedRequests: [], images: [], states: [],
  nativeGPU: true, modelAndRealismCertified: false,
};
let browser, budgetTimer;
try {
  if (process.platform !== "darwin") throw new Error("This comparison requires native macOS Chrome/Metal.");
  report.sourceHashes = await sourceHashes();
  browser = await chromium.launch({ headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--use-gl=angle", "--use-angle=metal"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  page.on("pageerror", error => report.browserErrors.push(String(error)));
  page.on("console", message => {
    const text = message.text();
    if (message.type() === "error") report.browserErrors.push(text);
    if (message.type() === "warning") report.warnings.push(text);
    if (text.startsWith("[liver-comparison]")) console.log(text);
  });
  page.on("response", response => {
    if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() });
  });
  page.on("requestfailed", request =>
    report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.goto(new URL("src/blood/blood.css", base).href);
  const result = await Promise.race([
    page.evaluate(async options =>
      (await import("/src/blood/liver/refinementVisualBench.ts")).liverRefinementVisualBench(options),
    { width, height, timesSeconds }),
    new Promise((_, reject) => {
      budgetTimer = setTimeout(() => reject(new Error(`Comparison exceeded ${budgetMs}ms execution budget`)), budgetMs);
    }),
  ]);
  clearTimeout(budgetTimer); budgetTimer = undefined;
  for (const capture of result.captures ?? []) {
    if (!/^[a-z0-9-]+$/.test(capture.name) || !capture.dataUrl.startsWith("data:image/png;base64,"))
      throw new Error("Invalid comparison capture");
    const bytes = Buffer.from(capture.dataUrl.split(",")[1], "base64"), filename = `${capture.name}.png`;
    await fs.writeFile(path.join(out, filename), bytes, { flag: "wx" });
    report.images.push({ filename, bytes: bytes.length, sha256: hash(bytes), ...capture.metadata });
  }
  for (const state of result.states ?? []) {
    if (![0, 1].includes(state.level) || !/^[a-z0-9-]+$/.test(state.label))
      throw new Error("Invalid accepted comparison state");
    const filename = `level-${state.level}-${state.label}-state.json`;
    const bytes = Buffer.from(`${JSON.stringify(state)}\n`);
    await fs.writeFile(path.join(out, filename), bytes, { flag: "wx" });
    report.states.push({ filename, bytes: bytes.length, sha256: hash(bytes),
      level: state.level, requestedTimeSeconds: state.requestedTimeSeconds,
      acceptedTimeSeconds: state.acceptedTimeSeconds, rejection: state.rejection,
      diagnostics: state.diagnostics });
  }
  delete result.captures; delete result.states; report.result = result;
  report.sourceHashesAfter = await sourceHashes();
  if (JSON.stringify(report.sourceHashesAfter) !== JSON.stringify(report.sourceHashes))
    throw new Error("Source changed during the comparison; results cannot establish a frozen-source comparison.");
  if (result.status !== "PASS" || report.browserErrors.length || report.failedRequests.length)
    throw new Error(`Comparison failed: ${JSON.stringify(result.checks?.filter(check => !check.passed))}`);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error); process.exitCode = 1;
} finally {
  clearTimeout(budgetTimer);
  try { await browser?.close(); }
  catch (error) { report.status = "FAIL"; report.cleanupError = String(error); process.exitCode = 1; }
  report.durationSeconds = (performance.now() - started) / 1000;
  report.finishedAt = new Date().toISOString();
  await receipt.writeFile(`${JSON.stringify(report, null, 2)}\n`); await receipt.close();
  console.log(JSON.stringify({ status: report.status, checks: report.result?.checks?.length ?? 0,
    failed: report.result?.checks?.filter(check => !check.passed), images: report.images.length,
    states: report.states.length, errors: report.browserErrors, receipt: receiptPath }, null, 2));
}
