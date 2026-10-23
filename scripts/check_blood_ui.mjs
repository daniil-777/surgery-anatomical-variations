#!/usr/bin/env node
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-2026-10-20/ui"));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
  args: ["--use-gl=angle", "--use-angle=metal", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, permissions: ["microphone"], acceptDownloads: true });
const page = await context.newPage(), errors = [], requests = [], report = { checks: [], visualRegression: "INCONCLUSIVE: no committed baseline", accessibility: null };
const url = `${process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/"}${(process.env.BLOOD_BASE_URL ?? "").includes("?") ? "&" : "?"}mode=blood`;
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
page.on("response", response => { if (response.status() >= 400) requests.push({ url: response.url(), status: response.status() }); });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const check = (name, details = {}) => report.checks.push({ name, status: "PASS", ...details });
const download = async (locator, filename) => {
  const pending = page.waitForEvent("download"); await locator.click(); const file = await pending;
  const target = path.join(out, filename ?? file.suggestedFilename()); await file.saveAs(target); return target;
};
try {
  await page.goto(url);
  await expect(page.getByRole("button", { name: "Run fluid", exact: true })).toBeEnabled({ timeout: 60000 });
  await expect(page.getByRole("heading", { name: "Blood flow laboratory." })).toBeVisible();
  check("WebGPU initialized");
  await page.screenshot({ path: path.join(out, "desktop-initial.png"), fullPage: true });
  const font = () => page.locator(".blood-controls label").first().evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  const small = await font();
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page.getByRole("button", { name: "200%", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const large = await font(); expect(large / small).toBeCloseTo(2, 1);
  check("Parameter text scales to 200%", { beforePX: small, afterPX: large });
  await page.screenshot({ path: path.join(out, "desktop-text-200.png"), fullPage: true });
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 1050 });
    const widths = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.viewport + 1);
    // Global overflow:hidden can hide clipped controls without increasing scrollWidth.
    for (const name of ["Display settings", "Video recorder"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    }
    await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
    check(`No horizontal overflow at ${width}px and 200% text`, widths);
    // The parent Studio shell hides page overflow. Prove users can wheel-scroll
    // the lab itself; programmatic scrollIntoView alone could mask this defect.
    await page.mouse.move(width - 10, 600); await page.mouse.wheel(0, 20000);
    await expect(page.getByRole("link", { name: "Read the constitutive source ↗" })).toBeInViewport();
    await page.screenshot({ path: path.join(out, `footer-${width}-text200.png`) });
    await page.mouse.wheel(0, -20000);
    await expect(page.getByRole("link", { name: "Anatomy studio" })).toBeInViewport();
    check(`Mouse-wheel access to lower content at ${width}px`);
  }
  await page.getByRole("button", { name: "Display settings", exact: true }).click();
  await page.getByRole("button", { name: "Reset display preferences", exact: true }).click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  const stage = page.getByRole("region", { name: "Blood flow scene" });
  const beforeHeight = (await stage.boundingBox()).height;
  await page.getByRole("separator", { name: "Resize scene height" }).focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await stage.boundingBox()).height).toBeGreaterThan(beforeHeight);
  check("Keyboard scene height resizing");
  await page.getByRole("button", { name: "Scene full screen", exact: true }).click();
  await expect(page.getByRole("button", { name: "Exit scene full screen" })).toBeVisible();
  await page.getByRole("button", { name: "Exit scene full screen" }).click();
  check("Fullscreen enter/exit");
  await page.getByLabel("Rendering", { exact: true }).selectOption("particles");
  await page.getByLabel("Particle colour", { exact: true }).selectOption("speed");
  const canvas = page.locator(".blood-stage canvas");
  await canvas.focus(); await page.keyboard.press("ArrowRight"); await page.keyboard.press("+"); await page.keyboard.press("Home");
  await page.getByLabel("Rendering", { exact: true }).selectOption("surface");
  check("Surface/particle modes, speed colours and keyboard camera");
  await page.getByRole("button", { name: "Run fluid", exact: true }).click();
  await expect.poll(async () => Number(await page.getByTestId("blood-steps").textContent()), { timeout: 60000 }).toBeGreaterThan(5);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForTimeout(500);
  const steps = await page.getByTestId("blood-steps").textContent();
  await page.waitForTimeout(500); expect(await page.getByTestId("blood-steps").textContent()).toBe(steps);
  const exportPath = await download(page.getByRole("button", { name: "Export accepted state + report" }), "accepted-state.json");
  const state = JSON.parse(await fs.readFile(exportPath, "utf8"));
  expect(state.acceptedStep).toBeGreaterThan(5); expect(state.acceptedState.length).toBe(512 * 8);
  check("Run, pause and accepted-state export", { steps: state.acceptedStep });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run fluid", exact: true })).toBeEnabled({ timeout: 60000 });
  await expect(page.getByTestId("blood-steps")).toHaveText("0");
  check("Reset returns to zero accepted time");
  // Exercise the shared native WebGPU capture adapter with synthetic audio only.
  for (const quality of [{ name: "HD · 1280 × 720", id: "hd", width: 1280, height: 720, audio: true },
    { name: "4K · 3840 × 2160", id: "4k", width: 3840, height: 2160, audio: false }]) {
    console.log(`Recording ${quality.id}`);
    await page.getByRole("button", { name: "Video recorder", exact: true }).click();
    const another = page.getByRole("button", { name: "Record another", exact: true });
    if (await another.isVisible()) await another.click();
    await page.getByRole("radio", { name: quality.name, exact: true }).check();
    await page.getByLabel("Recording frame rate").selectOption("30");
    await page.getByLabel("Record microphone audio").setChecked(quality.audio);
    if (quality.audio) {
      await page.getByRole("button", { name: /Allow microphone access|Refresh microphones/ }).click();
      await expect(page.getByLabel("Microphone", { exact: true })).toBeEnabled();
    }
    await page.getByRole("button", { name: "Start recording", exact: true }).click();
    // Starting capture closes the modal automatically.
    await expect(page.getByRole("button", { name: "Stop video recording", exact: true })).toBeVisible({ timeout: 30000 });
    await expect(canvas).toHaveAttribute("width", String(quality.width));
    await expect(canvas).toHaveAttribute("height", String(quality.height));
    await page.getByRole("button", { name: "Run fluid", exact: true }).click();
    await page.waitForTimeout(4000);
    await canvas.focus(); await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Pause video recording" }).click();
    await page.waitForTimeout(250);
    await page.getByRole("button", { name: "Resume video recording" }).click();
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "Stop video recording" }).click();
    await expect(page.getByRole("region", { name: "Finished recording" })).toBeVisible({ timeout: 60000 });
    const movie = await download(page.getByRole("link", { name: /Download (MP4|WEBM)/ }));
    const detailsPath = await download(page.getByRole("button", { name: "Capture details" }), `${quality.id}-capture.json`);
    check(`Native ${quality.id} recording`, { file: path.basename(movie), metadata: JSON.parse(await fs.readFile(detailsPath, "utf8")), fakeMicrophone: quality.audio });
    await page.getByRole("button", { name: "Close video recorder" }).click();
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    if (await pause.isVisible()) await pause.click();
    await page.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(page.getByRole("button", { name: "Run fluid", exact: true })).toBeEnabled({ timeout: 60000 });
  }
  try {
    const require = createRequire(import.meta.url);
    await page.addScriptTag({ path: process.env.AXE_SCRIPT ?? require.resolve("axe-core/axe.min.js") });
    report.accessibility = await page.evaluate(async () => {
      const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] } });
      return { violations: result.violations, incomplete: result.incomplete.map(item => ({ id: item.id, nodes: item.nodes.length })), passes: result.passes.length };
    });
    expect(report.accessibility.violations).toEqual([]);
  } catch (error) { report.accessibility ??= { status: "NOT_RUN", reason: String(error) }; throw error; }
  const unsupported = await context.newPage();
  await unsupported.addInitScript(() => Object.defineProperty(navigator, "gpu", { value: undefined }));
  await unsupported.goto(url);
  await expect(unsupported.getByRole("alert")).toContainText("needs WebGPU");
  await expect(unsupported.getByRole("link", { name: "Anatomy studio" })).toBeVisible();
  await unsupported.close(); check("Unsupported WebGPU has actionable fallback");
  expect(errors).toEqual([]); expect(requests).toEqual([]);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error);
  await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true }).catch(() => {});
  process.exitCode = 1; console.error(error);
} finally {
  await fs.writeFile(path.join(out, "qa.json"), JSON.stringify({ ...report, errors, failedRequests: requests }, null, 2));
  await browser.close();
}
