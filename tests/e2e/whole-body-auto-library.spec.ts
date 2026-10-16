import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

const autoApply = (page: Page) => page.getByRole("button", { name: "Apply default library materials", exact: true });
const complete = (page: Page) => page.getByTestId("default-library-complete");
const progress = (page: Page) => page.getByRole("progressbar", { name: "Default library material progress", exact: true });
const catalog = () => readFile("apps/studio/public/body-reference/catalog.json", "utf8").then(JSON.parse);
async function snapshot(page: Page): Promise<any> {
  return JSON.parse(await page.locator("[data-scene-snapshot]").getAttribute("data-scene-snapshot") ?? "{}");
}
async function openPanel(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?mode=scene");
  await expect(page.locator("[data-scene-ready='true'] canvas")).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Whole-body colour", exact: true }).click();
  await expect(autoApply(page)).toBeEnabled();
}
async function rendered(page: Page) {
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.rendering.renderedRevision === state.rendering.sceneRevision;
  }).toBe(true);
}
async function applyRealDefaults(page: Page) {
  await autoApply(page).click();
  await expect(complete(page)).toContainText("All 36 organ materials applied", { timeout: 60000 });
  await rendered(page);
  return snapshot(page);
}
function preservesScene(before: any, after: any) {
  expect(after.camera).toEqual(before.camera);
  expect(after.physics).toEqual(before.physics);
  expect(after.rendering.lights).toEqual(before.rendering.lights);
  expect(after.organs.map((organ: any) => [organ.id, organ.geometrySignature])).toEqual(before.organs.map((organ: any) => [organ.id, organ.geometrySignature]));
}
function preservesPalette(before: any, after: any) {
  expect(after.referenceColors).toEqual(before.referenceColors);
  expect(after.bodyReferencePlan).toEqual(before.bodyReferencePlan);
  expect(after.organs.map((organ: any) => [organ.id, organ.materialSignature])).toEqual(before.organs.map((organ: any) => [organ.id, organ.materialSignature]));
  preservesScene(before, after);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test("one default-library action shows progress, applies all 36 real materials, and undo resets the checkmark", async ({ page }, info) => {
  test.setTimeout(120000);
  const library = await catalog();
  const requests: any[] = [], pageErrors: string[] = [];
  const finalRequest = deferred(), releaseFinal = deferred();
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.route("**/api/atlas/reference-material/analyze-regions", async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === library.sources.length) { finalRequest.resolve(); await releaseFinal.promise; }
    await route.continue();
  });
  await openPanel(page);
  const before = await snapshot(page);
  await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath("before-default-materials.png") });
  // Beyond opening this tab, the entire operation uses this single action.
  await autoApply(page).click();
  await finalRequest.promise;
  try {
    await expect(progress(page)).toBeVisible();
    const current = await progress(page).evaluate(element => ({ value: (element as HTMLProgressElement).value, max: (element as HTMLProgressElement).max }));
    expect(current.value).toBeGreaterThan(0);
    expect(current.value).toBeLessThan(current.max);
    await expect(complete(page)).toHaveCount(0);
    preservesPalette(before, await snapshot(page));
    await page.screenshot({ path: info.outputPath("default-material-progress.png") });
  } finally { releaseFinal.resolve(); }
  await expect(complete(page)).toContainText("All 36 organ materials applied", { timeout: 60000 });
  await expect(complete(page).locator("svg")).toHaveCount(1);
  await rendered(page);
  const after = await snapshot(page);
  expect(Object.keys(after.referenceColors)).toHaveLength(36);
  expect(after.bodyReferencePlan.settings).toEqual({ strength: .85, mode: "color", related: true, harmonize: true });
  const assignments = Object.values(after.bodyReferencePlan.assignments) as any[];
  expect(assignments.filter(item => item.basis === "direct")).toHaveLength(6);
  expect(assignments.filter(item => item.basis === "related" || item.basis === "harmonized")).toHaveLength(30);
  const appliedCoverage = page.getByTestId("default-library-coverage");
  await expect(appliedCoverage.locator('[data-basis="direct"]')).toHaveCount(6);
  await expect(appliedCoverage.locator('[data-basis="related"], [data-basis="harmonized"]')).toHaveCount(30);
  await expect(appliedCoverage.locator('[data-target-id="pancreas"]')).toContainText("Verify the reference surface");
  await expect(appliedCoverage.locator('[data-target-id="liver"]')).toContainText("Reference images disagree");
  expect(requests).toHaveLength(library.sources.length);
  expect(requests.flatMap(request => request.regions)).toHaveLength(7);
  expect(requests.every(request => request.regions.every((region: any) => typeof region.mask_base64 === "string" && region.mask_base64.length > 0))).toBe(true);
  expect(after.bodyReferencePlan.assignments.liver.evidence).toHaveLength(2);
  for (const evidence of assignments.flatMap(item => item.evidence)) {
    expect(evidence.identity_source).toContain("expert-reviewed");
    expect(evidence.capture_group).toMatch(/^dsad-surgery-/);
    expect(evidence.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  }
  preservesScene(before, after);
  for (const old of before.organs.filter((organ: any) => organ.category === "skeleton")) {
    expect(after.organs.find((organ: any) => organ.id === old.id).materialSignature).toBe(old.materialSignature);
    expect(after.referenceColors[old.id]).toBeUndefined();
  }
  await page.screenshot({ path: info.outputPath("default-materials-complete.png") });
  await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath("after-default-materials.png") });
  await page.getByRole("button", { name: "Before", exact: true }).click();
  await rendered(page);
  const comparison = await snapshot(page);
  preservesPalette(before, comparison);
  await expect(complete(page)).toContainText("All 36 organ materials applied");
  await page.getByRole("button", { name: "Applied colours", exact: true }).click();
  await rendered(page);
  preservesPalette(after, await snapshot(page));
  await writeFile(info.outputPath("default-materials-evidence.json"), JSON.stringify({ before, after, requests: requests.map(request => ({ segmentation: request.segmentation, regions: request.regions.map(({ mask_base64, ...region }: any) => ({ ...region, supplied_mask: Boolean(mask_base64) })) })) }, null, 2));
  await page.setViewportSize({ width: 390, height: 844 });
  await complete(page).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("default-materials-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Restore previous colours", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).referenceColors).toEqual(before.referenceColors);
  await expect(complete(page)).toHaveCount(0);
  await rendered(page);
  // Resizing changes the camera projection, so material equality is checked
  // separately from the already-proven pre-resize camera invariance above.
  const restored = await snapshot(page);
  expect(restored.bodyReferencePlan).toEqual(before.bodyReferencePlan);
  expect(restored.organs.map((organ: any) => [organ.id, organ.materialSignature])).toEqual(before.organs.map((organ: any) => [organ.id, organ.materialSignature]));
  expect(pageErrors).toEqual([]);
});

