import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import fixture from "./fixtures/atlas-material-v2.json" with { type: "json" };
import type { AtlasSpec } from "../../apps/studio/src/atlas";

const controlKeys = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"];
const positions = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
const catalog = {
  organs: [{ id: "liver", label: "Liver", templates: [{ id: "liver-reference", label: "Reference", source: "Synthetic test geometry", license: "Original test fixture" }] }],
  controls: controlKeys.map((key, index) => ({ key, label: ["Width", "Height", "Depth", "Bend", "Twist", "Taper", "Asymmetry"][index], min: -1, max: 1, default: 0 })), materials: fixture.catalog,
};
async function setup(page: Page, mobile = false) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const generated: AtlasSpec[] = [];
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: catalog }));
  await page.route("**/api/atlas/generate", route => {
    const spec = route.request().postDataJSON() as AtlasSpec, material = spec.material;
    generated.push(spec);
    const resolved = material ? structuredClone(fixture.resolved.liver[material.preset]) : null;
    return route.fulfill({ json: { spec: { ...spec, realized_id: "example-fixture" }, summary: {}, scene: {
      organs: [{ id: "organ", name: "Test organ", kind: "organ", color: "#913831", positions, indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2], ...(material ? { rest_positions: positions, material_regions: [0, 0, 0, 0] } : {}) }],
      metadata: { geometry_sha256: `fixture-${JSON.stringify(spec.controls)}`, ...(material ? { material_v2: { recipe: material, resolved } } : {}) },
    } } });
  });
  await page.goto("/");
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  if (mobile) await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  return generated;
}
const sampleButton = (page: Page, number: number) => page.getByRole("button", { name: `Use colon reference ${number}`, exact: true });
const analyzeButton = (page: Page) => page.getByRole("button", { name: "Analyse reference region", exact: true });
const applyButton = (page: Page) => page.getByRole("button", { name: "Apply reference colour", exact: true });
const exampleReview = (page: Page) => page.getByRole("checkbox", { name: "I reviewed this colon example and want its colour on Liver.", exact: true });
async function displayedImage(page: Page) {
  return (await page.getByTestId("reference-image-selection").locator("img").first().getAttribute("src"))!.split(",")[1]!;
}
function result(image: string) {
  return { version: "reference-analysis-1", organ: "liver", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), width: 960, height: 540,
    mask_png_base64: image, overlay_png_base64: image, palette_srgb: [[0.6, 0.5, 0.43]],
    quality: { selected_pixels: 10000, accepted_pixels: 7000, accepted_fraction: 0.7 }, warnings: ["Example test analysis."],
    reference_color: { version: "reference-color-1", organ: "liver", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), observed_srgb: [0.6, 0.5, 0.43], strength: 1, mode: "chroma" },
  };
}

test("all three built-in examples load usable regions, require review and succeed with the real analyzer", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const generated = await setup(page), requests: any[] = [], analyses: any[] = [];
  page.on("request", request => { if (request.url().endsWith("/api/atlas/reference-material/analyze")) requests.push(request.postDataJSON()); });
  for (const number of [1, 2, 3]) {
    await sampleButton(page, number).click();
    await expect(page.getByTestId("reference-image-selection")).toBeVisible();
    await expect(analyzeButton(page)).toBeEnabled();
    await expect(applyButton(page)).toHaveCount(0);
    expect(requests).toHaveLength(number - 1); expect(generated).toHaveLength(1);
    const response = page.waitForResponse(response => response.url().endsWith("/api/atlas/reference-material/analyze"));
    await analyzeButton(page).click();
    const received = await response; expect(received.status()).toBe(200);
    const analysis = await received.json(); analyses.push(analysis);
    expect(analysis.quality.accepted_pixels).toBeGreaterThan(1000);
    expect(requests.at(-1).selection.foreground_points.length).toBeGreaterThan(0);
    await expect(page.getByRole("img", { name: "Tissue segmentation overlay", exact: true })).toBeVisible();
    await expect(exampleReview(page)).not.toBeChecked();
    await expect(applyButton(page)).toBeDisabled();
    await page.getByTestId("reference-image-selection").scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`colon-example-${number}-review.png`) });
  }
  expect(new Set(analyses.map(analysis => analysis.source_sha256)).size).toBe(3);
  await exampleReview(page).check(); await applyButton(page).click();
  await expect.poll(() => generated.at(-1)?.material?.reference_color?.source_sha256).toBe(analyses[2].source_sha256);
  expect(generated.at(-1)?.material?.reference_color?.organ).toBe("liver");
  expect(generated.at(-1)?.controls).toEqual(generated[0]!.controls);
  expect(errors).toEqual([]);
  await writeFile(info.outputPath("example-analysis-evidence.json"), JSON.stringify({ requests: requests.map(({ image_base64, ...request }) => ({ ...request, encoded_image_length: image_base64.length })), analyses }, null, 2));
});

