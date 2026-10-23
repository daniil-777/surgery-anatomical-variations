/** Actual six-condition artifact integration. This does not execute fixture tests.
 * First run validate_tissue_model_parity.py against the downloaded model SHA.
 * node scripts/check_tissue_model_browser.mjs --model MODEL --parity PARITY_DIR
 *   --output NEW_DIR --url http://127.0.0.1:8823/tissues.html
 *   --expected-training-steps 3000 (explicitly pin a later training run)
 * --preflight-only verifies inputs/references and never launches a browser.
 * --engineering-proof uses a retained real-data pilot parity receipt, distinctly
 * labelled as integration proof rather than the next completed training run.
 * Rendering here is small diagnostic evidence; UHD/motion/realism remain separate.
 */
import { chromium, expect } from "@playwright/test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: options } = parseArgs({ options: {
  model: { type: "string" }, parity: { type: "string" }, output: { type: "string" },
  url: { type: "string", default: "http://127.0.0.1:8823/tissues.html" },
  "preflight-only": { type: "boolean", default: false },
  "expected-training-steps": { type: "string", default: "2000" },
  "engineering-proof": { type: "boolean", default: false },
} });
if (!options.model || !options.parity || !options.output) throw new Error("Required: --model MODEL --parity PASSED_PARITY_DIR --output NEW_DIR [--url URL] [--preflight-only]");
const modelPath = path.resolve(options.model), parityPath = path.resolve(options.parity), output = path.resolve(options.output);
const url = new URL(options.url);
const expectedSteps = Number(options["expected-training-steps"]);
if (!/^[1-9][0-9]*$/.test(options["expected-training-steps"]) || !Number.isSafeInteger(expectedSteps)) throw new Error("Expected a positive integer --expected-training-steps");
if (!["http:", "https:"].includes(url.protocol)) throw new Error("Expected an HTTP(S) Studio URL");
await mkdir(path.dirname(output), { recursive: true });
await mkdir(output); // Never replace failed or accepted evidence.
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const expectedMappings = new Map([
  ["large_bowel", "colon"], ["liver", "liver"], ["pancreas", "pancreas"],
  ["small_bowel", "small_intestine"], ["spleen", "spleen"], ["stomach", "stomach"],
]);
const unsupported = ["colonic_mucosa", "gastric_mucosa", "intestinal_mucosa", "kidney"];
const report = { schema: "viscera.actual-tissue-model-browser-check/v1", status: "running", startedUtc: new Date().toISOString(),
  url: url.href, output, modelPath, parityPath, browserExecuted: false, fixtureModelUsed: false,
  byteTolerance: 1, learnedResolution: 256, authoredMapResolution: 512,
  scope: options["engineering-proof"]
    ? "Retained real-data pilot integration proof; not the next completed training run, UHD throughput, photorealism or clinical acceptance."
    : "Actual imported model integration and pixel parity; no UHD throughput, photorealism or clinical acceptance.",
  engineeringProof: options["engineering-proof"],
  samples: [], authoredRestoration: [], unsupportedRegions: [], resourceChecks: [], errors: [], optionalConfigProbes: [] };
let browser, context, page, modelSha, architecture, canonical, sourceHashes;
const host = () => page.locator(".tissue-viewport[data-tissue-ready='true']");
const snapshot = async () => JSON.parse(await host().getAttribute("data-tissue-snapshot") ?? "{}");
const geometryFor = region => expectedMappings.has(region) ? "source-atlas-exterior-v1" : "80-mm-surface-coupon";
const frame = () => host().evaluate(element => element.captureTissueFrame(480, 270, 0));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

function metrics(actual, expected) {
  assert.equal(actual.length, expected.length, "decoded pixel shape mismatch");
  let maximum = 0, total = 0, changed = 0;
  for (let index = 0; index < actual.length; index++) {
    const difference = Math.abs(actual[index] - expected[index]);
    maximum = Math.max(maximum, difference); total += difference; changed += Number(difference !== 0);
  }
  return { maximumAbsoluteByteDifference: maximum, meanAbsoluteByteDifference: total / actual.length,
    differentChannels: changed, comparedChannels: actual.length };
}

