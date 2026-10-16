import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AtlasGeneration } from "../../apps/studio/src/atlas";

// The receipt is generated independently from the downloaded ZIP manifest.
// A successful HTTP response alone does not prove the requested weights served it.
interface Receipt { bundle_sha256: string; model_hashes: { shape: string; material: string; disease: string } }
let receipt: Receipt;
test.beforeAll(async () => {
  const file = process.env.VISCERA_COLAB_EXPECTED_RECEIPT;
  if (!file) throw new Error("Set VISCERA_COLAB_EXPECTED_RECEIPT to the independently verified ZIP receipt JSON");
  receipt = JSON.parse(await readFile(file, "utf8")) as Receipt;
  for (const hash of [receipt.bundle_sha256, ...Object.values(receipt.model_hashes)]) expect(hash).toMatch(/^[a-f0-9]{64}$/);
});

async function responseTo(page: Page, suffix: string, action: () => Promise<unknown>): Promise<AtlasGeneration> {
  const waiting = page.waitForResponse(response => response.url().endsWith(suffix) && response.request().method() === "POST");
  await action();
  const response = await waiting;
  expect(response.status(), await response.text()).toBe(200);
  const value = await response.json() as AtlasGeneration;
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  return value;
}

function geometry(generation: AtlasGeneration): unknown { return generation.scene.metadata?.geometry_sha256; }
function provenance(generation: AtlasGeneration, key: string): Record<string, unknown> { return generation.summary[key] as Record<string, unknown>; }
function assertModel(generation: AtlasGeneration, lane: keyof Receipt["model_hashes"], key: string) {
  expect(provenance(generation, key).model_sha256).toBe(receipt.model_hashes[lane]);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  const canvas = page.getByTestId("atlas-viewport").locator("canvas");
  const image = await canvas.evaluate(async (element: HTMLCanvasElement) => {
    for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
    const source = new Image(); source.src = element.toDataURL("image/png"); await source.decode();
    const copy = document.createElement("canvas"); copy.width = source.width; copy.height = source.height;
    const context = copy.getContext("2d")!; context.drawImage(source, 0, 0);
    const values = context.getImageData(0, 0, copy.width, copy.height).data;
    let opaque = 0; for (let i = 3; i < values.length; i += 4) if (values[i]! > 200) opaque++;
    return { opaque, png: source.src.split(",")[1]! };
  });
  expect(image.opaque).toBeGreaterThan(10000);
  await writeFile(info.outputPath(`${name}-organ.png`), Buffer.from(image.png, "base64"));
  await page.screenshot({ path: info.outputPath(`${name}-studio.png`) });
  return { opaquePixels: image.opaque, pngSha256: createHash("sha256").update(image.png).digest("hex") };
}

