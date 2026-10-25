import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const evidence = process.env.TISSUE_TEST_OUTPUT ?? "artifacts/tissue-lab-v3";
const executeFile = promisify(execFile);
const entryUrl = process.env.TISSUE_PRODUCTION_URL ?? "./?mode=tissues";
const pbrSoftwareFixture = JSON.parse(await readFile("tests/fixtures/tissue-pbr/software-material.tissue-pbr.json", "utf8")) as {
  manifest: { channels: { substrate: { sha256: string; bytes: number } } };
  files: Array<{ pngBase64: string }>;
};
type CaptureHost = HTMLDivElement & { captureTissueFrame: (width?: number, height?: number, time?: number) => string };
const host = (page: Page) => page.locator(".tissue-viewport[data-tissue-ready='true']");
const snapshot = async (page: Page) => JSON.parse(await host(page).getAttribute("data-tissue-snapshot") ?? "{}");

async function ready(page: Page, organ = "liver", resolution = 512) {
  await expect.poll(async () => {
    if (await host(page).count() !== 1) return null;
    const state = await snapshot(page);
    return { organ: state.organ, resolution: state.resolution };
  }).toEqual({ organ, resolution: [resolution, resolution] });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".tissue-loading")).toHaveCount(0);
  await rendered(page);
}
async function rendered(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function pixels(page: Page, width = 480, height = 270, time = 0): Promise<string> {
  return host(page).evaluate((element: CaptureHost, args) => element.captureTissueFrame(...args), [width, height, time] as const);
}
async function centralRgb(page: Page, png: string): Promise<number[]> {
  return page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const data = context.getImageData(Math.floor(image.width / 4), Math.floor(image.height / 4), Math.floor(image.width / 2), Math.floor(image.height / 2)).data;
    const sums = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let channel = 0; channel < 3; channel++) sums[channel]! += data[i + channel]!;
    return sums.map(value => value / (data.length / 4));
  }, png);
}
async function capture(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/${name}.png` });
  await writeFile(`${evidence}/${name}.json`, JSON.stringify(await snapshot(page), null, 2));
}
async function imageDifference(page: Page, a: string, b: string) {
  return page.evaluate(async ([first, second]) => {
    const decode = async (source: string) => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return context.getImageData(0, 0, image.width, image.height).data;
    };
    const x = await decode(first), y = await decode(second);
    if (x.length !== y.length) throw new Error("Mismatched image dimensions");
    let sum = 0, changed = 0, dark = 0, maximum = 0;
    for (let i = 0; i < x.length; i += 4) {
      const delta = (Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!)) / 3;
      sum += delta; if (delta > 2) changed++;
      if (Math.max(y[i]!, y[i + 1]!, y[i + 2]!) < 8) dark++;
      maximum = Math.max(maximum, y[i]!, y[i + 1]!, y[i + 2]!);
    }
    return { meanAbsoluteByteDifference: sum / (x.length / 4), changedFraction: changed / (x.length / 4), secondDarkFraction: dark / (x.length / 4), secondMaximumByte: maximum };
  }, [a, b]);
}
function monitor(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    // The application deliberately probes optional api.json before rendering.
    if (message.type() === "error" && !message.location().url.endsWith("/api.json")) errors.push(message.text());
  });
  page.on("response", response => {
    if (response.status() >= 400 && !(response.status() === 404 && new URL(response.url()).pathname.endsWith("/api.json"))) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

test("loads the complete catalog and representative surface and lumen materials without errors", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  const region = page.getByLabel("Tissue region", { exact: true });
  const ids = await region.locator("option").evaluateAll(options => options.map(option => (option as HTMLOptionElement).value));
  expect(ids.length).toBeGreaterThanOrEqual(19);
  expect(new Set(ids).size).toBe(ids.length);
  // Exercise every catalog entry, not only the four captured examples.
  for (const organ of ids) {
    const material = await (await page.request.get("./tissue-materials/" + organ + "/preview/manifest.json")).json();
    await region.selectOption(organ); await ready(page, material.recipe.organ);
    if (["liver", "pancreas", "gastric_mucosa", "colonic_mucosa"].includes(organ)) await capture(page, `profile-${organ}`);
  }
  expect(errors).toEqual([]);
});

test("coverage, ablations and relighting change appearance and restore deterministically", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  const original = await pixels(page), initial = await snapshot(page);
  for (const [label, key] of [["Vessel coverage", "vessels"], ["Fascia coverage", "fascia"], ["Adipose coverage", "adipose"], ["Wet coat", "wetness"]] as const) {
    await page.getByLabel(label, { exact: true }).fill("1"); await rendered(page);
    expect((await snapshot(page))[key]).toBe(1);
    expect(await pixels(page)).not.toBe(original);
    await page.getByLabel(label, { exact: true }).fill(String(initial[key])); await rendered(page);
    expect(await pixels(page)).toBe(original);
  }
  const studies = new Set<string>();
  for (const study of ["albedo", "normal", "roughness", "lit"]) {
    await page.getByLabel("Surface study", { exact: true }).selectOption(study); await rendered(page);
    const renderedPng = await pixels(page), [red, green, blue] = await centralRgb(page, renderedPng);
    expect((await snapshot(page)).study).toBe(study); studies.add(renderedPng);
    // Decode the actual framebuffer: state labels alone cannot prove the correct map was displayed.
    if (study === "albedo") { expect(red! - green!).toBeGreaterThan(20); expect(red! - blue!).toBeGreaterThan(20); }
    if (study === "normal") { expect(blue! - red!).toBeGreaterThan(20); expect(blue! - green!).toBeGreaterThan(20); }
    if (study === "roughness") { expect(Math.abs(red! - green!)).toBeLessThan(3); expect(Math.abs(red! - blue!)).toBeLessThan(3); }
    await capture(page, `ablation-${study}`);
  }
  expect(studies.size).toBe(4); expect(await pixels(page)).toBe(original);
  await page.getByLabel("Surface study", { exact: true }).selectOption("normal"); await rendered(page);
  await page.getByLabel("Adipose coverage", { exact: true }).fill("0"); await rendered(page);
  const bareNormal = await pixels(page);
  await page.getByLabel("Adipose coverage", { exact: true }).fill("1"); await rendered(page);
  const coveredNormal = await pixels(page);
  expect((await imageDifference(page, bareNormal, coveredNormal)).meanAbsoluteByteDifference).toBeGreaterThan(.1);
  await page.getByLabel("Adipose coverage", { exact: true }).fill("0"); await rendered(page);
  expect(await pixels(page)).toBe(bareNormal);
  await page.getByLabel("Adipose coverage", { exact: true }).fill(String(initial.adipose));
  await page.getByLabel("Surface study", { exact: true }).selectOption("roughness"); await rendered(page);
  await page.getByLabel("Wet coat", { exact: true }).fill("0"); await rendered(page);
  const dryRoughness = await pixels(page);
  await page.getByLabel("Wet coat", { exact: true }).fill("1"); await rendered(page);
  const filmRoughness = await pixels(page);
  expect((await imageDifference(page, dryRoughness, filmRoughness)).meanAbsoluteByteDifference).toBeGreaterThan(.1);
  expect((await centralRgb(page, filmRoughness))[0]!).toBeLessThan((await centralRgb(page, dryRoughness))[0]!);
  await page.getByLabel("Wet coat", { exact: true }).fill("0"); await rendered(page);
  expect(await pixels(page)).toBe(dryRoughness);
  await page.getByLabel("Wet coat", { exact: true }).fill(String(initial.wetness));
  await page.getByLabel("Surface study", { exact: true }).selectOption("lit"); await rendered(page);
  expect(await pixels(page)).toBe(original);
  await page.getByLabel("Lighting", { exact: true }).selectOption("grazing"); await rendered(page);
  expect(await pixels(page)).not.toBe(original); await capture(page, "grazing-light");
  await page.getByLabel("Lighting", { exact: true }).selectOption("camera"); await rendered(page);
  expect(await pixels(page)).toBe(original); expect(errors).toEqual([]);
});

test("material variations replay exact seeds and change colour and roughness without changing geometry or normals", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect.poll(async () => (await snapshot(page)).geometry).toBe("source-atlas-exterior-v1"); await ready(page);
  const initial = await snapshot(page), canvas = await host(page).locator("canvas").elementHandle();
  expect(canvas).not.toBeNull();
  await expect(page.getByRole("checkbox", { name: "Enable material variation", exact: true })).not.toBeChecked();
  const authored = new Map<string, string>();
  for (const study of ["lit", "albedo", "roughness", "normal"]) {
    await page.getByLabel("Surface study", { exact: true }).selectOption(study); await rendered(page);
    authored.set(study, await pixels(page));
  }
  const requests: string[] = [], listener = (request: { url: () => string }) => {
    if (/\/(?:anatomy-scene|tissue-materials)\//.test(request.url())) requests.push(request.url());
  };
  page.on("request", listener);
  await page.getByRole("checkbox", { name: "Enable material variation", exact: true }).check();
  await page.getByLabel("Colour variation", { exact: true }).fill("0.75");
  await page.getByLabel("Roughness variation", { exact: true }).fill("0.75");
  await page.getByLabel("Pigment warmth", { exact: true }).fill("0.2");
  await page.getByLabel("Pigment depth", { exact: true }).fill("0.1");
  const variations: Array<{ study: string; meanAbsoluteByteDifference: number }> = [];
  for (const study of ["lit", "albedo", "roughness", "normal"]) {
    await page.getByLabel("Surface study", { exact: true }).selectOption(study);
    const frames: string[] = [];
    for (const seed of ["42", "43", "42"]) {
      await page.getByLabel("Material variation seed", { exact: true }).fill(seed); await page.getByLabel("Material variation seed", { exact: true }).press("Enter");
      await expect.poll(async () => (await snapshot(page)).materialVariation?.seed).toBe(seed); await rendered(page);
      const state = await snapshot(page);
      expect(state.geometry).toBe(initial.geometry);
      expect(state.atlas).toEqual(initial.atlas);
      expect(state.seed).toBe(initial.seed);
      expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
      frames.push(await pixels(page));
    }
    expect(frames[2]).toBe(frames[0]);
    const delta = await imageDifference(page, frames[0]!, frames[1]!);
    if (study === "normal") {
      expect(frames[0]).toBe(authored.get(study)); expect(frames[1]).toBe(authored.get(study));
    } else {
      expect(delta.meanAbsoluteByteDifference).toBeGreaterThan(.1);
      expect(frames[0]).not.toBe(authored.get(study));
    }
    variations.push({ study, meanAbsoluteByteDifference: delta.meanAbsoluteByteDifference });
  }
  await page.getByRole("checkbox", { name: "Enable material variation", exact: true }).uncheck();
  for (const study of ["lit", "albedo", "roughness", "normal"]) {
    await page.getByLabel("Surface study", { exact: true }).selectOption(study); await rendered(page);
    expect(await pixels(page)).toBe(authored.get(study));
  }
  page.off("request", listener); expect(requests).toEqual([]);
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/material-variation-replay.json`, JSON.stringify({ variations, atlas: initial.atlas, authoredAssetRequests: requests, geometryAndNormalsPreserved: true }, null, 2));
  expect(errors).toEqual([]);
});

