/** Reproducible rendered-canvas studies; images are evidence, not biological validation.
 * FAT_EXPERIMENT_STAGE=candidate-01 FAT_EXPERIMENT_PHASE=all node scripts/fat_v3_experiments.mjs
 * Phase can be all/still/video. Existing phase reports are never overwritten.
 */
import { chromium } from '@playwright/test';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const stage = process.env.FAT_EXPERIMENT_STAGE ?? 'candidate-01';
const phase = process.env.FAT_EXPERIMENT_PHASE ?? 'all';
if (!/^[a-z0-9][a-z0-9_-]*$/i.test(stage)) throw new Error('Use a simple unique stage name.');
if (!['all', 'still', 'video'].includes(phase)) throw new Error('FAT_EXPERIMENT_PHASE must be all, still or video.');
const base = process.env.FAT_EXPERIMENT_URL ?? 'http://127.0.0.1:5174';
const root = path.resolve(process.env.FAT_EXPERIMENT_ROOT ?? 'artifacts/fat-quality-v3-2026-10-19', stage);
const reportFile = path.join(root, `${phase}-observations.json`);
await mkdir(root, { recursive: true });
try { await access(reportFile); throw new Error(`${reportFile} already exists; use a new stage to preserve evidence.`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const hash = data => createHash('sha256').update(data).digest('hex');
const sourceFiles = ['generator.ts', 'material.ts', 'optics.ts', 'texture.ts', 'texture.worker.ts', 'physics.ts', 'mechanicsExperiments.ts', 'FatLab.tsx', 'FatViewport.tsx', 'fatLab.css'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async file => {
  try { return [file, hash(await readFile(path.join('apps/studio/src/fat', file)))]; }
  catch (error) { if (error.code === 'ENOENT') return [file, null]; throw error; }
})));
const observations = {
  stage, phase, base, startedAt: new Date().toISOString(), sourceHashes: await sourceHashes(),
  scope: 'Procedural appearance and homogeneous coupon numerical behavior. No patient/tissue validation or local contact solve.',
  stillCaptureMethod: 'Raw rendered WebGL canvas.toDataURL PNG, excluding DOM overlays; lab-context.png includes the full interface.',
  videoCaptureMethod: 'VP9 MediaRecorder over canvas.captureStream(30); actual decoded cadence is measured with ffprobe.',
  cases: [], videos: [], errors: [], optionalProbes: [],
};
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle', '--use-angle=metal'] } : {}) });

function monitor(page) {
  page.on('pageerror', error => observations.errors.push(error.message));
  page.on('response', response => {
    if (response.status() < 400) return;
    const message = `${response.status()} ${response.url()}`;
    if (response.status() === 404 && new URL(response.url()).pathname.endsWith('/api.json')) observations.optionalProbes.push(message);
    else observations.errors.push(message);
  });
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) observations.errors.push(message.text());
  });
}

const canvas = page => page.locator('.fat-viewport canvas');
async function rendered(page, resolution = 1024) {
  // Give React/effects a browser frame before inspecting the asynchronous bake.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(expected => {
    const host = document.querySelector('[data-fat-ready="true"]');
    return host && JSON.parse(host.dataset.fatSnapshot).textureResolution === expected && !document.querySelector('.fat-baking');
  }, resolution, { timeout: 120000 });
  if (await page.getByRole('alert').count()) throw new Error(await page.getByRole('alert').innerText());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function snapshot(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-fat-ready="true"]'), canvas = host.querySelector('canvas');
    return {
      wallTimeMs: performance.now(), viewport: JSON.parse(host.dataset.fatSnapshot),
      canvas: { width: canvas.width, height: canvas.height, clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight, devicePixelRatio },
      controls: Object.fromEntries([...document.querySelectorAll('.fat-panel input[aria-label], .fat-panel select[aria-label]')].map(input => [input.getAttribute('aria-label'), input.type === 'checkbox' ? input.checked : input.value])),
      experimentReadout: document.querySelector('input[aria-label="Experiment time"]')?.closest('label')?.querySelector('output')?.textContent ?? null,
    };
  });
}

async function writeCapture(page, name, data = {}) {
  const file = `${name}.png`;
  const encoded = await canvas(page).evaluate(element => element.toDataURL('image/png').split(',')[1]);
  const pixels = Buffer.from(encoded, 'base64');
  await writeFile(path.join(root, file), pixels);
  const result = { name, file, sha256: hash(pixels), bytes: pixels.byteLength, ...data, snapshot: await snapshot(page) };
  observations.cases.push(result);
  return result;
}

