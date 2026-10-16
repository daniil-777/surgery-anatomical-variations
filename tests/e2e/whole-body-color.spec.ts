import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

async function snapshot(page: Page): Promise<any> {
  return JSON.parse(await page.locator("[data-scene-snapshot]").getAttribute("data-scene-snapshot") ?? "{}");
}
async function openScene(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?mode=scene");
  await expect(page.locator("[data-scene-ready='true'] canvas")).toBeVisible({ timeout: 60000 });
}
async function openLibrary(page: Page) {
  await page.getByRole("button", { name: "Whole-body colour", exact: true }).click();
  await page.getByRole("button", { name: "Load reference library", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyse all regions", exact: true })).toBeEnabled();
}
const reviewBoxes = (page: Page) => page.getByRole("checkbox", { name: /^Review region / });
const apply = (page: Page) => page.getByRole("button", { name: "Apply all reviewed colours", exact: true });
function checkPreservation(before: any, after: any) {
  expect(after.camera).toEqual(before.camera);
  expect(after.physics).toEqual(before.physics);
  expect(after.rendering.lights).toEqual(before.rendering.lights);
  expect(after.organs.map((organ: any) => [organ.id, organ.geometrySignature])).toEqual(before.organs.map((organ: any) => [organ.id, organ.geometrySignature]));
}

test("real multi-organ library produces a reviewed whole-body palette and restores exact materials without changing paused physics", async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const catalog = JSON.parse(await readFile("apps/studio/public/body-reference/catalog.json", "utf8"));
  const count = catalog.sources.reduce((sum: number, source: any) => sum + source.regions.length, 0);
  const calls: any[] = [];
  page.on("request", request => { if (request.url().endsWith("/reference-material/analyze-regions")) calls.push(request.postDataJSON()); });
  await openScene(page);
  await page.getByRole("button", { name: "Apply learned physics to all organs", exact: true }).click();
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics?.running).toBe(false);
  await expect.poll(async () => { const state = await snapshot(page); return state.rendering.renderedRevision === state.rendering.sceneRevision; }).toBe(true);
  const before = await snapshot(page);
  await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath("body-before.png") });
  await openLibrary(page);
  expect(calls).toHaveLength(0);
  await expect(apply(page)).toBeDisabled();
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).click();
  await expect(reviewBoxes(page)).toHaveCount(count, { timeout: 60000 });
  await expect(page.getByRole("button", { name: "Analyse all regions", exact: true })).toBeEnabled();
  await expect(apply(page)).toBeDisabled();
  expect(calls).toHaveLength(catalog.sources.length);
  expect(calls.some(call => call.regions.length > 1)).toBe(true);
  const analysed = await snapshot(page);
  expect(analysed.referenceColors).toEqual(before.referenceColors);
  for (const box of await reviewBoxes(page).all()) await box.check();
  await expect(apply(page)).toBeEnabled();
  await apply(page).click();
  await expect.poll(async () => (await snapshot(page)).bodyReferencePlan?.version).toBe("whole-body-color-1");
  const direct = await snapshot(page);
  checkPreservation(before, direct);
  const assignments = Object.values(direct.bodyReferencePlan.assignments) as any[];
  expect(assignments.filter(item => item.basis === "direct").length).toBeGreaterThanOrEqual(6);
  expect(assignments.some(item => item.basis === "authored")).toBe(true);
  for (const old of before.organs) {
    const current = direct.organs.find((organ: any) => organ.id === old.id);
    if (!direct.referenceColors[old.id]) expect(current.materialSignature).toBe(old.materialSignature);
  }
  await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath("body-direct-colours.png") });
  await page.getByRole("button", { name: "Restore previous colours", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).referenceColors).toEqual(before.referenceColors);
  expect((await snapshot(page)).organs.map((organ: any) => organ.materialSignature)).toEqual(before.organs.map((organ: any) => organ.materialSignature));
  await page.getByRole("checkbox", { name: "Borrow related tissue colours", exact: true }).check();
  await page.getByRole("checkbox", { name: "Harmonize other soft organs", exact: true }).check();
  await apply(page).click();
  await expect.poll(async () => Object.keys((await snapshot(page)).referenceColors).length).toBe(36);
  const harmonized = await snapshot(page);
  checkPreservation(before, harmonized);
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download colour plan", exact: true }).click();
  const download = await downloadEvent;
  const exportPath = info.outputPath("exported-colour-plan.json");
  await download.saveAs(exportPath);
  const exported = JSON.parse(await readFile(exportPath, "utf8"));
  expect(exported).toEqual(harmonized.bodyReferencePlan);
  expect(exported.assignments.liver.evidence).toHaveLength(2);
  for (const evidence of exported.assignments.liver.evidence) {
    expect(evidence.capture_group).toMatch(/^dsad-surgery-/);
    expect(evidence.source_url).toBe("https://doi.org/10.6084/m9.figshare.21702600");
    expect(evidence.identity_source).toContain("expert-reviewed");
  }
  for (const old of before.organs.filter((organ: any) => organ.category === "skeleton")) {
    expect(harmonized.organs.find((organ: any) => organ.id === old.id).materialSignature).toBe(old.materialSignature);
    expect(harmonized.referenceColors[old.id]).toBeUndefined();
  }
  await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath("body-harmonized.png") });
  await page.screenshot({ path: info.outputPath("body-colour-panel.png"), fullPage: true });
  await writeFile(info.outputPath("whole-body-colour-evidence.json"), JSON.stringify({ before, direct, harmonized, calls: calls.map(({ image_base64, regions, ...request }) => ({ ...request, image_bytes_base64: image_base64.length, regions: regions.map(({ mask_base64, ...region }: any) => ({ ...region, supplied_mask: Boolean(mask_base64) })) })) }, null, 2));
  // A later individual edit invalidates undo, while other pooled materials keep
  // their complete source evidence rather than just the compatibility hash.
  await page.getByRole("button", { name: "Scene controls", exact: true }).click();
  await page.getByText("Explore the structures", { exact: false }).click();
  await page.getByRole("button", { name: "Liver", exact: true }).click();
  await page.getByRole("button", { name: "Clear reference colour", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).referenceColors.liver).toBeUndefined();
  const edited = await snapshot(page);
  expect(edited.bodyReferencePlan.assignments.liver).toBeUndefined();
  expect(edited.bodyReferencePlan.assignments.stomach.evidence).toEqual(harmonized.bodyReferencePlan.assignments.stomach.evidence);
  await page.getByRole("button", { name: "Whole-body colour", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore previous colours", exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("failed batch analysis cannot apply materials or invent coverage", async ({ page }) => {
  await page.route("**/api/atlas/reference-material/analyze-regions", route => route.fulfill({ status: 503, json: { detail: "Reference analysis unavailable for this test." } }));
  await openScene(page); const before = await snapshot(page);
  await openLibrary(page);
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).click();
  await expect(page.getByText(/Reference analysis unavailable for this test/).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyse all regions", exact: true })).toBeEnabled();
  await expect(apply(page)).toBeDisabled();
  expect((await snapshot(page)).referenceColors).toEqual(before.referenceColors);
  expect((await snapshot(page)).bodyReferencePlan).toBeNull();
});

