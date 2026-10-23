#!/usr/bin/env node
// Native GPU test: run serially, never alongside another graphics harness.
// Handle selection is reconstructed on the CPU from the public mesh export and
// the installed Three.js controls. No hidden browser scene or product test hook.
import { chromium, expect } from '@playwright/test';
import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { capturePublicBuildSources } from './stage_public_assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const url = process.env.SCISSORS_URL ?? process.env.CUTTING_URL ?? 'http://127.0.0.1:5174/';
const out = path.resolve(process.env.SCISSORS_GIZMO_OUT ?? path.join(root, 'artifacts/cutting-2026-10-20', `scissors-gizmo-${Date.now()}`));
await fs.mkdir(out, { recursive: true });
const staticCopy = process.env.SCISSORS_STATIC_COPY === '1' || process.env.CUTTING_STATIC_COPY === '1';
const config = staticCopy ? await fetch(new URL('api.json', url)).then(response => { if (!response.ok) throw new Error('Missing static API configuration'); return response.json(); }) : null;
if (config && config.api !== null) throw new Error('Offline health expectation requires explicit api:null');
const health = location => Boolean(config) && location === new URL('api/health', url).href;
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = async () => [...capturePublicBuildSources(root).filter(entry => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.path)),
  { path: 'apps/studio/public/cutting/liver-reference.json', sha256: hash(await fs.readFile(path.join(root, 'apps/studio/public/cutting/liver-reference.json'))) }];
