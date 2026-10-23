#!/usr/bin/env node
// Browser evidence for the blood model selector, the liver cut-preview UX and the
// WebGPU blood pool. Captures screenshots + a video for visual assessment.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/blood-pool-cut-ux-2026-10-21"));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
await fs.mkdir(path.join(out, "video"), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true,
  recordVideo: { dir: path.join(out, "video"), size: { width: 1440, height: 1050 } } });
const page = await context.newPage();
const checks = [], errors = [];
page.setDefaultTimeout(30000);
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error" || message.type() === "warning") errors.push(`${message.type()}: ${message.text()}`); });
await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
const check = (name, details = {}) => { checks.push({ name, status: "PASS", ...details }); console.log("PASS", name, Object.keys(details).length ? JSON.stringify(details) : ""); };
const button = name => page.getByRole("button", { name, exact: true });
const frames = (n = 2) => page.evaluate(n => new Promise(resolve => { let i = 0; const f = () => ++i >= n ? resolve() : requestAnimationFrame(f); requestAnimationFrame(f); }), n);
const shot = async (name, locator) => { const file = path.join(out, `${name}.png`); await (locator ?? page).screenshot({ path: file }); console.log("shot", name); return file; };
async function slider(label, value) { const el = page.getByLabel(label, { exact: true }); const { min, step } = await el.evaluate(e => ({ min: Number(e.min), step: Number(e.step) }));
  await el.focus(); await el.press("Home"); for (let i = 0; i < Math.round((value - min) / step); i++) await el.press("ArrowRight"); await expect(el).toHaveValue(String(value)); }
const download = async (locator, name) => { const pending = page.waitForEvent("download"); await locator.click(); const item = await pending; const file = path.join(out, name); await item.saveAs(file); return JSON.parse(await fs.readFile(file, "utf8")); };