test("whole-body image workflow fits mobile and uploads do not alter the material scene", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openScene(page);
  const before = await snapshot(page);
  await openLibrary(page);
  const catalog = JSON.parse(await readFile("apps/studio/public/body-reference/catalog.json", "utf8"));
  await page.getByLabel("Whole-body reference images", { exact: true }).setInputFiles(`apps/studio/public${catalog.sources[0].src}`);
  await expect(apply(page)).toBeDisabled();
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("body-colours-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await snapshot(page)).referenceColors).toEqual(before.referenceColors);
});

test("uploaded photograph uses a drawn SAM 2 region and applies only its explicitly reviewed organ", async ({ page }, info) => {
  test.setTimeout(180000);
  const catalog = JSON.parse(await readFile("apps/studio/public/body-reference/catalog.json", "utf8"));
  const source = catalog.sources.find((item: any) => item.id === "dsad-03-2");
  await openScene(page);
  const before = await snapshot(page);
  await page.getByRole("button", { name: "Whole-body colour", exact: true }).click();
  await page.getByLabel("Whole-body reference images", { exact: true }).setInputFiles(`apps/studio/public${source.src}`);
  await page.getByRole("button", { name: "Add region to dsad-03-2.png", exact: true }).click();
  await page.getByRole("checkbox", { name: "Target Liver", exact: true }).check();
  await page.getByLabel("Reference tissue surface", { exact: true }).selectOption("outer");
  const values = [0, 5, 87, 95];
  for (const [index, edge] of ["left", "top", "right", "bottom"].entries()) {
    await page.getByLabel(`Whole-body region ${edge}`, { exact: true }).fill(String(values[index]));
  }
  await page.getByRole("button", { name: "+ Tissue", exact: true }).click();
  const regionImage = page.getByTestId("whole-body-region-selection");
  const bounds = await regionImage.boundingBox();
  expect(bounds).not.toBeNull();
  await regionImage.click({ position: { x: bounds!.width * .335156, y: bounds!.height * .523438 } });
  await page.getByRole("checkbox", { name: "Use SAM 2 for whole-body regions", exact: true }).check();
  const responseEvent = page.waitForResponse(response => response.url().endsWith("/reference-material/analyze-regions"));
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).click();
  const response = await responseEvent;
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.results).toHaveLength(1);
  const analysis = result.results[0].analysis;
  expect(analysis.segmentation.method).toMatch(/sam2/);
  expect(analysis.quality.accepted_fraction).toBeGreaterThan(.2);
  await expect(reviewBoxes(page)).toHaveCount(1);
  await expect(apply(page)).toBeDisabled();
  expect((await snapshot(page)).referenceColors).toEqual(before.referenceColors);
  await reviewBoxes(page).check();
  await apply(page).click();
  await expect.poll(async () => Object.keys((await snapshot(page)).referenceColors)).toEqual(["liver"]);
  const after = await snapshot(page);
  expect(after.bodyReferencePlan.assignments.liver.evidence[0].identity_source).toBe("User-assigned tissue identity");
  for (const old of before.organs.filter((organ: any) => organ.id !== "liver")) {
    expect(after.organs.find((organ: any) => organ.id === old.id).materialSignature).toBe(old.materialSignature);
  }
  await page.getByRole("button", { name: "Edit region dsad-03-2.png: Region 1", exact: true }).click();
  await page.screenshot({ path: info.outputPath("uploaded-liver-sam2.png"), fullPage: true });
  await writeFile(info.outputPath("uploaded-liver-sam2-analysis.json"), JSON.stringify(analysis, null, 2));
});