async function preflight() {
  const modelBytes = await readFile(modelPath), model = JSON.parse(modelBytes.toString());
  modelSha = sha256(modelBytes); architecture = model.architecture;
  assert.ok(["viscera.tissue-appearance-decoder/v1", "viscera.tissue-appearance-decoder/v2", "viscera.tissue-appearance-decoder/v3"].includes(model.schema), "Unsupported artifact schema");
  const directional = model.schema === "viscera.tissue-appearance-decoder/v2";
  const spatial = model.schema === "viscera.tissue-appearance-decoder/v3";
  assert.equal(model.model_type, spatial ? "masked-rgb-spatial-cvae-gan-v1" : directional ? "masked-rgb-directional-cvae-gan-v1" : "masked-rgb-periodic-cvae-v1");
  report.learnedNativeResolution = spatial ? 128 : null;
  report.outputSampling = spatial ? "periodic-bilinear-pixel-centers" : "direct-coordinate-inference";
  if (spatial) assert.deepEqual(architecture.native_resolution, [128, 128]);
  assert.equal(model.provenance.training_status, "research_trained", "Actual-model harness rejects fixture weights");
  assert.equal(model.provenance.training_steps, expectedSteps, "Expected the explicitly pinned trained update count");
  assert.equal(architecture.condition_labels.length, 6);
  assert.equal(architecture.condition_regions.length, 6);
  assert.equal(architecture.condition_species.length, 6);
  assert.equal(new Set(architecture.condition_regions).size, 6);
  architecture.condition_regions.forEach((region, index) => {
    assert.ok(expectedMappings.has(region), "Unexpected learned region: " + region);
    assert.equal(architecture.condition_labels[index], "human:laparoscopic_exterior:" + expectedMappings.get(region));
    assert.equal(architecture.condition_species[index], "human");
  });
  const parityBytes = await readFile(path.join(parityPath, "receipt.json")), parity = JSON.parse(parityBytes);
  assert.equal(parity.schema, "viscera.tissue-full-decoder-parity/v1");
  assert.equal(parity.status, "passed");
  assert.equal(parity.scope, options["engineering-proof"] ? "retained-pilot-proof" : "incoming-six-condition");
  assert.equal(parity.claims.incoming_numerical_parity_validated, !options["engineering-proof"]);
  assert.equal(parity.model.sha256, modelSha, "Parity evidence is for a different model");
  assert.equal(parity.byte_tolerance, 1); assert.equal(parity.resolution, 256);
  assert.deepEqual(parity.seeds_in_order, ["42", "43", "18446744073709551615", "42"]);
  assert.equal(parity.samples.length, 24); assert.equal(parity.summary.all_replays_exact, true);
  const paritySourceFiles = ["scripts/validate_tissue_model_parity.py",
    "scripts/check_tissue_decoder.mjs", "apps/studio/src/tissues/neuralAppearance.ts",
    "apps/studio/src/tissues/neuralAppearanceConv.ts",
    "py/viscera_core/tissue_learning/artifact.py", "py/viscera_core/tissue_learning/model.py",
    "py/viscera_core/tissue_learning/config.py"];
  if (directional || spatial) {
    assert.equal(parity.artifact_schema, model.schema);
    paritySourceFiles.push(...["artifact.py", "model.py", "config.py"].map(file => "py/viscera_core/tissue_learning_detail/" + file));
  }
  if (spatial) {
    assert.equal(parity.artifact_schema, model.schema);
    paritySourceFiles.push(...["artifact.py", "model.py", "config.py"].map(file => "py/viscera_core/tissue_learning_conv/" + file));
    assert.deepEqual(parity.sampling.native_resolution, [128, 128]);
    assert.deepEqual(parity.sampling.output_resolution, [256, 256]);
    assert.equal(parity.sampling.method, "periodic-bilinear-pixel-centers");
    assert.equal(parity.sampling.independent_high_resolution_detail, false);
  }
  assert.deepEqual(Object.keys(parity.source_sha256).sort(), paritySourceFiles.sort(), "Parity source inventory is incomplete");
  for (const [file, digest] of Object.entries(parity.source_sha256)) {
    assert.equal(sha256(await readFile(path.join(root, file))), digest, "Parity source changed: " + file);
  }
  canonical = new Map(); const observedPairs = new Set();
  for (const sample of parity.samples) {
    assert.ok(Number.isInteger(sample.run) && sample.run >= 1 && sample.run <= 4);
    assert.ok(Number.isInteger(sample.condition) && sample.condition >= 0 && sample.condition < 6);
    const pair = `${sample.run}:${sample.condition}`;
    assert.ok(!observedPairs.has(pair), "Duplicate run/condition parity sample"); observedPairs.add(pair);
    assert.deepEqual(Object.keys(sample.metrics).sort(), ["torch_vs_numpy", "studio_vs_numpy", "studio_vs_torch"].sort());
    for (const value of Object.values(sample.metrics)) {
      assert.equal(value.passed, true); assert.equal(value.tolerance_bytes, 1);
      assert.ok(Number.isFinite(value.maximum_absolute_error_bytes) && value.maximum_absolute_error_bytes >= 0 && value.maximum_absolute_error_bytes <= 1);
      assert.ok(Number.isFinite(value.mean_absolute_error_bytes) && value.mean_absolute_error_bytes >= 0 && value.mean_absolute_error_bytes <= 1);
      assert.equal(value.compared_channels, 256 * 256 * 3);
      assert.ok(Number.isInteger(value.different_channels) && value.different_channels >= 0 && value.different_channels <= value.compared_channels);
    }
    assert.equal(sample.seed, parity.seeds_in_order[sample.run - 1]);
    assert.equal(sample.label, architecture.condition_labels[sample.condition]);
    const file = path.join(parityPath, `run-${sample.run}-seed-${sample.seed}`, `condition-${sample.condition}-seed${sample.seed}-256.rgba`);
    const rgba = await readFile(file);
    assert.equal(rgba.length, 256 * 256 * 4); assert.equal(sha256(rgba), sample.studio_rgba_sha256);
    for (let index = 3; index < rgba.length; index += 4) assert.equal(rgba[index], 255);
    const key = `${sample.condition}:${sample.seed}`;
    if (canonical.has(key)) assert.deepEqual(rgba, canonical.get(key), "Canonical replay changed");
    canonical.set(key, rgba);
  }
  assert.equal(observedPairs.size, 24); assert.equal(canonical.size, 18);
  report.modelSha256 = modelSha; report.provenance = model.provenance; report.artifactSchema = model.schema; report.expectedTrainingSteps = expectedSteps;
  report.conditionMappings = architecture.condition_regions.map((region, index) => ({ index, region, label: architecture.condition_labels[index], species: architecture.condition_species[index] }));
  report.parityReceiptSha256 = sha256(parityBytes);
  sourceHashes = {};
  const tissueFiles = (await readdir(path.join(root, "apps/studio/src/tissues")))
    .filter(file => /\.(tsx?|css)$/.test(file)).map(file => "apps/studio/src/tissues/" + file);
  for (const file of ["scripts/check_tissue_model_browser.mjs", ...tissueFiles]) {
    sourceHashes[file] = sha256(await readFile(path.join(root, file)));
  }
  report.implementationSha256 = sourceHashes;
  report.preflight = { passed: true, canonicalTextures: canonical.size, canonicalReplays: 6, currentParitySourcesMatched: true };
}

