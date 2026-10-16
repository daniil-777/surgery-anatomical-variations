/** Surface-only editing; these numerical guards do not certify anatomy or volumetric mechanics. */
export type Vec3 = [number, number, number];
export interface MeshGeometry {
  positions: number[];
  indices: number[];
}
export interface MeshMetrics {
  volumeMl: number;
  areaCm2: number;
  center: Vec3;
  dimensions: Vec3;
  vertices: number;
  triangles: number;
}
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const minus = (a: Vec3, b: Vec3): Vec3 => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const at = (p: number[], i: number): Vec3 => [
  p[i * 3]!,
  p[i * 3 + 1]!,
  p[i * 3 + 2]!,
];
export function meshMetrics({
  positions: p,
  indices: t,
}: MeshGeometry): MeshMetrics {
  const lo: Vec3 = [Infinity, Infinity, Infinity],
    hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  let volume = 0,
    area = 0;
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a]!, p[i + a]!);
      hi[a] = Math.max(hi[a]!, p[i + a]!);
    }
  for (let i = 0; i < t.length; i += 3) {
    const a = at(p, t[i]!),
      b = at(p, t[i + 1]!),
      c = at(p, t[i + 2]!);
    const n = cross(minus(b, a), minus(c, a));
    area += Math.hypot(...n) / 2;
    const bc = cross(b, c);
    volume += (a[0] * bc[0] + a[1] * bc[1] + a[2] * bc[2]) / 6;
  }
  return {
    volumeMl: Math.abs(volume) / 1000,
    areaCm2: area / 100,
    center: lo.map((v, a) => (v + hi[a]!) / 2) as Vec3,
    dimensions: lo.map((v, a) => hi[a]! - v) as Vec3,
    vertices: p.length / 3,
    triangles: t.length / 3,
  };
}
export function validateSurfaceEdit(
  before: MeshGeometry,
  positions: number[],
): { valid: boolean; reason: string } {
  if (
    positions.length !== before.positions.length ||
    !positions.every(Number.isFinite)
  )
    return { valid: false, reason: "Invalid vertex coordinates" };
  const p = before.positions,
    t = before.indices;
  for (let i = 0; i < t.length; i += 3) {
    const ids = [t[i]!, t[i + 1]!, t[i + 2]!];
    const a = at(p, ids[0]!),
      b = at(p, ids[1]!),
      c = at(p, ids[2]!);
    const na = at(positions, ids[0]!),
      nb = at(positions, ids[1]!),
      nc = at(positions, ids[2]!);
    const n = cross(minus(b, a), minus(c, a)),
      nn = cross(minus(nb, na), minus(nc, na));
    const n2 = n[0] ** 2 + n[1] ** 2 + n[2] ** 2;
    if (n2 < 1e-18) continue;
    if (Math.hypot(...nn) < Math.sqrt(n2) * 0.04)
      return { valid: false, reason: "Edit would collapse a surface triangle" };
    if (nn[0] * n[0] + nn[1] * n[1] + nn[2] * n[2] < 0)
      return { valid: false, reason: "Edit would fold the surface locally" };
  }
  return {
    valid: true,
    reason:
      "Finite coordinates and local triangle checks passed; self-contact and tetrahedra not evaluated",
  };
}
export function scaleMesh(
  mesh: MeshGeometry,
  axis: 0 | 1 | 2 | "all",
  ratio: number,
): number[] {
  const c = meshMetrics(mesh).center;
  return mesh.positions.map((v, i) =>
    axis === "all" || i % 3 === axis ? c[i % 3]! + (v - c[i % 3]!) * ratio : v,
  );
}
export function brushMesh(
  mesh: MeshGeometry,
  opts: {
    tool: "grab" | "inflate" | "twist" | "smooth" | "probe";
    point: Vec3;
    delta: Vec3;
    normal: Vec3;
    radius: number;
    strength: number;
  },
): number[] {
  const p = mesh.positions,
    result = p.slice();
  const neighbours = opts.tool === "smooth" ? adjacency(mesh) : null;
  for (let i = 0; i < p.length; i += 3) {
    const r: Vec3 = [
      p[i]! - opts.point[0],
      p[i + 1]! - opts.point[1],
      p[i + 2]! - opts.point[2],
    ];
    const d = Math.hypot(...r) / opts.radius;
    if (d >= 1) continue;
    const w = (1 - d * d) ** 2 * opts.strength;
    if (opts.tool === "smooth" && neighbours) {
      const ns = neighbours[i / 3]!;
      if (!ns.length) continue;
      for (let a = 0; a < 3; a++) {
        let m = 0;
        for (const k of ns) m += p[k * 3 + a]!;
        result[i + a] = p[i + a]! + (m / ns.length - p[i + a]!) * w * 0.36;
      }
    } else if (opts.tool === "twist") {
      const theta =
        Math.hypot(...opts.delta) *
        0.025 *
        w *
        (opts.delta[0] + opts.delta[1] >= 0 ? 1 : -1);
      const n = opts.normal,
        cr = cross(n, r),
        dot = n[0] * r[0] + n[1] * r[1] + n[2] * r[2];
      for (let a = 0; a < 3; a++)
        result[i + a] =
          opts.point[a]! +
          r[a]! * Math.cos(theta) +
          cr[a]! * Math.sin(theta) +
          n[a]! * dot * (1 - Math.cos(theta));
    } else {
      const motion =
        opts.tool === "inflate"
          ? (opts.normal.map((n) => n * 0.9) as Vec3)
          : opts.delta;
      for (let a = 0; a < 3; a++) result[i + a] = p[i + a]! + motion[a]! * w;
    }
  }
  return result;
}
const adjacencyCache = new WeakMap<number[], number[][]>();
function adjacency(mesh: MeshGeometry): number[][] {
  const old = adjacencyCache.get(mesh.indices);
  if (old) return old;
  const n = Array.from(
    { length: mesh.positions.length / 3 },
    () => new Set<number>(),
  );
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]!,
      b = mesh.indices[i + 1]!,
      c = mesh.indices[i + 2]!;
    n[a]!.add(b).add(c);
    n[b]!.add(a).add(c);
    n[c]!.add(a).add(b);
  }
  const result = n.map((s) => [...s]);
  adjacencyCache.set(mesh.indices, result);
  return result;
}
export function bendMesh(mesh: MeshGeometry, amount: number): number[] {
  const m = meshMetrics(mesh),
    w = Math.max(m.dimensions[0], 1);
  return mesh.positions.map((v, i) =>
    i % 3 === 2
      ? v + amount * (((mesh.positions[i - 2]! - m.center[0]) / w) ** 2 - 0.08)
      : v,
  );
}