test("material variation controls preserve full uint64 seeds and replayable display recipes", async ({ page }) => {
  const errors = monitor(page), maximum = "18446744073709551615";
  await page.goto(entryUrl); await ready(page);
  await page.getByRole("checkbox", { name: "Enable material variation", exact: true }).check();
  await page.getByLabel("Material variation seed", { exact: true }).fill(maximum); await page.getByLabel("Material variation seed", { exact: true }).press("Enter");
  await page.getByLabel("Pigment warmth", { exact: true }).fill("-0.35");
  await page.getByLabel("Pigment depth", { exact: true }).fill("0.4");
  await page.getByLabel("Colour variation", { exact: true }).fill("0.6");
  await page.getByLabel("Roughness variation", { exact: true }).fill("0.7");
  const expected = { version: "viscera-tissue-variation-v1", enabled: true, seed: maximum, strength: .6, warmth: -.35, depth: .4, roughness: .7 };
  await expect.poll(async () => (await snapshot(page)).materialVariation).toEqual(expected); await rendered(page);
  const first = await pixels(page);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export material + display recipe", exact: true }).click();
  const download = await pending, file = `${evidence}/material-variation-uint64-recipe.json`;
  await download.saveAs(file);
  expect(JSON.parse(await readFile(file, "utf8")).display.materialVariation).toEqual(expected);
  await page.getByRole("button", { name: "New material variation", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).materialVariation?.seed).not.toBe(maximum);
  const randomSeed = await page.getByLabel("Material variation seed", { exact: true }).inputValue();
  expect(randomSeed).toMatch(/^(?:0|[1-9][0-9]*)$/);
  expect(BigInt(randomSeed)).toBeLessThanOrEqual(18446744073709551615n);
  await page.getByLabel("Material variation seed", { exact: true }).fill(maximum); await page.getByLabel("Material variation seed", { exact: true }).press("Enter");
  await expect.poll(async () => (await snapshot(page)).materialVariation?.seed).toBe(maximum); await rendered(page);
  expect(await pixels(page)).toBe(first);
  for (const [label, study, restored] of [["Pigment warmth", "albedo", "-0.35"], ["Pigment depth", "albedo", "0.4"], ["Colour variation", "albedo", "0.6"], ["Roughness variation", "roughness", "0.7"]]) {
    await page.getByLabel("Surface study", { exact: true }).selectOption(study!); await rendered(page);
    const before = await pixels(page);
    await page.getByLabel(label!, { exact: true }).fill("0"); await rendered(page);
    expect((await imageDifference(page, before, await pixels(page))).meanAbsoluteByteDifference).toBeGreaterThan(.05);
    await page.getByLabel(label!, { exact: true }).fill(restored!); await rendered(page);
    expect(await pixels(page)).toBe(before);
  }
  expect(errors).toEqual([]);
});