async function ready(region, learned, seed = "42", geometry = geometryFor(region)) {
  await page.waitForFunction(({ region, learned, seed, geometry, modelSha }) => {
    const element = document.querySelector(".tissue-viewport[data-tissue-ready='true']");
    if (!element || typeof element.captureTissueFrame !== "function" || document.querySelector(".tissue-loading")) return false;
    const state = JSON.parse(element.dataset.tissueSnapshot ?? "{}");
    return state.organ === region && state.geometry === geometry && state.resolution?.[0] === 512
      && (learned ? state.appearance?.modelId === modelSha && state.appearance?.region === region
        && state.appearance?.seed === seed && state.appearance?.resolution === 256
        && state.appearance?.evidence === "research_trained" : state.appearance === null);
  }, { region, learned, seed, geometry, modelSha }, { timeout: 120000 });
  await expect(page.getByRole("alert")).toHaveCount(0); await settle();
}

async function regionView(region, learned, seed = "42") {
  await page.getByLabel("Tissue region", { exact: true }).selectOption(region);
  await page.getByLabel("View", { exact: true }).selectOption(expectedMappings.has(region) ? "organ" : "surface");
  await page.getByLabel("Surface study", { exact: true }).selectOption("albedo");
  await ready(region, learned, seed);
}

async function decodedPng(bytes) {
  return Buffer.from(await page.evaluate(async base64 => {
    const image = new Image(); image.src = "data:image/png;base64," + base64; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
    const drawing = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
    drawing.drawImage(image, 0, 0);
    return Array.from(drawing.getImageData(0, 0, image.width, image.height).data);
  }, bytes.toString("base64")));
}

