import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import { evaluateVesselAnchor, type AtlasVesselAnchor } from "../../atlasVessels";
import { adaptLiverAnatomy } from "./anatomy";
import { refineLiverAnatomy } from "./refinement";
import { buildLiverCutGeometry, prepareLiverCut } from "./wounds";
import type { LiverAnatomy, LiverSurface, LiverVec3 } from "./types";

function reference() {
  return adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL(
    "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
}
function area(surface: LiverSurface, t: number) {
  const points = [0, 1, 2].map(j => {
    const i = surface.indices[3 * t + j]!;
    return Array.from(surface.positionsM.subarray(3 * i, 3 * i + 3));
  });
  const u = points[1]!.map((x, k) => x - points[0]![k]!);
  const v = points[2]!.map((x, k) => x - points[0]![k]!);
  return Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!,
    u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) * .5;
}
function topology(surface: LiverSurface) {
  const edges = new Map<string, { a: number; b: number; count: number; orientation: number }>();
  for (let t = 0; t < surface.indices.length; t += 3) for (let j = 0; j < 3; j++) {
    const a = surface.indices[t + j]!, b = surface.indices[t + (j + 1) % 3]!;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const edge = edges.get(key) ?? { a, b, count: 0, orientation: 0 };
    edge.count++; edge.orientation += a < b ? 1 : -1; edges.set(key, edge);
  }
  let boundary = 0, boundaryLengthM = 0, invalid = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) {
      boundary++;
      boundaryLengthM += Math.hypot(...[0, 1, 2].map(k =>
        surface.positionsM[edge.a * 3 + k]! - surface.positionsM[edge.b * 3 + k]!));
    } else if (edge.count !== 2 || edge.orientation !== 0) invalid++;
  }
  return { edges: edges.size, boundary, boundaryLengthM, invalid };
}
function fixture(): LiverAnatomy {
  const positions = [0, 0, 0, 4, 0, 0, 4, 0, 6, 0, 0, 6], indices = [0, 2, 1, 0, 3, 2];
  const normals = [0, 1, 0, .1, .99, 0, .1, .98, .1, 0, .99, .1];
  const anchors: AtlasVesselAnchor[] = [
    [1, 0, 0], [0, 1, 0], [0, 0, 1], [.5, .5, 0], [.5, 0, .5], [0, .5, .5],
    [.7, .2, .1], [.1, .8, .1], [.2, .1, .7], [.2, .4, .4],
  ].map((weights, i) => ({ triangle: i % 2, weights: weights as LiverVec3 }));
  const segments = anchors.map(anchor => ({ a_mm: evaluateVesselAnchor(anchor, positions, indices),
    b_mm: evaluateVesselAnchor(anchor, positions, indices), normal: [0, 1, 0] as LiverVec3,
    radius_a_mm: .1, radius_b_mm: .1, depth_mm: .5, kind: 0 as const,
    a_anchor: anchor, b_anchor: anchor }));
  return {
    surface: { positionsM: Float64Array.from(positions, x => x * .001),
      normals: Float32Array.from(normals), indices: Uint32Array.from(indices) },
    organ: { id: "liver", name: "Analytical capsule", kind: "organ", color: "#804020", positions, indices,
      normals, colors: [.1, .2, .3, .4, .5, .6, .7, .8, .9, .2, .4, .6],
      uv: [0, 0, 1, 0, 1, 1, 0, 1],
      ...{ rest_positions: positions.map(x => x * 2 + 3), material_regions: [0, 0, 0, 0] },
      metadata: { material_v2: { untouched: "recipe" }, liver_capsule_source_vertices: [10, 20, 30, 40] } },
    network: { version: "surface-vessels-design-1.0.0", seed: 42, organ_id: "liver",
      provenance: "procedural-surface-design-not-patient-vasculature",
      settings: { density: .45, visibility: 1, radius_scale: 1 }, segments,
      statistics: { terminals: 10, branches: 0, connected_components: 10, length_mm: 0, murray_exponent: 3 } },
    vessels: segments.map((s, i) => ({ id: `v${i}`, aM: s.a_mm.map(x => x * .001) as LiverVec3,
      bM: s.b_mm.map(x => x * .001) as LiverVec3, normal: [0, 1, 0], radiusAM: .0001, radiusBM: .0001,
      depthM: .0005, aTriangle: s.a_anchor.triangle, bTriangle: s.b_anchor.triangle })),
    targets: anchors.map((anchor, i) => ({ id: `t${i}`, label: `Target ${i}`, vesselId: `v${i}`,
      pick: { triangle: anchor.triangle, barycentric: [...anchor.weights],
        positionM: evaluateVesselAnchor(anchor, positions, indices).map(x => x * .001) as LiverVec3, normal: [0, 1, 0] } })),
    sourceTriangleIndices: Uint32Array.from([7, 11]), sourceVertexIndices: Uint32Array.from([10, 20, 30, 40]),
    provenance: { templateId: "plane", label: "Analytical fixture", source: "fixture", license: "fixture",
      vascularModel: "procedural-surface-design-not-patient-vasculature", detail: "Two adjacent planar triangles" },
  };
}

