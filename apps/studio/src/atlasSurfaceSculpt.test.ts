import { describe, expect, it } from "vitest";
import { beginSurfaceSculpt, type SculptPoint } from "./atlasSurfaceSculpt";

function grid(n = 15, spacing = 0.2) {
  const positions: number[] = [], indices: number[] = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) positions.push((x - (n - 1) / 2) * spacing, (y - (n - 1) / 2) * spacing, 0);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const a = y * n + x;
    indices.push(a, a + 1, a + n + 1, a, a + n + 1, a + n);
  }
  return { positions, indices, faceIndex: ((n - 1) / 2 * (n - 1) + (n - 1) / 2) * 2 };
}

function sphere(subdivisions = 3) {
  const positions = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
  let indices = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
  for (let pass = 0; pass < subdivisions; pass++) {
    const cache = new Map<string, number>();
    const midpoint = (a: number, b: number) => {
      const key = [Math.min(a, b), Math.max(a, b)].join(":");
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const x = positions[a * 3]! + positions[b * 3]!, y = positions[a * 3 + 1]! + positions[b * 3 + 1]!, z = positions[a * 3 + 2]! + positions[b * 3 + 2]!;
      const length = Math.hypot(x, y, z), i = positions.length / 3;
      positions.push(x / length, y / length, z / length); cache.set(key, i);
      return i;
    };
    const next: number[] = [];
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]!, b = indices[i + 1]!, c = indices[i + 2]!;
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
    }
    indices = next;
  }
  return { positions, indices, faceIndex: 0 };
}

function facePoint(mesh: { positions: number[]; indices: number[]; faceIndex: number }): [number, number, number] {
  const corners = mesh.indices.slice(mesh.faceIndex * 3, mesh.faceIndex * 3 + 3);
  return [0, 1, 2].map((k) => corners.reduce((sum, i) => sum + mesh.positions[i * 3 + k]!, 0) / 3) as [number, number, number];
}

