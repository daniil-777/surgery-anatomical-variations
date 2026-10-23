#!/usr/bin/env node
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-artery-2026-10-20/ui"));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
} : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ["microphone"], acceptDownloads: true });
const page = await context.newPage(), checks = [], errors = [], failedRequests = [];
const url = `${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/"}?mode=blood&flow=artery`;
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
page.on("pageerror", e => errors.push(String(e)));
page.on("console", e => { if (e.type() === "error") errors.push(e.text()); });
page.on("response", r => { if (r.status() >= 400) failedRequests.push({ url: r.url(), status: r.status() }); });
const check = (name, details = {}) => checks.push({ name, status: "PASS", ...details });
const download = async (locator, filename) => {
  const pending = page.waitForEvent("download"); await locator.click(); const file = await pending;
  const destination = path.join(out, filename ?? file.suggestedFilename()); await file.saveAs(destination); return destination;
};
const exported = async name => JSON.parse(await fs.readFile(await download(page.getByRole("button", { name: "Export artery state & waveform" }), name), "utf8"));
const reset = async () => {
  await page.getByRole("button", { name: "Apply & reset", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run artery", exact: true })).toBeEnabled();
  await expect(page.getByTestId("artery-time")).toHaveText("0.000 s");
};
const setRange = async (name, value) => {
  // Keyboard operates the actual accessible slider; do not bypass React state.
  const input = page.getByRole("slider", { name, exact: true }); await input.focus(); await input.press("Home");
  const { min, step } = await input.evaluate(el => ({ min: Number(el.min), step: Number(el.step) }));
  for (let i = 0; i < Math.round((value - min) / step); ++i) await input.press("ArrowRight");
};
let status = "FAIL", caught, accessibility;
try {
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Artery flow playground." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run artery", exact: true })).toBeEnabled({ timeout: 60000 });
  const initial = await exported("initial-cy.json");
  expect(Math.abs(initial.snapshot.flowRateM3S / 2.102134673690784e-6 - 1)).toBeLessThan(.001);
  expect(initial.snapshot.wallShearPa).toBeCloseTo(.45, 6);
  expect(initial.initialization.kind).toBe("steady-mean-pressure-gradient");
  expect(initial.initialization.periodicSteadyState).toBe(false);
  check("UI starts with independently verified CY steady flow", { flowM3S: initial.snapshot.flowRateM3S, wallShearPa: initial.snapshot.wallShearPa });
  await page.screenshot({ path: path.join(out, "artery-initial.png"), fullPage: true });
  const canvas = page.locator(".artery-canvas-host canvas");
  await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("+"); await page.keyboard.press("Home");
  await page.getByLabel("Artery display", { exact: true }).selectOption("blood");
  await page.locator(".artery-stage").scrollIntoViewIfNeeded();
  await page.locator(".artery-stage").screenshot({ path: path.join(out, "artery-blood.png") });
  await page.getByLabel("Open vessel cutaway").uncheck();
  await page.locator(".artery-stage").scrollIntoViewIfNeeded();
  await page.locator(".artery-stage").screenshot({ path: path.join(out, "artery-complete-vessel.png") });
  await page.getByLabel("Open vessel cutaway").check();
  await page.getByLabel("Artery display", { exact: true }).selectOption("velocity");
  check("Camera, cutaway, full vessel and material/velocity modes");
  await page.getByRole("button", { name: "Run artery", exact: true }).click();
  await expect.poll(async () => parseFloat(await page.getByTestId("artery-time").textContent()), { timeout: 15000 }).toBeGreaterThan(.4);
  await page.getByRole("button", { name: "Pause artery", exact: true }).click();
  const paused = await exported("paused-pulse.json");
  await page.waitForTimeout(400); const still = await exported("still-pulse.json");
  expect(still.snapshot.timeSeconds).toBe(paused.snapshot.timeSeconds);
  expect(still.snapshot.axialVelocityMS).toEqual(paused.snapshot.axialVelocityMS);
  expect(still.recentHistory.length).toBeGreaterThan(1);
  check("Pulsatile solve advances; pause preserves physical state", { timeSeconds: still.snapshot.timeSeconds });
  await page.getByLabel("Artery timestep", { exact: true }).selectOption("0.5"); await reset();
  await expect(page.getByLabel("Artery timestep", { exact: true })).toHaveValue("0.5");
  const halfStep = await exported("half-ms-step.json");
  expect(halfStep.pressureWaveform.dtMS).toBe(.5);
  await page.getByRole("button", { name: "Run artery", exact: true }).click();
  await expect.poll(async () => parseFloat(await page.getByTestId("artery-time").textContent())).toBeGreaterThan(.05);
  await page.getByRole("button", { name: "Pause artery", exact: true }).click();
  const halfStepMotion = await exported("half-ms-motion.json");
  expect(halfStepMotion.snapshot.timeSeconds / halfStepMotion.snapshot.acceptedSteps).toBeCloseTo(.0005, 12);
  check("Fractional timestep stays selected and drives the actual solve");
  await page.getByLabel("Artery timestep", { exact: true }).selectOption("1"); await reset();
  await page.getByLabel("Blood rheology").selectOption("newtonian"); await reset();
  const newtonian = await exported("newtonian-steady.json");
  expect(Math.abs(newtonian.snapshot.flowRateM3S / 2.765967445008405e-6 - 1)).toBeLessThan(.001);
  expect(newtonian.snapshot.flowRateM3S).toBeGreaterThan(initial.snapshot.flowRateM3S);
  await setRange("Lumen radius", 4); await reset();
  const larger = await exported("radius-4mm.json");
  expect(larger.snapshot.flowRateM3S / newtonian.snapshot.flowRateM3S).toBeCloseTo((4 / 3) ** 4, 6);
  await setRange("Vessel length", 100); await reset();
  const longer = await exported("length-100mm.json");
  expect(longer.snapshot.flowRateM3S).toBeCloseTo(larger.snapshot.flowRateM3S, 12);
  expect(longer.snapshot.pressureDropPa).toBeCloseTo(30, 8);
  check("Rheology, physical radius and pressure-gradient/length semantics");
  await setRange("Lumen radius", 3); await setRange("Vessel length", 60);
  await page.getByLabel("Blood rheology").selectOption("carreau-yasuda"); await reset();
  await setRange("Mean pressure gradient", 0); await setRange("Pulse amplitude", 1200); await reset();
  await expect(page.getByRole("img", { name: /^Axial velocity across the lumen/ })).toHaveAttribute("aria-label",
    "Axial velocity across the lumen ranges from 0.000 to 0.000 metres per second, zero at the vessel wall.");
  // Observe slowly enough to pause inside the negative half-cycle. Checking a
  // delayed readout alone allowed the exported/screenshot state to be positive.
  await page.getByLabel("Artery playback speed", { exact: true }).selectOption("0.1");
  await expect(page.getByLabel("Artery playback speed", { exact: true })).toHaveValue("0.1");
  await page.getByRole("button", { name: "Run artery", exact: true }).click();
  await expect.poll(async () => parseFloat(await page.getByTestId("artery-flow").textContent()), { timeout: 15000 }).toBeLessThan(-.1);
  await page.getByRole("button", { name: "Pause artery", exact: true }).click();
  const reversing = await exported("reversing-pulse.json");
  expect(reversing.snapshot.flowRateM3S * 1e6).toBeLessThan(-.1);
  expect(Math.min(...reversing.snapshot.axialVelocityMS)).toBeLessThan(0);
  expect(reversing.recentHistory.some(row => row.flowMLs > .1)).toBe(true);
  expect(reversing.recentHistory.some(row => row.flowMLs < -.1)).toBe(true);
  await expect(page.getByTestId("artery-time")).toHaveText(`${reversing.snapshot.timeSeconds.toFixed(3)} s`);
  await expect(page.getByTestId("artery-flow")).toHaveText(`${(reversing.snapshot.flowRateM3S * 1e6).toFixed(3)} mL/s`);
  await page.locator(".artery-stage").scrollIntoViewIfNeeded();
  await page.locator(".artery-stage").screenshot({ path: path.join(out, "artery-reverse-flow.png") });
  check("Zero-flow chart is truthful; pulsatile CY flow reverses through the UI", { timeSeconds: reversing.snapshot.timeSeconds,
    flowMLs: reversing.snapshot.flowRateM3S * 1e6 });
  await setRange("Mean pressure gradient", 300); await setRange("Pulse amplitude", 200); await reset();
  await page.getByLabel("Artery playback speed", { exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page.getByRole("button", { name: "200%", exact: true }).click(); await page.getByRole("button", { name: "Done", exact: true }).click();
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.mouse.move(width - 8, 600); await page.mouse.wheel(0, 30000);
    await expect(page.getByRole("link", { name: "Read the blood-rheology study ↗" })).toBeInViewport();
    await page.mouse.wheel(0, -30000);
    await expect(page.getByRole("link", { name: "Anatomy studio" })).toBeInViewport();
    await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
  }
  check("Mobile/desktop 200% text and real scrolling");
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page.getByRole("button", { name: "Reset display preferences" }).click(); await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("separator", { name: "Resize scene height" }).focus(); await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "Scene full screen", exact: true }).click();
  await page.getByRole("button", { name: "Exit scene full screen", exact: true }).click();
  for (const quality of [{ name: "HD · 1280 × 720", id: "hd", width: 1280, height: 720 }, { name: "4K · 3840 × 2160", id: "4k", width: 3840, height: 2160 }]) {
    console.log(`Recording artery ${quality.id}`);
    await page.getByRole("button", { name: "Video recorder", exact: true }).click();
    const another = page.getByRole("button", { name: "Record another", exact: true }); if (await another.isVisible()) await another.click();
    await page.getByRole("radio", { name: quality.name, exact: true }).check();
    await page.getByLabel("Recording frame rate").selectOption("30"); await page.getByLabel("Record microphone audio").uncheck();
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    await expect(page.getByRole("button", { name: "Stop video recording", exact: true })).toBeVisible();
    await expect(canvas).toHaveAttribute("width", String(quality.width)); await expect(canvas).toHaveAttribute("height", String(quality.height));
    await page.getByRole("button", { name: "Free-surface fluid", exact: true }).click();
    await expect(page.getByText("Stop the recording before changing workspaces.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Run artery", exact: true }).click(); await page.waitForTimeout(2200);
    await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.waitForTimeout(1200);
    await page.getByRole("button", { name: "Stop video recording", exact: true }).click();
    await expect(page.getByRole("region", { name: "Finished recording" })).toBeVisible({ timeout: 30000 });
    const movie = await download(page.getByRole("link", { name: /Download (MP4|WEBM)/ }));
    const metadata = await download(page.getByRole("button", { name: "Capture details" }), `${quality.id}-capture.json`);
    check(`Native artery ${quality.id} capture`, { file: path.basename(movie), metadata: JSON.parse(await fs.readFile(metadata, "utf8")) });
    await page.getByRole("button", { name: "Close video recorder" }).click();
    await page.getByRole("button", { name: "Pause artery", exact: true }).click(); await reset();
  }
  await page.addScriptTag({ path: process.env.AXE_SCRIPT ?? "/private/tmp/blood-axe.min.js" });
  accessibility = await page.evaluate(async () => {
    const r = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
    return { violations: r.violations, incomplete: r.incomplete.map(v => ({ id: v.id, nodes: v.nodes.length })) };
  });
  expect(accessibility.violations).toEqual([]);
  await page.getByRole("button", { name: "Free-surface fluid", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run fluid", exact: true })).toBeEnabled({ timeout: 60000 });
  await page.getByRole("button", { name: "Artery flow playground", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run artery", exact: true })).toBeEnabled();
  check("Switching workspaces releases prior renderer and recreates cleanly");
  expect(errors).toEqual([]); expect(failedRequests).toEqual([]); status = "PASS";
} catch (error) {
  caught = String(error); console.error(error); process.exitCode = 1;
  await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(out, "qa.json"), JSON.stringify({ status, error: caught, checks, errors, failedRequests, accessibility }, null, 2));
  await browser.close();
}
