import { describe, expect, it } from "vitest";
import { validateContactCapDomain } from "./contactCapDomain";
import type { CuttingEmbeddedSurface } from "./types";

type Point = [number, number];
type Triangle = [Point, Point, Point];
function surface(triangles: Triangle[], tet = 0): CuttingEmbeddedSurface {
  return {
    positionsMm: triangles.flatMap(triangle => triangle.flatMap(([y, z]) => [0, y, z])),
    indices: Array.from({ length: triangles.length * 3 }, (_, i) => i),
    tetIndices: Array(triangles.length * 3).fill(tet),
    weights: Array.from({ length: triangles.length * 3 }, () => [1, 0, 0, 0]).flat(),
  };
}
function tile(y: number, z: number, diagonal = false): Triangle[] {
  return diagonal
    ? [[[y, z], [y + 1, z], [y, z + 1]], [[y + 1, z], [y + 1, z + 1], [y, z + 1]]]
    : [[[y, z], [y + 1, z], [y + 1, z + 1]], [[y, z], [y + 1, z + 1], [y, z + 1]]];
}
const ring = (diagonal = false): Triangle[] => Array.from({ length: 9 }, (_, i) => i).filter(i => i !== 4).flatMap(i => tile(i % 3, Math.floor(i / 3), diagonal));

describe("contact-only cap domain equivalence", () => {
  it("accepts different tessellations of a nonconvex domain with a hole and a disconnected component", () => {
    const original = [...ring(), ...tile(7, 2)], replacement = [...ring(true), ...tile(7, 2, true)];
    expect(() => validateContactCapDomain(surface(original), surface(replacement))).not.toThrow();
    // A second triangulation introduces vertices inside faces; no topology
    // welding or shared vertex indices are required by the domain contract.
    const split: Triangle[] = replacement.flatMap(([a, b, c]) => {
      const mid: Point = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
      return [[a, b, mid], [b, c, mid], [c, a, mid]] as Triangle[];
    });
    expect(() => validateContactCapDomain(surface(original), surface(split))).not.toThrow();
  });
  it("rejects a filled hole compensated by a missing tile and an equal-area displacement", () => {
    const replacement = ring(true).slice(2).concat(tile(1, 1));
    expect(() => validateContactCapDomain(surface(ring()), surface(replacement))).toThrow(/missing or extra/);
    expect(() => validateContactCapDomain(surface(tile(0, 0)), surface(tile(.01, 0)))).toThrow(/missing or extra/);
  });
  it("rejects duplicated pieces even when both inputs carry the same overlap", () => {
    const original = surface(tile(0, 0)), duplicate = surface([tile(0, 0)[0]!, tile(0, 0)[0]!]);
    expect(() => validateContactCapDomain(original, duplicate)).toThrow(/overlapping/);
    expect(() => validateContactCapDomain(duplicate, duplicate)).toThrow(/overlapping/);
  });
  it("preserves support-cell ownership even for coincident domains", () => {
    expect(() => validateContactCapDomain(surface(tile(0, 0), 0), surface(tile(0, 0), 1))).toThrow(/support tetrahedr/);
  });
  it("uses local coordinates for large offsets, tiny faces and either winding", () => {
    for (const scale of [1, 1e-5]) {
      const translated = (faces: Triangle[]): Triangle[] => faces.map(triangle => triangle.map(([y, z]) => [9990 + y * scale, -9990 + z * scale]) as Triangle);
      const old = translated(tile(0, 0)), changed = translated(tile(0, 0, true)).map(([a, b, c]) => [a, c, b] as Triangle);
      expect(() => validateContactCapDomain(surface(old), surface(changed))).not.toThrow();
    }
  });
});
