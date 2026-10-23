import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { composeDiffuseSubstrate } from "../optics";
import { bloodAppearanceTransport } from "../experiments/bloodAppearanceOptics";
import { createLiverFilmCache, liverFilmGeometry, liverFilmInterfaceRoughness, liverFilmLevelingFactor,
  liverFilmOpticalRGBA, liverFilmTransportTextureData, liverInspectionWorkingDistanceM, updateLiverFilmCache,
  rectangularEmitterProjectedSolidAngle, LIVER_OPERATING_PANEL } from "./renderer";
import { APPEARANCE_LOG_MAX, APPEARANCE_MAX_M, APPEARANCE_SCALE_M, APPEARANCE_THICKNESS_COUNT } from "../experiments/bloodAppearanceLut.generated";
import type { LiverAnatomy, LiverCutGeometry, LiverSurface } from "./types";

const surface = (): LiverSurface => ({
  positionsM: new Float64Array([0, 0, 0, .02, 0, 0, 0, 0, .03]),
  normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]),
  indices: new Uint32Array([0, 1, 2]),
});
const anatomy = (): LiverAnatomy => ({
  surface: surface(), organ: { id: "liver", name: "Oracle", kind: "liver", positions: [], indices: [], color: "#805040" },
  network: { version: "surface-vessels-design-1.0.0", seed: 1, organ_id: "liver",
    provenance: "procedural-surface-design-not-patient-vasculature", settings: { density: .5, visibility: .7, radius_scale: 1 },
    segments: [], statistics: { terminals: 0, branches: 0, connected_components: 0, length_mm: 0, murray_exponent: 3 } },
  vessels: [], targets: [], provenance: { templateId: "analytic", label: "Analytic triangle", source: "test",
    license: "test", vascularModel: "procedural-surface-design-not-patient-vasculature", detail: "Exact P1 integral oracle" },
});
const uncut = (): LiverCutGeometry => ({
  surface: surface(), cavity: { positionsM: new Float64Array(), normals: new Float32Array(), indices: new Uint32Array() },
  removedAreaM2: 0, sourceTriangles: new Uint32Array([0, 0, 0]),
  sourceBarycentrics: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
});
const rgb = () => new Float32Array([.18, .04, .025, .18, .04, .025, .18, .04, .025]);

describe("physical liver inspection camera", () => {
  it("preserves target-plane framing with actual near perspective and zoom1", () => {
    for (const radiusM of [.03, .16822445516660294, .25]) {
      const old = new PerspectiveCamera(35, 16 / 9, .0001, 10), near = old.clone();
      old.position.z = radiusM * 3.7; old.zoom = 3;
      near.position.z = liverInspectionWorkingDistanceM(radiusM); near.zoom = 1;
      for (const camera of [old, near]) { camera.updateProjectionMatrix(); camera.updateMatrixWorld(); }
      for (const point of [[0, 0, 0], [.01, -.02, 0], [-.03, .04, 0]]) {
        const a = new Vector3(...point).project(old), b = new Vector3(...point).project(near);
        expect(a.x).toBeCloseTo(b.x, 13); expect(a.y).toBeCloseTo(b.y, 13);
      }
      // Relief has genuinely changed perspective; this is not equivalent to
      // retaining the distant camera and only changing a display zoom label.
      const raised = new Vector3(.01, .01, .005);
      expect(Math.abs(raised.clone().project(old).x - raised.clone().project(near).x)).toBeGreaterThan(1e-4);
    }
    for (const radius of [0, -1, NaN, Infinity]) expect(() => liverInspectionWorkingDistanceM(radius)).toThrow();
  });
});

