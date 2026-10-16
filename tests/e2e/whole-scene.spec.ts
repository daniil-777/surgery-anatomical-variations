import { expect, test, type Page, type Download } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const evidence = process.env.VISCERA_WHOLE_SCENE_EVIDENCE_DIR
  ? resolve(process.env.VISCERA_WHOLE_SCENE_EVIDENCE_DIR)
  : fileURLToPath(new URL("../../benchmarks/results/whole-scene-2026-10-08/", import.meta.url));
interface OrganSnapshot {
  id: string;
  label: string;
  category: string;
  visible: boolean;
  geometrySignature: string;
  materialSignature: string;
  bounds: { min: number[]; max: number[] };
  restBounds: { min: number[]; max: number[] };
  vertices: number;
  triangles: number;
}
interface SceneSnapshot {
  seed: number;
  strength: number;
  severity: number;
  baseline: boolean;
  camera: { view: string; position: unknown; target: unknown };
  motion: { breathing: boolean; phase: number; [key: string]: unknown };
  organs: OrganSnapshot[];
  [key: string]: unknown;
}
const host = (page: Page) => page.locator("[data-scene-ready='true'][data-scene-snapshot]");
async function snapshot(page: Page): Promise<SceneSnapshot> {
  return JSON.parse(await host(page).getAttribute("data-scene-snapshot") ?? "{}");
}
function signatures(value: SceneSnapshot) {
  return Object.fromEntries(value.organs.map(organ => [organ.id, [organ.geometrySignature, organ.materialSignature]]));
}
function isFiniteTree(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isFiniteTree);
  if (value && typeof value === "object") return Object.values(value).every(isFiniteTree);
  return true;
}
async function openScene(page: Page, reducedMotion = true) {
  const errors: string[] = [];
  const failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url ?? ""}`); });
  page.on("response", response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  if (reducedMotion) await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/?mode=scene${process.env.VISCERA_WHOLE_SCENE_SHADOWS === "off" ? "&sceneShadows=off" : ""}`);
  await expect(page.getByRole("heading", { name: "The connected body", exact: true })).toBeVisible();
  await expect(host(page).locator("canvas")).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).organs?.length ?? 0).toBeGreaterThan(10);
  return { errors, failures };
}
async function capture(page: Page, filename: string) {
  await mkdir(evidence, { recursive: true });
  if (await host(page).count()) {
    await expect.poll(async () => {
      const rendering = (await snapshot(page)).rendering as Record<string, unknown>;
      return !rendering.renderPending && rendering.renderedRevision === rendering.sceneRevision && !rendering.cameraTransition;
    }).toBe(true);
  }
  await page.screenshot({ path: join(evidence, `${process.env.VISCERA_WHOLE_SCENE_CAPTURE_PREFIX ?? ""}${filename}`), fullPage: true });
}
async function downloadBytes(download: Download) {
  const stream = await download.createReadStream();
  expect(stream).not.toBeNull();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function beginFixedCameraRecording(page: Page, durationMs: number) {
  await host(page).locator("canvas").evaluate((element, duration) => {
    const canvas = element as HTMLCanvasElement;
    const stream = canvas.captureStream(30);
    const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find(value => MediaRecorder.isTypeSupported(value));
    if (!type) throw new Error("Canvas video recording is unsupported.");
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
    const chunks: Blob[] = [];
    const state = window as Window & { __sceneQaClip?: Promise<number[]> };
    state.__sceneQaClip = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = () => reject(new Error("Fixed-camera evidence recording failed."));
      recorder.onstop = async () => {
        stream.getTracks().forEach(track => track.stop());
        resolve(Array.from(new Uint8Array(await new Blob(chunks, { type }).arrayBuffer())));
      };
    });
    recorder.start(100);
    setTimeout(() => recorder.stop(), duration);
  }, durationMs);
}
async function saveFixedCameraRecording(page: Page, filename: string) {
  const bytes = await page.evaluate(async () => {
    const state = window as Window & { __sceneQaClip?: Promise<number[]> };
    const result = await state.__sceneQaClip;
    delete state.__sceneQaClip;
    if (!result) throw new Error("Fixed-camera evidence was lost.");
    return result;
  });
  await writeFile(join(evidence, filename), Buffer.from(bytes));
}

