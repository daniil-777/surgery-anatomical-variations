import { describe, expect, it } from "vitest";
import { LiverSurfaceFlow, intactLiverFilmGeometry } from "./surfaceFlow";
import { LiverSurfaceCollision } from "./surfaceCollision";
import type { LiverSurface } from "./types";
import type { VesselLandingEvent, VesselVector } from "../experiments/vesselSolver";

function plane(n = 8, slope = 0, rotation = 0): LiverSurface {
  const p: number[] = [], normal: number[] = [], indices: number[] = [];
  const transform = ([x, y, z]: number[]) => [Math.cos(rotation) * x! - Math.sin(rotation) * z!, y!,
    Math.sin(rotation) * x! + Math.cos(rotation) * z!];
  const norm = Math.hypot(slope, 1);
  for (let z = 0; z <= n; z++) for (let x = 0; x <= n; x++) {
    p.push(...transform([.04 * x / n, .05 - slope * .04 * x / n, .04 * z / n]));
    normal.push(...transform([slope / norm, 1 / norm, 0]));
  }
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const i = z * (n + 1) + x; indices.push(i, i + n + 1, i + 1, i + 1, i + n + 1, i + n + 2);
  }
  return { positionsM: Float64Array.from(p), normals: Float32Array.from(normal), indices: Uint32Array.from(indices) };
}
function event(surface: LiverSurface, vertex: number, volumeM3: number, timeSeconds = .002, id = vertex): VesselLandingEvent {
  const index = surface.indices.indexOf(vertex), local = index % 3;
  return { id, holeId: "test", timeSeconds, volumeM3, velocityMS: [0, 0, 0], supportRadiusM: 0,
    positionM: [surface.positionsM[3 * vertex]!, surface.positionsM[3 * vertex + 1]!, surface.positionsM[3 * vertex + 2]!],
    surface: { triangle: Math.floor(index / 3), barycentric: [local === 0 ? 1 : 0, local === 1 ? 1 : 0, local === 2 ? 1 : 0] } };
}
function volumeMoment(s: ReturnType<LiverSurfaceFlow["snapshot"]>, surface: LiverSurface, direction: VesselVector) {
  return s.depthM.reduce((m, h, i) => m + h * s.vertexAreaM2[i]!
    * direction.reduce((v, d, k) => v + d * surface.positionsM[3 * i + k]!, 0), 0) / s.filmVolumeM3;
}

describe("conservative curved-surface reduced film", () => {
  it("starts exactly dry, never creates a precursor or unforced motion", () => {
    const f = new LiverSurfaceFlow(plane());
    for (let i = 0; i < 50; i++) f.step();
    expect(f.snapshot().depthM.every(v => v === 0)).toBe(true);
    expect(f.snapshot().filmVolumeM3).toBe(0); expect(f.snapshot().escapedVolumeM3).toBe(0);
  });
  it("matches the independent Nusselt mean speed for a uniform inclined laminar film", () => {
    const slope = .2, surface = plane(12, slope), h = 20e-6, f = new LiverSurfaceFlow(surface, { surfaceTensionNM: 0 });
    const area = f.snapshot().vertexAreaM2;
    const before = f.step(Array.from(area, (a, i) => event(surface, i, a * h)));
    const direction: VesselVector = [1 / Math.hypot(1, slope), -slope / Math.hypot(1, slope), 0];
    const after = f.step(), measured = (volumeMoment(after, surface, direction) - volumeMoment(before, surface, direction)) / .002;
    const expected = 1060 * 9.81 * slope / Math.hypot(1, slope) * h * h / (3 * .00345);
    expect(Math.abs(measured / expected - 1)).toBeLessThan(2e-7);
    expect(Math.abs(after.volumeErrorM3)).toBeLessThan(1e-20);
  });
  it("is invariant under rotation about gravity and conserves impact volume and surface energy descent", () => {
    const surfaces = [plane(10, .3), plane(10, .3, .71)], solvers = surfaces.map(s => new LiverSurfaceFlow(s));
    solvers.forEach((s, i) => s.step([event(surfaces[i]!, 60, 4e-10)]));
    for (let k = 0; k < 30; k++) solvers.forEach(s => s.step());
    const a = solvers[0]!.snapshot(), b = solvers[1]!.snapshot();
    a.depthM.forEach((v, i) => expect(Math.abs(v - b.depthM[i]!)).toBeLessThan(1e-12));
    expect(a.depthM.filter(v => v > 0).length).toBeGreaterThan(1);
    expect(a.filmVolumeM3).toBeCloseTo(4e-10, 20);
    expect(solvers[0]!.diagnostics().viscousEnergyLossJ).toBeGreaterThan(0);
  });
  it("preserves volume and exact P1 visible integral after removing retained support", () => {
    const surface = plane(1), f = new LiverSurfaceFlow(surface);
    const initial = f.step([event(surface, 0, 1e-10)]), cut = intactLiverFilmGeometry(surface);
    // Retain just the second triangle: canonical vertex 0 loses all support.
    cut.surface.indices = cut.surface.indices.slice(3);
    f.setRetainedGeometry(cut);
    const after = f.snapshot();
    expect(after.filmVolumeM3).toBeCloseTo(initial.filmVolumeM3, 22);
    expect(after.depthM[0]).toBe(0); expect(f.diagnostics().cutRedistributedVolumeM3).toBeCloseTo(1e-10, 22);
    const t = [1, 2, 3], integral = .04 ** 2 / 2 * t.reduce((s, i) => s + after.depthM[i]!, 0) / 3;
    expect(integral).toBeCloseTo(after.filmVolumeM3, 22);
  });
  it("rejects duplicate impact replay and oversized deposits without changing accepted state", () => {
    const surface = plane(), f = new LiverSurfaceFlow(surface);
    f.step([event(surface, 40, 1e-10)]);
    const before = f.snapshot();
    expect(() => f.step([event(surface, 40, 1e-10, .004)])).toThrow(/duplicate/);
    expect(f.snapshot()).toEqual(before);
    expect(() => f.step([event(surface, 41, 1e-3, .004)])).toThrow();
    expect(f.snapshot()).toEqual(before);
    const token = f.checkpoint(); f.step(); f.restore(token); expect(f.snapshot()).toEqual(before);
  });
  it("accounts for missed impacts and unsupported underside drainage without coloring dry tissue", () => {
    const surface = plane(); surface.normals = Float32Array.from(surface.normals, v => -v);
    const f = new LiverSurfaceFlow(surface), hit = event(surface, 40, 1e-10);
    f.step([hit, { ...hit, id: 100, surface: undefined } as unknown as VesselLandingEvent]);
    expect(f.snapshot().filmVolumeM3).toBe(0);
    expect(f.snapshot().escapedVolumeM3).toBeCloseTo(2e-10, 22);
    expect(f.diagnostics().undersideDrainedVolumeM3).toBeCloseTo(1e-10, 22);
  });
  it("rejects meaningful contact with unresolved source boundaries and preserves accepted volume and time", () => {
    const surface = plane(8), f = new LiverSurfaceFlow(surface, { rejectOpenBoundaryContact: true });
    f.step([event(surface, 40, 1e-10)]);
    const before = f.snapshot();
    expect(() => f.step([event(surface, 0, 2e-10, .004, 12345)])).toThrow(/open boundary.*rolled back/);
    expect(f.snapshot()).toEqual(before);
    expect(f.diagnostics().sourceBoundaryVertices).toBe(32);
    expect(f.diagnostics().sourceBoundaryContactVolumeM3).toBe(0);
  });
});

