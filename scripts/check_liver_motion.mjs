#!/usr/bin/env node
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { capturePublicBuildSources } from "./stage_public_assets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ??
  path.join(root, "artifacts/liver-bleeding-2026-10-20", `motion-${Date.now()}`));
const options = {
  width: Number(process.env.LIVER_MOTION_WIDTH ?? 3840),
  height: Number(process.env.LIVER_MOTION_HEIGHT ?? 2160),
  fps: 20, durationSeconds: Number(process.env.LIVER_MOTION_SECONDS ?? 8),
  illumination: process.env.LIVER_MOTION_LIGHT ?? "camera", kind: process.env.LIVER_MOTION_KIND ?? "vein",
  view: process.env.LIVER_MOTION_VIEW ?? "wound",
  undersideBoundary: process.env.LIVER_MOTION_UNDERSIDE ?? "drain",
};
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
const timeoutMS = Number(process.env.LIVER_MOTION_TIMEOUT_MS ?? 1_200_000);
if (![1280, 1920, 3840].includes(options.width) || options.height !== options.width * 9 / 16 ||
    !Number.isFinite(options.durationSeconds) || options.durationSeconds < 1 || options.durationSeconds > 15 ||
    !Number.isSafeInteger(options.durationSeconds * options.fps) ||
    !["camera", "studio", "operating"].includes(options.illumination) || !["vein", "artery"].includes(options.kind) ||
    !["wound", "overview"].includes(options.view) ||
    !["drain", "retain"].includes(options.undersideBoundary) ||
    !Number.isSafeInteger(timeoutMS) || timeoutMS < 1000 || timeoutMS > 3_600_000)
  throw new RangeError("Invalid motion capture options or timeout");
