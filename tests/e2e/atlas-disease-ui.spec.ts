import { expect, test, type Page } from "@playwright/test";
import materialFixture from "./fixtures/atlas-material-v2.json" with { type: "json" };
import profileFixture from "../../py/viscera_core/disease_profiles.json" with { type: "json" };
import type { AtlasSpec } from "../../apps/studio/src/atlas";

const allOrgans = [...new Set(profileFixture.profiles.map(profile => profile.organ))];
function catalog(organs = ["liver", "kidney"], materials = true) {
  const profiles = profileFixture.profiles.filter(profile => organs.includes(profile.organ));
  return { organs: organs.map(id => ({ id, label: id, templates: [{ id: `${id}-reference`, label: `${id} reference`, source: "Test atlas", license: "CC BY 4.0" }] })),
    controls: [{ key: "bend", label: "Bend", min: -1, max: 1, default: 0 }],
    ...(materials ? { materials: materialFixture.catalog } : {}),
    diseases: { version: "disease-morphology-design-1.0.0", profiles,
      controls: ["severity", "size", "spread", "irregularity", "contrast", "count"].map(key => ({ key, label: key, min: key === "count" ? 1 : 0, max: key === "count" ? 8 : 1, default: key === "count" ? 3 : 0.5 })),
      defaults: Object.fromEntries(organs.map(organ => [organ, { profile_id: profiles.find(profile => profile.organ === organ && profile.supported)!.id, seed: 42, severity: 0.55, size: 0.5, spread: 0.5, irregularity: 0.35, contrast: 0.45, count: 3, location: [0.25, 0.15, 0.8] }])) } };
}
const rest = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
function generation(spec: AtlasSpec) {
  const material = spec.material;
  const resolved = material ? structuredClone(materialFixture.resolved[material.organ as "liver" | "kidney"][material.preset]) : null;
  if (resolved && material) Object.assign(resolved.uniforms, { uAtlasSeed: material.seed, uAtlasPigmentContrast: material.pigment_contrast, uAtlasMottleScaleMm: material.mottle_scale_mm, uAtlasWetness: material.wetness, uAtlasFineDetail: material.fine_detail, uAtlasStructureStrength: material.structure_strength });
  return { spec: { ...spec, realized_id: "server-bound-geometry" }, summary: {}, scene: {
    organs: [{ id: "organ", name: "Reference", kind: "organ", color: "#913831", positions: rest.map((value, i) => value * (1 + 0.15 * (spec.controls.bend ?? 0)) + (i === 0 ? (spec.disease?.severity ?? 0) * 20 : 0)), indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
      ...(material ? { rest_positions: rest, material_regions: [0, 0, 0, 0] } : {}),
      ...(spec.disease ? { metadata: { disease_field: { version: "disease-morphology-design-1.0.0", fields: [{ center_mm: [0, 0, 0], radius_mm: 95, direction: [0, 0, 1], amplitude_mm: 1 }], target_srgb: [0.6, 0.4, 0.3], color_strength: spec.disease.contrast * spec.disease.severity } } } : {}) }],
    metadata: { geometry_sha256: JSON.stringify([spec.template_id, spec.controls, spec.disease ?? null]), ...(material ? { material_v2: { recipe: material, resolved } } : {}) } } };
}
async function setup(page: Page, everyOrgan = false) {
  const generated: AtlasSpec[] = [], exported: AtlasSpec[] = [], sampled: { spec: AtlasSpec; seed: number }[] = [];
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message)); page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
  const library = everyOrgan ? catalog(allOrgans, false) : catalog();
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: library }));
  await page.route("**/api/atlas/generate", route => { const spec = route.request().postDataJSON() as AtlasSpec; generated.push(spec); return route.fulfill({ json: generation(spec) }); });
  await page.route("**/api/atlas/sample-disease", route => {
    const request = route.request().postDataJSON() as { spec: AtlasSpec; seed: number }; sampled.push(request);
    return route.fulfill({ json: { ...generation({ ...request.spec, disease: { ...request.spec.disease!, seed: (request.seed ^ 1234567) >>> 0, severity: 0.81 } }), summary: { disease_model: { model_sha256: "test-trained-prior", population: "synthetic-design", request_seed: request.seed, spatial_seed: (request.seed ^ 1234567) >>> 0, profile_id: request.spec.disease!.profile_id } } } });
  });
  await page.route("**/api/atlas/export", route => { exported.push(route.request().postDataJSON().spec); const bytes = Buffer.alloc(12); bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(12, 8); return route.fulfill({ contentType: "model/gltf-binary", body: bytes }); });
  await page.goto("/"); await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  if ((page.viewportSize()?.width ?? 1600) <= 700) await page.getByRole("button", { name: "Shape", exact: true }).click();
  await page.getByRole("tab", { name: "Disease", exact: true }).click();
  return { generated, exported, sampled, errors, library };
}
async function enable(page: Page, id = "liver-cirrhosis") {
  await page.getByRole("combobox", { name: "Disease profile" }).selectOption(id);
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
}
async function exportSpec(page: Page) { const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download; }

test("disease sliders update geometry, keep shape and PBR surface settings, and export the displayed recipe", async ({ page }, testInfo) => {
  const { generated, exported, errors } = await setup(page);
  const initial = generated[0]!;
  await enable(page);
  await page.getByRole("slider", { name: "Morphology intensity", exact: true }).fill("0.9");
  await expect.poll(() => generated.at(-1)?.disease?.severity).toBe(0.9);
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  expect(generated.at(-1)?.controls).toEqual(initial.controls); expect(generated.at(-1)?.material).toEqual(initial.material);
  await exportSpec(page); expect(exported.at(-1)).toMatchObject({ disease: { profile_id: "liver-cirrhosis", severity: 0.9 }, realized_id: "server-bound-geometry" });
  await page.screenshot({ path: testInfo.outputPath("disease-desktop.png") });
  expect(errors).toEqual([]);
});

