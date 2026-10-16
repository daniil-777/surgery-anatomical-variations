/** Numerical/performance comparison of the prior and current interpolation
 * kernels on a synthetic dense torso lattice. Not an end-to-end FPS measure.
 * Run with Node 24 (native TypeScript stripping), from viscera. */
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { WholeScenePhysics } from "../../apps/studio/src/wholeScenePhysics.ts";

const source = JSON.parse(await readFile(new URL("../../apps/studio/public/anatomy-scene/learned-materials.json", import.meta.url), "utf8"));
const organs = [
  { id: "liver", category: "digestive", bounds: { min: [-130, -100, -20], max: [45, 30, 90] } },
  { id: "stomach", category: "digestive", bounds: { min: [10, -140, -40], max: [120, 30, 70] } },
  { id: "left-lung", category: "respiratory", bounds: { min: [0, 40, -60], max: [110, 290, 60] } },
  { id: "skeleton", category: "skeleton", bounds: { min: [-140, -260, -100], max: [140, 300, 90] } },
];
const solver = new WholeScenePhysics(organs, source);
const vertices = 392000, rest = new Float32Array(vertices * 3);
for (let v = 0; v < vertices; v++) {
  rest[v * 3] = -125 + (v % 100) * 2.5;
  rest[v * 3 + 1] = -250 + (Math.floor(v / 100) % 280) * 1.95;
  rest[v * 3 + 2] = -70 + (Math.floor(v / 28000) % 14) * 10;
}
const binding = solver.bind(rest), oldOut = new Float32Array(rest.length), newOut = new Float32Array(rest.length);
solver.pulse("liver");
for (let step = 0; step < 33; step++) solver.step(1 / 120, true);
// Read the existing field only; no model parameters or state are changed here.
const lattice = solver.lattice;
function previousKernel() {
  oldOut.set(rest);
  for (let v = 0; v < binding.vertices; v++) for (let c = 0; c < 8; c++) {
    const id = binding.indices[v * 8 + c] * 3, w = binding.weights[v * 8 + c];
    for (let a = 0; a < 3; a++) oldOut[v * 3 + a] += lattice[id + a] * w;
  }
}
function currentKernel() { solver.deform(rest, newOut, binding); }
for (let warm = 0; warm < 3; warm++) { previousKernel(); currentKernel(); }
const prior = [], current = [];
for (let repeat = 0; repeat < 12; repeat++) {
  let start = performance.now(); previousKernel(); prior.push(performance.now() - start);
  start = performance.now(); currentKernel(); current.push(performance.now() - start);
}
let maxDifference = 0;
for (let i = 0; i < rest.length; i++) maxDifference = Math.max(maxDifference, Math.abs(oldOut[i] - newOut[i]));
if (maxDifference > .00025 || !newOut.every(Number.isFinite)) throw new Error("Interpolation comparison exceeded the floating-point tolerance.");
const median = samples => [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];
const report = {
  scope: "Synthetic 392,000-vertex CPU interpolation microbenchmark; not actual scene FPS or mechanical calibration.",
  node: process.version, vertices, repetitions: 12, maximum_coordinate_difference_mm: maxDifference,
  prior_median_ms: median(prior), optimized_median_ms: median(current), speedup: median(prior) / median(current),
  prior_ms: prior, optimized_ms: current,
};
await writeFile(new URL("../../benchmarks/results/whole-scene-quality-2026-10-08/deformation-kernel-benchmark.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
