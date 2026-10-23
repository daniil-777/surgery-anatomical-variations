/** Exercise the recorded V3 review without starting or modifying the live lab. */
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const output = 'artifacts/fat-quality-v3-2026-10-19';
const url = process.env.FAT_REVIEW_URL ?? `http://127.0.0.1:8817/viscera/${output}/index.html`;
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'darwin' ? {
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-gl=angle', '--use-angle=metal'],
  } : {}),
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript(() => {
  const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
  window.__galleryUrls = { created: [], revoked: [] };
  URL.createObjectURL = blob => {
    const url = create(blob); window.__galleryUrls.created.push(url); return url;
  };
  URL.revokeObjectURL = url => { window.__galleryUrls.revoked.push(url); return revoke(url); };
});
const errors = [];
const videoRequests = [];
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
});
page.on('request', request => {
  if (new URL(request.url()).pathname.endsWith('.webm')) videoRequests.push(request.url());
});

async function imagesReady() {
  await page.waitForFunction(() => [...document.images].every(image =>
    image.complete && image.naturalWidth > 0 && !image.hidden));
}

try {
  await page.goto(url);
  await imagesReady();
  const data = await page.locator('#gallery-data').evaluate(element => JSON.parse(element.textContent));
  assert.equal(data.pairs.length, 18);
  assert.equal(data.studies.length, 33);
  assert.equal(data.videos.length, 5);
  assert.equal(videoRequests.length, 0, 'Recordings must not load before user action');
  for (const pair of data.pairs) {
    await page.locator('#depot').selectOption(pair.depot);
    await page.locator('#seed').selectOption(String(pair.seed));
    await page.locator('#view').selectOption(pair.view);
    await imagesReady();
    assert.equal(await page.locator('#previous-image').getAttribute('src'), pair.previous);
    assert.equal(await page.locator('#final-image').getAttribute('src'), pair.final);
  }
  await page.locator('#pair-next').click();
  assert.equal(await page.locator('#depot').inputValue(), data.pairs[0].depot);
  await page.locator('#pair-prev').click();
  assert.equal(await page.locator('#depot').inputValue(), data.pairs.at(-1).depot);
  for (const study of data.studies) {
    await page.locator('#family').selectOption(study.family);
    await page.locator('#study').selectOption(study.id);
    await imagesReady();
    assert.equal(await page.locator('#study-image').getAttribute('src'), study.file);
    assert.match(await page.locator('#study-details').textContent(), new RegExp(study.sha256));
  }
  const lastStudy = await page.locator('#study').inputValue();
  await page.locator('#study-next').click();
  await page.locator('#study-prev').click();
  assert.equal(await page.locator('#study').inputValue(), lastStudy);

  const videoResults = [];
  for (const video of data.videos) {
    await page.locator('#video-choice').selectOption(video.id);
    assert.equal(await page.locator('#video-player').getAttribute('src'), null);
    assert.equal(await page.evaluate(() => window.__galleryUrls.created.length - window.__galleryUrls.revoked.length), 0);
    assert(await page.locator('#video-cover').isVisible());
    await page.locator('#video-load').click();
    await page.waitForFunction(() => {
      const player = document.querySelector('#video-player');
      return player.readyState >= 2 && player.currentTime > 0.1
        && Number.isFinite(player.duration) && player.duration > 0;
    }, null, { timeout: 30_000 });
    const result = await page.locator('#video-player').evaluate(player => {
      player.pause();
      return { width: player.videoWidth, height: player.videoHeight,
        duration: player.duration, currentTime: player.currentTime, source: player.currentSrc,
        error: player.error?.message ?? null };
    });
    assert.equal(result.width, video.width);
    assert.equal(result.height, video.height);
    assert.equal(result.error, null);
    assert.match(result.source, /^blob:/);
    assert.equal(await page.evaluate(() => window.__galleryUrls.created.length - window.__galleryUrls.revoked.length), 1);
    const seekTarget = result.duration * 0.6;
    await page.locator('#video-player').evaluate((player, target) => { player.currentTime = target; }, seekTarget);
    try {
      await page.waitForFunction(target => {
        const player = document.querySelector('#video-player');
        return !player.seeking && player.readyState >= 2 && Math.abs(player.currentTime - target) < 0.05;
      }, seekTarget);
    } catch (error) {
      const state = await page.locator('#video-player').evaluate(player => ({
        currentTime: player.currentTime, duration: player.duration, seeking: player.seeking,
        readyState: player.readyState, networkState: player.networkState,
        buffered: Array.from({ length: player.buffered.length }, (_, i) => [player.buffered.start(i), player.buffered.end(i)]),
        seekable: Array.from({ length: player.seekable.length }, (_, i) => [player.seekable.start(i), player.seekable.end(i)]),
        error: player.error?.message ?? null,
      }));
      await writeFile(`${output}/gallery-seek-failure.json`, JSON.stringify({ video: video.id, seekTarget, state }, null, 2));
      console.error(JSON.stringify({ video: video.id, seekTarget, state }));
      throw error;
    }
    videoResults.push({ id: video.id, ...result, seekTarget, seekPassed: true });
  }
  // Reload reproduces the selected evidence, but never automatically reloads media.
  const selected = await page.evaluate(() => Object.fromEntries(
    ['depot', 'seed', 'view', 'family', 'study', 'video-choice'].map(id => [id, document.getElementById(id).value])));
  await page.reload();
  await imagesReady();
  for (const [id, value] of Object.entries(selected)) assert.equal(await page.locator(`#${id}`).inputValue(), value);
  assert.equal(await page.locator('#video-player').getAttribute('src'), null);

  const reports = await page.locator('#report-grid a').evaluateAll(links => links.map(link => link.href));
  for (const report of reports) {
    const response = await page.request.get(report);
    assert.equal(response.ok(), true, `Report unavailable: ${report}`);
    await response.dispose();
  }
  await page.locator('#depot').selectOption('omental');
  await page.locator('#seed').selectOption('42');
  await page.locator('#view').selectOption('front');
  await page.locator('#family').selectOption('thickness-drape');
  await page.locator('#study').selectOption('sheet-t4-d32');
  await page.locator('#video-choice').selectOption('omental-orbit');
  await imagesReady();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `${output}/gallery-desktop.png`, fullPage: true });
  const widths = [390, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Overflow at ${width}px`);
    await page.screenshot({ path: `${output}/gallery-${width}.png`, fullPage: true });
  }
  await page.keyboard.press('Control+Home');
  await page.locator('.skip').focus();
  assert(await page.locator('.skip').evaluate(element => element.getBoundingClientRect().top >= 0));
  assert.deepEqual(errors, []);
  const receipt = { passed: true, pairedViews: data.pairs.length, studies: data.studies.length,
    videos: videoResults, reportLinks: reports.length, noAutoload: true, deepLinkRestore: true,
    mobileWidths: widths, skipLink: true, singleVideoObjectUrl: true, errors };
  await writeFile(`${output}/gallery-check.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
}
