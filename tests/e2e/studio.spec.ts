import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function openStudio(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/?mode=legacy");
  await expect(page.getByTestId("organ-liver")).toHaveCount(1);
  await expect(page.locator(".viewport-loading")).toHaveCount(0);
  await expect(page.locator("canvas")).toBeVisible();
  return errors;
}

test("real geometry edits, locks, undo and project round trip", async ({
  page,
}, testInfo) => {
  const errors = await openStudio(page);
  const width = page.locator(".dimensions-row strong").first();
  const original = (await width.textContent())!;
  const slider = page.getByTestId("width-slider");
  await slider.focus();
  await slider.press("ArrowRight");
  await slider.press("Tab");
  await expect(width).not.toHaveText(original);
  await page.getByTestId("undo").click();
  await expect(width).toHaveText(original);
  await page.getByRole("button", { name: "Lock Liver", exact: true }).click();
  await expect(slider).toBeDisabled();
  await page.getByRole("button", { name: "Unlock Liver", exact: true }).click();
  await expect(slider).toBeEnabled();
  await page.getByTestId("export-menu").click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /Studio project/ }).click();
  const downloaded = await pending;
  const path = await downloaded.path();
  expect(path).toBeTruthy();
  const json = JSON.parse(await readFile(path!, "utf8"));
  expect(json.scene.organs[0].positions.length).toBeGreaterThan(30_000);
  expect(json.scene.organs[0].indices.length).toBeGreaterThan(90_000);
  await page.locator("input[type=file]").setInputFiles(path!);
  await expect(
    page.getByText("Imported project", { exact: true }).first(),
  ).toBeVisible();
  await expect(width).toHaveText(original);
  await page.screenshot({ path: testInfo.outputPath("studio-overview.png") });
  expect(errors).toEqual([]);
});

test("text requests compile atomically and generate requested dimensions", async ({
  page,
}, testInfo) => {
  const errors = await openStudio(page);
  const prompt = page.getByTestId("text-prompt");
  const width = page.locator(".dimensions-row strong").first();
  const original = (await width.textContent())!;
  await prompt.fill("liver width 260 mm and make it blue");
  await page.getByTestId("compile-prompt").click();
  await expect(page.locator(".result-label")).toHaveText("UNSUPPORTED");
  await expect(
    page.getByRole("button", { name: /Apply to specimen/ }),
  ).toHaveCount(0);
  await expect(width).toHaveText(original);
  await prompt.fill("liver width 245 mm");
  await page.getByTestId("compile-prompt").click();
  await expect(page.locator(".result-label")).toHaveText("INTERPRETED CHANGE");
  await page.getByRole("button", { name: /Apply to specimen/ }).click();
  await expect(width).toHaveText("245.0mm", { timeout: 60_000 });
  await page.screenshot({ path: testInfo.outputPath("text-generated.png") });
  expect(errors).toEqual([]);
});

test("coherent variation and model export", async ({ page }, testInfo) => {
  const errors = await openStudio(page);
  const width = page.locator(".dimensions-row strong").first();
  const original = (await width.textContent())!;
  await page.getByTestId("new-variation").click();
  await expect(width).not.toHaveText(original, { timeout: 60_000 });
  await page.getByTestId("export-menu").click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /3D model/ }).click();
  const file = await pending;
  const bytes = await readFile((await file.path())!);
  expect(bytes.toString("ascii", 0, 4)).toBe("glTF");
  expect(bytes.byteLength).toBeGreaterThan(100_000);
  await page.screenshot({ path: testInfo.outputPath("variation.png") });
  expect(errors).toEqual([]);
});

