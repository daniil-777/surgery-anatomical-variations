#!/usr/bin/env node
// Native Chrome/Metal qualification. Run serially against a frozen production
// copy; never overlap another GPU run. Baseline mode captures existing controls.
// FAT_QA_URL=http://127.0.0.1:5190/ FAT_QA_STATIC_COPY=1 FAT_QA_RECORD=1 node scripts/check_fat_realism_native.mjs
import { chromium, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { capturePublicBuildSources } from './stage_public_assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const base = new URL(process.env.FAT_QA_URL ?? 'http://127.0.0.1:5190/');
const out = path.resolve(process.env.FAT_QA_OUT ?? path.join(root, 'artifacts/fat-realism-2026-10-21', `native-${Date.now()}`));
const baseline = process.env.FAT_QA_BASELINE === '1';
const phase = process.env.FAT_QA_PHASE ?? 'all';
if (!['scene', 'specimen', 'all', 'motion'].includes(phase)) throw new Error('FAT_QA_PHASE must be scene, specimen, motion or all');
const record = process.env.FAT_QA_RECORD === '1' && !baseline;
const staticCopy = process.env.FAT_QA_STATIC_COPY === '1';
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = () => capturePublicBuildSources(root).filter(entry => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.path));
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'started.json'), JSON.stringify({ base: base.href, baseline, phase, startedAt: new Date().toISOString() }), { flag: 'wx' });
const config = staticCopy ? await fetch(new URL('api.json', base)).then(response => {
  if (!response.ok) throw new Error('Static API configuration unavailable'); return response.json();
}) : null;
if (config && config.api !== null) throw new Error('Static-copy qualification requires explicit api:null');
// The static app probes API availability and the optional reference-colour
// service on mount. Baseline receipt records these exact 404 endpoints; other
// resource failures remain errors, including any different API path/status.
const offlineProbeUrls = ['/api/health', '/api/atlas/reference-material/status'].map(relative => new URL(relative, base).href);
const expectedOfflineRequest = location => Boolean(config) && offlineProbeUrls.includes(location);
const report = { status: 'FAIL', baseline, phase, url: base.href, out, startedAt: new Date().toISOString(), checks: [], captures: [], videos: [], pointerAudit: [], errors: [], failedRequests: [], expectedOfflineProbes: [], expectedOfflineConsole: [], sourceBefore: sources(), clinicalRealismCertified: false };
report.harnessSha256 = hash(await fs.readFile(import.meta.filename));
if (staticCopy) {
  report.build = await fetch(new URL('build.json', base)).then(response => { if (!response.ok) throw new Error('Build receipt unavailable'); return response.json(); });
  const manifest = await fetch(new URL('public-source.json', base)).then(response => { if (!response.ok) throw new Error('Build source receipt unavailable'); return response.json(); });
  const built = new Map(manifest.files.map(entry => [entry.path, entry.sha256]));
  report.deployedSourceMismatches = report.sourceBefore.filter(entry => built.get(entry.path) !== entry.sha256).map(entry => entry.path);
  if (!baseline) expect(report.deployedSourceMismatches).toEqual([]);
}
const browser = await chromium.launch({ headless: true, ...(process.platform === 'darwin' ? {
  executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle', '--use-angle=metal'],
} : {}) });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, hasTouch: true, acceptDownloads: true });
await context.addInitScript(() => {
  window.__fatPointerAudit = [];
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) document.addEventListener(type, event => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    window.__fatPointerAudit.push({ type, pointerType: event.pointerType, isTrusted: event.isTrusted, label: event.target.getAttribute('aria-label') });
  }, true);
});
const page = await context.newPage(); page.setDefaultTimeout(45000);
page.on('pageerror', error => report.errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') (expectedOfflineRequest(message.location().url) && /^Failed to load resource:/.test(message.text()) ? report.expectedOfflineConsole : report.errors).push({ message: message.text(), location: message.location() }); });
page.on('response', response => { if (response.status() >= 400) (expectedOfflineRequest(response.url()) && response.status() === 404 ? report.expectedOfflineProbes : report.failedRequests).push({ url: response.url(), status: response.status() }); });
page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), failure: request.failure()?.errorText }));
const button = name => page.getByRole('button', { name, exact: true });
const check = (name, details = {}) => { report.checks.push({ name, status: 'PASS', ...details }); console.log(`PASS ${name}`); };
const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const host = () => page.locator('[data-fat-ready="true"], [data-scene-ready="true"]').first();
const canvas = () => host().locator('canvas').first();
const state = async () => JSON.parse(await host().getAttribute(await host().getAttribute('data-fat-snapshot') ? 'data-fat-snapshot' : 'data-scene-snapshot'));
const modeUrl = mode => { const url = new URL(base); url.searchParams.set('mode', mode); if (mode === 'scene') url.searchParams.set('fat', '1'); return url.href; };
async function readySpecimen(resolution = 1024) {
  await frames(); await expect.poll(async () => (await state()).textureResolution, { timeout: 150000 }).toBe(resolution);
  await expect(page.locator('.fat-baking')).toHaveCount(0); await expect(page.getByRole('alert')).toHaveCount(0); await frames();
}
async function readyScene(seed) {
  await expect.poll(async () => { const s = await state(); return s.fat?.status === 'ready' && (seed === undefined || s.fat.diagnostics.seed === seed); }, { timeout: 150000 }).toBe(true);
  await expect.poll(async () => (await state()).rendering.cameraTransition).toBe(false);
  await expect(page.getByRole('alert')).toHaveCount(0); await frames();
}
async function visibleDepots(omentum, perirenal) {
  await expect.poll(async () => {
    const fat = (await state()).fat;
    return fat.options.omentum === omentum && fat.options.perirenal === perirenal && fat.layers.length === 3
      && fat.layers.every(layer => layer.visible === (layer.id.includes('omentum') ? omentum : perirenal));
  }).toBe(true);
}
const views = ['Front', 'Back', 'Left', 'Right', 'Top', ...(baseline ? [] : ['Bottom']), '¾ view'];
async function sceneView(view) {
  const id = view === '¾ view' ? 'oblique' : view.toLowerCase();
  await button(view).click();
  await expect.poll(async () => { const s = await state(); return s.camera.view === id && !s.rendering.cameraTransition; }).toBe(true);
  await readyScene();
}
async function capture(name, details = {}) {
  await canvas().scrollIntoViewIfNeeded(); await frames();
  const bytes = Buffer.from(await canvas().evaluate(element => element.toDataURL('image/png').split(',')[1]), 'base64');
  await fs.writeFile(path.join(out, `${name}.png`), bytes);
  const snapshot = await state(), record = { name, file: `${name}.png`, sha256: hash(bytes), ...details, snapshot };
  report.captures.push(record); await fs.writeFile(path.join(out, `${name}-state.json`), JSON.stringify(snapshot, null, 2)); return record;
}
async function orbit(dx, dy = 0, touch = false) {
  await canvas().scrollIntoViewIfNeeded(); const box = await canvas().boundingBox(); expect(box).toBeTruthy();
  // OrbitControls scales angular motion by element height. Keep each drag inside
  // the visible canvas and repeat when >1/3 canvas width is needed.
  const count = Math.max(1, Math.ceil(Math.abs(dx) * box.height / (box.width * .3)), Math.ceil(Math.abs(dy) / .3));
  const start = { x: box.x + box.width * .48, y: box.y + box.height * .5 };
  const cdp = touch ? await context.newCDPSession(page) : null;
  try {
    for (let i = 0; i < count; i++) {
      const end = { x: start.x + dx * box.height / count, y: start.y + dy * box.height / count };
      if (cdp) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, ...start }] });
        for (let step = 1; step <= 8; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: start.x + (end.x - start.x) * step / 8, y: start.y + (end.y - start.y) * step / 8 }] });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else { await page.mouse.move(start.x, start.y); await page.mouse.down(); await page.mouse.move(end.x, end.y, { steps: 12 }); await page.mouse.up(); }
      await page.waitForTimeout(650);
    }
  } finally { await cdp?.detach(); }
}
async function download(name, file) {
  const pending = page.waitForEvent('download'); await button(name).click(); const item = await pending;
  await item.saveAs(path.join(out, file)); return fs.readFile(path.join(out, file));
}
async function range(label, value) {
  const field = page.getByLabel(label, { exact: true });
  const attrs = await field.evaluate(input => ({ min: Number(input.min), max: Number(input.max), step: Number(input.step || 1) }));
  expect(value).toBeGreaterThanOrEqual(attrs.min); expect(value).toBeLessThanOrEqual(attrs.max);
  await field.focus(); await field.press('Home');
  for (let i = 0; i < Math.round((value - attrs.min) / attrs.step); i++) await field.press('ArrowRight');
  await expect(field).toHaveValue(String(value)); await frames();
}
async function fit() { await button('Fit fat specimen').click(); await page.waitForTimeout(700); }
function glbGeometry(bytes) {
  expect(bytes.subarray(0, 4).toString()).toBe('glTF'); expect(bytes.readUInt32LE(4)).toBe(2); expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12), binaryOffset = 20 + jsonLength;
  const json = JSON.parse(bytes.subarray(20, binaryOffset).toString('utf8'));
  expect(json.meshes.length).toBeGreaterThan(0); expect(bytes.toString('ascii', binaryOffset + 4, binaryOffset + 8)).toBe('BIN\0');
  return hash(bytes.subarray(binaryOffset + 8));
}
async function mobile(mode) {
  const text = page.locator(mode === 'fat' ? '.fat-panel h2' : '.whole-panel-scroll h2').first();
  const font = await text.evaluate(element => parseFloat(getComputedStyle(element).fontSize));
  await button('Display settings').click(); const display = page.getByRole('dialog', { name: 'Make this workspace yours', exact: true });
  await display.getByRole('button', { name: '200%', exact: true }).click(); await display.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(() => text.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(font * 2, 2);
  for (const width of [390, 768, 1600]) {
    await page.setViewportSize({ width, height: 1100 }); await frames();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    const action = button(mode === 'fat' ? 'Sample new specimen' : 'Resample fat layers'); await action.scrollIntoViewIfNeeded(); await expect(action).toBeInViewport(); await action.click({ trial: true });
    await page.screenshot({ path: path.join(out, `${mode}-layout-${width}-text200.png`), fullPage: true });
  }
  await button('Display settings').click(); await display.getByRole('button', { name: 'Reset display preferences', exact: true }).click(); await display.getByRole('button', { name: 'Done', exact: true }).click();
  check(`${mode}: 200% text at 390/768/1600 px has no horizontal overflow and keeps primary action reachable`);
}
async function recordNative(name) {
  const pose = (await state()).camera;
  // A modal lab can coexist with the global recorder entry. Target the current
  // workspace's header controls so duplicate global labels cannot pass/fail us.
  const header = page.locator('.fat-header, .whole-header').first();
  await header.getByRole('button', { name: 'Video recorder', exact: true }).click(); const recorder = page.getByRole('dialog', { name: 'Video recorder', exact: true });
  await recorder.getByRole('radio', { name: /4K/ }).check(); await recorder.getByLabel('Recording frame rate', { exact: true }).selectOption('30');
  await recorder.getByLabel('Record microphone audio', { exact: true }).uncheck(); await recorder.getByRole('button', { name: 'Start recording', exact: true }).click();
  await expect(header.getByRole('button', { name: 'Pause video recording', exact: true })).toBeVisible(); await expect.poll(() => canvas().evaluate(element => [element.width, element.height])).toEqual([3840, 2160]);
  if (pose?.focusedOrgan?.startsWith('fat-')) {
    await expect.poll(async () => (await state()).rendering.cameraTransition).toBe(false);
    const recordingPose = (await state()).camera;
    expect(recordingPose.target).toEqual(pose.target); expect(recordingPose.position).toEqual(pose.position);
    expect(recordingPose.focusedOrgan).toBe(pose.focusedOrgan);
  }
  if (process.env.FAT_QA_RAW_SAMPLES === '1') await canvas().evaluate(source => {
    const probe = document.createElement('canvas'); probe.width=384; probe.height=216;
    const context = probe.getContext('2d', {willReadFrequently:true});
    window.__fatRawSamples=[];
    const started=performance.now();
    window.__fatRawTimer=setInterval(()=>{
      context.drawImage(source,0,0,384,216);const pixels=context.getImageData(0,0,384,216).data;
      let black=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]<5&&pixels[i+1]<5&&pixels[i+2]<5)black++;
      const fraction=black/(384*216), rows=window.__fatRawSamples;
      rows.push({seconds:(performance.now()-started)/1000,blackFraction:fraction,
        ...(fraction>.001&&rows.filter(row=>row.png).length<12?{png:source.toDataURL('image/png').split(',')[1]}:{})});
    },50);
  });
  await page.waitForTimeout(900); await orbit(.18, -.035); await orbit(.18, .07); await orbit(.18, -.035); await page.waitForTimeout(900);
  if (process.env.FAT_QA_RAW_SAMPLES === '1') {
    const rows=await page.evaluate(()=>{clearInterval(window.__fatRawTimer);return window.__fatRawSamples;});
    for(let i=0;i<rows.length;i++)if(rows[i].png){const bytes=Buffer.from(rows[i].png,'base64');delete rows[i].png;rows[i].file=`${name}-raw-${i}.png`;rows[i].sha256=hash(bytes);await fs.writeFile(path.join(out,rows[i].file),bytes);}
    await fs.writeFile(path.join(out,`${name}-raw-samples.json`),JSON.stringify({diagnosticOnly:true,notes:'Raw canvas small-image black-pixel heuristic; sampling adds GPU readback cost. Suspicious raw PNGs preserved unmodified. Not an FPS benchmark.',samples:rows},null,2));
  }
  await header.getByRole('button', { name: 'Stop video recording', exact: true }).click(); await expect(page.getByRole('region', { name: 'Finished recording', exact: true })).toBeVisible({ timeout: 60000 });
  const preview = page.getByLabel('Recording preview', { exact: true }); await expect.poll(() => preview.evaluate(video => [video.videoWidth, video.videoHeight])).toEqual([3840, 2160]);
  const playback = await preview.evaluate(async video => { video.muted = true; await video.play(); await new Promise(resolve => setTimeout(resolve, 350)); video.pause(); return { width: video.videoWidth, height: video.videoHeight, currentTime: video.currentTime, previewUrl: video.currentSrc, error: video.error?.message ?? null }; });
  expect(playback.currentTime).toBeGreaterThan(.1); expect(playback.error).toBe(null);
  const pending = page.waitForEvent('download'); await page.getByRole('link', { name: /^Download (MP4|WEBM)$/i }).click(); const video = await pending, file = `${name}${path.extname(video.suggestedFilename())}`; await video.saveAs(path.join(out, file));
  const detailsPending = page.waitForEvent('download'); await recorder.getByRole('button', { name: 'Capture details', exact: true }).click(); const details = await detailsPending; await details.saveAs(path.join(out, `${name}-recording.json`));
  const receipt = JSON.parse(await fs.readFile(path.join(out, `${name}-recording.json`), 'utf8')); expect(receipt.width).toBe(3840); expect(receipt.height).toBe(2160); expect(receipt.upscaled).toBe(false);
  const probe = spawnSync(process.env.FFPROBE ?? '/opt/homebrew/bin/ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,nb_read_frames,duration', '-show_entries', 'format=duration', '-of', 'json', path.join(out, file)], { encoding: 'utf8', timeout: 60000 });
  expect(probe.status, probe.stderr || String(probe.error)).toBe(0); const decoded = JSON.parse(probe.stdout); expect(decoded.streams[0].width).toBe(3840); expect(decoded.streams[0].height).toBe(2160); expect(Number(decoded.streams[0].nb_read_frames)).toBeGreaterThan(5);
  await fs.writeFile(path.join(out, `${name}-ffprobe.json`), JSON.stringify(decoded, null, 2)); report.videos.push({ file, playback, receipt, decoded });
  await recorder.getByRole('button', { name: 'Close video recorder', exact: true }).click(); check(`${name}: actual native 3840×2160 orbit recording downloads and decodes`, { file });
}

