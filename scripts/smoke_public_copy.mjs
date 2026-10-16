// scripts/smoke_public_copy.mjs — opens the built public copy in headless Chrome the way a visitor does: the organ
// studio must become ready without errors and sample a joint flow variation in the browser, the whole scene, the
// procedural studio and the texture lab must become ready; the organ studio must not carry the texture lab's layer.
//   node scripts/smoke_public_copy.mjs [dir=public-copy] [--url https://host/path/] [--chrome PATH] [--port 8123] [--budget 300000] [--out DIR]
// With --url the published copy is checked instead of a local folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serve } from './serve-static.mjs';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const argv = process.argv.slice(2), opt = {};
const positional = [];
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; else positional.push(argv[i]);
const DIR = path.resolve(positional[0] || 'public-copy');
const PORT = +(opt.port || 8123);
const T = +(opt.budget || 300000);
const OUTDIR = opt.out || fs.mkdtempSync(path.join(os.tmpdir(), 'viscera-smoke-'));
const CHROME = [opt.chrome, process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  .find((p) => p && fs.existsSync(p));
if (!CHROME) { console.error('no Chrome found: pass --chrome PATH or set $CHROME'); process.exit(2); }
const LIVE = typeof opt.url === 'string' ? opt.url.replace(/\/?$/, '/') : null;
if (!LIVE && !fs.existsSync(path.join(DIR, 'index.html'))) { console.error(`${DIR} has no index.html`); process.exit(2); }

const server = LIVE ? null : await serve(DIR, PORT);
const base = LIVE ?? `http://127.0.0.1:${PORT}/`;
console.log(`smoke: ${base}`);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1380,820', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])] });
let failures = 0;
const flag = (page, expr) => page.waitForFunction(expr, { timeout: T });
const button = (page, label) => page.evaluate((l) => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === l); if (!b || b.disabled) return false; b.click(); return true; }, label);

async function check(name, url, mode, steps) {
  const t = Date.now();
  const page = await browser.newPage();
  page.setDefaultTimeout(T);
  await page.setViewport({ width: 1380, height: 820 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(m.text())) errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon|\/api\//i.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  let info = '', ok = true;
  try {
    await page.goto(base + url, { waitUntil: 'load', timeout: T });
    await flag(page, 'window.__viscera && (window.__viscera.ready || window.__viscera.errors.length)');
    info = await steps(page);
    const v = await page.evaluate(() => ({ ...window.__viscera, photo: !!document.querySelector('.atlas-photo-detail'), tiles: performance.getEntriesByType('resource').filter((e) => /\/textures\/.*\.png$/.test(e.name)).length }));
    if (v.errors.length) throw new Error(v.errors.join(' | '));
    if (v.mode !== mode) throw new Error(`ready in mode ${v.mode}, expected ${mode}`);
    if (mode === 'textures' && (!v.photo || !v.tiles)) throw new Error('texture lab without its photo controls or tiles');
    if (mode === 'atlas' && (v.photo || v.tiles)) throw new Error('organ studio carries the photo layer');
    if (errors.length) throw new Error(`console errors: ${errors.slice(0, 3).join(' | ')}`);
  } catch (e) { ok = false; failures++; info = e && e.message || String(e); }
  try { await page.screenshot({ path: path.join(OUTDIR, name + '.png') }); } catch { /* page gone */ }
  await page.close();
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(14)} ${((Date.now() - t) / 1000).toFixed(1).padStart(5)} s   ${info}`);
}

await check('atlas', '', 'atlas', async (page) => {
  // the joint flow samples in the browser (atlasJointLocal.ts): the button must apply a variation without the API
  await flag(page, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Joint flow variation' && !b.disabled)");
  if (!await button(page, 'Joint flow variation')) throw new Error('joint flow button unavailable');
  await flag(page, "[...document.querySelectorAll('.atlas-model-status')].some((e) => /Joint flow variation applied/.test(e.textContent)) || window.__viscera.errors.length > 0");
  const seed = await page.evaluate(() => document.getElementById('atlas-joint-seed')?.value ?? null);
  await button(page, 'New joint variation');
  await flag(page, `(document.getElementById('atlas-joint-seed')?.value ?? null) !== ${JSON.stringify(seed)} || window.__viscera.errors.length > 0`);
  await new Promise((r) => setTimeout(r, 3000));
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Surface')?.click());
  await new Promise((r) => setTimeout(r, 2500));
  return 'joint flow sampled twice · Surface tab opened';
});
await check('scene', '?mode=scene', 'scene', async () => 'whole scene ready');
await check('legacy', '?mode=legacy', 'legacy', async () => 'procedural studio ready');
await check('textures', 'textures.html', 'textures', async () => { await new Promise((r) => setTimeout(r, 2500)); return 'texture lab ready with its tiles'; });

await browser.close();
server?.close();
console.log(`${4 - failures}/4 checks passed · screenshots in ${OUTDIR}`);
process.exit(failures ? 1 : 0);
