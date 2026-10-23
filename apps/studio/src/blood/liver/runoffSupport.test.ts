import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { AtlasGeneration } from "../../atlas";
import type { LiverAnatomy, LiverVec3 } from "./types";
import { adaptLiverAnatomy } from "./anatomy";
import { refineLiverAnatomy } from "./refinement";
import { createPackedRunoffSupportResolver, createRunoffSupportResolver, type PackedRunoffSupportOptions } from "./runoffSupport";

function plane(): LiverAnatomy {
  const positionsM = new Float64Array([0, 0, 0, .01, 0, 0, 0, 0, .01]);
  const indices = new Uint32Array([0, 1, 2]), normals = new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0]);
  return { surface: { positionsM, indices, normals },
    organ: { id: "liver", kind: "organ", name: "Analytical support", color: "#fff",
      positions: Array.from(positionsM, p => p * 1000), indices: Array.from(indices), normals: Array.from(normals) },
    network: { version: "surface-vessels-design-1.0.0", seed: 1, organ_id: "liver",
      provenance: "procedural-surface-design-not-patient-vasculature", settings: { density: .45, visibility: 1, radius_scale: 1 },
      segments: [], statistics: { terminals: 0, branches: 0, connected_components: 0, length_mm: 0, murray_exponent: 3 } },
    vessels: [], targets: [], provenance: { templateId: "fixture", label: "fixture", source: "analytic",
      license: "fixture", vascularModel: "procedural-surface-design-not-patient-vasculature", detail: "Right triangle" } };
}
function reconstruct(anatomy: LiverAnatomy, face: number, barycentric: readonly number[]) {
  return [0, 1, 2].map(k => barycentric.reduce((v, w, j) =>
    v + w * anatomy.surface.positionsM[3 * anatomy.surface.indices[3 * face + j]! + k]!, 0));
}
function checkDisk(anatomy: LiverAnatomy, position: readonly number[], face: number, radius: number) {
  const indices = anatomy.surface.indices, points = [0, 1, 2].map(k => Array.from(anatomy.surface.positionsM
    .subarray(indices[3 * face + k]! * 3, indices[3 * face + k]! * 3 + 3)));
  for (let edge = 0; edge < 3; edge++) {
    const a = points[edge]!, b = points[(edge + 1) % 3]!;
    const u = b.map((value, k) => value - a[k]!), p = position.map((value, k) => value - a[k]!);
    const distance = Math.hypot(u[1]! * p[2]! - u[2]! * p[1]!,
      u[2]! * p[0]! - u[0]! * p[2]!, u[0]! * p[1]! - u[1]! * p[0]!) / Math.hypot(...u);
    expect(distance).toBeGreaterThanOrEqual(radius - 2e-13);
  }
}

