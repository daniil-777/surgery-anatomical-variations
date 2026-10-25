import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { appearanceLatent, bakeAppearanceRows, parseAppearanceModel } from "../../apps/studio/src/tissues/neuralAppearance";

const fixture = "tests/fixtures/tissue-learning/fixture-trained.tissue-model.json";
const detailFixture = "tests/fixtures/tissue-learning-detail/fixture-trained.tissue-model.json";
const spatialFixture = "tests/fixtures/tissue-learning-conv/real-native-three-step.tissue-model.json";
const pbrFixture = "tests/fixtures/tissue-pbr/software-material.tissue-pbr.json";
const host = (page: Page) => page.locator(".tissue-viewport[data-tissue-ready='true']");
const snapshot = async (page: Page) => JSON.parse(await host(page).getAttribute("data-tissue-snapshot") ?? "{}");
const appearance = async (page: Page) => (await snapshot(page)).appearance;
async function start(page: Page) {
  await page.goto(process.env.TISSUE_PRODUCTION_URL ?? "./?mode=tissues");
  await expect(host(page)).toHaveCount(1);
  await expect.poll(async () => (await snapshot(page)).organ).toBe("liver");
}
async function importModel(page: Page, path = fixture) {
  await page.getByLabel("Import generative tissue model").setInputFiles(path);
  await expect(page.getByLabel("Learned RGB resolution")).toBeVisible();
  await page.getByLabel("Learned RGB resolution").selectOption("128");
  await expect.poll(async () => (await appearance(page))?.resolution).toBe(128);
  const modelId = createHash("sha256").update(await readFile(path)).digest("hex");
  await expect.poll(async () => (await appearance(page))?.modelId).toBe(modelId);
}
async function textureDigest(page: Page) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download learned RGB texture", exact: true }).click();
  const download = await pending, path = await download.path();
  expect(path).not.toBeNull();
  const png = await readFile(path!);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
  return createHash("sha256").update(png).digest("hex");
}

test("actual trained fixture imports, changes the surface, and replays the exact uint64 seed", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await start(page);
  await page.getByLabel("Surface study", { exact: true }).selectOption("albedo");
  const pixels = () => host(page).evaluate((element: HTMLDivElement & { captureTissueFrame: (w: number, h: number, t: number) => string }) => element.captureTissueFrame(480, 270, 0));
  const authored = await pixels();
  await importModel(page);
  const imported = await appearance(page);
  expect(imported.modelId).toBe(createHash("sha256").update(await readFile(fixture)).digest("hex"));
  expect(imported.evidence).toBe("fixture_trained");
  expect(await pixels()).not.toBe(authored);
  const first = await textureDigest(page);
  await page.getByLabel("Appearance seed", { exact: true }).fill("18446744073709551615");
  await expect.poll(async () => (await appearance(page))?.seed).toBe("18446744073709551615");
  expect(await textureDigest(page)).not.toBe(first);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export material + display recipe", exact: true }).click();
  const path = await (await pending).path();
  const recipe = JSON.parse(await readFile(path!, "utf8"));
  expect(recipe.learnedAppearance).toMatchObject({ modelId: imported.modelId, resolution: 128, seed: "18446744073709551615", pbrGroundTruth: false });
  await page.getByLabel("Appearance seed", { exact: true }).fill("42");
  await expect.poll(async () => (await appearance(page))?.seed).toBe("42");
  expect(await textureDigest(page)).toBe(first);
  await page.getByRole("checkbox", { name: "Use learned appearance" }).uncheck();
  await expect.poll(() => appearance(page)).toBeNull();
  expect(await pixels()).toBe(authored);
  expect(errors).toEqual([]);
});

test("stored model restores, unsupported regions keep authored maps, and removal persists", async ({ page }) => {
  await start(page); await importModel(page, "apps/studio/public/tissue-models/exemplar-liver.tissue-model.json");
  const modelId = (await appearance(page)).modelId;
  await page.reload();
  await expect.poll(async () => (await appearance(page))?.modelId).toBe(modelId);
  await page.getByLabel("Tissue region", { exact: true }).selectOption("kidney");
  await expect.poll(async () => (await snapshot(page)).organ).toBe("kidney");
  await expect.poll(() => appearance(page)).toBeNull();
  await expect(page.getByText("This model does not cover kidney.", { exact: false })).toBeVisible();
  await page.getByLabel("Tissue region", { exact: true }).selectOption("liver");
  await expect.poll(async () => (await appearance(page))?.modelId).toBe(modelId);
  await page.getByRole("button", { name: "Remove imported model", exact: true }).click();
  await expect.poll(() => appearance(page)).toBeNull();
  await expect(page.getByText("Model removed from this browser.", { exact: true })).toBeVisible();
  await page.reload(); await expect(host(page)).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Remove imported model", exact: true })).toHaveCount(0);
  await expect.poll(() => appearance(page)).toBeNull();
});