async function checkTexture(region, seed, name) {
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download learned RGB texture", exact: true }).click();
  const download = await pending, file = name + ".png";
  await download.saveAs(path.join(output, file));
  const png = await readFile(path.join(output, file));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 256); assert.equal(png.readUInt32BE(20), 256);
  const pixels = await decodedPng(png), condition = architecture.condition_regions.indexOf(region);
  const difference = metrics(pixels, canonical.get(`${condition}:${seed}`));
  const state = await snapshot();
  assert.equal(state.appearance.condition, architecture.condition_labels[condition]);
  report.samples.push({ file, region, condition, seed, pngSha256: sha256(png), rgbaSha256: sha256(pixels), difference, snapshot: state });
  assert.ok(difference.maximumAbsoluteByteDifference <= 1, "Browser PNG differs from canonical TS by more than one byte");
  return pixels;
}

async function compareAuthored(region, baseline, name) {
  const actual = await frame();
  await writeFile(path.join(output, name + ".png"), Buffer.from(actual.split(",")[1], "base64"));
  assert.equal(actual, baseline, "Authored material changed for " + region);
  return { region, exactFixedTimeFrameMatch: true, snapshot: await snapshot() };
}

async function executeBrowser() {
  browser = await chromium.launch({ headless: true, ...(process.platform === "darwin" ? {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", args: ["--use-gl=angle", "--use-angle=metal"],
  } : {}) });
  report.browserExecuted = true; report.browserVersion = await browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  page = await context.newPage(); page.setDefaultTimeout(120000);
  page.on("pageerror", error => report.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !message.location().url.endsWith("/api.json")) report.errors.push(message.text()); });
  page.on("response", response => {
    if (response.status() < 400) return;
    const failure = response.status() + " " + response.url();
    if (response.status() === 404 && new URL(response.url()).pathname.endsWith("/api.json")) report.optionalConfigProbes.push(failure);
    else report.errors.push(failure);
  });
  const response = await page.goto(url.href); assert.ok(response?.ok());
  report.servedEntrySha256 = sha256(await response.body());
  await expect(host()).toHaveCount(1, { timeout: 120000 });
  const baselines = new Map();
  for (const region of [...expectedMappings.keys(), ...unsupported]) {
    await regionView(region, false);
    const baseline = await frame(); baselines.set(region, baseline);
    await writeFile(path.join(output, region + "-authored-before.png"), Buffer.from(baseline.split(",")[1], "base64"));
  }
  await regionView("liver", false);
  await page.getByLabel("Import Colab tissue model").setInputFiles(modelPath);
  await ready("liver", true);
  await expect(page.getByLabel("Learned RGB resolution")).toHaveValue("256");
  for (const region of expectedMappings.keys()) {
    await regionView(region, true);
    const canvas = await host().locator("canvas").elementHandle(); assert.ok(canvas);
    const requests = [], listener = request => { if (/\/(?:anatomy-scene|tissue-materials)\//.test(request.url())) requests.push(request.url()); };
    page.on("request", listener);
    let first;
    for (const [index, seed] of ["42", "43", "42"].entries()) {
      await page.getByLabel("Appearance seed", { exact: true }).fill(seed); await ready(region, true, seed);
      const pixels = await checkTexture(region, seed, `${region}-seed${seed}-run${index + 1}`);
      if (index === 0) first = pixels;
      if (index === 2) assert.deepEqual(pixels, first, "Browser seed42 replay is not exact");
      assert.ok(await canvas.evaluate(element => element.isConnected), "Seed changes recreated the atlas canvas");
    }
    const learned = await frame(); assert.notEqual(learned, baselines.get(region), "Learned appearance did not change rendered RGB");
    await writeFile(path.join(output, region + "-learned-seed42.png"), Buffer.from(learned.split(",")[1], "base64"));
    await page.getByRole("checkbox", { name: "Use learned appearance" }).uncheck(); await ready(region, false);
    report.authoredRestoration.push(await compareAuthored(region, baselines.get(region), region + "-authored-restored"));
    await page.getByRole("checkbox", { name: "Use learned appearance" }).check(); await ready(region, true);
    assert.ok(await canvas.evaluate(element => element.isConnected), "Toggling recreated the atlas canvas");
    page.off("request", listener); assert.deepEqual(requests, [], "Seed/toggle reloaded authored assets");
    report.resourceChecks.push({ region, originalCanvasRetained: true, authoredAssetRequestsDuringSeedAndToggle: requests });
    console.log("Passed browser PNG parity/replay/toggle: " + region);
  }
  for (const region of unsupported) {
    await regionView(region, false);
    await expect(page.getByText(`This model does not cover ${region.replaceAll("_", " ")}.`, { exact: false })).toBeVisible();
    await expect(page.getByLabel("Learned tissue condition")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Download learned RGB texture", exact: true })).toHaveCount(0);
    report.unsupportedRegions.push(await compareAuthored(region, baselines.get(region), region + "-unsupported-authored"));
  }
  await page.reload(); await ready("liver", true, "42", "80-mm-surface-coupon");
  await checkTexture("liver", "42", "liver-restored-after-reload");
  report.persistence = { restoredModelSha256: (await snapshot()).appearance.modelId, restoredSeed: "42" };
  const maximumSeed = "18446744073709551615";
  await page.getByLabel("Appearance seed", { exact: true }).fill(maximumSeed);
  await ready("liver", true, maximumSeed, "80-mm-surface-coupon");
  await checkTexture("liver", maximumSeed, "liver-uint64-max");
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export material + display recipe", exact: true }).click();
  await (await pending).saveAs(path.join(output, "uint64-max-recipe.json"));
  const recipe = JSON.parse(await readFile(path.join(output, "uint64-max-recipe.json"), "utf8"));
  assert.equal(recipe.learnedAppearance.modelId, modelSha); assert.equal(recipe.learnedAppearance.seed, maximumSeed);
  assert.equal(recipe.learnedAppearance.resolution, 256); assert.equal(recipe.learnedAppearance.pbrGroundTruth, false);
  report.uint64RecipePreserved = true;
  await page.getByRole("button", { name: "Remove imported model", exact: true }).click();
  await ready("liver", false, "42", "80-mm-surface-coupon");
  await expect(page.getByText("Model removed from this browser.", { exact: true })).toBeVisible();
  await page.reload(); await ready("liver", false, "42", "80-mm-surface-coupon");
  await expect(page.getByRole("button", { name: "Remove imported model", exact: true })).toHaveCount(0);
  await regionView("liver", false); await compareAuthored("liver", baselines.get("liver"), "liver-after-remove-and-reload");
  report.removalPersists = true;
  await page.screenshot({ path: path.join(output, "final-removed-model-ui.png") });
  assert.deepEqual(report.errors, [], "Browser/HTTP errors occurred");
}

try {
  await preflight();
  if (!options["preflight-only"]) await executeBrowser();
  assert.equal(sha256(await readFile(modelPath)), modelSha, "Model changed during browser validation");
  for (const [file, expected] of Object.entries(sourceHashes)) assert.equal(sha256(await readFile(path.join(root, file))), expected, "Implementation changed during validation: " + file);
  report.status = options["preflight-only"] ? "preflight-passed-browser-not-run" : "passed";
} catch (error) {
  report.status = "failed"; report.failure = { name: error.name, message: error.message, stack: error.stack };
  if (page) await page.screenshot({ path: path.join(output, "failure-ui.png") }).catch(() => {});
  process.exitCode = 1;
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {});
  report.finishedUtc = new Date().toISOString();
  await writeFile(path.join(output, "receipt.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ status: report.status, browserExecuted: report.browserExecuted,
  pixelComparisons: report.samples.length, receipt: path.join(output, "receipt.json"), failure: report.failure?.message }, null, 2));