describe("bounded conforming liver physics refinement", () => {
  it("shares midpoint vertices, preserves winding and boundaries, and leaves the input untouched", () => {
    const base = fixture(), before = structuredClone(base), refined = refineLiverAnatomy(base);
    expect(refineLiverAnatomy(base, 0)).toBe(base);
    expect(refined.surface.positionsM.length / 3).toBe(9);
    expect(refined.surface.indices.length / 3).toBe(8);
    expect(topology(refined.surface)).toMatchObject({ edges: 16, boundary: 8, invalid: 0 });
    expect(topology(refined.surface).boundaryLengthM).toBeCloseTo(.020, 15);
    for (let t = 0; t < 2; t++) {
      const childArea = [0, 1, 2, 3].reduce((sum, c) => sum + area(refined.surface, 4 * t + c), 0);
      expect(childArea).toBeCloseTo(area(base.surface, t), 20);
    }
    expect(base).toEqual(before);
    expect(refined.organ.metadata!.material_v2).toEqual(base.organ.metadata!.material_v2);
    expect(refined.sourceVertexIndices).toBeUndefined();
    expect(refined.organ.metadata!.liver_capsule_source_vertices).toBeUndefined();
  });

  it("preserves source-face P1 geometry, raw normal directions, UV, pigment and rest attributes", () => {
    const base = fixture(), refined = refineLiverAnatomy(base), map = refined.refinement!;
    const attrs = ["positions", "normals", "colors", "uv", "rest_positions", "material_regions"] as const;
    const old = base.organ as unknown as Record<typeof attrs[number], number[]>;
    const next = refined.organ as unknown as Record<typeof attrs[number], number[]>;
    for (let i = 0; i < refined.surface.positionsM.length / 3; i++) {
      const t = map.vertexParentTriangles[i]!, b = Array.from(map.vertexParentBarycentrics.subarray(i * 3, i * 3 + 3));
      expect(b.reduce((s, x) => s + x, 0)).toBe(1);
      expect(Math.min(...b)).toBeGreaterThanOrEqual(0);
      expect(refined.sourceVertexTriangles![i]).toBe(base.sourceTriangleIndices![t]);
      for (const attr of attrs) {
        const stride = attr === "uv" ? 2 : attr === "material_regions" ? 1 : 3;
        for (let k = 0; k < stride; k++) {
          // The canonical normal buffers are float32; their interpolation
          // preserves the field to its existing storage precision.
          const original = attr === "normals" ? base.surface.normals : old[attr];
          const expected = b.reduce((s, w, j) => s + w * original[base.surface.indices[t * 3 + j]! * stride + k]!, 0);
          expect(next[attr][i * stride + k]).toBeCloseTo(expected, attr === "normals" ? 7 : 13);
        }
      }
      for (let k = 0; k < 3; k++) expect(refined.surface.positionsM[3 * i + k])
        .toBeCloseTo(refined.organ.positions[3 * i + k]! * .001, 16);
    }
  });

  it("remaps all child regions and edge ties without moving targets or authored vessel geometry", () => {
    const base = fixture(), refined = refineLiverAnatomy(base);
    for (let i = 0; i < base.targets.length; i++) {
      const target = refined.targets[i]!, original = base.targets[i]!;
      expect(target.pick.positionM).toEqual(original.pick.positionM);
      expect(target.pick.normal).toEqual(original.pick.normal);
      const restored = evaluateVesselAnchor({ triangle: target.pick.triangle, weights: target.pick.barycentric },
        refined.surface.positionsM, refined.surface.indices);
      restored.forEach((x, k) => expect(x).toBeCloseTo(original.pick.positionM[k]!, 16));
      const s = refined.network.segments[i]!, old = base.network.segments[i]!;
      expect({ ...s, a_anchor: old.a_anchor, b_anchor: old.b_anchor }).toEqual(old);
      expect(refined.vessels[i]!.aM).toEqual(base.vessels[i]!.aM);
      expect(refined.vessels[i]!.bM).toEqual(base.vessels[i]!.bM);
      for (const anchor of [s.a_anchor, s.b_anchor]) {
        const p = evaluateVesselAnchor(anchor, refined.organ.positions, refined.organ.indices);
        p.forEach((x, k) => expect(x).toBeCloseTo(old.a_mm[k]!, 13));
      }
    }
  });

  it("preserves the exact integral of any inherited nonnegative P1 film", () => {
    const base = fixture(), refined = refineLiverAnatomy(base), values = [0, .00012, .00004, .0002];
    const map = refined.refinement!, fineValues = Array.from(map.vertexParentTriangles, (t, i) =>
      [0, 1, 2].reduce((s, j) => s + map.vertexParentBarycentrics[i * 3 + j]!
        * values[base.surface.indices[t * 3 + j]!]!, 0));
    const integral = (surface: LiverSurface, h: number[]) => {
      const dual = new Float64Array(h.length);
      for (let t = 0; t < surface.indices.length / 3; t++)
        for (let j = 0; j < 3; j++) dual[surface.indices[t * 3 + j]!]! += area(surface, t) / 3;
      expect(dual.every(a => a > 0)).toBe(true);
      return h.reduce((s, v, i) => s + v * dual[i]!, 0);
    };
    expect(fineValues.every(v => v >= 0)).toBe(true);
    expect(integral(refined.surface, fineValues)).toBeCloseTo(integral(base.surface, values), 22);
  });

  it("refines the actual capsule below budget with unchanged area, attachments and usable cut targets", () => {
    const base = reference(), start = performance.now(), fine = refineLiverAnatomy(base);
    expect(fine.surface.positionsM.length / 3).toBe(60299);
    expect(fine.surface.indices.length / 3).toBe(120136);
    const oldTopology = topology(base.surface), newTopology = topology(fine.surface);
    expect(newTopology.invalid).toBe(0); expect(newTopology.boundary).toBe(460);
    expect(newTopology.boundaryLengthM).toBeCloseTo(oldTopology.boundaryLengthM, 12);
    let maximumRelativeAreaError = 0, maximumAnchorErrorMM = 0;
    for (let t = 0; t < base.surface.indices.length / 3; t++) {
      const childArea = [0, 1, 2, 3].reduce((sum, c) => sum + area(fine.surface, 4 * t + c), 0);
      maximumRelativeAreaError = Math.max(maximumRelativeAreaError, Math.abs(childArea / area(base.surface, t) - 1));
    }
    for (let i = 0; i < fine.network.segments.length; i++) {
      const current = fine.network.segments[i]!, previous = base.network.segments[i]!;
      for (const side of ["a", "b"] as const) {
        const p = evaluateVesselAnchor(current[`${side}_anchor`], fine.organ.positions, fine.organ.indices);
        maximumAnchorErrorMM = Math.max(maximumAnchorErrorMM, Math.hypot(...p.map((x, k) => x - previous[`${side}_mm`][k]!)));
      }
    }
    expect(maximumRelativeAreaError).toBeLessThan(1e-12);
    expect(maximumAnchorErrorMM).toBeLessThan(1e-10);
    const coarseCut = prepareLiverCut(base, [], { pick: base.targets[0]!.pick, radiusM: .00125, depthM: .001, timeSeconds: 0 });
    const fineCut = prepareLiverCut(fine, [], { pick: fine.targets[0]!.pick, radiusM: .00125, depthM: .001, timeSeconds: 0 });
    expect(fineCut.outcome).toBe(coarseCut.outcome); expect(fineCut.outcome).toBe("vessel-hit");
    expect(fineCut.wound!.vesselId).toBe(coarseCut.wound!.vesselId);
    expect(fineCut.wound!.apertureRadiusM).toBeCloseTo(coarseCut.wound!.apertureRadiusM, 14);
    const cut = buildLiverCutGeometry(fine, [fineCut.wound!]);
    const referenceCut = buildLiverCutGeometry(base, [coarseCut.wound!]);
    expect(cut.removedAreaM2).toBeCloseTo(referenceCut.removedAreaM2, 14);
    expect(cut.surface.positionsM.every(Number.isFinite)).toBe(true);
    console.info("Liver midpoint refinement evidence", { vertices: 60299, faces: 120136,
      maximumRelativeAreaError, maximumAnchorErrorMM, geometryValidationMs: performance.now() - start });
  }, 60000);

  it("rejects unsupported levels, repeated subdivision and over-budget input without mutation", () => {
    const base = fixture(), before = structuredClone(base);
    expect(() => refineLiverAnatomy(base, 2 as 1)).toThrow(/levels/);
    expect(() => refineLiverAnatomy(refineLiverAnatomy(base))).toThrow(/only once/);
    const large = fixture(), count = 99999;
    large.surface.positionsM = new Float64Array(count * 3);
    large.surface.normals = new Float32Array(count * 3);
    large.organ.positions = new Array(count * 3).fill(0);
    expect(() => refineLiverAnatomy(large)).toThrow(/budget/);
    expect(base).toEqual(before);
  });
});