test("a local PBR import suspends the learned model and preserves its disabled state, exact seed and resolution", async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const seed = "18446744073709551615";
  const pbrSource = await readFile(pbrFixture, "utf8"), pbrManifest = JSON.parse(pbrSource).manifest;
  const importedIdentity = { bundleSha256: createHash("sha256").update(pbrSource).digest("hex"),
    sourceFile: "software-material.tissue-pbr.json", provenance: pbrManifest.provenance };
  await start(page); await importModel(page);
  const modelId = (await appearance(page)).modelId;
  await page.getByLabel("Appearance seed", { exact: true }).fill(seed);
  await expect.poll(async () => (await appearance(page))?.seed).toBe(seed);
  await expect(page.getByLabel("Learned RGB resolution", { exact: true })).toHaveValue("128");
  await page.getByRole("checkbox", { name: "Use learned appearance", exact: true }).uncheck();
  await expect.poll(() => appearance(page)).toBeNull();

  await page.getByLabel("Import generated PBR material", { exact: true }).setInputFiles(pbrFixture);
  await expect(page.getByRole("button", { name: "Return to tissue library", exact: true })).toBeVisible();
  await expect(host(page)).toHaveCount(1);
  await expect.poll(async () => (await snapshot(page)).importedMaterial).toEqual(importedIdentity);
  await expect.poll(() => appearance(page)).toBeNull();
  await expect(page.locator(".tissue-model-panel")).toBeHidden();

  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect.poll(async () => (await snapshot(page)).geometry).toBe("source-atlas-exterior-v1");
  const recording = await host(page).evaluate(async (element: HTMLDivElement & {
    recordTissueVideo: (seconds: number) => Promise<{ blob: Blob; metrics: {
      width: number; height: number; materialSnapshot: Record<string, unknown>;
    } }>;
  }) => {
    const result = await element.recordTissueVideo(1);
    return { bytes: result.blob.size, metrics: result.metrics };
  });
  expect(recording.bytes).toBeGreaterThan(128);
  expect(recording.metrics).toMatchObject({ width: 3840, height: 2160,
    materialSnapshot: { importedMaterial: importedIdentity, appearance: null } });

  await page.getByRole("button", { name: "Return to tissue library", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).organ).toBe("liver");
  await expect(page.locator(".tissue-model-panel")).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Use learned appearance", exact: true })).not.toBeChecked();
  await expect(page.getByLabel("Appearance seed", { exact: true })).toHaveValue(seed);
  await expect(page.getByLabel("Learned RGB resolution", { exact: true })).toHaveValue("128");
  await expect.poll(() => appearance(page)).toBeNull();
  await expect.poll(async () => (await snapshot(page)).importedMaterial).toBeNull();

  await page.getByRole("checkbox", { name: "Use learned appearance", exact: true }).check();
  await expect.poll(() => appearance(page)).toMatchObject({ modelId, seed, resolution: 128, region: "liver" });
  expect(errors).toEqual([]);
});

