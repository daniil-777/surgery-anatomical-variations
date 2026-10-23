import { describe, expect, it } from "vitest";
import { createLiverFilmCache, liverFilmFlowActivity, liverFilmReliefScaleM,
  updateLiverFilmCache, LIVER_FILM_VISUAL_RELIEF } from "./renderer";
import type { LiverAnatomy, LiverCutGeometry, LiverSurface } from "./types";

// A flat 7×7 grid (2 mm spacing, normal +y) so a central blood patch has a
// real contact line and dry surroundings.
const N = 7, SPACING = .002;
function grid(): LiverSurface {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { positions.push(i * SPACING, 0, j * SPACING); normals.push(0, 1, 0); }
  for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
    const a = j * N + i, b = a + 1, c = a + N, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { positionsM: new Float64Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}
const anatomy = (): LiverAnatomy => ({
  surface: grid(), organ: { id: "liver", name: "Grid", kind: "liver", positions: [], indices: [], color: "#805040" },
  network: { version: "surface-vessels-design-1.0.0", seed: 1, organ_id: "liver",
    provenance: "procedural-surface-design-not-patient-vasculature", settings: { density: .5, visibility: .7, radius_scale: 1 },
    segments: [], statistics: { terminals: 0, branches: 0, connected_components: 0, length_mm: 0, murray_exponent: 3 } },
  vessels: [], targets: [], provenance: { templateId: "analytic", label: "Grid", source: "test",
    license: "test", vascularModel: "procedural-surface-design-not-patient-vasculature", detail: "Presentation relief oracle" },
});
function uncut(): LiverCutGeometry {
  const surface = grid(), count = N * N, tris = new Uint32Array(count), bary = new Float64Array(count * 3);
  // Map each vertex to a triangle that contains it as a corner.
  for (let k = 0; k < surface.indices.length; k++) {
    const v = surface.indices[k]!; tris[v] = Math.floor(k / 3); bary.fill(0, v * 3, v * 3 + 3); bary[v * 3 + (k % 3)] = 1;
  }
  return { surface, cavity: { positionsM: new Float64Array(), normals: new Float32Array(), indices: new Uint32Array() },
    removedAreaM2: 0, sourceTriangles: tris, sourceBarycentrics: bary };
}

describe("presentation-only blood film relief", () => {
  it("adapts the dome scale to the peak and maps outflow to a monotone activity in [0, 1)", () => {
    expect(liverFilmReliefScaleM(0)).toBe(LIVER_FILM_VISUAL_RELIEF.minimumScaleM);
    expect(liverFilmReliefScaleM(4e-4)).toBeCloseTo(LIVER_FILM_VISUAL_RELIEF.peakFraction * 4e-4, 12);
    expect(liverFilmFlowActivity(0)).toBe(0); expect(liverFilmFlowActivity(-1)).toBe(0); expect(liverFilmFlowActivity(NaN)).toBe(0);
    let previous = 0;
    for (const flow of [1e-9, 1e-8, 1e-7, 1e-6]) {
      const a = liverFilmFlowActivity(flow); expect(a).toBeGreaterThan(previous); expect(a).toBeLessThan(1); previous = a;
    }
    expect(liverFilmFlowActivity(1e-5)).toBeLessThanOrEqual(1);
  });
  it("raises a rounded dome with outward-tilting rim normals while physical buffers stay exact", () => {
    const model = anatomy(), cut = uncut(), count = N * N;
    const cache = createLiverFilmCache(model, cut, new Float32Array(count * 3).fill(.2));
    const depth = new Float64Array(count), centre = 3 * N + 3, peak = 3e-4;
    for (let j = 2; j <= 4; j++) for (let i = 2; i <= 4; i++) depth[j * N + i] = peak * (j === 3 && i === 3 ? 1 : .6);
    const data = updateLiverFilmCache(cache, { depthM: depth }, .75);
    // Physical display buffers are untouched by the relief.
    for (let v = 0; v < count; v++) {
      expect(data.thicknessM[v]).toBeCloseTo(depth[v]!, 9);
      expect(data.positions[v * 3 + 1]).toBeCloseTo(depth[v]! * 1000, 6);
    }
    // Relief: the centre is lifted well above the physical depth, but bounded.
    const lift = data.smoothPositions[centre * 3 + 1]! / 1000;
    expect(lift).toBeGreaterThan(peak + .3 * LIVER_FILM_VISUAL_RELIEF.maximumM);
    expect(lift).toBeLessThanOrEqual(peak + LIVER_FILM_VISUAL_RELIEF.maximumM + 1e-9);
    // Dome: the centre is the highest point and the rim normals lean outward.
    for (let v = 0; v < count; v++) expect(data.smoothPositions[v * 3 + 1]!).toBeLessThanOrEqual(data.smoothPositions[centre * 3 + 1]! + 1e-9);
    const rimEast = 3 * N + 5, rimWest = 3 * N + 1;
    expect(data.smoothNormals[rimEast * 3]!).toBeGreaterThan(.05);
    expect(data.smoothNormals[rimWest * 3]!).toBeLessThan(-.05);
    for (let v = 0; v < count; v++) {
      const n = [data.smoothNormals[v * 3]!, data.smoothNormals[v * 3 + 1]!, data.smoothNormals[v * 3 + 2]!];
      expect(Math.hypot(...n)).toBeCloseTo(1, 5); expect(n[1]).toBeGreaterThan(0);
    }
  });
});

