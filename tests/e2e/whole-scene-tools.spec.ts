import { expect, test, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { PerspectiveCamera, Vector3 } from "three";

const iteration = process.env.VISCERA_TOOLS_ITERATION ?? "current";
const evidence = fileURLToPath(new URL(`../../benchmarks/results/whole-scene-tools-2026-10-08/${iteration}/`, import.meta.url));
const host = (page: Page) => page.locator("[data-scene-ready='true'][data-scene-snapshot]");
const canvas = (page: Page) => host(page).locator("canvas");
const snapshot = async (page: Page) => JSON.parse(await host(page).getAttribute("data-scene-snapshot") ?? "{}");
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((value, axis) => value - b[axis]));
const signatures = (state: any) => Object.fromEntries(state.organs.map((organ: any) => [organ.id, [organ.geometrySignature, organ.materialSignature]]));
const finite = (value: unknown): boolean => typeof value === "number" ? Number.isFinite(value) : Array.isArray(value) ? value.every(finite) : value !== null && typeof value === "object" ? Object.values(value).every(finite) : true;
const browserErrors = new WeakMap<Page, string[]>();

test.afterEach(async ({ page }, info) => {
  const name = info.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 100);
  await save(`${name}-console`, browserErrors.get(page) ?? []);
  if (info.status !== info.expectedStatus && await host(page).count()) await save(`${name}-failure-state`, await snapshot(page));
});

