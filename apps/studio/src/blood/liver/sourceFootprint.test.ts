import { describe, expect, it } from "vitest";
import { buildLiverAttachmentFootprint } from "./sourceFootprint";
import { LiverSurfaceFlow, intactLiverFilmGeometry } from "./surfaceFlow";
import type { LiverSurface } from "./types";
import type { VesselLandingEvent } from "../experiments/vesselSolver";

const square = (): LiverSurface => ({
  positionsM: Float64Array.from([-.004, 0, -.004, .004, 0, -.004, -.004, 0, .004, .004, 0, .004]),
  normals: Float32Array.from([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  indices: Uint32Array.from([0, 2, 1, 1, 2, 3]),
});
const radius = .001;
const source = (id: number, volumeM3: number, start = 0, end = .002): VesselLandingEvent => ({
  id, holeId: "wound", timeSeconds: (start + end) / 2, volumeM3, positionM: [0, 0, 0],
  velocityMS: [0, -.1, 0], supportRadiusM: 0,
  surface: { triangle: 0, barycentric: [0, .5, .5] },
  sourceAttachment: { startTimeSeconds: start, endTimeSeconds: end, radiusM: radius },
});
describe("physical aperture footprint and constant-flux attachment", () => {
  it("integrates actual retained area and P1 fields with a bounded inscribed-disk error", () => {
    const mesh = square(), cut = intactLiverFilmGeometry(mesh);
    const p = buildLiverAttachmentFootprint(mesh, cut, [0, 0, 0], [0, 1, 0], radius);
    const exactPolygonArea = 32 * radius ** 2 * Math.sin(Math.PI / 32);
    expect(p.areaM2).toBeCloseTo(exactPolygonArea, 17);
    expect(Math.abs(p.areaM2 / (Math.PI * radius ** 2) - 1)).toBeLessThan(.00161);
    expect(p.weights.reduce((s, w) => s + w, 0)).toBeCloseTo(1, 14);
    for (const axis of [0, 2]) expect(Array.from(p.indices).reduce((s, i, j) =>
      s + p.weights[j]! * mesh.positionsM[3 * i + axis]!, 0)).toBeCloseTo(0, 15);
    // Removing one actual triangle retains precisely half this symmetric disk.
    cut.surface.indices = cut.surface.indices.slice(0, 3);
    const half = buildLiverAttachmentFootprint(mesh, cut, [0, 0, 0], [0, 1, 0], radius);
    expect(half.areaM2).toBeCloseTo(p.areaM2 / 2, 17);
    expect(Array.from(half.indices)).not.toContain(3);
  });
  it("adds the exact source ODE volume and no unforced spreading on a force-free surface", () => {
    const mesh = square(), cut = intactLiverFilmGeometry(mesh);
    const p = buildLiverAttachmentFootprint(mesh, cut, [0, 0, 0], [0, 1, 0], radius);
    const f = new LiverSurfaceFlow(mesh, { gravityMS2: [0, 0, 0], surfaceTensionNM: 0 });
    const s = f.step([source(1, 1e-9)], new Map([["wound", p]]));
    expect(s.inputVolumeM3).toBeCloseTo(1e-9, 23);
    expect(s.filmVolumeM3).toBeCloseTo(1e-9, 23);
    p.indices.forEach((i, j) => expect(s.depthM[i]! * s.vertexAreaM2[i]!).toBeCloseTo(1e-9 * p.weights[j]!, 23));
    expect(f.diagnostics().impactKineticEnergyRemovedJ).toBeCloseTo(.5 * 1060 * 1e-9 * .1 ** 2, 20);
    expect(f.diagnostics().attachmentSubsteps).toBeGreaterThan(0);
  });
  it("treats equivalent temporal subdivisions as the same continuous source", () => {
    const mesh = square(), cut = intactLiverFilmGeometry(mesh);
    const p = buildLiverAttachmentFootprint(mesh, cut, [0, 0, 0], [0, 1, 0], radius);
    const create = () => new LiverSurfaceFlow(mesh, { gravityMS2: [0, 0, 0], surfaceTensionNM: 0 });
    const whole = create().step([source(1, 1e-9)], new Map([["wound", p]]));
    const parts = create().step([source(2, 3e-10, 0, .0006), source(3, 7e-10, .0006, .002)], new Map([["wound", p]]));
    whole.depthM.forEach((h, i) => expect(parts.depthM[i]).toBeCloseTo(h, 16));
    expect(Math.abs(parts.volumeErrorM3)).toBeLessThan(1e-23);
  });
  it("rejects malformed intervals, missing footprints and replay without advancing inventory or time", () => {
    const mesh = square(), f = new LiverSurfaceFlow(mesh), before = f.snapshot();
    const p = buildLiverAttachmentFootprint(mesh, intactLiverFilmGeometry(mesh), [0, 0, 0], [0, 1, 0], radius);
    expect(() => f.step([source(1, 1e-9)])).toThrow(/attachment source/);
    expect(f.snapshot()).toEqual(before);
    expect(() => f.step([source(1, 1e-9, -.001, .002)], new Map([["wound", p]]))).toThrow();
    expect(f.snapshot()).toEqual(before);
    f.step([source(1, 1e-9)], new Map([["wound", p]]));
    const accepted = f.snapshot();
    expect(() => f.step([source(1, 1e-9, .002, .004)], new Map([["wound", p]]))).toThrow(/duplicate/);
    expect(f.snapshot()).toEqual(accepted);
  });
});
