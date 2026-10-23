import { describe, expect, it } from "vitest";
import { DryCollectorFilm, liverDryCollectorConfig, type DryCollectorDeposit } from "./dryCollector";
import { tankSurfaceData } from "../experiments/geometry";
import { liverCollectionPlaneYM } from "./collectionPlane";

const config = { nx: 16, nz: 16, widthM: .16, depthM: .16, originXM: -.08, originZM: -.08, dtSeconds: .002 };
const event = (changes: Partial<DryCollectorDeposit> = {}): DryCollectorDeposit => ({
  id: 1, timeSeconds: .002, positionM: [.013, 0, .026],
  velocityMS: [.8, -1.2, -.4], volumeM3: 1e-9, ...changes,
});
function accepted(model: DryCollectorFilm, events: readonly DryCollectorDeposit[] = []) {
  const result = model.step(events); expect(result.accepted, result.reason).toBe(true); return result;
}
const sum = (a: ArrayLike<number>) => Array.from(a).reduce((total, v) => total + v, 0);
const area = (s: DryCollectorFilm) => s.config.widthM * s.config.depthM / (s.config.nx * s.config.nz);
const kinetic = (s: ReturnType<DryCollectorFilm["snapshot"]>, a: number, rho: number) =>
  .5 * rho * a * sum(Float64Array.from(s.heightM, (h, i) => h > 0
    ? (s.momentumXM2S[i]! ** 2 + s.momentumZM2S[i]! ** 2) / h : 0));