// These cases use the real checked-in whole-scene meshes and renderer. No scene
// geometry, atlas payload, render diagnostics or export is replaced with a mock.
test("the whole registered atlas renders, keeps laterality, and exposes six actual camera angles", async ({ page }) => {
  const { errors, failures } = await openScene(page);
  const baseline = await snapshot(page);
  expect(baseline.baseline).toBe(true);
  expect(baseline.organs.every(organ => organ.vertices > 0 && organ.triangles > 0)).toBe(true);
  expect(new Set(baseline.organs.map(organ => organ.id)).size).toBe(baseline.organs.length);
  expect(isFiniteTree(baseline)).toBe(true);
  const labels = baseline.organs.map(organ => organ.label.toLowerCase()).join(" ");
  for (const required of ["stomach", "liver", "gallbladder", "pancreas", "kidney", "heart", "lung"]) expect(labels).toContain(required);
  const center = (id: string, axis: number) => {
    const organ = baseline.organs.find(item => item.id === id)!;
    expect(organ, id).toBeDefined();
    return (organ.bounds.min[axis]! + organ.bounds.max[axis]!) / 2;
  };
  expect(center("liver", 0)).toBeLessThan(0);
  expect(center("stomach", 0)).toBeGreaterThan(0);
  expect(center("spleen", 0)).toBeGreaterThan(center("stomach", 0));
  expect(center("right-kidney", 0)).toBeLessThan(center("left-kidney", 0));
  expect(center("right-kidney", 1)).toBeLessThan(center("left-kidney", 1));
  expect(center("right-kidney", 2)).toBeLessThan(center("liver", 2));
  expect(center("pancreas", 2)).toBeLessThan(center("stomach", 2));
  expect(center("right-lung", 1)).toBeGreaterThan(center("liver", 1));
  expect(center("left-lung", 1)).toBeGreaterThan(center("stomach", 1));
  expect(center("heart", 0)).toBeGreaterThan(center("right-lung", 0));
  expect(center("heart", 0)).toBeLessThan(center("left-lung", 0));
  for (const id of ["esophagus", "duodenum", "cystic-duct", "hepatic-duct", "pancreatic-duct", "portal-vein", "aorta", "vena-cava"]) {
    expect(baseline.organs.some(organ => organ.id === id), `source connection ${id}`).toBe(true);
  }
  const cameraPositions = new Set<string>();
  for (const [name, view] of [["Front", "front"], ["Back", "back"], ["Left", "left"], ["Right", "right"], ["Top", "top"], ["¾ view", "oblique"]]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).camera.view).toBe(view);
    const state = await snapshot(page);
    cameraPositions.add(JSON.stringify(state.camera.position));
    expect(signatures(state)).toEqual(signatures(baseline));
    await capture(page, `atlas-${view}.png`);
  }
  expect(cameraPositions.size).toBe(6);
  await page.getByRole("button", { name: "Front", exact: true }).click();
  const canvasBox = (await host(page).locator("canvas").boundingBox())!;
  const startX = canvasBox.x + canvasBox.width * 0.5;
  const startY = canvasBox.y + canvasBox.height * 0.6;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY - canvasBox.height * 0.12, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => {
    const camera = (await snapshot(page)).camera;
    return (camera.position as number[])[1]! - (camera.target as number[])[1]!;
  }).toBeLessThan(0);
  await capture(page, "atlas-inferior-orbit.png");
  await page.getByText("Explore the structures", { exact: false }).click();
  for (const label of ["Liver", "Stomach"]) {
    await page.getByRole("button", { name: `Hide ${label}`, exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).organs.find(organ => organ.label === label)!.visible).toBe(false);
  }
  await page.getByRole("checkbox", { name: "Lungs & airways", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Heart & vessels", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Diaphragm & supports", exact: true }).uncheck();
  await page.getByRole("button", { name: "Front", exact: true }).click();
  await capture(page, "connections-cutaway-front.png");
  await page.getByRole("button", { name: "¾ view", exact: true }).click();
  await capture(page, "connections-cutaway-oblique.png");
  for (const label of ["Liver", "Stomach"]) {
    await page.getByRole("button", { name: `Show ${label}`, exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).organs.find(organ => organ.label === label)!.visible).toBe(true);
  }
  expect(signatures(await snapshot(page))).toEqual(signatures(baseline));
  await writeFile(join(evidence, "baseline-render-metadata.json"), JSON.stringify(baseline, null, 2));
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});