test("corrupt imports cannot replace a verified model and invalid seeds do not crash the page", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await start(page); await importModel(page);
  const modelId = (await appearance(page)).modelId;
  const artifact = JSON.parse(await readFile(fixture, "utf8")); artifact.weights.sha256 = "0".repeat(64);
  await page.getByLabel("Import generative tissue model").setInputFiles({ name: "corrupt.tissue-model.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(artifact)) });
  await expect(page.locator(".tissue-model-error")).toContainText(/checksum|hash/i);
  expect((await appearance(page)).modelId).toBe(modelId);
  await page.getByLabel("Appearance seed", { exact: true }).fill("-1");
  await expect(page.locator(".tissue-model-error")).toContainText(/seed/i);
  await expect.poll(() => appearance(page)).toBeNull();
  await page.getByLabel("Appearance seed", { exact: true }).fill("42");
  await expect.poll(async () => (await appearance(page))?.modelId).toBe(modelId);
  expect(errors).toEqual([]);
});

test("appearance replacement keeps the atlas renderer and authored texture assets alive", async ({ page }) => {
  await start(page);
  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect.poll(async () => (await snapshot(page)).geometry).toBe("source-atlas-exterior-v1");
  const canvas = await host(page).locator("canvas").elementHandle();
  expect(canvas).not.toBeNull();
  const assetRequests: string[] = [];
  page.on("request", request => { if (/\/(?:anatomy-scene|tissue-materials)\//.test(request.url())) assetRequests.push(request.url()); });
  await importModel(page);
  for (const seed of ["43", "44", "42"]) {
    await page.getByLabel("Appearance seed", { exact: true }).fill(seed);
    await expect.poll(async () => (await appearance(page))?.seed).toBe(seed);
    expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
    expect((await snapshot(page)).geometry).toBe("source-atlas-exterior-v1");
  }
  await page.getByRole("checkbox", { name: "Use learned appearance" }).uncheck();
  await expect.poll(() => appearance(page)).toBeNull();
  expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
  expect(assetRequests).toEqual([]);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("v2 directional synthetic fixture worker matches the canonical decoder for both regions and replay", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const model = await parseAppearanceModel(await readFile(detailFixture, "utf8"));
  await start(page); await importModel(page, detailFixture);
  for (const region of ["liver", "colonic_mucosa"]) {
    await page.getByLabel("Tissue region", { exact: true }).selectOption(region);
    await expect.poll(async () => (await appearance(page))?.region).toBe(region);
    const canvas = await host(page).locator("canvas").elementHandle();
    let first: Buffer | undefined;
    for (const seed of ["42", "43", "42"]) {
      await page.getByLabel("Appearance seed", { exact: true }).fill(seed);
      await expect.poll(async () => (await appearance(page))?.seed).toBe(seed);
      await expect(page.getByRole("button", { name: "Download learned RGB texture", exact: true })).toBeEnabled();
      const pending = page.waitForEvent("download");
      await page.getByRole("button", { name: "Download learned RGB texture", exact: true }).click();
      const png = await readFile((await (await pending).path())!);
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
      const pixels = Buffer.from(await page.evaluate(async base64 => {
        const image = new Image(); image.src = "data:image/png;base64," + base64; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = 128; canvas.height = 128;
        const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true })!;
        context.drawImage(image, 0, 0);
        return [...context.getImageData(0, 0, 128, 128).data];
      }, png.toString("base64")));
      const expected = new Uint8Array(128 * 128 * 4), latent = await appearanceLatent(seed, 64);
      bakeAppearanceRows(model, latent, model.artifact.architecture.condition_regions.indexOf(region), 128, 0, 128, expected);
      let maximum = 0;
      pixels.forEach((value, index) => { maximum = Math.max(maximum, Math.abs(value - expected[index]!)); });
      expect(maximum).toBeLessThanOrEqual(1);
      if (first && seed === "42") expect(pixels).toEqual(first);
      else if (first) expect(pixels).not.toEqual(first);
      else first = pixels;
      expect((await appearance(page)).evidence).toBe("fixture_trained");
      expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test("v1 and v2 fixture replacement stays reversible and directional packing corruption cannot replace the model", async ({ page }) => {
  await start(page); await importModel(page);
  const v1 = (await appearance(page)).modelId;
  await importModel(page, detailFixture);
  const v2 = (await appearance(page)).modelId; expect(v2).not.toBe(v1);
  await page.reload();
  await expect(page.getByText(/An early test model was saved here/)).toBeVisible();
  expect(await appearance(page)).toBeNull();
  await importModel(page, detailFixture);
  const corrupt = JSON.parse(await readFile(detailFixture, "utf8")); corrupt.architecture.fourier_order = "cos,sin";
  await page.getByLabel("Import generative tissue model").setInputFiles({ name: "corrupt-v2.tissue-model.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(corrupt)) });
  await expect(page.locator(".tissue-model-error")).toContainText(/unsupported directional.*architecture/i);
  expect((await appearance(page)).modelId).toBe(v2);
  await page.getByLabel("Tissue region", { exact: true }).selectOption("kidney");
  await expect.poll(async () => (await snapshot(page)).organ).toBe("kidney");
  await expect.poll(() => appearance(page)).toBeNull();
  await page.getByLabel("Tissue region", { exact: true }).selectOption("liver");
  await expect.poll(async () => (await appearance(page))?.modelId).toBe(v2);
  await importModel(page);
  expect((await appearance(page)).modelId).toBe(v1);
  await page.reload(); await expect(page.getByText(/An early test model was saved here/)).toBeVisible();
  expect(await appearance(page)).toBeNull();
  await importModel(page);
  await page.getByRole("button", { name: "Remove imported model", exact: true }).click();
  await expect.poll(() => appearance(page)).toBeNull();
});

test("v3 real-data three-step engineering proof matches native128 and periodic256 worker pixels", async ({ page }) => {
  test.setTimeout(240_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const model = await parseAppearanceModel(await readFile(spatialFixture, "utf8"));
  expect(model.kind).toBe("spatial");
  await start(page); await importModel(page, spatialFixture);
  const canvas = await host(page).locator("canvas").elementHandle();
  let first: Buffer | undefined;
  for (const [resolution, seed] of [[128, "42"], [256, "42"], [256, "18446744073709551615"], [256, "42"]] as const) {
    await page.getByLabel("Learned RGB resolution").selectOption(String(resolution));
    await page.getByLabel("Appearance seed", { exact: true }).fill(seed);
    await expect.poll(async () => (await appearance(page))?.resolution).toBe(resolution);
    await expect.poll(async () => (await appearance(page))?.seed).toBe(seed);
    await expect(page.getByRole("button", { name: "Download learned RGB texture", exact: true })).toBeEnabled();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download learned RGB texture", exact: true }).click();
    const png = await readFile((await (await pending).path())!);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([resolution, resolution]);
    const pixels = Buffer.from(await page.evaluate(async ({ base64, size }) => {
      const image = new Image(); image.src = "data:image/png;base64," + base64; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = size;
      const context = canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      return [...context.getImageData(0, 0, size, size).data];
    }, { base64: png.toString("base64"), size: resolution }));
    const expected = new Uint8Array(resolution * resolution * 4);
    bakeAppearanceRows(model, await appearanceLatent(seed, model.artifact.architecture.latent_dim), model.artifact.architecture.condition_regions.indexOf("liver"), resolution, 0, resolution, expected);
    let maximum = 0; pixels.forEach((value, index) => { maximum = Math.max(maximum, Math.abs(value - expected[index]!)); });
    expect(maximum).toBeLessThanOrEqual(1);
    if (resolution === 256) {
      if (!first) first = pixels;
      else if (seed === "42") expect(pixels).toEqual(first);
      else expect(pixels).not.toEqual(first);
    }
    expect((await appearance(page)).evidence).toBe("research_trained");
    expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
  }
  expect(errors).toEqual([]);
});

test("v3 test weights require explicit import after reload and still reject altered operators", async ({ page }) => {
  await start(page); await importModel(page, spatialFixture);
  const spatialId = (await appearance(page)).modelId;
  await page.reload();
  await expect(page.getByText(/An early test model was saved here/)).toBeVisible();
  expect(await appearance(page)).toBeNull();
  await importModel(page, spatialFixture);
  const corrupt = JSON.parse(await readFile(spatialFixture, "utf8")); corrupt.architecture.padding = "zeros";
  await page.getByLabel("Import generative tissue model").setInputFiles({ name: "corrupt-v3.tissue-model.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(corrupt)) });
  await expect(page.locator(".tissue-model-error")).toContainText(/spatial decoder operations/i);
  expect((await appearance(page)).modelId).toBe(spatialId);
  for (const region of ["colonic_mucosa", "gastric_mucosa", "intestinal_mucosa", "kidney"]) {
    await page.getByLabel("Tissue region", { exact: true }).selectOption(region);
    await expect.poll(async () => (await snapshot(page)).organ).toBe(region);
    await expect.poll(() => appearance(page)).toBeNull();
  }
  await page.getByLabel("Tissue region", { exact: true }).selectOption("liver");
  await expect.poll(async () => (await appearance(page))?.modelId).toBe(spatialId);
  for (const prior of [fixture, detailFixture, spatialFixture]) {
    await importModel(page, prior);
    expect((await appearance(page)).modelId).toBe(createHash("sha256").update(await readFile(prior)).digest("hex"));
  }
  await page.getByRole("button", { name: "Remove imported model", exact: true }).click();
  await expect.poll(() => appearance(page)).toBeNull();
});