describe("initially dry blood collector", () => {
  it("stays exactly dry with zero momentum, energy and inventory; no numerical precursor is created", () => {
    const model = new DryCollectorFilm(config), initial = model.snapshot();
    for (let i = 0; i < 100; i++) accepted(model);
    const end = model.snapshot();
    expect(end.heightM).toEqual(initial.heightM);
    expect(end.momentumXM2S.every(v => v === 0)).toBe(true);
    expect(end.momentumZM2S.every(v => v === 0)).toBe(true);
    for (const key of ["initialFilmVolumeM3", "filmVolumeM3", "volumeErrorM3", "energyJ", "sourceEnergyJ",
      "dissipatedEnergyJ", "impactDissipatedEnergyJ"] as const) expect(end[key]).toBe(0);
    expect(end.timeSeconds).toBe(.2);
  });

  it("adds exact impact volume and horizontal momentum at the actual event time, without a radial kick", () => {
    const model = new DryCollectorFilm(config), input = event(), s = accepted(model, [input]).snapshot, a = area(model);
    expect(s.initialFilmVolumeM3).toBe(0);
    expect(s.heightM.filter(h => h > 0)).toHaveLength(4);
    expect(sum(s.heightM) * a).toBeCloseTo(input.volumeM3, 23);
    expect(sum(s.momentumXM2S) * a).toBeCloseTo(input.volumeM3 * input.velocityMS[0], 23);
    expect(sum(s.momentumZM2S) * a).toBeCloseTo(input.volumeM3 * input.velocityMS[2], 23);
    let x = 0, z = 0;
    for (let i = 0; i < s.heightM.length; i++) {
      x += s.heightM[i]! * a * (config.originXM + (i % config.nx + .5) * config.widthM / config.nx);
      z += s.heightM[i]! * a * (config.originZM + (Math.floor(i / config.nx) + .5) * config.depthM / config.nz);
    }
    expect(x / input.volumeM3).toBeCloseTo(input.positionM[0], 14);
    expect(z / input.volumeM3).toBeCloseTo(input.positionM[2], 14);
    expect(s.impactDissipatedEnergyJ).toBeCloseTo(.5 * model.config.densityKgM3 * input.volumeM3 * input.velocityMS[1] ** 2, 19);
    expect(Math.abs(s.energyBalanceErrorJ)).toBeLessThan(1e-20);
    const vertical = new DryCollectorFilm(config);
    const v = accepted(vertical, [event({ velocityMS: [0, -2, 0] })]).snapshot;
    expect(v.momentumXM2S.every(q => q === 0)).toBe(true);
    expect(v.momentumZM2S.every(q => q === 0)).toBe(true);
  });

  it("accounts for inelastic opposing impacts independently of gravity and capillary potential", () => {
    const model = new DryCollectorFilm({ ...config, gravityMS2: 0, surfaceTensionNm: 0, viscosityPaS: 0 });
    const v = 2e-9, speed = .7;
    const s = accepted(model, [
      event({ id: 1, volumeM3: v, velocityMS: [speed, 0, 0] }),
      event({ id: 2, volumeM3: v, velocityMS: [-speed, 0, 0] }),
    ]).snapshot;
    expect(s.filmVolumeM3).toBeCloseTo(2 * v, 23);
    expect(kinetic(s, area(model), model.config.densityKgM3)).toBeLessThan(1e-25);
    expect(s.impactDissipatedEnergyJ).toBeCloseTo(model.config.densityKgM3 * v * speed ** 2, 20);
  });

  it("retains exact input mass at closed edges and records outside arrivals separately", () => {
    const model = new DryCollectorFilm(config);
    const positions: [number, number, number][] = [
      [-.08, 0, -.08], [.08, 0, .08], [-.08, 0, .08], [.08, 0, -.08], [.081, 0, 0],
    ];
    const s = accepted(model, positions.map((positionM, i) => event({ id: i, positionM, velocityMS: [0, -.1, 0] }))).snapshot;
    expect(s.inputVolumeM3).toBeCloseTo(5e-9, 23);
    expect(s.filmVolumeM3).toBeCloseTo(4e-9, 23);
    expect(s.escapedVolumeM3).toBe(1e-9);
    expect(s.depositedVolumeM3).toBeCloseTo(4e-9, 23);
    expect(Math.abs(s.volumeErrorM3)).toBeLessThan(1e-22);
  });

  it("has a frozen previous-state collision query and exactly matching nonnegative rendered volume", () => {
    const model = new DryCollectorFilm({ ...config, collectionPlaneYM: -.035 }), before = model.collisionQuery();
    expect(model.maximumSurfaceYM).toBe(-.035);
    accepted(model, [event({ positionM: [-.08, -.035, -.08], velocityMS: [0, -1, 0], volumeM3: 1e-7 })]);
    const s = model.snapshot(), c = model.config, query = model.collisionQuery();
    expect(model.maximumSurfaceYM).toBe(c.collectionPlaneYM + Math.max(...s.heightM));
    expect(s.domain).toEqual({ nx: c.nx, nz: c.nz, widthM: c.widthM, depthM: c.depthM,
      originXM: c.originXM, originZM: c.originZM, collectionPlaneYM: c.collectionPlaneYM });
    expect(Object.isFrozen(s.domain)).toBe(true);
    const data = tankSurfaceData({ ...c, heightM: .1 * Math.min(c.widthM, c.depthM) }, s.heightM, undefined, .75, [.2, .2, .2], true);
    let volume = 0;
    for (let i = 0; i < data.indices.length; i += 3) {
      const ids = [data.indices[i]!, data.indices[i + 1]!, data.indices[i + 2]!];
      const p = ids.map(j => Array.from(data.positions.slice(j * 3, j * 3 + 3), v => v / 1000));
      const projectedArea = Math.abs((p[1]![0]! - p[0]![0]!) * (p[2]![2]! - p[0]![2]!)
        - (p[2]![0]! - p[0]![0]!) * (p[1]![2]! - p[0]![2]!)) / 2;
      volume += projectedArea * (p[0]![1]! + p[1]![1]! + p[2]![1]!) / 3;
      for (const v of p) {
        expect(v[1]).toBeGreaterThanOrEqual(0);
        expect(query.heightAt(v[0]! + c.originXM + c.widthM / 2, v[2]! + c.originZM + c.depthM / 2) - c.collectionPlaneYM)
          .toBeCloseTo(v[1]!, 9);
      }
    }
    expect(Math.abs(volume - s.filmVolumeM3)).toBeLessThan(s.filmVolumeM3 * 1e-6);
    expect(before.heightAt(-.08, -.08)).toBe(c.collectionPlaneYM);
    expect(query.heightAt(-.08, -.08)).toBeGreaterThan(c.collectionPlaneYM);
    const contact = query.contact([-.08, .01, -.08], [0, 0, 0], [0, -9.81, 0], .002, .002, 1, 0);
    expect(contact).toBeTruthy();
    const expectedTime = .002 + Math.sqrt(2 * (.01 - query.heightAt(-.08, -.08)) / 9.81);
    expect(contact!.timeSeconds).toBeCloseTo(expectedTime, 12);
  });

  it("keeps prepare, superseded commit, rollback and duplicate ownership transactional", () => {
    const model = new DryCollectorFilm(config), checkpoint = model.checkpoint(), initial = model.snapshot();
    const first = model.prepareStep([event()]);
    expect(first.accepted, first.reason).toBe(true); expect(model.snapshot()).toEqual(initial);
    const next = model.prepareStep([event({ id: 2 })]);
    expect(() => first.commit()).toThrow(/Stale/);
    expect(next.accepted, next.reason).toBe(true); next.commit();
    expect(() => next.commit()).toThrow(/Stale/);
    const before = model.snapshot(), duplicate = model.step([event({ id: 2, timeSeconds: .004 })]);
    expect(duplicate.accepted).toBe(false); expect(model.snapshot()).toEqual(before);
    model.restore(checkpoint); expect(model.snapshot()).toEqual(initial);
    accepted(model, [event({ id: 2 })]);
    expect(() => model.restore(checkpoint)).toThrow(/checkpoint/);
    expect(() => new DryCollectorFilm(config).restore(model.checkpoint())).toThrow(/checkpoint/);
  });

  it("rejects invalid inputs, overheight and finite-work exhaustion without partial deposits or time advance", () => {
    for (const invalid of [
      event({ volumeM3: -1 }), event({ volumeM3: NaN }), event({ timeSeconds: .003 }),
      event({ velocityMS: [NaN, 0, 0] }), event({ velocityMS: [1e300, 0, 0] }),
      event({ positionM: [0, Infinity, 0] }), event({ volumeM3: .1 }),
    ]) {
      const model = new DryCollectorFilm(config), before = model.snapshot(), rejected = model.step([invalid]);
      expect(rejected.accepted).toBe(false); expect(model.snapshot()).toEqual(before);
    }
    const model = new DryCollectorFilm({ ...config, maxSubsteps: 1, dtSeconds: .1 });
    const before = model.snapshot(), result = model.step([event({ timeSeconds: 0, volumeM3: 1e-7 })]);
    expect(result.accepted).toBe(false); expect(model.snapshot()).toEqual(before);
    expect(() => new DryCollectorFilm({ ...config, collectionPlaneYM: NaN })).toThrow();
    expect(() => new DryCollectorFilm(config, new Float64Array(256).fill(-1e-12))).toThrow();
  });

  it("converges to the independent Ritter wet-to-dry dam-break solution with no clipping or artificial dry depth", () => {
    const g = 9.81, h0 = .001, length = .16, duration = .15, dt = .0005, c0 = Math.sqrt(g * h0);
    const exact = (x: number) => {
      const xi = (x - length / 2) / duration;
      return xi <= -c0 ? h0 : xi >= 2 * c0 ? 0 : (2 * c0 - xi) ** 2 / (9 * g);
    };
    const errors: number[] = [];
    for (const nx of [32, 64, 128]) {
      const nz = 8, initial = Float64Array.from({ length: nx * nz }, (_, i) => i % nx < nx / 2 ? h0 : 0);
      const model = new DryCollectorFilm({ nx, nz, widthM: length, depthM: .02,
        originXM: 0, originZM: 0, dtSeconds: dt, viscosityPaS: 0, surfaceTensionNm: 0 }, initial);
      const startingVolume = model.snapshot().filmVolumeM3;
      for (let step = 0; step < Math.round(duration / dt); step++) accepted(model);
      const s = model.snapshot();
      let error = 0;
      for (let x = 0; x < nx; x++) {
        let expected = 0;
        for (let q = 0; q < 32; q++) expected += exact((x + (q + .5) / 32) * length / nx) / 32;
        error += Math.abs(s.heightM[x]! - expected) / nx;
      }
      errors.push(error / h0);
      expect(s.heightM.every(h => h >= 0 && Number.isFinite(h))).toBe(true);
      expect(Math.abs(s.filmVolumeM3 - startingVolume)).toBeLessThan(1e-18);
      expect(Math.abs(s.energyBalanceErrorJ)).toBeLessThan(1e-16);
    }
    expect(errors[1]!).toBeLessThan(errors[0]! * .8);
    expect(errors[2]!).toBeLessThan(errors[1]! * .8);
    expect(errors[2]!).toBeLessThan(.025);
  }, 20_000);

  it("spreads a finite real deposit into a dry domain with positive mass and dissipative capillary/viscous evolution", () => {
    const model = new DryCollectorFilm({ ...config, widthM: .04, depthM: .04, originXM: -.02, originZM: -.02, nx: 32, nz: 32 });
    accepted(model, [event({ positionM: [0, 0, 0], volumeM3: 2e-9, velocityMS: [.05, -.2, 0] })]);
    let energy = model.snapshot().energyJ;
    for (let i = 0; i < 100; i++) {
      const result = accepted(model);
      expect(result.telemetry.minimumHeightM).toBeGreaterThanOrEqual(0);
      expect(result.snapshot.energyJ).toBeLessThanOrEqual(energy * (1 + 3e-12) + 1e-23);
      expect(Math.abs(result.snapshot.volumeErrorM3)).toBeLessThan(1e-20);
      expect(result.snapshot.numericalDissipatedEnergyJ).toBeGreaterThanOrEqual(-1e-20);
      energy = result.snapshot.energyJ;
    }
    const s = model.snapshot();
    expect(s.heightM.filter(h => h > 1e-12).length).toBeGreaterThan(4);
    expect(s.basalDissipatedEnergyJ).toBeGreaterThan(0);
    expect(Math.abs(s.energyBalanceErrorJ)).toBeLessThan(1e-17);
  }, 20_000);

  it("accepts a timed sequence of separated drops on the default64² dry tray without losing tiny inputs", () => {
    const model = new DryCollectorFilm({ dtSeconds: .002 });
    let expected = 0, maxSubsteps = 0;
    for (let step = 0; step < 500; step++) {
      const deposits = step % 25 === 0 ? [event({ id: step, timeSeconds: step * .002 + .001,
        volumeM3: step === 0 ? 1e-18 : 2e-9, positionM: [.01, 0, .02], velocityMS: [.1, -.5, .04] })] : [];
      expected += deposits.reduce((v, e) => v + e.volumeM3, 0);
      const r = accepted(model, deposits);
      maxSubsteps = Math.max(maxSubsteps, r.telemetry.substeps);
      expect(Math.abs(r.snapshot.filmVolumeM3 - expected)).toBeLessThan(Math.max(1e-28, expected * 1e-10));
      expect(r.snapshot.heightM.every(h => h >= 0 && Number.isFinite(h))).toBe(true);
    }
    const snapshot = model.snapshot();
    expect(snapshot.timeSeconds).toBe(1);
    expect(snapshot.inputVolumeM3).toBe(expected);
    expect(Math.abs(snapshot.energyBalanceErrorJ)).toBeLessThan(1e-16);
    expect(maxSubsteps).toBeLessThan(32);
  }, 20_000);

  it("derives tray bounds and plane from the canonical physical surface, independent of indexing/refinement", () => {
    const surface = { positionsM: new Float64Array([-.03, .02, -.02, .05, .03, -.02, -.03, .01, .04]) };
    const c = liverDryCollectorConfig(surface);
    expect(c.collectionPlaneYM).toBe(liverCollectionPlaneYM(surface));
    expect(c.originXM).toBeCloseTo(-.05, 15); expect(c.originZM).toBeCloseTo(-.04, 15);
    expect(c.widthM).toBeCloseTo(.12, 15); expect(c.depthM).toBeCloseTo(.1, 15);
    const midpoint = { positionsM: new Float64Array([...surface.positionsM, .01, .025, -.02]) };
    expect(liverDryCollectorConfig(midpoint)).toEqual(c);
  });
});
