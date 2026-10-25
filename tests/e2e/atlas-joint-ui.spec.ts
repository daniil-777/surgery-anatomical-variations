import { expect, test, type Page } from "@playwright/test";
import materialFixture from "./fixtures/atlas-material-v2.json" with { type: "json" };
import profileFixture from "../../py/viscera_core/disease_profiles.json" with { type: "json" };
import type { AtlasSpec } from "../../apps/studio/src/atlas";

const baseStatus = { source: "defaults", bundle_sha256: null, max_upload_bytes: 134217728, joint_generation: 1 };
const jointLane = { status: "active", method: "joint_conditional_vae", scope: "Synthetic coupled shape, color and disease variation" };
const defaults = { ...baseStatus, joint_bundle_sha256: "c".repeat(64), lanes: { joint: { ...jointLane, source: "bundled_default" } } };
const active = { ...baseStatus, joint_bundle_sha256: "a".repeat(64), lanes: { joint: { ...jointLane, source: "imported" } } };
const unavailable = { ...baseStatus, joint_bundle_sha256: null, lanes: {} };
const rest = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
function generation(spec: AtlasSpec) {
  const material = spec.material;
  const resolved = material ? structuredClone(materialFixture.resolved.liver[material.preset]) : null;
  if (resolved && material) Object.assign(resolved.uniforms, { uAtlasSeed: material.seed, uAtlasPigmentContrast: material.pigment_contrast, uAtlasMottleScaleMm: material.mottle_scale_mm, uAtlasWetness: material.wetness, uAtlasFineDetail: material.fine_detail, uAtlasStructureStrength: material.structure_strength });
  return { spec: { ...spec, realized_id: "bound-geometry" }, summary: {} as Record<string, unknown>, scene: {
    organs: [{ id: "liver", name: "Liver", kind: "organ", color: "#913831", positions: rest.map((value, i) => value * (1 + 0.2 * spec.controls.bend!) + (i === 0 ? (spec.disease?.severity ?? 0) * 20 : 0)), indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2],
      ...(material ? { rest_positions: rest, material_regions: [0, 0, 0, 0] } : {}),
      ...(spec.disease ? { metadata: { disease_field: { version: "disease-morphology-design-1.0.0", fields: [{ center_mm: [0, 0, 0], radius_mm: 95, direction: [0, 0, 1], amplitude_mm: 1 }], target_srgb: [0.6, 0.4, 0.3], color_strength: spec.disease.contrast * spec.disease.severity } } } : {}) }],
    metadata: { geometry_sha256: JSON.stringify([spec.template_id, spec.controls, spec.disease ?? null]), ...(material ? { material_v2: { recipe: material, resolved } } : {}) } } };
}
interface JointRequest { spec: AtlasSpec; seed: number; temperature: number }
function sampled(request: JointRequest, bundle = defaults.joint_bundle_sha256) {
  const value = ((request.seed % 1009) / 1009) * request.temperature;
  const result = generation({ ...request.spec, seed: request.seed, appearance: "tissue", controls: { bend: value }, material: { ...materialFixture.catalog.defaults.liver, tint: value * 0.3 }, ...(request.spec.disease ? { disease: { ...request.spec.disease, seed: 54, severity: 0.4 + value * 0.2 } } : {}) });
  result.summary.joint_model = { bundle_sha256: bundle, model_sha256: "b".repeat(64), request_seed: request.seed, temperature: request.temperature, template_id: request.spec.template_id, profile_id: request.spec.disease?.profile_id ?? null, material_seed: result.spec.material!.seed, spatial_seed: result.spec.disease?.seed ?? null };
  return result;
}
async function setup(page: Page, initial: "bundled" | "missing" | "imported" = "bundled") {
  const exported: AtlasSpec[] = [], requests: JointRequest[] = [], errors: string[] = [];
  let status = initial === "imported" ? active : initial === "missing" ? unavailable : defaults;
  page.on("pageerror", error => errors.push(error.message));
  const profiles = profileFixture.profiles.filter(p => p.organ === "liver");
  await page.route("**/api/atlas/models", route => route.fulfill({ json: status }));
  await page.route("**/api/atlas/models/joint/history", route => route.fulfill({ json: {
    versions: status.joint_bundle_sha256 ? [{ generation: 1, bundle_sha256: status.joint_bundle_sha256, active: true, integrity: "verified", conditions: 2, runtime: { device: "cpu" } }] : [],
    selected_generation: 1, active_bundle: status.joint_bundle_sha256, selection_error: null,
  } }));
  await page.route("**/api/atlas/models/import", route => { status = active; return route.fulfill({ json: status }); });
  await page.route("**/api/atlas/models/defaults", route => { status = defaults; return route.fulfill({ json: status }); });
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: {
    organs: [{ id: "liver", label: "Liver", templates: [{ id: "liver-reference", label: "Reference", source: "Fixture", license: "Test" }] }],
    controls: [{ key: "bend", label: "Bend", min: -1, max: 1, default: 0 }], materials: materialFixture.catalog,
    diseases: { version: "disease-morphology-design-1.0.0", profiles,
      controls: ["severity", "size", "spread", "irregularity", "contrast", "count"].map(key => ({ key, label: key, min: key === "count" ? 1 : 0, max: key === "count" ? 8 : 1, default: key === "count" ? 3 : 0.5 })),
      defaults: { liver: { profile_id: "liver-cirrhosis", seed: 42, severity: 0.55, size: 0.5, spread: 0.5, irregularity: 0.35, contrast: 0.45, count: 3, location: [0.25, 0.15, 0.8] } } },
  } }));
  await page.route("**/api/atlas/generate", route => route.fulfill({ json: generation(route.request().postDataJSON()) }));
  await page.route("**/api/atlas/sample-joint", route => { const request = route.request().postDataJSON(); requests.push(request); return route.fulfill({ json: sampled(request, status.joint_bundle_sha256!) }); });
  await page.route("**/api/atlas/export", route => { exported.push(route.request().postDataJSON().spec); const bytes = Buffer.alloc(12); bytes.write("glTF"); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(12, 8); return route.fulfill({ contentType: "model/gltf-binary", body: bytes }); });
  await page.goto("/");
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  return { exported, requests, errors };
}
async function exportSpec(page: Page) { const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export GLB", exact: true }).click(); await download; }

test("a fresh browser uses bundled joint defaults without importing, replays seed and updates shape and color", async ({ page }, info) => {
  const { requests, exported, errors } = await setup(page);
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Choose generation model", exact: true })).toContainText("Generative Model 1 · CPU");
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await expect(page.getByText("Packaged default models", { exact: true })).toBeVisible();
  await expect(page.getByText("Your imported weights are active", { exact: true })).toHaveCount(0);
  await expect(page.getByText(defaults.joint_bundle_sha256, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await page.getByRole("textbox", { name: "Joint variation seed", exact: true }).fill("201");
  await page.getByRole("slider", { name: "Joint variation temperature", exact: true }).fill("0.7");
  await page.getByRole("button", { name: "Generative Model 1 variation", exact: true }).click();
  await expect(page.getByText("Generative Model 1 variation applied", { exact: true })).toBeVisible();
  await exportSpec(page); const first = structuredClone(exported.at(-1)!);
  expect(requests.at(-1)).toMatchObject({ seed: 201, temperature: 0.7 });
  expect(first.controls.bend).not.toBe(0); expect(first.material!.tint).not.toBe(0);
  await page.getByRole("button", { name: "Generative Model 1 variation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await exportSpec(page); expect(exported.at(-1)).toEqual(first);
  await page.getByRole("button", { name: "New joint variation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await exportSpec(page); expect(exported.at(-1)!.seed).not.toBe(201);
  await page.getByRole("slider", { name: "Bend", exact: true }).fill("0.4");
  await expect(page.getByText("Generative Model 1 variation applied", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await exportSpec(page); expect(exported.at(-1)!.controls.bend).toBe(0.4);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("joint-baseline-studio.png") });
});

test("joint disease variation is available in Disease and refuses a mismatched result without replacing the organ", async ({ page }, info) => {
  const { requests, exported, errors } = await setup(page);
  await page.getByRole("tab", { name: "Disease", exact: true }).click();
  await page.getByRole("combobox", { name: "Disease profile", exact: true }).selectOption("liver-hcc");
  await expect(page.getByText("Preview matches this recipe", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Joint variation seed", exact: true }).fill("301");
  await page.getByRole("button", { name: "Generative Model 1 variation", exact: true }).click();
  await expect(page.getByText("Generative Model 1 variation applied", { exact: true })).toBeVisible();
  await exportSpec(page); const good = structuredClone(exported.at(-1)!);
  expect(requests.at(-1)!.spec.disease!.profile_id).toBe("liver-hcc");
  expect(good.disease!.severity).not.toBe(0.55); expect(good.disease!.profile_id).toBe("liver-hcc");
  await page.route("**/api/atlas/sample-joint", route => { const result = sampled(route.request().postDataJSON()); (result.summary.joint_model as Record<string, unknown>).request_seed = 0; return route.fulfill({ json: result }); });
  await page.getByRole("button", { name: "Generative Model 1 variation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("previous preview was preserved");
  await exportSpec(page); expect(exported.at(-1)).toEqual(good);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("joint-disease-studio.png") });
});

test("a joint import overrides bundled weights and Restore defaults keeps joint sampling available", async ({ page }) => {
  const { requests, errors } = await setup(page);
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await page.getByLabel("Model weight archive").setInputFiles({ name: "viscera-joint-weights.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await expect(page.getByText(active.joint_bundle_sha256, { exact: true })).toBeVisible();
  await expect(page.getByText("Your imported weights are active", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restore defaults", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "Disease", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await page.getByRole("button", { name: "Restore defaults", exact: true }).click();
  await expect(page.getByText("Packaged default models", { exact: true })).toBeVisible();
  await expect(page.getByText(defaults.joint_bundle_sha256, { exact: true })).toBeVisible();
  await expect(page.getByText(active.joint_bundle_sha256, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Generative Model 1 variation", exact: true }).click();
  await expect(page.getByText("Generative Model 1 variation applied", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("a minimal deployment without bundled weights still accepts an explicit joint import", async ({ page }) => {
  await setup(page, "missing");
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await page.getByLabel("Model weight archive").setInputFiles({ name: "viscera-joint-weights.zip", mimeType: "application/zip", buffer: Buffer.from("fixture") });
  await page.getByRole("button", { name: "Validate & activate", exact: true }).click();
  await expect(page.getByText("Your imported weights are active", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Generative Model 1 variation", exact: true })).toBeEnabled();
});

// These contract tests model an online service, independent of the preview host.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", route => route.fulfill({ json: { status: "ok" } }));
});