test("actual Colab weights drive learned geometry, surface, disease, editable recipes and GLB export", async ({ page }, info) => {
  const browserErrors: string[] = [];
  page.on("pageerror", error => browserErrors.push(error.message));
  const initial = await responseTo(page, "/api/atlas/generate", () => page.goto("/?template=hra-liver-female"));
  const status = await (await page.request.get("/api/atlas/models")).json();
  expect(status.source).toBe("imported"); expect(status.bundle_sha256).toBe(receipt.bundle_sha256);
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await expect(page.getByText(receipt.bundle_sha256, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  // Keep this lane deterministic while the optional language worker may be enabled.
  const trainedToggle = page.getByRole("checkbox", { name: "Use trained text adapter · shape edits, compiler guarded", exact: true });
  if (await trainedToggle.count()) await trainedToggle.uncheck();

  await page.getByRole("checkbox", { name: "Keep overall dimensions", exact: true }).uncheck();
  const shapes: AtlasGeneration[] = [];
  for (const seed of [4101, 4101, 4102]) {
    await page.getByRole("textbox", { name: "Variation seed", exact: true }).fill(String(seed));
    shapes.push(await responseTo(page, "/api/atlas/sample", () => page.getByRole("button", { name: "Learned variation", exact: true }).click()));
    assertModel(shapes.at(-1)!, "shape", "model");
  }
  expect(shapes[0]!.spec).toEqual(shapes[1]!.spec);
  expect(geometry(shapes[0]!)).toBe(geometry(shapes[1]!));
  expect(geometry(shapes[2]!)).not.toBe(geometry(shapes[1]!));
  expect(shapes.every(item => item.spec.template_id === initial.spec.template_id)).toBe(true);
  const shapeFrame = await screenshot(page, info, "01-learned-shape");
  const edited = await responseTo(page, "/api/atlas/generate", () => page.getByRole("slider", { name: "Width", exact: true }).fill("0.8"));
  expect(edited.spec.controls.scale_x).toBe(0.8);
  expect(geometry(edited)).not.toBe(geometry(shapes[2]!));
  expect(edited.spec.material).toEqual(shapes[2]!.spec.material);

  await page.getByRole("tab", { name: "Surface", exact: true }).click();
  const surfaces: AtlasGeneration[] = [];
  for (const seed of [5201, 5201, 5202]) {
    await page.getByRole("textbox", { name: "Appearance seed", exact: true }).fill(String(seed));
    surfaces.push(await responseTo(page, "/api/atlas/sample-material", () => page.getByRole("button", { name: "Sample surface", exact: true }).click()));
    assertModel(surfaces.at(-1)!, "material", "material_model");
    expect(geometry(surfaces.at(-1)!)).toBe(geometry(edited));
  }
  expect(surfaces[0]!.spec.material).toEqual(surfaces[1]!.spec.material);
  expect(surfaces[2]!.spec.material).not.toEqual(surfaces[1]!.spec.material);
  const surfaceFrame = await screenshot(page, info, "02-learned-surface");

  await page.getByRole("tab", { name: "Disease", exact: true }).click();
  const diseasedBaseline = await responseTo(page, "/api/atlas/generate", () => page.getByRole("combobox", { name: "Disease profile", exact: true }).selectOption("liver-hcc"));
  const diseases: AtlasGeneration[] = [];
  for (const seed of [6301, 6301, 6302]) {
    await page.getByRole("textbox", { name: "Disease seed", exact: true }).fill(String(seed));
    diseases.push(await responseTo(page, "/api/atlas/sample-disease", () => page.getByRole("button", { name: "Learned disease variation", exact: true }).click()));
    const value = diseases.at(-1)!; assertModel(value, "disease", "disease_model");
    expect(value.spec.controls).toEqual(diseasedBaseline.spec.controls);
    expect(value.spec.material).toEqual(diseasedBaseline.spec.material);
    expect(provenance(value, "disease_model").request_seed).toBe(seed);
  }
  expect(diseases[0]!.spec.disease).toEqual(diseases[1]!.spec.disease);
  expect(geometry(diseases[0]!)).toBe(geometry(diseases[1]!));
  expect(diseases[2]!.spec.disease).not.toEqual(diseases[1]!.spec.disease);
  const diseaseFrame = await screenshot(page, info, "03-learned-disease");
  const diseaseEdit = await responseTo(page, "/api/atlas/generate", () => page.getByRole("slider", { name: "Morphology intensity", exact: true }).fill("0.72"));
  expect(diseaseEdit.spec.disease!.severity).toBe(0.72);
  expect(diseaseEdit.spec.controls).toEqual(diseasedBaseline.spec.controls);

  // Width is already near its positive bound; shrinking is a reachable edit.
  await page.getByRole("textbox", { name: "Describe an anatomy variation", exact: true }).fill("slightly narrower");
  const compiledResponse = page.waitForResponse(item => item.url().endsWith("/api/atlas/compile"));
  const textEdited = await responseTo(page, "/api/atlas/generate", () => page.getByRole("button", { name: "Apply text instruction", exact: true }).click());
  const compiled = await (await compiledResponse).json();
  expect(compiled.status).toBe("accepted");
  expect(textEdited.spec.disease).toEqual(diseaseEdit.spec.disease);
  expect(textEdited.spec.material).toEqual(diseaseEdit.spec.material);
  expect(textEdited.spec.controls).not.toEqual(diseaseEdit.spec.controls);

  // Real 512px bake/export of exactly the browser-displayed recipe; no route mocks.
  const glbResponse = await page.request.post("/api/atlas/export", { data: { spec: textEdited.spec, format: "glb", texture_resolution: 512 }, timeout: 120000 });
  expect(glbResponse.status(), await glbResponse.text()).toBe(200);
  const glb = await glbResponse.body();
  expect(glb.toString("ascii", 0, 4)).toBe("glTF"); expect(glb.readUInt32LE(4)).toBe(2); expect(glb.readUInt32LE(8)).toBe(glb.length);
  const gltf = JSON.parse(glb.toString("utf8", 20, 20 + glb.readUInt32LE(12)).trim());
  expect(gltf.meshes.length).toBeGreaterThan(0); expect(gltf.images.length).toBeGreaterThan(0);
  expect(gltf.scenes[0].extras.spec).toEqual(textEdited.spec);
  expect(gltf.scenes[0].extras.geometry_sha256).toBe(geometry(textEdited));
  const binaryOffset = 20 + glb.readUInt32LE(12) + 8;
  for (const image of gltf.images) {
    expect(image.mimeType).toBe("image/png");
    const offset = binaryOffset + (gltf.bufferViews[image.bufferView].byteOffset ?? 0);
    expect(glb.readUInt32BE(offset + 16)).toBe(512);
    expect(glb.readUInt32BE(offset + 20)).toBe(512);
  }
  await writeFile(info.outputPath("colab-learned-liver-512.glb"), glb);
  expect(browserErrors).toEqual([]);
  await writeFile(info.outputPath("integration-evidence.json"), JSON.stringify({ receipt, status, shapeFrame, surfaceFrame, diseaseFrame,
    sameSeedReproducible: true, distinctSeedsVary: true, sliderEditsPreservedRecipes: true, textCompiler: compiled,
    glb: { bytes: glb.length, sha256: createHash("sha256").update(glb).digest("hex"), textureResolution: 512 }, browserErrors }, null, 2));
});

test("enabled Colab text adapter edits rendered disease anatomy and keeps unsupported edits unapplied", async ({ page }, info) => {
  test.skip(process.env.VISCERA_TEST_LANGUAGE_ENABLED !== "1", "Explicitly enabled real Qwen adapter is required");
  const status = await (await page.request.get("/api/atlas/models")).json();
  expect(status.bundle_sha256).toBe(receipt.bundle_sha256); expect(status.language_enabled).toBe(true);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const generations: AtlasGeneration[] = [];
  page.on("response", async response => {
    if (response.url().endsWith("/api/atlas/generate") && response.ok()) generations.push(await response.json());
  });
  await responseTo(page, "/api/atlas/generate", () => page.goto("/?template=hra-liver-female"));
  await page.getByRole("tab", { name: "Disease", exact: true }).click();
  const before = await responseTo(page, "/api/atlas/generate", () => page.getByRole("combobox", { name: "Disease profile", exact: true }).selectOption("liver-hcc"));
  expect(Object.values(before.spec.controls).every(value => value === 0)).toBe(true);
  expect(before.spec.realized_id).toBeTruthy(); expect(before.spec.template_sha256).toBeTruthy();
  // New browser contexts have no localStorage: availability must be discovered
  // without opening the dialog, and availability must not opt the user in.
  const toggle = page.getByRole("checkbox", { name: "Use trained text adapter · shape edits, compiler guarded", exact: true });
  await expect(toggle).toBeVisible(); await expect(toggle).not.toBeChecked();
  await page.getByRole("button", { name: "Trained models", exact: true }).click();
  await expect(page.getByRole("button", { name: "Text adapter enabled", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Close trained models", exact: true }).click();
  await expect(toggle).not.toBeChecked(); await toggle.check();
  await page.getByRole("textbox", { name: "Describe an anatomy variation", exact: true }).fill("taper 0.3");
  let compiling = page.waitForResponse(response => response.url().endsWith("/api/atlas/compile"));
  await page.getByRole("button", { name: "Apply text instruction", exact: true }).click();
  const accepted = await (await compiling).json();
  expect(accepted.status, JSON.stringify(accepted)).toBe("accepted");
  expect(accepted.adapter).toMatchObject({ adapter_inference_executed: true, guard: "passed", disease_or_appearance_predicted: false });
  await expect.poll(() => generations.at(-1)?.spec.controls.taper).toBe(0.3);
  await expect(page.getByRole("button", { name: "Export GLB", exact: true })).toBeEnabled();
  const after = generations.at(-1)!;
  expect(after.spec.disease).toEqual(before.spec.disease); expect(after.spec.material).toEqual(before.spec.material);
  expect(geometry(after)).not.toBe(geometry(before));
  const frame = await screenshot(page, info, "04-trained-text-with-disease");

  const count = generations.length;
  await page.getByRole("textbox", { name: "Describe an anatomy variation", exact: true }).fill("add a tumor");
  compiling = page.waitForResponse(response => response.url().endsWith("/api/atlas/compile"));
  await page.getByRole("button", { name: "Apply text instruction", exact: true }).click();
  const rejected = await (await compiling).json();
  expect(rejected.status).toBe("unsupported"); expect(rejected.adapter.adapter_inference_executed).toBe(false);
  await expect(page.getByRole("button", { name: "Apply text instruction", exact: true })).toBeEnabled();
  expect(generations).toHaveLength(count); expect(generations.at(-1)!.spec).toEqual(after.spec);
  await expect(page.getByRole("alert")).toHaveCount(0); expect(errors).toEqual([]);
  await writeFile(info.outputPath("language-browser-evidence.json"), JSON.stringify({ bundle_sha256: receipt.bundle_sha256,
    renderedContextBindings: { template_sha256: before.spec.template_sha256, realized_id: before.spec.realized_id },
    accepted, rejected, materialPreserved: true, diseasePreserved: true, unsupportedGeometryPreserved: true, frame, browserErrors: errors }, null, 2));
});
