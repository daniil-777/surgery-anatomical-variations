// Check the public entrance against the exact installed browser release.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) =>
  index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []));
const base = options.url || 'http://127.0.0.1:5190';
const out = path.resolve(options.out || 'artifacts/studio-welcome');
fs.mkdirSync(out, { recursive: true });
const results = [], errors = [];
const pass = name => { results.push(name); console.log('PASS', name); };
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--use-angle=metal'],
});
try {
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/auth/login?next=' + encodeURIComponent('/?mode=scene&scene=virtamed'));
  await page.waitForFunction(() => [...document.querySelectorAll('.study img')].length === 4 &&
    [...document.querySelectorAll('.study img')].every(img => img.complete && img.naturalWidth));
  assert.equal(await page.locator('input').count(), 0);
  assert.equal(await page.locator('script[src$="login.js"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Welcome', exact: true }).count(), 1);
  assert.equal(await page.locator('.study img[src$=".gif"]').count(), 0);
  pass('Welcome replaces username/password; reduced-motion gallery loads');
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const bounds = await page.locator('#welcome-button').boundingBox();
    assert(bounds.width >= 44 && bounds.height >= 44);
    await page.screenshot({ path: path.join(out, `welcome-${width}.png`), fullPage: true });
    pass(`Responsive layout ${width}×${height}`);
  }
  await page.getByRole('link', { name: 'Jump to Welcome' }).click();
  await page.locator('#welcome-button').focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert.notEqual(await page.locator('#welcome-button').evaluate(el => getComputedStyle(el).outlineStyle), 'none');
  const buttonBounds = await page.locator('#welcome-button').boundingBox();
  assert(buttonBounds.y >= 0 && buttonBounds.y + buttonBounds.height <= 740);
  pass('Mobile shortcut and visible keyboard focus');
  await page.route('**/auth/enter?*', route => route.fulfill({ status: 503, body: 'Unavailable' }));
  await page.keyboard.press('Enter');
  await page.getByText('The studio could not be reached. Please try again.').waitFor();
  assert(await page.getByRole('button', { name: 'Welcome', exact: true }).isEnabled());
  await page.unroute('**/auth/enter?*');
  pass('Unavailable entry shows retry feedback and restores the button');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#welcome-button').focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('scene') === 'virtamed');
  await page.locator('canvas').first().waitFor({ timeout: 120000 });
  const session = await (await context.request.get(base + '/auth/session')).json();
  assert.equal(session.user, 'Visitor');
  assert.equal((await context.request.get(base + '/anatomy-scene/virtamed-scene.glb')).status(), 200);
  await page.screenshot({ path: path.join(out, 'studio-entered.png'), fullPage: true });
  pass('Keyboard Welcome enters the requested 3D workspace with no credentials');
  await page.reload();
  await page.locator('canvas').first().waitFor({ timeout: 120000 });
  assert(!page.url().includes('/auth/login'));
  pass('Studio refresh retains visitor access');
  await page.getByRole('button', { name: 'Sign out of studio', exact: true }).click();
  await page.getByRole('button', { name: 'Welcome', exact: true }).waitFor();
  assert.equal(await page.locator('input').count(), 0);
  assert.equal((await context.request.get(base + '/auth/session')).status(), 401);
  pass('Leaving returns to Welcome without a login form');
  assert.deepEqual(errors, []);
  await context.close();
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  await browser.close();
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, errors, passed: !process.exitCode }, null, 2));
}