const report = { status: 'FAIL', url, out, startedAt: new Date().toISOString(), checks: [], errors: [], failedRequests: [], expectedOfflineProbes: [], observations: [], sourceBefore: await sources() };
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? {
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle', '--use-angle=metal'],
} : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true });
await context.addInitScript(() => {
  window.__scissorsGizmoEvents = [];
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'webglcontextlost']) document.addEventListener(type, event => {
    if (!(event.target instanceof HTMLCanvasElement) || !event.target.closest('[data-testid="scissors-viewport"]')) return;
    window.__scissorsGizmoEvents.push({ type, pointerType: event.pointerType ?? null, isTrusted: event.isTrusted });
  }, true);
});
const page = await context.newPage(); page.setDefaultTimeout(45000);
page.on('pageerror', error => report.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') (health(message.location().url) ? report.expectedOfflineProbes : report.errors).push(message.text()); });
page.on('response', response => { if (response.status() >= 400) (health(response.url()) && response.status() === 404 ? report.expectedOfflineProbes : report.failedRequests).push({ url: response.url(), status: response.status() }); });
page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
const lab = page.getByRole('dialog', { name: 'Liver physics lab', exact: true });
const host = page.getByTestId('scissors-viewport'), canvas = host.locator('canvas'), workspace = lab.locator('.scissors-lab');
const button = name => lab.getByRole('button', { name, exact: true });
const diagnostic = async () => JSON.parse(await host.getAttribute('data-scissors-diagnostics'));
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ready = async () => { await expect(canvas).toHaveCount(1); await expect.poll(async () => (await diagnostic()).ready, { timeout: 90000 }).toBe(true); await expect(button('Close & cut')).toBeEnabled(); };
const check = (name, details = {}) => { report.checks.push({ name, status: 'PASS', ...details }); console.log(`PASS ${name}`); };
const snapshot = async name => {
  const pending = page.waitForEvent('download'); await button('Export incision mesh').click();
  const download = await pending, file = path.join(out, `${name}.json`); await download.saveAs(file);
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  expect(data.schema).toBe('viscera.scissors-workspace/v1');
  for (const values of [data.tool.positionMm, data.tool.quaternion, data.camera.positionMm, data.camera.quaternion]) expect(values.every(Number.isFinite)).toBe(true);
  return data;
};
const topology = data => hash(JSON.stringify({ rest: data.surface.geometry.restPositionsMm, indices: data.surface.geometry.indices, walls: data.surface.geometry.wallIndices }));
const unchangedCuts = (before, after) => { expect(after.surface.metrics.cutCount).toBe(before.surface.metrics.cutCount); expect(topology(after)).toBe(topology(before)); };
const equalVector = (before, after, tolerance = 1e-6) => before.forEach((value, i) => expect(Math.abs(value - after[i])).toBeLessThan(tolerance));
const cameraStable = (before, after) => { equalVector(before.camera.positionMm, after.camera.positionMm, 1e-4); equalVector(before.camera.quaternion, after.camera.quaternion, 1e-6); };

/** CPU-only picker reconstruction. pointerHover is a public Three control API;
 * the actual action below remains a trusted browser mouse/touch interaction. */
async function plan(data, mode, axis = 'X', displacementMm = 6) {
  await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); expect(box).toBeTruthy();
  const camera = new THREE.PerspectiveCamera(data.camera.fovDegrees, data.camera.aspect, .1, 2500);
  camera.position.fromArray(data.camera.positionMm); camera.quaternion.fromArray(data.camera.quaternion); camera.updateMatrixWorld();
  const scene = new THREE.Scene(), object = new THREE.Group(); object.position.fromArray(data.tool.positionMm); object.quaternion.fromArray(data.tool.quaternion); scene.add(object);
  const control = new TransformControls(camera); control.attach(object); control.setSize(.75); control.setSpace('world'); control.setMode(mode); scene.add(control.getHelper()); scene.updateMatrixWorld(true);
  const scale = camera.position.distanceTo(object.position) * Math.min(1.9 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2), 7) * .75 / 4;
  const vector = new THREE.Vector3(axis === 'X' ? 1 : 0, axis === 'Y' ? 1 : 0, axis === 'Z' ? 1 : 0);
  const project = world => { const ndc = world.clone().project(camera); return { ndc, x: box.x + (ndc.x + 1) * box.width / 2, y: box.y + (1 - ndc.y) * box.height / 2 }; };
  const candidates = [];
  if (mode === 'translate') for (const fraction of [.50, -.50, .44, -.44, .55, -.55]) candidates.push(object.position.clone().addScaledVector(vector, scale * fraction));
  else control.getHelper().traverse(child => {
    // Use visible ring vertices: the picker torus also covers its hidden half.
    if (!child.isMesh || child.name !== axis) return;
    for (let parent = child; parent; parent = parent.parent) if (!parent.visible) return;
    const position = child.geometry.getAttribute('position');
    for (let i = 2; i < position.count - 2; i += Math.max(1, Math.floor(position.count / 24))) candidates.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(child.matrixWorld));
  });
  let found;
  for (const world of candidates) {
    const p = project(world); if (p.x < box.x + 15 || p.x > box.x + box.width - 15 || p.y < box.y + 15 || p.y > box.y + box.height - 15) continue;
    control.pointerHover({ x: p.ndc.x, y: p.ndc.y, button: 0 }); if (control.axis !== axis) continue;
    const end = mode === 'translate' ? world.clone().addScaledVector(vector, displacementMm)
      : world.clone().sub(object.position).applyAxisAngle(vector, .35).add(object.position);
    const finish = project(end);
    if (finish.x < box.x + 10 || finish.x > box.x + box.width - 10 || finish.y < box.y + 10 || finish.y > box.y + box.height - 10) continue;
    found = { start: { x: p.x, y: p.y }, end: { x: finish.x, y: finish.y }, axis, scale, mode }; break;
  }
  const geometries = new Set(), materials = new Set(); control.getHelper().traverse(child => { if (child.geometry) geometries.add(child.geometry); if (child.material) for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material); });
  geometries.forEach(item => item.dispose()); materials.forEach(item => item.dispose());
  expect(found, `No visible ${mode} ${axis} picker at exported camera`).toBeTruthy(); report.observations.push({ kind: 'projected-handle', ...found }); return found;
}
async function beginDrag(p) { await canvas.focus(); await page.mouse.move(p.start.x, p.start.y); await page.mouse.down(); await page.mouse.move(p.end.x, p.end.y, { steps: 10 }); await frames(); }
async function xDrag(name) {
  await button('Move in 3D').click(); await frames(); const before = await snapshot(`${name}-before`), p = await plan(before, 'translate');
  await beginDrag(p); await page.mouse.up(); await frames(); const after = await snapshot(`${name}-after`);
  expect(after.tool.positionMm[0] - before.tool.positionMm[0]).toBeGreaterThan(.5);
  equalVector(before.tool.positionMm.slice(1), after.tool.positionMm.slice(1)); equalVector(before.tool.quaternion, after.tool.quaternion);
  cameraStable(before, after); unchangedCuts(before, after); return { before, after, plan: p };
}

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Physics lab', exact: true }).click(); await ready();
  await button('Focus jaws').click(); await page.waitForTimeout(350);
  await xDrag('mouse-x'); await canvas.screenshot({ path: path.join(out, 'mouse-x.png') });
  check('A trusted X gizmo drag changes only tool X; camera and incision topology remain unchanged');

  await button('Rotate in 3D').click(); await frames(); const beforeRotate = await snapshot('rotation-before'), ring = await plan(beforeRotate, 'rotate', 'Z');
  await beginDrag(ring); await page.mouse.up(); await frames(); const afterRotate = await snapshot('rotation-after');
  const rotationRadians = new THREE.Quaternion().fromArray(beforeRotate.tool.quaternion).angleTo(new THREE.Quaternion().fromArray(afterRotate.tool.quaternion));
  expect(rotationRadians).toBeGreaterThan(.01); equalVector(beforeRotate.tool.positionMm, afterRotate.tool.positionMm); cameraStable(beforeRotate, afterRotate); unchangedCuts(beforeRotate, afterRotate);
  await canvas.screenshot({ path: path.join(out, 'rotation.png') }); check('Dragging a visible rotation ring rotates the instrument without translating it or orbiting the camera', { rotationRadians });

  await button('Move in 3D').click(); const heldBefore = await snapshot('held-drag-before'), heldPlan = await plan(heldBefore, 'translate', 'X', 2);
  await beginDrag(heldPlan); await expect.poll(async () => (await diagnostic()).position[0] - heldBefore.tool.positionMm[0]).toBeGreaterThan(.5);
  await page.keyboard.press('Space'); await expect.poll(async () => (await diagnostic()).notice).toBe('Release the transform handle before closing the jaws.');
  expect((await diagnostic()).busy).toBe(false); expect((await diagnostic()).cutCount).toBe(heldBefore.surface.metrics.cutCount);
  await page.keyboard.press('Escape'); await page.mouse.up(); await frames(); const heldAfter = await snapshot('held-drag-after'); unchangedCuts(heldBefore, heldAfter);
  await xDrag('after-escape'); check('Space while dragging is rejected; Escape and pointer release restore subsequent gizmo interaction');

  const beforeTouch = await snapshot('touch-before'), touchPlan = await plan(beforeTouch, 'translate', 'X', 3), cdp = await context.newCDPSession(page);
  await canvas.focus();
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 4, ...touchPlan.start, radiusX: 3, radiusY: 3, force: .5 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 4, x: touchPlan.start.x + (touchPlan.end.x - touchPlan.start.x) * i / 8, y: touchPlan.start.y + (touchPlan.end.y - touchPlan.start.y) * i / 8, radiusX: 3, radiusY: 3, force: .5 }] });
    await expect.poll(async () => (await diagnostic()).position[0] - beforeTouch.tool.positionMm[0]).toBeGreaterThan(.5);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await frames();
  } finally { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }).catch(() => {}); await cdp.detach(); }
  const afterTouch = await snapshot('touch-cancel-after'); equalVector(beforeTouch.tool.positionMm.slice(1), afterTouch.tool.positionMm.slice(1)); cameraStable(beforeTouch, afterTouch); unchangedCuts(beforeTouch, afterTouch);
  expect((await page.evaluate(() => window.__scissorsGizmoEvents)).some(event => event.type === 'pointercancel' && event.pointerType === 'touch' && event.isTrusted)).toBe(true);
  await xDrag('after-touch-cancel');
  await button('Inspect').click(); await canvas.scrollIntoViewIfNeeded(); const beforeOrbit = await snapshot('orbit-before'), box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width * .5, box.y + box.height * .5); await page.mouse.down(); await page.mouse.move(box.x + box.width * .5 + 48, box.y + box.height * .5 + 20, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
  const afterOrbit = await snapshot('orbit-after'); expect(new THREE.Vector3().fromArray(beforeOrbit.camera.positionMm).distanceTo(new THREE.Vector3().fromArray(afterOrbit.camera.positionMm))).toBeGreaterThan(1);
  equalVector(beforeOrbit.tool.positionMm, afterOrbit.tool.positionMm); unchangedCuts(beforeOrbit, afterOrbit);
  check('A trusted touch handle drag and touchcancel leave both mouse gizmos and camera inspection usable');

  const retired = await canvas.elementHandle();
  const injected = await canvas.evaluate(element => { const gl = element.getContext('webgl2') ?? element.getContext('webgl'); const extension = gl?.getExtension('WEBGL_lose_context'); if (!extension) return false; extension.loseContext(); return true; }); expect(injected).toBe(true);
  await expect(workspace.getByRole('alert')).toContainText('graphics context was lost'); await expect(button('Close & cut')).toBeDisabled(); await expect.poll(async () => (await diagnostic()).ready).toBe(false);
  expect((await page.evaluate(() => window.__scissorsGizmoEvents)).some(event => event.type === 'webglcontextlost' && event.isTrusted)).toBe(true);
  await button('Reload scissors').click(); await ready(); await expect(workspace.getByRole('alert')).toHaveCount(0);
  expect(await retired.evaluate(element => ({ connected: element.isConnected, source: element.dataset.sceneRecordingSource }))).toEqual({ connected: false, source: undefined }); await retired.dispose();
  await expect(canvas).toHaveAttribute('data-scene-recording-source', 'native'); expect((await diagnostic()).cutCount).toBe(0);
  await xDrag('after-context-reload'); await canvas.screenshot({ path: path.join(out, 'recovered.png') });
  check('Native graphics-context loss disables cutting; Reload creates one fresh registered canvas and working gizmos');

  report.events = await page.evaluate(() => window.__scissorsGizmoEvents);
  for (const pointerType of ['mouse', 'touch']) expect(report.events.some(event => event.type === 'pointerdown' && event.pointerType === pointerType && event.isTrusted)).toBe(true);
  expect(report.errors).toEqual([]); expect(report.failedRequests).toEqual([]);
  report.sourceAfter = await sources(); report.sourceUnchanged = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter); expect(report.sourceUnchanged).toBe(true); report.status = 'PASS';
} catch (error) {
  report.failure = error.stack ?? String(error); report.failureState = await diagnostic().catch(() => null); process.exitCode = 1; console.error(error);
  await page.mouse.up().catch(() => {}); await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  report.events = await page.evaluate(() => window.__scissorsGizmoEvents).catch(() => null); report.finishedAt = new Date().toISOString();
  report.scope = 'Trusted gizmo interaction, cancellation and native context-loss recovery; not clinical validation.';
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify({ out, status: report.status, checks: report.checks.length, failure: report.failure }));
}
