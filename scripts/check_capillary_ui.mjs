#!/usr/bin/env node
// Serial real-browser gate. CAPILLARY_CHECKS=renderer|ui|all (default all).
// Production builds exclude the development bench: use CAPILLARY_CHECKS=ui.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile), root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-capillary-2026-10-20/browser"));
const mode = process.env.CAPILLARY_CHECKS ?? "all";
if (!["all", "renderer", "ui"].includes(mode)) throw new Error("CAPILLARY_CHECKS must be renderer, ui or all");
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
const url = new URL(base); url.searchParams.set("mode", "blood"); url.searchParams.set("flow", "film");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
} : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 },
  permissions: ["microphone"], acceptDownloads: true });
const page = await context.newPage(), checks = [], errors = [], failedRequests = [];
page.setDefaultTimeout(15000);
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() }); });
const check = (name, details = {}) => checks.push({ name, status: "PASS", ...details });
const download = async (locator, filename) => {
  const pending = page.waitForEvent("download"); await locator.click(); const file = await pending;
  const destination = path.join(out, filename ?? file.suggestedFilename());
  await file.saveAs(destination); return destination;
};
const exported = async filename => JSON.parse(await fs.readFile(await download(
  page.getByRole("button", { name: "Export film state & diagnostics", exact: true }), filename), "utf8"));
