import { expect, test, type Page } from "@playwright/test";
import fixture from "./fixtures/atlas-material-v2.json" with { type: "json" };
import type { AtlasSpec } from "../../apps/studio/src/atlas";

const keys = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"];
const catalog = {
  organs: ["liver", "kidney"].map((id) => ({ id, label: id === "liver" ? "Liver" : "Kidney", templates: [{ id: `${id}-reference`, label: "Reference", source: "Fixture atlas", license: "CC BY 4.0" }] })),
  controls: keys.map((key, index) => ({ key, label: ["Width", "Height", "Depth", "Bend", "Twist", "Taper", "Asymmetry"][index], min: -1, max: 1, default: 0 })),
  materials: fixture.catalog,
};
const positions = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
function generation(spec: AtlasSpec) {
  const material = spec.material;
  const shapedPositions = positions.map((value, index) => value * (1 + 0.35 * (spec.controls[["scale_x", "scale_y", "scale_z"][index % 3]!] ?? 0)));
  const resolved = material ? structuredClone(fixture.resolved[material.organ as "liver" | "kidney"][material.preset]) : null;
  if (resolved && material) {
    Object.assign(resolved.uniforms, { uAtlasSeed: material.seed, uAtlasPigmentContrast: material.pigment_contrast, uAtlasMottleScaleMm: material.mottle_scale_mm, uAtlasWetness: material.wetness, uAtlasFineDetail: material.fine_detail, uAtlasStructureStrength: material.structure_strength });
  }
  return {
    spec: { ...spec, realized_id: `bound-${material?.seed ?? "v1"}-${material?.fine_detail ?? 0}` }, summary: {},
    scene: { organs: [{ id: "reference", name: "Reference", kind: "organ", color: "#913831", positions: shapedPositions, indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
      ...(material ? { rest_positions: positions, material_regions: [0, 0, 0, 0] } : {}) }],
      metadata: { geometry_sha256: `geometry-${spec.template_id}-${JSON.stringify(spec.controls)}`,
        ...(material ? { material_v2: { recipe: material, resolved } } : {}) } },
  };
}
async function setup(page: Page) {
  const generated: AtlasSpec[] = [], exported: AtlasSpec[] = [], sampled: { spec: AtlasSpec; seed: number }[] = [];
  await page.route("**/api/atlas/catalog", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/atlas/generate", (route) => { const spec = route.request().postDataJSON() as AtlasSpec; generated.push(spec); return route.fulfill({ json: generation(spec) }); });
  await page.route("**/api/atlas/sample-material", (route) => {
    const request = route.request().postDataJSON() as { spec: AtlasSpec; seed: number }; sampled.push(request);
    const result = generation({ ...request.spec, material: { ...request.spec.material!, seed: request.seed, fine_detail: 0.88 } });
    return route.fulfill({ json: { ...result, summary: { material_model: { model_sha256: "fixture-material-prior", sampling: "empirical_training_bootstrap" } } } });
  });
  await page.route("**/api/atlas/export", (route) => {
    exported.push(route.request().postDataJSON().spec); const bytes = Buffer.alloc(12); bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(12, 8);
    return route.fulfill({ contentType: "model/gltf-binary", body: bytes });
  });
  await page.goto("/"); await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  return { generated, exported, sampled };
}
test("surface presets and valid appearance seeds update live while retaining shape edits", async ({ page }) => {
  const { generated, exported } = await setup(page);
  await page.getByRole("slider", { name: "Width", exact: true }).fill("0.4");
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Surface", exact: true })).toHaveCSS("border-bottom-color", "rgb(141, 187, 169)");
  await page.getByRole("tab", { name: "Surface", exact: true }).press("ArrowLeft");
  await expect(page.getByRole("tab", { name: "Shape", exact: true })).toBeFocused();
  await page.getByRole("tab", { name: "Shape", exact: true }).press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Surface", exact: true })).toBeFocused();
  await expect(page.getByRole("button", { name: /surface preset/ })).toHaveCount(4);
  await page.getByRole("button", { name: "Rich pigment surface preset", exact: true }).click();
  await page.getByRole("textbox", { name: "Appearance seed", exact: true }).fill("701");
  await expect.poll(() => generated.at(-1)?.material?.seed).toBe(701);
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  expect(generated.at(-1)).toMatchObject({ seed: 42, controls: { scale_x: 0.4 }, material: { preset: "rich", seed: 701 } });
  await page.getByRole("tab", { name: "Shape", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Width", exact: true })).toHaveValue("0.4");
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download;
  expect(exported.at(-1)).toMatchObject({ controls: { scale_x: 0.4 }, material: { preset: "rich", seed: 701 }, realized_id: expect.any(String) });
});

test("surface edits during an in-flight shape preview compose both edits and ignore the old response", async ({ page }) => {
  const { exported } = await setup(page);
  let releaseShape!: () => void;
  let startedShape!: () => void;
  let deliveredShape!: () => void;
  const shapeGate = new Promise<void>((resolve) => { releaseShape = resolve; });
  const shapeStarted = new Promise<void>((resolve) => { startedShape = resolve; });
  const shapeDelivered = new Promise<void>((resolve) => { deliveredShape = resolve; });
  const requests: AtlasSpec[] = [];
  await page.route("**/api/atlas/generate", async (route) => {
    const spec = route.request().postDataJSON() as AtlasSpec;
    requests.push(spec);
    if (requests.length === 1) {
      startedShape(); await shapeGate;
      await route.fulfill({ json: generation(spec) }).catch(() => {});
      deliveredShape();
    } else await route.fulfill({ json: generation(spec) });
  });
  await page.getByRole("slider", { name: "Width", exact: true }).fill("0.6");
  await shapeStarted;
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  const detail = page.getByRole("slider", { name: "Fine surface detail", exact: true });
  await expect(detail).toBeEnabled();
  await detail.fill("0.92");
  releaseShape(); await shapeDelivered;
  await expect(detail).toHaveValue("0.92");
  await expect.poll(() => requests.at(-1)?.material?.fine_detail).toBe(0.92);
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ controls: { scale_x: 0.6 }, material: { fine_detail: 0.92 } });
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download;
  expect(exported.at(-1)).toMatchObject({ controls: { scale_x: 0.6 }, material: { fine_detail: 0.92 } });
});

test("surface sliders change the rendered finish without changing geometry", async ({ page }) => {
  const { generated, exported } = await setup(page);
  const initial = structuredClone(generated[0]!);
  const canvas = page.getByTestId("atlas-viewport").locator("canvas");
  const before = await canvas.screenshot();
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await page.getByRole("slider", { name: "Surface wetness", exact: true }).fill("1");
  await expect.poll(() => generated.at(-1)?.material?.wetness).toBe(1);
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  expect(generated.at(-1)?.controls).toEqual(initial.controls);
  expect(generated.at(-1)?.seed).toBe(initial.seed);
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download;
  expect(exported.at(-1)).toMatchObject({ controls: initial.controls, material: { wetness: 1 } });
});

test("source and clay requests omit tissue materials and tissue restores the committed recipe", async ({ page }) => {
  const { generated } = await setup(page);
  const material = structuredClone(generated[0]!.material);
  await page.getByRole("slider", { name: "Width", exact: true }).fill("0.4");
  await expect.poll(() => generated.at(-1)?.controls.scale_x).toBe(0.4);
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  for (const mode of ["Clay", "Source"]) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect(page.getByRole("button", { name: mode, exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(generated.at(-1)?.material).toBeUndefined();
    expect(generated.at(-1)?.controls.scale_x).toBe(0.4);
  }
  await page.getByRole("button", { name: "Tissue", exact: true }).click();
  await expect(page.getByRole("button", { name: "Tissue", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(generated.at(-1)?.material).toEqual(material);
  await expect(page.getByRole("slider", { name: "Width", exact: true })).toHaveValue("0.4");
});
test("surface sampling uses the selected preset and seed without changing shape", async ({ page }) => {
  const { generated, sampled, exported } = await setup(page);
  const initial = generated[0]!;
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await page.getByRole("button", { name: "Moist surface preset", exact: true }).click();
  await page.getByRole("textbox", { name: "Appearance seed", exact: true }).fill("4294967295");
  await page.getByRole("button", { name: "Sample surface", exact: true }).click();
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  expect(sampled.at(-1)).toMatchObject({ seed: 4294967295, spec: { controls: initial.controls, seed: initial.seed, material: { preset: "moist" } } });
  await expect(page.getByRole("slider", { name: "Fine surface detail", exact: true })).toHaveValue("0.88");
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download;
  expect(exported.at(-1)?.material).toMatchObject({ seed: 4294967295, fine_detail: 0.88 });
});
test("invalid seeds, changed geometry and unavailable material models preserve the preview", async ({ page }) => {
  const { generated, exported } = await setup(page);
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await page.getByRole("textbox", { name: "Appearance seed", exact: true }).fill("-1");
  await page.getByRole("button", { name: "Apply surface", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("appearance seed"); expect(generated).toHaveLength(1);
  await page.route("**/api/atlas/generate", (route) => { const result = generation(route.request().postDataJSON()); result.scene.metadata.geometry_sha256 = "wrong-geometry"; return route.fulfill({ json: result }); });
  await page.getByRole("textbox", { name: "Appearance seed", exact: true }).fill("99");
  await expect(page.getByRole("alert")).toContainText("did not preserve the displayed geometry");
  await page.route("**/api/atlas/sample-material", (route) => route.fulfill({ status: 503, json: { detail: "Material prior unavailable" } }));
  await page.getByRole("button", { name: "Sample surface", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Material prior unavailable");
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download;
  expect(exported.at(-1)?.material?.seed).toBe(42);
});
test("a failed organ selection restores the displayed reference and leaves surface controls usable", async ({ page }) => {
  const { generated, exported } = await setup(page);
  const initial = structuredClone(generated[0]!);
  const requests: AtlasSpec[] = [];
  await page.route("**/api/atlas/generate", (route) => {
    const spec = route.request().postDataJSON() as AtlasSpec;
    requests.push(spec);
    return spec.template_id === "kidney-reference"
      ? route.fulfill({ status: 503, json: { detail: "Kidney reference is temporarily unavailable" } })
      : route.fulfill({ json: generation(spec) });
  });
  await page.getByRole("button", { name: /02 Kidney/ }).click();
  await expect(page.getByRole("alert")).toContainText("Kidney reference is temporarily unavailable");
  await expect(page.getByRole("heading", { level: 1, name: "Liver", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /01 Liver/ })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /02 Kidney/ })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  const detail = page.getByRole("slider", { name: "Fine surface detail", exact: true });
  await expect(detail).toBeEnabled();
  await detail.fill("0.91");
  await expect.poll(() => requests.at(-1)?.material?.fine_detail).toBe(0.91);
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests.at(-1)).toMatchObject({ template_id: "liver-reference", controls: initial.controls, material: { organ: "liver", fine_detail: 0.91 } });
  await expect(page.getByRole("alert")).toHaveCount(0);
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download;
  expect(exported.at(-1)).toMatchObject({ template_id: "liver-reference", material: { organ: "liver", fine_detail: 0.91 } });
});

test("material controls stay open after live updates at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await setup(page);
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  await page.getByRole("button", { name: "Rich pigment surface preset", exact: true }).click();
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rich pigment surface preset", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close anatomy controls", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Fine surface detail", exact: true }).fill("0.72");
  await expect(page.getByText("Preview matches this surface", { exact: true })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Fine surface detail", exact: true })).toHaveValue("0.72");
  await expect(page.getByRole("slider", { name: "Fine surface detail", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Tissue", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