test("local PBR software fixture decodes into the canvas, exports its exact recipe and rejects corrupt replacements", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("Surface study", { exact: true }).selectOption("albedo"); await rendered(page);
  const authored = await pixels(page), requests: string[] = [];
  const listener = (request: { url: () => string }) => {
    if (/\/tissue-materials\//.test(request.url())) requests.push(request.url());
  };
  page.on("request", listener);
  const input = page.getByLabel("Import generated PBR material", { exact: true });
  await input.setInputFiles("tests/fixtures/tissue-pbr/software-material.tissue-pbr.json");
  await ready(page, "liver", 16);
  const state = await snapshot(page), imported = await pixels(page);
  expect(state.geometry).toBe("80-mm-surface-coupon"); expect(imported).not.toBe(authored);
  const center = await page.evaluate(async source => {
    const image = new Image(); image.src = source; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    return Array.from(context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data).slice(0, 3);
  }, imported);
  // Known fixture pixels verify actual decoding and sRGB display, not merely a state label.
  [164, 54, 48].forEach((expected, channel) => expect(Math.abs(center[channel]! - expected)).toBeLessThanOrEqual(1));
  expect(requests).toEqual([]); page.off("request", listener);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export material + display recipe", exact: true }).click();
  const recipeFile = `${evidence}/imported-pbr-software-fixture-recipe.json`;
  await (await pending).saveAs(recipeFile);
  const recipe = JSON.parse(await readFile(recipeFile, "utf8"));
  expect(recipe.material.recipe.seed).toBe("18446744073709551615");
  expect(recipe.material.resolution).toEqual([16, 16]);
  expect(recipe.material.provenance).toMatchObject({ fixture: true, clinically_validated: false, source_type: "deterministic-software-test-fixture" });
  const canvas = await host(page).locator("canvas").elementHandle();
  expect(canvas).not.toBeNull();
  const badHash = structuredClone(pbrSoftwareFixture); badHash.manifest.channels.substrate.sha256 = "0".repeat(64);
  await input.setInputFiles({ name: "wrong-hash.tissue-pbr.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(badHash)) });
  await expect(page.getByRole("alert")).toContainText(/checksum/i);
  expect(await pixels(page)).toBe(imported); expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
  const undecodable = structuredClone(pbrSoftwareFixture);
  // Valid signature/IHDR and matching SHA are insufficient: this PNG has no image data.
  const headerOnly = Buffer.from(undecodable.files[0]!.pngBase64, "base64").subarray(0, 33);
  undecodable.files[0]!.pngBase64 = headerOnly.toString("base64");
  undecodable.manifest.channels.substrate.bytes = headerOnly.length;
  undecodable.manifest.channels.substrate.sha256 = createHash("sha256").update(headerOnly).digest("hex");
  await input.setInputFiles({ name: "header-only.tissue-pbr.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(undecodable)) });
  await expect(page.getByRole("alert")).toContainText(/decode|image|invalid|source/i);
  expect(await pixels(page)).toBe(imported); expect(await canvas!.evaluate(element => element.isConnected)).toBe(true);
  expect((await snapshot(page)).resolution).toEqual([16, 16]);
  await page.getByRole("button", { name: "Return to tissue library", exact: true }).click();
  await ready(page, "liver", 512);
  expect(await pixels(page)).toBe(authored);
  await capture(page, "pbr-import-returned-to-library"); expect(errors).toEqual([]);
});

test("loads native 4K maps and downloads correctly dimensioned maps, frame and recipe", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("Map resolution", { exact: true }).selectOption("4096"); await ready(page, "liver", 4096);
  await capture(page, "native-4096");
  for (const channel of ["base color", "normal", "height"]) {
    const pending = page.waitForEvent("download");
    await page.getByRole("link", { name: `${channel} 4K ↓`, exact: true }).click();
    const download = await pending, file = `${evidence}/${channel.replace(" ", "_")}-4096.png`;
    await download.saveAs(file);
    const png = await readFile(file);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([4096, 4096]);
    if (channel === "height") expect(png[24]).toBe(16);
  }
  const pendingFrame = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save 4K frame ↗", exact: true }).click();
  await (await pendingFrame).saveAs(`${evidence}/frame-3840x2160.png`);
  const frame = await readFile(`${evidence}/frame-3840x2160.png`);
  expect([frame.readUInt32BE(16), frame.readUInt32BE(20)]).toEqual([3840, 2160]);
  const pendingRecipe = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export material + display recipe", exact: true }).click();
  await (await pendingRecipe).saveAs(`${evidence}/display-recipe.json`);
  const recipe = JSON.parse(await readFile(`${evidence}/display-recipe.json`, "utf8"));
  expect(recipe.material.resolution).toEqual([4096, 4096]);
  expect(recipe.material.provenance.clinically_validated).toBe(false);
  expect(recipe.material.provenance.trained_weights).toBeNull();
  expect(errors).toEqual([]);
});

test("download preserves the exact uint64 material seed", async ({ page }) => {
  const errors = monitor(page), seed = "18446744073709551615";
  await page.route("**/tissue-materials/liver/preview/manifest.json", async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/("seed"\s*:\s*)42(?=\s*[,}])/, "$1" + seed);
    expect(body).toContain(seed);
    await route.fulfill({ response, body, contentType: "application/json" });
  });
  await page.goto(entryUrl); await ready(page);
  await mkdir(evidence, { recursive: true });
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export material + display recipe", exact: true }).click();
  const file = `${evidence}/uint64-display-recipe.json`; await (await pending).saveAs(file);
  const source = await readFile(file, "utf8");
  expect(source).toMatch(new RegExp('"seed"\\s*:\\s*' + seed + '(?=\\s*[,}])'));
  expect(JSON.parse(source).display.seed).toBe(42);
  expect(errors).toEqual([]);
});