describe("finite operating emitter normalization", () => {
  it("matches independent midpoint integration of projected solid angle and preserves scale", () => {
    for (const [width, height, distance] of [[.4, .3, .6], [.05, .2, .3], [.8, .6, .4]]) {
      const n = 512, dx = width! / n, dy = height! / n, d2 = distance! ** 2;
      let integral = 0;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = (i + .5) * dx - width! / 2, y = (j + .5) * dy - height! / 2;
        integral += d2 / (d2 + x * x + y * y) ** 2 * dx * dy;
      }
      const analytic = rectangularEmitterProjectedSolidAngle(width!, height!, distance!);
      expect(Math.abs(integral / analytic - 1)).toBeLessThan(1e-6);
      expect(rectangularEmitterProjectedSolidAngle(width! * 1000, height! * 1000, distance! * 1000)).toBeCloseTo(analytic, 14);
      expect(analytic).toBeGreaterThan(0); expect(analytic).toBeLessThan(Math.PI);
    }
  });
  it("has the small-source inverse-square limit and finite hemisphere bound", () => {
    const small = rectangularEmitterProjectedSolidAngle(.0004, .0003, .6);
    expect(Math.abs(small / (.0004 * .0003 / .6 ** 2) - 1)).toBeLessThan(2e-7);
    expect(rectangularEmitterProjectedSolidAngle(1e6, 1e6, 1)).toBeCloseTo(Math.PI, 10);
    const panel = LIVER_OPERATING_PANEL, angle = rectangularEmitterProjectedSolidAngle(panel.widthM, panel.heightM, panel.workingDistanceM);
    const radiance = panel.referenceRelativeIrradiance / angle;
    expect(radiance * angle).toBeCloseTo(panel.referenceRelativeIrradiance, 14);
    for (const bad of [0, -1, NaN, Infinity])
      expect(() => rectangularEmitterProjectedSolidAngle(.4, .3, bad)).toThrow();
  });
});

