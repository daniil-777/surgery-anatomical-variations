#!/usr/bin/env node
// Run serially: this launches native Chrome/Metal and must not overlap GPU QA.
// No product hooks or mocked mechanics. Optional SCISSORS_RECORD=1 records the
// actual interactive scene at 4K through the application's own recorder.
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { capturePublicBuildSources } from './stage_public_assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const url = process.env.SCISSORS_URL ?? process.env.CUTTING_URL ?? 'http://127.0.0.1:5174/';
const out = path.resolve(process.env.SCISSORS_OUT ?? path.join(root, 'artifacts/cutting-2026-10-20', `scissors-native-${Date.now()}`));
const shouldRecord = process.env.SCISSORS_RECORD === '1';
await fs.mkdir(out, { recursive: true });
const staticCopy = process.env.SCISSORS_STATIC_COPY === '1' || process.env.CUTTING_STATIC_COPY === '1';
const config = staticCopy ? await fetch(new URL('api.json', url)).then(response => { if (!response.ok) throw new Error('Static API configuration unavailable'); return response.json(); }) : null;
if (config && config.api !== null) throw new Error('Offline health expectation requires explicit api:null');
const expectedHealth = location => Boolean(config) && location === new URL('api/health', url).href;
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSnapshot = async () => [...capturePublicBuildSources(root).filter(entry => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.path)),
  { path: 'apps/studio/public/cutting/liver-reference.json', sha256: hash(await fs.readFile(path.join(root, 'apps/studio/public/cutting/liver-reference.json'))) }];