const expectedFrames = options.durationSeconds * options.fps;
await fs.mkdir(out, { recursive: false });
await fs.mkdir(path.join(out, "frames"));
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sources = async () => ({
  browserBuildSources: capturePublicBuildSources(root),
  script: digest(await fs.readFile(import.meta.filename)),
});
const command = (exe, args, limitMS = 180_000) => new Promise((resolve, reject) => {
  const child = spawn(exe, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, limitMS);
  child.stdout.on("data", b => { stdout += b; });
  child.stderr.on("data", b => { stderr = (stderr + b).slice(-100_000); });
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", code => {
    clearTimeout(timer);
    code === 0 && !timedOut ? resolve(stdout) :
      reject(new Error(`${exe}: ${timedOut ? `timeout after ${limitMS} ms` : code}\n${stderr}`));
  });
});
const bounded = async (work, limitMS, label) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${limitMS} ms`)), limitMS);
    })]);
  } finally { clearTimeout(timer); }
};
const report = { status: "RUNNING", startedAt: new Date().toISOString(), options,
  expectedFrames, timeoutMS, frames: [], loadedAssets: [], errors: [], failedRequests: [] };
let browser, page;
const assetChecks = [];
try {
  report.sourceHashes = await sources();
  browser = await chromium.launch({ headless: true,
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--use-gl=angle", "--use-angle=metal"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1,
    serviceWorkers: "block" });
  page.setDefaultTimeout(30_000);
  page.on("pageerror", error => report.errors.push(String(error)));
  page.on("console", message => {
    if (message.type() === "error") report.errors.push(message.text());
    if (message.text().startsWith("[liver-motion]")) console.log(message.text());
  });
  page.on("response", response => {
    if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() });
    // Bind the actual source specimen and photo maps to the review, alongside
    // code hashes. These are served bytes; compressed HTTP content is decoded
    // by Playwright, so this is not a claim about the wire-transfer encoding.
    const url = new URL(response.url());
    if (/\/(?:textures|static\/api)\//.test(url.pathname) && response.ok()) {
      assetChecks.push(response.body().then(bytes => {
        report.loadedAssets.push({ url: response.url(), bytes: bytes.length, sha256: digest(bytes) });
      }).catch(error => { report.errors.push(`Asset receipt failed: ${error}`); }));
    }
  });
  page.on("requestfailed", request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.exposeFunction("__saveLiverMotionFailure", async state => {
    if (state?.schema !== "viscera.liver-motion-failure/v1" ||
        !Number.isFinite(state.snapshot?.timeSeconds) || state.snapshot.timeSeconds < 0)
      throw new Error("Invalid motion failure state");
    const bytes = Buffer.from(JSON.stringify(state));
    await fs.writeFile(path.join(out, "failure-state.json"), bytes, { flag: "wx" });
    report.failureState = { filename: "failure-state.json", bytes: bytes.length,
      sha256: digest(bytes), acceptedTimeSeconds: state.snapshot.timeSeconds };
  });
  await page.exposeFunction("__saveLiverMotionFrame", async frame => {
    const endpoint = frame?.endpoint === true;
    if (!frame || typeof frame.endpoint !== "boolean" || !Number.isSafeInteger(frame.index) || !Number.isFinite(frame.timeSeconds) ||
        frame.index !== report.frames.length || frame.index > expectedFrames || report.endpoint ||
        endpoint !== (frame.index === expectedFrames) ||
        Math.abs(frame.timeSeconds - frame.index / options.fps) > 1e-10 ||
        typeof frame.dataUrl !== "string" || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.dataUrl))
      throw new Error("Invalid or out-of-order physical motion frame");
    const filename = endpoint ? "accepted-endpoint.jpg" : `frames/frame-${String(frame.index).padStart(5, "0")}.jpg`;
    const bytes = Buffer.from(frame.dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)
      throw new Error("Incomplete JPEG frame");
    await fs.writeFile(path.join(out, filename), bytes, { flag: "wx" });
    const receipt = { filename, timeSeconds: frame.timeSeconds, sha256: digest(bytes), bytes: bytes.length };
    if (endpoint) report.endpoint = receipt;
    else report.frames.push(receipt);
  });
  await page.goto(new URL("src/blood/blood.css", base).href, { timeout: 30_000 });
  await page.evaluate(() => document.body.replaceChildren());
  const result = await bounded(page.evaluate(async options =>
    (await import("/src/blood/liver/motionBench.ts")).liverMotionBench(options), options),
  timeoutMS, "Accepted-time motion capture");
  if (result.status !== "PASS" || result.frames !== expectedFrames || report.frames.length !== expectedFrames ||
      result.endpointFrames !== 1 || !report.endpoint ||
      result.acceptedEndpointTimeSeconds !== options.durationSeconds ||
      result.encodedDurationSeconds !== options.durationSeconds)
    throw new Error("Motion capture did not complete the requested physical interval");
  await fs.writeFile(path.join(out, "accepted-states.json"), JSON.stringify(result), { flag: "wx" });
  report.result = { ...result, checkpoints: result.checkpoints.map(x => ({ timeSeconds: x.timeSeconds, diagnostics: x.diagnostics })) };
  report.sourceHashesAfter = await sources();
  report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesAfter);
  if (!report.sourceStable) throw new Error("Sources changed during motion capture");
  await bounded(Promise.all(assetChecks), 30_000, "Loaded asset receipts");
  report.loadedAssets.sort((a, b) => a.url.localeCompare(b.url));
  if (!report.loadedAssets.some(asset => /\/specimens\/hra-liver-female\.json\.gz(?:\?|$)/.test(asset.url)))
    throw new Error("The actual liver source asset was not recorded");
  if (report.errors.length || report.failedRequests.length) throw new Error("Browser errors occurred");
  await bounded(browser.close(), 15_000, "Browser cleanup"); browser = undefined;
  await command("/opt/homebrew/bin/ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-err_detect", "explode", "-n",
    "-framerate", String(options.fps), "-i", path.join(out, "frames/frame-%05d.jpg"),
    // Canvas output is sRGB; JPEG stores its full-range YCbCr with the JPEG
    // matrix. Convert the transfer function and matrix, rather than merely
    // relabelling full-range JPEG as limited-range Rec.709 video.
    "-vf", "colorspace=ispace=bt470bg:irange=pc:iprimaries=bt709:itrc=srgb:all=bt709:range=tv:format=yuv420p",
    "-frames:v", String(expectedFrames), "-c:v", "libx264", "-crf", "17", "-pix_fmt", "yuv420p",
    "-color_range", "tv", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
    "-movflags", "+faststart", path.join(out, "liver-motion.mp4")]);
  report.video = JSON.parse(await command("/opt/homebrew/bin/ffprobe", ["-v", "error", "-count_frames",
    "-show_streams", "-show_format", "-show_frames",
    "-show_entries", "frame=media_type,best_effort_timestamp_time,width,height",
    "-of", "json", path.join(out, "liver-motion.mp4")]));
  const video = report.video.streams.find(s => s.codec_type === "video");
  const rational = value => {
    const [a, b] = String(value).split("/").map(Number); return b ? a / b : NaN;
  };
  if (!video || report.video.streams.length !== 1 || video.codec_name !== "h264" || video.pix_fmt !== "yuv420p" ||
      video.color_range !== "tv" || video.color_space !== "bt709" ||
      video.color_primaries !== "bt709" || video.color_transfer !== "bt709" ||
      video.width !== options.width || video.height !== options.height ||
      Number(video.nb_frames) !== expectedFrames || Number(video.nb_read_frames) !== expectedFrames ||
      rational(video.avg_frame_rate) !== options.fps ||
      !Number.isFinite(Number(video.start_time)) || Math.abs(Number(video.start_time)) > 1e-9 ||
      !Number.isFinite(Number(video.duration)) || Math.abs(Number(video.duration) - options.durationSeconds) > 1e-6 ||
      !Number.isFinite(Number(report.video.format.duration)) ||
      Math.abs(Number(report.video.format.duration) - options.durationSeconds) > 1e-6)
    throw new Error("Encoded movie differs from native physical frame sequence");
  const decoded = report.video.frames;
  if (!Array.isArray(decoded) || decoded.length !== expectedFrames || decoded.some((frame, index) =>
    frame.media_type !== "video" || frame.width !== options.width || frame.height !== options.height ||
    !Number.isFinite(Number(frame.best_effort_timestamp_time)) ||
    Math.abs(Number(frame.best_effort_timestamp_time) - index / options.fps) > 1e-6))
    throw new Error("Decoded frame timestamps or dimensions differ from accepted physical samples");
  await fs.mkdir(path.join(out, "decoded"));
  await command("/opt/homebrew/bin/ffmpeg", ["-nostdin", "-v", "error", "-xerror", "-n",
    "-i", path.join(out, "liver-motion.mp4"), "-vf",
    `select='eq(n,0)+eq(n,${Math.floor(expectedFrames / 2)})+eq(n,${expectedFrames - 1})',colorspace=all=bt709:trc=srgb:range=pc,format=rgb24`,
    "-fps_mode", "vfr", path.join(out, "decoded/frame-%02d.png")]);
  report.decodedReviewFrames = (await fs.readdir(path.join(out, "decoded"))).sort();
  if (report.decodedReviewFrames.length !== 3) throw new Error("Decoded review frames are missing");
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error); process.exitCode = 1;
  try {
    report.sourceHashesAfter = await sources();
    report.sourceStable = JSON.stringify(report.sourceHashes) === JSON.stringify(report.sourceHashesAfter);
  } catch (receiptError) {
    report.sourceStable = false; report.sourceReceiptError = String(receiptError);
  }
} finally {
  try { if (browser) await bounded(browser.close(), 15_000, "Final browser cleanup"); }
  catch (error) { report.status = "FAIL"; report.cleanupError = String(error); process.exitCode = 1; }
  if (!report.sourceHashesAfter) {
    try { report.sourceHashesAfter = await sources(); } catch (error) { report.sourceReceiptError = String(error); }
  }
  report.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(out, "motion.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  console.log(JSON.stringify({ status: report.status, frames: report.frames.length, error: report.error, out }));
}