describe("liver film optical layer", () => {
  it("is exactly absent on dry tissue and composes the complete independent slab/substrate model", () => {
    for (const substrate of [[0, 0, 0], [1, 1, 1], [.18, .04, .025]] as const)
      for (const oxygenation of [0, .75, .98, 1])
        for (const depth of [0, 1e-7, 1e-6, 1e-5, 1e-3, .05]) {
          const rgba = liverFilmOpticalRGBA(depth, oxygenation, substrate);
          expect(rgba.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
          if (depth === 0) expect(rgba).toEqual([0, 0, 0, 0]);
          const expected = composeDiffuseSubstrate(bloodAppearanceTransport(depth, oxygenation), substrate);
          for (let channel = 0; channel < 3; channel++)
            expect(rgba[3] * rgba[channel]! + (1 - rgba[3]) * substrate[channel]!).toBeCloseTo(expected[channel]!, 12);
        }
  });
  it("keeps a resolved wet dielectric interface independent of diffuse slab opacity", () => {
    const substrate = [.18, .04, .025] as const;
    for (const depth of [1e-12, 1e-9, 1e-6, .00005, .001]) {
      const value = liverFilmOpticalRGBA(depth, .75, substrate);
      expect(value[3]).toBe(1);
      expect(value.slice(0, 3)).toEqual(composeDiffuseSubstrate(bloodAppearanceTransport(depth, .75), substrate));
    }
    const limit = liverFilmOpticalRGBA(1e-12, .75, substrate);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(limit[channel]! - substrate[channel]!)).toBeLessThan(1e-8);
  });
  it("returns infinitesimal tails continuously to the authored capsule BRDF without a thickness threshold", () => {
    const reliefM = .024 * .5 * .12 / 1000;
    expect(reliefM).toBeCloseTo(1.44e-6, 15);
    expect(liverFilmLevelingFactor(0, reliefM)).toBe(0);
    expect(liverFilmLevelingFactor(reliefM, reliefM)).toBe(.5);
    expect(liverFilmLevelingFactor(1e-12, reliefM)).toBeGreaterThan(0);
    expect(liverFilmLevelingFactor(1e-12, reliefM)).toBeLessThan(1e-6);
    expect(liverFilmLevelingFactor(1, reliefM)).toBeGreaterThan(.999998);
    expect(liverFilmInterfaceRoughness(0, reliefM, .43, .16)).toBeCloseTo(.43, 14);
    expect(liverFilmInterfaceRoughness(1e-12, reliefM, .43, .16)).toBeCloseTo(.43, 6);
    expect(liverFilmInterfaceRoughness(1e6, reliefM, .43, .16)).toBeCloseTo(.16, 9);
    let previous = .43;
    for (const h of [1e-12, 1e-10, 1e-8, 1e-6, 1e-4, .01]) {
      const roughness = liverFilmInterfaceRoughness(h, reliefM, .43, .16);
      expect(roughness).toBeLessThan(previous); expect(roughness).toBeGreaterThan(.16); previous = roughness;
    }
    for (const h of [-1, Infinity, NaN]) expect(() => liverFilmLevelingFactor(h, reliefM)).toThrow();
    for (const relief of [-1, Infinity, NaN]) expect(() => liverFilmLevelingFactor(.001, relief)).toThrow();
  });
  it("rejects nonphysical thickness and oxygenation instead of coloring invalid state", () => {
    for (const depth of [-1e-6, NaN, Infinity]) expect(() => liverFilmOpticalRGBA(depth, .98, [.2, .1, .1])).toThrow();
    for (const oxygenation of [-.1, 1.1, NaN]) expect(() => liverFilmOpticalRGBA(.001, oxygenation, [.2, .1, .1])).toThrow();
  });
  it("packs shader R/T rows consistently with the validated spectral transport across thickness and oxygenation", () => {
    const n = APPEARANCE_THICKNESS_COUNT;
    for (const oxygenation of [0, .1, .75, .983, 1]) {
      const packed = liverFilmTransportTextureData(oxygenation);
      for (const h of [0, 1e-9, 1e-7, 1e-6, 8e-6, 5e-5, .00025, .001, .025, .05, .08]) {
        const x = Math.log1p(Math.min(h, APPEARANCE_MAX_M) / APPEARANCE_SCALE_M) / APPEARANCE_LOG_MAX * (n - 1);
        const lo = Math.floor(x), hi = Math.min(lo + 1, n - 1), fraction = x - lo;
        const expected = bloodAppearanceTransport(h, oxygenation);
        for (let channel = 0; channel < 3; channel++) {
          const r = packed[lo * 4 + channel]! * (1 - fraction) + packed[hi * 4 + channel]! * fraction;
          const t = packed[(n + lo) * 4 + channel]! * (1 - fraction) + packed[(n + hi) * 4 + channel]! * fraction;
          expect(Math.abs(r - expected.reflectance[channel]!)).toBeLessThan(8e-8);
          expect(Math.abs(t - expected.transmittance[channel]!)).toBeLessThan(8e-8);
          expect(r + t).toBeLessThanOrEqual(1 + 8e-8);
        }
      }
    }
    const preserved = new Float32Array(n * 8).fill(42);
    expect(() => liverFilmTransportTextureData(NaN, preserved)).toThrow();
    expect(preserved.every(value => value === 42)).toBe(true);
  });
  it("resolves a wet/dry triangle midpoint as its physical thickness instead of interpolating endpoint alpha", () => {
    const substrate = [.18, .04, .025] as const;
    const dry = liverFilmOpticalRGBA(0, .75, substrate), wet = liverFilmOpticalRGBA(.0005, .75, substrate);
    const midpoint = liverFilmOpticalRGBA(.00025, .75, substrate);
    expect(midpoint[3]).toBeGreaterThan(.999);
    expect((dry[3] + wet[3]) / 2).toBeCloseTo(.5, 8);
    expect(Math.abs(midpoint[0] - (substrate[0] + wet[0]) / 2)).toBeGreaterThan(.005);
  });
});