test("lumen seed variation is visible and fixed-time camera replay is stable", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("Tissue region", { exact: true }).selectOption("colonic_mucosa"); await ready(page, "colonic_mucosa");
  await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
  expect((await snapshot(page)).geometry).toBe("curved-lumen-phantom-v3");
  const first = await pixels(page);
  await page.getByLabel("Lumen variation seed", { exact: true }).fill("43"); await rendered(page);
  const second = await pixels(page);
  // Image differences must be spatially meaningful, not one Float32 rounding bit.
  const difference = await imageDifference(page, first, second);
  expect(difference.meanAbsoluteByteDifference).toBeGreaterThan(.25); expect(difference.changedFraction).toBeGreaterThan(.01);
  await page.getByLabel("Lumen variation seed", { exact: true }).fill("42"); await rendered(page);
  expect(await pixels(page)).toBe(first);
  expect(await pixels(page, 480, 270, 2)).not.toBe(first);
  expect(await pixels(page, 480, 270, 0)).toBe(first);
  await capture(page, "lumen-phantom");
  await writeFile(`${evidence}/adjacent-seed-difference.json`, JSON.stringify(difference, null, 2));
  await page.getByRole("button", { name: "Start camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause camera", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Pause camera", exact: true }).click();
  expect(errors).toEqual([]);
});

test("the recording button downloads native 4K video and an honest timing receipt", async ({ page }) => {
  const errors = monitor(page);
  await mkdir(evidence, { recursive: true });
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("Tissue region", { exact: true }).selectOption("colonic_mucosa"); await ready(page, "colonic_mucosa");
  await page.getByLabel("Map resolution", { exact: true }).selectOption("4096"); await ready(page, "colonic_mucosa", 4096);
  await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
  const videoPending = page.waitForEvent("download", { predicate: download => /-4k-walkthrough\.(mp4|webm)$/.test(download.suggestedFilename()) });
  const metricsPending = page.waitForEvent("download", { predicate: download => download.suggestedFilename().endsWith("-4k-stream-metrics.json") });
  await page.getByRole("button", { name: "Record 4K · 5s", exact: true }).click();
  await expect(page.getByRole("button", { name: "Recording…", exact: true })).toBeDisabled();
  await expect(page.locator(".tissue-panel")).toHaveAttribute("inert", /.*/);
  const duringRecording = await host(page).evaluate((element: CaptureHost) => {
    let rejection = "";
    try { element.captureTissueFrame(480, 270, 0); } catch (error) { rejection = String(error); }
    const canvas = element.querySelector("canvas")!;
    return { rejection, shape: [canvas.width, canvas.height] };
  });
  expect(duringRecording.rejection).toContain("during recording");
  expect(duringRecording.shape).toEqual([3840, 2160]);
  await page.setViewportSize({ width: 1000, height: 800 });
  expect(await host(page).locator("canvas").evaluate(canvas => [canvas.width, canvas.height])).toEqual([3840, 2160]);
  const video = await videoPending, metricsDownload = await metricsPending;
  const videoFile = `${evidence}/${video.suggestedFilename()}`, metricsFile = `${evidence}/${metricsDownload.suggestedFilename()}`;
  await video.saveAs(videoFile); await metricsDownload.saveAs(metricsFile);
  const metrics = JSON.parse(await readFile(metricsFile, "utf8"));
  expect([metrics.width, metrics.height]).toEqual([3840, 2160]);
  expect(metrics.durationSeconds).toBeGreaterThanOrEqual(4.5); expect(metrics.renderedFrames).toBeGreaterThan(0);
  expect(videoFile.endsWith(metrics.mimeType.startsWith("video/mp4") ? ".mp4" : ".webm")).toBe(true);
  const probe = JSON.parse((await executeFile("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,nb_read_frames:frame=best_effort_timestamp_time", "-of", "json", videoFile])).stdout);
  expect([probe.streams[0].width, probe.streams[0].height]).toEqual([3840, 2160]);
  expect(Number(probe.streams[0].nb_read_frames)).toBeGreaterThan(10);
  const timestamps = probe.frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time));
  expect(timestamps.every(Number.isFinite)).toBe(true);
  expect(timestamps.slice(1).every((time: number, index: number) => time > timestamps[index])).toBe(true);
  // A valid MP4 header and frame count cannot prove that the recording covers the requested camera motion.
  const encodedSpanSeconds = timestamps.at(-1) - timestamps[0];
  expect(encodedSpanSeconds).toBeGreaterThan(3.5); expect(encodedSpanSeconds).toBeLessThan(metrics.durationSeconds + .5);
  const decoded = await executeFile("ffmpeg", ["-v", "error", "-i", videoFile, "-vf", "fps=2,scale=96:54", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], { encoding: "buffer", maxBuffer: 2_000_000 });
  const frames = decoded.stdout, stride = 96 * 54 * 3;
  expect(frames.length % stride).toBe(0); expect(frames.length / stride).toBeGreaterThanOrEqual(7);
  const frameDifferences: number[] = [];
  for (let offset = stride; offset < frames.length; offset += stride) {
    let sum = 0; for (let i = 0; i < stride; i++) sum += Math.abs(frames[offset + i]! - frames[offset - stride + i]!);
    frameDifferences.push(sum / stride);
  }
  expect(frameDifferences.filter(delta => delta > .1).length).toBeGreaterThanOrEqual(frameDifferences.length - 1);
  probe.decodedMotion = { resolution: [96, 54], samplingFps: 2, frameDifferences, encodedSpanSeconds, interpretation: "Decode and nonfrozen-motion regression; not a realism or flicker metric." };
  await writeFile(`${evidence}/ui-recording-probe.json`, JSON.stringify(probe, null, 2));
  await expect(page.getByRole("button", { name: "Record 4K · 5s", exact: true })).toBeEnabled();
  await expect.poll(async () => host(page).evaluate(element => {
    const canvas = element.querySelector("canvas")!, ratio = Math.min(devicePixelRatio, 1.5);
    return canvas.width === Math.floor(element.clientWidth * ratio) && canvas.height === Math.floor(element.clientHeight * ratio);
  })).toBe(true);
  await expect(page.getByText(/actual encoded cadence may differ/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("curved paths remain visible and replayable across seeds, long traversals and the loop join", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("Tissue region", { exact: true }).selectOption("colonic_mucosa"); await ready(page, "colonic_mucosa");
  await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
  const trajectory = (await snapshot(page)).trajectory;
  expect(trajectory.lengthMm).toBeGreaterThan(500); expect(trajectory.speedMmPerSecond).toBeGreaterThan(0);
  expect(trajectory.periodSeconds).toBeCloseTo(trajectory.lengthMm / trajectory.speedMmPerSecond, 5);
  const observations = [];
  for (const seed of [0, 42, 43, 4294967295]) {
    await page.getByLabel("Lumen variation seed", { exact: true }).fill(String(seed)); await rendered(page);
    const frames = [];
    for (const time of [0, trajectory.periodSeconds * .25, trajectory.periodSeconds * .5, trajectory.periodSeconds * .75]) frames.push(await pixels(page, 480, 270, time));
    expect(new Set(frames).size).toBe(4);
    for (const frame of frames) expect((await imageDifference(page, frame, frame)).secondDarkFraction).toBeLessThan(.95);
    expect(await pixels(page, 480, 270, 0)).toBe(frames[0]);
    const wrapped = await imageDifference(page, frames[0]!, await pixels(page, 480, 270, trajectory.periodSeconds));
    expect(wrapped.meanAbsoluteByteDifference).toBeLessThan(.05);
    const dt = 1 / 240, times = [-2 * dt, -dt, 0, dt, 2 * dt].map(t => trajectory.periodSeconds + t);
    const boundaryFrames = []; for (const time of times) boundaryFrames.push(await pixels(page, 480, 270, time));
    const steps = [];
    for (let index = 1; index < boundaryFrames.length; index++) steps.push((await imageDifference(page, boundaryFrames[index - 1]!, boundaryFrames[index]!)).meanAbsoluteByteDifference);
    // Crossing the join must not create a discontinuity larger than neighboring physical motion.
    const neighboring = Math.max(steps[0]!, steps[3]!);
    expect(Math.max(steps[1]!, steps[2]!)).toBeLessThan(4 * neighboring + .5);
    expect(Math.max(...steps)).toBeLessThan(8);
    observations.push({ seed, times, steps, wrapped, trajectory });
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(`${evidence}/trajectory-continuity.json`, JSON.stringify(observations, null, 2));
  expect(errors).toEqual([]);
});

test("rapid material replacement resolves the latest selection without stale frames", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  const region = page.getByLabel("Tissue region", { exact: true });
  for (const organ of ["liver", "gastric_mucosa", "pancreas", "colonic_mucosa", "kidney", "gastric_mucosa"]) await region.selectOption(organ);
  await ready(page, "gastric_mucosa");
  const reference = await pixels(page);
  await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
  await page.getByLabel("View", { exact: true }).selectOption("surface"); await rendered(page);
  expect(await pixels(page)).toBe(reference);
  expect(await page.locator(".tissue-viewport canvas").count()).toBe(1);
  expect(errors).toEqual([]);
});

test("slider edits reuse GPU resources and invalid captures preserve the viewport", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  const resources = async () => JSON.parse(await host(page).getAttribute("data-tissue-resources") ?? "null");
  await expect.poll(resources).not.toBeNull();
  const initial = await resources(), image = await pixels(page);
  for (let index = 0; index < 20; index++) {
    await page.getByLabel("Wet coat", { exact: true }).fill(String(Number((index / 20).toFixed(3))));
    await page.getByLabel("Vessel coverage", { exact: true }).fill(String(Number((1 - index / 20).toFixed(3))));
  }
  // Resource counts are sampled every 30 frames. Wait for two render samples after updates.
  await page.evaluate(() => new Promise<void>(resolve => {
    let count = 0; const tick = () => ++count < 65 ? requestAnimationFrame(tick) : resolve(); requestAnimationFrame(tick);
  }));
  const after = await resources();
  expect(after.geometries).toBe(initial.geometries); expect(after.textures).toBe(initial.textures); expect(after.programs).toBe(initial.programs);
  const rejected = await host(page).evaluate((element: CaptureHost) => {
    const canvas = element.querySelector("canvas")!, before = [canvas.width, canvas.height], messages = [];
    for (const args of [[0, 270, 0], [100000, 270, 0], [480, 270, Number.NaN]]) {
      try { element.captureTissueFrame(args[0], args[1], args[2]); messages.push("accepted"); } catch (error) { messages.push(String(error)); }
    }
    return { before, after: [canvas.width, canvas.height], messages };
  });
  expect(rejected.messages.every(message => message.includes("Invalid capture"))).toBe(true);
  expect(rejected.after).toEqual(rejected.before);
  expect(await pixels(page)).not.toBe(image);
  await mkdir(evidence, { recursive: true }); await writeFile(`${evidence}/resource-lifecycle.json`, JSON.stringify({ initial, after, rejected }, null, 2));
  expect(errors).toEqual([]);
});

