import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
const iteration = process.env.VISCERA_QUALITY_ITERATION ?? "current";
const evidence = fileURLToPath(new URL(`../../benchmarks/results/whole-scene-quality-2026-10-08/${iteration}/`, import.meta.url));
const host = (page: Page) => page.locator("[data-scene-ready='true'][data-scene-snapshot]");
const snapshot = async (page: Page) => JSON.parse(await host(page).getAttribute("data-scene-snapshot") ?? "{}");
async function settled(page: Page) {
  await expect.poll(async () => {
    const state = await snapshot(page);
    return state.rendering?.mode !== "on-demand" || (!state.rendering.renderPending && !state.rendering.cameraTransition && state.rendering.renderedRevision === state.rendering.sceneRevision);
  }).toBe(true);
}
async function capture(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await settled(page);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.screenshot({ path: join(evidence, `${name}.png`) });
  await writeFile(join(evidence, `${name}.json`), JSON.stringify(await snapshot(page), null, 2));
}
async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`); });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const assetOverride = process.env.VISCERA_QUALITY_ASSET_DIR;
  if (assetOverride) {
    for (const [name, contentType] of [["bodyparts3d-torso.glb", "model/gltf-binary"], ["manifest.json", "application/json"]]) {
      await page.route(`**/anatomy-scene/${name}`, route => route.fulfill({ path: resolve(assetOverride, name), contentType }));
    }
  }
  await page.goto(`/?mode=scene${process.env.VISCERA_QUALITY_QUERY ? `&${process.env.VISCERA_QUALITY_QUERY}` : ""}`);
  await expect(host(page).locator("canvas")).toBeVisible();
  const manifest = await (await page.request.get("/anatomy-scene/manifest.json")).json();
  await expect.poll(async () => (await snapshot(page)).organs.length).toBe(manifest.organs.length);
  return errors;
}
async function zoom(page: Page) {
  await settled(page);
  const box = (await host(page).locator("canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width*.5, box.y + box.height*.5);
  const initial = await snapshot(page);
  const before = JSON.stringify(initial.camera.position);
  await page.mouse.wheel(0, -650);
  await expect.poll(async () => JSON.stringify((await snapshot(page)).camera.position)).not.toBe(before);
  await expect.poll(async () => (await snapshot(page)).renderedFrames).toBeGreaterThan(initial.renderedFrames);
  await settled(page);
}

test("consistent full-scene and abdominal close-up views for independent quality comparison", async ({ page }) => {
  const errors = await open(page);
  for (const [label, name] of [["Front", "front"], ["¾ view", "oblique"], ["Back", "back"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await capture(page, name);
  }
  await page.getByRole("button", { name: "¾ view", exact: true }).click();
  await zoom(page);
  await capture(page, "abdomen-close-oblique");
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await settled(page);
  await zoom(page);
  await capture(page, "abdomen-close-front");
  await page.getByText("Explore the structures", { exact: false }).click();
  for (const label of ["Liver", "Stomach"]) await page.getByRole("button", { name: `Hide ${label}`, exact: true }).click();
  await page.getByRole("checkbox", { name: "Lungs & airways", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Diaphragm & supports", exact: true }).uncheck();
  await capture(page, "biliary-pancreas-close-front");
  await page.getByRole("button", { name: "¾ view", exact: true }).click();
  await zoom(page);
  await capture(page, "biliary-pancreas-close-oblique");
  expect(errors).toEqual([]);
});

const signatures = (state: any) => Object.fromEntries(state.organs.map((organ: any) => [organ.id, organ.geometrySignature]));
const distance = (camera: any) => Math.hypot(...camera.position.map((value: number, axis: number) => value - camera.target[axis]));

test("quality refinement preserves existing anatomy and exploration presets change visibility only", async ({ page }) => {
  const errors = await open(page);
  const initial = await snapshot(page);
  const previous = JSON.parse(await readFile(fileURLToPath(new URL("../../benchmarks/results/whole-scene-quality-2026-10-08/baseline/front.json", import.meta.url)), "utf8"));
  for (const organ of previous.organs) {
    const current = initial.organs.find((item: any) => item.id === organ.id);
    expect(current, organ.id).toBeDefined();
    expect(current.geometrySignature, `${organ.id} existing geometry`).toBe(organ.geometrySignature);
    expect(current.restBounds, `${organ.id} existing registration`).toEqual(organ.restBounds);
    expect(current.vertices, `${organ.id} existing vertices`).toBe(organ.vertices);
    expect(current.triangles, `${organ.id} existing triangles`).toBe(organ.triangles);
  }
  const abdominal = ["right-lung", "left-lung", "heart", "trachea", "bronchi", "diaphragm"];
  for (const [label, hidden] of [["Abdominal", abdominal], ["Deep anatomy", [...abdominal, "liver", "stomach", "colon", "small-intestine"]], ["Full torso", []]] as [string, string[]][]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).organs.every((organ: any) => organ.visible === (organ.category !== "skeleton" && !hidden.includes(organ.id)))).toBe(true);
    expect(signatures(await snapshot(page))).toEqual(signatures(initial));
    await capture(page, `preset-${label.toLowerCase().replaceAll(" ", "-")}`);
  }
  expect(errors).toEqual([]);
});

test("organ focus restores visibility, targets the selected structure, and resets without mutating anatomy", async ({ page }) => {
  const errors = await open(page);
  const initial = await snapshot(page);
  await page.getByRole("button", { name: "Deep anatomy", exact: true }).click();
  await page.getByText("Explore the structures", { exact: false }).click();
  await page.getByRole("button", { name: "Liver", exact: true }).click();
  const before = (await snapshot(page)).camera;
  await page.getByRole("button", { name: "Focus organ", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).organs.find((organ: any) => organ.id === "liver").visible).toBe(true);
  await expect.poll(async () => distance((await snapshot(page)).camera)).toBeLessThan(distance(before));
  const focused = await snapshot(page);
  expect(focused.camera.target).not.toEqual(before.target);
  const liver = focused.organs.find((organ: any) => organ.id === "liver");
  for (let axis = 0; axis < 3; axis++) expect(focused.camera.target[axis]).toBeCloseTo((liver.bounds.min[axis] + liver.bounds.max[axis]) / 2, 3);
  expect(signatures(focused)).toEqual(signatures(initial));
  await capture(page, "focus-liver");
  await page.getByRole("button", { name: "Hide organ", exact: true }).click();
  await expect(page.getByRole("button", { name: "Focus organ", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await snapshot(page)).organs.find((organ: any) => organ.id === "liver").visible).toBe(false);
  await page.getByRole("button", { name: "Gallbladder", exact: true }).click();
  await page.getByRole("button", { name: "Focus organ", exact: true }).click();
  await capture(page, "focus-gallbladder");
  await page.getByRole("button", { name: "Clear organ selection", exact: true }).click();
  await expect(page.getByRole("button", { name: "Focus organ", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Fit whole scene", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).camera.target).toEqual(initial.camera.target);
  expect(signatures(await snapshot(page))).toEqual(signatures(initial));
  expect(errors).toEqual([]);
});

test("mobile organ inspection keeps focus actions and camera presets visible and operable", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const errors = await open(page);
  await page.getByRole("button", { name: "Deep anatomy", exact: true }).click();
  await page.getByText("Explore the structures", { exact: false }).click();
  await page.getByRole("button", { name: "Hide Gallbladder", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).organs.find((organ: any) => organ.id === "gallbladder").visible).toBe(false);
  await page.getByRole("button", { name: "Focus Gallbladder", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).organs.find((organ: any) => organ.id === "gallbladder").visible).toBe(true);
  const actions = page.getByRole("button", { name: "Focus organ", exact: true });
  await actions.scrollIntoViewIfNeeded();
  const box = (await actions.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const geometry = await page.evaluate(() => ({ pageFooterTop: document.querySelector(".whole-footer")!.getBoundingClientRect().top, panelFooterBottom: document.querySelector(".whole-panel-footer")!.getBoundingClientRect().bottom }));
  expect(geometry.pageFooterTop).toBeGreaterThanOrEqual(geometry.panelFooterBottom - 1);
  await capture(page, "mobile-focus-gallbladder");
  await page.getByRole("button", { name: "Hide organ", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).organs.find((organ: any) => organ.id === "gallbladder").visible).toBe(false);
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).camera.view).toBe("front");
  expect(errors).toEqual([]);
});

const fullSignatures = (state: any) => Object.fromEntries(state.organs.map((organ: any) => [organ.id, [organ.geometrySignature, organ.materialSignature]]));

test("all expanded structures jointly vary, replay exactly and restore their atlas appearance", async ({ page }) => {
  const errors = await open(page);
  const baseline = await snapshot(page);
  const samples = [];
  let previous = baseline;
  for (let index = 0; index < 8; index++) {
    await page.getByRole("button", { name: "Joint scene variation", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).seed).not.toBe(previous.seed);
    const next = await snapshot(page);
    for (const organ of next.organs) {
      const prior = previous.organs.find((item: any) => item.id === organ.id);
      expect(organ.geometrySignature, `${organ.id} sample ${index} geometry`).not.toBe(prior.geometrySignature);
      expect(organ.materialSignature, `${organ.id} sample ${index} material`).not.toBe(prior.materialSignature);
      expect(organ.restBounds).toEqual(prior.restBounds);
      expect(organ.vertices).toBe(prior.vertices);
      expect(organ.triangles).toBe(prior.triangles);
    }
    samples.push(next); previous = next;
  }
  const replay = samples[2];
  await page.getByLabel("Scene seed", { exact: true }).fill(String(replay.seed));
  await page.getByRole("button", { name: "Replay seed", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).seed).toBe(replay.seed);
  expect(fullSignatures(await snapshot(page))).toEqual(fullSignatures(replay));
  await capture(page, "joint-variation");
  await page.getByRole("button", { name: "Restore atlas", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).baseline).toBe(true);
  expect(fullSignatures(await snapshot(page))).toEqual(fullSignatures(baseline));
  await writeFile(join(evidence, "variation-samples.json"), JSON.stringify(samples, null, 2));
  expect(errors).toEqual([]);
});

test("high resolution PNG exports real 4096 pixel imagery and restores the live renderer", async ({ page }) => {
  const errors = await open(page);
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await settled(page);
  const before = await snapshot(page);
  const canvasBefore = await host(page).locator("canvas").evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
  const pending = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save image", exact: true }).click();
  const download = await pending;
  await mkdir(evidence, { recursive: true });
  const path = join(evidence, "export-4096.png");
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  expect(Math.max(dimensions.width, dimensions.height)).toBe(4096);
  expect(dimensions.width / dimensions.height).toBeCloseTo(canvasBefore[0] / canvasBefore[1], 2);
  await expect.poll(async () => (await snapshot(page)).rendering.lastImageCapture?.width).toBe(dimensions.width);
  const after = await snapshot(page);
  expect(fullSignatures(after)).toEqual(fullSignatures(before));
  expect(after.camera).toEqual(before.camera);
  expect(await host(page).locator("canvas").evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height])).toEqual(canvasBefore);
  await settled(page);
  const idle = await snapshot(page);
  if (idle.rendering.mode === "on-demand") {
    await expect.poll(async () => (await snapshot(page)).animationFrames).toBeGreaterThan(idle.animationFrames + 30);
    expect((await snapshot(page)).renderedFrames).toBe(idle.renderedFrames);
  }
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).camera.view).toBe("back");
  await expect.poll(async () => (await snapshot(page)).renderedFrames).toBeGreaterThan(after.renderedFrames);
  await writeFile(join(evidence, "image-export-metadata.json"), JSON.stringify({ dimensions, canvasBefore, byteLength: bytes.length, rendering: after.rendering }, null, 2));
  expect(errors).toEqual([]);
});

test("expanded learned materials deform every soft structure and retain recovery, performance and video export", async ({ page }) => {
  const errors = await open(page);
  const atlas = await snapshot(page);
  await page.getByRole("button", { name: "Apply learned physics to all organs", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics?.running).toBe(true);
  const applied = await snapshot(page);
  expect(applied.physics.organs.map((organ: any) => organ.id).sort()).toEqual(atlas.organs.filter((organ: any) => organ.category !== "skeleton").map((organ: any) => organ.id).sort());
  for (const organ of applied.physics.organs) {
    expect(organ.parameters.accepted_for_application).toBe(true);
    expect(organ.parameters.observation_origin).toBe("synthetic-design-history");
  }
  await expect.poll(async () => (await snapshot(page)).physics.displacement_mm).toBeGreaterThan(0.15);
  const warmup = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).physics.time_s).toBeGreaterThan(warmup.physics.time_s + 2);
  const start = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).wall_time_ms).toBeGreaterThan(start.wall_time_ms + 5000);
  const end = await snapshot(page);
  const wall = (end.wall_time_ms - start.wall_time_ms) / 1000;
  const simulation = end.physics.time_s - start.physics.time_s;
  const timing = { wall_time_s: wall, simulation_time_s: simulation, simulation_to_wall_ratio: simulation / wall, rendered_fps: (end.renderedFrames - start.renderedFrames) / wall, dropped_time_delta_s: end.physics.dropped_time_s - start.physics.dropped_time_s, organs: end.organs.length, physics_organs: end.physics.organs.length, rendering: end.rendering, scope: "One local Chrome run, same diagnostic timestamps, no screenshot or recording during observation interval." };
  expect(end.physics.finite).toBe(true);
  expect(end.physics.renderedSamples.filter((organ: any) => !atlas.organs.find((part: any) => part.id === organ.id && part.category === "skeleton")).every((organ: any) => organ.maxSampleDisplacementMm > 0)).toBe(true);
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics.running).toBe(false);
  await page.getByRole("checkbox", { name: /Breathing/ }).uncheck();
  await page.getByRole("button", { name: "Reset motion", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics.displacement_mm).toBe(0);
  await page.getByText("Explore the structures", { exact: false }).click();
  await page.getByRole("button", { name: "Liver", exact: true }).click();
  await page.getByRole("button", { name: "Resume physics", exact: true }).click();
  await page.getByRole("button", { name: "Palpate selected organ", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics.peak_displacement_mm).toBeGreaterThan(0.1);
  const loaded = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).physics.displacement_mm, { timeout: 30_000 }).toBeLessThan(0.025);
  const recovered = await snapshot(page);
  expect(recovered.physics.finite).toBe(true);
  expect(recovered.physics.stabilization_count).toBe(0);
  expect(signatures(recovered)).toEqual(signatures(atlas));
  await page.getByRole("button", { name: "Clear organ selection", exact: true }).click();
  await page.getByRole("checkbox", { name: /Breathing/ }).check();
  await page.getByRole("button", { name: "¾ view", exact: true }).click();
  const pending = page.waitForEvent("download", { timeout: 45_000 });
  await page.getByRole("button", { name: "Record tour", exact: true }).click();
  const video = await pending;
  await mkdir(evidence, { recursive: true });
  const videoPath = join(evidence, "quality-physics-tour.webm");
  await video.saveAs(videoPath);
  const bytes = await readFile(videoPath);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(bytes.length).toBeGreaterThan(200_000);
  await writeFile(join(evidence, "physics-performance.json"), JSON.stringify(timing, null, 2));
  await writeFile(join(evidence, "physics-metadata.json"), JSON.stringify({ applied, loaded, recovered, afterVideo: await snapshot(page) }, null, 2));
  await page.getByRole("button", { name: "Remove physics", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics).toBeNull();
  expect(errors).toEqual([]);
});
