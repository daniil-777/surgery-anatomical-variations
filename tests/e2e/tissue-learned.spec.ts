import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

// Learned tiles in the Tissue Lab: grouped catalog, family gallery, and the optional local generator.
// The generator is mocked with page.route; responses must pass the same bundle validation as a file import.
const entryUrl = process.env.TISSUE_PRODUCTION_URL ?? "./?mode=tissues";
const fixture = "tests/fixtures/tissue-pbr/software-material.tissue-pbr.json";
const GENERATOR = "http://127.0.0.1:8790";
const health = { schema: "viscera.tissue-generator/v1", ready: true, busy: false, families: ["liver", "pancreas"], modes: ["clean", "guided", "delit", "raw"],
  run_id: "tissue-lora-e2e", rights: { training_profile: "noncommercial-research", rights: ["noncommercial-research"] } };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Private-Network": "true" };

const host = (page: Page) => page.locator(".tissue-viewport[data-tissue-ready='true']");
async function snapshot(page: Page) { return JSON.parse((await host(page).getAttribute("data-tissue-snapshot"))!); }
async function ready(page: Page, organ = "liver") {
  await expect.poll(async () => (await host(page).count()) === 1 ? (await snapshot(page)).organ : null, { timeout: 60_000 }).toBe(organ);
  await expect(page.locator(".tissue-loading")).toHaveCount(0);
}
function monitor(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.location().url.endsWith("/api.json")) errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400 && !(response.status() === 404 && new URL(response.url()).pathname.endsWith("/api.json"))) errors.push(`${response.status()} ${response.url()}`); });
  return errors;
}
async function mockGenerator(page: Page, bundle: string, onPost: (body: unknown) => void = () => {}) {
  await page.route(`${GENERATOR}/**`, async route => {
    const request = route.request();
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    if (request.url().endsWith("/health")) return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(health) });
    onPost(JSON.parse(request.postData() ?? "{}"));
    return route.fulfill({ status: 200, headers: { ...cors, "Content-Type": "application/json" }, body: bundle });
  });
}

test("the catalog groups authored and learned studies and the gallery selects learned tiles", async ({ page }) => {
  const errors = monitor(page);
  const generatorRequests: string[] = [];
  page.on("request", request => { if (request.url().startsWith(GENERATOR)) generatorRequests.push(request.url()); });
  await page.goto(entryUrl); await ready(page);
  const catalog = await (await page.request.get("./tissue-materials/catalog.json")).json() as { materials: { id: string; family?: string; group?: string }[] };
  const learned = catalog.materials.filter(entry => entry.group && entry.group !== "Authored library");
  test.skip(!learned.length, "the served library has no learned studies");
  const region = page.getByLabel("Tissue region", { exact: true });
  const groups = await region.locator("optgroup").evaluateAll(nodes => nodes.map(node => (node as HTMLOptGroupElement).label));
  expect(groups[0]).toBe("Authored library");
  expect(groups.length).toBeGreaterThan(1);
  const family = learned[0]!.family!;
  const ofFamily = learned.filter(entry => entry.family === family);
  await region.selectOption(family); await ready(page, family);
  const gallery = page.getByRole("group", { name: `Learned ${family.replaceAll("_", " ")} tiles` });
  const tiles = gallery.getByRole("button");
  await expect(tiles).toHaveCount(ofFamily.length);
  await expect(gallery.locator("img").first()).toHaveJSProperty("complete", true);
  await tiles.first().click();
  await expect(region).toHaveValue(ofFamily[0]!.id);
  await ready(page, family);
  await expect(tiles.first()).toHaveAttribute("aria-pressed", "true");
  expect(generatorRequests).toEqual([]);   // the page never contacts the generator on its own
  expect(errors).toEqual([]);
});