test("repeated joint samples change every organ's actual geometry and material and replay deterministically", async ({ page }) => {
  const { errors, failures } = await openScene(page);
  const baseline = await snapshot(page);
  const samples: SceneSnapshot[] = [];
  let previous = baseline;
  for (let index = 0; index < 12; index++) {
    await page.getByRole("button", { name: "Joint scene variation", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).seed).not.toBe(previous.seed);
    const next = await snapshot(page);
    expect(next.baseline).toBe(false);
    expect(isFiniteTree(next)).toBe(true);
    expect(next.organs).toHaveLength(baseline.organs.length);
    for (const organ of next.organs) {
      const prior = previous.organs.find(item => item.id === organ.id)!;
      expect(organ.geometrySignature, `sample ${index}, ${organ.id}: geometry`).not.toBe(prior.geometrySignature);
      expect(organ.materialSignature, `sample ${index}, ${organ.id}: material`).not.toBe(prior.materialSignature);
      expect(organ.restBounds).toEqual(prior.restBounds);
      expect(organ.vertices).toBe(prior.vertices);
      expect(organ.triangles).toBe(prior.triangles);
    }
    samples.push(next);
    previous = next;
  }
  const replay = samples[2]!;
  await page.getByLabel("Scene seed", { exact: true }).fill(String(replay.seed));
  await page.getByRole("button", { name: "Replay seed", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).seed).toBe(replay.seed);
  expect(signatures(await snapshot(page))).toEqual(signatures(replay));
  await capture(page, "joint-variation.png");
  await page.getByRole("button", { name: "Restore atlas", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).baseline).toBe(true);
  expect(signatures(await snapshot(page))).toEqual(signatures(baseline));
  await writeFile(join(evidence, "variation-render-metadata.json"), JSON.stringify(samples, null, 2));
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});