describe("source-face finite runoff supports", () => {
  it("projects into the exact physically eroded triangle rather than placing a disk on an edge", () => {
    const anatomy = plane(), before = structuredClone(anatomy), radius = .001;
    const resolve = createRunoffSupportResolver(anatomy, radius, [0, -9.81, 0]);
    expect(resolve.eligibleFaceCount).toBe(1);
    const edge = resolve([0, .02, 0]);
    expect(edge.positionM[0]).toBeCloseTo(radius, 15);
    expect(edge.positionM[1]).toBe(0); expect(edge.positionM[2]).toBeCloseTo(radius, 15);
    expect(edge.normal).toEqual([0, -1, 0]); checkDisk(anatomy, edge.positionM, 0, radius);
    const inside = resolve([.004, -.02, .004]);
    expect(inside.positionM).toEqual([.004, 0, .004]);
    reconstruct(anatomy, inside.surface!.triangle, inside.surface!.barycentric)
      .forEach((v, k) => expect(v).toBeCloseTo(inside.positionM[k]!, 15));
    expect(anatomy).toEqual(before);
  });

  it("reduces to the incenter at the maximum fitting radius and rejects an oversized disk", () => {
    const anatomy = plane(), radius = .01 ** 2 / (.02 + Math.hypot(.01, .01));
    const resolve = createRunoffSupportResolver(anatomy, radius, [0, -1, 0]);
    const a = resolve([1, 0, 2]), b = resolve([-1, -.1, -.5]);
    a.positionM.forEach((v, k) => expect(v).toBeCloseTo(b.positionM[k]!, 15));
    expect(a.positionM[0]).toBeCloseTo(radius, 15); expect(a.positionM[2]).toBeCloseTo(radius, 15);
    expect(() => createRunoffSupportResolver(anatomy, radius * (1 + 1e-8), [0, -1, 0])).toThrow(/No outward/);
  });

  it("uses true facet orientation and transforms covariantly under rigid rotation and translation", () => {
    const anatomy = plane(), q: LiverVec3 = [.001, -.03, .006];
    // Deliberately unrelated shading normals must not tilt physical support.
    anatomy.surface.normals.fill(.3);
    const original = createRunoffSupportResolver(anatomy, .001, [0, -9.81, 0])(q);
    const rotate = (p: readonly number[]): LiverVec3 => [p[2]!, p[0]!, p[1]!];
    const transform = (p: readonly number[]): LiverVec3 => { const r = rotate(p); return [r[0] + .1, r[1] - .2, r[2] + .3]; };
    const transformed = structuredClone(anatomy);
    for (let i = 0; i < anatomy.surface.positionsM.length; i += 3)
      transformed.surface.positionsM.set(transform(Array.from(anatomy.surface.positionsM.subarray(i, i + 3))), i);
    const result = createRunoffSupportResolver(transformed, .001, rotate([0, -9.81, 0]))(transform(q));
    result.positionM.forEach((v, k) => expect(v).toBeCloseTo(transform(original.positionM)[k]!, 14));
    result.normal.forEach((v, k) => expect(v).toBeCloseTo(rotate(original.normal)[k]!, 14));
    expect(() => createRunoffSupportResolver(anatomy, .001, [0, 9.81, 0])).toThrow(/No outward/);
  });

  it("preserves source world supports exactly under midpoint refinement and maps canonical barycentrics correctly", () => {
    const base = plane(), fine = refineLiverAnatomy(base);
    const coarse = createRunoffSupportResolver(base, .001, [0, -9.81, 0]);
    const refined = createRunoffSupportResolver(fine, .001, [0, -9.81, 0]);
    expect(refined.sourceFaceCount).toBe(coarse.sourceFaceCount);
    expect(refined.eligibleFaceCount).toBe(coarse.eligibleFaceCount);
    for (const q of [[0, -.01, 0], [.006, -.01, .001], [.001, -.01, .006], [.003, -.01, .003]] as LiverVec3[]) {
      const a = coarse(q), b = refined(q);
      expect(b.positionM).toEqual(a.positionM); expect(b.normal).toEqual(a.normal);
      reconstruct(fine, b.surface!.triangle, b.surface!.barycentric)
        .forEach((v, k) => expect(v).toBeCloseTo(b.positionM[k]!, 15));
      checkDisk(base, a.positionM, a.surface!.triangle, .001);
    }
    const malformed = structuredClone(fine); malformed.surface.positionsM[3 * base.surface.positionsM.length / 3]! += 1e-6;
    expect(() => createRunoffSupportResolver(malformed, .001, [0, -9.81, 0])).toThrow(/midpoint geometry/);
  });

  it("rejects invalid radius, gravity, query and malformed topology instead of inventing a support offset", () => {
    const base = plane();
    for (const radius of [0, -1, NaN, Infinity])
      expect(() => createRunoffSupportResolver(base, radius, [0, -9.81, 0])).toThrow();
    expect(() => createRunoffSupportResolver(base, .001, [0, 0, 0])).toThrow();
    const resolve = createRunoffSupportResolver(base, .001, [0, -9.81, 0]);
    expect(() => resolve([NaN, 0, 0])).toThrow();
    const bad = structuredClone(base); bad.surface.indices[0] = 999;
    expect(() => createRunoffSupportResolver(bad, .001, [0, -9.81, 0])).toThrow(/bounds/);
  });

  it("measures1mm and0.5mm fitting supports on the actual original HRA source and proves refined invariance", () => {
    const base = adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL(
      "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
    const fine = refineLiverAnatomy(base), grid = .004, samples = new Map<string, LiverVec3>();
    for (let i = 0; i < base.surface.positionsM.length / 3; i++) if (base.surface.normals[3 * i + 1]! < -.05) {
      const key = [0, 1, 2].map(k => Math.floor(base.surface.positionsM[3 * i + k]! / grid));
      samples.set(key.join(","), key.map(value => (value + .5) * grid) as LiverVec3);
    }
    const all = [...samples.values()], queries = Array.from({ length: Math.min(64, all.length) },
      (_, i) => all[Math.floor(i * all.length / Math.min(64, all.length))]!);
    const rows = [];
    for (const radius of [.001, .0005]) {
      const coarse = createRunoffSupportResolver(base, radius, [0, -9.81, 0]);
      const refined = createRunoffSupportResolver(fine, radius, [0, -9.81, 0]);
      const distances: number[] = [];
      for (const q of queries) {
        const a = coarse(q), b = refined(q);
        expect(b.positionM).toEqual(a.positionM); expect(b.normal).toEqual(a.normal);
        checkDisk(base, a.positionM, a.surface!.triangle, radius);
        reconstruct(fine, b.surface!.triangle, b.surface!.barycentric)
          .forEach((v, k) => expect(v).toBeCloseTo(a.positionM[k]!, 13));
        distances.push(Math.hypot(...q.map((v, k) => v - a.positionM[k]!)));
      }
      distances.sort((a, b) => a - b);
      rows.push({ radiusMM: radius * 1000, sourceFaces: coarse.sourceFaceCount, eligibleFaces: coarse.eligibleFaceCount,
        samples: queries.length, within4MM: distances.filter(d => d <= grid).length,
        medianMM: distances[Math.floor(distances.length / 2)]! * 1000, maximumMM: distances.at(-1)! * 1000 });
    }
    console.info("HRA physical runoff support fit", JSON.stringify(rows));
  }, 20_000);
});

const packing: PackedRunoffSupportOptions = { contactRadiusM: .0005, neckLengthM: .00025,
  criticalVolumeM3: 2 * Math.PI * .0005 * .055 / (1060 * 9.81),
  supportSpacingM: .004, gridOriginM: [0, 0, 0], gravityMS2: [0, -9.81, 0] };
function largePlane() {
  const source = plane();
  source.surface.positionsM = new Float64Array([-.02, 0, -.02, .02, 0, -.02, -.02, 0, .02]);
  source.organ.positions = Array.from(source.surface.positionsM, p => p * 1000);
  return source;
}
function sourceCell(key: string): LiverVec3 {
  return key.replace(/^pinning:/, "").split(",").map(Number).map(v => (v + .5) * packing.supportSpacingM) as LiverVec3;
}
describe("immutable physical runoff support packing", () => {
  it("gives aliased source cells one immutable support identity independently of query order", () => {
    const source = largePlane(), before = structuredClone(source), resolve = createPackedRunoffSupportResolver(source, packing);
    const rows = [];
    for (let x = -5; x <= 4; x++) for (let y = -1; y <= 0; y++) for (let z = -5; z <= 4; z++) {
      const point: LiverVec3 = [(x + .5) * .004, (y + .5) * .004, (z + .5) * .004];
      try { rows.push({ point, anchor: resolve(point) }); } catch { /* Explicit unsupported cells are allowed here. */ }
    }
    expect(rows.length).toBeGreaterThan(resolve.supports.length);
    const byId = new Map<string, (typeof rows)[number]["anchor"]>();
    for (const row of [...rows].reverse()) {
      const result = resolve(row.point);
      expect(result).toEqual(row.anchor);
      expect(Math.hypot(...result.positionM.map((v, k) => v - row.point[k]!))).toBeLessThanOrEqual(.004);
      if (byId.has(result.supportId)) expect(result).toEqual(byId.get(result.supportId));
      else byId.set(result.supportId, result);
    }
    const sample = rows[0]!, copy = resolve(sample.point);
    (copy.positionM as unknown as number[])[0] = 999;
    expect(resolve(sample.point)).toEqual(sample.anchor);
    expect(Object.isFrozen(resolve.supports)).toBe(true);
    expect(resolve.supports.every(s => Object.isFrozen(s.positionM) && Object.isFrozen(s.surface))).toBe(true);
    expect(source).toEqual(before);
  });

  it("separates the complete largest planar caps and release spheres, including every smaller fill", () => {
    const resolve = createPackedRunoffSupportResolver(largePlane(), packing);
    const a = packing.contactRadiusM, L = packing.neckLengthM, V = packing.criticalVolumeM3;
    // Independent bisection of the analytic volume equation, not the product's
    // hyperbolic inverse, supplies the maximum cap radius.
    let lo = 0, hi = .02;
    for (let i = 0; i < 80; i++) {
      const h = (lo + hi) / 2, volume = Math.PI * a * a * L + Math.PI * h * (3 * a * a + h * h) / 6;
      if (volume > V) hi = h; else lo = h;
    }
    const h = (lo + hi) / 2, R = (h * h + a * a) / (2 * h), r = Math.cbrt(3 * V / (4 * Math.PI));
    expect(resolve.supports.length).toBeGreaterThan(10);
    for (let i = 0; i < resolve.supports.length; i++) for (let j = 0; j < i; j++) {
      const p = resolve.supports[i]!.positionM, q = resolve.supports[j]!.positionM;
      const transverse = Math.hypot(p[0] - q[0], p[2] - q[2]);
      expect(transverse).toBeGreaterThanOrEqual(2 * Math.max(a, R, r));
    }
    for (const fraction of [.001, .01, .1, .5, .9, 1]) {
      let lower = 0, upper = h;
      const capV = Math.max(0, fraction * V - Math.PI * a * a * L);
      for (let i = 0; i < 60; i++) {
        const middle = (lower + upper) / 2;
        if (Math.PI * middle * (3 * a * a + middle * middle) / 6 > capV) upper = middle; else lower = middle;
      }
      const smallH = (lower + upper) / 2, centre = h - R;
      if (capV > 0) for (let i = 0; i <= 30; i++) {
        const z = smallH * i / 30, smallR = (smallH * smallH + a * a) / (2 * smallH);
        const radial2 = Math.max(0, a * a + 2 * (smallH - smallR) * z - z * z);
        expect(radial2 + (z - centre) ** 2).toBeLessThanOrEqual(R * R + 1e-18);
      }
    }
  });

  it("has identical physical support packing under midpoint refinement and rejects arbitrary query offsets", () => {
    const coarse = largePlane(), fine = refineLiverAnatomy(coarse);
    const a = createPackedRunoffSupportResolver(coarse, packing), b = createPackedRunoffSupportResolver(fine, packing);
    expect(b.supportedCellCount).toBe(a.supportedCellCount);
    expect(b.unsupportedCellCount).toBe(a.unsupportedCellCount);
    expect(b.supports.map(s => [s.supportId, s.positionM, s.normal])).toEqual(a.supports.map(s => [s.supportId, s.positionM, s.normal]));
    for (const source of a.supports) {
      const q = sourceCell(source.supportId), x = a(q), y = b(q);
      expect(y.positionM).toEqual(x.positionM); expect(y.normal).toEqual(x.normal); expect(y.supportId).toBe(x.supportId);
      reconstruct(fine, y.surface!.triangle, y.surface!.barycentric)
        .forEach((value, k) => expect(value).toBeCloseTo(y.positionM[k]!, 14));
    }
    expect(() => a([0, 0, 0])).toThrow(/cell centre/);
    expect(() => a([1.002, 1.002, 1.002])).toThrow(/No nonoverlapping/);
    expect(() => createPackedRunoffSupportResolver(coarse, { ...packing, criticalVolumeM3: NaN })).toThrow();
  });

  it("reuses exact unchanged geometry on reset without retaining mutable parameter or geometry aliases", () => {
    const source = largePlane(), mutable = { ...packing, gridOriginM: [...packing.gridOriginM] as LiverVec3 };
    const first = createPackedRunoffSupportResolver(source, mutable), q = sourceCell(first.supports[0]!.supportId), before = first(q);
    expect(createPackedRunoffSupportResolver(source, mutable)).toBe(first);
    (mutable.gridOriginM as unknown as number[])[0] = .001;
    expect(first(q)).toEqual(before);
    expect(createPackedRunoffSupportResolver(source, mutable)).not.toBe(first);
    source.surface.positionsM[1] = .0001;
    expect(createPackedRunoffSupportResolver(source, packing)).not.toBe(first);
    expect(first(q)).toEqual(before);
  });

  it("measures actual HRA coverage and preserves the saved 8-second active source cells within unchanged bounds", () => {
    const base = adaptLiverAnatomy(JSON.parse(gunzipSync(readFileSync(new URL(
      "../../../../../public-copy/static/api/atlas/specimens/hra-liver-female.json.gz", import.meta.url))).toString()) as AtlasGeneration);
    const started = performance.now(), coarse = createPackedRunoffSupportResolver(base, packing), elapsedMS = performance.now() - started;
    const fine = createPackedRunoffSupportResolver(refineLiverAnatomy(base), packing);
    expect(fine.supports.map(s => [s.supportId, s.positionM, s.normal])).toEqual(coarse.supports.map(s => [s.supportId, s.positionM, s.normal]));
    // Regression source cells from actual coarse HRA default-target runoff at
    // 8s, captured 2026-10-20. Inline addresses keep this test independent of
    // optional artifacts. Nearest-face normals are recomputed from the source.
    const saved = "-7,-11,17 -8,-11,16 -9,-12,16 -10,-12,16 -6,-11,17 -7,-12,17 -10,-13,16 -5,-12,17 -11,-13,16 -12,-13,17 -4,-13,17 -5,-13,17 -12,-14,17 -13,-14,16 -3,-14,17 -14,-14,16 -3,-14,18 -2,-15,18 -15,-15,16 -16,-15,16 -1,-15,18 -17,-15,15 0,-15,18 1,-16,18 0,-16,18 -18,-14,14".split(" ");
    const reference = createRunoffSupportResolver(base, packing.contactRadiusM, packing.gravityMS2);
    const failures: string[] = [], mapped: string[] = [];
    let maximumRelocationM = 0;
    for (const id of saved) {
      const point = sourceCell(id), normal = reference(point).normal;
      try {
        const anchor = coarse(point);
        mapped.push(anchor.supportId);
        maximumRelocationM = Math.max(maximumRelocationM, Math.hypot(...point.map((v, k) => v - anchor.positionM[k]!)));
        expect(anchor.normal.reduce((v, n, k) => v + n * normal[k]!, 0)).toBeGreaterThanOrEqual(.8);
      } catch (error) { failures.push(`${id}: ${String(error)}`); }
    }
    console.info("HRA immutable pinning coverage", JSON.stringify({ sourceCells: coarse.candidateCellCount,
      supported: coarse.supportedCellCount, unsupported: coarse.unsupportedCellCount, supports: coarse.supports.length,
      savedActiveCells: saved.length, uniqueActiveSupports: new Set(mapped).size,
      maximumRelocationMM: maximumRelocationM * 1000, buildMilliseconds: elapsedMS, failures }));
    expect(failures).toEqual([]);
  }, 60_000);
});
