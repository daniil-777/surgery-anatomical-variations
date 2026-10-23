#!/usr/bin/env node
// Real UI, mouse/touch and native video evidence. Run serially on the GPU.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile), root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-liver-2026-10-20/browser"));
const url = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/"); url.searchParams.set("mode", "blood"); url.searchParams.set("flow", "liver");
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, hasTouch: true, permissions: ["microphone"], acceptDownloads: true });
const page = await context.newPage(), cdp = await context.newCDPSession(page);
const checks = [], errors = [], failedRequests = [];
page.setDefaultTimeout(30000);
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) failedRequests.push({ url: response.url(), status: response.status() }); });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const check = (name, details = {}) => { checks.push({ name, status: "PASS", ...details }); console.log(name); };
const button = name => page.getByRole("button", { name, exact: true });
const canvas = page.locator(".liver-canvas-host canvas"), stage = page.getByRole("region", { name: "Liver bleeding scene" });
const hash = data => createHash("sha256").update(data).digest("hex");
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
let serial = 0;
const download = async (locator, name) => { const pending = page.waitForEvent("download"); await locator.click(); const item = await pending;
  const filename = path.join(out, name ?? item.suggestedFilename()); await item.saveAs(filename); return filename; };
const exported = async (name = `state-${serial++}.json`) => JSON.parse(await fs.readFile(await download(button("Export experiment evidence"), name), "utf8"));
const ready = async () => { await expect(button("Run bleeding")).toBeEnabled({ timeout: 90000 }); await expect(page.getByRole("alert")).toHaveCount(0); };
const reset = async () => { await page.getByRole("button", { name: /^(Clear cuts & reset|Apply & reset liver)$/ }).click(); await ready(); await expect(page.getByTestId("liver-time")).toHaveText("0.000 s"); await expect(page.getByTestId("liver-wounds")).toContainText("0 / 3"); };
async function slider(label, value) { const el = page.getByLabel(label, { exact: true }); const { min, step } = await el.evaluate(e => ({ min: Number(e.min), step: Number(e.step) }));
  await el.focus(); await el.press("Home"); for (let i = 0; i < Math.round((value - min) / step); i++) await el.press("ArrowRight"); await expect(el).toHaveValue(String(value)); }
