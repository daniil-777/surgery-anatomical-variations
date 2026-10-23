import { describe, expect, it } from "vitest";
import { BLOOD_PROFILES, shearRate, surfaceTensionCitrated, validateMaterial, viscosity } from "./material";
import { boundaryState, DEFAULT_SCENE, initialState, kernel, sceneHash, validateScene } from "./scene";
import { periodicGeometricVolume } from "./bench";
import { projectTrayVelocity, trayGeometry } from "./boundary";

describe("sourced blood constitutive references", () => {
  it.each([
    [0, .056], [.1, .052260], [1, .028715], [10, .008651], [100, .004326], [1000, .003595],
  ])("evaluates the Weddell tuple at %s s^-1", (gamma, expected) => {
    expect(viscosity(gamma)).toBeCloseTo(expected, 6);
  });
  it("preserves both published tuples instead of mixing parameters", () => {
    expect(BLOOD_PROFILES.map(p => [p.lambda, p.a, p.n])).toEqual([[1.902, 1.25, .22], [3.313, 2, .3568]]);
    for (const p of BLOOD_PROFILES) {
      expect(viscosity(0, p)).toBe(p.mu0);
      const values = [0, .1, 1, 10, 100, 1000, 10000].map(rate => viscosity(rate, p));
      values.forEach((value, i) => { expect(value).toBeGreaterThanOrEqual(p.muInf); if (i) expect(value).toBeLessThan(values[i - 1]!); });
    }
  });
  it("handles Newtonian degeneracies and validates every parameter", () => {
    expect(viscosity(100, { ...BLOOD_PROFILES[0]!, n: 1 })).toBe(.056);
    expect(viscosity(100, { ...BLOOD_PROFILES[0]!, mu0: .00345 })).toBe(.00345);
    for (const k of ["rho", "mu0", "muInf", "lambda", "a", "n"]) expect(() => validateMaterial({ ...BLOOD_PROFILES[0]!, [k]: NaN })).toThrow();
    for (const x of [-1, NaN, Infinity, 1e7]) expect(() => viscosity(x)).toThrow();
  });
  it("distinguishes rigid rotation, simple shear and incompressible extension", () => {
    expect(shearRate([0, -3, 0, 3, 0, 0, 0, 0, 0])).toBe(0);
    expect(shearRate([0, 7, 0, 0, 0, 0, 0, 0, 0])).toBe(7);
    expect(shearRate([2, 0, 0, 0, -1, 0, 0, 0, -1])).toBeCloseTo(Math.sqrt(12), 12);
    expect(shearRate([2, -3, 0, 3, -1, 0, 0, 0, -1])).toBeCloseTo(Math.sqrt(12), 12);
    expect(() => shearRate([0])).toThrow();
  });
  it("keeps citrated-blood surface tension separate and within its temperature range", () => {
    expect(surfaceTensionCitrated(37)).toBeCloseTo(.052604, 10);
    expect(surfaceTensionCitrated(22)).toBeCloseTo(.059699, 10);
    for (const t of [19, 41, NaN]) expect(() => surfaceTensionCitrated(t)).toThrow();
  });
});
describe("blood scene contract", () => {
  it("uses the uploaded FP32 timestep and isolates configuration from presentation", async () => {
    const scene = validateScene(DEFAULT_SCENE);
    expect(scene.dtSeconds).toBe(Math.fround(.0005));
    const decorated = { ...DEFAULT_SCENE, camera: [1, 2, 3], colour: "blue" };
    expect(await sceneHash(decorated)).toBe(await sceneHash(DEFAULT_SCENE));
    expect(await sceneHash({ ...DEFAULT_SCENE, dynamicViscosityPaS: .01 })).not.toBe(await sceneHash(DEFAULT_SCENE));
  });
  it.each([.00001, .001])("round-trips the FP32 timestep endpoint %s", async dtSeconds => {
    const scene = validateScene({ ...DEFAULT_SCENE, dtSeconds });
    expect(validateScene(scene)).toEqual(scene);
    expect(await sceneHash(scene)).toBe(await sceneHash({ ...DEFAULT_SCENE, dtSeconds }));
  });
  it.each([
    { axis: 9 }, { axis: 64 }, { dtSeconds: NaN }, { iterations: 1.2 }, { seed: -1 }, { fixture: "artery" },
    { densityTolerance: .1 }, { solver: "other" }, { lengthM: -1 }, { wallContact: "hidden-clamp" },
  ])("rejects invalid configuration %j before allocating", patch => {
    expect(() => validateScene({ ...DEFAULT_SCENE, ...patch } as typeof DEFAULT_SCENE)).toThrow();
  });
  it("checks explicit stability bounds rather than silently changing the timestep", () => {
    expect(() => validateScene({ ...DEFAULT_SCENE, axis: 16, lengthM: .008, dynamicViscosityPaS: .056, dtSeconds: .001 })).toThrow();
  });
  it("builds physical SI mass and byte-stable replay with SoA offsets", () => {
    const s = validateScene(DEFAULT_SCENE), a = initialState(s), b = initialState(s), n = s.axis ** 3;
    expect(a).toEqual(b); expect(a.byteLength).toBe(n * 32);
    let mass = 0; for (let i = 0; i < n; ++i) mass += a[4 * i + 3]!;
    expect(mass / (s.densityKgM3 * s.lengthM ** 3)).toBeCloseTo(1, 6);
    expect(a[4 * n + 3]).toBe(0);
    const translation = initialState({ ...s, fixture: "translation" });
    expect(translation[n * 4]).toBe(Math.fround(s.speedMS));
  });
  it("normalizes the 3D cubic kernel and enforces exact support", () => {
    const h = .004, dr = h / 10000;
    let integral = 0;
    for (let i = 0; i < 10000; ++i) { const r = (i + .5) * dr; integral += 4 * Math.PI * r * r * kernel(r, h) * dr; }
    expect(integral).toBeCloseTo(1, 7); expect(kernel(h, h)).toBe(0); expect(kernel(1.01 * h, h)).toBe(0);
  });
  it("builds non-overlapping fluid and solid-volume samples for an open tray", () => {
    const s = { ...DEFAULT_SCENE, fixture: "dam" as const }, fluid = initialState(s), solid = boundaryState(s), dx = s.lengthM / (s.axis * 2);
    const locations = new Set<string>();
    for (let i = 0; i < solid.length; i += 4) {
      const key = Array.from(solid.slice(i, i + 3)).join(",");
      expect(locations.has(key)).toBe(false); locations.add(key);
      expect(solid[i + 3]).toBe(Math.fround(s.densityKgM3 * dx ** 3));
    }
    for (let i = 0; i < s.axis ** 3 * 4; i += 4) expect(locations.has(Array.from(fluid.slice(i, i + 3)).join(","))).toBe(false);
    expect(boundaryState(DEFAULT_SCENE).length).toBe(0);
  });
  it("uses independent periodic tetrahedra to detect collapsed geometry despite constant mass", () => {
    const s = DEFAULT_SCENE, state = initialState(s);
    const initial = periodicGeometricVolume(state, s.axis, s.lengthM);
    expect(initial.relativeError).toBeLessThan(1e-10); expect(initial.invertedTetrahedra).toBe(0);
    for (let i = 0; i < s.axis ** 3; ++i) state[i * 4] = 0;
    const collapsed = periodicGeometricVolume(state, s.axis, s.lengthM);
    expect(collapsed.relativeError).toBe(1); expect(collapsed.invertedTetrahedra).toBe(s.axis ** 3 * 6);
  });
});
describe("declared fixed-tray contact", () => {
  const scene = { ...DEFAULT_SCENE, fixture: "dam" as const, dtSeconds: .0001 };
  it("includes contact in the physical configuration hash", async () => {
    expect(await sceneHash(scene)).not.toBe(await sceneHash({ ...scene, wallContact: "pressure-only" }));
  });
  it("preserves tangential and outgoing velocity with an open top", () => {
    const { minimumCentre: lo, maximumCentre: hi } = trayGeometry(scene);
    expect(projectTrayVelocity([lo, lo, lo], [-1, -1, .1], scene)).toEqual([0, 0, .1]);
    expect(projectTrayVelocity([hi, hi, hi], [.1, 1, -.1], scene)).toEqual([0, 1, -.1]);
  });
  it("prevents swept wall crossings without adding energy or moving positions", () => {
    const { minimumCentre: lo, maximumCentre: hi } = trayGeometry(scene);
    let seed = 17;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let i = 0; i < 1000; ++i) {
      const p = [0, 1, 2].map(() => lo + random() * (hi - lo)), before = [...p];
      const v = [0, 1, 2].map(() => (random() - .5) * 200);
      const projected = projectTrayVelocity(p, v, scene);
      const next = p.map((x, axis) => x + Math.fround(scene.dtSeconds) * projected[axis]!);
      expect(Math.min(...next)).toBeGreaterThanOrEqual(lo - 1e-14);
      expect(Math.max(next[0]!, next[2]!)).toBeLessThanOrEqual(hi + 1e-14);
      expect(projected.reduce((sum, x) => sum + x * x, 0)).toBeLessThanOrEqual(v.reduce((sum, x) => sum + x * x, 0) + 1e-10);
      expect(p).toEqual(before);
    }
  });
});
