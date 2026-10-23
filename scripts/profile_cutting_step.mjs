#!/usr/bin/env node
// CPU-only full-step profile with real warm-up history. No GPU or product hooks.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Session } from 'node:inspector/promises';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const artifact = process.argv[2] ?? path.join(root, 'artifacts/cutting-2026-10-20', `step-profile-${Date.now()}.json`);
const hotCountersEnabled = process.env.CUTTING_PROFILE_COUNTS === '1';
const sourceFiles = ['apps/studio/src/liverContinuumMaterial.ts', 'apps/studio/src/cutting/continuumEvaluator.ts', 'apps/studio/src/cutting/solver.ts', 'apps/studio/src/cutting/minimize.ts', 'apps/studio/src/cutting/preconditioner.ts', 'apps/studio/src/cutting/cohesive.ts', 'apps/studio/src/cutting/contactQuadrature.ts', 'apps/studio/src/cutting/types.ts', 'apps/studio/public/cutting/liver-reference.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
const bundled = await esbuild.build({ stdin: { contents: "export { LiverCuttingSolver } from './apps/studio/src/cutting/solver.ts';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false });
// One frozen bundle remains the subject even if other agents edit their lanes.
const bundle = bundled.outputFiles[0].text, bundleHash = sha256(bundle);
const { LiverCuttingSolver } = await import(`data:text/javascript;base64,${Buffer.from(bundle).toString('base64')}`);
const mesh = JSON.parse(fs.readFileSync(path.join(root, 'apps/studio/public/cutting/liver-reference.json'), 'utf8'));
const bulk = { young_pa: 4800, poisson: .45, relaxation_fraction: .42, relaxation_time_s: .65, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const solver = new LiverCuttingSolver(mesh, { bulk, cohesive: { fractureEnergyJm2: 2.5, peakTractionPa: 5000 }, gravity: false });
const cap = mesh.cap.positionsMm;
let topIndex = 1; for (let i = 4; i < cap.length; i += 3) if (cap[i] > cap[topIndex]) topIndex = i;
const top = cap[topIndex], z = cap[topIndex + 1], dt = 1 / 240;
const positionTarget = { active: false, tipYMm: top + 3, centerZMm: z };
solver.setScalpelTarget(positionTarget);
const warmupStarted = performance.now(); let positioningSteps = 0, contactSteps = 0;
while (Math.hypot(solver.scalpelPose().tipYMm - positionTarget.tipYMm, solver.scalpelPose().centerZMm - z) > 1e-8) {
  assert(++positioningSteps < 1000, 'positioning must remain bounded');
  assert(solver.step(dt), `positioning failed: ${solver.metrics().lastError}`);
}
const contactStart = solver.metrics().timeSeconds;
solver.setScalpelTarget({ active: true, tipYMm: top - 12, centerZMm: z });
while (solver.metrics().timeSeconds - contactStart < .15 - 1e-10) {
  assert(++contactSteps < 1000, 'warm contact trajectory must remain bounded');
  assert(solver.step(dt), `warm contact trajectory failed: ${solver.metrics().lastError}`);
}
console.log(JSON.stringify({ stage: 'warmup-complete', wallSeconds: (performance.now() - warmupStarted) / 1000, positioningSteps, contactSteps, pose: solver.scalpelPose(), metrics: solver.metrics() }));

// Time only coarse operations; hot callbacks receive counters rather than a
// clock read at every quadrature sample. Nested elapsed values are inclusive.
let context = 'other'; const timings = {}, counts = {};
function counted(object, name) {
  const original = object[name];
  object[name] = function (...args) { const key = `${context}.${name}`; counts[key] = (counts[key] ?? 0) + 1; return original.apply(this, args); };
}
function timed(object, name, label = name, transform) {
  const original = object[name];
  object[name] = function (...args) {
    const parent = context, key = typeof label === 'function' ? label(args) : label;
    context = key; const started = performance.now();
    try { const value = original.apply(this, args); return transform ? transform(value) : value; }
    finally { const entry = timings[key] ??= { calls: 0, milliseconds: 0 }; entry.calls++; entry.milliseconds += performance.now() - started; context = parent; }
  };
}
timed(solver.continuum, 'solveVertices', 'vbdSweep');
timed(solver.continuum, 'beginStep', 'beginMaterialStep');
timed(solver.continuum, 'commit', 'commitMaterialHistory');
timed(solver, 'evaluateCandidate', args => args[2] === false ? 'trialCandidate' : 'finalCandidate');
timed(solver, 'attemptStep', 'attemptStep');
timed(solver, 'preconditioner', 'preconditionerBuild', result => {
  timed(result, 'applyInverse', 'preconditionerPCG'); return result;
});
if (hotCountersEnabled) { counted(solver, 'external'); counted(solver, 'sampleContact'); counted(solver.continuum, 'deformation'); }
const beforeMetrics = solver.metrics(), beforeLocalDiagnostics = solver.continuum.diagnostics(), beforePose = solver.scalpelPose();
const session = new Session(); session.connect(); await session.post('Profiler.enable'); await session.post('Profiler.setSamplingInterval', { interval: 1000 }); await session.post('Profiler.start');
const stepResults = [], started = performance.now();
for (let step = 0; step < 3; step++) {
  const start = performance.now(), accepted = solver.step(dt);
  stepResults.push({ accepted, wallMilliseconds: performance.now() - start, pose: solver.scalpelPose(), metrics: solver.metrics() });
  if (!accepted) break;
}
const elapsedMilliseconds = performance.now() - started;
const { profile } = await session.post('Profiler.stop'); session.disconnect();
const afterLocalDiagnostics = solver.continuum.diagnostics();
const localDelta = Object.fromEntries(['lineSearchBacktracks', 'volumeLimits', 'rejectedVertexUpdates'].map(key => [key, afterLocalDiagnostics[key] - beforeLocalDiagnostics[key]]));
const nodeById = new Map(profile.nodes.map(node => [node.id, node])), samplesByFunction = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const node = nodeById.get(profile.samples[i]), name = node.callFrame.functionName || '(anonymous)';
  samplesByFunction.set(name, (samplesByFunction.get(name) ?? 0) + profile.timeDeltas[i]);
}
const selfSamples = [...samplesByFunction].map(([name, microseconds]) => ({ name, selfMilliseconds: microseconds / 1000, fraction: microseconds / (profile.endTime - profile.startTime) })).sort((a, b) => b.selfMilliseconds - a.selfMilliseconds).slice(0, 25);
const currentSourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
const result = { status: stepResults.every(step => step.accepted) ? 'PASS' : 'STEP_REJECTED', at: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
  scope: 'Actual reference mesh and default UI material; real zero-gravity accepted warm-up history, then three loaded steps. Timings include profiler/counter overhead; no browser or real-time claim.',
  sourceHashes, currentSourceHashes, sourcesUnchanged: sourceFiles.every(file => sourceHashes[file] === currentSourceHashes[file]), bundleHash,
  nodes: solver.masses.length, cells: solver.cells.length, contactSamples: solver.contactQuadrature.samples.length,
  bulk, dt, warming: { positioningSteps, contactSteps, contactSeconds: beforeMetrics.timeSeconds - contactStart }, beforeMetrics, beforePose,
  elapsedMilliseconds, hotCountersEnabled, timings, counts, localLineSearchDiagnostics: localDelta, stepResults, cpuSelfSamples: selfSamples };
fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(result, null, 2));
fs.writeFileSync(artifact.replace(/\.json$/, '.cpuprofile'), JSON.stringify(profile));
fs.writeFileSync(artifact.replace(/\.json$/, '.bundle.mjs'), bundle);
console.log(JSON.stringify({ artifact, ...result }, null, 2));