test("compact viewport remains navigable", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const errors = await openStudio(page);
  await expect(
    page.getByRole("button", { name: "Open scene panel" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open scene panel" }).click();
  await expect(page.getByTestId("organ-gallbladder")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("recorded tetrahedral probe keeps positive cells and recovers without reset", async ({
  page,
}, testInfo) => {
  const errors = await openStudio(page);
  await page.getByTestId("run-probe").click();
  const report = page.getByTestId("probe-report");
  await expect(report).toBeVisible();
  await expect(report).toHaveAttribute("data-status", "complete", {
    timeout: 45_000,
  });
  const pending = page.waitForEvent("download");
  await report.getByRole("button", { name: "Report", exact: true }).click();
  const downloaded = await pending;
  const data = JSON.parse(await readFile((await downloaded.path())!, "utf8"));
  expect(data.status).toBe("complete");
  expect(data.rejectedSteps).toBe(0);
  expect(data.minJacobian).toBeGreaterThan(0.8);
  expect(data.maxVolumeDrift).toBeLessThan(0.02);
  expect(data.maxDisplacementMm).toBeGreaterThan(1);
  expect(data.recoveryResidualMm).toBeLessThan(data.maxDisplacementMm * 0.4);
  await downloaded.saveAs(testInfo.outputPath("probe-metrics.json"));
  await page.screenshot({ path: testInfo.outputPath("probe-recovery.png") });
  await report.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(report).toBeVisible(); // Reset must retain the measured result.
  expect(errors).toEqual([]);
});

test("installed learned model produces an identified experimental specimen", async ({
  page,
  request,
}) => {
  const capabilities = await (await request.get("/api/capabilities")).json();
  test.skip(
    !capabilities.model_available,
    "Optional local model artifact is not installed",
  );
  const errors = await openStudio(page);
  const response = page.waitForResponse((r) =>
    r.url().endsWith("/api/sample-learned"),
  );
  await page.getByTestId("sample-learned").click();
  const result = await response;
  expect(result.status()).toBe(200);
  const scene = await result.json();
  expect(scene.metadata.generation_source).toBe(
    "experimental_conditional_parameter_flow",
  );
  expect(scene.metadata.model_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(scene.gate.passed).toBe(true);
  await expect(
    page.getByText("Learned parameter pilot", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

async function downloadProject(page: Page) {
  await page.getByTestId("export-menu").click();
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: /Studio project/ }).click();
  return JSON.parse(await readFile((await (await pending).path())!, "utf8"));
}

test("invalid import is atomic and project undo restores appearance and object state", async ({
  page,
}) => {
  const errors = await openStudio(page);
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "broken.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({ organs: [{ positions: [], indices: [] }] }),
      ),
    });
  await expect(page.getByTestId("undo")).toBeDisabled();
  await expect(page.getByTestId("organ-liver")).toBeVisible();
  await page.getByRole("button", { name: "Material", exact: true }).click();
  const roughness = page.getByRole("slider", {
    name: "Surface roughness",
    exact: true,
  });
  await roughness.focus();
  await roughness.press("ArrowRight");
  await roughness.press("Tab");
  await page
    .getByRole("button", { name: "Hide Gallbladder", exact: true })
    .click();
  await page.getByRole("button", { name: "Lock Liver", exact: true }).click();
  const before = await downloadProject(page);
  const imported = structuredClone(before);
  imported.appearance.liver.roughness = 0.75;
  imported.hidden = [];
  imported.locked = [];
  await page
    .locator("input[type=file]")
    .setInputFiles({
      name: "changed.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(imported)),
    });
  await expect(roughness).toHaveValue("0.75");
  await expect(
    page.getByRole("button", { name: "Hide Gallbladder", exact: true }),
  ).toBeVisible();
  await page.getByTestId("undo").click();
  await expect(roughness).toHaveValue(
    String(before.appearance.liver.roughness),
  );
  await expect(
    page.getByRole("button", { name: "Show Gallbladder", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Unlock Liver", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Original procedural", { exact: true }),
  ).toBeVisible();
  const restored = await downloadProject(page);
  expect(restored.appearance).toEqual(before.appearance);
  expect(restored.hidden).toEqual(before.hidden);
  expect(restored.locked).toEqual(before.locked);
  await page.getByTestId("redo").click();
  await expect(roughness).toHaveValue("0.75");
  await expect(
    page.getByText("Imported project", { exact: true }).first(),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("late generation never overwrites a newer local surface edit", async ({
  page,
}) => {
  const errors = await openStudio(page);
  const specimen = await (await page.request.get("/default-scene.json")).json();
  const spec = { ...specimen.spec, seed: 8675309 };
  await page.route("**/api/variation/*", (route) =>
    route.fulfill({ json: spec }),
  );
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/generate", async (route) => {
    started();
    await released;
    await route.fulfill({ json: { ...specimen, spec } });
  });
  await page.getByTestId("new-variation").click();
  await requested;
  const width = page.locator(".dimensions-row strong").first();
  const original = (await width.textContent())!;
  try {
    await page.getByTestId("width-slider").focus();
    await page.getByTestId("width-slider").press("ArrowRight");
    await page.getByTestId("width-slider").press("Tab");
    await expect(width).not.toHaveText(original);
  } finally {
    release();
  }
  await expect(
    page.getByText(/The specimen changed while generation was running/),
  ).toBeVisible();
  await expect(width).not.toHaveText(original);
  expect(errors).toEqual([]);
});

test("compiler responses from an older surface cannot be applied", async ({
  page,
}) => {
  const errors = await openStudio(page);
  let release!: () => void;
  let started!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route("**/api/compile", async (route) => {
    const body = route.request().postDataJSON();
    started();
    await released;
    await route.fulfill({
      json: {
        status: "ready",
        spec: body.spec,
        message: "Stale interpretation",
      },
    });
  });
  await page.getByTestId("text-prompt").fill("liver width 245 mm");
  await page.getByTestId("compile-prompt").click();
  await requested;
  try {
    await page.getByTestId("width-slider").focus();
    await page.getByTestId("width-slider").press("ArrowRight");
    await page.getByTestId("width-slider").press("Tab");
  } finally {
    release();
  }
  await expect(page.getByTestId("compile-prompt")).toBeEnabled();
  await expect(
    page.getByRole("button", { name: /Apply to specimen/ }),
  ).toHaveCount(0);
  await expect(page.getByText("Stale interpretation")).toHaveCount(0);
  expect(errors).toEqual([]);
});