try {
  // ---------- Model selector ----------
  const liverUrl = new URL(base); liverUrl.searchParams.set("mode", "blood"); liverUrl.searchParams.set("flow", "liver");
  await page.goto(liverUrl.href, { waitUntil: "domcontentloaded", timeout: 180000 });
  const nav = page.getByRole("navigation", { name: "Blood lab workspaces" });
  await expect(nav).toBeVisible({ timeout: 180000 });
  await expect(page.getByLabel("Fluid simulation model", { exact: true })).toHaveValue("liver");
  await expect(page.getByLabel("Active fluid simulation model", { exact: true })).toHaveValue("liver");
  for (const name of ["Liver bleeding", "Blood pool", "Free-surface fluid", "Artery flow playground", "Thin-film wetting", "Blood experiments"]) await expect(nav.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Liver bleeding", exact: true })).toHaveAttribute("aria-pressed", "true");
  check("Model selector exposes all six models in top dropdown, sidebar dropdown, and workspace cards");
  await button("Compare models").click();
  await expect(page.getByRole("table")).toBeVisible();
  await shot("01-model-selector-compare", page.locator(".blood-model-selector"));
  await button("Hide comparison").click();

  // ---------- Liver cut UX ----------
  const stage = page.getByRole("region", { name: "Liver bleeding scene" }), canvas = page.locator(".liver-canvas-host canvas");
  await expect(button("Run bleeding")).toBeEnabled({ timeout: 90000 });
  await shot("02-liver-ready", stage);
  const exported = async name => download(button("Export experiment evidence"), name);
  async function targetPoint(index = 0) {
    const select = page.getByLabel("Vessel target", { exact: true });
    const id = await select.evaluate((el, i) => el.options[i].value, index);
    await select.selectOption(id); await button("Show target").click(); await frames(3);
    const state = await exported(`target-${index}.json`), box = await canvas.boundingBox();
    const t = state.renderer.projectedTargets.find(t => t.id === id); expect(t?.visible).toBe(true);
    await canvas.scrollIntoViewIfNeeded(); const after = await canvas.boundingBox();
    return { x: t.clientX + after.x - box.x, y: t.clientY + after.y - box.y, state };
  }
  await page.keyboard.press("c"); // shortcut → Cut tool
  await expect(button("Cut")).toHaveAttribute("aria-pressed", "true");
  check("Keyboard shortcut C selects the cut tool");
  const hud = page.getByTestId("liver-cut-preview");
  await expect(hud).toHaveAttribute("data-status", /idle|vessel|deeper|tissue/);
  await slider("Cut depth", .25);
  let p = await targetPoint(0);
  await page.mouse.move(p.x + 1, p.y); await page.mouse.move(p.x, p.y); await frames(3);
  const shallow = await hud.getAttribute("data-status");
  await shot("03-cut-preview-shallow", stage);
  check("Hover preview at 0.25 mm depth", { status: shallow, text: (await hud.innerText()).replace(/\s+/g, " ") });
  if (shallow === "deeper") {
    await hud.getByRole("button", { name: /Set depth to/ }).click();
    await page.mouse.move(p.x + 1, p.y); await page.mouse.move(p.x, p.y); await frames(3);
    await expect(hud).toHaveAttribute("data-status", "vessel");
    check("Suggested depth turns the preview into a vessel hit", { depth: await page.getByLabel("Cut depth", { exact: true }).inputValue() });
  } else {
    await slider("Cut depth", 1.25); await page.mouse.move(p.x + 1, p.y); await page.mouse.move(p.x, p.y); await frames(3);
  }
  await shot("04-cut-preview-vessel", stage);
  // Off-vessel point for the tissue state.
  for (const [dx, dy] of [[90, 60], [-90, 60], [90, -60], [-90, -60], [0, 110]]) {
    await page.mouse.move(p.x + dx, p.y + dy); await frames(3);
    if (await hud.getAttribute("data-status") === "tissue") break;
  }
  await shot("05-cut-preview-tissue", stage);
  check("Off-vessel hover preview", { status: await hud.getAttribute("data-status"), text: (await hud.innerText()).replace(/\s+/g, " ") });
  // Right-drag rotates and the wheel zooms while the cut tool stays active; neither cuts.
  const before = await exported("cut-orbit-before.json");
  await page.mouse.move(p.x, p.y); await page.mouse.down({ button: "right" }); await page.mouse.move(p.x + 60, p.y + 20, { steps: 6 }); await page.mouse.up({ button: "right" });
  await page.mouse.wheel(0, -200); await frames(3);
  const after = await exported("cut-orbit-after.json");
  expect(after.snapshot.wounds.length).toBe(before.snapshot.wounds.length);
  expect(after.renderer.cameraQuaternion).not.toEqual(before.renderer.cameraQuaternion);
  await expect(button("Cut")).toHaveAttribute("aria-pressed", "true");
  check("Right-drag orbit and wheel zoom work in cut mode without cutting");
  // Commit the predicted vessel cut.
  p = await targetPoint(0);
  await page.mouse.move(p.x, p.y); await frames(2);
  await expect(hud).toHaveAttribute("data-status", "vessel");
  await page.mouse.click(p.x, p.y); await frames(2);
  await expect(page.getByTestId("liver-wounds")).toContainText("1 / 3 incisions · 1 vessel hits");
  check("Predicted vessel cut commits as a vessel hit");
  const atTime = async t => { await expect.poll(async () => parseFloat(await page.getByTestId("liver-time").textContent()), { timeout: 120000 }).toBeGreaterThanOrEqual(t); };
  await expect(button("Pause bleeding")).toBeVisible();
  await page.mouse.move(20, 20);
  await atTime(1); await shot("06-bleeding-1s", stage);
  await atTime(3); await shot("07-bleeding-3s", stage);
  await atTime(5); await button("Pause bleeding").click(); await frames(2);
  await shot("08-bleeding-5s", stage);
  await button("Show target").click(); await frames(3); await shot("09-bleeding-5s-closeup", stage);
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("operating"); await frames(4);
  await shot("10-bleeding-5s-operating-light", stage);
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("camera");
  // Undo: a tissue cut while paused can be undone because no time has run.
  const wounds = page.getByTestId("liver-wounds");
  await button("Show target").click(); await frames(3);
  { const cb = await canvas.boundingBox(); p = { x: cb.x + cb.width / 2, y: cb.y + cb.height / 2 }; }
  let undone = false;
  for (const [dx, dy] of [[120, 80], [-120, 80], [120, -80], [-120, -80], [0, 140], [0, -140]]) {
    await page.mouse.move(p.x + dx, p.y + dy); await frames(2);
    const status = await hud.getAttribute("data-status");
    if (status !== "tissue" && status !== "deeper") continue;
    await page.mouse.click(p.x + dx, p.y + dy); await frames(2);
    if (!(await wounds.textContent()).startsWith("2 / 3")) continue;
    await expect(button("Undo cut")).toBeEnabled();
    await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z"); await frames(2);
    await expect(wounds).toContainText("1 / 3 incisions"); undone = true; break;
  }
  check("Undo removes an incision made while paused", { exercised: undone });
  await shot("11-liver-controls", page.getByRole("complementary", { name: "Liver experiment controls" }));
  // Keyboard depth step.
  await page.mouse.move(20, 20); const depthBefore = Number(await page.getByLabel("Cut depth", { exact: true }).inputValue());
  await page.locator("body").click({ position: { x: 5, y: 5 } }); await page.keyboard.press("[");
  await expect(page.getByLabel("Cut depth", { exact: true })).toHaveValue(String(Math.max(.25, depthBefore - .25)));
  check("[ shortcut reduces cut depth by one step");

  // ---------- Blood pool ----------
  await page.getByRole("navigation", { name: "Blood lab workspaces" }).getByRole("button", { name: "Blood pool", exact: true }).click();
  await expect(page).toHaveURL(/flow=pool/);
  const pool = page.getByRole("region", { name: "Blood pool scene" });
  await expect(button("Run pool")).toBeEnabled({ timeout: 60000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  check("Blood pool initialises WebGPU");
  await shot("12-pool-ready", pool);
  await button("Run GPU/CPU parity check").click();
  await expect(page.getByTestId("pool-parity")).toBeVisible({ timeout: 60000 });
  const parity = await page.getByTestId("pool-parity").innerText();
  expect(parity).toMatch(/^PASS/);
  check("GPU/CPU parity", { parity });
  await slider("Fall height", 4);
  const poolCanvas = pool.locator("canvas");
  const at = async (fx, fy) => { await pool.scrollIntoViewIfNeeded(); const b = await poolCanvas.boundingBox(); return { x: b.x + b.width * fx, y: b.y + b.height * fy }; };
  for (const [fx, fy] of [[.5, .54], [.41, .50], [.59, .58], [.48, .47]]) { const q = await at(fx, fy); await page.mouse.click(q.x, q.y); await page.waitForTimeout(160); }
  await page.waitForTimeout(180); await shot("13-pool-whole-drops", pool);
  await page.getByLabel("Pool fluid", { exact: true }).selectOption("irrigated");
  for (const [fx, fy] of [[.5, .54], [.44, .51], [.56, .57]]) { const q = await at(fx, fy); await page.mouse.click(q.x, q.y); await page.waitForTimeout(150); }
  await page.waitForTimeout(180); await shot("14-pool-irrigated-drops", pool);
  await page.getByLabel("Pool fluid", { exact: true }).selectOption("wash");
  for (const [fx, fy] of [[.5, .54], [.43, .51], [.57, .56]]) { const q = await at(fx, fy); await page.mouse.click(q.x, q.y); await page.waitForTimeout(150); }
  await page.waitForTimeout(180); await shot("15-pool-wash-caustics", pool);
  await button("Probe").click();
  let q = await at(.32, .54); await page.mouse.move(q.x, q.y); await page.mouse.down();
  for (let i = 0; i <= 28; i++) { q = await at(.32 + .36 * i / 28, .54 + .09 * Math.sin(i / 4)); await page.mouse.move(q.x, q.y); await page.waitForTimeout(22); }
  await shot("16-pool-probe-wake", pool); await page.mouse.up();
  await page.getByLabel("Pool fluid", { exact: true }).selectOption("whole");
  await page.getByLabel("Drip rate", { exact: true }).evaluate(el => { el.value = "6"; el.dispatchEvent(new Event("change", { bubbles: true })); el.dispatchEvent(new Event("input", { bubbles: true })); });
  await button("Drip").click(); q = await at(.5, .53); await page.mouse.click(q.x, q.y);
  await page.getByText("Continuous drip at the last clicked point").click();
  await page.waitForTimeout(1800); await shot("17-pool-continuous-drip", pool);
  await button("Top view").click(); await page.waitForTimeout(500); await shot("18-pool-top-view", pool);
  await button("Pause pool").click();
  const evidence = await download(button("Export pool evidence"), "pool-evidence.json");
  check("Pool evidence export", { drops: evidence.telemetry.drops, timeSeconds: evidence.telemetry.timeSeconds, volumeError: evidence.telemetry.readback?.relativeVolumeError, validity: evidence.telemetry.validity?.status });
  await page.evaluate(() => window.scrollTo(0, 0)); await frames(2);
  await shot("19-pool-page", page);
} catch (error) {
  console.error("FAILED", error); await shot("zz-failure", page).catch(() => {}); process.exitCode = 1;
} finally {
  const relevant = errors.filter(e => !/Download the React DevTools|favicon|\[vite\]/.test(e));
  await fs.writeFile(path.join(out, "report.json"), JSON.stringify({ checks, consoleErrors: relevant }, null, 2));
  console.log("console errors/warnings:", relevant.length); for (const e of relevant.slice(0, 20)) console.log("  ", e.slice(0, 300));
  await context.close(); await browser.close();
}
