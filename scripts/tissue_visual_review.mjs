/** Deterministic 4K capture plus independent interactive timing; no realism/clinical claim.
 * Run from viscera/: node scripts/tissue_visual_review.mjs
 * TISSUE_REVIEW_URL, TISSUE_REVIEW_OUTPUT, TISSUE_REVIEW_PHASE=all|still|video|preview|codecs are optional.
 * TISSUE_REVIEW_MODEL imports a local experimental model for a separate diagnostic run (256² RGB;
 * spatial v3 resamples its learned native128 grid, without learning additional output detail).
 * A served public-source.json is checked when present. TISSUE_REVIEW_STATIC_COPY=1
 * requires it; TISSUE_REVIEW_SOURCE_MANIFEST may name another receipt URL.
 */
import { chromium } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { capturePublicBuildSources } from "./stage_public_assets.mjs";

const requestedUrl = new URL(process.env.TISSUE_REVIEW_URL ?? "http://127.0.0.1:5176/");
if (!["http:", "https:"].includes(requestedUrl.protocol)) throw new Error("Review URL must use HTTP(S)");
const entryUrl = new URL(requestedUrl), baseUrl = new URL(requestedUrl);
if (/\.html$/i.test(requestedUrl.pathname)) {
  baseUrl.pathname = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf("/") + 1);
} else {
  baseUrl.pathname = baseUrl.pathname.replace(/\/?$/, "/");
  entryUrl.pathname = baseUrl.pathname;
  entryUrl.searchParams.set("mode", "tissues");
}
baseUrl.search = ""; baseUrl.hash = "";
const base = baseUrl.href;
const output = path.resolve(process.env.TISSUE_REVIEW_OUTPUT ?? "artifacts/tissue-quality-2026-10-19-v3/final");
const phase = process.env.TISSUE_REVIEW_PHASE ?? "all";
if (!["all", "still", "video", "preview", "codecs"].includes(phase)) throw new Error("Invalid TISSUE_REVIEW_PHASE");
const width = 3840, height = 2160, fps = 24, frameCount = 72;
const atlasOrgans = ["liver", "kidney", "heart", "lung", "spleen", "stomach", "small_bowel", "large_bowel", "pancreas", "gallbladder", "bladder", "mesentery"];
const liveDurationSeconds = ["preview", "codecs"].includes(phase) ? 3 : 5;
const mapResolution = ["preview", "codecs"].includes(phase) ? 512 : 4096;
const previousEvidence = await readdir(output).catch(error => { if (error.code === "ENOENT") return []; throw error; });
if (previousEvidence.length) throw new Error("Review output already contains evidence. Choose a new TISSUE_REVIEW_OUTPUT; failed and accepted iterations must be preserved: " + output);
await mkdir(output, { recursive: true });
const report = {
  schema: "viscera.tissue-visual-review/v3", startedAt: new Date().toISOString(), phase, base, entryUrl: entryUrl.href,
  system: { platform: process.platform, arch: process.arch, os: os.release(), cpu: os.cpus()[0]?.model, node: process.version },
  evidenceLevel: "authored-material engineering and visual diagnostics; no clinical or photorealism qualification",
  limitations: ["Curved lumen phantom; not a connected patient anatomy.", "Atlas views inspect selected exterior structures in assumed atlas millimetres; they do not infer internal cavities or surgical connections.", "Constant cavity fill and film roughness are authored approximations, not measured scattering or tissue optics.", "Offline playback FPS is independent of interactive rendering performance.", "Unregistered frame differences include expected camera/light motion; they are not a calibrated flicker score.", "No deforming anatomy is demonstrated by the fixed-UV lumen test.", "Learned source RGB, if separately selected, is appearance data rather than measured intrinsic albedo; its source resolution must be reported separately from output resolution."],
  cases: [], optionalConfigProbes: [], errors: [], videos: [], materialManifests: {},
};
let browser, context, server, reviewAppearance;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-16000); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(program + " exited " + code + ": " + stderr)));
  });
}
async function serverReady() {
  try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
async function ensureServer() {
  if (await serverReady()) return;
  const address = new URL(base);
  if (!["127.0.0.1", "localhost"].includes(address.hostname) || address.port !== "5176") throw new Error("Start review server first: " + base);
  server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "apps/studio/vite.config.ts", "--host", "127.0.0.1", "--port", "5176", "--strictPort"], { stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  server.stdout.on("data", data => { logs = (logs + data).slice(-4000); });
  server.stderr.on("data", data => { logs = (logs + data).slice(-4000); });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await serverReady()) return;
    if (server.exitCode !== null) throw new Error("Vite failed: " + logs);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Vite startup timed out: " + logs);
}
async function verifyServedSources() {
  const explicit = process.env.TISSUE_REVIEW_SOURCE_MANIFEST;
  const required = Boolean(explicit) || process.env.TISSUE_REVIEW_STATIC_COPY === "1";
  const url = new URL(explicit ?? "public-source.json", baseUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (response.status === 404 && !required) {
    report.servedBuildSource = { url: url.href, status: "not-provided", verified: false };
    return;
  }
  if (!response.ok) throw new Error("Build source receipt unavailable: " + response.status + " " + url.href);
  const bytes = Buffer.from(await response.arrayBuffer());
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch {
    // Vite's development fallback can return index.html for an absent JSON path.
    if (!required && response.headers.get("content-type")?.includes("text/html")) {
      report.servedBuildSource = { url: url.href, status: "development-html-fallback", verified: false }; return;
    }
    throw new Error("Build source receipt is not JSON: " + url.href);
  }
  if (manifest.schema !== "viscera.public-build-source/v1" || !Array.isArray(manifest.files)) throw new Error("Unsupported build source receipt");
  const built = new Map();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || built.has(item.path)) throw new Error("Invalid or duplicate build source entry");
    built.set(item.path, item.sha256);
  }
  const current = capturePublicBuildSources(path.resolve(".")).filter(item => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(item.path));
  const mismatches = current.filter(item => built.get(item.path) !== item.sha256).map(item => item.path);
  report.servedBuildSource = { url: url.href, sha256: hash(bytes), schema: manifest.schema, checkedRuntimeFiles: current.length, mismatches, verified: mismatches.length === 0 };
  if (mismatches.length) throw new Error("Served build differs from current runtime sources: " + mismatches.join(", "));
  report.servedRuntimeSources = current;
}
function monitor(page) {
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !message.location().url.endsWith("/api.json")) report.errors.push(message.text());
  });
  page.on("response", response => {
    if (response.status() < 400) return;
    const detail = response.status() + " " + response.url();
    if (response.status() === 404 && new URL(response.url()).pathname.endsWith("/api.json")) report.optionalConfigProbes.push(detail);
    else report.errors.push(detail);
  });
}
const host = page => page.locator(".tissue-viewport[data-tissue-ready='true']");
const state = async page => JSON.parse(await host(page).getAttribute("data-tissue-snapshot"));
async function settled(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function ready(page, organ = "liver", resolution = 512) {
  await page.waitForFunction(({ organ, resolution, appearance }) => {
    const element = document.querySelector(".tissue-viewport[data-tissue-ready='true']");
    if (!element || typeof element.captureTissueFrame !== "function" || document.querySelector(".tissue-loading")) return false;
    const snapshot = JSON.parse(element.dataset.tissueSnapshot);
    const expectedLearned = appearance?.regions.includes(organ);
    const appearanceReady = !appearance || (expectedLearned ? snapshot.appearance?.modelId === appearance.modelId && snapshot.appearance?.resolution === appearance.resolution && snapshot.appearance?.region === organ && snapshot.appearance?.seed === "42" : snapshot.appearance === null);
    return snapshot.organ === organ && snapshot.resolution[0] === resolution && snapshot.resolution[1] === resolution && appearanceReady;
  }, { organ, resolution, appearance: reviewAppearance }, { timeout: 90000 });
  if (await page.getByRole("alert").count()) throw new Error(await page.getByRole("alert").innerText());
  await settled(page);
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
async function inspectDirections(page, organ, resolution) {
  await viewReady(page, "walkthrough", organ, resolution);
  await page.getByRole("button", { name: "Look along the path", exact: true }).click(); await settled(page);
  const dimensions = resolution === 4096 ? [width, height] : [1280, 720];
  const forward = await capture(page, organ + "-direction-forward", ...dimensions);
  const observations = [];
  for (const [name, yaw, pitch] of [["reverse", 180, 0], ["right", 90, 0], ["left", -90, 0], ["up", 0, 90], ["down", 0, -90]]) {
    await page.getByLabel("Camera yaw", { exact: true }).fill(String(yaw)); await page.getByLabel("Camera pitch", { exact: true }).fill(String(pitch)); await settled(page);
    const sample = await capture(page, organ + "-direction-" + name, ...dimensions);
    const delta = difference(forward.rgb, sample.rgb), appearance = imageSummary(sample.rgb), snapshot = await state(page);
    if (snapshot.cameraYawDeg !== yaw || snapshot.cameraPitchDeg !== pitch) throw new Error("Inspection controls did not reach requested direction");
    if (delta.meanAbsoluteByteDifference <= .25 || appearance.darkFraction >= .95) throw new Error(organ + " has an invisible or unchanged " + name + " inspection view");
    observations.push({ name, yawDeg: yaw, pitchDeg: pitch, ...delta, ...appearance });
  }
  await page.getByRole("button", { name: "Look along the path", exact: true }).click(); await settled(page);
  const replay = difference(forward.rgb, (await render(page, ...dimensions, 0)).rgb);
  if (replay.meanAbsoluteByteDifference > .05) throw new Error(organ + " direction reset changed the fixed-time frame");
  report.directionReviews ??= []; report.directionReviews.push({ organ, resolution, observations, resetReplay: replay, meaning: "Six camera orientations from the same clearance-tested phantom position; no new anatomical connectivity is implied." });
}
function imageSummary(rgb) {
  let sum = 0, squares = 0, dark = 0, clipped = 0, below16 = 0, below32 = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const luma = .2126 * rgb[i] + .7152 * rgb[i + 1] + .0722 * rgb[i + 2];
    sum += luma; squares += luma * luma;
    if (luma < 16) below16++;
    if (luma < 32) below32++;
    if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) < 8) dark++;
    if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) >= 250) clipped++;
  }
  const count = rgb.length / 3, mean = sum / count;
  return { meanLumaByte: mean, lumaStdByte: Math.sqrt(Math.max(0, squares / count - mean * mean)), darkFraction: dark / count, darkDefinition: "all RGB channels below 8", lumaBelow16Fraction: below16 / count, lumaBelow32Fraction: below32 / count, nearClippedFraction: clipped / count };
}
function difference(a, b) {
  if (a.length !== b.length) throw new Error("Pixel shape mismatch");
  let absolute = 0, changed = 0;
  for (let i = 0; i < a.length; i++) { const delta = Math.abs(a[i] - b[i]); absolute += delta; if (delta > 2) changed++; }
  return { meanAbsoluteByteDifference: absolute / a.length, changedChannelFraction: changed / a.length };
}
async function render(page, width, height, time) {
  return host(page).evaluate(async (element, args) => {
    const png = element.captureTissueFrame(args.width, args.height, args.time);
    const image = new Image(); image.src = png; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const drawing = canvas.getContext("2d", { willReadFrequently: true }); drawing.drawImage(image, 0, 0, 160, 90);
    const rgba = drawing.getImageData(0, 0, 160, 90).data, rgb = [];
    for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
    return { png: png.slice(png.indexOf(",") + 1), width: image.width, height: image.height, rgb };
  }, { width, height, time });
}
async function capture(page, name, captureWidth = 1280, captureHeight = 720, time = 0) {
  await page.screenshot({ path: path.join(output, name + "-ui.png") });
  const sample = await render(page, captureWidth, captureHeight, time), bytes = Buffer.from(sample.png, "base64");
  await writeFile(path.join(output, name + ".png"), bytes);
  const snapshot = await state(page), selected = await page.getByLabel("Tissue region", { exact: true }).inputValue();
  const entry = report.libraryCatalog.materials.find(material => material.id === selected);
  if (!entry) throw new Error("Selected material missing from captured catalog: " + selected);
  const manifestPath = "tissue-materials/" + (snapshot.resolution[0] === 4096 ? entry.manifest : entry.preview);
  if (!report.materialManifests[manifestPath]) {
    const response = await page.request.get(new URL(manifestPath, baseUrl).toString());
    if (!response.ok()) throw new Error("Material manifest unavailable during evidence capture: " + manifestPath);
    const bytes = await response.body(), manifest = JSON.parse(bytes.toString());
    report.materialManifests[manifestPath] = { sha256: hash(bytes), generator: manifest.generator, resolution: manifest.resolution, provenance: manifest.provenance };
  }
  report.cases.push({ name, timeSeconds: time, snapshot, manifestPath, width: sample.width, height: sample.height, sha256: hash(bytes), ...imageSummary(sample.rgb) });
  return sample;
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b), mean = values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  return { count: values.length, meanMs: mean, medianMs: sorted[Math.floor(sorted.length * .5)] ?? null, p95Ms: sorted[Math.floor(sorted.length * .95)] ?? null, maxMs: sorted.at(-1) ?? null, averageFps: mean > 0 ? 1000 / mean : 0, intervalsOver33ms: values.filter(value => value > 1000 / 30).length, intervalsOver50ms: values.filter(value => value > 50).length };
}

