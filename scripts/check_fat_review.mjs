import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true,
  ...(process.platform === 'darwin' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-gl=angle', '--use-angle=metal'] } : {}) });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
try {
  await page.goto('http://127.0.0.1:8817/viscera/artifacts/fat-quality-2026-10-19/index.html');
  async function imagesReady() {
    await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  }
  await imagesReady();
  for (const depot of ['visceral', 'omental', 'subcutaneous']) {
    await page.locator('#depot').selectOption(depot);
    for (const seed of ['0', '42', '4294967295']) {
      await page.locator('#seed').selectOption(seed);
      for (const view of ['front', 'reverse']) { await page.locator('#view').selectOption(view); await imagesReady(); }
    }
  }
  for (const diagnostic of ['ablation-tissue', 'ablation-color', 'ablation-relief', 'ablation-geometry', 'light-surgical', 'light-grazing', 'resolution-4096']) {
    await page.locator('#diagnostic').selectOption(diagnostic); await imagesReady();
  }
  for (const motion of ['orbit', 'compression']) {
    await page.locator('#motion').selectOption(motion);
    await page.waitForFunction(() => [...document.querySelectorAll('video')].every(video => video.readyState >= 1 && video.duration > 0));
    await page.locator('#play').click(); await page.waitForTimeout(700);
    assert(await page.locator('#newVideo').evaluate(video => video.currentTime > 0));
  }
  await page.locator('#depot').selectOption('visceral'); await page.locator('#seed').selectOption('42'); await page.locator('#view').selectOption('front');
  await page.evaluate(() => scrollTo(0, 0)); await imagesReady();
  await page.screenshot({ path: 'artifacts/fat-quality-2026-10-19/gallery-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: 'artifacts/fat-quality-2026-10-19/gallery-mobile.png' });
  assert.deepEqual(errors, []);
  await writeFile('artifacts/fat-quality-2026-10-19/gallery-check.json', JSON.stringify({ passed: true, pairedViews: 18, diagnostics: 7, videoPairs: 2, mobileWidth: 390, errors }, null, 2));
  console.log('Gallery: 18 paired views, 7 diagnostics, 2 video pairs, mobile layout passed.');
} finally { await browser.close(); }