const report = { status: 'FAIL', url, out, startedAt: new Date().toISOString(), checks: [], errors: [], failedRequests: [], expectedOfflineProbes: [], expectedOfflineConsole: [], observations: [], recordRequested: shouldRecord, sourceBefore: await sourceSnapshot(), clinicalRealismCertified: false };
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? {
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle', '--use-angle=metal'],
} : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true });
await context.addInitScript(() => {
  window.__scissorsPointerAudit = [];
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) document.addEventListener(type, event => {
    if (!(event.target instanceof HTMLCanvasElement) || !event.target.closest('[data-testid="scissors-viewport"]')) return;
    window.__scissorsPointerAudit.push({ type, pointerType: event.pointerType, isPrimary: event.isPrimary, isTrusted: event.isTrusted });
  }, true);
});
const page = await context.newPage(); page.setDefaultTimeout(45000);
page.on('pageerror', error => report.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') (expectedHealth(message.location().url) ? report.expectedOfflineConsole : report.errors).push(message.text()); });
page.on('response', response => { if (response.status() >= 400) (expectedHealth(response.url()) && response.status() === 404 ? report.expectedOfflineProbes : report.failedRequests).push({ url: response.url(), status: response.status() }); });
page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
const lab = page.getByRole('dialog', { name: 'Liver physics lab', exact: true });
const workspace = lab.locator('.scissors-lab'), host = page.getByTestId('scissors-viewport'), canvas = host.locator('canvas'), stage = workspace.locator('.scissors-stage');
const button = name => lab.getByRole('button', { name, exact: true });
const diagnostic = async () => JSON.parse(await host.getAttribute('data-scissors-diagnostics'));
const check = (name, details = {}) => { report.checks.push({ name, status: 'PASS', ...details }); console.log(`PASS ${name}`); };
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const ready = async () => { await expect(canvas).toHaveCount(1); await expect.poll(async () => Boolean((await diagnostic())?.ready), { timeout: 90000 }).toBe(true); await expect(button('Close & cut')).toBeEnabled(); };
const capture = async name => { await canvas.scrollIntoViewIfNeeded(); await canvas.screenshot({ path: path.join(out, `${name}.png`) }); const state = await diagnostic(); report.observations.push({ name, ...state }); await fs.writeFile(path.join(out, `${name}-state.json`), JSON.stringify(state, null, 2)); };
function array(value, label) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object' && Object.keys(value).every(key => /^\d+$/.test(key))) return Object.keys(value).sort((a, b) => Number(a) - Number(b)).map(key => value[key]);
  throw new Error(`${label} is not a numeric mesh array`);
}
function meshData(snapshot) {
  expect(snapshot.schema).toBe('viscera.scissors-workspace/v1'); expect(snapshot.surface.schema).toBe('viscera.scissors-surface/v1');
  const geometry = snapshot.surface.geometry;
  const result = Object.fromEntries(['positionsMm', 'restPositionsMm', 'indices', 'wallIndices'].map(name => [name, array(geometry[name], name)]));
  expect(result.positionsMm.length).toBeGreaterThan(0); expect(result.positionsMm.length % 3).toBe(0);
  expect(result.restPositionsMm.length).toBe(result.positionsMm.length);
  expect(result.positionsMm.every(Number.isFinite)).toBe(true); expect(result.restPositionsMm.every(Number.isFinite)).toBe(true);
  for (const name of ['indices', 'wallIndices']) { expect(result[name].length % 3).toBe(0); expect(result[name].every(index => Number.isInteger(index) && index >= 0 && index * 3 < result.positionsMm.length)).toBe(true); }
  return result;
}
const topology = snapshot => { const mesh = meshData(snapshot); return hash(JSON.stringify({ restPositionsMm: mesh.restPositionsMm, indices: mesh.indices, wallIndices: mesh.wallIndices })); };
const exported = async name => {
  const pending = page.waitForEvent('download'); await button('Export incision mesh').click();
  const download = await pending, destination = path.join(out, `${name}.json`); await download.saveAs(destination);
  const snapshot = JSON.parse(await fs.readFile(destination, 'utf8')); meshData(snapshot); return snapshot;
};
const closeJaws = async (name, keyboard = false) => {
  const before = await diagnostic();
  if (keyboard) { await canvas.focus(); await page.keyboard.press('Space'); } else await button('Close & cut').click();
  await expect.poll(async () => (await diagnostic()).busy).toBe(true);
  await capture(`${name}-closing`);
  await expect.poll(async () => (await diagnostic()).busy, { timeout: 45000 }).toBe(false);
  await expect(workspace.getByRole('alert')).toHaveCount(0); await expect(button('Close & cut')).toBeEnabled();
  const after = await exported(name); report.observations.push({ name: `${name}-cycle`, before, after: await diagnostic() }); return after;
};
const commit = async (label, value) => { const field = workspace.getByLabel(label, { exact: true }); await field.fill(String(value)); await field.press('Enter'); };
const point = async (x = .5, y = .5) => { await canvas.scrollIntoViewIfNeeded(); const bounds = await canvas.boundingBox(); expect(bounds).toBeTruthy(); return { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y }; };
const sameCuts = (before, after) => { expect(after.surface.metrics.cutCount).toBe(before.surface.metrics.cutCount); expect(after.surface.metrics.cutSegments).toBe(before.surface.metrics.cutSegments); expect(topology(after)).toBe(topology(before)); };

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' }); await page.getByRole('button', { name: 'Physics lab', exact: true }).click();
  await expect(button('3D scissors')).toHaveAttribute('aria-pressed', 'true'); await ready();
  await expect(canvas).toHaveAttribute('data-scene-recording-source', 'native');
  await expect(canvas).toHaveAttribute('data-scene-recording-label', 'Laparoscopic scissors · interactive surface model');
  report.graphics = await canvas.evaluate(element => { const gl = element.getContext('webgl2') ?? element.getContext('webgl'); if (!gl) return null; const info = gl.getExtension('WEBGL_debug_renderer_info'); return { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) }; });
  const initial = await exported('initial'); expect(initial.surface.metrics.cutCount).toBe(0); expect(meshData(initial).wallIndices).toHaveLength(0);
  await capture('initial-scissors'); await page.screenshot({ path: path.join(out, 'initial-ui.png'), fullPage: true });
  check('Physics Lab opens the ready 3D scissors workspace with a registered native scene');

  const cut = await closeJaws('first-incision');
  expect(cut.surface.metrics.cutCount).toBe(1); expect(cut.surface.metrics.cutSegments).toBeGreaterThan(0);
  expect(topology(cut)).not.toBe(topology(initial)); expect(meshData(cut).wallIndices.length).toBeGreaterThan(0);
  expect(meshData(cut).positionsMm.length).toBeGreaterThan(meshData(initial).positionsMm.length);
  await button('Focus jaws').click(); await capture('first-incision-close');
  check('An explicit jaw closure creates exported split topology and finite interior walls', { metrics: cut.surface.metrics });

  // Pose changes are verified against immutable topology, not moving shell
  // coordinates: the independent compliant response may still be relaxing.
  await button('Move in 3D').click();
  for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]]) {
    const next = (await diagnostic()).position[index] + 3.25; await commit(`Position ${axis}`, next);
    await expect.poll(async () => (await diagnostic()).position[index]).toBeCloseTo(next, 5);
  }
  await button('Rotate in 3D').click();
  for (const [axis, index, value] of [['X', 0, 15], ['Y', 1, -23], ['Z', 2, 31]]) { await commit(`Rotation ${axis}`, value); await expect.poll(async () => (await diagnostic()).rotation[index]).toBeCloseTo(value, 4); }
  const moved = await exported('all-axes-pose'); sameCuts(cut, moved); expect(moved.tool.quaternion).not.toEqual(cut.tool.quaternion);
  await capture('rotated-instrument');
  await canvas.focus(); await page.keyboard.press('m'); await expect.poll(async () => (await diagnostic()).mode).toBe('translate');
  const keyPosition = (await diagnostic()).position;
  for (const [key, index, delta] of [['ArrowRight', 0, 1], ['ArrowUp', 1, 1], ['PageUp', 2, 1]]) { await page.keyboard.press(key); await expect.poll(async () => (await diagnostic()).position[index]).toBeCloseTo(keyPosition[index] + delta, 6); }
  await page.keyboard.press('r'); await expect.poll(async () => (await diagnostic()).mode).toBe('rotate');
  for (const key of ['ArrowRight', 'ArrowUp', 'PageUp']) {
    const before = await exported(`before-key-${key}`); await canvas.focus(); await page.keyboard.press(key); await frames();
    const after = await exported(`after-key-${key}`); sameCuts(cut, after);
    const dot = Math.abs(before.tool.quaternion.reduce((sum, value, i) => sum + value * after.tool.quaternion[i], 0));
    expect(2 * Math.acos(Math.min(1, dot)) * 180 / Math.PI).toBeCloseTo(5, 5);
    expect(after.tool.positionMm).toEqual(before.tool.positionMm);
  }
  check('Numeric and keyboard movement/rotation work on all three axes without creating cuts');

  const rest = meshData(initial).restPositionsMm, maxima = [0, 1, 2].map(axis => Math.max(...rest.filter((_, i) => i % 3 === axis)));
  for (const [axis, index] of [['X', 0], ['Y', 1], ['Z', 2]]) await commit(`Position ${axis}`, maxima[index] + 120);
  const emptyBefore = await exported('empty-space-before');
  const emptyAfter = await closeJaws('empty-space-after'); sameCuts(emptyBefore, emptyAfter);
  check('Closing in empty space preserves every exported surface and wall triangle');

  await button('Fit liver').click(); await button('Place on liver').click();
  const placementCandidates = [[.50, .50], [.43, .50], [.57, .50], [.50, .40], [.43, .60], [.57, .60], [.36, .50], [.64, .50]];
  async function placeByPointer(kind) {
    const before = (await diagnostic()).position, cdp = kind === 'touch' ? await context.newCDPSession(page) : null;
    try {
      for (const [x, y] of placementCandidates) {
        const p = await point(x, y);
        if (cdp) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 7, x: p.x, y: p.y, radiusX: 4, radiusY: 4, force: .5 }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
        else await page.mouse.click(p.x, p.y);
        await frames(); const current = await diagnostic();
        if (current.notice.startsWith('Tissue positioned') && current.position.some((value, i) => Math.abs(value - before[i]) > .05)) return current;
      }
      throw new Error(`No ${kind} surface placement changed the pose at any visible candidate`);
    } finally { await cdp?.detach(); }
  }
  await placeByPointer('mouse'); const mousePlaced = await exported('mouse-placement'); sameCuts(cut, mousePlaced);
  await commit('Position X', maxima[0] + 100); await placeByPointer('touch'); const touchPlaced = await exported('touch-placement'); sameCuts(cut, touchPlaced);
  const pointerAudit = await page.evaluate(() => window.__scissorsPointerAudit);
  for (const kind of ['mouse', 'touch']) expect(pointerAudit.some(event => event.type === 'pointerup' && event.pointerType === kind && event.isTrusted)).toBe(true);
  const beforeGesture = await exported('before-two-finger-inspection'), touchCenter = await point(.5, .5), cdp = await context.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: touchCenter.x - 25, y: touchCenter.y }, { id: 2, x: touchCenter.x + 25, y: touchCenter.y }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: touchCenter.x - 35, y: touchCenter.y + 12 }, { id: 2, x: touchCenter.x + 35, y: touchCenter.y + 12 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await frames();
  const afterGesture = await exported('after-two-finger-inspection'); sameCuts(beforeGesture, afterGesture); expect(afterGesture.tool).toEqual(beforeGesture.tool);
  check('Trusted mouse/touch placement changes pose only; two-finger inspection preserves the tool and cuts');

  await button('Inspect').click(); await canvas.scrollIntoViewIfNeeded();
  const orbitBefore = await exported('before-camera-orbit'), imageBeforeOrbit = await canvas.screenshot(), orbitPoint = await point(.5, .5);
  await page.mouse.move(orbitPoint.x, orbitPoint.y); await page.mouse.down(); await page.mouse.move(orbitPoint.x + 60, orbitPoint.y + 24, { steps: 8 }); await page.mouse.up();
  await page.waitForTimeout(400); const imageAfterOrbit = await canvas.screenshot({ path: path.join(out, 'camera-orbit.png') });
  const orbitAfter = await exported('after-camera-orbit'); sameCuts(orbitBefore, orbitAfter); expect(orbitAfter.tool).toEqual(orbitBefore.tool);
  expect(hash(imageAfterOrbit)).not.toBe(hash(imageBeforeOrbit));
  await canvas.focus(); await page.keyboard.press('f'); await page.keyboard.press('p'); await expect.poll(async () => (await diagnostic()).mode).toBe('place');
  check('Pointer camera inspection changes the view while preserving tool pose and incision topology');

  await button('Reset incisions').click(); await expect.poll(async () => (await diagnostic()).cutCount).toBe(0);
  const reset = await exported('reset'); expect(topology(reset)).toBe(topology(initial));
  const keyboardCut = await closeJaws('keyboard-incision', true); expect(keyboardCut.surface.metrics.cutCount).toBe(1);
  check('Reset restores the intact mesh and Space triggers one explicit incision');

  const font = await workspace.locator('.scissors-controls legend').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await button('Display settings').click(); const display = page.getByRole('dialog', { name: 'Make this workspace yours', exact: true });
  await display.getByRole('button', { name: '200%', exact: true }).click(); await display.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => workspace.locator('.scissors-controls legend').first().evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(font * 2, 2);
  for (const width of [390, 768, 1600]) {
    await page.setViewportSize({ width, height: 1100 }); await frames();
    await expect.poll(() => workspace.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await button('Export incision mesh').scrollIntoViewIfNeeded(); await expect(button('Export incision mesh')).toBeInViewport();
    await page.screenshot({ path: path.join(out, `layout-${width}-text200.png`), fullPage: true });
    if (width === 390) {
      await stage.scrollIntoViewIfNeeded(); await stage.getByRole('button', { name: 'Scene full screen', exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains('scissors-stage') ?? false)).toBe(true);
      const fullCut = stage.getByRole('button', { name: 'Close scissors and cut in full screen', exact: true });
      await expect(fullCut).toBeInViewport({ ratio: 1 }); await fullCut.click({ trial: true });
      await expect.poll(() => stage.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: path.join(out, 'fullscreen-390-text200.png') });
      await stage.getByRole('button', { name: 'Exit scene full screen', exact: true }).click(); await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
    }
  }
  await button('Display settings').click(); await display.getByRole('button', { name: 'Reset display preferences', exact: true }).click(); await display.getByRole('button', { name: 'Done', exact: true }).click();
  check('390/768/1600 px layouts support 200% text and a reachable fullscreen cut control');

  if (shouldRecord) {
    await button('Reset incisions').click(); await expect.poll(async () => (await diagnostic()).cutCount).toBe(0);
    await workspace.getByLabel('Show instrument handle', { exact: true }).uncheck(); await button('Focus jaws').click();
    const beforeVideo = await exported('recording-before');
    await button('Video recorder').click(); const recorder = page.getByRole('dialog', { name: 'Video recorder', exact: true });
    await expect(recorder.getByText('Current source:', { exact: true }).locator('..')).toContainText('Laparoscopic scissors');
    await recorder.getByRole('radio', { name: /4K/ }).check(); await recorder.getByLabel('Recording frame rate', { exact: true }).selectOption('30');
    await recorder.getByLabel('Record microphone audio', { exact: true }).uncheck();
    await recorder.getByRole('button', { name: 'Start recording', exact: true }).click();
    await expect(button('Pause video recording')).toBeVisible();
    await expect.poll(() => canvas.evaluate(element => [element.width, element.height])).toEqual([3840, 2160]);
    await page.waitForTimeout(750); const recordedCut = await closeJaws('recorded-incision'); expect(recordedCut.surface.metrics.cutCount).toBeGreaterThan(beforeVideo.surface.metrics.cutCount);
    await page.waitForTimeout(1200); await button('Advance 10 mm').click(); const continuedCut = await closeJaws('recorded-continued-incision');
    expect(continuedCut.surface.metrics.cutCount).toBeGreaterThan(recordedCut.surface.metrics.cutCount);
    await page.waitForTimeout(1200);
    await button('Stop video recording').click();
    await expect(page.getByRole('region', { name: 'Finished recording', exact: true })).toBeVisible({ timeout: 60000 });
    const preview = page.getByLabel('Recording preview', { exact: true });
    await expect.poll(() => preview.evaluate(video => [video.videoWidth, video.videoHeight])).toEqual([3840, 2160]);
    report.playback = await preview.evaluate(async video => { video.muted = true; await video.play(); await new Promise(resolve => setTimeout(resolve, 400)); video.pause(); return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null, error: video.error?.message ?? null }; });
    expect(report.playback.currentTime).toBeGreaterThan(.1); expect(report.playback.error).toBe(null);
    const pendingVideo = page.waitForEvent('download'); await page.getByRole('link', { name: /^Download (MP4|WEBM)$/i }).click(); const video = await pendingVideo;
    report.videoFile = `scissors-native-4k${path.extname(video.suggestedFilename())}`; await video.saveAs(path.join(out, report.videoFile));
    const pendingDetails = page.waitForEvent('download'); await recorder.getByRole('button', { name: 'Capture details', exact: true }).click(); const details = await pendingDetails; await details.saveAs(path.join(out, 'recording.json'));
    report.recording = JSON.parse(await fs.readFile(path.join(out, 'recording.json'), 'utf8')); expect(report.recording.width).toBe(3840); expect(report.recording.height).toBe(2160); expect(report.recording.upscaled).toBe(false);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,codec_name,r_frame_rate', '-of', 'json', path.join(out, report.videoFile)], { encoding: 'utf8', timeout: 20000 });
    if (probe.error?.code === 'ENOENT') report.ffprobe = { status: 'UNAVAILABLE' };
    else { expect(probe.status, probe.stderr).toBe(0); report.ffprobe = JSON.parse(probe.stdout); expect(report.ffprobe.streams[0].width).toBe(3840); expect(report.ffprobe.streams[0].height).toBe(2160); }
    await page.screenshot({ path: path.join(out, 'recording-preview.png'), fullPage: true }); await recorder.getByRole('button', { name: 'Close video recorder', exact: true }).click();
    check('Actual 4K scene recording contains successful live incisions and decodes at 3840×2160', { video: report.videoFile });
  }

  const retiredCanvas = await canvas.elementHandle(); await button('Recorded experiments').click();
  await expect(host).toHaveCount(0);
  expect(await retiredCanvas.evaluate(element => ({ connected: element.isConnected, source: element.dataset.sceneRecordingSource }))).toEqual({ connected: false, source: undefined }); await retiredCanvas.dispose();
  await expect(lab.locator('canvas[data-scene-recording-label="Laparoscopic scissors · interactive surface model"]')).toHaveCount(0);
  await button('3D scissors').click(); await ready(); expect((await diagnostic()).cutCount).toBe(0);
  check('Leaving scissors removes its canvas/recording registration; reopening starts an intact specimen');
  await capture('final'); await page.screenshot({ path: path.join(out, 'final-ui.png'), fullPage: true });
  expect(report.errors).toEqual([]); expect(report.failedRequests).toEqual([]);
  report.sourceAfter = await sourceSnapshot(); report.sourceUnchanged = JSON.stringify(report.sourceAfter) === JSON.stringify(report.sourceBefore); expect(report.sourceUnchanged).toBe(true);
  report.status = 'PASS';
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1; console.error(error);
  report.failureState = await diagnostic().catch(() => null);
  report.layoutFailure = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth,
    clipped: [...document.querySelectorAll('*')].filter(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 100), width: element.clientWidth, scroll: element.scrollWidth })).slice(0, 50) })).catch(() => null);
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  report.pointerAudit = await page.evaluate(() => window.__scissorsPointerAudit).catch(() => null);
  report.finishedAt = new Date().toISOString(); report.scope = 'Native UI, exported surface topology and optional actual recording checks; not volumetric fracture or clinical validation.';
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close(); console.log(JSON.stringify({ out, status: report.status, failure: report.failure, checks: report.checks.length }));
}
