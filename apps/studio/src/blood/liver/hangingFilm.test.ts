import { describe, expect, it } from "vitest";
import { LiverSurfaceFlow, intactLiverFilmGeometry } from "./surfaceFlow";
import type { LiverSurface } from "./types";
import type { VesselLandingEvent } from "../experiments/vesselSolver";

function grid(n: number, length: number, orientation: "up" | "down" | "vertical" = "down"): LiverSurface {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) {
    if (orientation === "vertical") { positions.push(0, -x * length / n, z * length / n); normals.push(1, 0, 0); }
    else { positions.push(x * length / n, 0, z * length / n); normals.push(0, orientation === "down" ? -1 : 1, 0); }
  }
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const a = z * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    if (orientation === "up") indices.push(a, c, b, b, c, d);
    else indices.push(a, b, c, b, d, c);
  }
  return { positionsM: Float64Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
}
function initialise(flow: LiverSurfaceFlow, surface: LiverSurface, heights: (i: number) => number) {
  const initial = flow.snapshot(), owner = new Int32Array(initial.depthM.length).fill(-1);
  surface.indices.forEach((vertex, offset) => { if (owner[vertex] === -1) owner[vertex] = offset; });
  const events: VesselLandingEvent[] = Array.from(initial.vertexAreaM2, (area, vertex) => {
    const offset = owner[vertex]!, corner = offset % 3;
    return { id: vertex, holeId: "analytic-film", timeSeconds: flow.config.fixedDtSeconds,
      volumeM3: area * heights(vertex), velocityMS: [0, 0, 0], supportRadiusM: 0,
      positionM: [surface.positionsM[3 * vertex]!, surface.positionsM[3 * vertex + 1]!, surface.positionsM[3 * vertex + 2]!],
      surface: { triangle: Math.floor(offset / 3), barycentric: [corner === 0 ? 1 : 0, corner === 1 ? 1 : 0, corner === 2 ? 1 : 0] } };
  });
  return flow.step(events);
}
function amplitude(snapshot: ReturnType<LiverSurfaceFlow["snapshot"]>, surface: LiverSurface, k: number) {
  const weights = snapshot.vertexAreaM2;
  const area = weights.reduce((s, a) => s + a, 0);
  const mean = snapshot.filmVolumeM3 / area;
  const cosineMean = weights.reduce((s, a, i) => s + a * Math.cos(k * surface.positionsM[3 * i]!), 0) / area;
  let numerator = 0, denominator = 0;
  for (let i = 0; i < weights.length; i++) {
    const c = Math.cos(k * surface.positionsM[3 * i]!) - cosineMean;
    numerator += weights[i]! * (snapshot.depthM[i]! - mean) * c; denominator += weights[i]! * c * c;
  }
  return numerator / denominator;
}
describe("experimental retained hanging film", () => {
  it("preserves a uniform underside layer and keeps legacy drainage explicitly unchanged", () => {
    const surface = grid(8, .02), retained = new LiverSurfaceFlow(surface, { undersideBoundary: "retain" });
    const legacy = new LiverSurfaceFlow(surface), h = 50e-6;
    const before = initialise(retained, surface, () => h), drained = initialise(legacy, surface, () => h);
    expect(drained.filmVolumeM3).toBe(0); expect(drained.escapedVolumeM3).toBeCloseTo(.02 ** 2 * h, 20);
    for (let i = 0; i < 20; i++) retained.step();
    const after = retained.snapshot();
    expect(after.depthM.every(v => Math.abs(v - h) < 1e-17)).toBe(true);
    expect(after.escapedVolumeM3).toBe(0); expect(after.drainageEvents).toEqual([]);
    expect(after.filmVolumeM3).toBe(before.filmVolumeM3);
    expect(() => new LiverSurfaceFlow(surface, { undersideBoundary: "invalid" as "retain" })).toThrow();
  });

  it("recovers stable and unstable planar dispersion with mass, positivity and spatial convergence", () => {
    const rows = [], rho = 1060, g = 9.81, sigma = .055, mu = .00345, h0 = 50e-6, dt = .0001;
    // Neumann cosine mode over a full wavelength: both normal film slope and
    // pressure flux vanish at the four planar boundaries. No fictitious blood
    // precursor, random perturbation, boundary source or relaxation is used.
    for (const wavelength of [.01, .02]) {
      const k = 2 * Math.PI / wavelength, expected = h0 ** 3 * k * k * (rho * g - sigma * k * k) / (3 * mu);
      const errors: number[] = [];
      for (const n of [16, 32, 64]) {
        const surface = grid(n, wavelength), flow = new LiverSurfaceFlow(surface,
          { undersideBoundary: "retain", fixedDtSeconds: dt, maxSubsteps: 512 });
        const before = initialise(flow, surface, i => h0 * (1 + .001 * Math.cos(k * surface.positionsM[3 * i]!)));
        const a0 = amplitude(before, surface, k);
        for (let step = 0; step < 12; step++) flow.step();
        const after = flow.snapshot(), measured = Math.log(amplitude(after, surface, k) / a0) / (12 * dt);
        const error = Math.abs(measured / expected - 1); errors.push(error);
        expect(Math.sign(measured)).toBe(Math.sign(expected));
        expect(Math.min(...after.depthM)).toBeGreaterThan(0);
        expect(after.escapedVolumeM3).toBe(0);
        expect(Math.abs(after.volumeErrorM3)).toBeLessThan(1e-19);
        expect(Math.abs(after.filmVolumeM3 - before.filmVolumeM3)).toBeLessThan(1e-19);
        // The mode energy changes sign at the same capillary wave number:
        // unstable-mode growth lowers negative hydrostatic+capillary energy.
        const modeEnergy = (a: number) => (sigma * k * k - rho * g) * a * a * wavelength ** 2 / 4;
        expect(modeEnergy(amplitude(after, surface, k))).toBeLessThan(modeEnergy(a0));
        rows.push({ wavelengthMM: wavelength * 1000, cells: n, analyticGrowthPerSecond: expected,
          measuredGrowthPerSecond: measured, relativeError: error, substeps: flow.diagnostics().acceptedSubsteps });
      }
      expect(errors[1]!).toBeLessThan(errors[0]!);
      expect(errors[2]!).toBeLessThan(errors[1]!);
      expect(errors[2]!).toBeLessThan(.02);
    }
    console.info("Retained hanging-film dispersion", JSON.stringify(rows));
  }, 120_000);

  it("retains the independent Nusselt vertical-film mean speed and signed-orientation covariance", () => {
    const surface = grid(16, .04, "vertical"), h = 20e-6;
    const flow = new LiverSurfaceFlow(surface, { undersideBoundary: "retain", surfaceTensionNM: 0 });
    const before = initialise(flow, surface, () => h), after = flow.step();
    const moment = (s: typeof before) => s.depthM.reduce((v, d, i) =>
      v - d * s.vertexAreaM2[i]! * surface.positionsM[3 * i + 1]!, 0) / s.filmVolumeM3;
    const measured = (moment(after) - moment(before)) / flow.config.fixedDtSeconds;
    expect(Math.abs(measured / (1060 * 9.81 * h * h / (3 * .00345)) - 1)).toBeLessThan(1e-7);
    expect(after.escapedVolumeM3).toBe(0);
    const up = grid(8, .02, "up"), down = grid(8, .02, "down");
    const a = new LiverSurfaceFlow(up, { undersideBoundary: "retain", gravityMS2: [0, 9.81, 0] });
    const b = new LiverSurfaceFlow(down, { undersideBoundary: "retain" });
    const wave = (i: number) => 30e-6 * (1 + .01 * Math.cos(2 * Math.PI * up.positionsM[3 * i]! / .02));
    initialise(a, up, wave); initialise(b, down, wave);
    for (let i = 0; i < 5; i++) { a.step(); b.step(); }
    a.snapshot().depthM.forEach((v, i) => expect(v).toBeCloseTo(b.snapshot().depthM[i]!, 16));
  });

  it("preserves depth-limit and unresolved-source-boundary rollback in retained mode", () => {
    const surface = grid(8, .02), flow = new LiverSurfaceFlow(surface,
      { undersideBoundary: "retain", rejectOpenBoundaryContact: true });
    const before = flow.snapshot();
    expect(() => initialise(flow, surface, () => .0001)).toThrow(/open boundary/);
    expect(flow.snapshot()).toEqual(before);
    const bounded = new LiverSurfaceFlow(surface, { undersideBoundary: "retain", maximumDepthM: .00001 });
    expect(() => initialise(bounded, surface, () => .0001)).toThrow(/depth/);
    expect(bounded.snapshot().filmVolumeM3).toBe(0);
  });

  it("copies the authored mask, retains unsupported mass, and exposes exact boundary provenance", () => {
    const surface = grid(8, .02), mask = new Uint8Array(surface.positionsM.length / 3);
    const mixed = new LiverSurfaceFlow(surface), retained = new LiverSurfaceFlow(surface, { undersideBoundary: "retain" });
    mixed.setDrainageEligibility(mask);
    expect(mixed.diagnostics().drainageBoundary).toEqual({ eligibilityMaskEnabled: true, version: 1,
      effectiveOutletVertices: 0, model: "authored-pinning-outlets-with-retained-remainder" });
    mask.fill(1); // Caller mutation must not convert retained blood into an outlet.
    const wave = (i: number) => 30e-6 * (1 + .01 * Math.cos(2 * Math.PI * surface.positionsM[3 * i]! / .02));
    initialise(mixed, surface, wave); initialise(retained, surface, wave);
    for (let i = 0; i < 8; i++) { mixed.step(); retained.step(); }
    expect(mixed.snapshot()).toEqual(retained.snapshot());
    const previous = mixed.snapshot(), metadata = mixed.diagnostics().drainageBoundary, saved = mixed.checkpoint();
    for (const invalid of [new Uint8Array(2), new Uint8Array(mask.length).fill(2)])
      expect(() => mixed.setDrainageEligibility(invalid)).toThrow(/binary canonical/);
    expect(mixed.snapshot()).toEqual(previous); expect(mixed.diagnostics().drainageBoundary).toEqual(metadata);
    mixed.setDrainageEligibility(mask);
    expect(mixed.snapshot()).toEqual(previous); // Setter cannot hide disposal.
    expect(mixed.diagnostics().drainageBoundary.effectiveOutletVertices).toBe(mask.length);
    const after = mixed.step();
    expect(after.filmVolumeM3).toBe(0);
    expect(after.escapedVolumeM3).toBeCloseTo(previous.filmVolumeM3, 20);
    expect(after.drainageEvents).toBeDefined();
    expect(after.drainageEvents!.every(e => e.startTimeSeconds === previous.timeSeconds && e.endTimeSeconds === previous.timeSeconds)).toBe(true);
    mixed.restore(saved);
    expect(mixed.snapshot()).toEqual(previous); expect(mixed.diagnostics().drainageBoundary).toEqual(metadata);
    mixed.step(); retained.step(); expect(mixed.snapshot()).toEqual(retained.snapshot());
    // Explicit retain remains all-retained even if an apparatus mask exists.
    retained.setDrainageEligibility(mask);
    expect(retained.diagnostics().drainageBoundary.effectiveOutletVertices).toBe(0);
    expect(retained.step().escapedVolumeM3).toBe(0);
  });

  it("transfers only eligible outward support and preserves inventory through cut/mask changes", () => {
    const surface = grid(4, .02), mixed = new LiverSurfaceFlow(surface), mask = new Uint8Array(25);
    mask[12] = 1; mixed.setDrainageEligibility(mask);
    const area = mixed.snapshot().vertexAreaM2, h = 20e-6;
    const first = initialise(mixed, surface, () => h);
    expect(first.escapedVolumeM3).toBeCloseTo(area[12]! * h, 22);
    expect(first.drainageEvents).toHaveLength(1);
    expect(first.drainageEvents![0]!.sourceVertex).toBe(12);
    for (let i = 0; i < 8; i++) {
      const s = mixed.step();
      expect(s.depthM.every(v => Number.isFinite(v) && v >= 0)).toBe(true);
      expect(Math.abs(s.filmVolumeM3 + s.escapedVolumeM3 - s.inputVolumeM3)).toBeLessThan(1e-20);
      expect(s.drainageEvents).toBeDefined();
      expect(s.drainageEvents!.every(e => e.sourceVertex === 12)).toBe(true);
    }
    const before = mixed.snapshot(), oldBoundary = mixed.diagnostics().drainageBoundary, checkpoint = mixed.checkpoint();
    const cut = intactLiverFilmGeometry(surface);
    cut.surface.indices = Uint32Array.from(Array.from(cut.surface.indices).filter((_, offset) => {
      const sourceTriangle = Math.floor(offset / 3);
      return !surface.indices.subarray(3 * sourceTriangle, 3 * sourceTriangle + 3).includes(0);
    }));
    mixed.setRetainedGeometry(cut); mixed.setDrainageEligibility(new Uint8Array(25));
    expect(mixed.snapshot().filmVolumeM3).toBeCloseTo(before.filmVolumeM3, 21);
    expect(mixed.snapshot().escapedVolumeM3).toBe(before.escapedVolumeM3);
    expect(mixed.snapshot().timeSeconds).toBe(before.timeSeconds);
    mixed.restore(checkpoint);
    expect(mixed.snapshot()).toEqual(before); expect(mixed.diagnostics().drainageBoundary).toEqual(oldBoundary);
    mixed.setDrainageEligibility(undefined);
    expect(mixed.diagnostics().drainageBoundary.model).toBe("legacy-outward-gravity-drain");
  });
});