async function qualifySpecimen() {
  await page.goto(modeUrl('fat'), { waitUntil: 'domcontentloaded' }); await readySpecimen();
  report.graphics = await canvas().evaluate(element => { const gl = element.getContext('webgl2') ?? element.getContext('webgl'), info = gl.getExtension('WEBGL_debug_renderer_info'); return { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) }; });
  await expect(canvas()).toHaveAttribute('data-scene-recording-source', 'native');
  for (const depot of ['visceral', 'omental', 'subcutaneous']) {
    await page.getByLabel('Fat depot', { exact: true }).selectOption(depot); await readySpecimen(); await fit();
    await capture(`specimen-${depot}-fit`);
    for (const [view, dx, dy] of [['reverse', .5, 0], ['low-side', .22, -.13], ['underside', .08, -.32], ['superior', .08, .19]]) {
      await fit(); await orbit(dx, dy); await capture(`specimen-${depot}-${view}`, { cameraMethod: 'Trusted pointer orbit from Fit; view names are descriptive, not calibrated anatomical axes.' });
    }
  }
  check('Three specimen depots captured from fit, reverse, low-side, underside and superior inspection poses');
  if (!baseline) {
    await page.getByLabel('Fat depot', { exact: true }).selectOption('omental'); await readySpecimen(); await fit();
    const stats = (await state()).stats;
    const initialGeometry = glbGeometry(await download('Geometry GLB', 'specimen-initial.glb'));
    const initialMap = hash(await download('color PNG', 'specimen-initial-color.png'));
    const recipe = JSON.parse((await download('Recipe JSON', 'specimen-initial-recipe.json')).toString());
    await button('Shape only').click(); await expect.poll(async () => (await state()).stats.shapeSeed).not.toBe(stats.shapeSeed); await readySpecimen();
    expect(glbGeometry(await download('Geometry GLB', 'specimen-sampled-shape.glb'))).not.toBe(initialGeometry);
    expect(hash(await download('color PNG', 'specimen-shape-only-color.png'))).toBe(initialMap);
    await page.getByLabel('Shape seed', { exact: true }).fill(String(recipe.shapeSeed)); await readySpecimen();
    expect(glbGeometry(await download('Geometry GLB', 'specimen-restored.glb'))).toBe(initialGeometry);
    await button('Texture only').click(); await readySpecimen();
    expect(hash(await download('color PNG', 'specimen-sampled-color.png'))).not.toBe(initialMap);
    expect(glbGeometry(await download('Geometry GLB', 'specimen-texture-only.glb'))).toBe(initialGeometry);
    await page.getByLabel('Texture seed', { exact: true }).fill(String(recipe.textureSeed)); await readySpecimen();
    expect(hash(await download('color PNG', 'specimen-restored-color.png'))).toBe(initialMap);
    check('Independent seeds alter only their intended exported geometry/texture and restore exact binary geometry and PNG bytes');
    const images = new Set(); await fit();
    for (const study of ['color', 'geometry', 'relief', 'tissue']) { await page.getByLabel('Surface study', { exact: true }).selectOption(study); await frames(); expect((await state()).stats).toEqual(stats); images.add((await capture(`specimen-ablation-${study}`)).sha256); }
    expect(images.size).toBe(4);
    for (const lighting of ['surgical', 'grazing', 'backlight', 'dark', 'studio']) { await page.getByLabel('Illumination', { exact: true }).selectOption(lighting); await frames(); await capture(`specimen-light-${lighting}`); }
    await orbit(.12, .05, true); await capture('specimen-trusted-touch-orbit');
    check('Material ablations preserve geometry; five lighting cases and trusted touch orbit captured');
    await page.getByLabel('Texture resolution', { exact: true }).selectOption('4096'); await readySpecimen(4096);
    const png = await download('color PNG', 'specimen-native-color-4096.png'); expect(png.readUInt32BE(16)).toBe(4096); expect(png.readUInt32BE(20)).toBe(4096);
    await fit(); await capture('specimen-native-4k-map'); check('Native 4096² color PNG exported without upscaling');
    if (record) { await page.getByLabel('Illumination', { exact: true }).selectOption('surgical'); await frames(); await recordNative('specimen-native-4k-orbit'); }
    await page.getByLabel('Texture resolution', { exact: true }).selectOption('1024'); await readySpecimen();
    await mobile('fat');
  }
  report.pointerAudit.push({ phase: 'specimen', events: await page.evaluate(() => window.__fatPointerAudit) });
}