describe("retained liver surface ballistic collision", () => {
  it("matches independent flat-plane ballistic impact and canonical surface coordinates", () => {
    const s = plane(3), c = new LiverSurfaceCollision(s, intactLiverFilmGeometry(s), -.1);
    const hit = c.contact([.02, .1, .02], [0, 0, 0], [0, -9.81, 0], 0, 0, .2, 0)!;
    expect(hit.timeSeconds).toBeCloseTo(Math.sqrt(2 * .05 / 9.81), 12);
    expect(hit.positionM[1]).toBeCloseTo(.05, 13);
    expect(hit.surface!.barycentric.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 13);
  });
  it("contacts the previous accepted film and finite droplet support earlier than bare tissue", () => {
    const s = plane(2), c = new LiverSurfaceCollision(s, intactLiverFilmGeometry(s), -.1);
    c.setAcceptedFilm(() => .001, .001);
    const hit = c.contact([.02, .1, .02], [0, 0, 0], [0, -9.81, 0], 0, 0, .2, .002)!;
    expect(hit.timeSeconds).toBeCloseTo(Math.sqrt(2 * .047 / 9.81), 12);
    expect(hit.positionM[1]).toBeCloseTo(.051, 13);
  });
  it("intersects the exact smooth-normal displaced triangle on a steep curved-normal fixture", () => {
    const s: LiverSurface = { positionsM: Float64Array.from([0, .05, 0, .04, .05, 0, 0, .05, .04]),
      normals: Float32Array.from([0, 1, 0, .8, .6, 0, 0, .6, .8]), indices: Uint32Array.from([0, 2, 1]) };
    const c = new LiverSurfaceCollision(s, intactLiverFilmGeometry(s), -.1), depths = [.001, .003, .002];
    c.setAcceptedFilm(i => depths[i]!, .003);
    // Independently construct A + .001*nA, B + .003*normalize(nB),
    // C + .002*normalize(nC), then their (.2,.3,.5) barycentre.
    const displaced = [0, 1, 2].map(i => {
      const n = Array.from(s.normals.slice(i * 3, i * 3 + 3)), length = Math.hypot(...n);
      return [0, 1, 2].map(k => s.positionsM[i * 3 + k]! + depths[i]! * n[k]! / length);
    });
    const target = [0, 1, 2].map(k => .2 * displaced[0]![k]! + .3 * displaced[1]![k]! + .5 * displaced[2]![k]!);
    const hit = c.contact([target[0]!, target[1]! + .02, target[2]!], [0, -1, 0], [0, 0, 0], 0, 0, .04, 0)!;
    expect(hit.timeSeconds).toBeCloseTo(.02, 12);
    hit.positionM.forEach((v, i) => expect(v).toBeCloseTo(target[i]!, 12));
    hit.surface!.barycentric.forEach((v, i) => expect(v).toBeCloseTo([.2, .5, .3][i]!, 12));
  });
  it("does not hit removed skin and sends a missed organ to the explicit escape plane", () => {
    const s = plane(1), cut = intactLiverFilmGeometry(s); cut.surface.indices = cut.surface.indices.slice(3);
    const c = new LiverSurfaceCollision(s, cut, -.1);
    const throughHole = c.contact([.005, .06, .005], [0, -1, 0], [0, -9.81, 0], 0, 0, .02, 0);
    expect(throughHole).toBeUndefined();
    const missed = c.contact([.1, .1, .1], [0, 0, 0], [0, -9.81, 0], 0, 0, .3, 0)!;
    expect(missed.surface).toBeUndefined(); expect(missed.positionM[1]).toBe(-.1);
  });
});
