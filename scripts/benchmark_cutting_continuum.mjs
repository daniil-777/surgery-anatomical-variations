#!/usr/bin/env node
// CPU-only allocation/parity benchmark. The real reference cage is subjected
// to an authored small deformation and nonzero Maxwell history; no clinical or
// full trajectory performance claim follows from this microbenchmark.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(import.meta.url);
const esbuild = createRequire(require.resolve('vite/package.json'))('esbuild');
const artifact = process.argv[2] ?? path.join(root, 'artifacts/cutting-2026-10-20', `continuum-performance-${Date.now()}.json`);
const loops = Number(process.env.CUTTING_BENCH_LOOPS ?? 60);
if (!Number.isSafeInteger(loops) || loops < 5 || loops > 1000) throw new Error('CUTTING_BENCH_LOOPS must be5–1000');
const sourceFiles = ['apps/studio/src/liverContinuumMaterial.ts', 'apps/studio/src/cutting/continuumEvaluator.ts', 'apps/studio/src/cutting/solver.ts', 'apps/studio/public/cutting/liver-reference.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, sha256(fs.readFileSync(path.join(root, file)))]));
const built = await esbuild.build({ stdin: { contents: `
  export { continuumResponse } from './apps/studio/src/liverContinuumMaterial.ts';
  export { CuttingContinuumEvaluator } from './apps/studio/src/cutting/continuumEvaluator.ts';
  export { LiverCuttingSolver } from './apps/studio/src/cutting/solver.ts';`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', write: false });
const { continuumResponse, CuttingContinuumEvaluator, LiverCuttingSolver } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const mesh = JSON.parse(fs.readFileSync(path.join(root, 'apps/studio/public/cutting/liver-reference.json'), 'utf8'));
const material = { young_pa: 6000, poisson: .4, relaxation_fraction: .4, relaxation_time_s: .7, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const solver = new LiverCuttingSolver(mesh, { bulk: material, cohesive: { fractureEnergyJm2: 2.5, peakTractionPa: 5000 }, gravity: false });
const dt = 1 / 240, cells = solver.cells, positions = solver.positions, prediction = positions.slice();
// Affine deformation is deliberately mild and has a known positive Jacobian.
for (let i = 0; i < positions.length; i += 3) {
  const x = positions[i], y = positions[i + 1], z = positions[i + 2];
  positions[i] = 1.015 * x + .025 * y; positions[i + 1] = .985 * y + .012 * z; positions[i + 2] = 1.005 * z;
}
cells.forEach((cell, index) => { for (let mode = 0; mode < 5; mode++) { cell.state.previous[mode] = .015 * Math.sin(index * .31 + mode); cell.state.memory[mode] = .008 * Math.cos(index * .13 + mode); } });
const evaluator = new CuttingContinuumEvaluator(material, dt), scratchF = new Float64Array(9);
const scratch = { energyDensity: 0, jacobian: 0, stress: new Float64Array(9) };
function deformation(cell, F) {
  F.fill(0);
  for (let j = 1; j < 4; j++) for (let r = 0; r < 3; r++) {
    const difference = positions[3 * cell.ids[j] + r] - positions[3 * cell.ids[0] + r];
    for (let c = 0; c < 3; c++) F[3 * r + c] += difference * cell.gradients[3 * j + c];
  }
}
function assemble(cached) {
  const residual = new Float64Array(positions.length); let energy = 0, minimumJacobian = Infinity;
  for (const cell of cells) {
    const F = cached ? scratchF : new Float64Array(9); deformation(cell, F);
    let response;
    if (cached) { evaluator.evaluate(F, cell.state, scratch); response = scratch; }
    else response = continuumResponse(F, material, cell.state, dt);
    energy += cell.volume * response.energyDensity; minimumJacobian = Math.min(minimumJacobian, response.jacobian);
    for (let j = 0; j < 4; j++) for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) residual[3 * cell.ids[j] + r] += cell.volume * response.stress[3 * r + c] * cell.gradients[3 * j + c];
  }
  return { energy, minimumJacobian, gradient: residual };
}
const original = assemble(false), cached = assemble(true);
let maxGradientError = 0; for (let i = 0; i < original.gradient.length; i++) maxGradientError = Math.max(maxGradientError, Math.abs(original.gradient[i] - cached.gradient[i]));
assert.equal(original.energy, cached.energy); assert.equal(original.minimumJacobian, cached.minimumJacobian); assert(maxGradientError < 1e-10);
let checksum = 0;
function profile(operation, count = loops) {
  for (let warm = 0; warm < 20; warm++) { const result = operation(); checksum += result.energy + result.minimumJacobian; }
  const millisecondsPerCall = [];
  for (let round = 0; round < 7; round++) {
    const started = performance.now();
    for (let i = 0; i < count; i++) { const result = operation(); checksum += result.energy + result.minimumJacobian; }
    millisecondsPerCall.push((performance.now() - started) / count);
  }
  const sorted = [...millisecondsPerCall].sort((a, b) => a - b);
  return { millisecondsPerCall, medianMs: sorted[3], minimumMs: sorted[0], maximumMs: sorted.at(-1), repetitions: count * 7 };
}
function allocations(operation) {
  const Native = globalThis.Float64Array, record = { constructedFloat64Arrays: 0, ownedArrayBuffers: 0, sharedBufferViews: 0, ownedBufferBytes: 0 };
  globalThis.Float64Array = class extends Native {
    constructor(...args) {
      super(...args); record.constructedFloat64Arrays++;
      if (args[0] instanceof ArrayBuffer || args[0] instanceof SharedArrayBuffer) record.sharedBufferViews++;
      else { record.ownedArrayBuffers++; record.ownedBufferBytes += this.byteLength; }
    }
  };
  try { operation(); } finally { globalThis.Float64Array = Native; }
  return record;
}
const originalTiming = profile(() => assemble(false)), cachedTiming = profile(() => assemble(true));
const candidateTiming = profile(() => solver.evaluateCandidate(prediction, dt, true), Math.max(5, Math.floor(loops / 3)));
// This pose deliberately loads the real cap quadrature. It is an authored
// candidate, not a converged/accepted physical state or an accuracy result.
const cap = mesh.cap?.positionsMm ?? mesh.skin.positionsMm;
let topIndex = 1; for (let i = 4; i < cap.length; i += 3) if (cap[i] > cap[topIndex]) topIndex = i;
const activePose = { active: true, tipYMm: cap[topIndex] - 8, centerZMm: cap[topIndex + 1] + 6 };
solver.trialPose = activePose;
const activeOriginal = solver.evaluateCandidate(prediction, dt, true), activeCached = solver.evaluateCandidate(prediction, dt, false);
assert(activeOriginal.maximumContactPenetrationMm > 0, 'authored blade must actually engage cap contact');
const activeErrors = {};
for (const field of ['energy', 'minimumJacobian', 'volume', 'stationarityResidualN', 'fixtureEnergyJ', 'maximumContactPenetrationMm']) {
  activeErrors[field] = activeCached[field] - activeOriginal[field];
  assert(Math.abs(activeErrors[field]) <= 2e-13 * Math.max(1, Math.abs(activeOriginal[field])), `active candidate mismatch: ${field}`);
}
activeErrors.maximumResidualComponentN = Math.max(...activeOriginal.gradient.map((v, i) => Math.abs(v - activeCached.gradient[i])));
activeErrors.maximumContactForceComponentN = Math.max(...activeOriginal.contactForceN.map((v, i) => Math.abs(v - activeCached.contactForceN[i])));
assert(activeErrors.maximumResidualComponentN < 1e-10); assert.equal(activeErrors.maximumContactForceComponentN, 0);
const activeOriginalTiming = profile(() => solver.evaluateCandidate(prediction, dt, true));
const activeCachedTiming = profile(() => solver.evaluateCandidate(prediction, dt, false));
const activeOriginalAllocation = allocations(() => solver.evaluateCandidate(prediction, dt, true));
const activeCachedAllocation = allocations(() => solver.evaluateCandidate(prediction, dt, false));
const originalAllocation = allocations(() => assemble(false)), cachedAllocation = allocations(() => assemble(true));
deformation(cells[0], scratchF);
const originalConstitutiveAllocation = allocations(() => continuumResponse(scratchF, material, cells[0].state, dt));
const cachedConstitutiveAllocation = allocations(() => evaluator.evaluate(scratchF, cells[0].state, scratch));
assert.equal(cachedConstitutiveAllocation.constructedFloat64Arrays, 0);
const result = { status: 'PASS', at: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
  scope: 'Actual reference cage, authored affine strain and nonzero Maxwell history; CPU trial evaluator microbenchmark, not a trajectory speed or clinical validation claim.',
  sourceHashes, nodes: positions.length / 3, cells: cells.length, material, dt,
  parity: { energyError: cached.energy - original.energy, minimumJacobianError: cached.minimumJacobian - original.minimumJacobian, maximumResidualComponentErrorN: maxGradientError },
  timings: { originalContinuumAssembly: originalTiming, cachedContinuumAssembly: cachedTiming, currentGlobalCandidate: candidateTiming, continuumAssemblySpeedup: originalTiming.medianMs / cachedTiming.medianMs },
  activeContactCandidate: { pose: activePose, maximumContactPenetrationMm: activeOriginal.maximumContactPenetrationMm, parity: activeErrors,
    originalTiming: activeOriginalTiming, cachedTiming: activeCachedTiming, speedup: activeOriginalTiming.medianMs / activeCachedTiming.medianMs,
    originalAllocation: activeOriginalAllocation, cachedAllocation: activeCachedAllocation },
  allocationsPerAssembly: { original: originalAllocation, cached: cachedAllocation },
  allocationsPerConstitutiveEvaluation: { original: originalConstitutiveAllocation, cached: cachedConstitutiveAllocation },
  allocationScope: 'Measured Float64Array constructor calls and owned buffer bytes only; does not count ordinary JS objects or engine-internal allocations. Timing measured without instrumentation.', checksum };
for (const file of sourceFiles) assert.equal(sha256(fs.readFileSync(path.join(root, file))), sourceHashes[file], `source changed during benchmark: ${file}`);
fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ artifact, ...result }, null, 2));
