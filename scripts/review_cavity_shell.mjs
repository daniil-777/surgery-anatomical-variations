/** Public-UI cavity review. Screenshots and video are unmodified browser output.
 * Run against a built site: REVIEW_URL=http://127.0.0.1:5177/ node scripts/review_cavity_shell.mjs
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve(process.env.CAVITY_REVIEW_OUTPUT ?? '/tmp/viscera-cavity-review');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--use-angle=metal'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1.5, recordVideo: { dir: path.join(out, 'motion'), size: { width: 1600, height: 1100 } } });
const page = await context.newPage(), errors = [], requests = [], cases = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', message => { if (message.type() === 'error' && /WebGL|Shader|THREE/.test(message.text())) errors.push(message.text()); });
page.on('response', response => { if (response.status() >= 400) requests.push({ status: response.status(), url: response.url() }); });
const read = () => page.evaluate(() => JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const click = async name => { await page.getByRole('button', { name, exact: true }).click(); await settle(); };
const capture = async name => {
  await settle();
  const snapshot = await read();
  if (!snapshot.ready || !snapshot.camera.position.every(Number.isFinite) || !snapshot.organs.find(o => o.id === 'abdominal-wall')?.visible) throw new Error(`Invalid cavity state: ${name}`);
  // Full-viewport capture does not temporarily clip/reposition the WebGL layer
  // in Chromium's simultaneous video stream, unlike element screenshots.
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  cases.push({ name, snapshot });
};
const turn = async (direction, steps) => { for (let i = 0; i < steps; i++) await click(`Look ${direction}`); };
const reset = () => click('Reset inspection camera');

try {
  const url = new URL(process.env.REVIEW_URL ?? 'http://127.0.0.1:5177/');
  url.searchParams.set('mode', 'scene'); url.searchParams.set('scene', 'virtamed');
  await page.goto(url.href);
  await page.waitForFunction(() => document.querySelector('[data-scene-ready="true"]'), { timeout: 120000 });
  await capture('01-white-operative');
  await click('Apply learned textures'); await capture('02-tissue-operative');
  const canvas = page.locator('.whole-scene-canvas canvas'), box = await canvas.boundingBox();
  for (const [name, dx, dy] of [['03-operative-left', 65, 12], ['04-operative-right', -65, -12]]) {
    await click('Video camera · instruments enabled');
    await page.mouse.move(box.x + box.width * .65, box.y + box.height * .48);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * .65 + dx, box.y + box.height * .48 + dy, { steps: 16 }); await page.mouse.up();
    await page.waitForTimeout(600); await capture(name);
  }
  await click('Video camera · instruments enabled');
  await click('Explore cavity');
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation.mode === 'explore');
  await capture('05-inside-field');
  for (const [name, direction, steps] of [['06-inside-left', 'left', 7], ['07-inside-right', 'right', 7], ['08-inside-superior', 'up', 6], ['09-inside-inferior', 'down', 5], ['10-inside-anterior', 'left', 18]]) {
    await reset(); await turn(direction, steps); await capture(name);
  }
  // The camera is now directed toward the anterior dome. Exercise the actual
  // navigation barrier, then retreat for an inspectable close view.
  let blocked = false;
  for (let step = 0; step < 60; step++) {
    await click('Move camera forward');
    const navigation = (await read()).camera.navigation;
    if (navigation.blocked) {
      if (navigation.blockedBy !== 'abdominal-wall') throw new Error(`Anterior wall approach blocked by ${navigation.blockedBy}`);
      blocked = true; break;
    }
  }
  if (!blocked) throw new Error('Camera escaped the anterior cavity without a wall collision');
  const atWall = await read();
  await click('Move camera forward');
  const stopped = await read();
  if (Math.hypot(...stopped.camera.position.map((v, i) => v - atWall.camera.position[i])) > .1) throw new Error('Camera tunneled through the cavity after contact');
  await capture('11-anterior-clearance-stop');
  for (let i = 0; i < 5; i++) await click('Move camera back');
  await capture('12-anterior-close');
  const insidePose = await read();
  await click('Use this view for instruments');
  const retainedPose = await read();
  if (retainedPose.camera.navigation.mode !== 'orbit' || Math.hypot(...retainedPose.camera.position.map((v, i) => v - insidePose.camera.position[i])) > .01) throw new Error('Instrument handoff lost the chosen interior camera');
  await capture('13-anterior-instrument-view');
  await click('Video camera · instruments enabled');
  await click('Fit whole scene');
  for (const [name, view] of [['14-external-front-cutaway', 'Front'], ['15-external-oblique-cutaway', '¾ view'], ['16-external-back-cutaway', 'Back']]) {
    await page.locator('.whole-view-bar').getByRole('button', { name: view, exact: true }).click();
    await page.waitForTimeout(700); await capture(name);
  }
  const apiProbes = requests.filter(r => /\/api\/(health|atlas\/reference-material\/status)$/.test(new URL(r.url).pathname));
  const assetErrors = requests.filter(r => !apiProbes.includes(r));
  if (errors.length || assetErrors.length) throw new Error(JSON.stringify({ errors, assetErrors, apiProbes }));
  await writeFile(path.join(out, 'receipt.json'), JSON.stringify({ cases, errors, requests, apiProbes, assetErrors, cameraBarrier: 'anterior wall stopped repeated forward input', imagePolicy: 'unmodified full-viewport browser screenshots' }, null, 2));
  console.log(JSON.stringify({ output: out, cases: cases.length, errors, assetErrors, apiProbes }));
} catch (error) {
  await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({ error: String(error), snapshot: await read().catch(() => null), cases, errors, requests }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); }
