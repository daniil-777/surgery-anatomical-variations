import { expect, test, type Page } from "@playwright/test";

const controls = [
  ["scale_x", "Width"], ["scale_y", "Height"], ["scale_z", "Depth"],
  ["bend", "Bend"], ["twist", "Twist"], ["taper", "Taper"], ["asymmetry", "Asymmetry"],
].map(([key, label]) => ({ key, label, min: -1, max: 1, default: 0 }));
const catalog = {
  organs: [
    { id: "liver", label: "Liver", templates: [{ id: "liver-f", label: "Female reference", source: "Human Reference Atlas", license: "CC BY 4.0", source_url: "https://humanatlas.io/3d-reference-library" }] },
    { id: "kidney", label: "Kidney", templates: [{ id: "kidney-l", label: "Left kidney reference", source: "Human Reference Atlas", license: "CC BY 4.0" }] },
  ], controls, release: "test-fixture",
};
interface Spec { template_id: string; seed: number; controls: Record<string, number>; appearance: string; }
const referencePositions = [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70];
const mesh = (spec: Spec) => ({
  scene: { organs: [{ id: "reference", name: "Reference test surface", kind: "organ", color: "#913831",
    positions: referencePositions.map((value, index) => value * (1 + 0.35 * (spec.controls[["scale_x", "scale_y", "scale_z"][index % 3]!] ?? 0))), indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2] }] },
  spec: { ...spec, source_hash: "saved-lineage" }, summary: { expert_reviewed: false },
});
async function installApi(page: Page, url = "/?mode=atlas") {
  const generated: Spec[] = [];
  const sampled: { spec: Spec; match_dimensions: boolean }[] = [];
  const exported: { spec: Spec & { source_hash?: string }; format: string }[] = [];
  await page.route("**/api/atlas/catalog", (route) => route.fulfill({ json: catalog }));
  await page.route("**/api/atlas/generate", async (route) => {
    const spec = route.request().postDataJSON() as Spec;
    generated.push(spec);
    await route.fulfill({ json: mesh(spec) });
  });
  await page.route("**/api/atlas/sample", async (route) => {
    const request = route.request().postDataJSON() as { spec: Spec; match_dimensions: boolean };
    sampled.push(request);
    const result = mesh({ ...request.spec, controls: { ...request.spec.controls, bend: 0.22 } });
    await route.fulfill({ json: {
      ...result, spec: { ...result.spec, source_hash: "learned-lineage", realized_id: "learned-specimen" },
      summary: { model: { method: "ridge", model_sha256: "fixture-model", scope: "within_generator_design_distribution", match_dimensions: request.match_dimensions } },
    } });
  });
  await page.route("**/api/atlas/export", async (route) => {
    exported.push(route.request().postDataJSON());
    const bytes = Buffer.alloc(12); bytes.write("glTF", 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(12, 8);
    await route.fulfill({ contentType: "model/gltf-binary", body: bytes });
  });
  await page.route("**/api/atlas/compile", async (route) => {
    const { text, spec } = route.request().postDataJSON() as { text: string; spec: Spec };
    await route.fulfill({ json: text.includes("wider")
      ? { status: "accepted", message: "Width increased within the bounded shape range.", spec: { ...spec, controls: { ...spec.controls, scale_x: 0.2 } } }
      : { status: "unsupported", message: "This request is outside the supported shape controls." } });
  });
  await page.goto(url);
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  return { generated, sampled, exported };
}

test("the default workspace is Atlas with an explicit legacy return link", async ({ page }) => {
  await installApi(page, "/");
  await expect(page.getByRole("heading", { level: 1, name: "Liver", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Procedural studio", exact: true })).toHaveAttribute("href", "?mode=legacy");
});

test("atlas browsing, cameras and materials use explicit source recipes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { generated } = await installApi(page);
  await expect(page.getByRole("heading", { level: 1, name: "Liver", exact: true })).toBeVisible();
  await expect(page.getByRole("slider")).toHaveCount(7);
  await expect(page.getByTestId("atlas-viewport").locator("canvas")).toBeVisible();
  await page.getByRole("button", { name: "Clay", exact: true }).click();
  await expect(page.getByRole("button", { name: "Clay", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(generated.at(-1)?.appearance).toBe("clay");
  await page.getByRole("button", { name: "Top", exact: true }).click();
  await page.getByRole("button", { name: "Fit organ in view", exact: true }).click();
  await page.getByRole("button", { name: /02 Kidney/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Kidney", exact: true })).toBeVisible();
  expect(generated.at(-1)?.template_id).toBe("kidney-l");
  await page.getByRole("button", { name: "Reference and validation details", exact: true }).click();
  await expect(page.getByText("Mechanical simulation is not enabled", { exact: false })).toBeVisible();
  expect(errors).toEqual([]);
});

test("shape sliders update geometry and the canvas without Generate, and reset updates live", async ({ page }) => {
  const { generated, exported } = await installApi(page);
  const canvas = page.getByTestId("atlas-viewport").locator("canvas");
  const before = await canvas.screenshot();
  await page.getByRole("slider", { name: "Width", exact: true }).fill("0.8");
  await expect.poll(() => generated.at(-1)?.controls.scale_x).toBe(0.8);
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  await expect(page.locator(".atlas-dimensions")).toContainText("153.6");
  expect((await canvas.screenshot()).equals(before)).toBe(false);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GLB", exact: true }).click();
  await download;
  expect(exported.at(-1)?.spec).toMatchObject({ controls: { scale_x: 0.8 }, source_hash: "saved-lineage" });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(() => generated.at(-1)?.controls.scale_x).toBe(0);
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  await expect(page.locator(".atlas-dimensions")).toContainText("120.0");
});

test("rapid edits win over stale responses, including while the latest edit is debouncing", async ({ page }) => {
  const { exported } = await installApi(page);
  let releaseOld!: () => void;
  let oldStarted!: () => void;
  let oldDelivered!: () => void;
  let releaseLatest!: () => void;
  let latestStarted!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldRequest = new Promise<void>((resolve) => { oldStarted = resolve; });
  const oldResponse = new Promise<void>((resolve) => { oldDelivered = resolve; });
  const latestGate = new Promise<void>((resolve) => { releaseLatest = resolve; });
  const latestRequest = new Promise<void>((resolve) => { latestStarted = resolve; });
  await page.route("**/api/atlas/generate", async (route) => {
    const spec = route.request().postDataJSON() as Spec;
    if (spec.controls.scale_x === 0.2) { oldStarted(); await oldGate; }
    else if (spec.controls.scale_x === 0.8) { latestStarted(); await latestGate; }
    await route.fulfill({ json: mesh(spec) }).catch(() => {});
    if (spec.controls.scale_x === 0.2) oldDelivered();
  });
  const width = page.getByRole("slider", { name: "Width", exact: true });
  await width.fill("0.2");
  await oldRequest;
  await expect(width).toBeEnabled();
  await width.fill("0.4");
  await width.fill("0.8");
  releaseOld();
  await oldResponse;
  // The old response arrives before the 240 ms debounce expires. It must not
  // replace the original preview, reset the slider, or cancel the latest edit.
  await expect(width).toHaveValue("0.8");
  await expect(page.locator(".atlas-dimensions")).toContainText("120.0");
  await latestRequest;
  releaseLatest();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  await expect(page.locator(".atlas-dimensions")).toContainText("153.6");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GLB", exact: true }).click();
  await download;
  expect(exported.at(-1)?.spec.controls.scale_x).toBe(0.8);
});

test("failed live edits keep the last valid displayed geometry and export", async ({ page }) => {
  const { exported } = await installApi(page);
  await page.route("**/api/atlas/generate", (route) => route.fulfill({ status: 422, json: { detail: "Requested deformation failed geometry validation" } }));
  await page.getByRole("slider", { name: "Width", exact: true }).fill("0.8");
  await expect(page.getByRole("alert")).toContainText("failed geometry validation");
  await expect(page.getByRole("slider", { name: "Width", exact: true })).toHaveValue("0.8");
  await expect(page.locator(".atlas-dimensions")).toContainText("120.0");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GLB", exact: true }).click();
  await download;
  expect(exported.at(-1)?.spec).toMatchObject({ controls: { scale_x: 0 }, source_hash: "saved-lineage" });
});

test("unsupported text leaves anatomy untouched and accepted text is realized", async ({ page }) => {
  const { generated } = await installApi(page);
  const before = generated.length;
  await page.getByRole("textbox", { name: "Describe an anatomy variation" }).fill("Add a tumor");
  await page.getByRole("button", { name: "Apply text instruction" }).click();
  await expect(page.getByText("This request is outside the supported shape controls.")).toBeVisible();
  expect(generated.length).toBe(before);
  await page.getByRole("textbox", { name: "Describe an anatomy variation" }).fill("Make the liver wider");
  await page.getByRole("button", { name: "Apply text instruction" }).click();
  await expect(page.getByText("Width increased within the bounded shape range.")).toBeVisible();
  expect(generated.at(-1)?.controls.scale_x).toBe(0.2);
  await expect(page.getByRole("slider", { name: "Width", exact: true })).toHaveValue("0.2");
});

test("sampled shape replays from the same seed and different seeds alter geometry", async ({ page }) => {
  const { generated } = await installApi(page);
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("1234");
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  const first = structuredClone(generated.at(-1)!);
  expect(first.seed).toBe(1234);
  expect(Object.values(first.controls).some((amount) => amount !== 0)).toBe(true);
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  expect(generated.at(-1)?.controls).toEqual(first.controls);
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("1235");
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  expect(generated.at(-1)?.controls).not.toEqual(first.controls);
});

test("Generate variation produces a fresh seed and changed shape on every click", async ({ page }) => {
  const { generated } = await installApi(page);
  await expect(page.getByRole("combobox", { name: "Variation range", exact: true })).toHaveValue("1");
  const recipes: Spec[] = [];
  for (let index = 0; index < 3; index++) {
    const previousCount = generated.length;
    await page.getByRole("button", { name: "Generate variation", exact: true }).click();
    await expect.poll(() => generated.length).toBe(previousCount + 1);
    await expect(page.getByText("Preview matches this recipe")).toBeVisible();
    recipes.push(structuredClone(generated.at(-1)!));
  }
  expect(new Set(recipes.map((spec) => spec.seed)).size).toBe(3);
  expect(new Set(recipes.map((spec) => JSON.stringify(spec.controls))).size).toBe(3);
});

test("sampling range changes deformation strength while an explicit seed remains replayable", async ({ page }) => {
  const { generated } = await installApi(page);
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("8421");
  await page.getByRole("combobox", { name: "Variation range", exact: true }).selectOption("0.4");
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  const subtle = structuredClone(generated.at(-1)!);
  await page.getByRole("combobox", { name: "Variation range", exact: true }).selectOption("1");
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  const broad = generated.at(-1)!;
  expect(broad.seed).toBe(subtle.seed);
  for (const key of Object.keys(broad.controls)) {
    expect(Math.abs(broad.controls[key]!)).toBeGreaterThanOrEqual(Math.abs(subtle.controls[key]!));
  }
  expect(broad.controls).not.toEqual(subtle.controls);
});

test("learned variation preserves requested identity, applies returned controls and exports its committed recipe", async ({ page }) => {
  const { generated, sampled, exported } = await installApi(page);
  const directCount = generated.length;
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("33");
  await expect(page.getByRole("checkbox", { name: "Keep overall dimensions" })).not.toBeChecked();
  await page.getByRole("button", { name: "Learned variation", exact: true }).click();
  await expect(page.getByText("Model variation applied", { exact: true })).toBeVisible();
  expect(sampled.at(-1)?.match_dimensions).toBe(false);
  expect(sampled.at(-1)?.spec).toMatchObject({ template_id: "liver-f", seed: 33, appearance: "tissue" });
  await expect(page.getByRole("slider", { name: "Bend", exact: true })).toHaveValue("0.22");
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  expect(generated.length).toBe(directCount);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GLB", exact: true }).click();
  await download;
  expect(exported.at(-1)?.spec).toMatchObject({ seed: 33, source_hash: "learned-lineage", controls: { bend: 0.22 } });
  await page.getByRole("checkbox", { name: "Keep overall dimensions" }).check();
  await page.getByRole("button", { name: "Learned variation", exact: true }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  expect(sampled.at(-1)?.match_dimensions).toBe(true);
});

test("a failed or mismatched learned response preserves the displayed specimen without a fallback", async ({ page }) => {
  const { generated, exported } = await installApi(page);
  const directCount = generated.length;
  await page.route("**/api/atlas/sample", (route) => route.fulfill({ status: 503, json: { detail: "The trained model is unavailable." } }));
  await page.getByRole("button", { name: "Learned variation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The trained model is unavailable.");
  await page.route("**/api/atlas/sample", (route) => {
    const { spec } = route.request().postDataJSON() as { spec: Spec };
    return route.fulfill({ json: { ...mesh({ ...spec, template_id: "kidney-l" }), summary: { model: { method: "ridge" } } } });
  });
  await page.getByRole("button", { name: "Learned variation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("did not preserve the requested reference");
  await expect(page.getByRole("heading", { level: 1, name: "Liver", exact: true })).toBeVisible();
  expect(generated.length).toBe(directCount);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export GLB", exact: true }).click();
  await download;
  expect(exported.at(-1)?.spec).toMatchObject({ template_id: "liver-f", source_hash: "saved-lineage", controls: { bend: 0 } });
});

test("invalid seeds and malformed response geometry do not replace a valid preview", async ({ page }) => {
  const { generated } = await installApi(page);
  const before = generated.length;
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("-1");
  await page.getByRole("button", { name: "Sample shape from seed", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("whole number");
  expect(generated.length).toBe(before);
  await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill("42");
  await page.route("**/api/atlas/generate", (route) => route.fulfill({ json: { ...mesh(route.request().postDataJSON()), scene: { organs: [] } } }));
  await page.getByRole("button", { name: "Generate variation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("no organ meshes");
  await expect(page.getByRole("heading", { level: 1, name: "Liver", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
});

test("an older organ request cannot overwrite a later selection", async ({ page }) => {
  await installApi(page);
  let releaseKidney!: () => void;
  let markStarted!: () => void;
  let markDelivered!: () => void;
  const gate = new Promise<void>((resolve) => { releaseKidney = resolve; });
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
  await page.route("**/api/atlas/generate", async (route) => {
    const spec = route.request().postDataJSON() as Spec;
    if (spec.template_id === "kidney-l") {
      markStarted();
      await gate;
      await route.fulfill({ json: mesh(spec) }).catch(() => {});
      markDelivered();
    } else await route.fulfill({ json: mesh(spec) });
  });
  await page.getByRole("button", { name: /02 Kidney/ }).click();
  await started;
  await page.getByRole("button", { name: /01 Liver/ }).click();
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  releaseKidney();
  await delivered;
  await expect(page.getByRole("heading", { level: 1, name: "Liver", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /01 Liver/ })).toHaveAttribute("aria-pressed", "true");
});

test("atlas controls remain usable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installApi(page);
  await page.getByRole("button", { name: "Shape", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Width", exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Width", exact: true }).fill("0.6");
  await expect(page.getByText("Preview matches this recipe")).toBeVisible();
  await expect(page.locator(".atlas-dimensions")).toContainText("145.2");
  await expect(page.getByRole("slider", { name: "Width", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close shape controls" })).toBeVisible();
  await page.getByRole("button", { name: "Close shape controls" }).click();
  await page.getByRole("button", { name: "Organs", exact: true }).click();
  await page.getByRole("button", { name: /02 Kidney/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Kidney", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
