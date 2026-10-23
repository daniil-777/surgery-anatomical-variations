#!/usr/bin/env node
// Development-only native UI fault injection. Run alone on the GPU against
// Vite; no product module imports this script and no test hook enters the UI.
import { chromium, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { capturePublicBuildSources } from "./stage_public_assets.mjs";

const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(process.env.BLOOD_EVIDENCE ??
  path.join(root, "artifacts/liver-bleeding-2026-10-20", `failure-paths-${Date.now()}`));
const base = new URL(process.env.BLOOD_BASE_URL ?? "http://127.0.0.1:5174/");
const url = new URL(base); url.searchParams.set("mode", "blood"); url.searchParams.set("flow", "liver");
await fs.mkdir(out, { recursive: false });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) => fs.writeFile(path.join(out, name),
  `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const report = { schema: "viscera.liver-ui-failure-paths/v1", status: "RUNNING",
  startedAt: new Date().toISOString(), url: url.href, checks: [], errors: [], failedRequests: [],
  expectedFaults: [], injectionObservations: [], sourceIdentity: {}, performanceClaim: false, visualRealismCertified: false };
let browser, page;
const loadedModuleURLs = new Map([
  ["/src/blood/liver/renderer.ts", new Set()],
  ["/src/blood/liver/liverFlow.ts", new Set()],
  ["/src/sceneRecordingSource.ts", new Set()],
]);
const liveModuleURL = pathname => {
  const urls = loadedModuleURLs.get(pathname);
  if (urls?.size !== 1) throw new Error(`Expected one live module identity for ${pathname}, found ${urls?.size ?? 0}`);
  return [...urls][0];
};
const bounded = async (promise, milliseconds, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
};
const sources = () => capturePublicBuildSources(root);
const button = name => page.getByRole("button", { name, exact: true });
const canvas = () => page.locator(".liver-canvas-host canvas");
const check = (name, details = {}) => {
  report.checks.push({ name, status: "PASS", ...details }); console.log(name);
};
const exported = async name => {
  const pending = page.waitForEvent("download");
  await button("Export experiment evidence").click();
  const item = await pending, location = path.join(out, name);
  // Every evidence name is fixed and unique. Explicitly refuse overwrite.
  try { await fs.access(location); throw new Error(`Evidence already exists: ${name}`); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  await item.saveAs(location);
  const bytes = await fs.readFile(location);
  const value = JSON.parse(bytes);
  expect(value.schema).toBe("viscera.liver-bleeding.evidence/v1");
  expect(value.snapshot.timeSeconds).toBe(value.execution.acceptedTimeSeconds);
  expect(Number.isFinite(value.snapshot.coupledVolumeErrorM3)).toBe(true);
  expect(Math.abs(value.snapshot.coupledVolumeErrorM3)).toBeLessThanOrEqual(value.snapshot.initialInventoryM3 * 1e-9);
  return { value, file: name, sha256: hash(bytes) };
};
const ready = async () => {
  await expect(button("Run bleeding")).toBeEnabled({ timeout: 90_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(canvas()).toHaveCount(1);
};
const reset = async name => {
  const previous = await canvas().elementHandle();
  expect(previous).toBeTruthy();
  await page.getByRole("button", { name: /^(Clear cuts & reset|Apply & reset liver)$/ }).click();
  await expect.poll(() => previous.evaluate(element => element.isConnected)).toBe(false);
  await ready();
  const registryURL = liveModuleURL("/src/sceneRecordingSource.ts");
  expect(await previous.evaluate(async (element, moduleURL) =>
    Boolean((await import(moduleURL)).getSceneRecordingSource(element)), registryURL)).toBe(false);
  await previous.dispose();
  const result = await exported(name);
  expect(result.value.execution.phase).toBe("paused");
  expect(result.value.execution.error).toBeNull();
  expect(result.value.snapshot.timeSeconds).toBe(0);
  expect(result.value.snapshot.wounds).toEqual([]);
  expect(result.value.renderer.woundCount).toBe(0);
  expect(await canvas().evaluate(async (element, moduleURL) =>
    Boolean((await import(moduleURL)).getSceneRecordingSource(element)), registryURL)).toBe(true);
  return result.value;
};
const inject = async kind => {
  // Vite appends ?t=... to modules invalidated by edits. An unversioned import
  // creates a second ESM class and silently patches the wrong prototype.
  // Use exactly the module URLs loaded by this fresh UI; ambiguous identities
  // fail rather than guessing which class owns the live scene.
  const moduleURLs = {};
  for (const pathname of loadedModuleURLs.keys()) moduleURLs[pathname] = liveModuleURL(pathname);
  return page.evaluate(async ({ kind, moduleURLs }) => {
    if (window.__liverFailureInjection) throw new Error("A previous failure injection was not restored");
    const [{ LiverRenderer }, { LiverFlowExperiment }] = await Promise.all([
      import(moduleURLs["/src/blood/liver/renderer.ts"]), import(moduleURLs["/src/blood/liver/liverFlow.ts"]),
    ]);
    const prototype = kind === "model-before-commit" ? LiverFlowExperiment.prototype : LiverRenderer.prototype;
    const method = kind === "update-after-commit" ? "update" : "setWounds";
    const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("Expected public prototype method is absent");
    const original = descriptor.value, message = `VISCERA_TEST_INJECTED_${kind}`;
    const injection = { kind, method, message, moduleURLs, calls: 0, injected: 0,
      restore: () => {
        Object.defineProperty(prototype, method, descriptor);
        delete window.__liverFailureInjection;
      } };
    Object.defineProperty(prototype, method, { ...descriptor, value: function (...args) {
      injection.calls++;
      const wounds = method === "update" ? args[0]?.wounds : args[0];
      if (!injection.injected && Array.isArray(wounds) && wounds.length > 0) {
        injection.injected++;
        if (kind === "graphics-after-swap") original.apply(this, args);
        throw new Error(message);
      }
      return original.apply(this, args);
    } });
    window.__liverFailureInjection = injection;
    return { kind, method, message, moduleURLs };
  }, { kind, moduleURLs });
};
const injectionState = () => page.evaluate(() => {
  const state = window.__liverFailureInjection;
  return state ? { kind: state.kind, calls: state.calls, injected: state.injected, moduleURLs: state.moduleURLs } : null;
});
const restoreInjection = async () => {
  if (page && !page.isClosed()) {
    const state = await injectionState();
    if (state) report.injectionObservations.push(state);
    await page.evaluate(() => window.__liverFailureInjection?.restore());
  }
};
const assertInjected = async () => {
  await expect.poll(async () => (await injectionState())?.injected,
    { message: "The fault must fire on the live UI instance before its error handling is tested" }).toBe(1);
};
const screenshot = name => page.getByRole("region", { name: "Liver bleeding scene", exact: true })
  .screenshot({ path: path.join(out, name) });
const assertHalted = async () => {
  await expect(page.getByRole("alert")).toContainText("Experiment paused");
  await expect(button("Run bleeding")).toBeDisabled();
  await expect(button("Cut selected vessel")).toBeDisabled();
  await expect(button("Export experiment evidence")).toBeEnabled();
};

try {
  if (process.platform !== "darwin") throw new Error("This native Chrome/Metal gate targets macOS");
  report.sourceIdentity.before = sources();
  report.sourceIdentity.scriptSHA256 = hash(await fs.readFile(import.meta.filename));
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    args: ["--use-gl=angle", "--use-angle=metal"] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1050 },
    deviceScaleFactor: 1, acceptDownloads: true, serviceWorkers: "block" });
  page.setDefaultTimeout(30_000);
  // The injected exceptions must be handled by the application. An uncaught
  // injection is a failure too; no broad message filtering hides real errors.
  page.on("pageerror", error => report.errors.push({ type: "pageerror", message: String(error) }));
  page.on("console", message => {
    if (message.type() === "error") report.errors.push({ type: "console", message: message.text() });
  });
  page.on("requestfailed", request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on("response", response => {
    if (response.status() >= 400) report.failedRequests.push({ url: response.url(), status: response.status() });
    const parsed = new URL(response.url());
    if (parsed.origin === base.origin && response.ok())
      loadedModuleURLs.get(parsed.pathname)?.add(response.url());
  });
  await page.route("**/favicon.ico", route => route.fulfill({ status: 204 }));
  await page.goto(url.href, { waitUntil: "networkidle", timeout: 90_000 }); await ready();
  await page.getByLabel("Run automatically after a vessel cut", { exact: true }).uncheck();
  const initial = (await exported("initial.json")).value;
  expect(initial.targets.length).toBeGreaterThan(0);
  await page.getByLabel("Vessel target", { exact: true }).selectOption(initial.targets[0].id);
  await button("Show target").click();
  expect(initial.cutSettings).toEqual({ radiusMM: 1.25, depthMM: 1 });
  report.graphics = await canvas().evaluate(element => {
    const gl = element.getContext("webgl2"), debug = gl?.getExtension("WEBGL_debug_renderer_info");
    return { available: Boolean(gl), renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) };
  });
  expect(report.graphics.available).toBe(true);
  expect(report.graphics.renderer).not.toMatch(/SwiftShader|llvmpipe|software rasterizer/i);

  // A: graphics has already changed, but no physical intervention may commit.
  const graphicsFault = await inject("graphics-after-swap");
  try {
    await button("Cut selected vessel").click(); await assertInjected(); await assertHalted();
    await expect(page.getByRole("alert")).toContainText(graphicsFault.message);
    const failed = (await exported("graphics-failure-export.json")).value;
    expect(failed.execution.phase).toBe("halted"); expect(failed.execution.error).toBeTruthy();
    expect(failed.snapshot).toEqual(initial.snapshot);
    expect(failed.interventions).toEqual(initial.interventions);
    expect(failed.renderer.woundCount).toBe(1); // Untrusted display is explicitly halted.
    expect((await injectionState()).injected).toBe(1);
    await screenshot("graphics-failure.png");
    report.expectedFaults.push({ ...graphicsFault, observedUIError: failed.execution.error });
    check("Graphics failure after a surface swap halts before physical commit and preserves an exportable accepted state");
  } finally { await restoreInjection(); }
  const modelBaseline = await reset("after-graphics-reset.json");
  check("Reset removes the failed canvas/recording source and recovers exactly one live renderer");

  // B: the model rejects before mutation; graphics must return to its baseline.
  const modelFault = await inject("model-before-commit");
  try {
    await button("Cut selected vessel").click(); await assertInjected(); await ready();
    await expect(page.locator(".liver-feedback")).toContainText(modelFault.message);
    const rejected = (await exported("model-rejection-export.json")).value;
    expect(rejected.execution.phase).toBe("paused"); expect(rejected.execution.error).toBeNull();
    expect(rejected.snapshot).toEqual(modelBaseline.snapshot);
    expect(rejected.interventions).toEqual(modelBaseline.interventions);
    expect(rejected.renderer.woundCount).toBe(0);
    expect(rejected.renderer.removedAreaM2).toBe(modelBaseline.renderer.removedAreaM2);
    expect(rejected.renderer.retainedSurfaceTriangles).toBe(modelBaseline.renderer.retainedSurfaceTriangles);
    expect((await injectionState()).injected).toBe(1);
    await screenshot("model-rejection.png");
    // The one-shot fault has fired. An actual second UI action must still work.
    await button("Cut selected vessel").click(); await ready();
    const retry = (await exported("model-rejection-retry.json")).value;
    expect(retry.snapshot.wounds).toHaveLength(1); expect(retry.snapshot.wounds[0].vesselId).toBeTruthy();
    expect(retry.renderer.woundCount).toBe(1); expect(retry.interventions).toHaveLength(1);
    expect(retry.snapshot.timeSeconds).toBe(0);
    report.expectedFaults.push({ ...modelFault, observedUIError: modelFault.message });
    check("Precommit physics rejection restores graphics and accepted state; the next UI incision remains usable");
  } finally { await restoreInjection(); }
  const updateBaseline = await reset("after-model-reset.json");

  // C: setWounds committed physically; a later failed display update must not
  // invent a rollback or lose the accepted wound in the forensic export.
  const updateFault = await inject("update-after-commit");
  try {
    await button("Cut selected vessel").click(); await assertInjected(); await assertHalted();
    await expect(page.getByRole("alert")).toContainText(updateFault.message);
    const failed = (await exported("committed-cut-render-failure.json")).value;
    expect(failed.execution.phase).toBe("halted"); expect(failed.execution.error).toBe(updateFault.message);
    expect(failed.snapshot.wounds).toHaveLength(1); expect(failed.snapshot.wounds[0].vesselId).toBeTruthy();
    expect(failed.snapshot.timeSeconds).toBe(updateBaseline.snapshot.timeSeconds);
    expect(failed.snapshot.cardiovascular).toEqual(updateBaseline.snapshot.cardiovascular);
    expect(failed.interventions).toHaveLength(1); expect(failed.interventions[0].wound.id).toBe(failed.snapshot.wounds[0].id);
    expect(failed.renderer.woundCount).toBe(1);
    expect((await injectionState()).injected).toBe(1);
    const repeated = (await exported("committed-cut-render-failure-repeat.json")).value;
    expect(repeated.snapshot).toEqual(failed.snapshot);
    await screenshot("committed-cut-render-failure.png");
    report.expectedFaults.push({ ...updateFault, observedUIError: failed.execution.error });
    check("Display failure after a physical incision halts input and exports the committed wound without advancing time");
  } finally { await restoreInjection(); }
  await reset("final-recovered.json");
  expect(await injectionState()).toBeNull();
  expect(report.errors).toEqual([]); expect(report.failedRequests).toEqual([]);
  report.sourceIdentity.after = sources();
  expect(report.sourceIdentity.after).toEqual(report.sourceIdentity.before);
  report.status = "PASS";
} catch (error) {
  report.status = "FAIL"; report.error = String(error.stack ?? error);
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: path.join(out, "failure.png"), fullPage: true, timeout: 10_000 }); }
    catch (captureError) { report.failureCaptureError = String(captureError); }
  }
} finally {
  try { await bounded(restoreInjection(), 10_000, "Restoring fault-injection prototypes"); }
  catch (error) { report.status = "FAIL"; report.restoreError = String(error); }
  try { if (browser) await bounded(browser.close(), 15_000, "Closing owned browser"); }
  catch (error) { report.status = "FAIL"; report.cleanupError = String(error); }
  if (report.errors.length || report.failedRequests.length) report.status = "FAIL";
  report.finishedAt = new Date().toISOString();
  if (!report.sourceIdentity.after) {
    try { report.sourceIdentity.after = sources(); } catch (error) { report.sourceIdentity.error = String(error); }
  }
  await write("qa.json", report);
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, error: report.error, out }));
}
if (report.status !== "PASS") process.exitCode = 1;
