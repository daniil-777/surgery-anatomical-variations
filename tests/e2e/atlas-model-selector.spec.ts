import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { AtlasGeneration } from "../../apps/studio/src/atlas";

// Live integration: never fabricate history, model status, or successful sampling.
// Only the explicit failure test intercepts one activation with an HTTP 500.
// Each test restores the user's original A100 selection, including on failure.
const originalBundle = "33c3a424e1663e2f6544f4ec23ed6a797e41a45473fa87c1bc9b01aed4effcf0";
interface ModelVersion {
  generation: 1 | 2;
  bundle_sha256: string;
  model_sha256: string;
  active: boolean;
  integrity: string;
  method: string;
  conditions: number;
  runtime: { device: string; gpu: string | null };
}
interface History { versions: ModelVersion[]; active_bundle: string; selected_generation: 1 | 2; selection_error: string | null }
let initialHistory: History;
let a100: ModelVersion;
let cpuFlow: ModelVersion;
let t4Vae: ModelVersion;
let cpuVae: ModelVersion;

const trigger = (page: Page) => page.getByRole("button", { name: "Choose generation model", exact: true });
const chooser = (page: Page) => page.getByRole("dialog", { name: "Generation models", exact: true });
async function settledChooser(page: Page) {
  await expect(chooser(page)).toHaveAttribute("aria-busy", "false");
  await expect.poll(() => chooser(page).evaluate(element => getComputedStyle(element).opacity)).toBe("1");
  await expect.poll(() => chooser(page).evaluate(element => getComputedStyle(element).transform)).toBe("none");
}
const retained = (history: History) => history.versions.map(({ active: _active, ...version }) => version)
  .sort((left, right) => left.bundle_sha256.localeCompare(right.bundle_sha256));

async function history(request: APIRequestContext): Promise<History> {
  const response = await request.get("/api/atlas/models/joint/history", { timeout: 30_000 });
  expect(response.status(), await response.text()).toBe(200);
  return await response.json() as History;
}

