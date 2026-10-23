import { describe, expect, it } from "vitest";
import { CollectorThinFilm as CollectorFilm, type CollectorConfig, type CollectorDeposit } from "./collectorThinFilm";

function accepted(solver: CollectorFilm, events: readonly CollectorDeposit[] = []) {
  const step = solver.step(events); expect(step.accepted, step.reason).toBe(true); return step;
}
function heights(n: number, length: number, mean: number, amplitude: number) {
  return Float64Array.from({ length: n * n }, (_, i) => mean + amplitude
    * Math.cos(Math.PI * ((i % n) + .5) / n) * Math.cos(Math.PI * (Math.floor(i / n) + .5) / n));
}
function projection(h: Float64Array, n: number, mean: number) {
  let a = 0, norm = 0;
  for (let i = 0; i < h.length; i++) {
    const w = Math.cos(Math.PI * ((i % n) + .5) / n) * Math.cos(Math.PI * (Math.floor(i / n) + .5) / n);
    a += (h[i]! - mean) * w; norm += w * w;
  }
  return a / norm;
}
describe("local finite-volume capillary/gravity collector", () => {
  it("keeps an untouched prewet film stationary and accounts for its physical initial volume", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16 }), initial = s.snapshot();
    for (let i = 0; i < 100; i++) accepted(s);
    expect(s.snapshot().heightM).toEqual(initial.heightM);
    expect(s.snapshot().filmVolumeM3).toBeCloseTo(.16 * .2 * 20e-6, 18);
    expect(s.snapshot().inputVolumeM3).toBe(0); expect(s.snapshot().volumeErrorM3).toBe(0);
  });
  it("deposits at the exact event time and conserves local subcell barycentre; outside hits escape", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .01 }), initial = s.snapshot();
    const event: CollectorDeposit = { id: 1, timeSeconds: .01, positionM: [.013, 0, .026], volumeM3: 2e-10 };
    const result = accepted(s, [event, { id: 2, timeSeconds: .006, positionM: [.081, 0, 0], volumeM3: 3e-10 }]);
    const h = result.snapshot.heightM, c = s.config, area = c.widthM * c.depthM / (c.nx * c.nz);
    let x = 0, z = 0, v = 0, changed = 0;
    for (let i = 0; i < h.length; i++) {
      const excess = (h[i]! - initial.heightM[i]!) * area;
      if (excess !== 0) changed++;
      v += excess; x += excess * (c.originXM + (i % c.nx + .5) * c.widthM / c.nx);
      z += excess * (c.originZM + (Math.floor(i / c.nx) + .5) * c.depthM / c.nz);
    }
    expect(changed).toBe(4); expect(v).toBeCloseTo(event.volumeM3, 22);
    expect(x / v).toBeCloseTo(event.positionM[0], 12); expect(z / v).toBeCloseTo(event.positionM[2], 12);
    expect(result.snapshot.depositedVolumeM3).toBe(2e-10); expect(result.snapshot.escapedVolumeM3).toBe(3e-10);
    expect(Math.abs(result.snapshot.volumeErrorM3)).toBeLessThan(1e-21);
  });
  it("has closed walls without losing an edge deposit", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16, dtSeconds: .002 });
    accepted(s, [{ id: 1, timeSeconds: .002, positionM: [-.08, 0, -.1], volumeM3: 1e-10 }]);
    for (let i = 0; i < 100; i++) accepted(s);
    expect(s.snapshot().depositedVolumeM3).toBe(1e-10);
    expect(s.snapshot().escapedVolumeM3).toBe(0);
    expect(Math.abs(s.snapshot().volumeErrorM3)).toBeLessThan(1e-20);
  });
  it("converges spatially to independent linear capillary/gravity Fourier decay", () => {
    const length = .008, mean = .0003, amplitude = 3e-9, dt = 1e-5, time = .02;
    const k2 = 2 * (Math.PI / length) ** 2, mu = .01, sigma = .05, rho = 1060, g = 9.81;
    const expected = amplitude * Math.exp(-(mean ** 3) / (3 * mu) * (rho * g * k2 + sigma * k2 ** 2) * time);
    const errors: number[] = [];
    for (const n of [16, 32, 64]) {
      const s = new CollectorFilm({ nx: n, nz: n, widthM: length, depthM: length, viscosityPaS: mu,
        dtSeconds: dt }, heights(n, length, mean, amplitude));
      for (let i = 0; i < Math.round(time / dt); i++) accepted(s);
      errors.push(Math.abs(projection(s.snapshot().heightM, n, mean) / expected - 1));
    }
    expect(errors[1]!).toBeLessThan(errors[0]! / 2.5);
    expect(errors[2]!).toBeLessThan(errors[1]! / 2);
    expect(errors[2]!).toBeLessThan(.001);
  }, 20000);
  it("preserves reflection symmetry, positive heights and dissipative energy while spreading", () => {
    const n = 32, initial = Float64Array.from({ length: n * n }, (_, i) => {
      const x = ((i % n) + .5) / n - .5, z = (Math.floor(i / n) + .5) / n - .5;
      return 30e-6 + 150e-6 * Math.exp(-80 * (x * x + z * z));
    });
    const s = new CollectorFilm({ nx: n, nz: n, widthM: .02, depthM: .02, viscosityPaS: .03,
      dtSeconds: .001 }, initial);
    const start = s.snapshot(); let last = start.energyJ;
    for (let i = 0; i < 250; i++) {
      const result = accepted(s);
      expect(result.snapshot.energyJ).toBeLessThanOrEqual(last + 1e-22); last = result.snapshot.energyJ;
      expect(result.telemetry.minimumHeightM).toBeGreaterThan(0);
    }
    const end = s.snapshot();
    expect(Math.max(...end.heightM)).toBeLessThan(Math.max(...initial));
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++)
      expect(end.heightM[z * n + x]!).toBeCloseTo(end.heightM[z * n + n - 1 - x]!, 13);
    expect(Math.abs(end.volumeErrorM3)).toBeLessThan(1e-21);
    expect(Math.abs(end.energyBalanceErrorJ)).toBeLessThan(1e-19);
  });
  it("obeys inverse-viscosity time scaling independently of its rendering", () => {
    const n = 16, initial = heights(n, .02, .0002, 5e-6);
    const common: Partial<CollectorConfig> = { nx: n, nz: n, widthM: .02, depthM: .02 };
    const a = new CollectorFilm({ ...common, viscosityPaS: .01, dtSeconds: .001 }, initial);
    const b = new CollectorFilm({ ...common, viscosityPaS: .02, dtSeconds: .002 }, initial);
    for (let i = 0; i < 100; i++) { accepted(a); accepted(b); }
    expect(a.snapshot().heightM).toEqual(b.snapshot().heightM);
  });
  it("makes failed steps and uncommitted previews atomic, and protects owner-tagged rollback", () => {
    const s = new CollectorFilm({ nx: 16, nz: 16 }), before = s.snapshot();
    const event: CollectorDeposit = { id: 1, timeSeconds: .001, positionM: [0, 0, 0], volumeM3: 1e-10 };
    const prepared = s.prepareStep([event]); expect(prepared.accepted).toBe(true);
    expect(s.snapshot()).toEqual(before);
    prepared.snapshot.heightM.fill(NaN); prepared.commit(); // caller cannot alter private candidate
    expect(s.snapshot().heightM.every(Number.isFinite)).toBe(true);
    expect(() => prepared.commit()).toThrow();
    const checkpoint = s.checkpoint(), atCheckpoint = s.snapshot();
    accepted(s, [{ ...event, id: 2, timeSeconds: .002 }]); s.restore(checkpoint);
    expect(s.snapshot()).toEqual(atCheckpoint);
    expect(() => s.restore(checkpoint)).toThrow();
    expect(() => s.restore(new CollectorFilm().checkpoint())).toThrow();
    accepted(s, [{ ...event, id: 2, timeSeconds: .002 }]); // rolled-back ID is legal again
    const current = s.snapshot(), failed = s.step([{ ...event, id: 2, timeSeconds: .003 }]);
    expect(failed.accepted).toBe(false); expect(s.snapshot()).toEqual(current);
    const old = s.prepareStep(); s.prepareStep();
    expect(() => old.commit()).toThrow(/Stale/);
  });
  it("rejects an unresolved deposition or exhausted substep budget without losing input volume", () => {
    const s = new CollectorFilm(), before = s.snapshot();
    const result = s.step([{ id: 1, timeSeconds: .0005, positionM: [0, 0, 0], volumeM3: 1e-5 }]);
    expect(result.accepted).toBe(false); expect(result.reason).toMatch(/slope|aspect/);
    expect(s.snapshot()).toEqual(before);
    const limited = new CollectorFilm({ maxSubsteps: 1 });
    const fail = limited.step([{ id: 1, timeSeconds: .0005, positionM: [0, 0, 0], volumeM3: 1e-11 }]);
    expect(fail.accepted).toBe(false); expect(fail.reason).toMatch(/budget/);
    expect(limited.timeSeconds).toBe(0); expect(limited.snapshot().inputVolumeM3).toBe(0);
  });
});