async function save(name: string, value: unknown) {
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, `${name}.json`), JSON.stringify(value, null, 2));
}
async function capture(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: join(evidence, `${name}.png`) });
  await save(name, await snapshot(page));
}
async function open(page: Page) {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(`${message.text()} ${message.location().url}`); });
  // Capability discovery for the unrelated reference-image feature needs no
  // server in these anatomy tests. All scene assets, contact and physics are real.
  await page.route("**/api/atlas/reference-material/status", route => route.fulfill({ json: { sam2: { configured: false }, default_segmentation: "local" } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?mode=scene");
  await expect(canvas(page)).toBeVisible();
  const manifest = await (await page.request.get("/anatomy-scene/manifest.json")).json();
  await expect.poll(async () => (await snapshot(page)).organs.length).toBe(manifest.organs.length);
  await save(`browser-environment-${page.viewportSize()?.width}`, { browser: page.context().browser()?.version(), viewport: page.viewportSize(), userAgent: await page.evaluate(() => navigator.userAgent), baseURL: page.url(), platform: process.platform, architecture: process.arch });
  return errors;
}
async function applyPhysics(page: Page) {
  await page.getByRole("button", { name: "Apply learned physics to all organs", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics?.running).toBe(true);
  await page.getByRole("checkbox", { name: /Breathing/ }).uncheck();
  await page.getByRole("button", { name: "Reset motion", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).physics.displacement_mm).toBe(0);
}
async function focusOrgan(page: Page, label = "Liver") {
  const details = page.locator(".whole-organ-details");
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator("summary").click();
  await page.getByRole("button", { name: `Focus ${label}`, exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).rendering.cameraTransition).toBe(false);
  await canvas(page).scrollIntoViewIfNeeded();
}
const tool = async (page: Page) => (await snapshot(page)).tools;
async function advance(page: Page, seconds = .3) {
  const before = (await snapshot(page)).physics.time_s;
  await expect.poll(async () => (await snapshot(page)).physics.time_s).toBeGreaterThan(before + seconds);
}
async function choose(page: Page, mode: "Push" | "Grasp" | "Camera") {
  await page.getByRole("button", { name: mode, exact: true }).click();
  await expect.poll(async () => (await tool(page)).mode).toBe(mode === "Camera" ? "orbit" : mode.toLowerCase());
}
async function surfacePoint(page: Page, organId: string, index = 0) {
  await canvas(page).scrollIntoViewIfNeeded();
  await expect.poll(async () => (await tool(page)).pickCandidates?.filter((candidate: any) => candidate.organId === organId).length ?? 0).toBeGreaterThan(index);
  const candidates = (await tool(page)).pickCandidates.filter((candidate: any) => candidate.organId === organId);
  const box = (await canvas(page).boundingBox())!;
  for (const candidate of [...candidates.slice(index), ...candidates.slice(0, index)]) {
    const x = box.x + candidate.canvasX, y = box.y + candidate.canvasY;
    const unobstructed = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === "CANVAS", { x, y });
    if (unobstructed) return { x, y, candidate };
  }
  throw new Error(`No uncovered canvas pick witness for ${organId}`);
}
async function engage(page: Page, organId = "liver", index = 0) {
  const point = await surfacePoint(page, organId, index);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect.poll(async () => (await tool(page)).engaged).toBe(true);
  expect((await tool(page)).organId).toBe(organId);
  return point;
}
async function release(page: Page, recording = false) {
  await page.mouse.up();
  await expect.poll(async () => (await tool(page)).engaged).toBe(false);
  const state = await snapshot(page);
  expect(state.tools.pointerCaptured).toBe(false);
  expect(state.tools.cameraLocked).toBe(recording);
  expect(state.tools.instrumentVisible).toBe(false);
  if (state.physics?.tool) {
    expect(state.physics.tool.active).toBe(false);
    expect(Math.hypot(...state.physics.tool.forceN)).toBeLessThan(1e-8);
  }
}
function contactCheck(state: any, mode: "push" | "grasp", organId: string) {
  const t = state.tools;
  expect(t.engaged).toBe(true);
  expect(t.instrumentVisible).toBe(true);
  expect(t.mode).toBe(mode);
  expect(t.organId).toBe(organId);
  expect(t.faceIndex).toBeGreaterThanOrEqual(0);
  expect(t.vertexIndices).toHaveLength(3);
  expect(t.barycentric).toHaveLength(3);
  expect(t.barycentric.every((weight: number) => weight >= -1e-6 && weight <= 1 + 1e-6)).toBe(true);
  expect(t.barycentric.reduce((sum: number, weight: number) => sum + weight, 0)).toBeCloseTo(1, 6);
  expect(t.surfaceTriangleMm).toHaveLength(3);
  const baryPoint = [0, 1, 2].map(axis => t.surfaceTriangleMm.reduce((sum: number, vertex: number[], corner: number) => sum + vertex[axis] * t.barycentric[corner], 0));
  expect(distance(baryPoint, t.surfacePointMm), "Anchor must lie on the actual uploaded triangle").toBeLessThan(1e-4);
  expect(Math.hypot(...t.normal)).toBeCloseTo(1, 5);
  expect(Math.hypot(...t.axis)).toBeCloseTo(1, 5);
  expect(t.cameraLocked).toBe(true);
  expect(state.physics.finite).toBe(true);
  expect(state.physics.displacement_gradient_bound).toBeLessThanOrEqual(.4501);
  expect(finite(t)).toBe(true);
  expect(Math.hypot(...t.solver.forceN)).toBeLessThanOrEqual(t.solver.forceLimitN + 1e-6);
  if (mode === "grasp") {
    expect(t.jawClosure).toBeGreaterThan(.9);
    expect(distance(t.visualTipMm, t.surfacePointMm), "Closed jaw nominal contact must follow displayed tissue").toBeLessThan(1e-4);
  } else {
    const dot = t.solver.forceN.reduce((sum: number, force: number, axis: number) => sum + force * t.solver.normal[axis], 0);
    const tangential = t.solver.forceN.map((force: number, axis: number) => force - dot * t.solver.normal[axis]);
    expect(dot, "Push must never apply tensile normal force").toBeLessThanOrEqual(1e-6);
    expect(Math.hypot(...tangential), "Push force is normal-only").toBeLessThan(1e-5);
  }
}
function shapeChange(a: number[][], b: number[][]) {
  const changes = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < i; j++) changes.push(distance(a[i], a[j]) - distance(b[i], b[j]));
  return Math.hypot(...changes) / Math.sqrt(Math.max(1, changes.length));
}
async function startRecording(page: Page) {
  await page.getByRole("button", { name: "Record interaction", exact: true }).click();
  await expect(page.getByText("Recording instrument interaction", { exact: true })).toBeVisible();
  await expect.poll(async () => (await snapshot(page)).motion.recordingKind).toBe("interaction");
  return snapshot(page);
}
async function stopRecording(page: Page, name: string) {
  const pending = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Stop recording", exact: true }).click();
  const download = await pending;
  await mkdir(evidence, { recursive: true });
  const path = join(evidence, `${name}.webm`);
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
  expect(bytes.length).toBeGreaterThan(10_000);
}
async function isolate(page: Page, id: string) {
  await choose(page, "Camera");
  const details = page.locator(".whole-organ-details");
  if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator("summary").click();
  const state = await snapshot(page);
  for (const organ of state.organs) {
    const hide = page.getByRole("button", { name: `Hide ${organ.label}`, exact: true });
    if (organ.id !== id && await hide.count()) await hide.click();
  }
  const selected = state.organs.find((organ: any) => organ.id === id);
  await focusOrgan(page, selected.label);
  await expect.poll(async () => (await snapshot(page)).organs.filter((organ: any) => organ.visible).map((organ: any) => organ.id)).toEqual([id]);
}
async function keyboardEngage(page: Page) {
  await page.getByRole("button", { name: "Engage at view centre", exact: true }).click();
  await expect.poll(async () => (await tool(page)).engaged).toBe(true);
}
async function freshPointerAttempt(page: Page, x: number, y: number) {
  await page.mouse.move(x, y); await page.mouse.down();
  const eventTime = await page.evaluate(() => performance.now());
  await expect.poll(async () => (await snapshot(page)).wall_time_ms).toBeGreaterThan(eventTime);
  return snapshot(page);
}
async function projectPoint(page: Page, state: any, point: number[]) {
  const camera = new PerspectiveCamera(state.camera.fov, state.camera.aspect, .1, 10000);
  camera.position.fromArray(state.camera.position); camera.up.fromArray(state.camera.up);
  camera.lookAt(new Vector3().fromArray(state.camera.target)); camera.updateMatrixWorld();
  const projected = new Vector3().fromArray(point).project(camera), box = (await canvas(page).boundingBox())!;
  return { x: box.x + (projected.x + 1) * box.width / 2, y: box.y + (1 - projected.y) * box.height / 2 };
}
// Read actual baseline GLB triangles only to propose additional screen locations.
// A normal browser pointer-down must still pass the current deformed ray pick and
// finite-tool guard. This helper never creates a contact or modifies application state.
async function atlasFaceCandidates(page: Page, id: string) {
  const bytes = await (await page.request.get("/anatomy-scene/bodyparts3d-torso.glb")).body();
  const jsonLength = bytes.readUInt32LE(12), gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString());
  const binaryStart = 28 + jsonLength;
  const node = gltf.nodes.find((entry: any) => entry.name === id);
  expect(node.matrix ?? node.translation ?? node.rotation ?? node.scale, "Atlas candidate coordinates require the documented identity node transform").toBeUndefined();
  const mesh = gltf.meshes[node.mesh].primitives[0];
  const position = gltf.accessors[mesh.attributes.POSITION], indices = gltf.accessors[mesh.indices];
  const pv = gltf.bufferViews[position.bufferView], iv = gltf.bufferViews[indices.bufferView];
  expect(position.componentType).toBe(5126);
  const positionsOffset = binaryStart + (pv.byteOffset ?? 0) + (position.byteOffset ?? 0), indicesOffset = binaryStart + (iv.byteOffset ?? 0) + (indices.byteOffset ?? 0);
  const indexAt = (i: number) => indices.componentType === 5125 ? bytes.readUInt32LE(indicesOffset + i * 4) : bytes.readUInt16LE(indicesOffset + i * 2);
  const vertexAt = (i: number) => [0, 1, 2].map(axis => bytes.readFloatLE(positionsOffset + i * (pv.byteStride ?? 12) + axis * 4));
  const state = await snapshot(page), camera = new PerspectiveCamera(state.camera.fov, state.camera.aspect, .1, 10000);
  camera.position.fromArray(state.camera.position); camera.up.fromArray(state.camera.up); camera.lookAt(new Vector3().fromArray(state.camera.target)); camera.updateMatrixWorld();
  const box = (await canvas(page).boundingBox())!, result: any[] = [];
  for (let face = 0; face < indices.count / 3; face += Math.max(1, Math.floor(indices.count / 3 / 140))) {
    const vertices = [0, 1, 2].map(corner => vertexAt(indexAt(face * 3 + corner)));
    const point = [0, 1, 2].map(axis => vertices.reduce((sum, vertex) => sum + vertex[axis] / 3, 0));
    const projected = new Vector3().fromArray(point).project(camera);
    const x = box.x + (projected.x + 1) * box.width / 2, y = box.y + (1 - projected.y) * box.height / 2;
    if (Math.abs(projected.x) > .95 || Math.abs(projected.y) > .95 || result.some(p => Math.hypot(p.x - x, p.y - y) < 13)) continue;
    if (await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName === "CANVAS", { x, y })) result.push({ x, y, sourceFaceIndex: face, sourceCentroidMm: point });
  }
  return result;
}