test("an older live API fails before loading photos and keeps the scene unchanged", async ({ page }) => {
  await page.route("**/api/atlas/reference-material/status", route => route.fulfill({ status: 404, json: { detail: "Not Found" } }));
  let analyses = 0;
  page.on("request", request => { if (request.url().endsWith("/reference-material/analyze-regions")) analyses++; });
  await openPanel(page);
  const before = await snapshot(page);
  await autoApply(page).click();
  await expect(page.getByRole("alert")).toContainText("Restart the anatomy server");
  await expect(complete(page)).toHaveCount(0);
  await expect(progress(page)).toHaveAttribute("value", "0");
  expect(analyses).toBe(0);
  preservesPalette(before, await snapshot(page));
});

test("applying from Before preserves the committed palette for undo and uses edited photo settings", async ({ page }) => {
  test.setTimeout(120000);
  await openPanel(page);
  const committed = await applyRealDefaults(page);
  await page.getByRole("button", { name: "Before", exact: true }).click();
  await rendered(page);
  await page.getByLabel("Default library transfer mode", { exact: true }).selectOption("chroma");
  await page.getByLabel("Default library transfer strength", { exact: true }).fill("0.4");
  const changed = await applyRealDefaults(page);
  expect(changed.bodyReferencePlan.settings).toEqual({ strength: .4, mode: "chroma", related: true, harmonize: true });
  expect(changed.referenceColors).not.toEqual(committed.referenceColors);
  await page.getByRole("button", { name: "Undo colour application", exact: true }).click();
  await rendered(page);
  preservesPalette(committed, await snapshot(page));
});

