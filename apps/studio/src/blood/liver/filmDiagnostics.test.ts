import { describe, expect, it } from "vitest";
import { createLiverFilmSlopeEvaluator } from "./filmDiagnostics";
import type { LiverCutGeometry, LiverSurface, LiverVec3 } from "./types";

const basePositions = [0, 0, 0, .004, 0, 0, .004, 0, .006, 0, 0, .006];
function plane(rotate = false): LiverSurface {
  const positions = [...basePositions];
  if (rotate) for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!, y = positions[i + 1]!, z = positions[i + 2]!;
    const X = Math.cos(.73) * x - Math.sin(.73) * y, Y = Math.sin(.73) * x + Math.cos(.73) * y;
    positions.splice(i, 3, X, Math.cos(.41) * Y - Math.sin(.41) * z, Math.sin(.41) * Y + Math.cos(.41) * z);
  }
  return { positionsM: Float64Array.from(positions), indices: Uint32Array.from([0, 2, 1, 0, 3, 2]),
    normals: new Float32Array(positions.length) };
}
type Piece = { triangle: number; corners: [LiverVec3, LiverVec3, LiverVec3] };
function retained(surface: LiverSurface, pieces?: Piece[]): LiverCutGeometry {
  const positions: number[] = [], source: number[] = [], weights: number[] = [];
  const triangles = pieces ?? Array.from({ length: surface.indices.length / 3 }, (_, triangle) => ({
    triangle, corners: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Piece["corners"],
  }));
  for (const piece of triangles) for (const b of piece.corners) {
    source.push(piece.triangle); weights.push(...b);
    for (let k = 0; k < 3; k++) positions.push(b.reduce((sum, w, j) =>
      sum + w * surface.positionsM[surface.indices[piece.triangle * 3 + j]! * 3 + k]!, 0));
  }
  return { surface: { positionsM: Float64Array.from(positions), normals: new Float32Array(positions.length),
    indices: Uint32Array.from(source, (_, i) => i) },
    cavity: { positionsM: new Float64Array(), normals: new Float32Array(), indices: new Uint32Array() },
    sourceTriangles: Uint32Array.from(source), sourceBarycentrics: Float64Array.from(weights), removedAreaM2: 0 };
}
/** Independent explicit 3×3 rectangle grid, triangulated into the four
 * midpoint children of each original triangle. */
function midpointPlane() {
  const p = [...basePositions, .002, 0, 0, .004, 0, .003, .002, 0, .003, 0, 0, .003, .002, 0, .006];
  return { positionsM: Float64Array.from(p), normals: new Float32Array(p.length),
    indices: Uint32Array.from([0, 6, 4, 2, 5, 6, 1, 4, 5, 6, 5, 4, 0, 7, 6, 3, 8, 7, 2, 6, 8, 7, 8, 6]) };
}
function affineHeights(surface: LiverSurface) {
  return Array.from({ length: surface.positionsM.length / 3 }, (_, i) =>
    .002 + .125 * surface.positionsM[3 * i]! - .25 * surface.positionsM[3 * i + 2]!);
}

