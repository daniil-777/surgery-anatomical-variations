/** Inspect executed native-512 model bundles in the actual Studio renderer.
 * From viscera/: TISSUE_REVIEW_URL=http://127.0.0.1:PORT/tissues.html \
 * TISSUE_REVIEW_OUTPUT=artifacts/NEW node scripts/tissue_pbr_visual_review.mjs BUNDLE.tissue-pbr.json [...]
 * Requires an already running server, native macOS Chrome/Metal and ffmpeg/ffprobe.
 * Serial GPU work only. No generated output or contact sheet establishes clinical realism.
 */
import { chromium } from "@playwright/test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { capturePublicBuildSources } from "./stage_public_assets.mjs";

const inputs = process.argv.slice(2).map(file => path.resolve(file));
if (!inputs.length || inputs.some(file => !file.endsWith(".tissue-pbr.json"))) throw new Error("Pass one or more actual .tissue-pbr.json bundle paths");
if (process.platform !== "darwin") throw new Error("This acceptance harness requires native macOS Chrome with Metal");
const requested = new URL(process.env.TISSUE_REVIEW_URL ?? "http://127.0.0.1:5176/");
if (!["http:", "https:"].includes(requested.protocol)) throw new Error("TISSUE_REVIEW_URL must use HTTP(S)");
const entryUrl = new URL(requested), baseUrl = new URL(requested);
if (/\.html$/i.test(requested.pathname)) baseUrl.pathname = baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf("/") + 1);
else { baseUrl.pathname = baseUrl.pathname.replace(/\/?$/, "/"); entryUrl.pathname = baseUrl.pathname; entryUrl.searchParams.set("mode", "tissues"); }
baseUrl.search = ""; baseUrl.hash = "";
const output = path.resolve(process.env.TISSUE_REVIEW_OUTPUT ?? "artifacts/tissue-pbr-visual-review");
const prior = await readdir(output).catch(error => { if (error.code === "ENOENT") return []; throw error; });
if (prior.length) throw new Error("Evidence directory is nonempty; preserve prior iterations and choose a new TISSUE_REVIEW_OUTPUT: " + output);
await mkdir(output, { recursive: true });
const width = 3840, height = 2160, nativeResolution = 512, seconds = 3;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const runtimeSources = () => capturePublicBuildSources(path.resolve(".")).filter(item => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(item.path));
const report = {
  schema: "viscera.tissue-pbr-visual-review/v1", startedAt: new Date().toISOString(), entryUrl: entryUrl.href,
  system: { platform: process.platform, arch: process.arch, os: os.release(), node: process.version },
  sourceMapResolution: [nativeResolution, nativeResolution], outputResolution: [width, height],
  meaning: "Actual imported model material at native 512x512, rendered to 3840x2160. Output pixels do not add learned source detail. Engineering evidence; visual acceptance requires inspecting original stills and video.",
  limitations: ["Model provenance is recorded, not independent evidence of measured optics or anatomical correctness.", "Atlas exterior geometry is not a patient-specific reconstruction or connected internal anatomy.", "Decoded frame differences include camera/light motion; uniqueness is not a realism or calibrated flicker score.", "Recording requests 30 FPS; actual render and encode cadence are reported separately."],
  bundles: [], errors: [], optionalConfigProbes: [], completed: false,
};
let browser, context;
async function run(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr = (stderr + bytes).slice(-16000); });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(program + " exited " + code + ": " + stderr)));
  });
}
async function verifyServedSources() {
  const explicit = process.env.TISSUE_REVIEW_SOURCE_MANIFEST;
  const required = Boolean(explicit) || process.env.TISSUE_REVIEW_STATIC_COPY === "1";
  const url = new URL(explicit ?? "public-source.json", baseUrl);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), cache: "no-store" });
  if (response.status === 404 && !required) { report.servedBuildSource = { url: url.href, verified: false, status: "not-provided" }; return; }
  if (!response.ok) throw new Error("Build source receipt unavailable: " + response.status + " " + url.href);
  const bytes = Buffer.from(await response.arrayBuffer());
  let receipt;
  try { receipt = JSON.parse(bytes.toString("utf8")); } catch {
    if (!required && response.headers.get("content-type")?.includes("text/html")) { report.servedBuildSource = { url: url.href, verified: false, status: "development-html-fallback" }; return; }
    throw new Error("Build source receipt is not JSON: " + url.href);
  }
  if (receipt.schema !== "viscera.public-build-source/v1" || !Array.isArray(receipt.files)) throw new Error("Unsupported build source receipt");
  const built = new Map();
  for (const item of receipt.files) {
    if (!item || typeof item.path !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || built.has(item.path)) throw new Error("Invalid or duplicate build source entry");
    built.set(item.path, item.sha256);
  }
  const current = runtimeSources(), mismatches = current.filter(item => built.get(item.path) !== item.sha256).map(item => item.path);
  report.servedBuildSource = { url: url.href, sha256: hash(bytes), checkedRuntimeFiles: current.length, mismatches, verified: mismatches.length === 0 };
  if (mismatches.length) throw new Error("Served build differs from current runtime sources: " + mismatches.join(", "));
}
const host = page => page.locator(".tissue-viewport[data-tissue-ready='true']");
const state = async page => JSON.parse(await host(page).getAttribute("data-tissue-snapshot"));
const settled = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
function assertIdentity(snapshot, bundle) {
  if (snapshot.importedMaterial?.bundleSha256 !== bundle.sha256 || snapshot.organ !== bundle.organ
    || snapshot.resolution?.[0] !== nativeResolution || snapshot.resolution?.[1] !== nativeResolution || snapshot.appearance !== null) {
    throw new Error("Imported material identity/native resolution/legacy appearance isolation failed: " + bundle.file);
  }
  if (snapshot.importedMaterial.provenance?.executed !== true) throw new Error("Renderer omitted executed model provenance");
}
async function ready(page, bundle, view) {
  await page.waitForFunction(({ sha256, view }) => {
    const element = document.querySelector(".tissue-viewport[data-tissue-ready='true']");
    if (!element || document.querySelector(".tissue-loading") || typeof element.captureTissueFrame !== "function") return false;
    const snapshot = JSON.parse(element.dataset.tissueSnapshot ?? "{}");
    return snapshot.importedMaterial?.bundleSha256 === sha256 && (!view || (snapshot.view === view && (view !== "organ" || snapshot.atlas?.nodes?.length > 0)));
  }, { sha256: bundle.sha256, view }, { timeout: 90000 });
  if (await page.getByRole("alert").count()) throw new Error(await page.getByRole("alert").allTextContents());
  await settled(page); assertIdentity(await state(page), bundle);
}
function summary(rgb) {
  let sum = 0, squares = 0, dark = 0, clipped = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const luma = .2126 * rgb[i] + .7152 * rgb[i + 1] + .0722 * rgb[i + 2]; sum += luma; squares += luma * luma;
    if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) < 8) dark++;
    if (Math.max(rgb[i], rgb[i + 1], rgb[i + 2]) >= 250) clipped++;
  }
  const count = rgb.length / 3, mean = sum / count;
  return { meanLumaByte: mean, lumaStdByte: Math.sqrt(Math.max(0, squares / count - mean * mean)), darkFraction: dark / count, nearClippedFraction: clipped / count };
}
function difference(a, b) {
  if (a.length !== b.length) throw new Error("Decoded sample shape mismatch");
  let total = 0; for (let i = 0; i < a.length; i++) total += Math.abs(a[i] - b[i]);
  return { meanAbsoluteByteDifference: total / a.length };
}
async function capture(page, bundle, name, time = 0) {
  await ready(page, bundle);
  const snapshot = await state(page);
  const sample = await host(page).evaluate(async (element, args) => {
    const dataUrl = element.captureTissueFrame(args.width, args.height, args.time);
    const image = new Image(); image.src = dataUrl; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 90;
    const drawing = canvas.getContext("2d", { willReadFrequently: true }); drawing.drawImage(image, 0, 0, 160, 90);
    const rgba = drawing.getImageData(0, 0, 160, 90).data, rgb = [];
    for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
    return { png: dataUrl.slice(dataUrl.indexOf(",") + 1), width: image.width, height: image.height, rgb };
  }, { width, height, time });
  if (sample.width !== width || sample.height !== height) throw new Error("Still is not native 3840x2160 output");
  const bytes = Buffer.from(sample.png, "base64"), file = name + ".png";
  await writeFile(path.join(bundle.directory, file), bytes, { flag: "wx" });
  const diagnostics = summary(sample.rgb);
  bundle.stills.push({ file, timeSeconds: time, width, height, sourceMapResolution: [512, 512], sha256: hash(bytes), snapshot, ...diagnostics });
  if (diagnostics.darkFraction > .98) throw new Error("Almost entirely black capture: " + file);
  return sample;
}
async function record(page, bundle) {
  const snapshot = await state(page); assertIdentity(snapshot, bundle);
  if (snapshot.view !== "organ" || snapshot.study !== "lit") throw new Error("Live clip must show lit organ exterior");
  const result = await host(page).evaluate(async (element, seconds) => {
    if (typeof element.recordTissueVideo !== "function") throw new Error("Missing native video hook");
    const result = await element.recordTissueVideo(seconds);
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onerror = () => reject(new Error("Video blob read failed"));
      reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.readAsDataURL(result.blob);
    });
    return { data, metrics: result.metrics };
  }, seconds);
  assertIdentity(result.metrics.materialSnapshot ?? {}, bundle);
  if (JSON.stringify(result.metrics.materialSnapshot) !== JSON.stringify(snapshot)) throw new Error("Recording material snapshot does not match its start state");
  const name = "organ-live-3840x2160", file = name + (result.metrics.mimeType.startsWith("video/mp4") ? ".mp4" : ".webm");
  const videoPath = path.join(bundle.directory, file), bytes = Buffer.from(result.data, "base64");
  await writeFile(videoPath, bytes, { flag: "wx" });
  const video = bundle.video = { file, sha256: hash(bytes), sourceMapResolution: [512, 512], requestedDurationSeconds: seconds, metrics: result.metrics };
  await writeFile(path.join(bundle.directory, name + "-metrics.json"), JSON.stringify(video, null, 2) + "\n", { flag: "wx" });
  const probe = JSON.parse((await run("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames,avg_frame_rate:format=duration:frame=best_effort_timestamp_time", "-of", "json", videoPath])).stdout);
  video.probe = probe;
  if (probe.streams?.[0]?.width !== width || probe.streams[0].height !== height) throw new Error("Encoded video is not native UHD");
  const timestamps = (probe.frames ?? []).map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite), span = timestamps.at(-1) - timestamps[0];
  const decodedFile = name + "-decoded-160x90.rgb", decodedPath = path.join(bundle.directory, decodedFile);
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "scale=160:90", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-pix_fmt", "rgb24", "-f", "rawvideo", decodedPath]);
  const decoded = await readFile(decodedPath), stride = 160 * 90 * 3, frames = [];
  if (decoded.length % stride) throw new Error("Decoded RGB frame shape mismatch");
  for (let offset = 0; offset < decoded.length; offset += stride) frames.push(decoded.subarray(offset, offset + stride));
  const uniqueFrames = new Set(frames.map(hash)).size, motion = frames.slice(1).map((frame, index) => difference(frames[index], frame));
  video.decodedDiagnostics = { file: decodedFile, resolution: [160, 90], sampling: "every encoded frame", decodedFrames: frames.length, uniqueFrames, frameAppearance: frames.map(summary), rawRgbDifferences: motion };
  video.encodedTimestampSpanSeconds = span;
  video.observedRenderedFps = result.metrics.renderedFrames / result.metrics.durationSeconds;
  video.encodedFramesPerRecordingWallSecond = frames.length / result.metrics.durationSeconds;
  video.encodedFramesPerSecondOverTimestampSpan = span > 0 ? (timestamps.length - 1) / span : null;
  await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "fps=3,scale=480:270,tile=3x3", "-frames:v", "1", path.join(bundle.directory, name + "-contact-sheet.png")]);
  const selected = [...new Set([0, Math.floor((frames.length - 1) / 2), frames.length - 1])].filter(index => index >= 0);
  video.fullResolutionInspectionFrames = [];
  for (const index of selected) {
    const image = name + "-frame" + String(index).padStart(4, "0") + ".png";
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", videoPath, "-vf", "select=eq(n\\," + index + ")", "-fps_mode", "passthrough", "-frames:v", "1", path.join(bundle.directory, image)]);
    video.fullResolutionInspectionFrames.push({ frameIndex: index, file: image, sha256: hash(await readFile(path.join(bundle.directory, image))) });
  }
  await writeFile(path.join(bundle.directory, name + "-analysis.json"), JSON.stringify(video, null, 2) + "\n", { flag: "wx" });
  if (frames.length !== Number(probe.streams[0].nb_read_frames) || frames.length !== timestamps.length) throw new Error("Decoded/probed frame count mismatch");
  if (timestamps.length < 10 || !timestamps.slice(1).every((value, index) => value > timestamps[index]) || span < seconds * .7) throw new Error("Invalid video timestamp cadence or insufficient recorded coverage");
  if (uniqueFrames !== frames.length || motion.some(step => step.meanAbsoluteByteDifference <= .01)) throw new Error("Moving organ video contains duplicate or frozen frames");
  console.log("Reviewed " + bundle.organ + ": " + frames.length + " encoded UHD frames from native-512 maps");
}
try {
  report.harnessSha256 = hash(await readFile(new URL(import.meta.url)));
  report.runtimeSources = runtimeSources();
  await verifyServedSources();
  await run("ffprobe", ["-version"]); await run("ffmpeg", ["-version"]);
  browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"] });
  report.browser = await browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.location().url.endsWith("/api.json")) report.errors.push(message.text()); });
  page.on("response", response => {
    if (response.status() < 400) return;
    const detail = response.status() + " " + response.url();
    if (response.status() === 404 && new URL(response.url()).pathname.endsWith("/api.json")) report.optionalConfigProbes.push(detail); else report.errors.push(detail);
  });
  const entry = await page.goto(entryUrl.href);
  if (!entry?.ok()) throw new Error("Tissue entry unavailable: " + entryUrl.href);
  report.servedEntrySha256 = hash(await entry.body());
  await host(page).waitFor({ state: "visible", timeout: 90000 });
  report.gpu = await host(page).evaluate(element => {
    const gl = element.querySelector("canvas").getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "not exposed", vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : "not exposed" };
  });
  if (!/metal/i.test(report.gpu.renderer) || /swiftshader|software/i.test(report.gpu.renderer)) throw new Error("Native Metal renderer was not verified: " + report.gpu.renderer);
  for (const [index, file] of inputs.entries()) {
    const bytes = await readFile(file), input = JSON.parse(bytes.toString("utf8")), manifest = input.manifest;
    if (input.schema !== "viscera.tissue-pbr-bundle/v1" || manifest?.resolution?.[0] !== 512 || manifest.resolution[1] !== 512
      || manifest.provenance?.executed !== true || manifest.provenance.native_resolution?.[0] !== 512 || manifest.provenance.native_resolution[1] !== 512
      || manifest.provenance.fixture === true || /software.test.fixture/i.test(manifest.provenance.source_type ?? "")) throw new Error("Expected an executed, non-fixture native-512 model bundle: " + file);
    const sha256 = hash(bytes), name = String(index + 1).padStart(2, "0") + "-" + String(manifest.recipe.organ).replace(/[^a-z0-9_-]/gi, "_") + "-" + sha256.slice(0, 12);
    const bundle = { file, sha256, bytes: bytes.length, organ: manifest.recipe.organ, recipe: manifest.recipe, generator: manifest.generator, provenance: manifest.provenance, sourceMapResolution: [512, 512], directory: path.join(output, name), stills: [] };
    report.bundles.push(bundle); await mkdir(bundle.directory);
    await page.getByLabel("Import generated PBR material", { exact: true }).setInputFiles({ name: path.basename(file), mimeType: "application/json", buffer: bytes });
    await ready(page, bundle);
    await page.getByRole("checkbox", { name: "Enable material variation", exact: true }).uncheck();
    await page.getByLabel("View", { exact: true }).selectOption("surface"); await ready(page, bundle, "surface");
    await page.getByLabel("Lighting", { exact: true }).selectOption("camera");
    for (const study of ["albedo", "normal", "roughness", "lit"]) {
      await page.getByLabel("Surface study", { exact: true }).selectOption(study); await settled(page);
      await capture(page, bundle, "coupon-" + study);
    }
    await page.getByLabel("Lighting", { exact: true }).selectOption("grazing"); await settled(page);
    await capture(page, bundle, "coupon-grazing-lit");
    await page.getByLabel("Lighting", { exact: true }).selectOption("camera");
    await page.getByLabel("View", { exact: true }).selectOption("organ"); await ready(page, bundle, "organ");
    const views = [];
    for (const [direction, time] of [["front", 0], ["side", 6], ["back", 12]]) views.push(await capture(page, bundle, "organ-" + direction, time));
    bundle.orbitDifferences = views.slice(1).map((view, index) => difference(views[index].rgb, view.rgb));
    if (bundle.orbitDifferences.some(delta => delta.meanAbsoluteByteDifference <= .25)) throw new Error("Exterior orbit views did not visibly change");
    await page.screenshot({ path: path.join(bundle.directory, "organ-ui.png"), fullPage: true });
    await record(page, bundle);
    if (hash(await readFile(file)) !== sha256) throw new Error("Input bundle changed during validation: " + file);
    await writeFile(path.join(bundle.directory, "observations.json"), JSON.stringify(bundle, null, 2) + "\n", { flag: "wx" });
    await page.getByRole("button", { name: "Return to tissue library", exact: true }).click();
  }
  if (JSON.stringify(runtimeSources()) !== JSON.stringify(report.runtimeSources)) throw new Error("Runtime source inventory changed during validation");
  if (report.harnessSha256 !== hash(await readFile(new URL(import.meta.url)))) throw new Error("Review harness changed during validation");
  if (report.errors.length) throw new Error("Browser errors: " + report.errors.join("; "));
  report.completed = true;
} catch (error) { report.failure = error instanceof Error ? error.stack : String(error); process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(output, "observations.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await context?.close(); await browser?.close();
}
console.log(JSON.stringify({ output, completed: report.completed, bundles: report.bundles.length, failure: report.failure ?? null }, null, 2));