async function runTo(time) { await button("Run bleeding").click(); await expect.poll(async () => parseFloat(await page.getByTestId("liver-time").textContent()), { timeout: 120000 }).toBeGreaterThanOrEqual(time); await button("Pause bleeding").click(); }
function relative(actual, expected, tolerance = 1e-9) { expect(Number.isFinite(actual)).toBe(true); expect(Number.isFinite(expected)).toBe(true); expect(Math.abs(actual - expected)).toBeLessThanOrEqual(Math.max(2e-18, Math.abs(expected) * tolerance)); }
function validate(data) {
  expect(data.schema).toBe("viscera.liver-bleeding.evidence/v1"); const s = data.snapshot;
  expect(s.timeSeconds).toBeGreaterThanOrEqual(0); expect(data.execution.acceptedTimeSeconds).toBe(s.timeSeconds); expect(data.renderer.timeSeconds).toBe(s.timeSeconds);
  expect(data.execution.error).toBeNull(); expect(data.renderer.woundCount).toBe(s.wounds.length);
  expect(s.film.depthM.length).toBe(s.film.vertexAreaM2.length); expect(s.film.depthM.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
  relative(s.film.depthM.reduce((sum, h, i) => sum + h * s.film.vertexAreaM2[i], 0), s.film.filmVolumeM3);
  relative(s.film.filmVolumeM3 + s.film.escapedVolumeM3, s.film.inputVolumeM3);
  relative(data.renderer.filmVolumeM3, s.film.filmVolumeM3, 3e-6);
  expect(Math.abs(s.coupledVolumeErrorM3)).toBeLessThanOrEqual(s.initialInventoryM3 * 1e-9);
  relative(Object.values(s.cardiovascular.compartmentVolumesM3).reduce((a, v) => a + v, 0), s.cardiovascular.circulatingVolumeM3);
  expect(s.breakup.timeSeconds).toBeCloseTo(s.timeSeconds, 10); expect(s.film.timeSeconds).toBeCloseTo(s.timeSeconds, 10);
  expect(data.renderer.sourceDropletCount).toBe(s.breakup.droplets.length);
  expect(data.renderer.runoffDropletCount).toBe(s.runoff.droplets.length);
  expect(data.renderer.dropletCount).toBe(s.breakup.droplets.length + s.runoff.droplets.length);
  expect(data.renderer.ligamentCount).toBe(s.breakup.ligaments.length);
  expect(s.runoff.timeSeconds).toBeCloseTo(s.timeSeconds, 10);
  expect(s.collector.timeSeconds).toBeCloseTo(s.timeSeconds, 10);
  expect(s.collector.initialFilmVolumeM3).toBe(0);
  expect(s.collector.heightM.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
  relative(s.runoff.inputVolumeM3, s.film.escapedVolumeM3);
  relative(s.runoff.attached.reduce((sum, item) => sum + item.volumeM3, 0), s.runoff.attachedVolumeM3);
  relative(s.runoff.droplets.reduce((sum, item) => sum + item.volumeM3, 0), s.runoff.inFlightVolumeM3);
  relative(s.pendingReturnEvents.reduce((sum, item) => sum + item.volumeM3, 0), s.pendingReturnVolumeM3);
  relative(data.renderer.runoff.attachedAcceptedVolumeM3, s.runoff.attachedVolumeM3);
  relative(data.renderer.collector.reconstructedVolumeM3, s.collector.filmVolumeM3, 5e-7);
  const inventory = s.cardiovascular.circulatingVolumeM3 + s.vessel.vesselVolumeM3
    + s.breakup.inFlightVolumeM3 + s.film.filmVolumeM3 + s.runoff.attachedVolumeM3
    + s.runoff.inFlightVolumeM3 + s.pendingReturnVolumeM3 + s.collector.filmVolumeM3 + s.terminalEscapeVolumeM3;
  relative(inventory, s.initialInventoryM3, 1e-10);
  expect(data.observationHistory.at(-1).time).toBe(s.timeSeconds);
}
// Exported projection is read-only evidence. Scroll correction is measured from
// the canvas DOM rect; no renderer/model callback is invoked by the harness.
async function targetPoint(id, requireVisible = true) {
  await page.getByLabel("Vessel target", { exact: true }).selectOption(id); await button("Show target").click(); await frames();
  const state = await exported(), before = await canvas.boundingBox();
  const target = state.renderer.projectedTargets.find(t => t.id === id); expect(target).toBeTruthy();
  if (requireVisible) expect(target.visible).toBe(true);
  await canvas.scrollIntoViewIfNeeded(); const after = await canvas.boundingBox();
  const point = { x: target.clientX + after.x - before.x, y: target.clientY + after.y - before.y };
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, point)).toBe("CANVAS");
  return point;
}
async function mouseCut(id, requireVisible = true) { const p = await targetPoint(id, requireVisible); await page.mouse.click(p.x, p.y); await frames(); }
async function touch(type, points = []) { await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id, radiusX: 1, radiusY: 1, force: 1 })) }); }
async function gestureGuards(id) {
  await button("Cut").click(); const initial = await exported("gestures-before.json");
  let p = await targetPoint(id);
  await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 22, p.y + 8, { steps: 5 }); await page.mouse.move(p.x, p.y, { steps: 5 }); await page.mouse.up();
  p = await targetPoint(id); await touch("touchStart", [p]); await touch("touchCancel");
  p = await targetPoint(id); await touch("touchStart", [p, { x: p.x + 22, y: p.y + 8 }]); await touch("touchMove", [{ x: p.x - 5, y: p.y }, { x: p.x + 27, y: p.y + 8 }]); await touch("touchEnd");
  await button("Rotate").click(); p = await targetPoint(id); await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(p.x + 30, p.y + 15, { steps: 5 }); await page.mouse.up();
  const after = await exported("gestures-after.json"); expect(after.snapshot).toEqual(initial.snapshot); expect(after.renderer.cameraQuaternion).not.toEqual(initial.renderer.cameraQuaternion);
  await button("Cut").click();
  check("Mouse drag, orbit, native touch cancellation and multitouch never create an incision");
}
async function inspectAppearance() {
  const initial = await exported("appearance-before.json"); validate(initial); await canvas.scrollIntoViewIfNeeded(); await frames(); const before = hash(await canvas.screenshot());
  await page.getByLabel("Show vessel guide", { exact: true }).uncheck(); await frames(); expect(hash(await canvas.screenshot({ path: path.join(out, "guide-off.png") }))).not.toBe(before);
  await page.getByLabel("Show vessel guide", { exact: true }).check();
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("studio"); await frames(); expect(hash(await canvas.screenshot({ path: path.join(out, "studio.png") }))).not.toBe(before);
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("operating"); await frames();
  expect(hash(await canvas.screenshot({ path: path.join(out, "operating.png") }))).not.toBe(before);
  const operating = await exported("appearance-operating.json");
  expect(operating.snapshot).toEqual(initial.snapshot);
  expect(operating.appearance.illumination).toBe("operating");
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("camera"); await slider("Liver exposure", -1); await frames(); expect(hash(await canvas.screenshot({ path: path.join(out, "exposure-minus1.png") }))).not.toBe(before);
  await slider("Liver exposure", 0); await frames(); const after = await exported("appearance-after.json"); expect(after.snapshot).toEqual(initial.snapshot); expect(after.appearance).toEqual(initial.appearance);
  await button("Fit liver").click(); await frames(); const fitted = await exported("fit-liver.json");
  expect(fitted.snapshot).toEqual(initial.snapshot); expect(fitted.renderer.cameraProjection).not.toEqual(after.renderer.cameraProjection);
  check("Guide, illumination and exposure change actual pixels while accepted physics stays identical");
}
async function record(id, quality, targetId, audio) {
  await reset(); await slider("Cut depth", 1); await button("Cut").click(); await page.getByLabel("Run automatically after a vessel cut", { exact: true }).check();
  await targetPoint(targetId);
  await button("Video recorder").click(); if (await button("Record another").isVisible()) await button("Record another").click();
  await page.getByRole("radio", { name: quality.label, exact: true }).check(); await page.getByLabel("Recording frame rate").selectOption("30");
  await page.getByLabel("Record microphone audio").setChecked(audio); await button("Start recording").click(); await expect(button("Stop video recording")).toBeVisible();
  if (await button("Back to the app").isVisible()) await button("Back to the app").click();
  await expect(canvas).toHaveAttribute("width", String(quality.width)); await expect(canvas).toHaveAttribute("height", String(quality.height));
  await button("Clear cuts & reset").click(); await expect(page.getByText("Stop the recording before resetting the liver.", { exact: true })).toBeVisible();
  // Re-read actual projection after the recorder changes render aspect/letterboxing.
  await mouseCut(targetId); await expect(page.getByTestId("liver-wounds")).toContainText("1 / 3 incisions · 1 vessel hits");
  await expect(button("Pause bleeding")).toBeVisible(); await page.waitForTimeout(2400); await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(1200);
  await button("Stop video recording").click(); await expect(page.getByRole("region", { name: "Finished recording" })).toBeVisible({ timeout: 45000 });
  const link = page.getByRole("link", { name: /Download (MP4|WEBM)/ }), ext = (await link.textContent()).includes("MP4") ? "mp4" : "webm";
  const movie = await download(link, `${id}.${ext}`), details = JSON.parse(await fs.readFile(await download(button("Capture details"), `${id}-capture.json`), "utf8"));
  expect(details.width).toBe(quality.width); expect(details.height).toBe(quality.height); expect(details.sourceWidth).toBe(quality.width); expect(details.sourceHeight).toBe(quality.height); expect(details.upscaled).toBe(false);
  const probe = JSON.parse((await exec(process.env.FFPROBE ?? "/opt/homebrew/bin/ffprobe", ["-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", movie])).stdout);
  await fs.writeFile(path.join(out, `${id}-ffprobe.json`), JSON.stringify(probe, null, 2)); const video = probe.streams.find(s => s.codec_type === "video");
  expect(video.width).toBe(quality.width); expect(video.height).toBe(quality.height); expect(Number(video.nb_read_frames)).toBeGreaterThan(20);
  if (audio) expect(probe.streams.some(s => s.codec_type === "audio")).toBe(true);
  const folder = path.join(out, `${id}-frames`); await fs.mkdir(folder, { recursive: true });
  await exec(process.env.FFMPEG ?? "/opt/homebrew/bin/ffmpeg", ["-y", "-v", "error", "-i", movie, "-vf", "fps=1", "-frames:v", "8", path.join(folder, "frame-%02d.png")]);
  const files = (await fs.readdir(folder)).filter(f => f.endsWith(".png")); expect(files.length).toBeGreaterThanOrEqual(2); expect(new Set(await Promise.all(files.map(async f => hash(await fs.readFile(path.join(folder, f)))))).size).toBeGreaterThan(1);
  await button("Close video recorder").click(); if (await button("Pause bleeding").isVisible()) await button("Pause bleeding").click();
  const state = await exported(`${id}-state.json`); validate(state); expect(state.snapshot.timeSeconds).toBeGreaterThan(0); expect(state.snapshot.wounds.length).toBe(1);
  check(`${id}: real mouse cut during native capture, moving decoded frames and reset guard`, { dimensions: [video.width, video.height], frames: Number(video.nb_read_frames), averageFrameRate: video.avg_frame_rate, audio: probe.streams.some(s => s.codec_type === "audio"), physicalTime: state.snapshot.timeSeconds });
}
let status = "FAIL", caught, accessibility;
try {
  await page.goto(url.href); await ready();
  await expect(page.getByLabel("Liver blood viscosity", { exact: true })).toHaveValue("0.00345");
  await page.getByLabel("Run automatically after a vessel cut", { exact: true }).uncheck(); await button("Cut").click();
  const initial = await exported("initial.json"); validate(initial); expect(initial.anatomy.license).toBe("CC-BY-4.0"); expect(initial.anatomy.vascularModel).toBe("procedural-surface-design-not-patient-vasculature");
  await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); await page.mouse.click(box.x + 3, box.y + 3);
  expect((await exported("background-miss.json")).snapshot).toEqual(initial.snapshot);
  let chosen;
  for (const target of initial.targets) {
    await reset(); await slider("Cut depth", .25); await button("Cut").click(); await mouseCut(target.id);
    const shallow = await exported(`shallow-${target.id}.json`); validate(shallow);
    if (shallow.snapshot.wounds.length !== 1 || shallow.snapshot.wounds[0].vesselId !== null) continue;
    await runTo(.05); const dry = await exported(`shallow-after-${target.id}.json`); validate(dry); expect(dry.snapshot.vessel.expelledVolumeM3).toBe(0); expect(dry.renderer.removedAreaM2).toBeGreaterThan(0); expect(dry.renderer.cavityTriangles).toBeGreaterThan(0);
    await reset(); await slider("Cut depth", 1); await mouseCut(target.id); const deep = await exported(`deep-${target.id}.json`); validate(deep);
    if (deep.snapshot.wounds.length === 1 && deep.snapshot.wounds[0].vesselId) { chosen = target.id; break; }
  }
  expect(chosen).toBeTruthy();
  await stage.screenshot({ path: path.join(out, "deep-incision.png") });
  const beforeDuplicate = await exported("duplicate-before.json"); await mouseCut(chosen, false); const afterDuplicate = await exported("duplicate-after.json"); expect(afterDuplicate.snapshot).toEqual(beforeDuplicate.snapshot);
  check("Actual mouse: background misses, shallow geometry-only incision, deeper vessel opening and duplicate prevention", { targetId: chosen });
  await reset(); await gestureGuards(chosen);
  const touchPoint = await targetPoint(chosen); await touch("touchStart", [touchPoint]); await touch("touchEnd");
  const touchCut = await exported("touch-cut.json"); validate(touchCut); expect(touchCut.snapshot.wounds).toHaveLength(1); expect(touchCut.snapshot.wounds[0].vesselId).not.toBeNull();
  check("Native touch tap opens one geometrically anchored vessel wound");
  await runTo(.5); const venous = await exported("venous-half-second.json"); validate(venous); expect(venous.snapshot.vessel.expelledVolumeM3).toBeGreaterThan(0); expect(venous.snapshot.film.filmVolumeM3 + venous.snapshot.breakup.inFlightVolumeM3).toBeGreaterThan(0);
  await stage.screenshot({ path: path.join(out, "venous-blood-film.png") }); await inspectAppearance();
  const beforePending = await exported("pending-before.json"); await page.getByLabel("Liver vessel model", { exact: true }).selectOption("artery");
  await expect(page.getByText("Circulation changes are pending. Apply & reset to use them.", { exact: true })).toBeVisible(); const pending = await exported("pending.json"); expect(pending.snapshot).toEqual(beforePending.snapshot); expect(pending.settings).toEqual(beforePending.settings);
  await reset(); await button("Cut").click(); await mouseCut(chosen); await runTo(.5); const arterial = await exported("arterial-half-second.json"); validate(arterial); expect(arterial.settings.kind).toBe("artery"); expect(arterial.snapshot.vessel.pressurePa).toBeGreaterThan(venous.snapshot.vessel.pressurePa);
  await stage.screenshot({ path: path.join(out, "arterial-blood-film.png") });
  check("Accepted half-second venous/arterial runs conserve volume; pending physiology is applied only by reset", { venousLossM3: venous.snapshot.vessel.expelledVolumeM3, arterialLossM3: arterial.snapshot.vessel.expelledVolumeM3 });
  // Use separately focused targets; raycasting and wound constraints remain active.
  for (const target of initial.targets.filter(t => t.id !== chosen)) { if ((await exported()).snapshot.wounds.length >= 3) break; await mouseCut(target.id); }
  const three = await exported("three-wounds.json"); validate(three); expect(three.snapshot.wounds).toHaveLength(3); await expect(button("Cut selected vessel")).toBeDisabled();
  const extra = initial.targets.find(t => !three.snapshot.wounds.some(w => Math.hypot(...t.pick.positionM.map((v, k) => v - w.pick.positionM[k])) < .01));
  if (extra) await mouseCut(extra.id); expect((await exported("three-limit.json")).snapshot).toEqual(three.snapshot); check("Three nonoverlapping actual surface cuts are supported; a fourth is rejected");
  await button("Display settings").click(); await button("200%").click(); await button("Done").click();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 }); await frames();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1
      && document.querySelector(".blood-lab").scrollWidth <= document.querySelector(".blood-lab").clientWidth + 1)).toBe(true);
    await page.getByRole("heading", { name: "Liver bleeding experiment.", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, `layout-${width}-text200-top.png`) });
    await stage.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out, `layout-${width}-text200-scene.png`) });
    await page.getByText("Model, anatomy and limitations", { exact: true }).scrollIntoViewIfNeeded(); await expect(page.getByText("Model, anatomy and limitations", { exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
  }
  await button("Display settings").click(); await button("Reset display preferences").click(); await button("Done").click();
  const height = await stage.evaluate(el => el.clientHeight); await page.getByRole("separator", { name: "Resize scene height" }).focus(); await page.keyboard.press("ArrowDown"); await expect.poll(() => stage.evaluate(el => el.clientHeight)).toBeGreaterThan(height);
  await button("Scene full screen").click(); await button("Exit scene full screen").click(); check("375/768/1440 layouts at 200% text, scene resize and full screen remain operable");
  await page.getByLabel("Liver vessel model", { exact: true }).selectOption("vein"); await reset();
  await record("liver-hd-audio", { label: "HD · 1280 × 720", width: 1280, height: 720 }, chosen, true);
  await record("liver-4k", { label: "4K · 3840 × 2160", width: 3840, height: 2160 }, chosen, false);
  try { await page.addScriptTag({ path: process.env.AXE_SCRIPT ?? "/private/tmp/blood-axe.min.js" }); accessibility = await page.evaluate(() => axe.run(document.querySelector(".blood-lab"), { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } })); expect(accessibility.violations).toEqual([]); check("Automated WCAG audit reports no violations", { incomplete: accessibility.incomplete.length }); }
  catch (error) { if (String(error).includes("ENOENT")) accessibility = { status: "NOT RUN", reason: "axe fixture not available" }; else throw error; }
  const acceptedBeforeLoss = await exported("context-loss-before.json");
  await canvas.evaluate(el => {
    const extension = el.getContext("webgl2")?.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("Native context-loss extension is required by this gate");
    extension.loseContext();
  });
  await expect(page.getByRole("alert")).toContainText("Experiment paused");
  await expect(button("Run bleeding")).toBeDisabled();
  await expect(button("Export experiment evidence")).toBeEnabled();
  const halted = await exported("context-loss-export.json");
  expect(halted.execution.phase).toBe("halted"); expect(halted.execution.error).toBeTruthy();
  expect(halted.snapshot).toEqual(acceptedBeforeLoss.snapshot);
  check("GPU loss halts input and preserves an exportable last accepted physical state");
  expect(errors).toEqual([]); expect(failedRequests).toEqual([]); status = "PASS";
} catch (error) { caught = String(error); console.error(error); await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {}); }
finally { await fs.writeFile(path.join(out, "qa.json"), JSON.stringify({ status, caught, url: url.href, checks, errors, failedRequests,
  accessibility: accessibility ? { violations: accessibility.violations, incomplete: accessibility.incomplete?.map(x => x.id), status: accessibility.status } : null,
  visualRealism: "Images and decoded motion require visual review. Numerical/UI PASS is not surgical realism or clinical validation." }, null, 2)); await browser.close(); }
if (status !== "PASS") process.exitCode = 1;