async function range(page, label, value) {
  const control = page.getByLabel(label, { exact: true });
  // Playwright fill does not accept range inputs; native setter plus the normal
  // input/change events exercises the same React handlers as pointer interaction.
  await control.evaluate((input, requested) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(requested));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function fit(page) {
  await page.getByRole('button', { name: 'Fit fat specimen', exact: true }).click();
  await page.waitForTimeout(200);
}

async function open(viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage(); monitor(page);
  await page.goto(`${base}/?mode=fat`); await rendered(page);
  return { context, page };
}

async function stillMatrix() {
  const { context, page } = await open({ width: 1440, height: 1000 });
  try {
    await page.screenshot({ path: path.join(root, 'lab-context.png') });
    for (const depot of ['visceral', 'omental', 'subcutaneous']) {
      await page.getByLabel('Fat depot', { exact: true }).selectOption(depot);
      await page.getByLabel('Shape seed', { exact: true }).fill('42');
      for (const textureSeed of [0, 42, 4294967295]) {
        await page.getByLabel('Texture seed', { exact: true }).fill(String(textureSeed));
        await rendered(page); await fit(page);
        await writeCapture(page, `texture-${depot}-${textureSeed}`, { family: 'independent-texture-seed', depot, shapeSeed: 42, textureSeed });
      }
    }
    await page.getByLabel('Fat depot', { exact: true }).selectOption('omental');
    await page.getByLabel('Texture seed', { exact: true }).fill('731');
    for (const thicknessMm of [0.5, 4, 12]) for (const drapeMm of [0, 32, 80]) {
      await range(page, 'Sheet thickness', thicknessMm); await range(page, 'Fold depth', drapeMm);
      await rendered(page); await fit(page);
      await writeCapture(page, `sheet-t${thicknessMm}-d${drapeMm}`, { family: 'thickness-drape', thicknessMm, drapeMm });
    }
    await range(page, 'Sheet thickness', 0.5); await range(page, 'Fold depth', 32); await rendered(page); await fit(page);
    for (const lighting of ['backlight', 'dark']) for (const scattering of [0, 0.5, 1]) {
      await page.getByLabel('Illumination', { exact: true }).selectOption(lighting); await range(page, 'Diffuse scattering', scattering);
      await rendered(page);
      await writeCapture(page, `optics-${lighting}-s${scattering}`, { family: 'scattering-ablation', lighting, scattering, thicknessMm: 0.5 });
    }
    await page.getByLabel('Illumination', { exact: true }).selectOption('studio'); await range(page, 'Diffuse scattering', 0.5);
    await page.getByLabel('Fat depot', { exact: true }).selectOption('visceral'); await rendered(page); await fit(page);
    const controls = [
      { label: 'Surface lobule scale', key: 'lobule-scale', values: [0.4, 1, 2.5], baseline: 1 },
      { label: 'Connective septa', key: 'septa', values: [0, 1, 2], baseline: 1 },
      { label: 'Vessel visibility', key: 'vessels', values: [0, 0.5, 2], baseline: 0.5 },
    ];
    for (const control of controls) {
      for (const value of control.values) {
        await range(page, control.label, value); await rendered(page);
        await writeCapture(page, `surface-${control.key}-${value}`, { family: 'surface-parameter', control: control.label, value });
      }
      await range(page, control.label, control.baseline); await rendered(page);
    }
  } finally { await context.close(); }
}

async function startRecording(page, bitrate) {
  return page.evaluate(bits => {
    const canvas = document.querySelector('.fat-viewport canvas');
    const requestedMime = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(requestedMime)) throw new Error('VP9 canvas recording is unavailable in this browser.');
    const stream = canvas.captureStream(30), recorder = new MediaRecorder(stream, { mimeType: requestedMime, videoBitsPerSecond: bits });
    const chunks = [], times = [], startedAt = performance.now();
    const state = { recorder, stream, times, startedAt, active: true };
    function tick(time) { if (!state.active) return; times.push(time); requestAnimationFrame(tick); } requestAnimationFrame(tick);
    state.result = new Promise((resolve, reject) => {
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onerror = event => reject(new Error(event.error?.message ?? 'MediaRecorder failure'));
      recorder.onstop = () => {
        state.active = false;
        const reader = new FileReader(); reader.onerror = () => reject(reader.error);
        reader.onload = () => resolve({ encoded: reader.result.split(',')[1], rafTimesMs: times.map(time => time - startedAt), durationMs: performance.now() - startedAt,
          mimeType: recorder.mimeType, requestedCaptureFps: 30, requestedBitrate: bits, trackSettings: stream.getVideoTracks()[0]?.getSettings() });
        reader.readAsDataURL(new Blob(chunks, { type: recorder.mimeType })); stream.getTracks().forEach(track => track.stop());
      };
    });
    window.__fatV3Recording = state; recorder.start(1000);
    return { width: canvas.width, height: canvas.height, mimeType: recorder.mimeType, recordingStartedAtMs: startedAt, trackSettings: stream.getVideoTracks()[0].getSettings() };
  }, bitrate);
}

