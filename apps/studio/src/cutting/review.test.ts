/** Independent checks of the coupled interface potential and prepared asset. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LiverCuttingSolver } from "./solver";
import { readCuttingReference } from "./reference";
import type { CuttingReference } from "./types";
const bulk = { young_pa: 6000, poisson: .4, relaxation_fraction: .4, relaxation_time_s: .7, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 };
const fixture = (): CuttingReference => ({ schema: "viscera.cutting-reference/v1", source: { templateId: "analytic", sha256: "analytic", attribution: "analytic", license: "CC0" }, positionsMm: [0, 0, 0, 0, 8, 0, 0, 0, 8, -8, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 8, 8, 0, 0], tets: [3, 0, 1, 2, 7, 4, 6, 5], boundaryIndices: [], seamPairs: [0, 1, 2].map(i => ({ left: i, right: i + 4, areaM2: 32e-6 / 3 })), seamLeftIndices: [0, 1, 2], seamRightIndices: [4, 6, 5], skin: { positionsMm: [], indices: [], colors: [], tetIndices: [], weights: [] }, planeXMm: 0, floorYMm: -2, fixedNodes: [3, 7], diagnostics: { originalCageVolumeM3: 2 * .008 ** 3 / 6, splitVolumeM3: 2 * .008 ** 3 / 6, seamAreaM2: 32e-6, embeddingErrorMm: 0, minimumTetVolumeM3: .008 ** 3 / 6 }, limitations: [] });
describe("independent cutting interface review", () => {
  it("differentiates the complete interface potential through softening, unloading and compression", () => {
    // Isolate the interface callback; log-volume bulk corrections are reviewed
    // separately against their full local/global potential.
    const solver = new LiverCuttingSolver(fixture(), { bulk, cohesive: { fractureEnergyJm2: 20, peakTractionPa: 16000 }, gravity: false, equilibriumModel: "stable-neo-hookean" });
    const state = solver as unknown as { positions: Float64Array; external: (id: number, gradient?: Float64Array) => number };
    for (const [gap, history] of [
      [[.0001, 0, 0], 0], [[.001, .0002, -.0001], 0], [[.0004, .0001, .0001], .0018],
      [[-.0003, .0008, .0002], .0002], [[.004, .0001, 0], 0],
    ] as const) {
      solver.maximumOpeningM[0] = history;
      for (let axis = 0; axis < 3; axis++) { state.positions[axis] = -gap[axis]! / 2; state.positions[12 + axis] = gap[axis]! / 2; }
      const left = new Float64Array(3), right = new Float64Array(3);
      state.external(0, left); state.external(4, right);
      expect(Math.hypot(...left.map((v, i) => v + right[i]!))).toBeLessThan(1e-12);
      for (const id of [0, 4]) for (let axis = 0; axis < 3; axis++) {
        const index = 3 * id + axis, original = state.positions[index]!, h = 1e-9;
        state.positions[index] = original - h; const lo = state.external(id);
        state.positions[index] = original + h; const hi = state.external(id);
        state.positions[index] = original;
        expect((hi - lo) / (2 * h)).toBeCloseTo((id === 0 ? left : right)[axis]!, 7);
      }
      expect(solver.maximumOpeningM[0]).toBe(history);
      expect(solver.damage[0]).toBe(0);
    }
  });
  it("uses a single fracture area and paired equal-area faces in the actual liver asset", () => {
    const mesh = readCuttingReference(JSON.parse(readFileSync(new URL("../../public/cutting/liver-reference.json", import.meta.url), "utf8")));
    const positions = mesh.positionsMm;
    const area = (faces: number[]) => {
      let total = 0; const unique = new Set<string>();
      for (let i = 0; i < faces.length; i += 3) {
        const ids = faces.slice(i, i + 3); unique.add(ids.slice().sort((a, b) => a - b).join());
        const a = [0, 1, 2].map(k => (positions[ids[1]! * 3 + k]! - positions[ids[0]! * 3 + k]!) * .001);
        const b = [0, 1, 2].map(k => (positions[ids[2]! * 3 + k]! - positions[ids[0]! * 3 + k]!) * .001);
        total += .5 * Math.hypot(a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!);
      }
      expect(unique.size).toBe(faces.length / 3); return total;
    };
    const physicalArea = mesh.seamPairs.reduce((sum, pair) => sum + pair.areaM2, 0);
    expect(area(mesh.seamLeftIndices)).toBeCloseTo(physicalArea, 13);
    expect(area(mesh.seamRightIndices)).toBeCloseTo(physicalArea, 13);
    const solver = new LiverCuttingSolver(mesh, { bulk, cohesive: { fractureEnergyJm2: 20, peakTractionPa: 16000 }, gravity: false });
    expect(solver.metrics().totalMassKg).toBeCloseTo(mesh.diagnostics.splitVolumeM3 * 1060, 11);
  });
});
