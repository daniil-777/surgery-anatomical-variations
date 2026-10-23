import { describe, expect, it } from "vitest";
import { CollectorFilm, collectorCapillaryGeometry, type CollectorDeposit } from "./collector";

const event = (changes: Partial<CollectorDeposit> = {}): CollectorDeposit => ({
  id: 0, timeSeconds: .002, positionM: [.013, 0, .026], velocityMS: [.8, -1.2, .4], volumeM3: 1e-10, ...changes,
});
function accepted(s: CollectorFilm, events: readonly CollectorDeposit[] = []) {
  const result = s.step(events); expect(result.accepted, result.reason).toBe(true); return result;
}
const sum = (a: ArrayLike<number>) => Array.from(a).reduce((s, v) => s + v, 0);

describe("conservative inertial local collector", () => {
  it("keeps the untouched prewet lake exactly stationary including all wall/corner cells", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 }), initial = s.snapshot();
    for (let i = 0; i < 100; i++) accepted(s);
    const end = s.snapshot();
    expect(end.heightM).toEqual(initial.heightM); expect(end.momentumXM2S.every(v => v === 0)).toBe(true);
    expect(end.momentumZM2S.every(v => v === 0)).toBe(true);
    expect(end.filmVolumeM3).toBeCloseTo(.16 * .2 * 20e-6, 18);
    expect(end.volumeErrorM3).toBe(0); expect(end.dissipatedEnergyJ).toBe(0);
  });
  it("deposits at actual substep time with exact mass, barycentre and horizontal momentum, not a radial kick", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 }), initial = s.snapshot();
    const input = event(), result = accepted(s, [input]), c = s.config, area = c.widthM * c.depthM / (c.nx * c.nz);
    let vx = 0, vz = 0, volume = 0, changed = 0;
    for (let i = 0; i < result.snapshot.heightM.length; i++) {
      const dv = (result.snapshot.heightM[i]! - initial.heightM[i]!) * area;
      if (dv) changed++;
      volume += dv; vx += dv * (c.originXM + (i % c.nx + .5) * c.widthM / c.nx);
      vz += dv * (c.originZM + (Math.floor(i / c.nx) + .5) * c.depthM / c.nz);
    }
    expect(changed).toBe(4); expect(volume).toBeCloseTo(input.volumeM3, 22);
    expect(vx / volume).toBeCloseTo(input.positionM[0], 12); expect(vz / volume).toBeCloseTo(input.positionM[2], 12);
    expect(sum(result.snapshot.momentumXM2S) * area).toBeCloseTo(input.volumeM3 * .8, 22);
    expect(sum(result.snapshot.momentumZM2S) * area).toBeCloseTo(input.volumeM3 * .4, 22);
    expect(result.snapshot.impactDissipatedEnergyJ).toBeGreaterThanOrEqual(.5 * 1060 * input.volumeM3 * 1.2 ** 2);
    expect(result.snapshot.depositedMomentumXKgMS).toBeCloseTo(1060 * input.volumeM3 * .8, 20);
    expect(Math.abs(result.snapshot.energyBalanceErrorJ)).toBeLessThan(1e-20);
    const vertical = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 });
    const onlyVertical = accepted(vertical, [event({ velocityMS: [0, -2, 0] })]).snapshot;
    expect(onlyVertical.momentumXM2S.every(v => v === 0)).toBe(true);
    expect(onlyVertical.momentumZM2S.every(v => v === 0)).toBe(true);
    expect(onlyVertical.impactDissipatedEnergyJ).toBeCloseTo(.5 * 1060 * input.volumeM3 * 4, 20);
  });
  it("accounts for missed impacts separately and never renormalises their volume into the tray", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 }), before = s.snapshot();
    const result = accepted(s, [event({ positionM: [.081, 0, 0] })]).snapshot;
    expect(result.heightM).toEqual(before.heightM); expect(result.escapedVolumeM3).toBe(1e-10);
    expect(result.depositedVolumeM3).toBe(0); expect(result.inputVolumeM3).toBe(1e-10);
    expect(Math.abs(result.volumeErrorM3)).toBeLessThan(1e-22);
  });
  it("keeps local source-work evaluation equal to the full-grid energy change at edges, corners and overlapping hits", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 }), initial = s.snapshot();
    const points: readonly [number, number, number][] = [
      [-.08, 0, -.1], [.08, 0, .1], [-.08, 0, .1], [.08, 0, -.1],
      [0, 0, -.1], [0, 0, .1], [-.08, 0, 0], [.08, 0, 0],
      [.013, 0, .026], [.014, 0, .027], [.012, 0, .025],
    ];
    const result = accepted(s, points.map((positionM, id) => event({ id, positionM,
      volumeM3: (id + 1) * 1e-10, velocityMS: [.02 * id, -.1, -.01 * id] }))).snapshot;
    expect(Math.abs(result.energyJ - initial.energyJ - result.sourceEnergyJ)).toBeLessThan(1e-19);
    expect(Math.abs(result.energyBalanceErrorJ)).toBeLessThan(1e-19);
    expect(Math.abs(result.volumeErrorM3)).toBeLessThan(1e-21);
  });
  it("uses the exact nonlinear graph energy gradient and converges to independently differentiated mean curvature", () => {
    const sigma = .055, length = .02, amplitude = .003, k = 2 * Math.PI / length;
    const errors: number[] = [];
    for (const n of [24, 48, 96]) {
      const dx = length / n, area = dx * dx;
      const h = Float64Array.from({ length: n * n }, (_, i) => {
        const x = (i % n + .5) * dx, z = (Math.floor(i / n) + .5) * dx;
        return .004 + amplitude * Math.cos(k * x) * Math.cos(k * z);
      });
      const result = collectorCapillaryGeometry(h, n, n, dx, dx, sigma);
      let error = 0, scale = 0;
      for (let z = 2; z < n - 2; z++) for (let x = 2; x < n - 2; x++) {
        const xx = (x + .5) * dx, zz = (z + .5) * dx;
        const hx = -amplitude * k * Math.sin(k * xx) * Math.cos(k * zz);
        const hz = -amplitude * k * Math.cos(k * xx) * Math.sin(k * zz);
        const hxx = -amplitude * k * k * Math.cos(k * xx) * Math.cos(k * zz), hzz = hxx;
        const hxz = amplitude * k * k * Math.sin(k * xx) * Math.sin(k * zz);
        const exact = -sigma * ((1 + hz * hz) * hxx - 2 * hx * hz * hxz + (1 + hx * hx) * hzz)
          / (1 + hx * hx + hz * hz) ** 1.5;
        error += (result.pressurePa[z * n + x]! - exact) ** 2; scale += exact ** 2;
      }
      errors.push(Math.sqrt(error / scale));
      // Independent directional finite difference of the total area energy,
      // including wall and corner variations, must equal integral p * delta h.
      const perturbation = Float64Array.from(h, (_, i) => Math.sin(1.73 * i) + .3 * Math.cos(.51 * i));
      const epsilon = 2e-10;
      const plus = collectorCapillaryGeometry(Float64Array.from(h, (v, i) => v + epsilon * perturbation[i]!), n, n, dx, dx, sigma).energyJ;
      const minus = collectorCapillaryGeometry(Float64Array.from(h, (v, i) => v - epsilon * perturbation[i]!), n, n, dx, dx, sigma).energyJ;
      const derivative = sum(Float64Array.from(result.pressurePa, (v, i) => v * perturbation[i]!)) * area;
      expect(Math.abs((plus - minus) / (2 * epsilon) - derivative)).toBeLessThan(2e-10);
      expect(Math.abs(sum(result.pressurePa) * area)).toBeLessThan(2e-16);
    }
    expect(errors[1]!).toBeLessThan(errors[0]! * .35);
    expect(errors[2]!).toBeLessThan(errors[1]! * .35);
    expect(errors[2]!).toBeLessThan(.002);
    console.info("Nonlinear capillary curvature relative L2", JSON.stringify(errors));
  });
  it("converges to independent linear gravity and gravity-capillary wave dispersion", () => {
    for (const sigma of [0, .05]) {
      const length = sigma ? .016 : .16, mean = sigma ? .0001 : .001, amplitude = mean * 1e-4;
      const time = sigma ? .05 : .3, dt = .0005, k = Math.PI / length;
      const omega = Math.sqrt(9.81 * mean * k * k + sigma * mean / 1060 * k ** 4);
      const expectedAmplitude = amplitude * Math.cos(omega * time), errors: number[] = [];
      for (const nx of [32, 64, 128]) {
        const nz = 8, initial = Float64Array.from({ length: nx * nz }, (_, i) =>
          mean + amplitude * Math.cos(k * (i % nx + .5) * length / nx));
        const s = new CollectorFilm({ nx, nz, widthM: length, depthM: sigma ? .016 : .02,
          viscosityPaS: 0, surfaceTensionNm: sigma, dtSeconds: dt }, initial);
        for (let i = 0; i < Math.round(time / dt); i++) accepted(s);
        const state = s.snapshot(); let projection = 0, norm = 0;
        for (let i = 0; i < state.heightM.length; i++) {
          const w = Math.cos(k * (i % nx + .5) * length / nx);
          projection += (state.heightM[i]! - mean) * w; norm += w * w;
        }
        errors.push(Math.abs(projection / norm - expectedAmplitude) / amplitude);
      }
      expect(errors[1]!).toBeLessThan(errors[0]! * .7);
      expect(errors[2]!).toBeLessThan(errors[1]! * .7);
      expect(errors[2]!).toBeLessThan(.03);
    }
  }, 20000);
  it("converges to an independent wet-bed dam-break Riemann solution before wall reflection", () => {
    const g = 9.81, left = .0011, right = .0009, length = .16, time = .2, dt = .0005;
    let lo = right, hi = left;
    for (let i = 0; i < 70; i++) {
      const h = (lo + hi) / 2, rarefaction = 2 * (Math.sqrt(g * left) - Math.sqrt(g * h));
      const shock = (h - right) * Math.sqrt(.5 * g * (1 / h + 1 / right));
      if (rarefaction > shock) lo = h; else hi = h;
    }
    const middle = (lo + hi) / 2, velocity = 2 * (Math.sqrt(g * left) - Math.sqrt(g * middle));
    const shockSpeed = middle * velocity / (middle - right);
    const exact = (x: number) => {
      const xi = (x - length / 2) / time;
      if (xi <= -Math.sqrt(g * left)) return left;
      if (xi < velocity - Math.sqrt(g * middle)) return (2 * Math.sqrt(g * left) - xi) ** 2 / (9 * g);
      return xi < shockSpeed ? middle : right;
    };
    const errors: number[] = [];
    for (const nx of [32, 64, 128]) {
      const nz = 8, s = new CollectorFilm({ nx, nz, widthM: length, depthM: .02,
        viscosityPaS: 0, surfaceTensionNm: 0, dtSeconds: dt },
      Float64Array.from({ length: nx * nz }, (_, i) => i % nx < nx / 2 ? left : right));
      for (let i = 0; i < Math.round(time / dt); i++) accepted(s);
      const state = s.snapshot(); let error = 0;
      for (let x = 0; x < nx; x++) {
        let average = 0;
        for (let q = 0; q < 32; q++) average += exact((x + (q + .5) / 32) * length / nx) / 32;
        error += Math.abs(state.heightM[x]! - average) / nx;
      }
      errors.push(error); expect(Math.abs(state.volumeErrorM3)).toBeLessThan(1e-18);
    }
    expect(errors[1]!).toBeLessThan(errors[0]! * .8);
    expect(errors[2]!).toBeLessThan(errors[1]! * .8);
  }, 20000);
  it("respects symmetry, positivity, and dissipative evolution, with viscosity affecting resolved motion", () => {
    const n = 32, initial = Float64Array.from({ length: n * n }, (_, i) => {
      const x = ((i % n) + .5) / n - .5, z = (Math.floor(i / n) + .5) / n - .5;
      return 30e-6 + 150e-6 * Math.exp(-80 * (x * x + z * z));
    });
    const peaks: number[] = [], kinetic: number[] = [];
    for (const viscosityPaS of [.00345, .03]) {
      const s = new CollectorFilm({ nx: n, nz: n, widthM: .02, depthM: .02, viscosityPaS, dtSeconds: .001 }, initial);
      let energy = s.snapshot().energyJ;
      for (let i = 0; i < 100; i++) {
        const r = accepted(s); expect(r.snapshot.energyJ).toBeLessThanOrEqual(energy * (1 + 3e-12));
        energy = r.snapshot.energyJ; expect(r.telemetry.minimumHeightM).toBeGreaterThan(0);
      }
      const h = s.snapshot();
      for (let z = 0; z < n; z++) for (let x = 0; x < n; x++)
        expect(h.heightM[z * n + x]!).toBeCloseTo(h.heightM[z * n + n - x - 1]!, 13);
      peaks.push(Math.max(...h.heightM));
      kinetic.push(sum(Float64Array.from(h.heightM, (v, i) => (h.momentumXM2S[i]! ** 2 + h.momentumZM2S[i]! ** 2) / v)));
      expect(Math.abs(h.volumeErrorM3)).toBeLessThan(1e-21); expect(Math.abs(h.energyBalanceErrorJ)).toBeLessThan(1e-19);
    }
    expect(peaks[1]!).toBeGreaterThan(peaks[0]!); expect(kinetic[1]!).toBeLessThan(kinetic[0]!);
  });
  it("relaxes a steep single-valued graph without clipping height or adding energy", () => {
    const n = 48, initial = Float64Array.from({ length: n * n }, (_, i) => {
      const x = ((i % n) + .5) / n - .5, z = (Math.floor(i / n) + .5) / n - .5;
      return 30e-6 + .0015 * Math.exp(-160 * (x * x + z * z));
    });
    const s = new CollectorFilm({ nx: n, nz: n, widthM: .02, depthM: .02, viscosityPaS: .00345, dtSeconds: .0002 }, initial);
    const before = s.snapshot(); expect(before.steepFrontWarning).toBe(true);
    let energy = before.energyJ;
    for (let i = 0; i < 250; i++) {
      const r = accepted(s);
      expect(r.snapshot.energyJ).toBeLessThanOrEqual(energy * (1 + 3e-12)); energy = r.snapshot.energyJ;
      expect(r.telemetry.minimumHeightM).toBeGreaterThan(0);
    }
    const end = s.snapshot();
    expect(end.energyJ).toBeLessThan(before.energyJ * .9);
    expect(Math.abs(end.volumeErrorM3)).toBeLessThan(1e-20);
    expect(Math.abs(end.energyBalanceErrorJ)).toBeLessThan(1e-18);
    expect(Math.max(...end.heightM)).toBeLessThan(Math.max(...initial));
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++)
      expect(end.heightM[z * n + x]!).toBeCloseTo(end.heightM[z * n + n - x - 1]!, 12);
  }, 20000);
  it("rejects invalid, duplicate, unresolved and over-budget inputs transactionally and supports safe composition", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 }), before = s.snapshot();
    const prepared = s.prepareStep([event()]); expect(prepared.accepted).toBe(true); expect(s.snapshot()).toEqual(before);
    prepared.snapshot.heightM.fill(NaN); prepared.commit();
    expect(s.snapshot().heightM.every(Number.isFinite)).toBe(true); expect(() => prepared.commit()).toThrow();
    const checkpoint = s.checkpoint(), saved = s.snapshot();
    accepted(s, [event({ id: 1, timeSeconds: .004 })]); s.restore(checkpoint);
    expect(s.snapshot()).toEqual(saved);
    expect(() => s.restore(checkpoint)).toThrow(); expect(() => s.restore(new CollectorFilm().checkpoint())).toThrow();
    accepted(s, [event({ id: 1, timeSeconds: .004 })]);
    const current = s.snapshot();
    for (const e of [event({ id: 1, timeSeconds: .006 }), event({ id: 2, timeSeconds: .004, volumeM3: 1e-5 }),
      event({ id: 3, timeSeconds: .009 }), event({ id: 4, timeSeconds: .006, velocityMS: [NaN, 0, 0] })]) {
      const result = s.step([e]); expect(result.accepted).toBe(false); expect(s.snapshot()).toEqual(current);
    }
    const old = s.prepareStep(); s.prepareStep(); expect(() => old.commit()).toThrow(/Stale/);
    const budget = new CollectorFilm({ maxSubsteps: 1, dtSeconds: .002 });
    expect(budget.step([event({ timeSeconds: .001 })]).accepted).toBe(false);
    expect(budget.timeSeconds).toBe(0); expect(budget.snapshot().inputVolumeM3).toBe(0);
  });
  it("accepts localized arterial-scale sources with actual horizontal momentum and finite 64² work", () => {
    const runs: unknown[] = [];
    for (const viscosityPaS of [.00345, .03]) {
      const s = new CollectorFilm({ viscosityPaS, dtSeconds: .002 });
      let maximumSubsteps = 0, maximumSlope = 0, maximumCourant = 0, maximumError = 0;
      for (let i = 0; i < 250; i++) {
        const result = accepted(s, [event({ id: i, timeSeconds: (i + .5) * .002,
          positionM: [0, 0, .025], velocityMS: [0, -1.5, 1.5], volumeM3: 2e-6 * .002 })]);
        maximumSubsteps = Math.max(maximumSubsteps, result.telemetry.substeps);
        maximumSlope = Math.max(maximumSlope, result.telemetry.maxSlope);
        maximumCourant = Math.max(maximumCourant, result.telemetry.maxCourant);
        maximumError = Math.max(maximumError, Math.abs(result.telemetry.relativeVolumeError));
      }
      expect(s.timeSeconds).toBe(.5); expect(maximumSubsteps).toBeLessThan(32);
      expect(Number.isFinite(maximumSlope)).toBe(true); expect(maximumCourant).toBeLessThanOrEqual(.3);
      expect(s.snapshot().steepFrontWarning).toBe(s.snapshot().maxSlope > s.config.maxSlope);
      expect(Math.max(...s.snapshot().heightM)).toBeLessThan(.1 * Math.min(s.config.widthM, s.config.depthM));
      expect(maximumError).toBeLessThan(2e-10);
      runs.push({ viscosityPaS, maximumSubsteps, maximumSlope, maximumCourant, maximumError });
    }
    console.info("Collector source envelope", JSON.stringify(runs));
  }, 20000);
});