test("partial region errors remain explicit and cancelled stale analysis cannot reappear", async ({ page }) => {
  await openScene(page); const before = await snapshot(page);
  await openLibrary(page);
  const catalog = JSON.parse(await readFile("apps/studio/public/body-reference/catalog.json", "utf8"));
  for (const source of catalog.sources.slice(1)) await page.getByRole("button", { name: `Remove source ${source.label}`, exact: true }).click();
  let original: any;
  await page.route("**/api/atlas/reference-material/analyze-regions", async route => {
    const response = await route.fetch();
    original = await response.json();
    await route.fulfill({ status: 200, json: { ...original, results: [original.results[0], { id: original.results[1].id, error: "Too little selected tissue in stomach region." }] } });
  });
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).click();
  await expect(reviewBoxes(page)).toHaveCount(1);
  await expect(page.getByText("Too little selected tissue in stomach region.", { exact: true })).toBeVisible();
  await reviewBoxes(page).check();
  await apply(page).click();
  await expect.poll(async () => Object.keys((await snapshot(page)).referenceColors)).toEqual(["liver"]);
  expect((await snapshot(page)).bodyReferencePlan.assignments.stomach.basis).toBe("authored");
  await page.getByRole("button", { name: "Restore previous colours", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).referenceColors).toEqual(before.referenceColors);
  await page.unroute("**/api/atlas/reference-material/analyze-regions");
  let release!: () => void, received!: () => void, fulfilled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { received = resolve; });
  const settled = new Promise<void>(resolve => { fulfilled = resolve; });
  await page.route("**/api/atlas/reference-material/analyze-regions", async route => {
    received(); await gate;
    try { await route.fulfill({ status: 200, json: original }); } finally { fulfilled(); }
  });
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).click();
  await requested;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByLabel("Reference tissue identity", { exact: true }).selectOption("spleen");
  release(); await settled;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(reviewBoxes(page)).toHaveCount(0);
  await expect(apply(page)).toBeDisabled();
  expect((await snapshot(page)).referenceColors).toEqual(before.referenceColors);
});