describe("conservative retained-surface P1 film display", () => {
  it("uses the exact analytic area integral and physical normal offset without a display scale", () => {
    const model = anatomy(), cut = uncut(), depthM = new Float64Array([.0001, 0, .0002]);
    const before = { source: Array.from(model.surface.positionsM), mapping: Array.from(cut.sourceBarycentrics), depths: Array.from(depthM) };
    const data = liverFilmGeometry(model, cut, { depthM }, rgb(), .98);
    const analyticAreaM2 = .02 * .03 / 2;
    expect(data.volumeM3).toBeCloseTo(analyticAreaM2 * (.0001 + 0 + .0002) / 3, 18);
    expect(data.wetVertices).toBe(2); expect(data.maximumDepthM).toBe(.0002);
    expect(data.positions[1]).toBeCloseTo(-.1, 7); expect(data.positions[4]).toBe(0);
    expect(data.thicknessM[0]).toBeCloseTo(.0001, 10); expect(data.thicknessM[1]).toBe(0);
    expect(data.positions[7]).toBeCloseTo(-.2, 7); expect(data.colours[7]).toBe(0);
    expect(Array.from(model.surface.positionsM)).toEqual(before.source);
    expect(Array.from(cut.sourceBarycentrics)).toEqual(before.mapping); expect(Array.from(depthM)).toEqual(before.depths);
  });
  it("integrates a clipped quarter triangle using canonical barycentrics, with no volume normalization", () => {
    const model = anatomy(), cut = uncut();
    cut.surface.positionsM = new Float64Array([0, 0, 0, .01, 0, 0, 0, 0, .015]);
    cut.sourceBarycentrics = new Float64Array([1, 0, 0, .5, .5, 0, .5, 0, .5]);
    cut.removedAreaM2 = .000225;
    const data = liverFilmGeometry(model, cut, { depthM: new Float64Array([.0001, 0, .0002]) }, rgb(), .75);
    const clippedArea = .01 * .015 / 2;
    expect(data.volumeM3).toBeCloseTo(clippedArea * (.0001 + .00005 + .00015) / 3, 18);
    expect(data.volumeM3).toBeLessThan(.02 * .03 / 2 * .0001);
    expect(data.positions[4]).toBeCloseTo(-.05, 8); expect(data.positions[7]).toBeCloseTo(-.15, 7);
  });
  it("keeps the complete original dry silhouette and zero blood inventory", () => {
    const data = liverFilmGeometry(anatomy(), uncut(), { depthM: new Float64Array(3) }, rgb(), .75);
    expect(data.volumeM3).toBe(0); expect(data.wetVertices).toBe(0);
    expect(Array.from(data.positions)).toEqual([0, 0, 0, 20, 0, 0, 0, 0, 30]);
    expect(Array.from(data.colours)).toEqual(new Array(12).fill(0));
  });
  it("uses the analytic inclined free-surface normal instead of the dry capsule normal", () => {
    const h0 = .0001, hx = .0003, hz = .0002;
    const data = liverFilmGeometry(anatomy(), uncut(), { depthM: new Float64Array([h0, hx, hz]) }, rgb(), .75);
    // Graph y = -(h0 + dh/dx*x + dh/dz*z); outward orientation is down.
    const dx = (hx - h0) / .02, dz = (hz - h0) / .03, length = Math.hypot(dx, 1, dz);
    for (let i = 0; i < 3; i++) {
      expect(data.normals[i * 3]).toBeCloseTo(-dx / length, 7);
      expect(data.normals[i * 3 + 1]).toBeCloseTo(-1 / length, 7);
      expect(data.normals[i * 3 + 2]).toBeCloseTo(-dz / length, 7);
    }
  });
  it("normalizes the canonical interpolated displacement direction independently of display shading", () => {
    const model = anatomy(), cut = uncut();
    // Deliberately non-unit interpolation on a clipped edge, as occurs on a
    // curved source mesh. The contact module uses this same normalized P1 N.
    model.surface.normals = new Float32Array([0, -1, 0, .6, -.8, 0, 0, -.8, .6]);
    cut.surface.positionsM = new Float64Array([0, 0, 0, .01, 0, 0, 0, 0, .015]);
    cut.sourceBarycentrics = new Float64Array([1, 0, 0, .5, .5, 0, .5, 0, .5]);
    const h = .0004, data = liverFilmGeometry(model, cut, { depthM: new Float64Array([h, h, h]) }, rgb(), .75);
    const magnitude = Math.hypot(.3, -.9);
    expect(data.positions[3]).toBeCloseTo((.01 + h * .3 / magnitude) * 1000, 6);
    expect(data.positions[4]).toBeCloseTo(-h * .9 / magnitude * 1000, 6);
    expect(data.positions[7]).toBeCloseTo(-h * .9 / magnitude * 1000, 6);
    expect(data.positions[8]).toBeCloseTo((.015 + h * .3 / magnitude) * 1000, 6);
    expect(data.volumeM3).toBeCloseTo(.01 * .015 / 2 * h, 18);
  });
  it("rejects invalid mappings and nonfinite or negative accepted thickness", () => {
    for (const values of [[0, NaN, 0], [0, -.1, 0], [0, 0]]) {
      expect(() => liverFilmGeometry(anatomy(), uncut(), { depthM: new Float64Array(values) }, rgb(), .98)).toThrow();
    }
    const cut = uncut(); cut.sourceBarycentrics[0] = .5;
    expect(() => liverFilmGeometry(anatomy(), cut, { depthM: new Float64Array(3) }, rgb(), .98)).toThrow();
  });
  it("reuses buffers and skips unchanged uploads while retaining exact P1 integral and dry alpha", () => {
    const cache = createLiverFilmCache(anatomy(), uncut(), rgb());
    const depthM = new Float64Array([.0001, 0, .0002]);
    const first = updateLiverFilmCache(cache, { depthM }, .98), positions = first.positions, colours = first.colours,
      normals = first.normals, savedNormals = Array.from(first.normals),
      physicalDepth = Array.from(depthM), savedThickness = Array.from(first.thicknessM),
      savedCapsuleNormals = Array.from(first.capsuleNormals);
    const repeated = updateLiverFilmCache(cache, { depthM }, .98);
    expect(repeated.positions).toBe(positions); expect(repeated.colours).toBe(colours);
    expect(repeated.normals).toBe(normals); expect(Array.from(repeated.normals)).toEqual(savedNormals);
    expect(repeated.positionChanged).toBe(false); expect(repeated.colourChanged).toBe(false);
    const recoloured = updateLiverFilmCache(cache, { depthM }, .75);
    expect(recoloured.positionChanged).toBe(false); expect(recoloured.colourChanged).toBe(true);
    expect(Array.from(recoloured.normals)).toEqual(savedNormals);
    expect(Array.from(recoloured.thicknessM)).toEqual(savedThickness);
    expect(Array.from(recoloured.capsuleNormals)).toEqual(savedCapsuleNormals);
    expect(Array.from(depthM)).toEqual(physicalDepth);
    expect(recoloured.volumeM3).toBe(first.volumeM3); expect(recoloured.colours[7]).toBe(0);
    const before = Array.from(positions), previousDepth = Array.from(cache.canonicalDepth);
    expect(() => updateLiverFilmCache(cache, { depthM: new Float64Array([0, NaN, 0]) }, .75)).toThrow();
    expect(Array.from(positions)).toEqual(before); expect(Array.from(cache.canonicalDepth)).toEqual(previousDepth);
  });
  it("keeps cached dry/wet derived statistics exact on clipped mappings and validates every canonical input", () => {
    const cut = uncut();
    cut.surface.positionsM = new Float64Array([0, 0, 0, .01, 0, 0, 0, 0, .015]);
    cut.sourceBarycentrics = new Float64Array([1, 0, 0, .5, .5, 0, .5, 0, .5]);
    for (const values of [[0, 0, 0], [.0001, 0, .0002], [1e-30, 2e-30, 0]]) {
      const cache = createLiverFilmCache(anatomy(), cut, rgb()), depthM = new Float64Array(values);
      const first = updateLiverFilmCache(cache, { depthM }, .75);
      const buffers = [first.positions, first.normals, first.colours, first.thicknessM].map(array => array.slice());
      for (let repeat = 0; repeat < 3; repeat++) {
        const same = updateLiverFilmCache(cache, { depthM: depthM.slice() }, .75);
        expect([same.volumeM3, same.maximumDepthM, same.wetVertices])
          .toEqual([first.volumeM3, first.maximumDepthM, first.wetVertices]);
        expect([same.positions, same.normals, same.colours, same.thicknessM]).toEqual(buffers);
        expect(same.positionChanged || same.colourChanged).toBe(false);
      }
      depthM[depthM.length - 1] = NaN;
      expect(() => updateLiverFilmCache(cache, { depthM }, .75)).toThrow();
      expect([cache.positions, cache.normals, cache.colours, cache.thicknessM]).toEqual(buffers);
      expect(() => updateLiverFilmCache(cache, { depthM: new Float64Array(values) }, Infinity)).toThrow();
    }
  });
});
