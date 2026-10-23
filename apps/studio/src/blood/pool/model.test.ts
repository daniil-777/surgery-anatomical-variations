import { describe, expect, it } from "vitest";
import {
  applyDeposit, applyInstrumentMove, BLOOD_SURFACE_TENSION, cellCentreM, createPoolState, DEFAULT_POOL_CONFIG, depositAmplitude,
  derivePoolScheme, discreteModeFrequency, poolFluidVolumeM3, poolValidity, stepPool, submergedChordM, tateDropVolumeM3,
  validatePoolConfig, type PoolConfig,
} from "./model";
import { buildPoolOpticsLut, equivalentWholeBloodThicknessM, POOL_OPTICS_ENTRIES, poolOpticsThicknessM } from "./optics";

const config = (change: Partial<PoolConfig> = {}): PoolConfig => ({ ...DEFAULT_POOL_CONFIG, ...change });

describe("blood pool scheme (SI mapping of the webgpu-water update)", () => {
  it("derives Δt from the shallow-water speed at the requested Courant number", () => {
    const c = config(), s = derivePoolScheme(c);
    expect(s.dxM).toBeCloseTo(.08 / 256, 15);
    expect(s.waveSpeedMS).toBeCloseTo(Math.sqrt(9.80665 * .005), 12);
    expect(s.waveSpeedMS * s.dtSeconds / s.dxM).toBeCloseTo(Math.sqrt(.4), 12);
    expect(s.dampPerStep).toBeCloseTo(Math.exp(-s.frictionPerSecond * s.dtSeconds), 15);
    expect(s.laminarFrictionPerSecond).toBeCloseTo(3 * (.00345 / 1060) / .005 ** 2, 12);
    // The kernel is the upstream form: C² multiplies (Σ neighbours − 4h).
    expect(derivePoolScheme(config({ courantSquared: .45 })).courant).toBeCloseTo(Math.sqrt(.45), 15);
  });
  it("rejects unstable or unsupported inputs instead of clamping them", () => {
    expect(() => validatePoolConfig(config({ courantSquared: .51 }))).toThrow(RangeError);
    expect(() => validatePoolConfig(config({ depthM: .02 }))).toThrow(RangeError);
    expect(() => validatePoolConfig(config({ grid: 100 as never }))).toThrow(RangeError);
    expect(() => validatePoolConfig(config({ bloodFraction: 0 }))).toThrow(RangeError);
    expect(() => validatePoolConfig(config({ viscosityPaS: Number.NaN }))).toThrow(RangeError);
  });
  it("uses Tate's law for the detaching drop volume", () => {
    const v = tateDropVolumeM3(.0005, BLOOD_SURFACE_TENSION, 1060, 9.80665);
    expect(v).toBeCloseTo(2 * Math.PI * .0005 * BLOOD_SURFACE_TENSION / (1060 * 9.80665), 18);
    expect(v * 1e9).toBeGreaterThan(14); expect(v * 1e9).toBeLessThan(18); // ≈ 16 µL
  });
});

describe("conservation", () => {
  const small = config({ grid: 128, lengthM: .06 });
  const s = derivePoolScheme(small);
  it("adds exactly the deposited volume, including a deposit truncated by a wall", () => {
    for (const [x, z] of [[0, 0], [.029, -.0295]] as const) {
      const state = createPoolState(s.n), amplitude = depositAmplitude(s, small.depthM, x, z, s.depositRadiusM, s.dropVolumeM3);
      const before = poolFluidVolumeM3(state, s, small.depthM);
      applyDeposit(state, s, x, z, s.depositRadiusM, amplitude);
      expect(poolFluidVolumeM3(state, s, small.depthM) - before).toBeCloseTo(s.dropVolumeM3, 18);
    }
  });
  it("conserves fluid volume through propagation, damping and instrument motion", () => {
    const state = createPoolState(s.n), scratch = createPoolState(s.n);
    applyDeposit(state, s, .01, -.005, s.depositRadiusM, depositAmplitude(s, small.depthM, .01, -.005, s.depositRadiusM, s.dropVolumeM3));
    let instrument: [number, number, number] = [-.01, small.depthM + small.instrumentRadiusM, 0];
    const initial = poolFluidVolumeM3(state, s, small.depthM, { centre: instrument, radiusM: small.instrumentRadiusM });
    let a = state, b = scratch;
    for (let k = 0; k < 400; k++) {
      if (k % 10 === 0) {
        const next: [number, number, number] = [-.01 + k * 4e-5, small.depthM + small.instrumentRadiusM * (1 - Math.min(1, k / 100) * 1.2), 0];
        applyInstrumentMove(a, s, small.depthM, instrument, next, small.instrumentRadiusM); instrument = next;
      }
      [a, b] = [stepPool(a, s, small.courantSquared, b), a];
    }
    const final = poolFluidVolumeM3(a, s, small.depthM, { centre: instrument, radiusM: small.instrumentRadiusM });
    expect(Math.abs(final - initial) / initial).toBeLessThan(1e-12);
    expect(Math.max(...a.h.map(Math.abs))).toBeGreaterThan(1e-4); // waves actually exist
  });
  it("computes the submerged chord of the instrument inside the fluid slab", () => {
    expect(submergedChordM(.006, .004, .005, .004)).toBe(0);
    expect(submergedChordM(0, .002, .001, .004)).toBeCloseTo(.002, 15);      // fully submerged
    expect(submergedChordM(0, .008, .005, .004)).toBeCloseTo(.001, 15);      // tip dipping 1 mm
    expect(submergedChordM(0, .002, .005, .004)).toBeCloseTo(.004, 15);      // spans the full depth
  });
});

