#!/usr/bin/env node
// Visual review of learned tissue studies in the actual Tissue Lab: stills per study and view,
// a native 3840x2160 frame, and (optionally) a live native-4K clip through the product's recorder.
// Evidence only: nothing here scores realism. Usage:
//   TISSUE_REVIEW_URL=http://127.0.0.1:5193/tissues.html TISSUE_REVIEW_OUTPUT=/path/new \
//   TISSUE_LEARNED_IDS=learned-pilot-liver-s1,... TISSUE_REVIEW_VIDEO=1 node scripts/tissue_learned_review.mjs
import { chromium } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.TISSUE_REVIEW_URL ?? "http://127.0.0.1:5176/?mode=tissues";
const output = path.resolve(process.env.TISSUE_REVIEW_OUTPUT ?? "artifacts/tissue-learned-review");
const wantVideo = process.env.TISSUE_REVIEW_VIDEO === "1";
const width = 3840, height = 2160;
const report = { schema: "viscera.tissue-learned-review/v1", url: baseUrl, created: new Date().toISOString(), errors: [], studies: [],
  meaning: ["Stills and clips from the real Tissue Lab renderer with the learned study selected.",
    "Learned maps are illumination-flattened observed RGB with derived relief; not measured optics, not patient anatomy.",
    "Image statistics describe exposure and coverage, not realism; visual inspection and clinician review remain separate."] };
await mkdir(output, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const host = page => page.locator(".tissue-viewport[data-tissue-ready='true']");
const state = async page => JSON.parse(await host(page).getAttribute("data-tissue-snapshot"));
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function ready(page, organ, resolution) {
  await page.waitForFunction(({ organ, resolution }) => {
    const element = document.querySelector(".tissue-viewport[data-tissue-ready='true']");
    if (!element || typeof element.captureTissueFrame !== "function" || document.querySelector(".tissue-loading")) return false;
    const snapshot = JSON.parse(element.dataset.tissueSnapshot);
    return snapshot.organ === organ && snapshot.resolution[0] === resolution;
  }, { organ, resolution }, { timeout: 90000 });
  if (await page.getByRole("alert").count()) throw new Error(await page.getByRole("alert").innerText());
  await settled(page);
}
function summary(rgb) {
  let sum = 0, squares = 0, dark = 0, clipped = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const luma = .2126 * rgb[i] + .7152 * rgb[i + 1] + .0722 * rgb[i + 2];
    sum += luma; squares += luma * luma;
    if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) < 8) dark++;
    if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) >= 250) clipped++;
  }
  const count = rgb.length / 3, mean = sum / count;
  return { meanLumaByte: mean, lumaStdByte: Math.sqrt(Math.max(0, squares / count - mean * mean)), darkFraction: dark / count, nearClippedFraction: clipped / count };
}
async function render(page, w, h, time = 0) {
  return host(page).evaluate(async (element, args) => {
    const png = element.captureTissueFrame(args.w, args.h, args.time);
    const image = new Image(); image.src = png; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const drawing = canvas.getContext("2d", { willReadFrequently: true }); drawing.drawImage(image, 0, 0, 160, 90);
    const rgba = drawing.getImageData(0, 0, 160, 90).data, rgb = [];
    for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
    return { png: png.slice(png.indexOf(",") + 1), width: image.width, height: image.height, rgb };
  }, { w, h, time });
}
async function capture(page, name, w = 1280, h = 720) {
  const sample = await render(page, w, h), bytes = Buffer.from(sample.png, "base64");
  await writeFile(path.join(output, name + ".png"), bytes);
  if (sample.width !== w || sample.height !== h) throw new Error("Capture is not " + w + "x" + h + ": " + name);
  const stats = summary(sample.rgb);
  if (stats.darkFraction > .95) throw new Error("Near-black capture: " + name);
  return { file: name + ".png", width: w, height: h, sha256: hash(bytes), ...stats };
}
async function viewReady(page, view, organ, resolution) {
  await page.getByLabel("View", { exact: true }).selectOption(view);
  const geometry = view === "organ" ? "source-atlas-exterior-v1" : view === "walkthrough" ? "curved-lumen-phantom-v3" : "80-mm-surface-coupon";
  await page.waitForFunction(geometry => {
    const element = document.querySelector(".tissue-viewport[data-tissue-ready='true']");
    return element && JSON.parse(element.dataset.tissueSnapshot ?? "{}").geometry === geometry;
  }, geometry, { timeout: 90000 });
  await ready(page, organ, resolution);
}
async function recordClip(page, name) {
  const live = await host(page).evaluate(async (element, seconds) => {
    if (typeof element.recordTissueVideo !== "function") throw new Error("Native 4K recording hook is unavailable");
    const result = await element.recordTissueVideo(seconds);
    const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("blob read failed")); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(result.blob); });
    return { data, metrics: result.metrics };
  }, 3);
  const file = name + (live.metrics.mimeType.startsWith("video/mp4") ? ".mp4" : ".webm"), target = path.join(output, file);
  await writeFile(target, Buffer.from(live.data, "base64"));
  const probeRun = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate:format=duration", "-of", "json", target], { encoding: "utf8", env: { ...process.env, PATH: "/opt/homebrew/bin:" + process.env.PATH } });
  const probe = probeRun.status === 0 ? JSON.parse(probeRun.stdout) : { error: probeRun.stderr };
  if (probe.streams && (probe.streams[0]?.width !== width || probe.streams[0]?.height !== height)) throw new Error("Clip is not native 3840x2160");
  if (probeRun.status === 0) spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", target, "-vf", "fps=3,scale=480:270,tile=3x3", "-frames:v", "1", path.join(output, name + "-contact.png")], { env: { ...process.env, PATH: "/opt/homebrew/bin:" + process.env.PATH } });
  return { file, metrics: live.metrics, probe, encodedFramesPerWallSecond: probe.streams ? Number(probe.streams[0].nb_read_frames) / live.metrics.durationSeconds : null,
    meaning: "Live product recorder; encoded cadence is measured and separate from the uncaptured render rate; no sustained-FPS claim." };
}