describe("geodesic elastic surface sculpting", () => {
  it("preserves rest geometry exactly and produces deterministic stroke-start updates", () => {
    const mesh = grid(), before = Float32Array.from(mesh.positions);
    const stroke = beginSurfaceSculpt({ ...mesh, point: facePoint(mesh), radius: 0.8 });
    expect(stroke.update([0, 0, 0]).positions).toEqual(before);
    const first = stroke.update([0.1, 0.1, 0.3]);
    stroke.update([-0.2, 0.2, -0.15]);
    expect(stroke.update([0.1, 0.1, 0.3]).positions).toEqual(first.positions);
    expect(stroke.update([0, 0, 0]).positions).toEqual(before);
    expect(Float32Array.from(mesh.positions)).toEqual(before);
    expect(first.diagnostics.maxDisplacement).toBeGreaterThan(0.01);
    expect(first.diagnostics.affectedVertices).toBeLessThan(mesh.positions.length / 3 / 2);
  });

  it("does not deform a close disconnected sheet or vertices beyond geodesic support", () => {
    const mesh = grid(), count = mesh.positions.length / 3;
    const positions = [...mesh.positions, ...mesh.positions.map((value, i) => i % 3 === 2 ? value + 0.01 : value)];
    const indices = [...mesh.indices, ...mesh.indices.map((i) => i + count)];
    const result = beginSurfaceSculpt({ ...mesh, positions, indices, point: facePoint(mesh), radius: 0.8 }).update([0, 0, 0.3]);
    expect(result.positions.slice(count * 3)).toEqual(Float32Array.from(positions.slice(count * 3)));
    expect(result.positions.slice(0, 3)).toEqual(Float32Array.from(positions.slice(0, 3)));
    expect(result.diagnostics.closedComponent).toBe(false);
    expect(result.diagnostics.volumeChangeFraction).toBeNull();
  });

  it("does not reach across a fold that is connected by a distant surface path", () => {
    const positions: number[] = [], indices: number[] = [];
    for (let i = 0; i <= 20; i++) {
      const x = i <= 10 ? i * 0.1 : (20 - i) * 0.1;
      const z = i <= 10 ? 0 : 0.02;
      positions.push(x, -0.1, z, x, 0.1, z);
      if (i < 20) indices.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
    }
    const mesh = { positions, indices, faceIndex: 0 };
    const result = beginSurfaceSculpt({ ...mesh, point: facePoint(mesh), radius: 0.45, stiffness: 0 }).update([0, 0, -0.1]);
    expect(result.diagnostics.maxDisplacement).toBeGreaterThan(0.02);
    expect(result.positions.slice(positions.length - 12)).toEqual(Float32Array.from(positions.slice(-12)));
  });

  it("is translation, rotation, and uniform-scale equivariant", () => {
    const mesh = sphere(2), point = facePoint(mesh), delta: SculptPoint = [0.04, 0.12, 0.03];
    const base = beginSurfaceSculpt({ ...mesh, point, radius: 0.85 }).update(delta);
    const transform = (x: number, y: number, z: number): [number, number, number] => [3 - y * 7, -2 + x * 7, 6 + z * 7];
    const positions: number[] = [];
    for (let i = 0; i < mesh.positions.length; i += 3) positions.push(...transform(mesh.positions[i]!, mesh.positions[i + 1]!, mesh.positions[i + 2]!));
    const moved = beginSurfaceSculpt({ ...mesh, positions, point: transform(...point), radius: 0.85 * 7 }).update([-delta[1] * 7, delta[0] * 7, delta[2] * 7]);
    for (let i = 0; i < base.positions.length; i += 3) {
      const expected = transform(base.positions[i]!, base.positions[i + 1]!, base.positions[i + 2]!);
      for (let k = 0; k < 3; k++) expect(moved.positions[i + k]!).toBeCloseTo(expected[k]!, 5);
    }
  });

  it("reduces volume error on a consistently oriented closed surface", () => {
    const mesh = sphere(), point = facePoint(mesh), delta: SculptPoint = [0.16, 0.02, 0.03];
    const uncorrected = beginSurfaceSculpt({ ...mesh, point, radius: 1.1, preserveVolume: 0 }).update(delta);
    const corrected = beginSurfaceSculpt({ ...mesh, point, radius: 1.1, preserveVolume: 0.95 }).update(delta);
    expect(corrected.diagnostics.closedComponent).toBe(true);
    expect(Math.abs(uncorrected.diagnostics.volumeChangeFraction!)).toBeGreaterThan(0.0001);
    expect(Math.abs(corrected.diagnostics.volumeChangeFraction!)).toBeLessThan(Math.abs(uncorrected.diagnostics.volumeChangeFraction!) * 0.12);
    expect(corrected.diagnostics.maxDisplacement).toBeGreaterThan(0.02);
  });

  it("disables volume projection on inconsistent winding and open surfaces", () => {
    const mesh = sphere(1), point = facePoint(mesh);
    const indices = [...mesh.indices];
    [indices[0], indices[1]] = [indices[1]!, indices[0]!];
    const result = beginSurfaceSculpt({ ...mesh, indices, point, radius: 1 }).update([0.1, 0.1, 0]);
    expect(result.diagnostics.closedComponent).toBe(false);
    expect(result.diagnostics.volumeChangeFraction).toBeNull();
    expect(result.positions.every(Number.isFinite)).toBe(true);
  });

  it("bounds extreme drags, preserves face orientation, and avoids crushed or stretched edges", () => {
    const mesh = sphere(2), point = facePoint(mesh);
    for (const delta of [[-1000, 80, -30], [100, -100, 500]] as SculptPoint[]) {
      const result = beginSurfaceSculpt({ ...mesh, point, radius: 0.8, stiffness: 0 }).update(delta);
      expect(result.diagnostics.guarded).toBe(true);
      expect(result.diagnostics.appliedFraction).toBeLessThan(1);
      expect(result.positions.every(Number.isFinite)).toBe(true);
      for (let f = 0; f < mesh.indices.length; f += 3) {
        const corners = mesh.indices.slice(f, f + 3).map((v) => v * 3);
        const normal = (p: ArrayLike<number>) => {
          const [a, b, c] = corners as [number, number, number];
          const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
          const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
          return [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
        };
        const n0 = normal(mesh.positions), n1 = normal(result.positions);
        expect(n0.reduce((sum, x, k) => sum + x * n1[k]!, 0)).toBeGreaterThan(0);
        for (let k = 0; k < 3; k++) {
          const a = corners[k]!, b = corners[(k + 1) % 3]!;
          const length = (p: ArrayLike<number>) => Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!);
          const ratio = length(result.positions) / length(mesh.positions);
          expect(ratio).toBeGreaterThanOrEqual(0.3999);
          expect(ratio).toBeLessThanOrEqual(2.0001);
        }
      }
    }
  });

  it("supports smooth broad contact and increases resistance with stiffness", () => {
    const mesh = grid(), point = facePoint(mesh), delta: SculptPoint = [0, 0, 0.2];
    const soft = beginSurfaceSculpt({ ...mesh, point, radius: 1, stiffness: 0 }).update(delta);
    const stiff = beginSurfaceSculpt({ ...mesh, point, radius: 1, stiffness: 1 }).update(delta);
    expect(soft.diagnostics.maxDisplacement).toBeGreaterThan(stiff.diagnostics.maxDisplacement * 1.8);
    const moved = Array.from(soft.positions).filter((value, i) => i % 3 === 2 && value > soft.diagnostics.maxDisplacement * 0.1);
    expect(moved.length).toBeGreaterThan(10);
    const tiny = beginSurfaceSculpt({ ...mesh, point, radius: 0.001 }).update(delta);
    expect(tiny.diagnostics.effectiveRadius).toBeGreaterThan(0.2);
    expect(tiny.diagnostics.affectedVertices).toBeGreaterThanOrEqual(3);
  });

  it("guards accumulated strokes against the immutable export specimen", () => {
    const mesh = sphere(2), baseline = [...mesh.positions];
    let positions: Float32Array = Float32Array.from(baseline);
    for (let stroke = 0; stroke < 16; stroke++) {
      const current = { ...mesh, positions: Array.from(positions) };
      const result = beginSurfaceSculpt({ ...current, guardPositions: baseline, point: facePoint(current), radius: 1, stiffness: 0 }).update([-0.6, 0.25, -0.1]);
      positions = result.positions;
      for (let f = 0; f < mesh.indices.length; f += 3) {
        const [a, b, c] = mesh.indices.slice(f, f + 3).map(i => i * 3) as [number, number, number];
        const normal = (p: ArrayLike<number>) => {
          const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
          const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
          return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        };
        const before = normal(baseline), after = normal(positions);
        expect(before.reduce((sum, x, k) => sum + x * after[k]!, 0)).toBeGreaterThan(0);
      }
    }
  });

  it("rejects invalid geometry, hit indices and nonfinite displacements", () => {
    const mesh = grid(), point = facePoint(mesh);
    expect(() => beginSurfaceSculpt({ ...mesh, point, radius: -1 })).toThrow(/radius/);
    expect(() => beginSurfaceSculpt({ ...mesh, point, radius: 1, indices: [0, 1, 100000] })).toThrow(/index/);
    expect(() => beginSurfaceSculpt({ ...mesh, point, radius: 1, faceIndex: -1 })).toThrow(/triangle/);
    expect(() => beginSurfaceSculpt({ ...mesh, point, radius: 1, guardPositions: [0, 1, 2] })).toThrow(/guard/);
    const stroke = beginSurfaceSculpt({ ...mesh, point, radius: 1 });
    expect(() => stroke.update([NaN, 1, 2])).toThrow(/finite/);
  });
});
