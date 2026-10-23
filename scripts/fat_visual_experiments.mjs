/** Reproducible browser experiments. No screenshot similarity is called biological accuracy. */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const stage = process.env.FAT_EXPERIMENT_STAGE ?? 'candidate';
const base = process.env.FAT_EXPERIMENT_URL ?? 'http://127.0.0.1:5174';
const root = path.resolve(process.env.FAT_EXPERIMENT_ROOT ?? 'artifacts/fat-quality-2026-10-19', stage);
await mkdir(root, { recursive: true });
const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle', '--use-angle=metal'] } : {}) });
const observations = { stage, base, startedAt: new Date().toISOString(), cases: [], errors: [], optionalProbes: [], videos: [] };
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
const page = await context.newPage();
function monitor(p) {
  p.on('pageerror', e => observations.errors.push(e.message));
  p.on('response', r => { if(r.status() >= 400) { const message=`${r.status()} ${r.url()}`; if(r.status() === 404 && new URL(r.url()).pathname.endsWith("/api.json")) observations.optionalProbes.push(message); else observations.errors.push(message); } });
  p.on('console', e => { if (e.type() === 'error' && !e.text().includes("Failed to load resource")) observations.errors.push(e.text()); });
}
monitor(page);
const host = p => p.locator('[data-fat-ready="true"]');
async function ready(p, resolution = 1024) {
  await p.waitForFunction(r => {
    const e = document.querySelector('[data-fat-ready="true"]');
    return e && JSON.parse(e.dataset.fatSnapshot).textureResolution === r && !document.querySelector('.fat-baking');
  }, resolution, { timeout: 90000 });
  if (await p.getByRole('alert').count()) throw new Error(await p.getByRole('alert').innerText());
}
async function capture(name, data = {}) {
  await page.screenshot({ path: path.join(root, `${name}.png`) });
  observations.cases.push({ name, ...data, snapshot: JSON.parse(await host(page).getAttribute('data-fat-snapshot')) });
}
try {
  await page.goto(`${base}/?mode=fat`); await ready(page);
  if (process.env.FAT_EXPERIMENT_PHASE !== 'video') {
    for (const depot of ['visceral', 'omental', 'subcutaneous']) {
      await page.getByLabel('Fat depot', { exact: true }).selectOption(depot);
      for (const seed of [0, 42, 4294967295]) {
        await page.getByLabel('Shape seed', { exact: true }).fill(String(seed));
        await page.getByLabel('Texture seed', { exact: true }).fill('731');
        await ready(page); await page.getByRole('button', { name: 'Fit fat specimen', exact: true }).click();
        await page.waitForTimeout(250);
        await capture(`${depot}-${seed}-front`, { depot, seed, view: 'default' });
        const box = await page.locator('.fat-viewport canvas').boundingBox();
        await page.mouse.move(box.x + box.width * .65, box.y + box.height * .55);
        await page.mouse.down(); await page.mouse.move(box.x + box.width * .22, box.y + box.height * .4, { steps: 24 }); await page.mouse.up();
        await page.waitForTimeout(600);
        await capture(`${depot}-${seed}-reverse`, { depot, seed, view: 'reverse' });
      }
    }
    await page.getByLabel('Fat depot', { exact: true }).selectOption('visceral');
    await page.getByLabel('Shape seed', { exact: true }).fill('42');
    await ready(page); await page.getByRole('button', { name: 'Fit fat specimen', exact: true }).click();
    if (await page.getByLabel('Surface study', { exact: true }).count()) {
      for (const surface of ['tissue', 'color', 'relief', 'geometry']) {
        await page.getByLabel('Surface study', { exact: true }).selectOption(surface);
        await page.waitForTimeout(300); await capture(`ablation-${surface}`, { surface });
      }
      await page.getByLabel('Surface study', { exact: true }).selectOption('tissue');
      for (const lighting of ['studio', 'surgical', 'grazing']) {
        await page.getByLabel('Illumination', { exact: true }).selectOption(lighting);
        await page.waitForTimeout(300); await capture(`light-${lighting}`, { lighting });
      }
      await page.getByLabel('Illumination', { exact: true }).selectOption('studio');
    }
    for (const resolution of [512, 4096]) {
      await page.getByLabel('Texture resolution', { exact: true }).selectOption(String(resolution)); await ready(page, resolution);
      await capture(`resolution-${resolution}`, { resolution });
    }
  }
  if (process.env.FAT_EXPERIMENT_PHASE !== 'still') {
    for (const experiment of ['orbit', 'compression']) {
      const videoContext = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
      const p = await videoContext.newPage(); monitor(p); await p.goto(`${base}/?mode=fat`); await ready(p);
      await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await p.evaluate(() => {
        const stream = document.querySelector('.fat-viewport canvas').captureStream(30);
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 8000000 });
        const chunks = [];
        window.__fatRecordingResult = new Promise(resolve => {
          recorder.ondataavailable = e => { if(e.data.size) chunks.push(e.data); };
          recorder.onstop = () => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(new Blob(chunks,{type:'video/webm'})); stream.getTracks().forEach(track=>track.stop()); };
        });
        window.__fatRecorder = recorder; recorder.start();
      });
      await p.evaluate(() => { window.__fatFrameTimes = []; let last = performance.now();
        function tick(t) { window.__fatFrameTimes.push(t - last); last = t; requestAnimationFrame(tick); } requestAnimationFrame(tick); });
      const frames = [];
      if (experiment === 'orbit') {
        const box = await p.locator('.fat-viewport canvas').boundingBox();
        for (let i = 0; i < 24; i++) {
          await p.mouse.move(box.x + box.width * .55, box.y + box.height * .5); await p.mouse.down();
          await p.mouse.move(box.x + box.width * .55 - box.height / 24, box.y + box.height * .5, { steps: 8 }); await p.mouse.up();
          await p.waitForTimeout(240);
          if (i % 3 === 0) { await p.screenshot({ path: path.join(root, `orbit-frame-${i}.png`) }); frames.push(i); }
        }
      } else {
        await p.getByRole('tab', { name: 'Mechanics', exact: true }).click();
        await p.getByLabel('Loading time', { exact: true }).fill('2');
        await p.getByLabel('Hold duration', { exact: true }).fill('2');
        await p.getByRole('button', { name: 'Play experiment', exact: true }).click();
        for (let i = 0; i < 10; i++) {
          await p.waitForTimeout(800);
          await p.screenshot({ path: path.join(root, `compression-frame-${i}.png`) });
          frames.push({ index: i, snapshot: JSON.parse(await host(p).getAttribute('data-fat-snapshot')) });
        }
      }
      const times = await p.evaluate(() => window.__fatFrameTimes);
      const file = path.join(root, `${experiment}.webm`);
      const encoded = await p.evaluate(async () => { window.__fatRecorder.stop(); return await window.__fatRecordingResult; });
      await writeFile(file,Buffer.from(encoded,'base64')); await videoContext.close();
      observations.videos.push({ experiment, file: path.basename(file), frameTimesMs: times, frames });
    }
  }
} finally {
  observations.finishedAt = new Date().toISOString();
  await writeFile(path.join(root, 'observations.json'), JSON.stringify(observations, null, 2));
  await browser.close();
}
if (observations.errors.length) throw new Error(JSON.stringify(observations.errors));
console.log(JSON.stringify({ stage, images: observations.cases.length, videos: observations.videos.length, errors: observations.errors.length }));
