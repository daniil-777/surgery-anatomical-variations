/** Render exact stored cohort recipes with the Studio's actual WebGL viewport.
 * Requires an Atlas API and Vite server; never treats screenshots as clinical QA.
 * Usage: node scripts/reports/render_atlas_witness.mjs --manifest PATH --out DIR
 *        --base-url http://127.0.0.1:5174 --expected-count 1536
 */
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const flags = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  if (!key?.startsWith("--") || !value) throw new Error("Arguments require --name value pairs");
  if (!["--manifest", "--out", "--base-url", "--expected-count", "--limit"].includes(key)) throw new Error(`Unknown argument ${key}`);
  flags.set(key, value);
}
if (!flags.has("--manifest") || !flags.has("--out")) throw new Error("--manifest and --out are required");
const manifestPath = path.resolve(flags.get("--manifest"));
const outputPath = path.resolve(flags.get("--out"));
const baseUrl = flags.get("--base-url") ?? "http://127.0.0.1:5174";
const manifestBytes = await fs.readFile(manifestPath);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const manifestHash = hash(manifestBytes);
const cohort = manifestBytes.toString("utf8").trim().split("\n").map((line) => JSON.parse(line));
if (flags.has("--expected-count") && cohort.length !== Number(flags.get("--expected-count"))) throw new Error("Cohort size differs from --expected-count");
const ids = new Set();
for (const sample of cohort) {
  if (!/^[a-z0-9_-]+$/i.test(sample.sample_id) || ids.has(sample.sample_id)) throw new Error("Unsafe or duplicate sample identity");
  if (!sample.spec || !/^[a-f0-9]{64}$/.test(sample.geometry_sha256)) throw new Error(`Missing exact recipe/geometry hash for ${sample.sample_id}`);
  ids.add(sample.sample_id);
}
const limit = Number(flags.get("--limit") ?? cohort.length);
if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
const work = cohort.slice(0, limit);
await fs.mkdir(path.join(outputPath, "images"), { recursive: true });
const successPath = path.join(outputPath, "witness.jsonl");
const failedPath = path.join(outputPath, "failures.jsonl");
const successful = new Map();
try {
  for (const line of (await fs.readFile(successPath, "utf8")).trim().split("\n")) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.source_manifest_sha256 !== manifestHash) throw new Error("Existing witness belongs to another cohort manifest");
    const bytes = await fs.readFile(path.join(outputPath, record.image));
    if (hash(bytes) !== record.image_sha256) throw new Error(`Witness image was modified: ${record.sample_id}`);
    successful.set(record.sample_id, record);
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }

const browser = await chromium.launch({ headless: true, args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] });
let page;
let rendererVersion;
const exceptions = [];
const failures = [];
const started = Date.now();
let newlyRendered = 0;
async function openHarness() {
  await page?.close();
  page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => exceptions.push(error.message));
  page.setDefaultTimeout(90000);
  await page.goto(`${baseUrl}/atlas-witness.html`);
  await page.waitForFunction(() => Boolean(window.atlasWitness));
  const version = await page.evaluate(() => window.atlasWitness.version);
  if (rendererVersion && version !== rendererVersion) throw new Error("Renderer changed during the visual audit");
  rendererVersion = version;
  if ([...successful.values()].some((record) => record.renderer_version !== version)) throw new Error("Resume directory contains a different renderer version");
}
async function writeSummary(complete = false) {
  const completed = cohort.filter((sample) => successful.has(sample.sample_id)).length;
  const summary = {
    status: complete && completed === cohort.length && !failures.length && !exceptions.length ? "PASS" : "INCOMPLETE",
    source_manifest: manifestPath, source_manifest_sha256: manifestHash,
    renderer_version: rendererVersion, total_objects: cohort.length, requested_objects: work.length,
    completed_objects: completed, rendered_views: completed * 3, newly_rendered: newlyRendered,
    elapsed_seconds: (Date.now() - started) / 1000,
    failures, browser_exceptions: exceptions,
    evidence_scope: "Exact geometry identity, 3-view raster coverage, nonempty pixels and framing; not an anatomical or mechanical certification",
    poses: ["oblique", "back", "top"], image_size: [768, 256],
  };
  await fs.writeFile(path.join(outputPath, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
try {
  await openHarness();
  for (const [index, sample] of work.entries()) {
    if (successful.has(sample.sample_id)) continue;
    if (newlyRendered && newlyRendered % 32 === 0) await openHarness();
    const sampleStarted = Date.now();
    try {
      const witness = await page.evaluate(({ spec, expected }) => window.atlasWitness.render(spec, expected), { spec: sample.spec, expected: sample.geometry_sha256 });
      const { png, ...metadata } = witness;
      if (witness.geometry_sha256 !== sample.geometry_sha256 || witness.renderer_version !== rendererVersion) throw new Error("Returned witness identity is inconsistent");
      const bytes = Buffer.from(png.slice(png.indexOf(",") + 1), "base64");
      if (bytes.length < 200 || bytes.readUInt32BE(0) !== 0x89504e47) throw new Error("Witness did not return a PNG image");
      const image = `images/${sample.sample_id}.png`;
      await fs.writeFile(path.join(outputPath, image), bytes);
      const record = {
        sample_id: sample.sample_id, template_id: sample.template_id, organ: sample.organ,
        split: sample.split, source_manifest_sha256: manifestHash,
        ...metadata, image, image_sha256: hash(bytes), elapsed_ms: Date.now() - sampleStarted,
      };
      await fs.appendFile(successPath, `${JSON.stringify(record)}\n`);
      successful.set(sample.sample_id, record); newlyRendered++;
    } catch (error) {
      const record = { sample_id: sample.sample_id, template_id: sample.template_id, error: error.message };
      failures.push(record); await fs.appendFile(failedPath, `${JSON.stringify(record)}\n`);
      console.error(JSON.stringify({ failed: record }));
      await openHarness();
    }
    if ((index + 1) % 16 === 0 || index === work.length - 1) {
      const summary = await writeSummary();
      console.log(JSON.stringify({ progress: index + 1, requested: work.length, completed: summary.completed_objects, failed: failures.length, elapsed_seconds: summary.elapsed_seconds }));
    }
  }
  const finalSummary = await writeSummary(true);
  console.log(JSON.stringify(finalSummary));
  if (failures.length || exceptions.length) process.exitCode = 1;
} finally { await browser.close(); }
