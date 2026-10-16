/** Full-resolution report images of actual cohort specimens, one per template. */
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
if (!args.get("--witness-dir")) throw new Error("--witness-dir is required");
const root = path.resolve(args.get("--witness-dir"));
const baseUrl = args.get("--base-url") ?? "http://127.0.0.1:5174";
const witnesses = (await fs.readFile(path.join(root, "witness.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
const coverage = JSON.parse(await fs.readFile(path.join(root, "summary.json"), "utf8"));
if (coverage.status !== "PASS" || coverage.completed_objects !== witnesses.length ||
    coverage.total_objects !== witnesses.length || new Set(witnesses.map((record) => record.sample_id)).size !== witnesses.length ||
    witnesses.some((record) => record.source_manifest_sha256 !== coverage.source_manifest_sha256 || record.renderer_version !== coverage.renderer_version))
  throw new Error("Hero capture requires a complete, uniquely identified witness cohort from one renderer and manifest");
const selected = new Map();
for (const record of witnesses) if (!selected.has(record.template_id)) selected.set(record.template_id, record);
await fs.mkdir(path.join(root, "heroes"), { recursive: true });
const browser = await chromium.launch({ headless: true, args: process.platform === "darwin" ? ["--use-gl=angle", "--use-angle=metal"] : [] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
page.setDefaultTimeout(90000);
const errors = []; page.on("pageerror", (error) => errors.push(error.message));
const heroes = [];
try {
  await page.goto(`${baseUrl}/atlas-witness.html`);
  await page.waitForFunction(() => Boolean(window.atlasWitness?.captureHero));
  for (const record of selected.values()) {
    const result = await page.evaluate(async (record) => {
      const replay = await window.atlasWitness.render(record.spec, record.geometry_sha256);
      const hero = await window.atlasWitness.captureHero("oblique", 1600, 1200);
      return { hero, replay: { geometry_sha256: replay.scene_payload_geometry_sha256, normal_sha256: replay.scene_payload_normal_sha256, color_sha256: replay.scene_payload_srgb_color_sha256, renderer_version: replay.renderer_version } };
    }, record);
    if (result.replay.renderer_version !== record.renderer_version || result.replay.geometry_sha256 !== record.geometry_sha256 || result.replay.normal_sha256 !== record.scene_payload_normal_sha256 || result.replay.color_sha256 !== record.scene_payload_srgb_color_sha256)
      throw new Error(`Source geometry or appearance changed before hero capture: ${record.sample_id}`);
    if (result.hero.view.width !== 1600 || result.hero.view.height !== 1200) throw new Error("Hero framebuffer resolution is incorrect");
    const image = `heroes/${record.template_id}.png`;
    const bytes = Buffer.from(result.hero.png.split(",")[1], "base64");
    await fs.writeFile(path.join(root, image), bytes);
    heroes.push({ sample_id: record.sample_id, template_id: record.template_id, organ: record.organ, source_manifest_sha256: record.source_manifest_sha256, spec: record.spec,
      source: record.source, display_normals: record.display_normals, appearance: record.appearance, ...result.replay,
      image, image_sha256: crypto.createHash("sha256").update(bytes).digest("hex"), view: result.hero.view });
    console.log(JSON.stringify({ hero: record.template_id, sample_id: record.sample_id, size: [1600, 1200] }));
  }
  await fs.writeFile(path.join(root, "heroes.json"), `${JSON.stringify({ status: errors.length ? "FAIL" : "PASS", selection: "first completed cohort manifest specimen per template; actual stored nonzero-control variants", count: heroes.length, browser_exceptions: errors, heroes }, null, 2)}\n`);
  if (errors.length) throw new Error(`Browser exceptions: ${errors.join("; ")}`);
} finally { await browser.close(); }