const browser = await chromium.launch(process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"] } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.location().url.endsWith("/api.json")) report.errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400 && !new URL(response.url()).pathname.endsWith("/api.json")) report.errors.push(response.status() + " " + response.url()); });
  await page.goto(baseUrl, { waitUntil: "load" });
  await ready(page, "liver", 512);
  const catalog = await (await page.request.get(new URL("tissue-materials/catalog.json", baseUrl).toString())).json();
  report.catalog = catalog.materials.map(entry => entry.id);
  const ids = process.env.TISSUE_LEARNED_IDS ? process.env.TISSUE_LEARNED_IDS.split(",") : catalog.materials.filter(entry => entry.id.startsWith("learned-")).map(entry => entry.id);
  if (!ids.length) throw new Error("No learned studies in the served catalog");
  for (const id of ids) {
    const entry = catalog.materials.find(item => item.id === id);
    if (!entry) throw new Error("Learned study missing from catalog: " + id);
    const manifest = await (await page.request.get(new URL("tissue-materials/" + entry.preview, baseUrl).toString())).json();
    const organ = manifest.recipe.organ, resolution = manifest.resolution[0];
    const study = { id, label: entry.label, organ, resolution, luminal: entry.luminal, generator: manifest.generator, nativeResolution: manifest.provenance?.native_resolution ?? null, seed: manifest.recipe.seed, captures: {} };
    await page.getByLabel("Tissue region", { exact: true }).selectOption(id);
    await viewReady(page, "surface", organ, resolution);
    await page.getByLabel("Lighting", { exact: true }).selectOption("camera");
    for (const view of ["lit", "albedo", "normal", "roughness"]) {
      await page.getByLabel("Surface study", { exact: true }).selectOption(view); await settled(page);
      study.captures["surface-" + view] = await capture(page, id + "-surface-" + view);
    }
    await page.getByLabel("Surface study", { exact: true }).selectOption("lit");
    await page.getByLabel("Lighting", { exact: true }).selectOption("grazing"); await settled(page);
    study.captures["surface-grazing"] = await capture(page, id + "-surface-grazing");
    await page.getByLabel("Lighting", { exact: true }).selectOption("camera"); await settled(page);
    study.captures["surface-native4k"] = await capture(page, id + "-surface-3840x2160", width, height);
    await page.screenshot({ path: path.join(output, id + "-ui.png") });
    const organOption = page.getByLabel("View", { exact: true }).locator('option[value="organ"]');
    if (!(await organOption.evaluate(option => option.disabled))) {
      await viewReady(page, "organ", organ, resolution);
      study.captures["organ-lit"] = await capture(page, id + "-organ-lit");
      study.captures["organ-native4k"] = await capture(page, id + "-organ-3840x2160", width, height);
      if (wantVideo) study.video = await recordClip(page, id + "-organ-live-3840x2160");
    }
    if (entry.luminal) {
      await viewReady(page, "walkthrough", organ, resolution);
      study.captures["lumen-lit"] = await capture(page, id + "-lumen-lit");
      study.captures["lumen-native4k"] = await capture(page, id + "-lumen-3840x2160", width, height);
      if (wantVideo) study.video = await recordClip(page, id + "-lumen-live-3840x2160");
    }
    await viewReady(page, "surface", organ, resolution);
    report.studies.push(study);
    console.log(JSON.stringify({ study: id, captures: Object.keys(study.captures).length, video: study.video?.file ?? null }));
  }
  if (report.errors.length) throw new Error("Browser errors: " + report.errors.join(" | "));
} finally {
  await browser.close();
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ output, studies: report.studies.length, errors: report.errors.length }));