describe("wave physics", () => {
  const c = config({ grid: 128, lengthM: .06, damping: "laminar" }), s = derivePoolScheme(c);
  const runMode = (m: number, steps: number, damp: number) => {
    const scheme = { ...s, dampPerStep: damp }, state = createPoolState(s.n), k = Math.PI * m / c.lengthM;
    for (let j = 0; j < s.n; j++) for (let i = 0; i < s.n; i++) state.h[j * s.n + i] = 1e-3 * Math.cos(k * (cellCentreM(i, s) + c.lengthM / 2));
    const trace: number[] = []; let a = state, b = createPoolState(s.n);
    for (let n = 0; n < steps; n++) { [a, b] = [stepPool(a, scheme, c.courantSquared, b), a]; trace.push(a.h[0]!); }
    return { trace, k };
  };
  it("propagates long waves at √(gH) and matches the discrete dispersion relation", () => {
    const { trace, k } = runMode(2, 4000, 1);
    // Zero crossings give the period.
    const crossings: number[] = [];
    for (let i = 1; i < trace.length; i++) if (Math.sign(trace[i]!) !== Math.sign(trace[i - 1]!)) crossings.push(i - 1 + trace[i - 1]! / (trace[i - 1]! - trace[i]!));
    const period = 2 * (crossings.at(-1)! - crossings[0]!) / (crossings.length - 1) * s.dtSeconds, omega = 2 * Math.PI / period;
    expect(omega / discreteModeFrequency(s, c.courantSquared, k, 0)).toBeCloseTo(1, 4);
    expect(omega / (s.waveSpeedMS * k)).toBeCloseTo(1, 3);
  });
  it("damps mode amplitude as e^{-λt/2}", () => {
    const steps = 3000, { trace } = runMode(2, steps, s.dampPerStep), undamped = runMode(2, steps, 1).trace;
    let peak = steps - 400;
    for (let i = peak; i < steps; i++) if (Math.abs(undamped[i]!) > Math.abs(undamped[peak]!)) peak = i;
    const expected = Math.exp(-s.frictionPerSecond * (peak + 1) * s.dtSeconds / 2);
    expect(Math.abs(trace[peak]! / undamped[peak]! / expected - 1)).toBeLessThan(.01);
  });
  const checkerboard = (courantSquared: number) => {
    const scheme = { ...derivePoolScheme(config({ grid: 128 })), dampPerStep: 1 }, state = createPoolState(128);
    for (let j = 0; j < 128; j++) for (let i = 0; i < 128; i++) state.h[j * 128 + i] = ((i + j) % 2 ? 1 : -1) * 1e-4;
    let a = state, b = createPoolState(128), peak = 0;
    for (let n = 0; n < 4000; n++) {
      [a, b] = [stepPool(a, scheme, courantSquared, b), a];
      if (n % 50 === 49) { let q = 0; for (const v of a.h) q += v * v; peak = Math.max(peak, Math.sqrt(q / a.h.length)); }
    }
    return peak / 1e-4;
  };
  it("keeps the highest grid mode bounded at the supported Courant limit", () => {
    // Per-mode bound for an h-only start: √(1 + (μ/2)²/sin²θ), μ = 8C², cosθ = 1 − μ/2.
    const mu = 8 * .45, theta = Math.acos(1 - mu / 2), bound = Math.sqrt(1 + (mu / 2) ** 2 / Math.sin(theta) ** 2);
    expect(checkerboard(.45)).toBeLessThanOrEqual(bound + 1e-9);
  });
  it("documents why the upstream C² = 0.5 is not accepted: near-double-root growth", () => {
    expect(checkerboard(.5)).toBeGreaterThan(20);
    expect(() => validatePoolConfig(config({ courantSquared: .5 }))).toThrow(RangeError);
  });
  it("reports dispersion, capillary and friction indicators honestly", () => {
    const v = poolValidity(config({ damping: "laminar" }), derivePoolScheme(config({ damping: "laminar" })));
    expect(v.status).toBe("outside-indicators");
    expect(v.dispersionSpeedRatio).toBeLessThan(1);
    expect(v.notes.some(n => n.includes("Surface tension"))).toBe(true);
    expect(v.notes.some(n => n.includes("under-damps"))).toBe(true);
    const stokes = derivePoolScheme(config());
    expect(stokes.frictionPerSecond).toBeGreaterThan(stokes.laminarFrictionPerSecond);
  });
});

describe("pool optics", () => {
  it("builds a monotone spectral slab LUT from the shared blood appearance model", () => {
    const lut = buildPoolOpticsLut(.75);
    expect(lut.length).toBe(POOL_OPTICS_ENTRIES * 8);
    const t = (i: number, ch: number) => lut[(POOL_OPTICS_ENTRIES + i) * 4 + ch]!;
    for (let i = 1; i < POOL_OPTICS_ENTRIES; i++) for (let ch = 0; ch < 3; ch++) expect(t(i, ch)).toBeLessThanOrEqual(t(i - 1, ch) + 1e-6);
    // Red survives far longer than green in whole blood.
    const mm = Array.from({ length: POOL_OPTICS_ENTRIES }, (_, i) => i).find(i => poolOpticsThicknessM(i) >= .0005)!;
    expect(t(mm, 0)).toBeGreaterThan(10 * t(mm, 1));
    expect(lut.every(Number.isFinite)).toBe(true);
  });
  it("maps saline dilution to an equivalent whole-blood thickness", () => {
    expect(equivalentWholeBloodThicknessM(.004, .1)).toBeCloseTo(.0004, 15);
    expect(() => equivalentWholeBloodThicknessM(.004, 0)).toThrow(RangeError);
  });
});