test("a generated tile is applied only through the validated bundle import", async ({ page }) => {
  const errors = monitor(page);
  const bundle = await readFile(fixture, "utf8");
  let posted: unknown;
  await mockGenerator(page, bundle, body => { posted = body; });
  await page.goto(entryUrl); await ready(page);
  await page.getByRole("button", { name: "Connect to local generator" }).click();
  await expect(page.getByLabel("Generator tissue family")).toHaveValue("liver");
  await expect(page.getByText("Research use only (training data licence)")).toBeVisible();
  await page.getByLabel("Generation mode").selectOption("guided");
  await page.getByRole("button", { name: "Generate new tile" }).click();
  await expect(page.getByRole("button", { name: "Return to tissue library" })).toBeVisible();
  expect(posted).toEqual({ family: "liver", mode: "guided" });
  await expect.poll(async () => (await snapshot(page)).importedMaterial?.bundleSha256 ?? "").toMatch(/^[a-f0-9]{64}$/);
  await expect(page.getByLabel("Tissue region", { exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Return to tissue library" }).click();
  await ready(page, "liver");
  expect(errors).toEqual([]);
});

test("a corrupt generator response is rejected and the current material stays", async ({ page }) => {
  const source = JSON.parse(await readFile(fixture, "utf8"));
  source.manifest.channels.substrate.sha256 = "0".repeat(64);
  await mockGenerator(page, JSON.stringify(source));
  await page.goto(entryUrl); await ready(page);
  const before = (await snapshot(page)).organ;
  await page.getByRole("button", { name: "Connect to local generator" }).click();
  await page.getByRole("button", { name: "Generate new tile" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /checksum|declarations|Missing/i })).toBeVisible();
  await expect(page.getByRole("button", { name: "Return to tissue library" })).toHaveCount(0);
  expect((await snapshot(page)).organ).toBe(before);
  expect((await snapshot(page)).importedMaterial).toBeNull();
});

test("an absent local server automatically connects to the built-in browser tile generator and generates a valid tile", async ({ page }) => {
  await page.route(`${GENERATOR}/**`, route => route.abort("connectionrefused"));
  await page.goto(entryUrl); await ready(page);
  await page.getByRole("button", { name: "Connect to local generator" }).click();
  await expect(page.getByText("Built-in tile generator")).toBeVisible();
  await expect(page.getByLabel("Generator tissue family")).toHaveValue("liver");
  await page.getByRole("button", { name: "Generate new tile" }).click();
  await expect(page.getByRole("button", { name: "Return to tissue library" })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).importedMaterial?.bundleSha256 ?? "").toMatch(/^[a-f0-9]{64}$/);
  await page.getByRole("button", { name: "Return to tissue library" }).click();
  await ready(page, "liver");
});

test("Use generative models discovers and loads the best Colab appearance and PBR models automatically", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page, "liver");
  await page.getByRole("button", { name: "Use generative models", exact: true }).click();
  await expect(page.getByLabel("Available generative models")).toHaveValue("exemplar-liver");
  await expect.poll(async () => (await snapshot(page)).appearance?.evidence ?? null, { timeout: 30_000 }).toBe("exemplar_fitted");
  await expect.poll(async () => (await snapshot(page)).appearance?.region ?? null).toBe("liver");

  await page.getByLabel("Tissue region", { exact: true }).selectOption("colonic_mucosa");
  await ready(page, "colonic_mucosa");
  await page.getByRole("button", { name: "Use generative models", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No recommended appearance model covers this tissue");
  await expect.poll(async () => (await snapshot(page)).appearance ?? null).toBeNull();

  await page.getByLabel("Tissue region", { exact: true }).selectOption("liver");
  await page.getByRole("button", { name: "Use generative models", exact: true }).click();
  await ready(page, "liver");
  await page.getByRole("button", { name: "Use generated PBR model", exact: true }).click();
  await expect(page.getByRole("button", { name: "Return to tissue library" })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).importedMaterial?.sourceFile ?? "").toBe("liver-seed43-refined.tissue-pbr.json");
  await page.getByRole("button", { name: "Return to tissue library" }).click();
  await ready(page, "liver");
  expect(errors).toEqual([]);
});