test("failure after a successful region batch preserves the previous applied palette without a success check", async ({ page }) => {
  test.setTimeout(120000);
  await openPanel(page);
  const before = await applyRealDefaults(page);
  let calls = 0;
  await page.route("**/api/atlas/reference-material/analyze-regions", async route => {
    if (++calls === 1) await route.continue();
    else await route.fulfill({ status: 503, json: { detail: "Default reference analysis failed for this test." } });
  });
  await autoApply(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "Default reference analysis failed for this test." })).toBeVisible();
  await expect(autoApply(page)).toBeEnabled();
  await expect(complete(page)).toHaveCount(0);
  expect(calls).toBe(2);
  preservesPalette(before, await snapshot(page));
});

test("cancelling a delayed default result cannot replace an existing palette or show a stale check", async ({ page }) => {
  test.setTimeout(120000);
  await openPanel(page);
  const before = await applyRealDefaults(page);
  const received = deferred(), release = deferred(), settled = deferred();
  let calls = 0;
  await page.route("**/api/atlas/reference-material/analyze-regions", async route => {
    ++calls;
    const response = await route.fetch();
    received.resolve(); await release.promise;
    try { await route.fulfill({ response }); } catch { /* The browser may have aborted this request. */ }
    finally { settled.resolve(); }
  });
  await autoApply(page).click();
  await received.promise;
  try {
    await expect(progress(page)).toBeVisible();
    await expect(complete(page)).toHaveCount(0);
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally { release.resolve(); }
  await settled.promise;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(autoApply(page)).toBeEnabled();
  await expect(complete(page)).toHaveCount(0);
  expect(calls).toBe(1);
  preservesPalette(before, await snapshot(page));
});

test("automatic defaults ignore edited assignments and uploaded drafts while preserving those drafts", async ({ page }) => {
  test.setTimeout(120000);
  const library = await catalog();
  await openPanel(page);
  await page.getByRole("button", { name: "Load reference library", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyse all regions", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Edit region Liver + Stomach: Liver", exact: true }).click();
  await page.getByLabel("Tissue region name", { exact: true }).fill("Keep my edited draft");
  await page.getByLabel("Reference tissue identity", { exact: true }).selectOption("heart");
  await page.getByLabel("Whole-body reference images", { exact: true }).setInputFiles("apps/studio/public/body-reference/dsad-03-2.png");
  await page.getByRole("button", { name: "Add region to dsad-03-2.png", exact: true }).click();
  await page.getByLabel("Tissue region name", { exact: true }).fill("Keep my uploaded draft");
  await page.getByLabel("Reference tissue identity", { exact: true }).selectOption("heart");
  await page.getByRole("button", { name: "Use full image for this region", exact: true }).click();
  const requests: any[] = [];
  page.on("request", request => { if (request.url().endsWith("/reference-material/analyze-regions")) requests.push(request.postDataJSON()); });
  const after = await applyRealDefaults(page);
  expect(requests).toHaveLength(library.sources.length);
  expect(requests.flatMap(request => request.regions.map((region: any) => region.organ)).sort()).toEqual(library.sources.flatMap((source: any) => source.regions.map((region: any) => region.organ)).sort());
  expect(after.bodyReferencePlan.assignments.heart.basis).not.toBe("direct");
  expect(after.bodyReferencePlan.assignments.liver.evidence).toHaveLength(2);
  expect((Object.values(after.bodyReferencePlan.assignments) as any[]).flatMap(item => item.evidence).every(evidence => !evidence.source_id.startsWith("upload-") && evidence.identity_source.includes("expert-reviewed"))).toBe(true);
  await expect(page.getByRole("button", { name: "Edit region Liver + Stomach: Keep my edited draft", exact: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Edit region dsad-03-2.png: Keep my uploaded draft", exact: true })).toHaveCount(1);
  await expect(page.getByRole("checkbox", { name: /^Review region / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Apply all reviewed colours", exact: true })).toBeDisabled();
});
