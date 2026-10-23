#!/usr/bin/env node
// Focused visual evidence for the liver blood film's 3D liquid appearance:
// cut the first target vessel, let blood flow, and capture overview, close-up,
// grazing and operating-light views plus a video of the flowing surface.
import { chromium } from "playwright";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, timeout = 30000, label = "condition") {
  const end = Date.now() + timeout;
  for (;;) { try { if (await predicate()) return; } catch {} if (Date.now() > end) throw new Error(`Timed out: ${label}`); await sleep(150); }
}
const expect = target => ({
  toBeEnabled: ({ timeout } = {}) => until(() => target.isEnabled(), timeout, "enabled"),
  toBeVisible: ({ timeout } = {}) => until(() => target.isVisible(), timeout, "visible"),
  toContainText: (text, { timeout } = {}) => until(async () => (await target.textContent()).includes(text), timeout, `text ${text}`),
});
expect.poll = (fn, { timeout } = {}) => ({ toBeGreaterThanOrEqual: v => until(async () => (await fn()) >= v, timeout, `>= ${v}`) });
import fs from "node:fs/promises";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ?? path.join(root, "artifacts/liver-blood-relief"));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
await fs.mkdir(path.join(out, "video"), { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  args: ["--use-gl=angle", "--use-angle=metal", "--enable-unsafe-webgpu"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true,
  recordVideo: { dir: path.join(out, "video"), size: { width: 1440, height: 1050 } } });
const page = await context.newPage();
const errors = [];
page.setDefaultTimeout(30000);
page.on("pageerror", error => errors.push(String(error)));
page.on("console", message => { if (message.type() === "error") errors.push(`${message.type()}: ${message.text()}`); });
const button = name => page.getByRole("button", { name, exact: true });
const frames = (n = 2) => page.evaluate(n => new Promise(resolve => { let i = 0; const f = () => ++i >= n ? resolve() : requestAnimationFrame(f); requestAnimationFrame(f); }), n);
const stage = page.getByRole("region", { name: "Liver bleeding scene" });
const shot = async name => { await stage.screenshot({ path: path.join(out, `${name}.png`) }); console.log("shot", name); };
const atTime = async t => { await expect.poll(async () => parseFloat(await page.getByTestId("liver-time").textContent()), { timeout: 180000 }).toBeGreaterThanOrEqual(t); };
try {
  const url = new URL(base); url.searchParams.set("mode", "blood"); url.searchParams.set("flow", "liver");
  await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 180000 });
  await expect(button("Run bleeding")).toBeEnabled({ timeout: 120000 });
  await page.getByLabel("Liver playback speed", { exact: true }).selectOption("2");
  await page.getByLabel("Cut depth", { exact: true }).evaluate(el => { el.value = "2"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); });
  await button("Show target").click(); await frames(3);
  await page.getByRole("button", { name: "Cut selected vessel" }).click(); await frames(2);
  await expect(page.getByTestId("liver-wounds")).toContainText("1 vessel hits");
  await expect(button("Pause bleeding")).toBeVisible();
  await page.mouse.move(10, 10);
  await atTime(1); await shot("r01-flow-1s");
  await atTime(2.5); await shot("r02-flow-2.5s");
  await atTime(4); await shot("r03-flow-4s");
  await button("Pause bleeding").click(); await frames(3);
  await button("Show target").click(); await frames(3); await shot("r04-closeup");
  const canvas = page.locator(".liver-canvas-host canvas"), box = await canvas.boundingBox();
  // Zoom in further, then orbit to a grazing angle where relief and highlights read.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -240); await frames(2); }
  await shot("r05-macro");
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 140, { steps: 10 }); await page.mouse.up(); await frames(3);
  await shot("r06-grazing");
  await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 220, box.y + box.height / 2 - 140, { steps: 10 }); await page.mouse.up(); await frames(3);
  await shot("r07-side");
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("operating"); await frames(4);
  await shot("r08-operating");
  await page.getByLabel("Liver lighting", { exact: true }).selectOption("camera");
  await button("Show target").click(); await frames(3);
  for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, -240); await frames(2); }
  await button("Run bleeding").click();
  await page.waitForTimeout(6000);
  await shot("r09-running-macro");
} catch (error) {
  console.error("FAILED", error); await page.screenshot({ path: path.join(out, "zz-failure.png") }).catch(() => {}); process.exitCode = 1;
} finally {
  console.log("errors:", errors.length); for (const e of errors.slice(0, 10)) console.log("  ", e.slice(0, 400));
  await context.close(); await browser.close();
}

