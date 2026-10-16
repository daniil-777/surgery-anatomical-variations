import { expect, test, type Page } from "@playwright/test";
import { SphereGeometry } from "three";
import fixture from "./fixtures/atlas-material-v2.json" with { type: "json" };
import type { AtlasGeneration, AtlasSpec } from "../../apps/studio/src/atlas";

const keys = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"];
const catalog = {
  organs: ["liver", "kidney"].map(id => ({ id, label: id === "liver" ? "Liver" : "Kidney", templates: [{ id: `${id}-reference`, label: "Reference", source: "Synthetic test surface", license: "Original test fixture" }] })),
  controls: keys.map((key, index) => ({ key, label: ["Width", "Height", "Depth", "Bend", "Twist", "Taper", "Asymmetry"][index], min: -1, max: 1, default: 0 })), materials: fixture.catalog,
};
const sphere = new SphereGeometry(75, 48, 32);
sphere.scale(1.4, 0.9, 1);
const positions = Array.from(sphere.attributes.position!.array), indices = Array.from(sphere.index!.array);
async function setup(page: Page) {
  const generated: AtlasSpec[] = [], exported: Record<string, any>[] = [];
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: catalog }));
  await page.route("**/api/atlas/generate", route => {
    const spec = route.request().postDataJSON() as AtlasSpec, material = spec.material;
    generated.push(spec);
    const resolved = material ? structuredClone(fixture.resolved[material.organ as "liver" | "kidney"][material.preset]) : null;
    return route.fulfill({ json: { spec: { ...spec, realized_id: "reference-fixture" }, summary: {}, scene: {
      organs: [{ id: "organ", name: "Test organ", kind: "organ", color: "#913831", positions, indices,
        ...(material ? { rest_positions: positions, material_regions: positions.filter((_, index) => index % 3 === 0).map(() => 0) } : {}) }],
      metadata: { geometry_sha256: `fixture-${spec.template_id}-${JSON.stringify(spec.controls)}`, ...(material ? { material_v2: { recipe: material, resolved } } : {}) },
    } } });
  });
  await page.route("**/api/atlas/export", route => {
    const request = route.request().postDataJSON(); exported.push(request);
    return route.fulfill({ body: Buffer.from(request.format === "unity" ? [80, 75, 3, 4] : [103, 108, 84, 70]), contentType: request.format === "unity" ? "application/zip" : "model/gltf-binary" });
  });
  await page.goto("/"); await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  return { generated, exported };
}
async function syntheticImage(page: Page) {
  const encoded = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 180;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#151719"; context.fillRect(0, 0, 240, 180);
    const gradient = context.createRadialGradient(115, 75, 8, 120, 90, 110);
    gradient.addColorStop(0, "#cf756d"); gradient.addColorStop(1, "#954d45");
    context.fillStyle = gradient; context.beginPath(); context.ellipse(120, 90, 98, 66, 0, 0, Math.PI * 2); context.fill();
    context.fillStyle = "#fffefa"; context.beginPath(); context.ellipse(92, 65, 9, 5, 0, 0, Math.PI * 2); context.fill();
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  return { name: "synthetic-tissue.png", mimeType: "image/png", buffer: Buffer.from(encoded, "base64") };
}
async function upload(page: Page) {
  const image = await syntheticImage(page);
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await page.getByLabel("Reference image", { exact: true }).setInputFiles(image);
  await expect(page.getByTestId("reference-image-selection")).toBeVisible();
  await page.getByRole("button", { name: "Select entire image", exact: true }).click();
  return image;
}
async function download(page: Page) {
  const promise = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await promise;
}
function analysis(image: string) {
  return { version: "reference-analysis-1", organ: "liver", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), width: 240, height: 180,
    mask_png_base64: image, overlay_png_base64: image, palette_srgb: [[0.65, 0.28, 0.22]], observed_color_srgb: [0.65, 0.28, 0.22],
    quality: { selected_pixels: 4000, accepted_pixels: 3900, accepted_fraction: 0.975 }, warnings: ["Synthetic test reference."], segmentation: { method: "test-mask" },
    reference_color: { version: "reference-color-1", organ: "liver", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), observed_srgb: [0.65, 0.28, 0.22], strength: 1, mode: "chroma" },
  };
}