test("switching examples discards late analysis and previously checked review", async ({ page }) => {
  const generated = await setup(page);
  await sampleButton(page, 1).click(); await expect(analyzeButton(page)).toBeEnabled();
  const image = await displayedImage(page);
  let release!: () => void, started!: () => void, completed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), sent = new Promise<void>(resolve => { started = resolve; }), delivered = new Promise<void>(resolve => { completed = resolve; });
  await page.route("**/api/atlas/reference-material/analyze", async route => { started(); await gate; await route.fulfill({ json: result(image) }).catch(() => {}); completed(); });
  await analyzeButton(page).click(); await sent;
  await sampleButton(page, 2).click(); release(); await delivered;
  await expect(analyzeButton(page)).toBeEnabled();
  await expect(applyButton(page)).toHaveCount(0);
  await analyzeButton(page).click(); await expect(exampleReview(page)).not.toBeChecked();
  await exampleReview(page).check(); await expect(applyButton(page)).toBeEnabled();
  await sampleButton(page, 3).click(); await expect(analyzeButton(page)).toBeEnabled();
  await expect(applyButton(page)).toHaveCount(0);
  await analyzeButton(page).click(); await expect(exampleReview(page)).not.toBeChecked();
  await expect(applyButton(page)).toBeDisabled();
  expect(generated).toHaveLength(1);
});

test("an uploaded image supersedes a late example load and uses the original organ confirmation", async ({ page }) => {
  await setup(page);
  const image = await readFile("apps/studio/public/reference-material/colon-view-2.png");
  let release!: () => void, started!: () => void, completed!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), sent = new Promise<void>(resolve => { started = resolve; }), delivered = new Promise<void>(resolve => { completed = resolve; });
  await page.route("**/reference-material/colon-view-1.png", async route => { started(); await gate; await route.fulfill({ body: image, contentType: "image/png" }).catch(() => {}); completed(); });
  await sampleButton(page, 1).click(); await sent;
  await page.getByLabel("Reference image", { exact: true }).setInputFiles({ name: "my-reviewed-upload.png", mimeType: "image/png", buffer: image });
  await expect(page.getByText("my-reviewed-upload.png", { exact: true })).toBeVisible();
  release(); await delivered;
  await expect(page.getByText("my-reviewed-upload.png", { exact: true })).toBeVisible();
  await expect(analyzeButton(page)).toBeDisabled();
  await page.getByRole("button", { name: "Select entire image", exact: true }).click();
  await page.route("**/api/atlas/reference-material/analyze", route => route.fulfill({ json: result(image.toString("base64")) }));
  await analyzeButton(page).click();
  await expect(page.getByRole("checkbox", { name: "I confirm the highlighted tissue is Liver.", exact: true })).toBeVisible();
  await expect(exampleReview(page)).toHaveCount(0);
  await expect(applyButton(page)).toBeDisabled();
});

test("example gallery remains usable at 390px and displays all three choices without overflow", async ({ page }, info) => {
  await setup(page, true);
  for (const number of [1, 2, 3]) {
    await sampleButton(page, number).scrollIntoViewIfNeeded();
    await expect(sampleButton(page, number)).toBeVisible();
  }
  await sampleButton(page, 1).click();
  await expect(analyzeButton(page)).toBeEnabled();
  await sampleButton(page, 1).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("colon-examples-mobile.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Close anatomy controls", exact: true })).toBeVisible();
  await expect(applyButton(page)).toHaveCount(0);
});