async function qualifyScene() {
  await page.goto(modeUrl('scene'), { waitUntil: 'domcontentloaded' }); await readyScene();
  report.graphics ??= await canvas().evaluate(element => { const gl = element.getContext('webgl2') ?? element.getContext('webgl'), info = gl.getExtension('WEBGL_debug_renderer_info'); return { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER) }; });
  await expect(canvas()).toHaveAttribute('data-scene-recording-source', 'native');
  const initial = await state(), signatures = initial.organs.map(organ => [organ.id, organ.geometrySignature]);
  expect(initial.fat.diagnostics.generatedLayers).toBe(3); expect(initial.fat.diagnostics.finite).toBe(true);
  expect(initial.fat.diagnostics.minimumSampledClearanceMm).toBeGreaterThanOrEqual(.6 - 1e-6);
  await button('Abdominal').click(); await readyScene();
  for (const view of views) { await sceneView(view); await capture(`organs-all-${({ '¾ view': 'oblique' })[view] ?? view.toLowerCase()}`); }
  check(`Organ context generates three finite depots with sampled clearances and ${views.length} camera views`);
  if (!baseline) {
    const depotTargets = new Map();
    for (const [depot, focus, omentum, perirenal] of [['omentum', 'Focus omentum', true, false], ['left-perirenal', 'Focus left perirenal fat', false, true], ['right-perirenal', 'Focus right perirenal fat', false, true]]) {
      await page.getByRole('checkbox', { name: 'Omental apron', exact: true }).setChecked(omentum); await page.getByRole('checkbox', { name: 'Perirenal pads', exact: true }).setChecked(perirenal); await readyScene();
      await visibleDepots(omentum, perirenal);
      await button(focus).click(); await readyScene();
      const focusId = depot === 'omentum' ? 'fat-omentum' : `fat-${depot === 'left-perirenal' ? 'left' : 'right'}-kidney-perirenal`;
      await expect.poll(async () => (await state()).camera.focusedOrgan).toBe(focusId);
      await visibleDepots(omentum, perirenal); await readyScene();
      const focused = (await state()).camera.target;
      depotTargets.set(depot, focused);
      for (const view of views) {
        await sceneView(view); expect((await state()).camera.target).toEqual(focused); await capture(`organs-${depot}-${({ '¾ view': 'oblique' })[view] ?? view.toLowerCase()}`);
      }
    }
    await button('Focus omentum').click(); await visibleDepots(true, false); await sceneView('¾ view');
    check(`Each organ depot can be isolated and focused, with focus preserved across ${views.length} camera views`);
    for (const study of ['color', 'geometry', 'relief', 'tissue']) { await page.getByLabel('Fat surface study', { exact: true }).selectOption(study); await expect.poll(async () => (await state()).fat.options.study).toBe(study); await capture(`organs-ablation-${study}`); }
    for (const lighting of ['surgical', 'grazing', 'studio']) { await page.getByLabel('Fat illumination', { exact: true }).selectOption(lighting); await expect.poll(async () => (await state()).fat.options.lighting).toBe(lighting); await capture(`organs-light-${lighting}`); }
    for (const wetness of [0, 1]) { await range('Fat wetness', wetness); await expect.poll(async () => (await state()).fat.options.wetness).toBe(wetness); await capture(`organs-wetness-${wetness}`); }
    await range('Fat wetness', .52);
    await expect.poll(async () => (await state()).fat.options.wetness).toBe(.52);
    const beforeOrbit = await state(); await orbit(.14, .03); const afterOrbit = await state(); expect(afterOrbit.camera.position).not.toEqual(beforeOrbit.camera.position); expect(afterOrbit.fat.diagnostics).toEqual(beforeOrbit.fat.diagnostics);
    expect(afterOrbit.organs.map(organ => [organ.id, organ.geometrySignature])).toEqual(signatures);
    await orbit(.08, -.03, true); await expect.poll(async () => (await state()).camera.position).not.toEqual(afterOrbit.camera.position);
    const pointerEvents = await page.evaluate(() => window.__fatPointerAudit);
    for (const pointerType of ['mouse', 'touch']) expect(pointerEvents.some(event => event.pointerType === pointerType && event.type === 'pointerup' && event.isTrusted)).toBe(true);
    report.pointerAudit.push({ phase: 'scene-orbit-before-reload', events: pointerEvents }); await capture('organs-trusted-touch-orbit');
    expect((await state()).fat.diagnostics).toEqual(beforeOrbit.fat.diagnostics); expect((await state()).organs.map(organ => [organ.id, organ.geometrySignature])).toEqual(signatures);
    check('In-context optical controls and trusted mouse/touch orbit preserve source anatomy and generated-depot diagnostics');
    await page.getByRole('checkbox', { name: 'Experimental fat layers', exact: true }).uncheck(); await expect.poll(async () => (await state()).fat.enabled).toBe(false); expect(page.url()).not.toContain('fat=1'); await capture('organs-fat-disabled');
    await page.getByRole('checkbox', { name: 'Experimental fat layers', exact: true }).check(); await readyScene();
    expect((await state()).fat.diagnostics).toEqual(initial.fat.diagnostics);
    await button('Resample fat layers').click(); await expect.poll(async () => { const s = await state(); return s.fat.status === 'ready' && s.fat.diagnostics.seed !== initial.fat.diagnostics.seed; }, { timeout: 150000 }).toBe(true);
    await capture('organs-resampled'); expect((await state()).organs.map(organ => [organ.id, organ.geometrySignature])).toEqual(signatures);
    await page.getByLabel('Fat seed', { exact: true }).fill(String(initial.fat.options.seed)); await readyScene(initial.fat.options.seed);
    expect((await state()).fat.diagnostics).toEqual(initial.fat.diagnostics); await capture('organs-seed-replayed');
    await page.reload(); await readyScene(initial.fat.options.seed); expect((await state()).fat.diagnostics).toEqual(initial.fat.diagnostics);
    check('Layer visibility/resampling preserves source anatomy; explicit fat seed replay and reload restore initial diagnostics');
    await button('Focus omentum').click(); await visibleDepots(true, false); await sceneView('¾ view');
    expect((await state()).camera.target).toEqual(depotTargets.get('omentum'));
    await page.getByLabel('Fat illumination', { exact: true }).selectOption('surgical'); await expect.poll(async () => (await state()).fat.options.lighting).toBe('surgical');
    await capture('organs-before-native-recording');
    if (record) await recordNative('organ-fat-native-4k-orbit');
    await mobile('scene');
  }
  report.pointerAudit.push({ phase: 'scene', events: await page.evaluate(() => window.__fatPointerAudit) });
}

