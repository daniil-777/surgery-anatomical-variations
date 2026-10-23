import { describe, expect, it } from "vitest";
import { FAT_GENERATOR_VERSION, generateFatGeometry, type FatGeometryData, type FatPreset } from "./generator";
import { countNonAdjacentTriangleIntersections } from "./geometryAudit.testSupport";

function auditTopology(mesh: FatGeometryData): void {
  const edges = new Map<string, { count: number; direction: number }>();
  let minimumArea = Infinity;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]!, b = mesh.indices[i + 1]!, c = mesh.indices[i + 2]!;
    for (const [from, to] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(from!, to!)}/${Math.max(from!, to!)}`;
      const old = edges.get(key) ?? { count: 0, direction: 0 };
      old.count++; old.direction += from! < to! ? 1 : -1; edges.set(key, old);
    }
    const p = mesh.positions;
    const ux = p[b * 3]! - p[a * 3]!, uy = p[b * 3 + 1]! - p[a * 3 + 1]!, uz = p[b * 3 + 2]! - p[a * 3 + 2]!;
    const vx = p[c * 3]! - p[a * 3]!, vy = p[c * 3 + 1]! - p[a * 3 + 1]!, vz = p[c * 3 + 2]! - p[a * 3 + 2]!;
    minimumArea = Math.min(minimumArea, Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx));
  }
  expect(minimumArea).toBeGreaterThan(1e-8);
  for (const edge of edges.values()) {
    if (edge.count !== 2 || edge.direction !== 0) throw new Error(`Non-manifold or inconsistent edge: ${JSON.stringify(edge)}`);
  }
  expect(mesh.stats.vertexCount - edges.size + mesh.stats.triangleCount).toBe(2);
}

function auditBoundsAndNormals(mesh: FatGeometryData): void {
  const bounds = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  let maximumNormalError = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[i + axis]!;
      if (!Number.isFinite(value)) throw new Error("Non-finite position");
      bounds[axis]![0] = Math.min(bounds[axis]![0]!, value); bounds[axis]![1] = Math.max(bounds[axis]![1]!, value);
    }
    const length = Math.hypot(mesh.normals[i]!, mesh.normals[i + 1]!, mesh.normals[i + 2]!);
    if (!Number.isFinite(length)) throw new Error("Non-finite normal");
    maximumNormalError = Math.max(maximumNormalError, Math.abs(length - 1));
  }
  expect(maximumNormalError).toBeLessThan(1e-6);
  for (let axis = 0; axis < 3; axis++) {
    expect(bounds[axis]![1]! - bounds[axis]![0]!).toBeCloseTo(mesh.stats.dimensionsMm[axis]!, 4);
    expect(bounds[axis]![1]! + bounds[axis]![0]!).toBeCloseTo(0, 4);
  }
}

/** Check the constructive no-crossing invariant on the actual Float32 mesh,
 * not just the field function: projected triangles must match exactly, each
 * disk face has the same orientation, and upper/lower gaps stay positive. */
function auditSheet(mesh: FatGeometryData): void {
  const p = mesh.positions, indices = mesh.indices;
  for (let i = 0; i < indices.length; i += 6) {
    const top = [indices[i]!, indices[i + 1]!, indices[i + 2]!];
    const bottom = [indices[i + 3]!, indices[i + 5]!, indices[i + 4]!];
    let maximumGap = 0;
    for (let corner = 0; corner < 3; corner++) {
      const a = top[corner]!, b = bottom[corner]!;
      if (p[a * 3] !== p[b * 3] || p[a * 3 + 2] !== p[b * 3 + 2]) throw new Error("Unmatched projected sheet faces");
      const gap = p[a * 3 + 1]! - p[b * 3 + 1]!;
      if (a !== b && gap <= 0) throw new Error("Crossed/collapsed interior sheet surfaces");
      maximumGap = Math.max(maximumGap, gap);
      if (Math.abs(gap - mesh.columnThicknessMm[a]!) > Math.max(1e-5, gap * 1e-6)) throw new Error("Column thickness disagrees with surface separation");
    }
    if (maximumGap <= 0) throw new Error("Zero-thickness sheet triangle");
    const [a, b, c] = top as [number, number, number];
    const orientation = (p[b * 3]! - p[a * 3]!) * (p[c * 3 + 2]! - p[a * 3 + 2]!) - (p[b * 3 + 2]! - p[a * 3 + 2]!) * (p[c * 3]! - p[a * 3]!);
    if (!(orientation < 0)) throw new Error("Inverted projected disk triangle");
  }
}

/** Visual smoothness regression metric, not a measured tissue curvature limit. */
function normalCurvature99(mesh: FatGeometryData): number {
  const values: number[] = [], edges = new Set<number>(), p = mesh.positions, n = mesh.normals;
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) for (let corner = 0; corner < 3; corner++) {
    const a = mesh.indices[triangle + corner]!, b = mesh.indices[triangle + (corner + 1) % 3]!;
    const key = Math.min(a, b) * mesh.stats.vertexCount + Math.max(a, b);
    if (edges.has(key)) continue;
    edges.add(key);
    const length = Math.hypot(p[a * 3]! - p[b * 3]!, p[a * 3 + 1]! - p[b * 3 + 1]!, p[a * 3 + 2]! - p[b * 3 + 2]!);
    // Very short polar edges amplify Float32 normal quantization.
    if (length < .025) continue;
    const dot = n[a * 3]! * n[b * 3]! + n[a * 3 + 1]! * n[b * 3 + 1]! + n[a * 3 + 2]! * n[b * 3 + 2]!;
    values.push(Math.acos(Math.max(-1, Math.min(1, dot))) / length);
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * .99)]!;
}

describe("procedural white adipose geometry", () => {
  it("reproduces positions, topology, UVs, normals and measurements for a seed", () => {
    const config = { preset: "visceral" as const, shapeSeed: 93817, detail: 24 };
    expect(generateFatGeometry(config)).toEqual(generateFatGeometry(config));
    expect(generateFatGeometry(config).stats.generatorVersion).toBe(FAT_GENERATOR_VERSION);
    expect(generateFatGeometry({ ...config, shapeSeed: 93818 }).positions).not.toEqual(generateFatGeometry(config).positions);
  });

  it("is closed, consistently oriented, non-degenerate and dimensioned across 1,200 seeds and all presets", () => {
    const presets: FatPreset[] = ["subcutaneous", "visceral", "omental"];
    const fingerprints = new Set<string>();
    for (let seed = 0; seed < 1200; seed++) {
      const preset = presets[seed % 3]!;
      const mesh = generateFatGeometry({ preset, shapeSeed: seed * 7919 - 99, detail: [12, 19, 24, 32][Math.floor(seed / 3) % 4]!, lobulation: (seed % 11) * .15 });
      auditTopology(mesh); auditBoundsAndNormals(mesh);
      const boxVolume = mesh.stats.dimensionsMm.reduce((a, b) => a * b, 1);
      expect(mesh.stats.volumeMm3 / boxVolume).toBeGreaterThan(preset === "omental" ? .025 : .25);
      expect(mesh.stats.volumeMm3 / boxVolume).toBeLessThan(.75);
      expect(mesh.stats.massGrams).toBeCloseTo(mesh.stats.volumeMm3 * .00092, 9);
      fingerprints.add(mesh.positions.slice(0, 48).join(","));
    }
    expect(fingerprints.size).toBe(1200);
  }, 60_000);

  it("preserves measured dimensions and mass units for user dimensions and density", () => {
    const mesh = generateFatGeometry({ preset: "subcutaneous", shapeSeed: 42, dimensionsMm: [62, 15, 39], detail: 32, densityKgM3: 900 });
    auditBoundsAndNormals(mesh);
    expect(mesh.stats.dimensionsMm).toEqual([62, 15, 39]);
    expect(mesh.stats.massGrams).toBeCloseTo(mesh.stats.volumeMm3 / 1000 * .9, 10);
  });

  it("keeps thin patch surfaces ordered without terraced or folded-over rims", () => {
    const detail = 32, longitudeCount = detail * 2;
    for (const preset of ["subcutaneous"] as const) for (let seed = 0; seed < 30; seed++) {
      const mesh = generateFatGeometry({ preset, shapeSeed: seed * 7919, detail, lobulation: 1.5 });
      for (let latitude = 1; latitude < detail / 2; latitude++) for (let longitude = 0; longitude < longitudeCount; longitude++) {
        const top = (1 + (latitude - 1) * longitudeCount + longitude) * 3;
        const bottom = (1 + (detail - latitude - 1) * longitudeCount + longitude) * 3;
        expect(mesh.positions[top]).toBeCloseTo(mesh.positions[bottom]!, 4);
        expect(mesh.positions[top + 2]).toBeCloseTo(mesh.positions[bottom + 2]!, 4);
        if (mesh.positions[top + 1]! <= mesh.positions[bottom + 1]!) throw new Error("Crossed upper/lower patch surfaces");
      }
    }
  });

  it("converges in enclosed volume when mesh resolution increases", () => {
    const config = { preset: "visceral" as const, shapeSeed: 31 };
    const medium = generateFatGeometry({ ...config, detail: 72 });
    const high = generateFatGeometry({ ...config, detail: 144 });
    expect(Math.abs(medium.stats.volumeMm3 / high.stats.volumeMm3 - 1)).toBeLessThan(.02);
    auditTopology(high);
  });

  it("rounds extreme lobules without the sharp nearest-cell tips and septal corners", () => {
    // The prior distance/F2 field measured 1.79–1.93 rad/mm at these settings.
    // This ceiling detects that defect returning, with headroom for variation.
    for (const shapeSeed of [0, 42, 731, 2 ** 32 - 1]) {
      const mesh = generateFatGeometry({ preset: "visceral", shapeSeed, detail: 128, lobulation: 1.5 });
      expect(normalCurvature99(mesh)).toBeLessThan(1.2);
    }
  });

  it("retains finite closed geometry at supported dimension and detail extremes", () => {
    for (const preset of ["visceral", "subcutaneous", "omental"] as const) {
      for (const dimensionsMm of [[1, 1, 1], [1000, 1, 1000], [1, 1000, 1]] as const) {
        const mesh = generateFatGeometry({ preset, shapeSeed: 2 ** 32 - 1, detail: 12, lobulation: 1.5, dimensionsMm });
        auditTopology(mesh); auditBoundsAndNormals(mesh);
        expect(mesh.stats.volumeMm3).toBeGreaterThan(0);
        expect(mesh.stats.volumeMm3).toBeLessThan(mesh.stats.dimensionsMm.reduce<number>((a, b) => a * b, 1));
      }
      const fineMesh = generateFatGeometry({ preset, shapeSeed: 0, detail: 192, lobulation: 0 });
      auditTopology(fineMesh); auditBoundsAndNormals(fineMesh);
    }
  });

  it("separates authored sheet thickness from drape, with exactly paired projected triangles", () => {
    for (const detail of [12, 13, 32, 73, 128]) for (const shapeSeed of [0, 42, 7919, -1]) {
      const flat = generateFatGeometry({ preset: "omental", shapeSeed, detail, thicknessMm: 4, drapeMm: 0 });
      const folded = generateFatGeometry({ preset: "omental", shapeSeed, detail, thicknessMm: 4, drapeMm: 48 });
      auditSheet(folded); auditBoundsAndNormals(folded);
      let minMiddle = Infinity, maxMiddle = -Infinity;
      const diskCount = (folded.stats.vertexCount + detail * 2) / 2;
      for (let i = 0; i < diskCount; i++) {
        expect(folded.positions[i * 3]).toBe(flat.positions[i * 3]);
        expect(folded.positions[i * 3 + 2]).toBe(flat.positions[i * 3 + 2]);
        expect(folded.thicknessMm[i]).toBeCloseTo(flat.thicknessMm[i]!, 4);
        const middle = folded.positions[i * 3 + 1]! - folded.columnThicknessMm[i]! * .5;
        minMiddle = Math.min(minMiddle, middle); maxMiddle = Math.max(maxMiddle, middle);
      }
      expect(maxMiddle - minMiddle).toBeCloseTo(48, 4);
      expect(folded.stats.dimensionsMm[1]).toBeGreaterThan(48);
      expect(flat.stats.dimensionsMm[1]).toBeLessThan(10);
      expect(folded.stats.resolvedThicknessMm).toBe(4);
      expect(folded.stats.resolvedDrapeMm).toBe(48);
      expect(folded.stats.thicknessDefinition).toBe("normal-projected-column");
    }
  }, 15_000);

  it("keeps positive paired graphs and topology across 216 sheet thickness/drape/detail/aspect extremes", () => {
    let cases = 0;
    for (const dimensionsMm of [[150, 12, 114], [1, 1, 1], [1000, 1, 1000], [1, 1000, 1]] as const)
      for (const thicknessMm of [.1, 4, 1000]) for (const drapeMm of [0, 32, 1000])
        for (const detail of [12, 13, 24, 48, 73, 128]) {
          const mesh = generateFatGeometry({ preset: "omental", shapeSeed: cases++ * 7919, dimensionsMm, thicknessMm, drapeMm, detail, lobulation: 1.5 });
          auditSheet(mesh); auditTopology(mesh); auditBoundsAndNormals(mesh);
          expect(mesh.stats.volumeMm3).toBeGreaterThan(0);
        }
    expect(cases).toBe(216);
  }, 60_000);

  it("finds actual crossing and coplanar triangles in the independent intersection auditor", () => {
    const indices = new Uint32Array([0, 1, 2, 3, 4, 5]);
    const first = [0, 0, 0, 2, 0, 0, 0, 2, 0];
    expect(countNonAdjacentTriangleIntersections({ indices, positions: new Float32Array([...first, .25, .25, -1, .25, .25, 1, 1, .25, 0]) })).toBe(1);
    expect(countNonAdjacentTriangleIntersections({ indices, positions: new Float32Array([...first, .25, .25, 0, 1, .25, 0, .25, 1, 0]) })).toBe(1);
    // Overlapping AABBs, disjoint coplanar triangles.
    expect(countNonAdjacentTriangleIntersections({ indices, positions: new Float32Array([...first, 1.5, 1.5, 0, 2, 1.5, 0, 1.5, 2, 0]) })).toBe(0);
  });

  it("has no nonadjacent triangle intersections across 192 independent seed/depot/parameter cases", () => {
    const presets = ["visceral", "subcutaneous", "omental"] as const;
    for (let i = 0; i < 192; i++) {
      const preset = presets[i % 3]!;
      const mesh = generateFatGeometry({ preset, shapeSeed: i * 65537 - 99, detail: i < 180 ? 12 + i % 2 : 36, lobulation: i % 2 ? 1.5 : 0,
        ...(preset === "omental" ? { thicknessMm: [.1, 4, 25][Math.floor(i / 3) % 3]!, drapeMm: [0, 32, 150, 1000][Math.floor(i / 9) % 4]! } : {}),
      });
      expect(countNonAdjacentTriangleIntersections(mesh), `case ${i}, ${preset}`).toBe(0);
    }
  }, 60_000);

  it("agrees with an independent integral of column gaps for folded-sheet volume", () => {
    for (const drapeMm of [0, 32, 200]) {
      const mesh = generateFatGeometry({ preset: "omental", shapeSeed: 731, detail: 64, thicknessMm: 3, drapeMm });
      const p = mesh.positions;
      let integratedVolume = 0;
      for (let i = 0; i < mesh.indices.length; i += 6) {
        const a = mesh.indices[i]!, b = mesh.indices[i + 1]!, c = mesh.indices[i + 2]!;
        const projectedArea = Math.abs((p[b * 3]! - p[a * 3]!) * (p[c * 3 + 2]! - p[a * 3 + 2]!) - (p[b * 3 + 2]! - p[a * 3 + 2]!) * (p[c * 3]! - p[a * 3]!)) * .5;
        const meanGap = (mesh.columnThicknessMm[a]! + mesh.columnThicknessMm[b]! + mesh.columnThicknessMm[c]!) / 3;
        integratedVolume += projectedArea * meanGap;
      }
      expect(Math.abs(integratedVolume / mesh.stats.volumeMm3 - 1)).toBeLessThan(1e-7);
    }
  });

  it("returns finite local thickness with an explicit geometric meaning for every vertex", () => {
    for (const preset of ["visceral", "subcutaneous", "omental"] as const) {
      const mesh = generateFatGeometry({ preset, shapeSeed: 43, detail: 64 });
      expect(mesh.thicknessMm.length).toBe(mesh.stats.vertexCount);
      expect(mesh.columnThicknessMm.length).toBe(mesh.stats.vertexCount);
      for (let i = 0; i < mesh.thicknessMm.length; i++) {
        expect(Number.isFinite(mesh.thicknessMm[i])).toBe(true);
        expect(mesh.thicknessMm[i]).toBeGreaterThanOrEqual(0);
        expect(mesh.columnThicknessMm[i]! + 1e-5).toBeGreaterThanOrEqual(mesh.thicknessMm[i]!);
      }
      expect(mesh.stats.thicknessDefinition).toBe(preset === "visceral" ? "opposite-ray-chord" : preset === "omental" ? "normal-projected-column" : "vertical-column");
    }
  });

  it("rejects invalid inputs before allocating mesh buffers", () => {
    const valid = { preset: "subcutaneous" as const, shapeSeed: 1 };
    for (const patch of [{ shapeSeed: NaN }, { shapeSeed: 1.1 }, { detail: 10000 }, { detail: 12.1 }, { lobulation: -1 }, { lobulation: Infinity }, { densityKgM3: 0 }, { thicknessMm: 0 }, { thicknessMm: NaN }, { drapeMm: -1 }, { drapeMm: Infinity }, { dimensionsMm: [1, NaN, 2] as const }]) {
      expect(() => generateFatGeometry({ ...valid, ...patch })).toThrow(RangeError);
    }
  });
});