test("ablation shaders render the same pixels regardless of compilation order", async ({ page }) => {
  const errors = monitor(page), reference = new Map<string, string>();
  for (const order of [["normal", "albedo", "roughness"], ["roughness", "normal", "albedo"], ["albedo", "roughness", "normal"]]) {
    await page.goto(entryUrl); await ready(page);
    for (const study of order) {
      await page.getByLabel("Surface study", { exact: true }).selectOption(study); await rendered(page);
      const frame = await pixels(page);
      if (reference.has(study)) expect(frame).toBe(reference.get(study));
      else reference.set(study, frame);
    }
  }
  expect(new Set(reference.values()).size).toBe(3); expect(errors).toEqual([]);
});

test("data diagnostics preserve known encoded values while albedo stays sRGB", async ({ page }) => {
  const errors = monitor(page);
  await page.route("**/tissue-materials/liver/preview/*.png", async route => {
    const file = new URL(route.request().url()).pathname.split("/").at(-1);
    const fixture = ["normal.png", "substrate_normal.png"].includes(file!) ? "flat-normal-512.png"
      : ["roughness.png", "substrate_roughness.png", "substrate.png"].includes(file!) ? "gray-128-512.png" : null;
    if (fixture) await route.fulfill({ contentType: "image/png", body: await readFile("tests/fixtures/tissue-materials/" + fixture) });
    else await route.continue();
  });
  await page.goto(entryUrl); await ready(page);
  for (const label of ["Vessel coverage", "Fascia coverage", "Adipose coverage", "Wet coat"]) await page.getByLabel(label, { exact: true }).fill("0");
  for (const [study, expected] of [["normal", [128, 128, 255]], ["roughness", [128, 128, 128]], ["albedo", [128, 128, 128]]] as const) {
    await page.getByLabel("Surface study", { exact: true }).selectOption(study); await rendered(page);
    const actual = await page.evaluate(async source => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      return Array.from(context.getImageData(Math.floor(image.width / 2), Math.floor(image.height / 2), 1, 1).data).slice(0, 3);
    }, await pixels(page));
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(actual[channel]! - expected[channel]!)).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});

