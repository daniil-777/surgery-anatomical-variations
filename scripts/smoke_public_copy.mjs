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
fs.mkdirSync(OUTDIR, { recursive: true });
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

const enabled = (label) => `[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`;
const shown = (selector, re) => `[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => ${re}.test(e.textContent)) || window.__viscera.errors.length > 0`;
await check('atlas', '', 'atlas', async (page) => {
  // every sampler that runs in the browser, pressed once: the joint flow (atlasJointLocal.ts), the trained shape model
  // (atlasShapeSampler.ts), a disease profile and its variation (atlasDiseaseLocal.ts), the joint flow with that disease,
  // the trained material sampler (atlasMaterialSampler.ts)
  // a text command (atlasTextCompiler.ts): a dimension request runs the compiler's solver on the bundled reference,
  // then the studio generates the result; the displayed bounding size must become 260.0 mm wide
  await page.waitForSelector('textarea[aria-label="Describe an anatomy variation"]');
  await page.type('textarea[aria-label="Describe an anatomy variation"]', 'liver width 260 mm');
  await page.evaluate(() => document.querySelector('form.atlas-prompt-box')?.requestSubmit());
  await flag(page, shown('.atlas-text-feedback', /width 260 mm/));
  if (await page.$('.atlas-text-feedback.unsupported')) throw new Error(`text command refused: ${await page.$eval('.atlas-text-feedback', (e) => e.textContent)}`);
  const width = await page.evaluate(() => Number(document.body.innerText.match(/(\d+\.\d) × (\d+\.\d) × (\d+\.\d)/)?.[1] ?? NaN));
  if (Math.abs(width - 260) > 0.05) throw new Error(`text command applied, but the liver is ${width} mm wide`);
  await flag(page, enabled('Generative Model 2 variation'));
  if (!await button(page, 'Generative Model 2 variation')) throw new Error('joint flow button unavailable');
  await flag(page, shown('.atlas-model-status', /Generative Model 2 variation applied/));
  const seed = await page.evaluate(() => document.getElementById('atlas-joint-seed')?.value ?? null);
  await button(page, 'New joint variation');
  await flag(page, `(document.getElementById('atlas-joint-seed')?.value ?? null) !== ${JSON.stringify(seed)} || window.__viscera.errors.length > 0`);
  await new Promise((r) => setTimeout(r, 3000));
  await flag(page, enabled('Learned variation'));
  if (!await button(page, 'Learned variation')) throw new Error('learned variation button unavailable');
  await flag(page, shown('.atlas-model-status', /Model variation applied/));
  await page.click('#atlas-tab-disease');
  await page.waitForSelector('select[aria-label="Disease profile"]');
  const profile = await page.$eval('select[aria-label="Disease profile"]', (s) => [...s.options].find((o) => o.value && !o.disabled)?.value ?? null);
  if (!profile) throw new Error('no supported disease profile to pick');
  await page.select('select[aria-label="Disease profile"]', profile);
  await flag(page, shown('.atlas-stage-disease', /synthetic prototype/));
  const diseaseSeed = await page.evaluate(() => document.getElementById('atlas-disease-seed')?.value ?? null);
  if (!await button(page, 'Generate variation')) throw new Error('disease variation button unavailable');
  await flag(page, `(document.getElementById('atlas-disease-seed')?.value ?? null) !== ${JSON.stringify(diseaseSeed)} || window.__viscera.errors.length > 0`);
  await flag(page, shown('.atlas-disease-panel .atlas-recipe-state', /Preview matches this recipe/));
  if (!await button(page, 'Generative Model 2 variation')) throw new Error('joint flow button unavailable with a disease');
  await flag(page, shown('.atlas-model-status', /Generative Model 2 variation applied/));
  if (!await page.$('.atlas-stage-disease')) throw new Error('the joint flow variation dropped the disease');
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Surface')?.click());
  await new Promise((r) => setTimeout(r, 2500));
  // the trained material sampler (atlasMaterialSampler.ts): the surface recipe's sliders take the sampled values
  const sliders = "[...document.querySelectorAll('#atlas-surface-panel input[type=range]')].map((i) => i.value).join(',')";
  const before = await page.evaluate(sliders);
  await flag(page, enabled('Sample surface'));
  if (!await button(page, 'Sample surface')) throw new Error('surface sample button unavailable');
  await flag(page, `${sliders} !== ${JSON.stringify(before)} || window.__viscera.errors.length > 0`);
  await flag(page, shown('#atlas-surface-panel .atlas-recipe-state', /Preview matches this surface/));
  return `text command (width 260 mm), joint flow, learned shape, disease ${profile}, joint flow with it and a surface sampled`;
});
await check('physics', '', 'atlas', async (page) => {
  // the physics lab calibrates a measurement of your own in the browser (atlasPhysicsCalibration.ts): the demonstration
  // with its force scaled by 1.25 must give a stiffer learned material than the demonstration's 4.80 kPa
  const demo = await page.evaluate(async () => (await fetch('static/api/physics/demo-observation.json')).json());
  const measurement = { times_s: demo.times_s, force_n: demo.force_n.map((f) => f * 1.25), displacement_mm: demo.displacement_mm,
    reference_length_mm: demo.reference_length_mm, reference_area_mm2: demo.reference_area_mm2, provenance: 'smoke test: the demonstration with its force scaled by 1.25' };
  const file = path.join(OUTDIR, 'calibration.json');
  fs.writeFileSync(file, JSON.stringify(measurement));
  await flag(page, enabled('Physics lab'));
  if (!await button(page, 'Physics lab')) throw new Error('physics lab button unavailable');
  await flag(page, enabled('Hands-on'));
  await button(page, 'Hands-on');
  const stiffness = "[...document.querySelectorAll('div')].find((d) => d.querySelector(':scope > span')?.textContent === 'Material stiffness')?.querySelector('strong')?.textContent ?? ''";
  await flag(page, `/\\d/.test(${stiffness}) || window.__viscera.errors.length > 0`);
  const before = await page.evaluate(stiffness);
  await page.evaluate(() => { const d = document.querySelector('details.physics-calibration'); if (d) d.open = true; });
  const input = await page.waitForSelector('details.physics-calibration input[type=file]');
  await input.uploadFile(file);
  await flag(page, shown('.physics-calibration-name', /Loaded/));
  await flag(page, enabled('Apply material'));
  if (!await button(page, 'Apply material')) throw new Error('apply material button unavailable');
  await flag(page, `(${stiffness}) !== ${JSON.stringify(before)} && /\\d/.test(${stiffness}) || window.__viscera.errors.length > 0 || !!document.querySelector('.physics-error, .playground-error')`);
  const error = await page.evaluate(() => document.querySelector('.physics-error, .playground-error')?.textContent ?? '');
  if (error) throw new Error(`calibration refused: ${error}`);
  const after = await page.evaluate(stiffness);
  return `measurement calibrated in the browser: stiffness ${before} → ${after}`;
});
await check('scene', '?mode=scene', 'scene', async (page) => {
  await flag(page, enabled('Under the liver'));
  if (!await button(page, 'Under the liver')) throw new Error('operative entry unavailable');
  await flag(page, `(() => { const value = document.querySelector('[data-scene-snapshot]')?.dataset.sceneSnapshot; if (!value) return false; const s=JSON.parse(value); return s.camera.navigation.mode==='explore' && s.fat.status==='ready' && !s.rendering.renderPending; })()`);
  const state=await page.evaluate(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
  if (!state.inspection.cameraLight.enabled || !state.fat.layers.length) throw new Error('operative field lacks camera light or fat layers');
  await page.click('button[aria-label="Exit interior exploration"]');
  await flag(page, `JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).camera.navigation.mode==='orbit'`);
  return 'whole scene, operative entry, surrounding fat and return to orbit';
});
await check('virtamed', '?mode=scene&scene=virtamed', 'scene', async (page) => {
  await flag(page, enabled('Apply learned textures'));
  const read=()=>page.evaluate(()=>JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot));
  const white=await read();
  if(white.sourceScene!=='virtamed'||white.surfaceMode!=='white'||white.organs.length!==12)throw new Error('Incomplete white video-field scene');
  await button(page,'Apply learned textures');
  await flag(page, `JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).surfaceMode==='learned-tissue'`);
  const tissue=await read();
  if(tissue.organs.filter(p=>p.appearance?.sha256).length!==4||tissue.organs.some((p,i)=>p.geometrySignature!==white.organs[i].geometrySignature))throw new Error('Learned material switch failed');
  await button(page,'Apply learned physics to all organs');
  await flag(page, `JSON.parse(document.querySelector('[data-scene-snapshot]').dataset.sceneSnapshot).physics?.running===true`);
  const physical=await read();
  if(!physical.physics.finite||physical.physics.organs.length!==12||!physical.physics.organs.some(o=>o.id==='abdominal-wall'))throw new Error('Video-field mechanics failed');
  return '12-part white GLB, verified learned textures, 12 dynamic tissues and supported cavity lining';
});
await check('legacy', '?mode=legacy', 'legacy', async () => 'procedural studio ready');
await check('textures', 'textures.html', 'textures', async () => { await new Promise((r) => setTimeout(r, 2500)); return 'texture lab ready with its tiles'; });

await browser.close();
server?.close();
console.log(`${6 - failures}/6 checks passed · screenshots in ${OUTDIR}`);
process.exit(failures ? 1 : 0);
