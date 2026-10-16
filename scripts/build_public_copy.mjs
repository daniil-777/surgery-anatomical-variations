// scripts/build_public_copy.mjs — builds the public copy of VISCERA Studio: the browser-only studio plus the API's
// snapshots it starts from. GitHub Pages serves the result (.github/workflows/pages.yml); the portfolio site's
// tools/build-anatomy.mjs does the same from outside this repository.
//   node scripts/build_public_copy.mjs [--out public-copy] [--api http://127.0.0.1:8000] [--keep-specimens] [--api-url https://host]
// Steps: (1) ask the running API for the catalogue (plus each template's normalisation), render every template with
// default controls in tissue and with its source colours, prepare the reference livers' hands-on physics, the physics
// status and demonstration calibration, the photo analyses of the bundled photographs, and the trained-model status
// (static/api/, gzipped JSON); --keep-specimens reuses what the output folder already has; (2) build the studio with
// Vite for a relative base and without source maps; (3) compress the whole-body atlas; (4) write build.json and api.json
// (the hosted API's address, preserved across rebuilds or set with --api-url), then swap the tree into --out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compressGlb } from './compress-glb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const FINAL = path.resolve(ROOT, typeof opt.out === 'string' ? opt.out : 'public-copy');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'viscera-public-'));   // built outside the tree, swapped in as one directory
const OUT = path.join(WORK, 'out');
const STATIC_API = path.join(OUT, 'static', 'api');
const FINAL_STATIC = path.join(FINAL, 'static', 'api');
const conflictCopy = (name) => / \d+(\.[\w.]+)?$/.test(name);   // "x 2.json.gz": what iCloud leaves behind
const API = (typeof opt.api === 'string' ? opt.api : process.env.VISCERA_API_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const PUB = path.join(ROOT, 'apps/studio/public');
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const t0 = Date.now();
/** fetch with one retry on a lost connection: the client may pause longer than the server's keep-alive while it
 *  gzips a 57 MB specimen, and the next request can race the server closing that idle connection. The calls here
 *  are deterministic, so repeating one is safe. */
async function fetchApi(route, init) {
  for (let attempt = 0; ; attempt++) {
    try { return await fetch(`${API}${route}`, init); }
    catch (error) {
      if (attempt >= 1) throw new Error(`${route}: the API connection failed twice (${error.cause?.message ?? error.message}); is the API still running?`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

for (const p of ['apps/studio/vite.config.ts', 'node_modules/vite/bin/vite.js', 'apps/studio/public/anatomy-scene/bodyparts3d-torso.glb'])
  if (!fs.existsSync(path.join(ROOT, p))) throw new Error(`${p} is missing: run pnpm install first`);

// the frame the shape controls act in is in each template's metadata; the API realizes the repaired templates-v3 when
// it is present (services/api/atlas.py versioned_template_root), so the catalogue's metadata is read from the same place
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES_V2
  || (!process.env.VISCERA_ATLAS_TEMPLATES && fs.existsSync(path.join(ROOT, 'datasets/anatomy-templates/templates-v3')) ? path.join(ROOT, 'datasets/anatomy-templates/templates-v3') : null)
  || process.env.VISCERA_ATLAS_TEMPLATES || path.join(ROOT, 'datasets/atlas/cohort-v2/templates');

// ---- 1. the catalogue and the reference specimens, from the API
let specimens;
const keep = path.join(WORK, 'keep', 'atlas');   // mirrors static/api/atlas; ../physics beside it
if (opt['keep-specimens']) {
  if (!fs.existsSync(path.join(FINAL_STATIC, 'atlas', 'specimens'))) throw new Error(`--keep-specimens: ${FINAL_STATIC}/atlas does not exist yet`);
  fs.cpSync(FINAL_STATIC, path.dirname(keep), { recursive: true, filter: (p) => !conflictCopy(path.basename(p)) });
  specimens = fs.readdirSync(path.join(keep, 'specimens')).length;
  console.log(`keeping ${specimens} bundled specimens`);
} else {
  const health = await fetchApi(`/api/health`).then((r) => r.ok, () => false);
  if (!health) throw new Error(`no VISCERA API at ${API}: start it (pnpm api), or pass --keep-specimens`);
  const catalog = await fetchApi(`/api/atlas/catalog`).then((r) => { if (!r.ok) throw new Error(`catalog: HTTP ${r.status}`); return r.json(); });
  if (!Array.isArray(catalog.organs) || !Array.isArray(catalog.controls)) throw new Error('the catalogue has no organs or controls');
  for (const organ of catalog.organs) for (const template of organ.templates) {
    const meta = JSON.parse(fs.readFileSync(path.join(templateRoot, `${template.id}.json`), 'utf8'));
    if (!(meta.normalization_mm > 0) || !Array.isArray(meta.control_limits)) throw new Error(`${template.id}: metadata lacks normalization_mm or control_limits`);
    template.normalization_mm = meta.normalization_mm;
    if (JSON.stringify(template.control_limits) !== JSON.stringify(meta.control_limits)) throw new Error(`${template.id}: catalogue and metadata disagree on control limits`);
  }
  for (const d of ['specimens', 'templates', '../physics/playground', 'reference-material/regions', 'reference-material/examples']) fs.mkdirSync(path.join(keep, d), { recursive: true });
  fs.writeFileSync(path.join(keep, 'catalog.json'), JSON.stringify(catalog));
  const post = async (route, body, raw = false) => {
    const r = await fetchApi(`${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
    return raw ? r.text() : r.json();
  };
  specimens = 0;
  const unavailable = [];
  for (const organ of catalog.organs) for (const template of organ.templates) {
    // the same spec the studio's defaultAtlasSpec() builds (apps/studio/src/atlas.ts): the API's answer must equal it
    const spec = { ...(catalog.renderer_version ? { renderer_version: catalog.renderer_version } : {}), template_id: template.id, seed: 42,
      controls: Object.fromEntries(catalog.controls.map((c) => [c.key, c.default])), appearance: 'tissue',
      ...(catalog.materials ? { material: { ...catalog.materials.defaults[organ.id] } } : {}) };
    const r = await fetchApi(`/api/atlas/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(spec) })

    if (r.status === 422) {   // a template the API itself refuses (its QA gate): the studio says so when picked
      const detail = (await r.text()).slice(0, 200);
      unavailable.push({ id: template.id, detail });
      console.log(`  ${template.id.padEnd(32)} not rendered: ${detail}`);
      continue;
    }
    if (!r.ok) throw new Error(`${template.id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const text = await r.text();
    const result = JSON.parse(text);
    if (!result.scene || !result.spec || result.spec.template_id !== template.id) throw new Error(`${template.id}: unexpected answer`);
    const gz = zlib.gzipSync(text, { level: 9 });
    fs.writeFileSync(path.join(keep, 'specimens', `${template.id}.json.gz`), gz);
    specimens++;
    const { material: _m, ...plain } = spec;   // the template's own colours, for the source appearance
    const colors = (await post('/api/atlas/generate', { ...plain, appearance: 'source' })).scene.organs[0].colors;
    if (!Array.isArray(colors) || colors.length !== result.scene.organs[0].positions.length) throw new Error(`${template.id}: source colours do not match the surface`);
    fs.writeFileSync(path.join(keep, 'templates', `${template.id}.source-colors.json.gz`), zlib.gzipSync(JSON.stringify(colors), { level: 9 }));
    if (organ.id === 'liver') for (const source of ['learned', 'manual']) {   // the hands-on physics of the reference livers
      const body = await post('/api/physics/playground', { spec: result.spec, parameter_source: source }, true);
      if (JSON.parse(body).source.realized_id !== result.spec.realized_id) throw new Error(`${template.id}: the physics cage names another realized liver`);
      fs.writeFileSync(path.join(keep, '../physics/playground', `${template.id}.${source}.json.gz`), zlib.gzipSync(body, { level: 9 }));
    }
    console.log(`  ${template.id.padEnd(32)} ${mb(text.length)} → ${mb(gz.length)} gz · ${result.summary?.triangles ?? '?'} triangles`);
  }
  fs.writeFileSync(path.join(keep, 'unavailable.json'), JSON.stringify(unavailable, null, 2) + '\n');
  // the photo panels' analyses: every bundled photograph's regions and every example's default region, through the API
  const b64 = (file) => fs.readFileSync(file).toString('base64');
  const bodyCatalog = JSON.parse(fs.readFileSync(path.join(PUB, 'body-reference/catalog.json'), 'utf8'));
  for (const source of bodyCatalog.sources) {
    const regions = source.regions.filter((r) => Array.isArray(r.selection?.box) && Array.isArray(r.targets) && r.targets.length).map((region, index) => {
      const mask = path.join(PUB, 'body-reference', `${region.id}-mask.png`);
      return { id: `region-${index}`, organ: region.organ, selection: region.selection, ...(fs.existsSync(mask) ? { mask_base64: b64(mask) } : {}) };
    });
    const analysis = await post('/api/atlas/reference-material/analyze-regions', { image_base64: b64(path.join(PUB, 'body-reference', path.basename(source.src))), segmentation: 'local', regions });
    fs.writeFileSync(path.join(keep, 'reference-material/regions', `${source.id}.json`), JSON.stringify(analysis));
  }
  const examples = fs.readFileSync(path.join(ROOT, 'apps/studio/src/referenceExamples.ts'), 'utf8');
  for (const block of examples.split(/\n\s*\{\s*\n\s*id:/).slice(1)) {
    const id = block.match(/"([^"]+)"/)[1], src = block.match(/src: "([^"]+)"/)[1];
    const box = block.match(/box: \[([^\]]+)\]/)[1].split(',').map(Number);
    const pairs = (text) => [...text.matchAll(/\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
    const fg = block.slice(block.indexOf('foreground:'), block.indexOf('background:')), bg = block.slice(block.indexOf('background:')).split('}')[0];
    const analysis = await post('/api/atlas/reference-material/analyze', { image_base64: b64(path.join(PUB, src.replace(/^\//, ''))), organ: 'large-intestine', segmentation: 'local', selection: { box, foreground_points: pairs(fg), background_points: pairs(bg) } });
    fs.writeFileSync(path.join(keep, 'reference-material/examples', `${id}.json`), JSON.stringify(analysis));
  }
  for (const [route, file] of [['/api/physics/status', '../physics/status.json'], ['/api/physics/demo-observation', '../physics/demo-observation.json'],
    ['/api/atlas/models', 'models.json'], ['/api/atlas/models/joint/history', 'models/joint/history.json']]) {
    const r = await fetchApi(`${route}`);
    if (!r.ok) throw new Error(`${route}: HTTP ${r.status}`);
    fs.mkdirSync(path.dirname(path.join(keep, file)), { recursive: true });
    fs.writeFileSync(path.join(keep, file), await r.text());
  }
  console.log(`  ${specimens} specimens, ${unavailable.length} unavailable, photo analyses and model status snapshotted`);
}

// ---- 1b. the hosted API's address: api.json survives rebuilds, or is set here
const previousApiJson = path.join(FINAL, 'api.json');
const apiJson = typeof opt['api-url'] === 'string' ? JSON.stringify({ api: opt['api-url'].replace(/\/$/, '') }, null, 2) + '\n'
  : fs.existsSync(previousApiJson) ? fs.readFileSync(previousApiJson, 'utf8')
  : JSON.stringify({ api: null, note: 'Set "api" to the https origin of a hosted VISCERA API (services.web.app) and the public copy uses it for everything; null keeps the browser-only copy.' }, null, 2) + '\n';

// ---- 2. the studio, built for a relative base, without source maps
const r = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'apps/studio/vite.config.ts', '--outDir', OUT, '--emptyOutDir'],
  { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, VISCERA_BASE: './', VISCERA_SOURCEMAP: '0' } });
if (r.status !== 0) { console.error(r.stdout, r.stderr); throw new Error('vite build failed'); }
console.log(r.stdout.split('\n').filter((l) => /built in/.test(l)).join('\n'));
if (fs.readdirSync(path.join(OUT, 'assets')).some((f) => f.endsWith('.map'))) throw new Error('source maps were written');
fs.writeFileSync(path.join(OUT, 'api.json'), apiJson);
// the models the browser samplers read (joint flow, shape and disease samplers, the disease renderer's support) travel with the build
for (const f of ['index.html', 'textures.html', 'models/joint-v2/model.json', 'models/joint-v2/weights.bin', 'models/shape-v2/model.json', 'models/shape-v2/weights.bin', 'models/material-v1/model.json', 'models/material-v1/weights.bin', 'models/physics-v2/model.json', 'models/physics-v2/weights.bin', 'models/disease-recipes-v2/model.json', 'models/disease-recipes-v2/weights.bin', 'models/disease-v2/index.json', 'default-scene.json', 'anatomy-scene/bodyparts3d-torso.glb', 'anatomy-scene/manifest.json', 'body-reference/catalog.json', 'textures/manifest.json'])
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`${f} missing after the build`);
fs.mkdirSync(STATIC_API, { recursive: true });
fs.cpSync(path.dirname(keep), STATIC_API, { recursive: true });

// ---- 3. the whole-body atlas, compressed
const glb = path.join(OUT, 'anatomy-scene', 'bodyparts3d-torso.glb'), tmp = glb.replace(/\.glb$/, '.compressed.glb');   // the writer picks the format by extension
const c = await compressGlb(glb, tmp);
fs.renameSync(tmp, glb);
if (c.bytesOut < 1e6 || c.bytesOut > c.bytesIn) throw new Error(`the compressed atlas is ${c.bytesOut} bytes: not plausible`);
console.log(`atlas ${mb(c.bytesIn)} → ${mb(c.bytesOut)} (${c.meshes} meshes, ${c.extensions.join(' ')})`);

// ---- 4. the stamp, then the swap into --out
let files = 0, bytes = 0;
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (conflictCopy(e.name)) throw new Error(`conflict copy in the build: ${p}`); if (e.isDirectory()) walk(p); else { files++; bytes += fs.statSync(p).size; } } };
walk(OUT);
const vite = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/vite/package.json'), 'utf8')).version;
const unavailable = JSON.parse(fs.readFileSync(path.join(STATIC_API, 'atlas/unavailable.json'), 'utf8')).map((u) => u.id);
for (const f of ['atlas/catalog.json', 'atlas/models.json', 'atlas/models/joint/history.json', 'atlas/reference-material/examples/colon-1.json', 'physics/status.json', 'physics/demo-observation.json', 'physics/playground/hra-liver-female.learned.json.gz'])
  if (!fs.existsSync(path.join(STATIC_API, f))) throw new Error(`static/api/${f} missing`);
fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({ builtAt: new Date().toISOString(), vite, specimens, unavailable, atlasBytes: c.bytesOut, files, bytes }, null, 2) + '\n');
fs.rmSync(FINAL, { recursive: true, force: true });
fs.mkdirSync(path.dirname(FINAL), { recursive: true });
try { fs.renameSync(OUT, FINAL); } catch { fs.cpSync(OUT, FINAL, { recursive: true }); }
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`${path.relative(ROOT, FINAL) || '.'}/: ${files} files, ${mb(bytes)}, ${specimens} specimens, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