test("Bake onto 3D organ mesh seamlessly bakes learned tiles onto the corresponding 3D organ with interactive UV atlas controls", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page, "liver");

  const bakeButton = page.getByRole("button", { name: /Bake onto 3D liver mesh/i });
  await expect(bakeButton).toBeVisible();
  await bakeButton.click();

  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.geometry === "source-atlas-exterior-v1" && state.organBake?.organ === "liver" ? state.organBake.seamContinuity : null;
  }, { timeout: 30_000 }).toBeGreaterThan(0.999);

  await expect(page.getByRole("button", { name: /Baked on 3D liver mesh/i })).toHaveAttribute("aria-pressed", "true");
  const bakeCard = page.getByRole("region", { name: "Baked 3D organ mesh" });
  await expect(bakeCard).toBeVisible();
  await expect(bakeCard.getByText(/100\.0% seam-free/i)).toBeVisible();

  for (const channel of ["normal", "roughness", "albedo"]) {
    const tab = bakeCard.getByRole("button", { name: channel, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true");
  }

  await page.getByLabel("Organ tile scale", { exact: true }).fill("64");
  await expect.poll(async () => (await snapshot(page)).organBake?.tileScaleMm ?? null).toBe(64);

  await expect(bakeCard.getByRole("button", { name: /Export 3D organ \(\.glb\)/i })).toBeEnabled();
  await expect(bakeCard.getByRole("button", { name: /Save UV atlas \(\.png\)/i })).toBeEnabled();

  const unityButton = bakeCard.getByRole("button", { name: /Export to Unity \(\.zip\)/i });
  await expect(unityButton).toBeEnabled();
  const downloadPromise = page.waitForEvent("download");
  await unityButton.click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("liver-unity-pbr-package.zip");
  await expect(bakeCard.getByText(/Exported Unity PBR package: liver-unity-pbr-package\.zip/i)).toBeVisible();
  expect(errors).toEqual([]);
});

test('selected learned tiles replace an active model on the baked liver and survive a late model response', async ({page}) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  await page.getByRole('button', {name:'Use generative models', exact:true}).click();
  await expect.poll(async() => (await snapshot(page)).appearance?.evidence).toBe('exemplar_fitted');
  const tiles = page.locator('.tissue-learned-tile');
  const region = page.getByLabel('Tissue region', {exact:true});
  const atlas = page.getByRole('img', {name:'Baked liver albedo UV atlas', exact:true});
  await tiles.nth(0).click(); await ready(page);
  const firstId = await region.inputValue();
  await page.getByRole('button', {name:/Bake onto 3D liver mesh/}).click();
  await expect.poll(async() => (await snapshot(page)).organBake?.source.kind).toBe('learned-tile');
  expect((await snapshot(page)).appearance).toBeNull();
  const firstAtlas = await atlas.getAttribute('src');
  const firstSource = (await snapshot(page)).organBake.source.substrateSha256;
  await tiles.nth(1).click(); await ready(page);
  await expect.poll(async() => (await snapshot(page)).organBake?.source.substrateSha256).not.toBe(firstSource);
  const secondAtlas = await atlas.getAttribute('src');
  expect(secondAtlas).not.toBe(firstAtlas);
  expect((await snapshot(page)).appearance).toBeNull();
  await tiles.nth(0).click(); await ready(page);
  await expect.poll(() => atlas.getAttribute('src')).toBe(firstAtlas);
  await expect(region).toHaveValue(firstId);

  // A delayed model download must not undo a newer explicit gallery selection.
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>(resolve => {release = resolve});
  const started = new Promise<void>(resolve => {requested = resolve});
  await page.route('**/tissue-models/exemplar-liver.tissue-model.json', async route => {
    const response = await route.fetch(); requested(); await pending; await route.fulfill({response});
  });
  await page.getByRole('button', {name:'Use generative models',exact:true}).click();
  await started;
  await tiles.nth(1).click(); await ready(page);
  const secondId = await region.inputValue();
  const delivered = page.waitForResponse(r => r.url().endsWith('/exemplar-liver.tissue-model.json'));
  release(); await delivered;
  await expect.poll(() => atlas.getAttribute('src')).toBe(secondAtlas);
  await expect(region).toHaveValue(secondId);
  expect((await snapshot(page)).appearance).toBeNull();
  await page.unroute('**/tissue-models/exemplar-liver.tissue-model.json');

  await page.getByRole('button', {name:'Use generative models',exact:true}).click();
  await expect(region).toHaveValue('liver');
  await expect.poll(async() => (await snapshot(page)).organBake?.source.kind).toBe('generated-appearance');
  const generatedAtlas = await atlas.getAttribute('src');
  await page.getByLabel('Learned RGB resolution', {exact:true}).selectOption('256');
  await expect.poll(async() => (await snapshot(page)).organBake?.source.resolution).toBe(256);
  expect(await atlas.getAttribute('src')).not.toBe(generatedAtlas);
  expect(errors).toEqual([]);
});