test("standalone production entry resolves relative maps and native walkthrough", async ({ page }) => {
  const production = process.env.TISSUE_PRODUCTION_URL;
  test.skip(!production, "Set TISSUE_PRODUCTION_URL to the built tissues.html entry.");
  const errors = monitor(page);
  await page.goto(production!); await ready(page);
  await page.getByLabel("Map resolution", { exact: true }).selectOption("4096"); await ready(page, "liver", 4096);
  await page.getByLabel("Tissue region", { exact: true }).selectOption("colonic_mucosa"); await ready(page, "colonic_mucosa", 4096);
  await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
  expect((await snapshot(page)).geometry).toBe("curved-lumen-phantom-v3");
  await capture(page, "production-standalone"); expect(errors).toEqual([]);
});

test("mobile material controls and lumen walkthrough remain operable", async ({ page }) => {
  const errors = monitor(page);
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(entryUrl); await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByLabel("Tissue region", { exact: true }).selectOption("gastric_mucosa"); await ready(page, "gastric_mucosa");
    await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
    await page.getByLabel("Vessel coverage", { exact: true }).fill("0.3"); await rendered(page);
    expect((await snapshot(page)).vessels).toBe(.3);
    await page.screenshot({ path: `${evidence}/mobile-${width}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
});


test("each supported exterior uses only its matching source atlas structures", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  const expected: Record<string, string[]> = { liver: ["liver"], kidney: ["right-kidney", "left-kidney"], heart: ["heart"], lung: ["right-lung", "left-lung"], spleen: ["spleen"], stomach: ["stomach"], small_bowel: ["small-intestine"], large_bowel: ["colon"], pancreas: ["pancreas"], gallbladder: ["gallbladder"], bladder: ["urinary-bladder"], mesentery: ["mesentery"] };
  for (const [organ, nodes] of Object.entries(expected)) {
    await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ);
    await page.getByLabel("View", { exact: true }).selectOption("organ");
    await expect.poll(async () => (await snapshot(page)).geometry).toBe("source-atlas-exterior-v1"); await ready(page, organ);
    const state = await snapshot(page); expect(state.atlas.nodes).toEqual(nodes);
    expect(state.atlas.assetSha256).toMatch(/^[a-f0-9]{64}$/); expect(state.atlas.license).toBe("CC-BY-4.0"); expect(state.atlas.units).toContain("assumed");
    expect(state.temporalBinding).toBe("object-mm-triplanar");
    const first = await pixels(page), opposite = await pixels(page, 480, 270, 6);
    const change = await imageDifference(page, first, opposite);
    expect(change.meanAbsoluteByteDifference).toBeGreaterThan(.25); expect(change.secondMaximumByte).toBeGreaterThan(18);
    expect((await imageDifference(page, first, await pixels(page, 480, 270, 24))).meanAbsoluteByteDifference).toBeLessThan(.05);
    if (organ === "liver") {
      const canvas = page.locator(".tissue-viewport canvas"), box = (await canvas.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 40, { steps: 12 }); await page.mouse.up();
      const manual = () => host(page).evaluate((element: CaptureHost) => element.captureTissueFrame(480, 270));
      // Observe convergence instead of assuming a particular frame rate for damping.
      let previous = await manual();
      await expect.poll(async () => {
        await rendered(page); const current = await manual();
        const delta = (await imageDifference(page, previous, current)).meanAbsoluteByteDifference; previous = current; return delta;
      }).toBeLessThan(.01);
      const inspected = await manual();
      expect((await imageDifference(page, first, inspected)).meanAbsoluteByteDifference).toBeGreaterThan(.25);
      await pixels(page, 480, 270, 6);
      expect((await imageDifference(page, inspected, await manual())).meanAbsoluteByteDifference).toBeLessThan(.05);
    }
    await capture(page, "atlas-" + organ);
    await page.getByLabel("View", { exact: true }).selectOption("surface"); await rendered(page);
  }
  for (const organ of ["uterus", "gastric_mucosa"]) {
    await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ);
    await expect(page.getByLabel("View", { exact: true }).locator('option[value="organ"]')).toHaveJSProperty("disabled", true);
  }
  expect(errors).toEqual([]);
});

test("lumen inspection covers reverse and pole directions with exact reset", async ({ page }) => {
  const errors = monitor(page);
  await page.goto(entryUrl); await ready(page);
  for (const organ of ["colonic_mucosa", "intestinal_mucosa", "gastric_mucosa"]) {
    await page.getByLabel("Tissue region", { exact: true }).selectOption(organ); await ready(page, organ);
    await page.getByLabel("View", { exact: true }).selectOption("walkthrough"); await rendered(page);
    await page.getByRole("button", { name: "Look along the path", exact: true }).click(); await rendered(page);
    const forward = await pixels(page);
    for (const [yaw, pitch] of [[180, 0], [-180, 0], [90, 0], [-90, 0], [0, 90], [0, -90]]) {
      await page.getByLabel("Camera yaw", { exact: true }).fill(String(yaw)); await page.getByLabel("Camera pitch", { exact: true }).fill(String(pitch)); await rendered(page);
      const state = await snapshot(page); expect([state.cameraYawDeg, state.cameraPitchDeg]).toEqual([yaw, pitch]);
      const difference = await imageDifference(page, forward, await pixels(page));
      expect(difference.meanAbsoluteByteDifference).toBeGreaterThan(.25); expect(difference.secondDarkFraction).toBeLessThan(.95);
      await capture(page, `${organ}-yaw${yaw}-pitch${pitch}`);
    }
    await page.getByRole("button", { name: "Look along the path", exact: true }).click(); await rendered(page);
    expect(await pixels(page)).toBe(forward);
  }
  expect(errors).toEqual([]);
});

test("atlas orbit records actual native UHD motion with source provenance", async ({ page }) => {
  const errors = monitor(page); await mkdir(evidence, { recursive: true });
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("Map resolution", { exact: true }).selectOption("4096"); await ready(page, "liver", 4096);
  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect.poll(async () => (await snapshot(page)).geometry).toBe("source-atlas-exterior-v1"); await ready(page, "liver", 4096);
  const result = await host(page).evaluate(async (element: HTMLDivElement & { recordTissueVideo: (seconds: number) => Promise<{ blob: Blob; metrics: { width: number; height: number; durationSeconds: number; mimeType: string } }> }) => {
    const result = await element.recordTissueVideo(3);
    const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = reject; reader.onload = () => resolve(String(reader.result).split(",")[1]!); reader.readAsDataURL(result.blob); });
    return { data, metrics: result.metrics };
  });
  const file = `${evidence}/liver-atlas-3840x2160.${result.metrics.mimeType.startsWith("video/mp4") ? "mp4" : "webm"}`; await writeFile(file, Buffer.from(result.data, "base64"));
  const probe = JSON.parse((await executeFile("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,nb_read_frames:frame=best_effort_timestamp_time", "-of", "json", file])).stdout);
  expect([probe.streams[0].width, probe.streams[0].height]).toEqual([3840, 2160]);
  const timestamps = probe.frames.map((frame: { best_effort_timestamp_time: string }) => Number(frame.best_effort_timestamp_time));
  expect(timestamps.at(-1) - timestamps[0]).toBeGreaterThan(2.1); expect(timestamps.slice(1).every((value: number, index: number) => value > timestamps[index])).toBe(true);
  const raw = await executeFile("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=96:54", "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"], { encoding: "buffer", maxBuffer: 4_000_000 });
  const stride = 96 * 54 * 3, decoded = raw.stdout; expect(decoded.length / stride).toBe(Number(probe.streams[0].nb_read_frames));
  let changed = 0; for (let offset = stride; offset < decoded.length; offset += stride) if (!decoded.subarray(offset, offset + stride).equals(decoded.subarray(offset - stride, offset))) changed++;
  expect(changed).toBe(decoded.length / stride - 1);
  await writeFile(`${evidence}/liver-atlas-video.json`, JSON.stringify({ snapshot: await snapshot(page), metrics: result.metrics, probe, decodedFrames: decoded.length / stride, changedFrames: changed }, null, 2));
  expect(errors).toEqual([]);
});

test("atlas loading failures clear busy state and retry only after an explicit selection", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let requests = 0, releaseFailure: (() => void) | undefined;
  await page.route("**/anatomy-scene/manifest.json", async route => {
    requests++;
    if (requests === 1) return route.fulfill({ status: 503, body: "temporary atlas failure" });
    if (requests === 2) { await new Promise<void>(resolve => { releaseFailure = resolve; }); return route.fulfill({ status: 503, body: "late atlas failure" }); }
    return route.continue();
  });
  await page.goto(entryUrl); await ready(page);
  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect(page.getByRole("alert")).toContainText("Atlas manifest unavailable");
  await expect(page.locator(".tissue-viewport")).not.toHaveAttribute("aria-busy", "true"); expect(requests).toBe(1);
  await page.getByLabel("View", { exact: true }).selectOption("surface");
  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect.poll(() => requests).toBe(2);
  await page.getByLabel("View", { exact: true }).selectOption("surface");
  releaseFailure!();
  await expect(page.locator(".tissue-viewport")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.getByRole("alert")).toHaveCount(0); expect(requests).toBe(2);
  await page.getByLabel("View", { exact: true }).selectOption("organ");
  await expect.poll(async () => (await snapshot(page)).geometry).toBe("source-atlas-exterior-v1"); await ready(page);
  expect(requests).toBe(3); expect(errors).toEqual([]);
});