try {
  report.implementationSha256 = {};
  const tissueFiles = (await readdir("apps/studio/src/tissues")).filter(file => /\.(tsx?|css)$/.test(file)).map(file => "apps/studio/src/tissues/" + file);
  const generatorFiles = (await readdir("py/viscera_core/tissue_materials")).filter(file => file.endsWith(".py")).map(file => "py/viscera_core/tissue_materials/" + file);
  for (const file of [...tissueFiles, ...generatorFiles, "apps/studio/public/tissue-materials/catalog.json", "scripts/tissue_visual_review.mjs", "tests/e2e/tissue-lab.spec.ts", "tests/e2e/tissue-neural.spec.ts", "playwright.tissues.config.ts"]) {
    report.implementationSha256[file] = hash(await readFile(file));
  }
  await ensureServer();
  await verifyServedSources();
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"] } : {}) });
  report.browser = await browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage(); monitor(page);
  const entryResponse = await page.goto(entryUrl.href);
  if (!entryResponse?.ok()) throw new Error("Tissue entry unavailable: " + entryUrl.href);
  report.servedEntrySha256 = hash(await entryResponse.body()); await ready(page);
  report.libraryCatalog = await (await page.request.get(new URL("tissue-materials/catalog.json", baseUrl).toString())).json();
  report.catalog = await page.getByLabel("Tissue region", { exact: true }).locator("option").evaluateAll(options => options.map(option => ({ id: option.value, label: option.label })));
  if (report.catalog.length < 19) throw new Error("Expected at least 19 profiles; found " + report.catalog.length);
  if (process.env.TISSUE_REVIEW_MODEL) {
    const modelPath = path.resolve(process.env.TISSUE_REVIEW_MODEL), bytes = await readFile(modelPath), artifact = JSON.parse(bytes.toString());
    if (!Array.isArray(artifact.architecture?.condition_regions)) throw new Error("Diagnostic model has no condition-region vocabulary");
    const spatial = artifact.schema === "viscera.tissue-appearance-decoder/v3";
    reviewAppearance = { modelId: hash(bytes), regions: artifact.architecture.condition_regions, resolution: 256,
      nativeResolution: spatial ? artifact.architecture.native_resolution : null,
      outputSampling: spatial ? "periodic-bilinear-pixel-centers" : "direct-coordinate-inference" };
    report.implementationSha256[modelPath] = hash(bytes);
    report.appearanceModel = { ...reviewAppearance, artifactSchema: artifact.schema, file: modelPath, seed: "42", conditionLabels: artifact.architecture.condition_labels, conditionSpecies: artifact.architecture.condition_species, provenance: artifact.provenance, meaning: "Experimental observed RGB diagnostic; a 256² bake replaces substrate color only on supported regions. For spatial v3, this explicitly resamples a learned native 128² grid. Other regions retain authored RGB. Larger output textures, 4096² material maps and 3840×2160 video do not add learned source detail or establish recovered albedo." };
    await page.getByLabel("Import Colab tissue model").setInputFiles(modelPath);
    await page.getByRole("button", { name: "Remove imported model", exact: true }).waitFor({ state: "visible", timeout: 60000 });
    await ready(page);
  }
  if (phase !== "video" && phase !== "codecs") {
    for (const organ of ["liver", "pancreas", "gastric_mucosa", "colonic_mucosa"]) {
      await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ); await capture(page, organ);
    }
    await page.getByLabel("Tissue region", { exact: true }).selectOption("liver"); await ready(page);
    const initial = await state(page), initialImage = await capture(page, "liver-baseline");
    for (const study of ["albedo", "normal", "roughness"]) {
      await page.getByLabel("Surface study", { exact: true }).selectOption(study); await settled(page); await capture(page, "study-" + study);
    }
    await page.getByLabel("Surface study", { exact: true }).selectOption("lit");
    for (const [label, key] of [["Vessel coverage", "vessels"], ["Fascia coverage", "fascia"], ["Adipose coverage", "adipose"], ["Wet coat", "wetness"]]) {
      for (const strength of [0, 1]) { await page.getByLabel(label, { exact: true }).fill(String(strength)); await settled(page); await capture(page, key + "-" + strength); }
      await page.getByLabel(label, { exact: true }).fill(String(initial[key]));
    }
    await page.getByLabel("Lighting", { exact: true }).selectOption("grazing"); await settled(page); await capture(page, "grazing-light");
    await page.getByLabel("Lighting", { exact: true }).selectOption("camera"); await settled(page);
    report.surfaceReplay = difference(initialImage.rgb, (await render(page, 1280, 720, 0)).rgb);
    if (phase !== "preview") { await page.getByLabel("Map resolution", { exact: true }).selectOption("4096"); await ready(page, "liver", 4096); await capture(page, "liver-native4k", width, height); }
    if (phase !== "preview") {
      for (const [material, organ] of [["liver_peritoneum", "liver"], ["pancreas_mesentery", "pancreas"]]) {
        await page.getByLabel("Tissue region", { exact: true }).selectOption(material); await ready(page, organ, 4096);
        await capture(page, material + "-native4k", width, height);
      }
      report.atlasReview = [];
      for (const organ of atlasOrgans) {
        await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ, 4096);
        await viewReady(page, "organ", organ, 4096);
        const snapshot = await state(page);
        if (!snapshot.atlas?.nodes?.length || snapshot.temporalBinding !== "object-mm-triplanar" || snapshot.atlas.license !== "CC-BY-4.0") throw new Error("Atlas provenance or projection missing for " + organ);
        const front = await capture(page, organ + "-atlas-front-native4k", width, height, 0);
        const side = await capture(page, organ + "-atlas-side-native4k", width, height, 6);
        const replay = difference(front.rgb, (await render(page, width, height, 24)).rgb), delta = difference(front.rgb, side.rgb);
        if (delta.meanAbsoluteByteDifference <= .25 || replay.meanAbsoluteByteDifference > .05) throw new Error("Atlas orbit variation or closure failed for " + organ);
        report.atlasReview.push({ organ, snapshot, quarterOrbitDifference: delta, fullOrbitReplay: replay });
        await viewReady(page, "surface", organ, 4096);
      }
    }
    for (const mobileWidth of [390, 768]) {
      await page.setViewportSize({ width: mobileWidth, height: 844 }); await settled(page);
      if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))) throw new Error("Horizontal mobile overflow at " + mobileWidth);
      await page.screenshot({ path: path.join(output, "mobile-" + mobileWidth + ".png"), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    if (phase !== "preview") {
      for (const organ of ["gastric_mucosa", "intestinal_mucosa"]) {
        await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ, 4096);
        await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await settled(page);
        await capture(page, organ + "-lumen-native4k", width, height);
        if (organ === "intestinal_mucosa") for (const time of [.5, 1]) await capture(page, organ + "-lumen-time" + time + "-native4k", width, height, time);
        await inspectDirections(page, organ, 4096);
      }
    }
  }
  await page.getByLabel("Tissue region", { exact: true }).selectOption("colonic_mucosa");
  await page.getByLabel("Map resolution", { exact: true }).selectOption(mapResolution === 4096 ? "4096" : "preview"); await ready(page, "colonic_mucosa", mapResolution);
  await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await settled(page);
  const seed42 = await capture(page, "lumen-seed42", phase === "preview" ? 1280 : width, phase === "preview" ? 720 : height);
  await page.getByLabel("Lumen variation seed", { exact: true }).fill("43"); await settled(page);
  const seed43 = await capture(page, "lumen-seed43", phase === "preview" ? 1280 : width, phase === "preview" ? 720 : height);
  report.adjacentSeedDifference = difference(seed42.rgb, seed43.rgb);
  if (report.adjacentSeedDifference.meanAbsoluteByteDifference < .25) throw new Error("Adjacent seeds lack visible variation");
  await page.getByLabel("Lumen variation seed", { exact: true }).fill("42"); await settled(page);
  if (phase !== "codecs") {
    const wetness = (await state(page)).wetness;
    for (const value of [0, 1]) {
      await page.getByLabel("Wet coat", { exact: true }).fill(String(value)); await settled(page);
      await capture(page, "lumen-wetness-" + value);
    }
    await page.getByLabel("Wet coat", { exact: true }).fill(String(wetness)); await settled(page);
  }
  if (phase !== "codecs") {
    const trajectory = (await state(page)).trajectory;
    if (!(trajectory?.periodSeconds > 0)) throw new Error("Missing finite camera trajectory metadata");
    report.trajectoryReview = { trajectory, samples: [], continuity: [], meaning: "Fixed-rest-UV curved-phantom camera tests; these establish continuity and replay, not anatomical correctness." };
    for (const seed of [0, 42, 43, 4294967295]) {
      await page.getByLabel("Lumen variation seed", { exact: true }).fill(String(seed)); await settled(page);
      for (const [index, time] of [0, .25, .5, .75].map(fraction => fraction * trajectory.periodSeconds).entries()) {
        const sample = await render(page, 640, 360, time), appearance = imageSummary(sample.rgb);
        const name = `trajectory-seed${seed}-quarter${index}.png`;
        await writeFile(path.join(output, name), Buffer.from(sample.png, "base64"));
        report.trajectoryReview.samples.push({ seed, time, file: name, ...appearance });
        if (appearance.darkFraction > .95) throw new Error("Camera traversal produced a near-black frame");
      }
      const dt = 1 / 240, boundary = [];
      for (const time of [-2 * dt, -dt, 0, dt, 2 * dt]) boundary.push((await render(page, 640, 360, trajectory.periodSeconds + time)).rgb);
      const steps = boundary.slice(1).map((sample, index) => difference(boundary[index], sample));
      const original = await render(page, 640, 360, 0), wrapped = await render(page, 640, 360, trajectory.periodSeconds);
      const replay = difference(original.rgb, wrapped.rgb);
      report.trajectoryReview.continuity.push({ seed, dt, steps, fullLoopReplay: replay });
      if (replay.meanAbsoluteByteDifference > .05) throw new Error("Full-loop replay changed appearance at seed " + seed);
      if (Math.max(steps[1].meanAbsoluteByteDifference, steps[2].meanAbsoluteByteDifference) > 4 * Math.max(steps[0].meanAbsoluteByteDifference, steps[3].meanAbsoluteByteDifference) + .5) throw new Error("Camera loop join discontinuity at seed " + seed);
    }
    await page.getByLabel("Lumen variation seed", { exact: true }).fill("42"); await settled(page);
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-pattern_type", "glob", "-i", path.join(output, "trajectory-seed*-quarter*.png"), "-vf", "scale=480:270,tile=4x4", "-frames:v", "1", path.join(output, "trajectory-contact-sheet.png")]);
    await inspectDirections(page, "colonic_mucosa", mapResolution);
  }
  // Exercise the product's actual native-4K recording path. Encoder cadence can differ from RAF cadence.
  const codecs = phase === "codecs" ? ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp8", "video/webm;codecs=vp9"] : [undefined];
  for (const [codecIndex, preferredMimeType] of codecs.entries()) {
  await page.getByRole("button", { name: "Reset camera", exact: true }).click(); await settled(page);
  const liveSnapshot = await state(page);
  const live = await host(page).evaluate(async (element, { preferred, seconds }) => {
    if (typeof element.recordTissueVideo !== "function") throw new Error("Native 4K recording hook is unavailable");
    const result = await element.recordTissueVideo(seconds, preferred);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error("Video blob read failed"));
      reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(result.blob);
    });
    return { data, metrics: result.metrics };
  }, { preferred: preferredMimeType, seconds: liveDurationSeconds });
  if (preferredMimeType && live.metrics.mimeType !== preferredMimeType) throw new Error("Recorder did not honor requested codec: " + preferredMimeType + " -> " + live.metrics.mimeType);
  const liveName = "lumen-live-3840x2160" + (phase === "codecs" ? "-codec" + codecIndex : "");
  const livePath = path.join(output, liveName + (live.metrics.mimeType.startsWith("video/mp4") ? ".mp4" : ".webm"));
  await writeFile(livePath, Buffer.from(live.data, "base64"));
  const liveProbe = JSON.parse((await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate:format=duration:frame=best_effort_timestamp_time", "-of", "json", livePath])).stdout);
  if (liveProbe.streams[0]?.width !== width || liveProbe.streams[0]?.height !== height) throw new Error("Live video is not native 3840x2160");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", livePath, "-vf", "fps=1,scale=640:360,tile=3x1", "-frames:v", "1", path.join(output, liveName + "-contact-sheet.png")]);
  const encodedTimes = (liveProbe.frames ?? []).map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
  const encodedSpan = encodedTimes.length > 1 ? encodedTimes.at(-1) - encodedTimes[0] : null;
  if (encodedTimes.length < 10 || !encodedTimes.slice(1).every((time, index) => time > encodedTimes[index])) throw new Error("Invalid or nonmonotonic decoded video timestamps");
  if (encodedSpan < liveDurationSeconds * .7) throw new Error("Video lost more than 30% of requested traversal coverage");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", livePath, "-vf", "scale=160:90", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-pix_fmt", "rgb24", "-f", "rawvideo", path.join(output, liveName + "-decoded.rgb")]);
  const decoded = await readFile(path.join(output, liveName + "-decoded.rgb")), stride = 160 * 90 * 3, decodedSamples = [];
  if (decoded.length % stride) throw new Error("Decoded frame shape mismatch");
  for (let offset = 0; offset < decoded.length; offset += stride) decodedSamples.push(decoded.subarray(offset, offset + stride));
  const decodedMotion = decodedSamples.slice(1).map((sample, index) => difference(decodedSamples[index], sample));
  const decodedUniqueFrames = new Set(decodedSamples.map(hash)).size;
  if (decodedSamples.length !== Number(liveProbe.streams[0].nb_read_frames) || decodedUniqueFrames !== decodedSamples.length) throw new Error("Decoded live frame count or uniqueness failed");
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", livePath, "-vf", "fps=3,scale=480:270,tile=3x5", "-frames:v", "1", path.join(output, liveName + "-dense-contact-sheet.png")]);
  if (decodedMotion.filter(step => step.meanAbsoluteByteDifference > .1).length < decodedMotion.length - 1) throw new Error("Decoded live recording froze despite camera motion");
  report.videos.push({ file: path.basename(livePath), mode: "live MediaRecorder", mapResolution, snapshot: liveSnapshot, learnedRgbResolution: liveSnapshot.appearance?.resolution ?? null, requestedDurationSeconds: liveDurationSeconds, requestedMimeType: preferredMimeType ?? "application default", metrics: live.metrics, probe: liveProbe, observedRenderedFps: live.metrics.renderedFrames / live.metrics.durationSeconds, encodedFramesPerRecordingWallSecond: Number(liveProbe.streams[0]?.nb_read_frames) / live.metrics.durationSeconds, encodedTimestampSpanSeconds: encodedSpan, timestampSpanOverRequestedDuration: encodedSpan === null ? null : encodedSpan / liveDurationSeconds, encodedFramesPerSecondOverTimestampSpan: encodedSpan > 0 ? (encodedTimes.length - 1) / encodedSpan : null, meaning: "Capture requests 30 FPS; actual rendered frames, encoded count and time coverage are independent. Timestamp cadence can look adequate despite dropped startup/tail coverage. No sustained 30-FPS claim. Learned RGB source resolution is independent from native material maps and video dimensions." });
  report.videos.at(-1).decodedDiagnostics = { resolution: [160, 90], sampling: "every encoded frame", decodedFrames: decodedSamples.length, uniqueFrames: decodedUniqueFrames, frameAppearance: decodedSamples.map(imageSummary), rawRgbDifferences: decodedMotion, meaning: "Decoded video visibility and motion evidence; not a photorealism or perceptual flicker score." };
  console.log("Recorded live UHD " + live.metrics.mimeType + ": " + liveProbe.streams[0]?.nb_read_frames + " encoded frames");
  }
  if (phase === "all" || phase === "video") {
    const frames = path.join(output, "frames"); await mkdir(frames, { recursive: true });
    const samples = [], captureTimesMs = [], hashes = [], captureStarted = performance.now();
    for (let index = 0; index < frameCount; index++) {
      const started = performance.now(), sample = await render(page, width, height, index / fps);
      if (sample.width !== width || sample.height !== height) throw new Error("Unexpected frame resolution");
      const bytes = Buffer.from(sample.png, "base64");
      await writeFile(path.join(frames, "frame-" + String(index).padStart(4, "0") + ".png"), bytes);
      samples.push(sample.rgb); hashes.push(hash(bytes)); captureTimesMs.push(performance.now() - started);
      if (index % 12 === 0) console.log("Captured " + (index + 1) + "/" + frameCount + " deterministic 4K frames");
    }
    const captureWallMs = performance.now() - captureStarted, replay = await render(page, width, height, 0);
    const replayHash = hash(Buffer.from(replay.png, "base64"));
    if (hashes[0] !== replayHash) throw new Error("Fixed-time frame replay changed after traversal");
    const encodeStarted = performance.now(), video = path.join(output, "lumen-3840x2160-24fps.mp4");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(fps), "-i", path.join(frames, "frame-%04d.png"), "-frames:v", String(frameCount), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", video]);
    const encodeWallMs = performance.now() - encodeStarted;
    const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_frames,avg_frame_rate,duration", "-of", "json", video])).stdout).streams[0];
    if (probe.width !== width || probe.height !== height || Number(probe.nb_frames) !== frameCount) throw new Error("Encoded video dimensions/frame count mismatch");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", video, "-vf", "select='eq(n,0)+eq(n,24)+eq(n,48)+eq(n,71)',scale=960:540,tile=2x2", "-frames:v", "1", path.join(output, "video-contact-sheet.png")]);
    report.videos.push({ file: path.basename(video), frameDirectory: "frames", snapshot: await state(page), semantics: "fixed-timestep offline capture; playback 24 FPS is not a real-time benchmark", width, height, fps, durationSeconds: 3, frameCount, captureWallMs, encodeWallMs, captureThroughputFramesPerSecond: frameCount * 1000 / captureWallMs, captureTimes: distribution(captureTimesMs), probe, frameHashes: hashes, uniqueFrameHashes: new Set(hashes).size, replayHashMatches: true, frameAppearance: samples.map(imageSummary), temporalRawRgbDifferences: samples.slice(1).map((sample, index) => difference(samples[index], sample)), temporalMetricResolution: [160, 90], temporalInterpretation: "Neighbor-frame differences include expected motion/lighting. Inspect video for artifacts; this is not an optical-flow-compensated flicker or realism metric." });
  }
  // Independent native 4K drawing-buffer performance, not capture/encoding latency.
  await page.setViewportSize({ width, height });
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  const benchmarkStyle = await page.addStyleTag({ content: ".tissue-viewport{position:fixed!important;inset:auto!important;left:0!important;top:0!important;width:3840px!important;height:2160px!important;z-index:999!important}" });
  await page.waitForFunction(() => { const canvas = document.querySelector(".tissue-viewport canvas"); return canvas.width === 3840 && canvas.height === 2160; });
  await page.waitForTimeout(1000);
  const timing = await page.evaluate(() => new Promise(resolve => {
    const frameTimesMs = [], started = performance.now(); let previous;
    function tick(now) {
      if (previous !== undefined) frameTimesMs.push(now - previous); previous = now;
      if (now - started < 3000) requestAnimationFrame(tick);
      else {
        const canvas = document.querySelector(".tissue-viewport canvas"), gl = canvas.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
        resolve({ frameTimesMs, elapsedMs: now - started, width: canvas.width, height: canvas.height, devicePixelRatio, renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "not exposed", vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : "not exposed", heapBytes: performance.memory?.usedJSHeapSize ?? null, appTiming: JSON.parse(document.querySelector(".tissue-viewport").dataset.frameTiming ?? "null") });
      }
    }
    requestAnimationFrame(tick);
  }));
  report.interactive4k = { ...timing, mapResolution, snapshot: await state(page), ...distribution(timing.frameTimesMs), meaning: "Observed RAF intervals with playing=true and 3840x2160 native drawing buffer; mapResolution and learned RGB bake resolution are recorded separately. Includes browser scheduling, not isolated GPU execution. No fixed FPS promise." };
  await page.screenshot({ path: path.join(output, "interactive-4k.png") });
  // Check other lumen profiles and actual atlas exterior orbits after the independent colonic performance sample.
  if (phase === "all" || phase === "video") {
    await benchmarkStyle.evaluate(element => element.remove());
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("button", { name: "Pause camera", exact: true }).click();
    const profileViews = [["gastric_mucosa", "walkthrough"], ["intestinal_mucosa", "walkthrough"], ["liver", "organ"], ["pancreas", "organ"]];
    for (const organ of new Set(reviewAppearance?.regions ?? [])) if (atlasOrgans.includes(organ) && !["liver", "pancreas"].includes(organ)) profileViews.push([organ, "organ"]);
    profileViews.push(["colonic_mucosa", "walkthrough", "material-variation"]);
    for (const [organ, view, variationCase] of profileViews) {
      await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ, 4096);
      await viewReady(page, view, organ, 4096);
      if (view === "walkthrough") await page.getByRole("button", { name: "Reset camera", exact: true }).click(); await settled(page);
      if (variationCase) {
        const before = await state(page), samples = [];
        await page.getByRole("checkbox", { name: "Enable material variation", exact: true }).check();
        for (const [label, value] of [["Colour variation", ".6"], ["Roughness variation", ".55"], ["Pigment warmth", ".15"], ["Pigment depth", ".1"]]) await page.getByLabel(label, { exact: true }).fill(value);
        for (const [index, seed] of ["42", "43", "42"].entries()) {
          await page.getByLabel("Material variation seed", { exact: true }).fill(seed); await page.getByLabel("Material variation seed", { exact: true }).press("Enter"); await settled(page);
          const snapshot = await state(page);
          if (!snapshot.materialVariation?.enabled || snapshot.materialVariation.seed !== seed || snapshot.geometry !== before.geometry || snapshot.seed !== before.seed) throw new Error("Material variation changed geometry or did not reach its requested seed");
          samples.push(await capture(page, "colonic-material-seed" + seed + "-run" + (index + 1), width, height, 0));
        }
        const adjacent = difference(samples[0].rgb, samples[1].rgb), replay = difference(samples[0].rgb, samples[2].rgb);
        if (adjacent.meanAbsoluteByteDifference <= .1 || samples[0].png !== samples[2].png) throw new Error("Material seed variation or exact replay failed");
        report.materialVariationReview = { adjacent, replay, geometryPreserved: true, seedSequence: ["42", "43", "42"], controls: (await state(page)).materialVariation, meaning: "Authored material field variation with fixed geometry and camera; not learned patient distribution or measured optics." };
      }
      const snapshot = await state(page);
      const live = await host(page).evaluate(async element => {
        const result = await element.recordTissueVideo(3);
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onerror = () => reject(new Error("Profile video blob read failed"));
          reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(result.blob);
        });
        return { data, metrics: result.metrics };
      });
      const name = organ + (view === "organ" ? "-atlas" : "") + (variationCase ? "-variation-seed42" : "") + "-live-3840x2160", file = name + (live.metrics.mimeType.startsWith("video/mp4") ? ".mp4" : ".webm");
      const videoPath = path.join(output, file); await writeFile(videoPath, Buffer.from(live.data, "base64"));
      const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate:format=duration:frame=best_effort_timestamp_time", "-of", "json", videoPath])).stdout);
      if (probe.streams[0]?.width !== width || probe.streams[0]?.height !== height) throw new Error(organ + " video is not native UHD");
      const timestamps = (probe.frames ?? []).map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
      const span = timestamps.at(-1) - timestamps[0];
      if (timestamps.length < 10 || !timestamps.slice(1).every((time, index) => time > timestamps[index]) || span < 2.1) throw new Error(organ + " video has invalid timestamps or insufficient time coverage");
      const decodedPath = path.join(output, name + "-decoded.rgb");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "scale=160:90", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-pix_fmt", "rgb24", "-f", "rawvideo", decodedPath]);
      const decoded = await readFile(decodedPath), stride = 160 * 90 * 3, samples = [];
      if (decoded.length % stride) throw new Error(organ + " decoded frame shape mismatch");
      for (let offset = 0; offset < decoded.length; offset += stride) samples.push(decoded.subarray(offset, offset + stride));
      const motion = samples.slice(1).map((sample, index) => difference(samples[index], sample));
      const uniqueFrames = new Set(samples.map(hash)).size;
      if (samples.length !== Number(probe.streams[0].nb_read_frames) || uniqueFrames !== samples.length || motion.some(step => step.meanAbsoluteByteDifference <= .01)) throw new Error(organ + " decoded camera movement froze");
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "fps=1,scale=640:360,tile=3x1", "-frames:v", "1", path.join(output, name + "-contact-sheet.png")]);
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "fps=3,scale=480:270,tile=3x3", "-frames:v", "1", path.join(output, name + "-dense-contact-sheet.png")]);
      report.videos.push({ file, mode: "live MediaRecorder profile check", organ, view, snapshot, mapResolution: 4096, requestedDurationSeconds: 3, metrics: live.metrics, probe, encodedTimestampSpanSeconds: span, decodedDiagnostics: { resolution: [160, 90], sampling: "every encoded frame", decodedFrames: samples.length, uniqueFrames, frameAppearance: samples.map(imageSummary), rawRgbDifferences: motion }, meaning: "Native UHD profile-specific moving-camera evidence; decoded cadence and frame count are measured, not a sustained 30-FPS or realism claim. Atlas clips show selected exterior structures only." });
      console.log("Recorded " + organ + " live UHD: " + probe.streams[0].nb_read_frames + " encoded frames");
      if (variationCase) { await page.getByRole("checkbox", { name: "Enable material variation", exact: true }).uncheck(); await settled(page); }
    }
  }
  for (const observation of [...report.cases, ...report.videos]) {
    observation.learnedRgbBakeResolution = observation.snapshot?.appearance?.resolution ?? null;
    observation.learnedNativeResolution = observation.snapshot?.appearance ? reviewAppearance?.nativeResolution ?? null : null;
    observation.learnedOutputSampling = observation.snapshot?.appearance ? reviewAppearance?.outputSampling ?? null : null;
  }
  const changedSources = [];
  for (const [file, digest] of Object.entries(report.implementationSha256)) {
    const current = hash(await readFile(file)); if (current !== digest) changedSources.push({ file, startedSha256: digest, finishedSha256: current });
  }
  if (report.servedRuntimeSources) {
    const finished = capturePublicBuildSources(path.resolve(".")).filter(item => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(item.path));
    if (JSON.stringify(finished) !== JSON.stringify(report.servedRuntimeSources)) throw new Error("Served runtime source inventory changed during capture; rebuild and rerun");
  }
  report.sourceConsistency = { unchangedThroughoutCapture: changedSources.length === 0, changedSources };
  if (changedSources.length) throw new Error("Implementation changed during visual acceptance capture; rerun with frozen sources");
  if (report.errors.length) throw new Error("Browser errors: " + report.errors.join("; "));
  report.completed = true;
} catch (error) {
  report.completed = false; report.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "observations.json"), JSON.stringify(report, null, 2) + "\n");
  await context?.close(); await browser?.close();
  if (server && server.exitCode === null) server.kill("SIGTERM");
}
console.log(JSON.stringify({ output, completed: report.completed, cases: report.cases.length, videos: report.videos.length, browserErrors: report.errors.length, failure: report.failure ?? null, interactive4k: report.interactive4k ? { medianMs: report.interactive4k.medianMs, p95Ms: report.interactive4k.p95Ms, width: report.interactive4k.width, height: report.interactive4k.height } : null }, null, 2));