describe("physical retained-film slope diagnostics", () => {
  it("reports exactly zero for dry and constant films independently of mesh spacing", () => {
    for (const surface of [plane(), midpointPlane(), plane(true)]) {
      const evaluate = createLiverFilmSlopeEvaluator(surface, retained(surface));
      for (const constant of [0, .0001, .004]) {
        const result = evaluate(() => constant);
        expect(result.maximumSurfaceSlope).toBe(0);
        expect(result.areaWeightedRmsSurfaceSlope).toBe(0);
        expect(result.maximumSurfaceSlopeTriangle).toBe(-1);
        expect(result.evaluatedAreaM2).toBeCloseTo(.004 * .006, 18);
      }
    }
  });

  it("matches an independent affine gradient on the retained surface", () => {
    const surface = plane(), h = affineHeights(surface);
    const result = createLiverFilmSlopeEvaluator(surface, retained(surface))(i => h[i]!);
    const expected = Math.hypot(.125, .25);
    expect(result.maximumSurfaceSlope).toBeCloseTo(expected, 14);
    expect(result.areaWeightedRmsSurfaceSlope).toBeCloseTo(expected, 14);
  });

  it("is unchanged by rigid rotation and exact midpoint subdivision of the same physical field", () => {
    const base = plane(), rotated = plane(true), refined = midpointPlane();
    const h = affineHeights(base), fine = affineHeights(refined);
    const a = createLiverFilmSlopeEvaluator(base, retained(base))(i => h[i]!);
    const b = createLiverFilmSlopeEvaluator(rotated, retained(rotated))(i => h[i]!);
    const c = createLiverFilmSlopeEvaluator(refined, retained(refined))(i => fine[i]!);
    for (const other of [b, c]) {
      expect(other.maximumSurfaceSlope).toBeCloseTo(a.maximumSurfaceSlope, 14);
      expect(other.areaWeightedRmsSurfaceSlope).toBeCloseTo(a.areaWeightedRmsSurfaceSlope, 14);
      expect(other.evaluatedAreaM2).toBeCloseTo(a.evaluatedAreaM2, 18);
    }
  });

  it("uses actual retained area for RMS, without smoothing away piecewise-affine slope changes", () => {
    const surface = plane(), h = [.0001, .0003, .0002, .00045];
    const geometry = retained(surface, [
      { triangle: 0, corners: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
      { triangle: 1, corners: [[1, 0, 0], [.5, .5, 0], [.5, 0, .5]] },
    ]);
    const result = createLiverFilmSlopeEvaluator(surface, geometry)(i => h[i]!);
    const g0 = Math.hypot((h[1]! - h[0]!) / .004, (h[2]! - h[1]!) / .006);
    const g1 = Math.hypot((h[2]! - h[3]!) / .004, (h[3]! - h[0]!) / .006);
    expect(result.maximumSurfaceSlope).toBeCloseTo(Math.max(g0, g1), 14);
    expect(result.maximumSurfaceSlopeTriangle).toBe(1);
    expect(result.areaWeightedRmsSurfaceSlope).toBeCloseTo(Math.sqrt((g0 ** 2 + .25 * g1 ** 2) / 1.25), 14);
    expect(result.evaluatedAreaM2).toBeCloseTo(.004 * .006 * .625, 18);
  });

  it("preserves a general parent P1 field under subdivision, not only globally affine films", () => {
    const base = plane(), refined = midpointPlane(), h = [.0001, .0003, .0002, .00045];
    const fine = [...h, (h[0]! + h[1]!) / 2, (h[1]! + h[2]!) / 2, (h[0]! + h[2]!) / 2,
      (h[0]! + h[3]!) / 2, (h[2]! + h[3]!) / 2];
    const a = createLiverFilmSlopeEvaluator(base, retained(base))(i => h[i]!);
    const b = createLiverFilmSlopeEvaluator(refined, retained(refined))(i => fine[i]!);
    expect(b.maximumSurfaceSlope).toBeCloseTo(a.maximumSurfaceSlope, 14);
    expect(b.areaWeightedRmsSurfaceSlope).toBeCloseTo(a.areaWeightedRmsSurfaceSlope, 14);
  });

  it("ignores removed faces and handles a small retained fragment without a spurious huge gradient", () => {
    const surface = plane(), h = affineHeights(surface), epsilon = 1e-6;
    const geometry = retained(surface, [{ triangle: 1,
      corners: [[1, 0, 0], [1 - epsilon, epsilon, 0], [1 - epsilon, 0, epsilon]] }]);
    const result = createLiverFilmSlopeEvaluator(surface, geometry)(i => h[i]!);
    expect(result.evaluatedSourceTriangles).toBe(1);
    expect(result.maximumSurfaceSlope).toBeCloseTo(Math.hypot(.125, .25), 14);
    expect(result.evaluatedAreaM2).toBeCloseTo(.5 * .004 * .006 * epsilon ** 2, 28);
  });

  it("rejects invalid mappings/heights without mutating geometry or corrupting later evaluations", () => {
    const surface = plane(), geometry = retained(surface), h = affineHeights(surface);
    const before = structuredClone(geometry), evaluate = createLiverFilmSlopeEvaluator(surface, geometry);
    const accepted = evaluate(i => h[i]!);
    for (const invalid of [NaN, Infinity, -.0001]) expect(() => evaluate(() => invalid)).toThrow(/thickness/);
    expect(evaluate(i => h[i]!)).toEqual(accepted);
    expect(geometry).toEqual(before);
    const displaced = structuredClone(geometry); displaced.surface.positionsM[0] = .1;
    expect(() => createLiverFilmSlopeEvaluator(surface, displaced)).toThrow(/mapping/);
    const mixed = structuredClone(geometry); mixed.sourceTriangles[1] = 1;
    expect(() => createLiverFilmSlopeEvaluator(surface, mixed)).toThrow();
    // The compiled evaluator owns coefficients, not references to mutable input.
    surface.positionsM.fill(99); geometry.sourceBarycentrics.fill(NaN);
    expect(evaluate(i => h[i]!)).toEqual(accepted);
  });

  it("matches the complete scan using only active support and retains the full-area RMS denominator", () => {
    const surface = midpointPlane(), evaluate = createLiverFilmSlopeEvaluator(surface, retained(surface));
    const h = new Float64Array(surface.positionsM.length / 3); h[1] = .0002;
    const full = evaluate(i => h[i]!), active = new Set([1]);
    const sparse = evaluate(i => h[i]!, active);
    expect(sparse.sampledSourceTriangles).toBeLessThan(full.sampledSourceTriangles);
    expect({ ...sparse, sampledSourceTriangles: full.sampledSourceTriangles }).toEqual(full);
    expect([...active]).toEqual([1]);
    expect(evaluate(i => h[i]!, [1, 1])).toEqual(sparse);
    const dry = evaluate(() => 0, []);
    expect(dry.sampledSourceTriangles).toBe(0);
    expect(dry.maximumSurfaceSlope).toBe(0); expect(dry.areaWeightedRmsSurfaceSlope).toBe(0);
    expect(dry.evaluatedAreaM2).toBe(full.evaluatedAreaM2);
    expect(() => evaluate(i => h[i]!, [-1])).toThrow(/active/);
    expect(() => evaluate(i => h[i]!, [NaN])).toThrow(/active/);
    expect(evaluate(i => h[i]!, active)).toEqual(sparse);
  });
});