test("camera tour and breathing are explicit in reduced motion, visibility is reversible, and image/video exports are real", async ({ page }) => {
  const { errors, failures } = await openScene(page);
  const baseline = await snapshot(page);
  expect(baseline.motion.breathing).toBe(false);
  await page.getByRole("checkbox", { name: /Breathing/ }).click();
  await expect.poll(async () => (await snapshot(page)).motion.breathing).toBe(true);
  const phase = (await snapshot(page)).motion.phase;
  await expect.poll(async () => (await snapshot(page)).motion.phase).not.toBe(phase);
  await page.getByRole("checkbox", { name: /Breathing/ }).click();
  await expect.poll(async () => (await snapshot(page)).motion.breathing).toBe(false);
  for (const [label, category] of [["Digestive organs", "digestive"], ["Lungs & airways", "respiratory"], ["Heart & vessels", "cardiovascular"], ["Urinary system", "urinary"], ["Diaphragm & supports", "connective"], ["Skeletal landmarks", "skeleton"]]) {
    const checkbox = page.getByRole("checkbox", { name: label, exact: true });
    const original = await checkbox.isChecked();
    await checkbox.setChecked(!original);
    await expect.poll(async () => (await snapshot(page)).organs.filter(organ => organ.category === category).every(organ => organ.visible === !original)).toBe(true);
    await checkbox.setChecked(original);
    await expect.poll(async () => (await snapshot(page)).organs.filter(organ => organ.category === category).every(organ => organ.visible === original)).toBe(true);
  }
  const startCamera = JSON.stringify((await snapshot(page)).camera.position);
  await page.getByRole("button", { name: "Camera tour", exact: true }).click();
  await expect.poll(async () => JSON.stringify((await snapshot(page)).camera.position)).not.toBe(startCamera);
  await page.getByRole("button", { name: "Camera tour", exact: true }).click();
  await page.getByRole("button", { name: "Front", exact: true }).click();

  const imageDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save image", exact: true }).click();
  const image = await imageDownload;
  expect(image.suggestedFilename()).toMatch(/\.png$/);
  const png = await downloadBytes(image);
  expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(png.readUInt32BE(16)).toBeGreaterThan(600);
  expect(png.readUInt32BE(20)).toBeGreaterThan(600);
  await image.saveAs(join(evidence, "export-scene.png"));

  const videoDownload = page.waitForEvent("download", { timeout: 45_000 });
  await page.getByRole("button", { name: "Record tour", exact: true }).click();
  const video = await videoDownload;
  expect(video.suggestedFilename()).toMatch(/\.webm$/);
  const webm = await downloadBytes(video);
  expect(webm.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(webm.length).toBeGreaterThan(10_000);
  await video.saveAs(join(evidence, "export-camera-tour.webm"));
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});

for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }]) {
  test(`scene controls and anatomy fit ${viewport.width}px without horizontal overflow`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { errors, failures } = await openScene(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (viewport.width < 760) {
      const scrollingScene = page.locator(".whole-scene-studio");
      expect(await scrollingScene.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
      const footerLayout = await page.evaluate(() => ({
        pageFooterTop: document.querySelector(".whole-footer")!.getBoundingClientRect().top,
        controlsFooterBottom: document.querySelector(".whole-panel-footer")!.getBoundingClientRect().bottom,
        panelClientHeight: document.querySelector(".whole-panel-scroll")!.clientHeight,
        panelScrollHeight: document.querySelector(".whole-panel-scroll")!.scrollHeight,
      }));
      expect(footerLayout.pageFooterTop).toBeGreaterThanOrEqual(footerLayout.controlsFooterBottom - 1);
      expect(footerLayout.panelScrollHeight).toBeLessThanOrEqual(footerLayout.panelClientHeight + 1);
      await page.locator(".whole-stage-actions").getByRole("button", { name: "Scene controls", exact: true }).click();
      await expect.poll(async () => scrollingScene.evaluate(element => element.scrollTop)).toBeGreaterThan(100);
      await page.mouse.move(viewport.width / 2, viewport.height * 0.65);
      const beforeWheel = await scrollingScene.evaluate(element => element.scrollTop);
      await page.mouse.wheel(0, 550);
      await expect.poll(async () => scrollingScene.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeWheel);
    }
    await expect(page.getByRole("button", { name: "Joint scene variation", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Joint scene variation", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).baseline).toBe(false);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).camera.view).toBe("back");
    await capture(page, `responsive-${viewport.width}.png`);
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });
}

test("explicit seed validation preserves the displayed scene and disease strength changes the replayed specimen", async ({ page }) => {
  const { errors, failures } = await openScene(page);
  const baseline = await snapshot(page);
  for (const invalid of ["-1", "3.4", "4294967296", "invalid", ""]) {
    await page.getByLabel("Scene seed", { exact: true }).fill(invalid);
    await page.getByRole("button", { name: "Replay seed", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("whole-number seed");
    expect(signatures(await snapshot(page))).toEqual(signatures(baseline));
  }
  await page.getByLabel("Scene seed", { exact: true }).fill("4294967295");
  await page.getByRole("slider", { name: "Disease appearance", exact: true }).fill("0");
  await page.getByRole("button", { name: "Replay seed", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).seed).toBe(4294967295);
  const neutral = await snapshot(page);
  expect(neutral.severity).toBe(0);
  await page.getByRole("slider", { name: "Disease appearance", exact: true }).fill("1");
  await page.getByRole("button", { name: "Replay seed", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).severity).toBe(1);
  const disease = await snapshot(page);
  for (const organ of disease.organs) {
    const before = neutral.organs.find(item => item.id === organ.id)!;
    expect(organ.geometrySignature, organ.id).not.toBe(before.geometrySignature);
    expect(organ.materialSignature, organ.id).not.toBe(before.materialSignature);
  }
  await capture(page, "disease-strength-maximum.png");
  await page.getByRole("button", { name: "Atlas references", exact: true }).click();
  const image = page.getByRole("img", { name: /Open anatomy illustration/ });
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth > 0)).toBe(true);
  await capture(page, "reference-desk.png");
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});

interface PhysicsSnapshot {
  model_id: string;
  running: boolean;
  time_s: number;
  displacement_mm: number;
  peak_displacement_mm: number;
  displacement_gradient_bound: number;
  stabilization_count: number;
  finite: boolean;
  organs: { id: string; parameters: { accepted_for_application: boolean; observation_origin: string; young_pa: number }; displacement_mm: number[] }[];
  renderedSamples: { id: string; positions: number[][]; maxSampleDisplacementMm: number }[];
}
const physics = async (page: Page) => (await snapshot(page)).physics as PhysicsSnapshot | null;

test("learned material assignments drive displayed soft-tissue displacement, pause, palpation recovery, reset and recorded motion", async ({ page }) => {
  const { errors, failures } = await openScene(page);
  const atlas = await snapshot(page);
  await page.getByRole("button", { name: "Apply learned physics to all organs", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pause physics", exact: true })).toBeVisible();
  await expect.poll(async () => (await physics(page))?.running).toBe(true);
  const applied = (await physics(page))!;
  expect(applied.model_id).toMatch(/^[a-f0-9]{64}$/);
  expect(applied.organs.map(organ => organ.id).sort()).toEqual(atlas.organs.filter(organ => organ.category !== "skeleton").map(organ => organ.id).sort());
  for (const organ of applied.organs) {
    expect(organ.parameters.accepted_for_application).toBe(true);
    expect(organ.parameters.observation_origin).toBe("synthetic-design-history");
    expect(organ.parameters.young_pa).toBeGreaterThanOrEqual(500);
    expect(organ.parameters.young_pa).toBeLessThanOrEqual(20_000);
  }
  await expect.poll(async () => (await physics(page))!.displacement_mm, { timeout: 30_000 }).toBeGreaterThan(0.15);
  await expect.poll(async () => Math.max(...(await physics(page))!.renderedSamples.map(organ => organ.maxSampleDisplacementMm))).toBeGreaterThan(0.1);
  expect(signatures(await snapshot(page))).toEqual(signatures(atlas));
  await capture(page, "physics-respiratory-loading.png");
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect.poll(async () => (await physics(page))!.running).toBe(false);
  const paused = (await physics(page))!;
  const frame = Number((await snapshot(page)).animationFrames);
  await expect.poll(async () => Number((await snapshot(page)).animationFrames)).toBeGreaterThan(frame + 2);
  expect((await physics(page))!.time_s).toBe(paused.time_s);
  expect((await physics(page))!.renderedSamples).toEqual(paused.renderedSamples);
  await page.getByRole("checkbox", { name: /Breathing/ }).uncheck();
  await page.getByRole("button", { name: "Reset motion", exact: true }).click();
  await expect.poll(async () => (await physics(page))!.displacement_mm).toBe(0);
  await expect.poll(async () => Math.max(...(await physics(page))!.renderedSamples.map(organ => organ.maxSampleDisplacementMm))).toBe(0);
  await page.getByText("Explore the structures", { exact: false }).click();
  await page.getByRole("button", { name: "Liver", exact: true }).click();
  await page.getByRole("button", { name: "Resume physics", exact: true }).click();
  await beginFixedCameraRecording(page, 8000);
  const fixedStart = { wallTimeMs: Date.now(), scene: await snapshot(page) };
  await expect.poll(async () => (await physics(page))!.time_s).toBeGreaterThan(0.7);
  await capture(page, "physics-palpation-rest.png");
  await page.getByRole("button", { name: "Palpate selected organ", exact: true }).click();
  await expect.poll(async () => (await physics(page))!.peak_displacement_mm).toBeGreaterThan(0.1);
  const loaded = (await physics(page))!;
  await capture(page, "physics-palpation-loaded.png");
  await expect.poll(async () => (await physics(page))!.displacement_mm, { timeout: 30_000 }).toBeLessThan(0.025);
  const recovered = (await physics(page))!;
  expect(recovered.finite).toBe(true);
  expect(recovered.displacement_gradient_bound).toBeLessThan(0.25);
  expect(recovered.stabilization_count).toBe(0);
  expect(isFiniteTree(recovered)).toBe(true);
  await capture(page, "physics-palpation-recovered.png");
  await saveFixedCameraRecording(page, "physics-fixed-camera-palpation.webm");
  const fixedEnd = { wallTimeMs: Date.now(), scene: await snapshot(page) };
  const elapsedWall = (fixedEnd.wallTimeMs - fixedStart.wallTimeMs) / 1000;
  const elapsedSimulation = (fixedEnd.scene.physics as PhysicsSnapshot).time_s - (fixedStart.scene.physics as PhysicsSnapshot).time_s;
  await writeFile(join(evidence, "physics-timing.json"), JSON.stringify({ wall_time_s: elapsedWall, simulation_time_s: elapsedSimulation, simulation_to_wall_ratio: elapsedSimulation / elapsedWall, rendered_frames: Number(fixedEnd.scene.renderedFrames) - Number(fixedStart.scene.renderedFrames), rendered_fps: (Number(fixedEnd.scene.renderedFrames) - Number(fixedStart.scene.renderedFrames)) / elapsedWall, scope: "One local headless Chrome run; capture and screenshots included. Fixed-camera canvas video is independently recorded test evidence, not the UI tour export." }, null, 2));
  await page.getByRole("checkbox", { name: /Breathing/ }).check();
  const warmupTime = (await physics(page))!.time_s;
  await expect.poll(async () => (await physics(page))!.time_s).toBeGreaterThan(warmupTime + 1);
  const cleanStart = await snapshot(page);
  await expect.poll(async () => Number((await snapshot(page)).wall_time_ms), { timeout: 15_000 }).toBeGreaterThan(Number(cleanStart.wall_time_ms) + 5000);
  const cleanEnd = await snapshot(page);
  const cleanWall = (Number(cleanEnd.wall_time_ms) - Number(cleanStart.wall_time_ms)) / 1000;
  const cleanSim = (cleanEnd.physics as PhysicsSnapshot).time_s - (cleanStart.physics as PhysicsSnapshot).time_s;
  await writeFile(join(evidence, "physics-clean-timing.json"), JSON.stringify({ wall_time_s: cleanWall, simulation_time_s: cleanSim, simulation_to_wall_ratio: cleanSim / cleanWall, rendered_frames: Number(cleanEnd.renderedFrames) - Number(cleanStart.renderedFrames), rendered_fps: (Number(cleanEnd.renderedFrames) - Number(cleanStart.renderedFrames)) / cleanWall, dropped_time_delta_s: Number((cleanEnd.physics as unknown as Record<string, number>).dropped_time_s) - Number((cleanStart.physics as unknown as Record<string, number>).dropped_time_s), rendering: cleanEnd.rendering, scope: "One local headless Chrome run after warm-up; same diagnostic snapshot timestamps; no screenshot or video capture in this observation interval." }, null, 2));
  await page.getByRole("button", { name: "¾ view", exact: true }).click();
  const pending = page.waitForEvent("download", { timeout: 45_000 });
  await page.getByRole("button", { name: "Record tour", exact: true }).click();
  const video = await pending;
  const bytes = await downloadBytes(video);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(bytes.length).toBeGreaterThan(10_000);
  await video.saveAs(join(evidence, "export-physics-camera-tour.webm"));
  await writeFile(join(evidence, "physics-render-metadata.json"), JSON.stringify({ applied, paused, palpationLoaded: loaded, palpationRecovered: recovered, afterVideo: await physics(page) }, null, 2));
  await page.getByRole("button", { name: "Remove physics", exact: true }).click();
  await expect.poll(async () => await physics(page)).toBeNull();
  expect(signatures(await snapshot(page))).toEqual(signatures(atlas));
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});

test("the existing organ workspace opens the whole scene and supports a clean round trip", async ({ page }) => {
  // Only the unrelated single-organ API is a small navigation fixture. The
  // whole-body GLB, materials, physics and viewport remain real local assets.
  await page.route("**/api/atlas/catalog", route => route.fulfill({ json: {
    organs: [{ id: "liver", label: "Liver", templates: [{ id: "navigation-liver", label: "Navigation fixture", source: "Browser navigation fixture", license: "Test fixture" }] }],
    controls: [{ key: "bend", label: "Bend", min: -1, max: 1, default: 0 }],
  } }));
  await page.route("**/api/atlas/models", route => route.fulfill({ json: { source: "defaults", lanes: {} } }));
  await page.route("**/api/atlas/models/joint/history", route => route.fulfill({ json: { versions: [], selected_generation: null, active_bundle: null, selection_error: null } }));
  await page.route("**/api/atlas/generate", route => route.fulfill({ json: {
    spec: route.request().postDataJSON(), summary: {},
    scene: { organs: [{ id: "liver", name: "Navigation fixture", kind: "organ", color: "#913831", positions: [0, 70, 0, -60, -45, 45, 60, -45, 45, 0, -45, -70], indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2] }], metadata: { geometry_sha256: "navigation-fixture" } },
  } }));
  const { errors, failures } = await openScene(page);
  const baseline = signatures(await snapshot(page));
  await page.getByRole("button", { name: "Organ studio", exact: true }).click();
  await expect(page).toHaveURL(/mode=atlas/);
  await expect(page.getByText("Reference geometry loaded", { exact: true })).toBeVisible();
  await expect(page.locator(".atlas-export")).toBeEnabled();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole("button", { name: "Whole scene", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await capture(page, "navigation-organ-studio-mobile.png");
  await page.getByRole("button", { name: "Whole scene", exact: true }).click();
  await expect(page).toHaveURL(/mode=scene/);
  await expect(host(page).locator("canvas")).toBeVisible();
  expect(signatures(await snapshot(page))).toEqual(baseline);
  await page.getByRole("button", { name: "Joint scene variation", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).baseline).toBe(false);
  expect(failures).toEqual([]);
  expect(errors).toEqual([]);
});