try {
  if (phase === 'motion') {
    await page.goto(modeUrl('scene'),{waitUntil:'domcontentloaded'});await readyScene();
    await button('Focus omentum').click();await readyScene();await visibleDepots(true,false);await sceneView('¾ view');
    await page.getByLabel('Fat illumination',{exact:true}).selectOption('surgical');await expect.poll(async()=>(await state()).fat.options.lighting).toBe('surgical');
    await capture('organs-before-native-recording');await recordNative('organ-fat-native-4k-orbit');
  } else {
    if (phase !== 'scene') await qualifySpecimen();
    if (phase !== 'specimen') await qualifyScene();
  }
  await page.screenshot({ path: path.join(out, 'final-ui.png'), fullPage: true });
  for (const entry of report.expectedOfflineConsole) expect(report.expectedOfflineProbes.some(probe => probe.url === entry.location.url && probe.status === 404)).toBe(true);
  // Chrome may cancel a preview's outstanding blob range request when the
  // recorder closes or playback seeks. Classify only the exact local URLs
  // whose video passed playback, download and independent ffprobe decoding.
  // Aborted assets, arbitrary blobs and every other network failure still fail.
  const verifiedPreviews = new Set(report.videos.map(video => video.playback.previewUrl).filter(url => url?.startsWith('blob:')));
  report.expectedPreviewAborts = report.failedRequests.filter(request => request.failure === 'net::ERR_ABORTED' && verifiedPreviews.has(request.url));
  report.failedRequests = report.failedRequests.filter(request => !report.expectedPreviewAborts.includes(request));
  expect(report.errors).toEqual([]); expect(report.failedRequests).toEqual([]);
  report.sourceAfter = sources(); report.sourceUnchanged = JSON.stringify(report.sourceAfter) === JSON.stringify(report.sourceBefore);
  if (!baseline) expect(report.sourceUnchanged).toBe(true);
  report.status = 'PASS';
} catch (error) {
  report.failure = error.stack ?? String(error); process.exitCode = 1; console.error(error);
  report.failureState = await state().catch(() => null);
  report.layoutFailure = await page.evaluate(() => ({ width: innerWidth, root: document.documentElement.scrollWidth, clipped: [...document.querySelectorAll('*')].filter(element => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 1).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 100), width: element.clientWidth, scroll: element.scrollWidth })).slice(0, 50) })).catch(() => null);
  await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  report.sourceAfter ??= sources(); report.sourceUnchanged ??= JSON.stringify(report.sourceAfter) === JSON.stringify(report.sourceBefore);
  report.finishedAt = new Date().toISOString(); report.scope = 'Native UI, deterministic exports, anatomical view coverage and optional actual 4K recordings. Rendered evidence requires human visual review; no biological, surgical or photorealism certification.';
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); console.log(JSON.stringify({ out, status: report.status, failure: report.failure, checks: report.checks.length, captures: report.captures.length, videos: report.videos.length }));
}