function decodedVideoMetadata(file) {
  try {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,r_frame_rate:format=duration:frame=best_effort_timestamp_time,pkt_duration_time', '-show_frames', '-of', 'json', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
    const timestampsSec = probe.frames.map(frame => Number(frame.best_effort_timestamp_time)).filter(Number.isFinite);
    const intervals = timestampsSec.slice(1).map((time, i) => time - timestampsSec[i]);
    const sorted = [...intervals].sort((a, b) => a - b);
    return { streams: probe.streams, format: probe.format, decodedFrames: timestampsSec.length, timestampsSec,
      measuredAverageFps: timestampsSec.length > 1 ? (timestampsSec.length - 1) / (timestampsSec.at(-1) - timestampsSec[0]) : null,
      medianFrameIntervalSec: sorted[Math.floor(sorted.length / 2)] ?? null, maximumFrameIntervalSec: sorted.at(-1) ?? null };
  } catch (error) { return { unavailable: String(error), note: 'rAF timings are reported separately and do not establish encoded video cadence.' }; }
}

async function decodeReviewFrames(experiment, file, frames, cadence, recordingStartedAtMs) {
  if (!cadence.timestampsSec?.length) return frames.map(frame => ({ ...frame, note: 'Decoded PNG unavailable; review the original video. Metadata snapshot only.' }));
  const indices = frames.map(frame => {
    const requestedSec = (frame.snapshot.wallTimeMs - recordingStartedAtMs) / 1000;
    let best = 0;
    cadence.timestampsSec.forEach((time, index) => { if (Math.abs(time - requestedSec) < Math.abs(cadence.timestampsSec[best] - requestedSec)) best = index; });
    return best;
  });
  const uniqueIndices = [...new Set(indices)].sort((a, b) => a - b);
  const temporaryPattern = path.join(root, `.decode-${experiment}-%03d.png`);
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=${uniqueIndices.map(index => `eq(n\\,${index})`).join('+')}`,
    '-fps_mode', 'vfr', '-frames:v', String(uniqueIndices.length), temporaryPattern], { stdio: 'pipe', maxBuffer: 1024 * 1024 });
  const decodedFiles = new Map();
  for (let i = 0; i < uniqueIndices.length; i++) {
    const name = `${experiment}-decoded-${String(uniqueIndices[i]).padStart(4, '0')}.png`;
    await rename(path.join(root, `.decode-${experiment}-${String(i + 1).padStart(3, '0')}.png`), path.join(root, name));
    const pixels = await readFile(path.join(root, name));
    decodedFiles.set(uniqueIndices[i], { file: name, sha256: hash(pixels), bytes: pixels.byteLength });
  }
  return frames.map((frame, i) => ({ ...frame, ...decodedFiles.get(indices[i]), captureType: 'decoded-actual-VP9-frame',
    decodedFrameIndex: indices[i], recordedTimestampSec: cadence.timestampsSec[indices[i]],
    snapshotTimestampSec: (frame.snapshot.wallTimeMs - recordingStartedAtMs) / 1000 }));
}

async function videoExperiment(experiment) {
  const fourK = experiment === 'omental-orbit';
  const { context, page } = await open(fourK ? { width: 4210, height: 2264 } : { width: 1200, height: 900 });
  try {
    await page.getByLabel('Fat depot', { exact: true }).selectOption(fourK || experiment === 'moving-light' ? 'omental' : 'visceral');
    const resolution = fourK ? 4096 : experiment === 'zoom-mips' || experiment === 'moving-light' ? 2048 : 1024;
    if (fourK) { await range(page, 'Sheet thickness', 4); await range(page, 'Fold depth', 32); }
    await page.getByLabel('Texture resolution', { exact: true }).selectOption(String(resolution)); await rendered(page, resolution); await fit(page);
    if (fourK) {
      const current = await snapshot(page);
      if (current.canvas.width !== 3840 || current.canvas.height !== 2160) {
        await page.setViewportSize({ width: 4210 + 3840 - current.canvas.width, height: 2264 + 2160 - current.canvas.height });
        await rendered(page, resolution);
      }
    }
    if (experiment === 'creep' || experiment === 'stress-cyclic') {
      await page.getByRole('tab', { name: 'Mechanics', exact: true }).click();
      await page.getByLabel('Experiment', { exact: true }).selectOption(experiment);
      await range(page, 'Loading time', 1); await range(page, 'Hold duration', 4); await range(page, 'Nominal load', 1.5);
      await rendered(page, resolution);
    }
    if (experiment === 'moving-light') {
      await range(page, 'Sheet thickness', 4); await range(page, 'Fold depth', 32);
      await page.getByLabel('Illumination', { exact: true }).selectOption('studio');
      await page.getByLabel('Moving studio light', { exact: true }).check();
      await rendered(page, resolution); await fit(page);
    }
    const initial = await snapshot(page);
    if (fourK && (initial.canvas.width !== 3840 || initial.canvas.height !== 2160)) throw new Error(`Expected true 3840×2160 canvas, got ${JSON.stringify(initial.canvas)}.`);
    const recording = await startRecording(page, fourK ? 24_000_000 : 8_000_000);
    const frames = [], startedAt = Date.now(), durationMs = experiment === 'stress-cyclic' ? 12500 : 10500;
    if (experiment === 'creep' || experiment === 'stress-cyclic') await page.getByRole('button', { name: 'Play experiment', exact: true }).click();
    const box = await canvas(page).boundingBox();
    let nextFrameAt = 0, iteration = 0, backlightEnabled = false;
    while (Date.now() - startedAt < durationMs) {
      if (experiment === 'omental-orbit') {
        if (!backlightEnabled && Date.now() - startedAt > durationMs * 0.7) {
          await page.getByLabel('Illumination', { exact: true }).selectOption('backlight'); backlightEnabled = true;
        }
        await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.55); await page.mouse.down();
        await page.mouse.move(box.x + box.width * 0.6 - box.height / 45, box.y + box.height * 0.55, { steps: 6 }); await page.mouse.up();
      } else if (experiment === 'zoom-mips') {
        await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await page.mouse.wheel(0, Date.now() - startedAt < durationMs * 0.5 ? -45 : 45);
      }
      if (Date.now() - startedAt >= nextFrameAt) {
        const name = `${experiment}-frame-${String(iteration++).padStart(2, '0')}`;
        // Avoid expensive synchronous PNG readback during motion. Review PNGs
        // are decoded from the recorded stream afterward, with exact timestamps.
        frames.push({ name, family: 'video-frame', experiment, elapsedMs: Date.now() - startedAt, snapshot: await snapshot(page) }); nextFrameAt += 2000;
      }
      await page.waitForTimeout(100);
    }
    const final = await snapshot(page);
    const encoded = await page.evaluate(async () => { window.__fatV3Recording.recorder.stop(); return await window.__fatV3Recording.result; });
    const pixels = Buffer.from(encoded.encoded, 'base64'), file = `${experiment}.webm`;
    await writeFile(path.join(root, file), pixels);
    const { encoded: omitted, ...recordingTiming } = encoded;
    const cadence = decodedVideoMetadata(path.join(root, file));
    const decodedFrames = await decodeReviewFrames(experiment, path.join(root, file), frames, cadence, recording.recordingStartedAtMs);
    observations.cases.push(...decodedFrames);
    const video = { experiment, file, sha256: hash(pixels), bytes: pixels.byteLength, initial, final, recording, recordingTiming,
      cadence, frames: decodedFrames };
    observations.videos.push(video);
    await writeFile(path.join(root, `${experiment}-metadata.json`), JSON.stringify(video, null, 2));
  } finally { await context.close(); }
}

try {
  if (phase !== 'video') await stillMatrix();
  if (phase !== 'still') for (const experiment of ['omental-orbit', 'creep', 'stress-cyclic', 'zoom-mips', 'moving-light']) await videoExperiment(experiment);
} catch (error) {
  observations.errors.push(String(error)); throw error;
} finally {
  observations.finishedAt = new Date().toISOString(); observations.finalSourceHashes = await sourceHashes();
  observations.sourcesChangedDuringCapture = JSON.stringify(observations.sourceHashes) !== JSON.stringify(observations.finalSourceHashes);
  await writeFile(reportFile, JSON.stringify(observations, null, 2)); await browser.close();
}
if (observations.errors.length) throw new Error(JSON.stringify(observations.errors));
console.log(JSON.stringify({ stage, phase, images: observations.cases.length, videos: observations.videos.length, errors: observations.errors.length, sourcesChangedDuringCapture: observations.sourcesChangedDuringCapture }));