test("reviewed colours preserve surface finish in focused pancreas and spleen views", async ({ page }, info) => {
  test.setTimeout(120000);
  await openScene(page);
  await openLibrary(page);
  await page.getByRole("button", { name: "Analyse all regions", exact: true }).click();
  await expect(reviewBoxes(page)).toHaveCount(7, { timeout: 60000 });
  for (const box of await reviewBoxes(page).all()) await box.check();
  await expect(apply(page)).toBeEnabled();
  await page.getByRole("button", { name: "Scene controls", exact: true }).click();
  await page.getByRole("button", { name: "Deep anatomy", exact: true }).click();
  await page.getByText("Explore the structures", { exact: false }).click();
  const records = [];
  const settled = async () => {
    await expect.poll(async () => {
      const state = await snapshot(page);
      return !state.rendering.cameraTransition && state.rendering.renderedRevision === state.rendering.sceneRevision;
    }).toBe(true);
  };
  for (const organ of ["Pancreas", "Spleen"]) {
    if (!await page.getByRole("button", { name: `Focus ${organ}`, exact: true }).isVisible()) {
      await page.getByText("Explore the structures", { exact: false }).click();
    }
    await page.getByRole("button", { name: `Focus ${organ}`, exact: true }).click();
    await settled();
    const before = await snapshot(page);
    expect(before.camera.focusedOrgan).toBe(organ.toLowerCase());
    await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath(`${organ.toLowerCase()}-before.png`) });
    await page.getByRole("button", { name: "Whole-body colour", exact: true }).click();
    await apply(page).click();
    await expect.poll(async () => (await snapshot(page)).bodyReferencePlan?.version).toBe("whole-body-color-1");
    await settled();
    const after = await snapshot(page);
    checkPreservation(before, after);
    const oldMaterial = JSON.parse(before.organs.find((part: any) => part.id === organ.toLowerCase()).materialSignature);
    const newMaterial = JSON.parse(after.organs.find((part: any) => part.id === organ.toLowerCase()).materialSignature);
    expect(newMaterial.color).not.toBe(oldMaterial.color);
    delete oldMaterial.color; delete newMaterial.color; delete newMaterial.reference_color;
    expect(newMaterial).toEqual(oldMaterial);
    await page.locator(".whole-scene-canvas canvas").screenshot({ path: info.outputPath(`${organ.toLowerCase()}-after.png`) });
    records.push({ organ, before, after });
    await page.getByRole("button", { name: "Restore previous colours", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).referenceColors).toEqual(before.referenceColors);
    await page.getByRole("button", { name: "Scene controls", exact: true }).click();
  }
  await writeFile(info.outputPath("focused-organ-evidence.json"), JSON.stringify(records, null, 2));
});