async function restoreOriginal(request: APIRequestContext) {
  const current = await history(request);
  if (current.active_bundle !== originalBundle || current.selected_generation !== 2) {
    const response = await request.post("/api/atlas/models/joint/activate", {
      data: { generation: 2, bundle_sha256: originalBundle }, timeout: 60_000,
    });
    expect(response.status(), await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({ joint_generation: 2, joint_bundle_sha256: originalBundle });
  }
  const restored = await history(request);
  expect(restored).toMatchObject({ active_bundle: originalBundle, selected_generation: 2, selection_error: null });
  expect(retained(restored)).toEqual(retained(initialHistory));
}

async function ready(page: Page) {
  await page.goto("/?template=hra-liver-female");
  await expect(trigger(page)).toBeEnabled();
  await expect(trigger(page)).toContainText("Flow v2 · A100");
  await expect(page.getByRole("button", { name: "Joint flow variation", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
}

async function choose(page: Page, label: string, model: ModelVersion) {
  if (!await chooser(page).isVisible()) await trigger(page).click();
  const completed = page.waitForResponse(response => response.url().endsWith("/api/atlas/models/joint/activate") && response.request().method() === "POST");
  await chooser(page).getByRole("button", { name: `Use ${label}`, exact: true }).click();
  const response = await completed;
  expect(response.status(), await response.text()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ generation: model.generation, bundle_sha256: model.bundle_sha256 });
  expect(await response.json()).toMatchObject({ joint_generation: model.generation, joint_bundle_sha256: model.bundle_sha256 });
  await expect(chooser(page)).toBeHidden();
  await expect(trigger(page)).toContainText(label);
  await expect(page.getByRole("button", { name: model.generation === 2 ? "Joint flow variation" : "Joint VAE variation", exact: true })).toBeEnabled();
}

async function sample(page: Page, model: ModelVersion, seed: number) {
  await page.getByRole("textbox", { name: "Joint variation seed", exact: true }).fill(String(seed));
  const completed = page.waitForResponse(response => response.url().endsWith("/api/atlas/sample-joint") && response.request().method() === "POST");
  await page.getByRole("button", { name: model.generation === 2 ? "Joint flow variation" : "Joint VAE variation", exact: true }).click();
  const response = await completed;
  expect(response.status(), await response.text()).toBe(200);
  const result = await response.json() as AtlasGeneration;
  expect(result.summary.joint_model).toMatchObject({
    bundle_sha256: model.bundle_sha256, model_sha256: model.model_sha256, request_seed: seed,
  });
  expect(result.spec.renderer_version).toBe(model.generation === 2 ? "disease-v2" : undefined);
  expect(result.spec.template_id).toBe("hra-liver-female");
  expect(result.scene.metadata?.geometry_sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  return { provenance: result.summary.joint_model, spec: result.spec, geometry_sha256: result.scene.metadata?.geometry_sha256 };
}

test.describe("live generation model selector", () => {
  test.describe.configure({ mode: "serial", timeout: 120_000 });

  test.beforeAll(async ({ request }) => {
    initialHistory = await history(request);
    expect(initialHistory).toMatchObject({ active_bundle: originalBundle, selected_generation: 2, selection_error: null });
    expect(initialHistory.versions.every(version => version.integrity === "verified")).toBe(true);
    const find = (generation: 1 | 2, gpu: RegExp | null) => {
      const matches = initialHistory.versions.filter(version => version.generation === generation &&
        (gpu ? gpu.test(version.runtime.gpu ?? "") : version.runtime.device === "cpu"));
      expect(matches).toHaveLength(1);
      return matches[0]!;
    };
    a100 = find(2, /A100/); cpuFlow = find(2, null); t4Vae = find(1, /T4/);
    cpuVae = find(1, null);
    expect(a100.bundle_sha256).toBe(originalBundle);
  });

  test.beforeEach(async ({ request, page }) => { await restoreOriginal(request); await ready(page); });
  test.afterEach(async ({ request }) => { await restoreOriginal(request); });

  test("one click switches real flow and VAE weights, and A100 persists on reload", async ({ page }, info) => {
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await trigger(page).click();
    for (const label of ["Flow v2 · A100", "Flow v2 · CPU", "VAE v1 · T4", "VAE v1 · CPU"]) {
      await expect(chooser(page).getByRole("button", { name: `Use ${label}`, exact: true })).toBeVisible();
    }
    await settledChooser(page);
    await page.screenshot({ path: info.outputPath("desktop-model-selector.png") });
    await choose(page, "Flow v2 · CPU", cpuFlow);
    const cpu = await sample(page, cpuFlow, 72101);
    await choose(page, "VAE v1 · T4", t4Vae);
    const vae = await sample(page, t4Vae, 72102);
    await choose(page, "VAE v1 · CPU", cpuVae);
    const cpuVaeSample = await sample(page, cpuVae, 72104);
    await choose(page, "Flow v2 · A100", a100);
    await page.reload();
    await expect(trigger(page)).toContainText("Flow v2 · A100");
    const restored = await sample(page, a100, 72103);
    const finalHistory = await history(page.request);
    expect(retained(finalHistory)).toEqual(retained(initialHistory));
    expect(finalHistory.active_bundle).toBe(originalBundle);
    expect(errors).toEqual([]);
    await writeFile(info.outputPath("model-switch-evidence.json"), JSON.stringify({
      initialHistory, cpu, vae, cpuVaeSample, restored, finalHistory, errors, persistedAcrossReload: true,
    }, null, 2));
  });

  test("a failed activation keeps the active model and can be retried", async ({ page }, info) => {
    let rejected = false;
    await page.route("**/api/atlas/models/joint/activate", async route => {
      if (!rejected && route.request().method() === "POST") {
        rejected = true;
        await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Selector activation test failure" }) });
      } else await route.continue();
    });
    await trigger(page).click();
    const failed = page.waitForResponse(response => response.url().endsWith("/api/atlas/models/joint/activate") && response.status() === 500);
    await chooser(page).getByRole("button", { name: "Use Flow v2 · CPU", exact: true }).click();
    await failed;
    await expect(chooser(page)).toBeVisible();
    await expect(chooser(page).getByRole("alert")).toContainText("Selector activation test failure");
    await expect(trigger(page)).toContainText("Flow v2 · A100");
    expect((await history(page.request)).active_bundle).toBe(originalBundle);
    await page.screenshot({ path: info.outputPath("model-selector-retry.png") });
    await chooser(page).getByRole("button", { name: "Retry", exact: true }).click();
    await expect(chooser(page).getByRole("button", { name: "Use Flow v2 · CPU", exact: true })).toBeEnabled();
    await choose(page, "Flow v2 · CPU", cpuFlow);
    expect((await history(page.request)).active_bundle).toBe(cpuFlow.bundle_sha256);
    await choose(page, "Flow v2 · A100", a100);
    expect(rejected).toBe(true);
    await page.unroute("**/api/atlas/models/joint/activate");
    await writeFile(info.outputPath("model-retry-evidence.json"), JSON.stringify({ rejected: true, priorSelectionPreserved: true, retryActivatedRealWeights: true, restoredBundle: originalBundle }, null, 2));
  });

  test("Retry repairs controls after weights activate but their catalog fails to load", async ({ page }, info) => {
    let catalogRequests = 0;
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve; });
    await page.route("**/api/atlas/catalog", async route => {
      if (++catalogRequests === 1) await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ detail: "Catalog refresh test failure" }) });
      else { await catalogGate; await route.continue(); }
    });
    await trigger(page).click();
    await chooser(page).getByRole("button", { name: "Use VAE v1 · T4", exact: true }).click();
    await expect(chooser(page).getByRole("alert")).toContainText("Studio could not refresh its controls");
    expect((await history(page.request)).active_bundle).toBe(t4Vae.bundle_sha256);
    await expect(page.getByRole("button", { name: "Joint VAE variation", exact: true })).toBeDisabled();
    const recoveryRequest = page.waitForRequest(request => request.url().endsWith("/api/atlas/catalog"));
    await chooser(page).getByRole("button", { name: "Retry", exact: true }).click();
    await recoveryRequest;
    try {
      await expect(chooser(page).getByRole("button", { name: "Manage weights & imports" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Trained models", exact: true })).toBeDisabled();
    } finally { releaseCatalog(); }
    await settledChooser(page);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Joint VAE variation", exact: true })).toBeEnabled();
    expect(catalogRequests).toBe(2);
    await page.keyboard.press("Escape");
    const recovered = await sample(page, t4Vae, 72201);
    await page.unroute("**/api/atlas/catalog");
    await choose(page, "Flow v2 · A100", a100);
    await writeFile(info.outputPath("catalog-recovery-evidence.json"), JSON.stringify({ catalogRequests, recovered, restoredBundle: originalBundle }, null, 2));
  });

  test("keyboard dismissal restores focus and the mobile selector stays in view", async ({ page }, info) => {
    await trigger(page).focus();
    await page.keyboard.press("Enter");
    await expect(chooser(page)).toBeVisible();
    await settledChooser(page);
    await expect(chooser(page).getByRole("button", { name: "Use Flow v2 · A100", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(chooser(page).getByRole("button", { name: "Use Flow v2 · CPU", exact: true })).toBeFocused();
    await page.keyboard.press("End");
    await expect(chooser(page).getByRole("button", { name: "Use VAE v1 · CPU", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(chooser(page)).toBeHidden();
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await page.mouse.click(8, page.viewportSize()!.height - 8);
    await expect(chooser(page)).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await trigger(page).click();
    await expect(chooser(page)).toBeVisible();
    await settledChooser(page);
    const bounds = await chooser(page).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    const width = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
    expect(width.content).toBeLessThanOrEqual(width.viewport);
    await page.screenshot({ path: info.outputPath("mobile-model-selector.png") });
    await page.keyboard.press("Escape");
    await expect(trigger(page)).toBeFocused();
    await trigger(page).click();
    await chooser(page).getByRole("button", { name: "Manage weights & imports" }).click();
    await expect(page.getByRole("dialog", { name: "Trained models", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Close trained models", exact: true }).click();
    await expect(trigger(page)).toBeFocused();
    expect((await history(page.request)).active_bundle).toBe(originalBundle);
    await writeFile(info.outputPath("model-selector-accessibility.json"), JSON.stringify({ bounds, width, keyboardDismissal: true, focusReturned: true, outsideDismissal: true, bundleUnchanged: originalBundle }, null, 2));
  });
});