test("real local analysis requires organ review and preserves the exported sculpture when applying and clearing colour", async ({ page }) => {
  await page.route("**/api/atlas/reference-material/status", route => route.fulfill({ json: { sam2: { configured: false }, default_segmentation: "local" } }));
  const { generated, exported } = await setup(page);
  await page.getByRole("tab", { name: "Sculpt", exact: true }).click();
  const bounds = (await page.getByTestId("atlas-viewport").boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5); await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.55, bounds.y + bounds.height * 0.46, { steps: 12 }); await page.mouse.up();
  await expect(page.getByRole("button", { name: "Undo sculpture", exact: true })).toBeEnabled(); await download(page);
  const sculpture = structuredClone(exported.at(-1)!.surface_edits);
  expect(sculpture).toHaveLength(1);
  await upload(page);
  const response = page.waitForResponse(response => response.url().endsWith("/api/atlas/reference-material/analyze"));
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(page.getByRole("img", { name: "Tissue segmentation overlay", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeDisabled();
  expect(generated).toHaveLength(1);
  await page.getByRole("slider", { name: "Reference transfer strength", exact: true }).fill("0.83");
  await page.getByRole("combobox", { name: "Reference transfer mode", exact: true }).selectOption("color");
  await page.getByRole("checkbox", { name: "I confirm the highlighted tissue is Liver.", exact: true }).check();
  await page.getByRole("button", { name: "Apply reference colour", exact: true }).click();
  await expect(page.getByText("Reference colour applied · 83% · colour and brightness", { exact: true })).toBeVisible();
  expect(generated.at(-1)?.material?.reference_color).toMatchObject({ organ: "liver", mode: "color", strength: 0.83 });
  expect(generated.at(-1)?.controls).toEqual(generated[0]!.controls);
  await download(page); expect(exported.at(-1)!.surface_edits).toEqual(sculpture);
  expect(exported.at(-1)!.spec.material.reference_color.source_sha256).toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Clear reference colour", exact: true }).click();
  await expect(page.getByText(/Reference colour applied/)).toHaveCount(0);
  await download(page); expect(exported.at(-1)!.surface_edits).toEqual(sculpture);
  expect(exported.at(-1)!.spec.material.reference_color).toBeNull();
});

test("changing selection, source or organ invalidates reference analysis and late responses", async ({ page }) => {
  const { generated } = await setup(page), image = await upload(page);
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), sent = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/atlas/reference-material/analyze", async route => { started(); await gate; await route.fulfill({ json: analysis(image.buffer.toString("base64")) }).catch(() => {}); });
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click(); await sent;
  await page.getByRole("button", { name: "Select entire image", exact: true }).click(); release();
  await expect(page.getByRole("button", { name: "Analyse reference region", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I confirm the highlighted tissue/ }).check();
  await page.getByLabel("Reference image", { exact: true }).setInputFiles({ ...image, name: "different-reference.png" });
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Select entire image", exact: true }).click();
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: /02 Kidney/ }).click();
  await expect(page.getByRole("heading", { name: "Kidney", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toHaveCount(0);
  expect(generated.every(spec => !spec.material?.reference_color)).toBe(true);
});

test("failed reference analysis leaves the displayed recipe untouched", async ({ page }) => {
  await page.route("**/api/atlas/reference-material/status", route => route.fulfill({ json: { sam2: { configured: true }, default_segmentation: "sam2" } }));
  const { generated } = await setup(page); await upload(page);
  const backends: string[] = [];
  await page.route("**/api/atlas/reference-material/analyze", route => { backends.push(route.request().postDataJSON().segmentation); return route.fulfill({ status: 503, json: { detail: "SAM 2 checkpoint is not configured." } }); });
  await expect(page.getByText("Segmentation: SAM 2.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("checkpoint is not configured");
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toHaveCount(0);
  expect(generated).toHaveLength(1);
  expect(backends).toEqual(["sam2"]);
});

test("late model availability cannot override the selected segmentation method", async ({ page }) => {
  let release!: () => void, delivered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), completed = new Promise<void>(resolve => { delivered = resolve; });
  await page.route("**/api/atlas/reference-material/status", async route => { await gate; await route.fulfill({ json: { sam2: { configured: true }, default_segmentation: "sam2" } }); delivered(); });
  await setup(page); const image = await upload(page);
  await page.getByText("Mask and segmentation options", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Use configured SAM 2 model", exact: true }).check();
  await page.getByRole("checkbox", { name: "Use configured SAM 2 model", exact: true }).uncheck();
  release(); await completed;
  let backend = "";
  await page.route("**/api/atlas/reference-material/analyze", route => { backend = route.request().postDataJSON().segmentation; return route.fulfill({ json: analysis(image.buffer.toString("base64")) }); });
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeDisabled();
  expect(backend).toBe("local");
});

test("an uploaded reviewed PNG mask is used by the real analysis endpoint", async ({ page }) => {
  await setup(page); await upload(page);
  const mask = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 240; canvas.height = 180;
    const context = canvas.getContext("2d")!; context.fillStyle = "black"; context.fillRect(0, 0, 240, 180);
    context.fillStyle = "white"; context.beginPath(); context.ellipse(120, 90, 90, 58, 0, 0, Math.PI * 2); context.fill();
    const pixels = context.getImageData(0, 0, 240, 180);
    for (let i = 0; i < pixels.data.length; i += 4) pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = pixels.data[i]! > 127 ? 255 : 0;
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await page.getByText("Mask and segmentation options", { exact: true }).click();
  await page.getByLabel("Reference mask", { exact: true }).setInputFiles({ name: "reviewed-mask.png", mimeType: "image/png", buffer: Buffer.from(mask, "base64") });
  await expect(page.getByText("Segmentation: reviewed mask.", { exact: true })).toBeVisible();
  const response = page.waitForResponse(response => response.url().endsWith("/api/atlas/reference-material/analyze"));
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  const result = await response; expect(result.status()).toBe(200);
  expect((await result.json()).segmentation).toMatchObject({ method: "uploaded-mask", learned: false });
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeDisabled();
});

test("mobile reference review supports a precise region and keeps the panel within the viewport", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  const image = await upload(page);
  let request: Record<string, any> | undefined;
  await page.route("**/api/atlas/reference-material/analyze", route => { request = route.request().postDataJSON(); return route.fulfill({ json: analysis(image.buffer.toString("base64")) }); });
  await page.getByText("Mask and segmentation options", { exact: true }).click();
  await page.getByRole("spinbutton", { name: "Reference region left", exact: true }).fill("10");
  await page.getByRole("spinbutton", { name: "Reference region top", exact: true }).fill("10");
  await page.getByRole("spinbutton", { name: "Reference region right", exact: true }).fill("90");
  await page.getByRole("spinbutton", { name: "Reference region bottom", exact: true }).fill("90");
  await page.getByText("Mask and segmentation options", { exact: true }).click();
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeDisabled();
  expect(request?.selection.box).toEqual([0.1, 0.1, 0.9, 0.9]);
  await page.getByRole("checkbox", { name: /I confirm the highlighted tissue/ }).check();
  await expect(page.getByRole("button", { name: "Apply reference colour", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Apply reference colour", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath("reference-mobile-review.png") });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(page.getByRole("button", { name: "Close anatomy controls", exact: true })).toBeVisible();
});

test("live reference transfer changes the actual rendered material while keeping geometry identical", async ({ page }, info) => {
  // This controlled colour fixture is synthetic; the surgical-reference test exercises SAM 2 on real tissue.
  await page.route("**/api/atlas/reference-material/status", route => route.fulfill({ json: { sam2: { configured: false }, default_segmentation: "local" } }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const initialResponse = page.waitForResponse(response => response.url().endsWith("/api/atlas/generate") && response.ok());
  await page.goto("/?template=hra-liver-female");
  const initial = await (await initialResponse).json() as AtlasGeneration;
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  const canvas = page.getByTestId("atlas-viewport").locator("canvas");
  const before = await canvas.screenshot();
  await upload(page);
  const analysisResponse = page.waitForResponse(response => response.url().endsWith("/api/atlas/reference-material/analyze"));
  await page.getByRole("button", { name: "Analyse reference region", exact: true }).click();
  expect((await analysisResponse).status()).toBe(200);
  await page.getByRole("checkbox", { name: "I confirm the highlighted tissue is Liver.", exact: true }).check();
  await page.getByRole("slider", { name: "Reference transfer strength", exact: true }).fill("1");
  await page.getByRole("combobox", { name: "Reference transfer mode", exact: true }).selectOption("color");
  const appliedResponse = page.waitForResponse(response => response.url().endsWith("/api/atlas/generate") && response.ok());
  await page.getByRole("button", { name: "Apply reference colour", exact: true }).click();
  const applied = await (await appliedResponse).json() as AtlasGeneration;
  await expect(page.getByText("Reference colour applied · 100% · colour and brightness", { exact: true })).toBeVisible();
  expect(applied.spec.material?.reference_color?.strength).toBe(1);
  expect(applied.scene.metadata?.geometry_sha256).toBe(initial.scene.metadata?.geometry_sha256);
  expect(applied.scene.organs[0]!.positions).toEqual(initial.scene.organs[0]!.positions);
  expect(applied.scene.metadata?.material_v2).not.toEqual(initial.scene.metadata?.material_v2);
  const after = await canvas.screenshot({ path: info.outputPath("reference-material-live.png") });
  expect(after.equals(before)).toBe(false); expect(errors).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