const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const reset = async () => {
  await page.getByRole("button", { name: "Apply & reset", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run film", exact: true })).toBeEnabled();
  await expect(page.getByTestId("film-time")).toHaveText("0.000 s");
};
const validateExport = data => {
  expect(data.schema).toBe("viscera.capillary-film.evidence/v1");
  expect(data.dtSeconds).toBe(.005);
  expect(data.config.cells).toBe(96);
  expect(data.config.lengthM).toBe(.004); expect(data.config.widthM).toBe(.001);
  const initial = data.initial, current = data.snapshot;
  expect(current.heightM).toHaveLength(96);
  expect(current.heightM.every(h => Number.isFinite(h) && h > 0)).toBe(true);
  const integrated = current.heightM.reduce((total, h) => total + h, 0) * .004 * .001 / 96;
  expect(Math.abs(integrated / current.volumeM3 - 1)).toBeLessThan(1e-12);
  expect(Math.abs(current.volumeM3 / initial.volumeM3 - 1)).toBeLessThan(2e-10);
  expect(current.maxSlope).toBeLessThanOrEqual(.3);
  expect(current.energyJ).toBeLessThanOrEqual(initial.energyJ + Math.abs(initial.energyJ) * 2e-8);
  if (current.timeSeconds > 0) {
    expect(data.lastSolve.normalizedResidual).toBeLessThanOrEqual(1e-10);
    expect(data.lastSolve.maxFilmReynolds).toBeLessThanOrEqual(1);
    expect(data.lastSolve.minimumHeightM).toBeGreaterThan(0);
    expect(data.lastSolve.relativeVolumeError).toBeLessThanOrEqual(2e-10);
  }
};
let status = "FAIL", caught, accessibility, rendererReport;
try {
  if (mode !== "ui") {
    console.log("Capillary renderer ownership and native-capture gate");
    await page.goto(new URL("src/blood/blood.css", base).href);
    rendererReport = await page.evaluate(async () =>
      (await import("/src/blood/capillary/renderBench.ts")).capillaryRendererBench());
    await fs.writeFile(path.join(out, "renderer.json"), JSON.stringify(rendererReport, null, 2));
    expect(rendererReport.status, JSON.stringify(rendererReport)).toBe("PASS");
    check("Direct renderer lifecycle/native-capture gate", { checks: rendererReport.checks.length });
  }
  if (mode !== "renderer") {
    await page.goto(url.href);
    await expect(page.getByRole("heading", { name: "Thin-film wetting playground." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run film", exact: true })).toBeEnabled();
    const initial = await exported("initial.json"); validateExport(initial);
    expect(initial.snapshot.timeSeconds).toBe(0);
    expect(Math.max(...initial.snapshot.heightM) * 1e6).toBeCloseTo(87.999963207, 6);
    await page.screenshot({ path: path.join(out, "film-initial.png"), fullPage: true });
    const canvas = page.locator(".artery-canvas-host canvas"), stage = page.getByRole("region", { name: "Capillary film scene" });
    const presets = [];
    for (const tension of [.04, .05, .06]) for (const wetting of [0, .08, .12, .16]) {
      console.log(`Film UI preset sigma=${tension}, wetting=${wetting}`);
      await page.getByLabel("Film surface tension", { exact: true }).selectOption(String(tension));
      await page.getByLabel("Film wetting", { exact: true }).selectOption(String(wetting));
      await reset();
      await page.getByRole("button", { name: "Run film", exact: true }).click();
      await expect.poll(async () => parseFloat(await page.getByTestId("film-time").textContent()), { timeout: 20000 }).toBeGreaterThanOrEqual(1);
      await page.getByRole("button", { name: "Pause film", exact: true }).click();
      const state = await exported(`preset-${tension}-${wetting}.json`); validateExport(state);
      expect(state.config.surfaceTensionNm).toBe(tension);
      expect(state.config.wetting?.equilibriumAngleRadians ?? 0).toBe(wetting);
      expect(state.snapshot.timeSeconds).toBeGreaterThanOrEqual(1);
      expect(Math.abs(Math.max(...state.snapshot.heightM) - Math.max(...state.initial.heightM))).toBeGreaterThan(1e-6);
      presets.push({ tension, wetting, timeSeconds: state.snapshot.timeSeconds,
        relativeVolumeError: state.snapshot.volumeM3 / state.initial.volumeM3 - 1,
        energyChangeJ: state.snapshot.energyJ - state.initial.energyJ });
    }
    check("All 12 presets run, pause and export conserved evolving profiles", { presets });
    const paused = await exported("paused.json"); await page.waitForTimeout(400);
    const still = await exported("still-paused.json");
    expect(still.snapshot).toEqual(paused.snapshot);
    check("Paused physical profile, energy, volume and time remain unchanged");
    await canvas.scrollIntoViewIfNeeded();
    const beforeCamera = await canvas.screenshot();
    await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("+"); await frame();
    const afterCamera = await canvas.screenshot({ path: path.join(out, "film-camera.png") });
    expect(hash(afterCamera)).not.toBe(hash(beforeCamera));
    const cameraState = await exported("after-camera.json");
    expect(cameraState.snapshot).toEqual(still.snapshot);
    await canvas.focus(); await page.keyboard.press("Home");
    check("Keyboard camera changes the actual image without advancing the physical model");

    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    await page.getByRole("button", { name: "200%", exact: true }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1050 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.mouse.move(width - 8, 600); await page.mouse.wheel(0, 30000);
      await expect(page.getByRole("link", { name: "Read the thin-film gradient-dynamics reference ↗" })).toBeInViewport();
      await page.mouse.wheel(0, -30000);
      await expect(page.getByRole("link", { name: "Anatomy studio", exact: true })).toBeInViewport();
      await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
    }
    check("375/768/1440px layouts support 200% text and real scrolling");
    await page.getByRole("button", { name: "Display settings", exact: true }).click();
    await page.getByRole("button", { name: "Reset display preferences" }).click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await stage.scrollIntoViewIfNeeded();
    const oldHeight = await stage.evaluate(element => element.getBoundingClientRect().height);
    const resizeHandle = page.getByRole("separator", { name: "Resize scene height" });
    await resizeHandle.focus(); await page.keyboard.press("ArrowDown");
    await expect.poll(() => stage.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(oldHeight);
    await page.getByRole("button", { name: "Scene full screen", exact: true }).click();
    await page.getByRole("button", { name: "Exit scene full screen", exact: true }).click();
    check("Scene height keyboard resize and full-screen round trip");

    await page.getByLabel("Film surface tension", { exact: true }).selectOption("0.05");
    await page.getByLabel("Film wetting", { exact: true }).selectOption("0.12"); await reset();
    for (const quality of [{ name: "HD · 1280 × 720", id: "hd", width: 1280, height: 720 },
      { name: "4K · 3840 × 2160", id: "4k", width: 3840, height: 2160 }]) {
      console.log(`Film actual ${quality.id} recording`);
      await page.getByRole("button", { name: "Video recorder", exact: true }).click();
      const another = page.getByRole("button", { name: "Record another", exact: true });
      if (await another.isVisible()) await another.click();
      await page.getByRole("radio", { name: quality.name, exact: true }).check();
      await page.getByLabel("Recording frame rate").selectOption("30");
      await page.getByLabel("Record microphone audio").uncheck();
      await page.getByRole("button", { name: "Start recording", exact: true }).click();
      await expect(page.getByRole("button", { name: "Stop video recording", exact: true })).toBeVisible();
      await expect(canvas).toHaveAttribute("width", String(quality.width));
      await expect(canvas).toHaveAttribute("height", String(quality.height));
      await page.getByRole("button", { name: "Artery flow playground", exact: true }).click();
      await expect(page.getByText("Stop the recording before changing workspaces.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Apply & reset", exact: true }).click();
      await expect(page.getByText("Stop the recording before applying settings.", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Run film", exact: true }).click();
      await expect.poll(async () => parseFloat(await page.getByTestId("film-time").textContent()), { timeout: 20000 }).toBeGreaterThan(1);
      await page.waitForTimeout(1200);
      await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(1200);
      await page.getByRole("button", { name: "Stop video recording", exact: true }).click();
      await expect(page.getByRole("region", { name: "Finished recording" })).toBeVisible({ timeout: 30000 });
      const movie = await download(page.getByRole("link", { name: /Download (MP4|WEBM)/ }));
      const metadataFile = await download(page.getByRole("button", { name: "Capture details" }), `${quality.id}-capture.json`);
      const metadata = JSON.parse(await fs.readFile(metadataFile, "utf8"));
      expect(metadata.width).toBe(quality.width); expect(metadata.height).toBe(quality.height);
      expect(metadata.sourceWidth).toBe(quality.width); expect(metadata.sourceHeight).toBe(quality.height);
      expect(metadata.upscaled).toBe(false); expect(metadata.sourceKind).toBe("scene");
      expect(metadata.requestedFps).toBe(30);
      expect(metadata.durationMs).toBeGreaterThan(1000);
      const probe = JSON.parse((await exec(process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe", [
        "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", movie,
      ], { maxBuffer: 4 * 1024 * 1024 })).stdout);
      await fs.writeFile(path.join(out, `${quality.id}-ffprobe.json`), JSON.stringify(probe, null, 2));
      const video = probe.streams.find(stream => stream.codec_type === "video");
      expect(video.width).toBe(quality.width); expect(video.height).toBe(quality.height);
      expect(Number(video.nb_read_frames)).toBeGreaterThan(2);
      const framesDir = path.join(out, `${quality.id}-frames`); await fs.mkdir(framesDir, { recursive: true });
      await exec(process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg", ["-v", "error", "-i", movie,
        "-vf", "fps=1", "-frames:v", "4", path.join(framesDir, "frame-%02d.png")], { maxBuffer: 4 * 1024 * 1024 });
      const frameFiles = (await fs.readdir(framesDir)).filter(file => file.endsWith(".png"));
      expect(frameFiles.length).toBeGreaterThanOrEqual(2);
      const hashes = await Promise.all(frameFiles.map(async file => hash(await fs.readFile(path.join(framesDir, file)))));
      expect(new Set(hashes).size).toBeGreaterThan(1);
      check(`Native ${quality.id} moving encoded video and workspace/reset guards`, {
        movie: path.basename(movie), metadata, codec: video.codec_name, encodedFrames: Number(video.nb_read_frames),
        averageFrameRate: video.avg_frame_rate, decodedReviewFrames: frameFiles.length,
      });
      await page.getByRole("button", { name: "Close video recorder", exact: true }).click();
      await page.getByRole("button", { name: "Pause film", exact: true }).click();
      const captured = await exported(`${quality.id}-physical-state.json`); validateExport(captured);
      expect(captured.snapshot.timeSeconds).toBeGreaterThan(1);
      await reset();
    }
    await page.addScriptTag({ path: process.env.AXE_SCRIPT ?? "/private/tmp/blood-axe.min.js" });
    accessibility = await page.evaluate(async () => {
      const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
      return { violations: result.violations, incomplete: result.incomplete.map(item => ({ id: item.id, nodes: item.nodes.length })) };
    });
    expect(accessibility.violations).toEqual([]);
    await page.getByRole("button", { name: "Artery flow playground", exact: true }).click();
    await expect(page.getByRole("button", { name: "Run artery", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Thin-film wetting", exact: true }).click();
    await expect(page.getByRole("button", { name: "Run film", exact: true })).toBeEnabled();
    await expect(page.getByTestId("film-time")).toHaveText("0.000 s");
    check("Accessible UI and clean renderer recreation after workspace changes");
  }
  expect(errors).toEqual([]); expect(failedRequests).toEqual([]); status = "PASS";
} catch (error) {
  caught = String(error); console.error(error); process.exitCode = 1;
  await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(out, "qa.json"), JSON.stringify({
    status, error: caught, mode, url: url.href, checks, errors, failedRequests, rendererReport, accessibility,
    realism: "Numerical thin-film and renderer/capture gate. Surgical realism requires separate visual review.",
  }, null, 2));
  await browser.close();
}