test("instruments require applied running physics and expose a reversible camera mode", async ({ page }) => {
  const errors = await open(page);
  const baseline = await snapshot(page);
  await expect(page.getByText("Apply learned physics above to enable the instruments.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Grasp", exact: true })).toHaveCount(0);
  await applyPhysics(page);
  for (const label of ["Camera", "Push", "Grasp"]) await expect(page.getByRole("button", { name: label, exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Pause physics", exact: true }).click();
  await expect(page.getByRole("button", { name: "Push", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Grasp", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Camera", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Resume physics", exact: true }).click();
  await page.getByRole("button", { name: "Grasp", exact: true }).click();
  await expect(page.getByRole("button", { name: "Grasp", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Camera", exact: true }).click();
  await expect(page.getByRole("button", { name: "Camera", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(signatures(await snapshot(page))).toEqual(signatures(baseline));
  await capture(page, "instrument-toolbar");
  await page.getByRole("button", { name: "Remove physics", exact: true }).click();
  await expect(page.getByRole("button", { name: "Grasp", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("continuous push advances and deforms tissue while the mouse stays held and stationary, then releases", async ({ page }) => {
  const errors = await open(page);
  await applyPhysics(page);
  await page.locator(".whole-organ-details summary").click();
  await page.getByRole("button", { name: "Liver", exact: true }).click();
  await choose(page, "Push");
  const continuous = page.getByRole("checkbox", { name: "Continuous push", exact: true });
  await expect(continuous).not.toBeChecked();
  await continuous.check();
  await page.getByRole("slider", { name: "Push speed", exact: true }).fill("3");
  await engage(page);
  const initial = await snapshot(page);
  // No mouse.move or wheel events: holding the button alone must keep loading.
  await advance(page, .75);
  const middle = await snapshot(page);
  await advance(page, .75);
  const loaded = await snapshot(page);
  expect(loaded.tools.holdingPush).toBe(true);
  expect(middle.tools.depthMm).toBeGreaterThan(initial.tools.depthMm + 1);
  expect(loaded.tools.depthMm).toBeGreaterThan(middle.tools.depthMm + 1);
  expect(loaded.tools.depthMm).toBeLessThanOrEqual(20);
  expect(distance(loaded.tools.surfacePointMm, initial.tools.surfacePointMm)).toBeGreaterThan(.5);
  expect(loaded.tools.solver.normalForceN).toBeGreaterThan(.01);
  expect(loaded.camera.position).toEqual(initial.camera.position);
  contactCheck(loaded, "push", "liver");
  await capture(page, "continuous-push-held");
  await release(page);
  await advance(page, .75);
  const released = await snapshot(page);
  expect(released.tools.holdingPush).toBe(false);
  expect(released.tools.latched).toBe(false);
  expect(released.tools.solver.active).toBe(false);
  expect(Math.hypot(...released.tools.solver.forceN)).toBe(0);
  await capture(page, "continuous-push-released");
  await save("continuous-push", { initial, middle, loaded, released });
  expect(errors).toEqual([]);
});

test("a mouse click attaches whole-body tools persistently, moves tissue, and a second click releases", async ({ page }) => {
  const errors = await open(page);
  await applyPhysics(page);
  await page.getByRole("checkbox", { name: /Breathing/ }).check();
  await page.locator(".whole-organ-details summary").click();
  await page.getByRole("button", { name: "Liver", exact: true }).click();
  for (const mode of ["Grasp", "Push"] as const) {
    await choose(page, mode);
    const p = await surfacePoint(page, "liver");
    await page.mouse.click(p.x, p.y);
    await expect.poll(async () => (await tool(page)).latched).toBe(true);
    const initial = await snapshot(page);
    await page.mouse.move(p.x + 35, p.y - 20, { steps: 8 });
    await advance(page, .4);
    const moved = await snapshot(page);
    expect(moved.tools.engaged).toBe(true);
    expect(moved.tools.organId).toBe("liver");
    expect(distance(moved.tools.targetMm, initial.tools.targetMm)).toBeGreaterThan(.3);
    expect(distance(moved.tools.surfacePointMm, initial.tools.surfacePointMm)).toBeGreaterThan(.1);
    expect(moved.tools.solver.normalForceN + Math.hypot(...moved.tools.solver.forceN)).toBeGreaterThan(.001);
    expect(moved.camera.position).toEqual(initial.camera.position);
    expect(moved.physics.finite).toBe(true);
    await capture(page, `click-attached-${mode.toLowerCase()}`);
    await page.mouse.click(p.x + 35, p.y - 20);
    await expect.poll(async () => (await tool(page)).engaged).toBe(false);
    expect((await tool(page)).solver.active).toBe(false);
    await page.getByRole("button", { name: "Reset motion", exact: true }).click();
  }
  expect(errors).toEqual([]);
});

test("a real surface grasp locks the camera, deforms tissue laterally and in depth, then releases and recovers", async ({ page }) => {
  const errors = await open(page);
  await applyPhysics(page);
  await focusOrgan(page);
  await choose(page, "Grasp");
  await expect.poll(async () => (await tool(page)).ready).toBe(true);
  const baseline = await snapshot(page);
  const recordingStart = await startRecording(page);
  const p = await engage(page);
  const anchor = await snapshot(page);
  await page.mouse.move(p.x + 70, p.y - 45, { steps: 16 });
  await advance(page, .6);
  const lateral = await snapshot(page);
  contactCheck(lateral, "grasp", "liver");
  expect(lateral.camera.position).toEqual(baseline.camera.position);
  expect(lateral.camera.target).toEqual(baseline.camera.target);
  expect(lateral.tools.faceIndex).toBe(anchor.tools.faceIndex);
  expect(lateral.tools.barycentric).toEqual(anchor.tools.barycentric);
  expect(distance(lateral.tools.surfacePointMm, anchor.tools.surfacePointMm)).toBeGreaterThan(.3);
  const beforeDepth = lateral.tools.targetMm;
  await page.mouse.wheel(0, -120);
  await advance(page, .4);
  const depth = await snapshot(page);
  contactCheck(depth, "grasp", "liver");
  expect(distance(depth.tools.targetMm, beforeDepth)).toBeGreaterThan(.1);
  expect(depth.camera.position).toEqual(baseline.camera.position);
  const beforeVertices = baseline.physics.renderedSamples.find((organ: any) => organ.id === "liver").positions;
  const loadedVertices = depth.physics.renderedSamples.find((organ: any) => organ.id === "liver").positions;
  const nonrigid = shapeChange(beforeVertices, loadedVertices);
  expect(nonrigid, "Pairwise vertex distances change, not just whole-organ translation").toBeGreaterThan(1e-4);
  expect(signatures(depth)).toEqual(signatures(baseline));
  await capture(page, "grasp-loaded");
  await release(page, true);
  await expect.poll(async () => (await snapshot(page)).physics.displacement_mm, { timeout: 30_000 }).toBeLessThan(.1);
  const recovered = await snapshot(page);
  await capture(page, "grasp-recovered");
  await stopRecording(page, "grasp-interaction");
  await expect.poll(async () => (await tool(page)).cameraLocked).toBe(false);
  await save("grasp-metrics", { baseline, recordingStart, anchor, lateral, depth, recovered, pairDistanceChangeRmsMm: nonrigid });
  expect(errors).toEqual([]);
});

test("the blunt probe applies compressive force and retracts without pulling tissue", async ({ page }) => {
  const errors = await open(page);
  await applyPhysics(page);
  await focusOrgan(page);
  await choose(page, "Push");
  await page.getByRole("slider", { name: "Probe tip radius", exact: true }).fill("6");
  await page.getByRole("slider", { name: "Initial push depth", exact: true }).fill("3");
  const baseline = await snapshot(page);
  const recordingStart = await startRecording(page);
  await engage(page);
  await advance(page, .6);
  const loaded = await snapshot(page);
  contactCheck(loaded, "push", "liver");
  expect(loaded.tools.solver.normalForceN).toBeGreaterThan(.001);
  expect(loaded.tools.penetrationMm).toBeLessThanOrEqual(.05);
  expect(loaded.tools.visualTipAnchorGapMm, "Conservative correction stays small for this exposed liver patch").toBeLessThan(.25);
  const actualSphereCenter = loaded.tools.poseOriginMm.map((v: number, axis: number) => v + loaded.tools.axis[axis] * 6);
  expect(distance(actualSphereCenter, loaded.tools.tipCenterMm)).toBeLessThan(1e-4);
  expect(loaded.camera.position).toEqual(baseline.camera.position);
  expect(loaded.physics.displacement_mm).toBeGreaterThan(.1);
  await capture(page, "probe-loaded");
  await canvas(page).focus();
  for (let i = 0; i < 12; i++) await page.keyboard.press("PageUp");
  await advance(page, .5);
  const retracted = await snapshot(page);
  if (retracted.tools.engaged) {
    contactCheck(retracted, "push", "liver");
    expect(retracted.tools.solver.normalForceN).toBeLessThan(.005);
    expect(retracted.tools.geometricClearanceMm, "Withdrawn visible sphere must separate from tissue").toBeGreaterThan(1);
  }
  await capture(page, "probe-withdrawn");
  await release(page, true);
  await expect.poll(async () => (await snapshot(page)).physics.displacement_mm, { timeout: 30_000 }).toBeLessThan(.1);
  const recovered = await snapshot(page);
  await stopRecording(page, "probe-interaction");
  await expect.poll(async () => (await tool(page)).cameraLocked).toBe(false);
  await save("probe-metrics", { baseline, recordingStart, loaded, retracted, recovered });
  expect(errors).toEqual([]);
});

test("keyboard movement and every scene interruption release attachments without leaving a camera lock", async ({ page }) => {
  const errors = await open(page);
  await applyPhysics(page);
  await focusOrgan(page);
  await choose(page, "Grasp");
  await canvas(page).focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await tool(page)).engaged).toBe(true);
  const initial = await snapshot(page);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("PageDown");
  await advance(page);
  const moved = await snapshot(page);
  contactCheck(moved, "grasp", "liver");
  expect(distance(moved.tools.targetMm, initial.tools.targetMm)).toBeGreaterThan(1);
  expect(moved.camera.position).toEqual(initial.camera.position);
  const transferPoint = await projectPoint(page, moved, moved.tools.surfacePointMm);
  const transferred = await freshPointerAttempt(page, transferPoint.x, transferPoint.y);
  contactCheck(transferred, "grasp", "liver");
  expect(transferred.tools.pointerCaptured).toBe(true);
  expect(transferred.tools.faceIndex).toBe(moved.tools.faceIndex);
  expect(transferred.tools.barycentric).toEqual(moved.tools.barycentric);
  expect(distance(transferred.tools.targetMm, moved.tools.targetMm), "Taking over a keyboard attachment must not jump its target").toBeLessThan(1e-5);
  await page.mouse.move(transferPoint.x + 24, transferPoint.y - 10, { steps: 5 }); await advance(page, .3);
  const pointerMoved = await snapshot(page); contactCheck(pointerMoved, "grasp", "liver");
  expect(distance(pointerMoved.tools.targetMm, transferred.tools.targetMm)).toBeGreaterThan(.1);
  expect(pointerMoved.camera.position).toEqual(moved.camera.position);
  await release(page); await keyboardEngage(page);
  await page.getByRole("checkbox", { name: /Breathing/ }).check(); await advance(page, .4);
  const breathingContact = await snapshot(page); contactCheck(breathingContact, "grasp", "liver");
  expect(breathingContact.motion.breathing).toBe(true);
  await page.getByRole("checkbox", { name: /Breathing/ }).uncheck();
  await page.getByLabel("Scene seed", { exact: true }).focus();
  const inputBefore = (await tool(page)).targetMm;
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("PageUp");
  expect((await tool(page)).targetMm).toEqual(inputBefore);
  await canvas(page).focus();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await tool(page)).engaged).toBe(false);
  expect((await tool(page)).cameraLocked).toBe(false);
  const evidenceRows: any[] = [{ operation: "keyboard-to-pointer transfer, breathing and Escape", initial, moved, transferred, pointerMoved, breathingContact, after: await snapshot(page) }];
  for (const action of ["Pause physics", "Reset motion", "Joint scene variation", "Hide Liver", "Hide digestive category", "Hide respiratory category", "Front", "Camera", "Remove physics"]) {
    await focusOrgan(page);
    await choose(page, "Grasp");
    await keyboardEngage(page);
    if (action === "Hide digestive category") await page.getByRole("checkbox", { name: "Digestive organs", exact: true }).uncheck();
    else if (action === "Hide respiratory category") await page.getByRole("checkbox", { name: "Lungs & airways", exact: true }).uncheck();
    else await page.getByRole("button", { name: action, exact: true }).click();
    await expect.poll(async () => (await tool(page)).engaged).toBe(false);
    await expect.poll(async () => (await tool(page)).cameraLocked).toBe(false);
    const after = await snapshot(page);
    if (after.physics?.tool) {
      expect(after.physics.tool.active).toBe(false);
      expect(Math.hypot(...after.physics.tool.forceN)).toBeLessThan(1e-8);
    }
    expect(after.tools.pointerCaptured).toBe(false);
    evidenceRows.push({ operation: action, after });
    if (action === "Pause physics") await page.getByRole("button", { name: "Resume physics", exact: true }).click();
  }
  await save("interruption-metrics", evidenceRows);
  expect(errors).toEqual([]);
});

test("every supported soft structure accepts a real visible surface grasp and shows displayed motion", async ({ page }) => {
  test.setTimeout(600_000);
  const errors = await open(page);
  await applyPhysics(page);
  const baseline = await snapshot(page);
  const targetIds = process.env.VISCERA_TOOLS_TARGETS?.split(",");
  const organs = baseline.organs.filter((organ: any) => organ.category !== "skeleton" && (!targetIds || targetIds.includes(organ.id)));
  const rows: any[] = [];
  for (const organ of organs) {
    await isolate(page, organ.id);
    await page.getByRole("button", { name: "Reset motion", exact: true }).click();
    await choose(page, "Grasp");
    let engaged = false;
    const attempts: any[] = [];
    for (const view of [null, "Back", "Left", "Right", "Top"]) {
      if (view) {
        await page.getByRole("button", { name: view, exact: true }).click();
        await focusOrgan(page, organ.label);
      }
      await expect.poll(async () => (await tool(page)).pickCandidates?.filter((candidate: any) => candidate.organId === organ.id).length ?? 0).toBeGreaterThan(0);
      const count = (await tool(page)).pickCandidates.filter((candidate: any) => candidate.organId === organ.id).length;
      for (let index = 0; index < count; index++) {
        const p = await surfacePoint(page, organ.id, index);
        await page.mouse.move(p.x, p.y); await page.mouse.down();
        const eventTime = await page.evaluate(() => performance.now());
        await expect.poll(async () => { const state = await snapshot(page); return state.wall_time_ms > eventTime && (state.tools.engaged || state.tools.guard.blocked); }).toBe(true);
        const state = await snapshot(page);
        attempts.push({ view, candidate: p.candidate, tools: state.tools });
        if (state.tools.engaged) { engaged = true; break; }
        await page.mouse.up();
      }
      if (engaged) break;
    }
    if (!engaged) for (const view of ["Front", "Back", "Left"]) {
      await page.getByRole("button", { name: view, exact: true }).click(); await focusOrgan(page, organ.label);
      for (const p of await atlasFaceCandidates(page, organ.id)) {
        const state = await freshPointerAttempt(page, p.x, p.y);
        attempts.push({ view, candidate: p, tools: state.tools });
        if (state.tools.engaged) { engaged = true; break; }
        await page.mouse.up();
      }
      if (engaged) break;
    }
    await save("soft-structure-matrix", { expectedStructures: organs.length, completed: rows, current: { id: organ.id, attempts } });
    expect(engaged, `${organ.label} must have at least one reachable exposed surface`).toBe(true);
    const initial = await snapshot(page);
    await page.keyboard.press("ArrowUp");
    await expect.poll(async () => distance((await tool(page)).surfacePointMm, initial.tools.surfacePointMm)).toBeGreaterThan(.005);
    await advance(page, .15);
    const loaded = await snapshot(page);
    contactCheck(loaded, "grasp", organ.id);
    expect(signatures(loaded)).toEqual(signatures(baseline));
    if (["gallbladder", "right-ureter", "mesentery", "cystic-duct", "stomach", "splenic-artery", "heart"].includes(organ.id)) await capture(page, `structure-${organ.id}`);
    await release(page);
    rows.push({ id: organ.id, label: organ.label, attempts, initial: initial.tools, loaded: loaded.tools, displayedDisplacementMm: distance(loaded.tools.surfacePointMm, initial.tools.surfacePointMm), physics: { finite: loaded.physics.finite, gradientBound: loaded.physics.displacement_gradient_bound } });
    await save("soft-structure-matrix", { expectedStructures: organs.length, completed: rows });
  }
  expect(rows.map(row => row.id).sort()).toEqual(organs.map((organ: any) => organ.id).sort());
  expect(errors).toEqual([]);
});

test("visible neighbours block a finite instrument approach and hiding the obstruction exposes the target", async ({ page }) => {
  test.setTimeout(180_000);
  const errors = await open(page);
  await applyPhysics(page);
  const attempts: any[] = [];
  let blocked: any = null;
  for (const label of ["Stomach", "Liver", "Large intestine", "Small intestine", "Right lung", "Left lung", "Heart", "Spleen"]) {
    await focusOrgan(page, label); await choose(page, "Grasp");
    const id = (await snapshot(page)).organs.find((organ: any) => organ.label === label).id;
    try { await expect.poll(async () => (await tool(page)).pickCandidates.filter((candidate: any) => candidate.organId === id).length, { timeout: 3000 }).toBeGreaterThan(0); }
    catch { attempts.push({ id, result: "No exposed surface witness in this full-context view" }); continue; }
    const candidates = (await tool(page)).pickCandidates.filter((candidate: any) => candidate.organId === id);
    for (let index = 0; index < candidates.length; index++) {
      const p = await surfacePoint(page, id, index), state = await freshPointerAttempt(page, p.x, p.y);
      attempts.push({ id, candidate: p.candidate, tools: state.tools });
      await page.mouse.up();
      if (state.tools.guard.blocked && state.tools.guard.organId !== id && !state.tools.engaged) { blocked = { id, label, p, state }; break; }
    }
    if (blocked) break;
  }
  await save("obstruction-search", attempts);
  expect(blocked, "A real full-context approach must demonstrate a neighbouring-structure guard").not.toBeNull();
  expect(blocked.state.tools.instrumentVisible).toBe(false);
  expect(blocked.state.tools.cameraLocked).toBe(false);
  expect(blocked.state.tools.guard.clearanceMm).toBeLessThan(.05);
  if (blocked.state.physics.tool) expect(Math.hypot(...blocked.state.physics.tool.forceN)).toBeLessThan(1e-8);
  await capture(page, "neighbour-obstruction");
  // Hide through the same user-facing controls; no physics or collision data is mocked.
  await isolate(page, blocked.id); await choose(page, "Grasp");
  const exposed = await freshPointerAttempt(page, blocked.p.x, blocked.p.y);
  await save("obstruction-uncovered", { before: blocked.state, after: exposed });
  expect(exposed.tools.engaged).toBe(true);
  expect(exposed.tools.organId).toBe(blocked.id);
  expect(exposed.organs.find((organ: any) => organ.id === blocked.state.tools.guard.organId).visible).toBe(false);
  await advance(page, .2); contactCheck(await snapshot(page), "grasp", blocked.id);
  await capture(page, "neighbour-hidden-contact");
  await release(page);
  await isolate(page, "rib-cage"); await choose(page, "Grasp");
  const boneBefore = await snapshot(page), bonePoints = (await atlasFaceCandidates(page, "rib-cage")).slice(0, 3), boneAttempts = [];
  expect(bonePoints.length).toBeGreaterThan(0);
  for (const p of bonePoints) {
    const state = await freshPointerAttempt(page, p.x, p.y); await page.mouse.up();
    expect(state.tools.engaged).toBe(false); expect(state.tools.instrumentVisible).toBe(false); expect(state.tools.cameraLocked).toBe(false);
    if (state.physics.tool) expect(Math.hypot(...state.physics.tool.forceN)).toBeLessThan(1e-8);
    boneAttempts.push({ point: p, tools: state.tools });
  }
  expect(signatures(await snapshot(page))).toEqual(signatures(boneBefore));
  await expect(page.getByRole("region", { name: "Instrument settings", exact: true }).getByText("Select an exposed soft-organ surface. The bone scaffold is fixed.", { exact: true })).toBeVisible();
  await save("fixed-bone-pointer", { boneBefore, attempts: boneAttempts, after: await snapshot(page) });
  expect(errors).toEqual([]);
});

test("multiple surface patches and a recovering deformed surface remain pickable while held-contact timing stays finite", async ({ page }) => {
  const errors = await open(page);
  await applyPhysics(page); await isolate(page, "liver");
  const baseline = await snapshot(page), patches: any[] = [];
  for (const view of ["Front", "Back"]) {
    await page.getByRole("button", { name: view, exact: true }).click(); await focusOrgan(page); await choose(page, "Grasp");
    for (let index = 0; index < 3; index++) {
      const p = await engage(page, "liver", index);
      await page.mouse.move(p.x + 15, p.y - 10, { steps: 4 }); await advance(page, .2);
      const state = await snapshot(page); contactCheck(state, "grasp", "liver");
      patches.push({ view, candidate: p.candidate, tools: state.tools }); await release(page);
    }
  }
  expect(new Set(patches.map(row => row.tools.faceIndex)).size).toBeGreaterThanOrEqual(4);
  await page.getByRole("button", { name: "Full torso", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).organs.filter((organ: any) => organ.category !== "skeleton").every((organ: any) => organ.visible)).toBe(true);
  await page.getByRole("button", { name: "Front", exact: true }).click(); await focusOrgan(page); await choose(page, "Grasp");
  await page.getByRole("button", { name: "Reset motion", exact: true }).click(); await advance(page, .5);
  const unloadedStart = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).wall_time_ms, { timeout: 15_000 }).toBeGreaterThan(unloadedStart.wall_time_ms + 5000);
  const unloadedEnd = await snapshot(page), unloadedWall = (unloadedEnd.wall_time_ms - unloadedStart.wall_time_ms) / 1000;
  const unloadedTiming = { wallSeconds: unloadedWall, renderedFps: (unloadedEnd.renderedFrames - unloadedStart.renderedFrames) / unloadedWall, simulationWallRatio: (unloadedEnd.physics.time_s - unloadedStart.physics.time_s) / unloadedWall };
  const point = await engage(page); await page.mouse.move(point.x + 55, point.y - 25, { steps: 8 }); await advance(page, .8);
  const warm = await snapshot(page);
  await expect.poll(async () => (await snapshot(page)).wall_time_ms, { timeout: 15_000 }).toBeGreaterThan(warm.wall_time_ms + 5000);
  const end = await snapshot(page);
  contactCheck(end, "grasp", "liver");
  const timing = { loadedStructures: end.organs.length, visibleStructures: end.organs.filter((organ: any) => organ.visible).length, wallSeconds: (end.wall_time_ms - warm.wall_time_ms) / 1000, simulationSeconds: end.physics.time_s - warm.physics.time_s, renderedFrames: end.renderedFrames - warm.renderedFrames };
  await release(page);
  const recovering = await snapshot(page), repickPoint = await projectPoint(page, recovering, recovering.tools.surfacePointMm);
  const repicked = await freshPointerAttempt(page, repickPoint.x, repickPoint.y);
  contactCheck(repicked, "grasp", "liver");
  const restPoint = [0, 1, 2].map(axis => repicked.tools.restTriangleMm.reduce((sum: number, vertex: number[], corner: number) => sum + vertex[axis] * repicked.tools.barycentric[corner], 0));
  const inheritedDisplacement = distance(restPoint, repicked.tools.surfacePointMm);
  expect(inheritedDisplacement, "The new ray hit uses recovering geometry, not the original atlas surface").toBeGreaterThan(.01);
  expect(signatures(repicked)).toEqual(signatures(baseline));
  await save("multiple-patches-and-timing", { patches, unloadedStart, unloadedEnd, unloadedTiming, warm, end, recovering, repicked, inheritedDisplacementMm: inheritedDisplacement, timing: { ...timing, renderedFps: timing.renderedFrames / timing.wallSeconds, simulationWallRatio: timing.simulationSeconds / timing.wallSeconds } });
  await capture(page, "recovering-surface-repick"); await release(page);
  expect(errors).toEqual([]);
});

test("camera-tour recording releases tools, orbits the view, downloads WebM and restores interaction", async ({ page }) => {
  const errors = await open(page); await applyPhysics(page); await focusOrgan(page); await choose(page, "Grasp");
  await keyboardEngage(page);
  const before = await snapshot(page), downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Record tour", exact: true }).click();
  await expect(page.getByText("Recording camera tour", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Grasp", exact: true })).toBeDisabled();
  await expect.poll(async () => (await tool(page)).engaged).toBe(false);
  await expect.poll(async () => distance((await snapshot(page)).camera.position, before.camera.position)).toBeGreaterThan(10);
  const orbiting = await snapshot(page);
  expect(orbiting.motion.recordingKind).toBe("tour");
  expect(orbiting.tools.instrumentVisible).toBe(false);
  const download = await downloadPromise; await mkdir(evidence, { recursive: true });
  const video = join(evidence, "camera-tour-regression.webm"); await download.saveAs(video);
  const bytes = await readFile(video); expect(bytes.subarray(0, 4).toString("hex")).toBe("1a45dfa3"); expect(bytes.length).toBeGreaterThan(10_000);
  await expect(page.getByRole("button", { name: "Grasp", exact: true })).toBeEnabled();
  await expect.poll(async () => (await snapshot(page)).motion.recording).toBe(false);
  await focusOrgan(page); await choose(page, "Grasp"); await engage(page); await advance(page, .2);
  contactCheck(await snapshot(page), "grasp", "liver"); await release(page);
  await save("tour-regression", { before, orbiting, after: await snapshot(page) });
  expect(errors).toEqual([]);
});

test.describe("mobile native touch instruments", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("touch drag and cancellation move the displayed tissue and release native capture", async ({ page }) => {
    const errors = await open(page);
    await applyPhysics(page);
    await focusOrgan(page);
    await choose(page, "Grasp");
    const p = await surfacePoint(page, "liver");
    const baseline = await snapshot(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: p.x, y: p.y }] });
    await expect.poll(async () => (await tool(page)).engaged).toBe(true);
    const initial = await snapshot(page);
    for (let i = 1; i <= 12; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: p.x + i * 1.5, y: p.y - i * 2 }] });
    await advance(page, .4);
    const loaded = await snapshot(page);
    contactCheck(loaded, "grasp", "liver");
    expect(distance(loaded.tools.surfacePointMm, initial.tools.surfacePointMm)).toBeGreaterThan(.1);
    expect(loaded.camera.position).toEqual(baseline.camera.position);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await capture(page, "mobile-touch-grasp");
    await cdp.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
    await expect.poll(async () => (await tool(page)).engaged).toBe(false);
    const cancelled = await snapshot(page);
    expect(cancelled.tools.pointerCaptured).toBe(false);
    expect(cancelled.tools.cameraLocked).toBe(false);
    expect(Math.hypot(...cancelled.physics.tool.forceN)).toBeLessThan(1e-8);
    await save("mobile-touch-metrics", { baseline, initial, loaded, cancelled });
    expect(errors).toEqual([]);
  });
});