test("all twelve organ families expose only their compatible supported disease profiles", async ({ page }) => {
  const { generated, library } = await setup(page, true);
  for (const organ of allOrgans) {
    await page.locator(".atlas-organ-button").filter({ hasText: organ }).click();
    await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
    const supported = library.diseases.profiles.find(profile => profile.organ === organ && profile.supported)!;
    const options = page.getByRole("combobox", { name: "Disease profile" }).locator("option");
    await expect(options).toHaveCount(4);
    await enable(page, supported.id);
    expect(generated.at(-1)?.disease?.profile_id).toBe(supported.id);
    await expect(page.getByRole("slider")).toHaveCount(9);
    for (const profile of library.diseases.profiles.filter(profile => profile.organ === organ && !profile.supported)) await expect(options.filter({ hasText: profile.label })).toHaveJSProperty("disabled", true);
  }
});

test("Generate variation changes disease as well as shape and replays from an explicit seed", async ({ page }) => {
  const { generated } = await setup(page); await enable(page);
  const variants: AtlasSpec[] = [];
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Generate variation", exact: true }).click();
    await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible(); variants.push(structuredClone(generated.at(-1)!));
  }
  expect(new Set(variants.map(spec => spec.disease!.seed)).size).toBe(3);
  expect(new Set(variants.map(spec => JSON.stringify(spec.disease))).size).toBe(3);
  expect(variants.every(spec => spec.seed === spec.disease!.seed)).toBe(true);
  await page.getByRole("tab", { name: "Shape", exact: true }).click();
  await expect(page.getByRole("button", { name: "Learned variation", exact: true })).toBeDisabled();
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("901");
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible(); const first = structuredClone(generated.at(-1)!);
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible(); expect(generated.at(-1)).toEqual(first);
});

test("learned disease sampling preserves the organ recipe and rejects forged seed provenance", async ({ page }) => {
  const { generated, exported, sampled } = await setup(page); await enable(page);
  await page.getByRole("textbox", { name: "Disease seed", exact: true }).fill("73");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible(); const initial = structuredClone(generated.at(-1)!);
  await page.getByRole("button", { name: "Learned disease variation", exact: true }).click();
  await expect(page.getByText("Disease model variation applied", { exact: true })).toBeVisible();
  expect(sampled.at(-1)).toMatchObject({ seed: 73, spec: { seed: initial.seed, controls: initial.controls, material: initial.material } });
  await exportSpec(page); expect(exported.at(-1)?.disease?.severity).toBe(0.81);
  await expect(page.getByRole("textbox", { name: "Disease seed", exact: true })).toHaveValue(String((73 ^ 1234567) >>> 0));
  await page.route("**/api/atlas/sample-disease", route => {
    const request = route.request().postDataJSON(); return route.fulfill({ json: { ...generation(request.spec), summary: { disease_model: { model_sha256: "bad-prior", request_seed: request.seed, spatial_seed: 0, profile_id: request.spec.disease.profile_id } } } });
  });
  await page.getByRole("button", { name: "Learned disease variation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("did not preserve");
  await exportSpec(page); expect(exported.at(-1)?.controls).toEqual(initial.controls); expect(exported.at(-1)?.disease?.severity).toBe(0.81);
});

test("rapid shape and disease edits compose, reject stale responses and preserve an invalid seed being typed", async ({ page }) => {
  const { exported } = await setup(page); await enable(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let reached!: () => void; const requested = new Promise<void>(resolve => { reached = resolve; });
  await page.route("**/api/atlas/generate", async route => {
    const spec = route.request().postDataJSON() as AtlasSpec;
    if (spec.disease?.severity === 0.66) { reached(); await held; }
    try { await route.fulfill({ json: generation(spec) }); } catch { /* The superseded fetch may be aborted. */ }
  });
  await page.getByRole("slider", { name: "Morphology intensity", exact: true }).fill("0.66"); await requested;
  await page.getByRole("textbox", { name: "Disease seed", exact: true }).fill("-1"); release();
  await expect(page.getByRole("textbox", { name: "Disease seed", exact: true })).toHaveValue("-1");
  await page.getByRole("button", { name: "Apply disease parameters", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("disease seed");
  await exportSpec(page); expect(exported.at(-1)?.disease?.severity).toBe(0.55);
  await page.getByRole("textbox", { name: "Disease seed", exact: true }).fill("81");
  await page.getByRole("tab", { name: "Shape", exact: true }).click(); await page.getByRole("slider", { name: "Bend", exact: true }).fill("0.4");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  await exportSpec(page); expect(exported.at(-1)).toMatchObject({ controls: { bend: 0.4 }, disease: { seed: 81, severity: 0.66 } });
});

test("baseline removal restores shape-only sampling and mobile disease controls remain open", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { generated, errors } = await setup(page);
  await enable(page);
  await page.getByRole("slider", { name: "Disease location X", exact: true }).fill("-0.4");
  await expect(page.getByRole("slider", { name: "Disease location X", exact: true })).toBeVisible();
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("disease-mobile.png") });
  await page.getByRole("combobox", { name: "Disease profile" }).selectOption("");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible(); expect(generated.at(-1)?.disease).toBeUndefined();
  await page.getByRole("tab", { name: "Shape", exact: true }).click(); await expect(page.getByRole("button", { name: "Learned variation", exact: true })).toBeEnabled(); expect(errors).toEqual([]);
});
