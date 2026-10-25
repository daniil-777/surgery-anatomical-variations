#!/usr/bin/env node
/** Reproducible synthetic-design calibration using Viscera's EXISTING browser inverse estimator.
 * node build_virtamed_materials.mjs --repo /path/to/viscera --out /path/to/output
 * Requires the repository's installed esbuild package; no network or training is performed.
 * The unknown-force demonstration video supplies no measured mechanics input.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const repo = path.resolve(option('--repo', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')));
const out = path.resolve(option('--out', path.dirname(fileURLToPath(import.meta.url))));
const require = createRequire(path.join(repo, 'package.json'));
const { build } = require('esbuild');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const names = ['young_pa', 'relaxation_fraction', 'relaxation_time_s'];

// Authored design assumptions for visible response differentiation. Not literature fits,
// measurements, tissue safety limits, disease predictions, or material constants of humans.
const designs = [
  ['liver', 'digestive', 4200, .40, .70, 1000, 'soft parenchymal design'],
  ['gallbladder', 'digestive', 2800, .44, .85, 1000, 'compliant thin-wall design; no lumen pressure'],
  ['cystic-duct', 'digestive', 6800, .27, .52, 1000, 'narrow duct design; no lumen mechanics'],
  ['hepatic-duct', 'digestive', 7200, .26, .49, 1000, 'narrow duct design; no lumen mechanics'],
  ['cystic-artery', 'cardiovascular', 9000, .28, .43, 1000, 'vessel design; no blood pressure or anisotropy'],
  ['colon', 'digestive', 4800, .40, .75, 1000, 'bowel-wall design; no lumen pressure'],
  ['small-intestine', 'digestive', 3500, .45, .80, 1000, 'compliant bowel-wall design; no lumen pressure'],
  ['duodenum', 'digestive', 4300, .40, .70, 1000, 'bowel-wall design; no lumen pressure'],
  ['hepatocystic-fat', 'connective', 2200, .55, 1.20, 950, 'soft synthetic adipose preview; not calibrated adipose law'],
  ['hepatoduodenal-ligament', 'connective', 12000, .22, .50, 1000, 'tether-like material design; actual attachments must be supplied separately'],
  ['falciform-ligament', 'connective', 9500, .25, .60, 1000, 'tether-like material design; actual attachments must be supplied separately'],
  ['abdominal-wall', 'connective', 17500, .20, .40, 1000, 'supported wall design; stiffness alone does not implement a fixed boundary'],
];

async function sourceModule(relative) {
  const result = await build({ entryPoints: [path.join(repo, relative)], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent', treeShaking: true,
    define: { 'import.meta.env': JSON.stringify({ VITE_API_URL: '', BASE_URL: '/' }), 'process.env.NODE_ENV': '"production"' } });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
}
const { parsePhysicsModel, inferObservation, stressResponse } = await sourceModule('apps/studio/src/atlasPhysicsCalibration.ts');
const { readLearnedSceneMaterials } = await sourceModule('apps/studio/src/wholeScenePhysics.ts');
const metaBytes = await fs.readFile(path.join(repo, 'apps/studio/public/models/physics-v2/model.json'));
const weights = await fs.readFile(path.join(repo, 'apps/studio/public/models/physics-v2/weights.bin'));
const meta = JSON.parse(metaBytes.toString('utf8'));
if (hash(weights) !== meta.weights_sha256) throw new Error('Existing physics estimator weights checksum mismatch.');
const model = parsePhysicsModel(meta, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
const clamp = v => Math.max(0, Math.min(1, v));
const grid = (duration, count) => Array.from({ length: count }, (_, i) => i * duration / (count - 1));
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return ((x >>> 0) + .5) / 4294967296; }; }
function gaussian(next) { return Math.sqrt(-2 * Math.log(next())) * Math.cos(2 * Math.PI * next()); }
const fittingTimes = grid(7, 113);
const fittingStrain = fittingTimes.map(t => .024 * Math.min(clamp(t / .8), clamp((4.7 - t) / .85)));
const validationProtocols = [
  { id: 'smooth-cycle', times: grid(5.2, 101), strain: t => .017 * Math.sin(Math.PI * t / 5.2) ** 2 },
  { id: 'fast-triangle', times: grid(3.5, 113), strain: t => .016 * Math.min(clamp(t / .65), clamp((1.8 - t) / 1.15)) },
  { id: 'slow-ramp-hold-release', times: grid(11.5, 185), strain: t => .035 * Math.min(clamp(t / 2.2), clamp((8.9 - t) / 2.2)) },
];
const referenceLength = 20, referenceArea = 100;
const materials = [], observations = [], heldOut = [];
for (const [id, category, E, g, tau, density, designNote] of designs) {
  const target = [E, g, tau], seed = parseInt(hash(`viscera-virtamed-design-v1:${id}`).slice(0, 8), 16);
  const next = rng(seed), clean = stressResponse(fittingTimes, fittingStrain, ...target);
  const peak = Math.max(...Array.from(clean, Math.abs));
  const noise = Array.from(clean, s => s + .002 * peak * gaussian(next)); noise[0] = 0;
  const provenance = `Synthetic scene design experiment for ${id}: SLS simulator, deterministic seed ${seed}, authored target E=${E} Pa, g=${g}, tau=${tau} s. ${designNote}. L0=20 mm and A0=100 mm^2 are synthetic metric assumptions. Full.mp4 is unknown-force visual reference only and supplied no mechanical observations. Not human calibration.`;
  const observation = { times_s: fittingTimes, displacement_mm: fittingStrain.map(e => e * referenceLength), force_n: noise.map(s => s * referenceArea * 1e-6), reference_length_mm: referenceLength, reference_area_mm2: referenceArea, provenance };
  const fit = inferObservation(model, observation);
  if (!fit.accepted_for_application) throw new Error(`Fit refused for ${id}: ${JSON.stringify(fit.rejection_reasons)}`);
  const predicted = names.map(k => fit.parameters[k]);
  const checks = validationProtocols.map(protocol => {
    const strain = protocol.times.map(protocol.strain);
    const actual = stressResponse(protocol.times, strain, ...target), estimated = stressResponse(protocol.times, strain, ...predicted);
    const scale = Math.max(...Array.from(actual, Math.abs));
    const error = Math.sqrt(Array.from(actual, (s, i) => (s - estimated[i]) ** 2).reduce((a, b) => a + b, 0) / actual.length) / scale;
    if (!Number.isFinite(error) || error > .02) throw new Error(`Held-out waveform failed for ${id}/${protocol.id}: ${error}`);
    return { id: protocol.id, samples: actual.length, duration_s: protocol.times.at(-1), peak_strain: Math.max(...strain), stress_nrmse: error, accepted: true,
      times_s: protocol.times, strain, design_stress_pa: Array.from(actual), fitted_stress_pa: Array.from(estimated) };
  });
  const errors = Object.fromEntries(names.map((k, i) => [k, Math.abs(predicted[i] / target[i] - 1)]));
  const record = { id, ...fit.parameters, density_kg_m3: density, accepted_for_application: true, observation_origin: 'synthetic-design-history', category,
    model_id: fit.model_id, design_parameters: Object.fromEntries(names.map((k, i) => [k, target[i]])), design_note: designNote,
    density_provenance: 'Authored mass-density assumption, not inferred from data or video.',
    neural_parameters: fit.neural_parameters, parameter_intervals_90: fit.parameter_intervals_90,
    parameter_absolute_relative_errors: errors, fit_stress_nrmse: fit.stress_nrmse,
    held_out_waveform_stress_nrmse: Math.max(...checks.map(c => c.stress_nrmse)),
    held_out_protocols: checks.map(({ times_s, strain, design_stress_pa, fitted_stress_pa, ...summary }) => summary),
    diagnostics: fit.diagnostics, provenance,
    ...(id === 'abdominal-wall' ? { recommended_boundary: 'fixed_or_tethered', boundary_is_enforced_by_this_material_table: false } : {}),
  };
  materials.push(record);
  observations.push({ id, seed, noise_standard_deviation_fraction_of_peak_stress: .002, design_parameters: record.design_parameters, observation, design_stress_pa: Array.from(clean), fit });
  heldOut.push({ id, design_parameters: record.design_parameters, fitted_parameters: fit.parameters, parameter_absolute_relative_errors: errors, protocols: checks });
  console.log(JSON.stringify({ id, accepted: true, E: fit.parameters.young_pa, g: fit.parameters.relaxation_fraction, tau: fit.parameters.relaxation_time_s, fit_nrmse: fit.stress_nrmse, held_out_nrmse: record.held_out_waveform_stress_nrmse }));
}
const sourceHashes = {};
for (const file of ['apps/studio/src/atlasPhysicsCalibration.ts', 'apps/studio/src/trustRegionReflective.ts', 'apps/studio/src/fusedMultiplyAdd.ts', 'apps/studio/src/wholeScenePhysics.ts', 'py/viscera_core/physics_learning_v2.py']) sourceHashes[file] = hash(await fs.readFile(path.join(repo, file)));
const payload = {
  schema_version: 'whole-scene-materials-1.0.0', model_id: meta.model_sha256, model_version: meta.version,
  scope: 'Existing inverse SLS estimator with bounded physical refinement applied to 12 explicit synthetic scene-design histories. Not learned from Full.mp4, biological organ-specific training, measured human properties, or clinical validation.',
  observation_origin: 'synthetic-design-history',
  video_mechanics_calibration: { performed: false, reason: 'Unknown loads, scale, boundary conditions and camera calibration; a rendered monocular demonstration cannot identify absolute tissue stiffness.' },
  parameter_intervals_scope: 'Synthetic inverse-model uncertainty only; no coverage claim for human tissues or model-form mismatch.',
  density_provenance: 'Authored mass-density assumptions, never inferred by the inverse model.',
  attachment_scope: 'This table assigns material responses. Attachments, rigid supports and sliding contacts must be implemented by the scene solver.',
  wall_boundary: { recommended: 'fixed_or_tethered', enforced_by_material_table: false, explanation: 'The v1 material schema has no constraint field. Higher modulus is not a tether.' },
  inference_method: 'Protocol-conditioned neural ensemble proposal followed by existing bounded robust physical refinement; no estimator retraining.',
  generation: { script: 'build_virtamed_materials.mjs', script_sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))), estimator_weights_sha256: hash(weights), source_sha256: sourceHashes,
    deterministic_seed_scheme: 'First 32 bits of SHA256(viscera-virtamed-design-v1:<organ-id>); xorshift32 and Box-Muller noise.', fit_samples: 113, fit_duration_s: 7, peak_fit_strain: .024 },
  held_out_validation: { protocols: validationProtocols.map(x => x.id), accepted_count: materials.length, accepted_waveforms: heldOut.reduce((n, x) => n + x.protocols.length, 0), maximum_stress_nrmse: Math.max(...materials.map(x => x.held_out_waveform_stress_nrmse)), acceptance_threshold: .02,
    scope: 'New protocols and amplitudes not used in fitting, generated by the same SLS constitutive family. This demonstrates synthetic parameter recovery, not biological validation.' },
  materials,
};
readLearnedSceneMaterials(payload);
if (new Set(materials.map(x => x.model_id)).size !== 1 || materials[0].model_id !== payload.model_id) throw new Error('Mixed estimator provenance.');
await fs.mkdir(out, { recursive: true });
const artifacts = {
  'virtamed-materials.json': payload,
  'virtamed-material-observations.json': { schema: 'viscera.synthetic-design-observations/1', scope: payload.scope, model_id: payload.model_id, records: observations },
  'virtamed-material-held-out.json': { schema: 'viscera.synthetic-design-validation/1', scope: payload.held_out_validation.scope, summary: payload.held_out_validation, records: heldOut },
};
for (const [file, value] of Object.entries(artifacts)) await fs.writeFile(path.join(out, file), JSON.stringify(value, null, 2) + '\n');
console.log(JSON.stringify({ accepted: materials.length, held_out: payload.held_out_validation, output: out }));
