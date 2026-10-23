import type { CuttingReference } from "./types";

export const RIM_BRIDGE_PROVENANCE = Object.freeze({
  role: "visualization of intact cohesive surface only",
  rule: "remove a segment when any supported cohesive pair starts damage",
  mechanicalContribution: false,
  capsuleConstitutiveModel: false,
});

export interface CuttingRimBridge {
  /** Six existing skin vertices per segment, with outward triangle winding. */
  skinVertices: Uint32Array;
  damagePairs: readonly number[][];
  restPositionsMm: Float32Array;
  pairCount: number;
}

/** Close only the elastic, undamaged cohesive zone. Uses the actual split skin
 * boundary, never the enclosing cage or cap tessellation. Invalid/non-manifold
 * pairings fail closed: a partial bridge could conceal a real crack. */
export function createCuttingRimBridge(mesh: CuttingReference): CuttingRimBridge {
  const { skin } = mesh;
  const fail = (): never => { throw new Error("The cutting skin has no consistent paired cohesive rim."); };
  const pointKey = (v: number) => [0, 1, 2].map(a => Math.round(skin.positionsMm[v * 3 + a]! * 1e6)).join(",");
  const edgeKey = (a: string, b: string) => a < b ? `${a}|${b}` : `${b}|${a}`;
  const sides = mesh.tets.reduce<number[]>((out, _, i) => {
    if (i % 4 === 0) out.push(Math.sign(mesh.tets.slice(i, i + 4).reduce((s, n) => s + mesh.positionsMm[n * 3]! - mesh.planeXMm, 0)));
    return out;
  }, []);
  type Edge = { a: number; b: number; ka: string; kb: string; count: number };
  const edges = [new Map<string, Edge>(), new Map<string, Edge>()];
  for (let i = 0; i < skin.indices.length; i += 3) for (let j = 0; j < 3; j++) {
    const a = skin.indices[i + j]!, b = skin.indices[i + (j + 1) % 3]!;
    if (Math.abs(skin.positionsMm[a * 3]! - mesh.planeXMm) > 1e-7 || Math.abs(skin.positionsMm[b * 3]! - mesh.planeXMm) > 1e-7) continue;
    const side = sides[skin.tetIndices[a]!]!;
    if (!side || sides[skin.tetIndices[b]!] !== side) fail();
    const ka = pointKey(a), kb = pointKey(b); if (ka === kb) fail();
    const map = edges[side < 0 ? 0 : 1]!, key = edgeKey(ka, kb), existing = map.get(key);
    if (existing) existing.count++; else map.set(key, { a, b, ka, kb, count: 1 });
  }
  const [left, right] = edges as [Map<string, Edge>, Map<string, Edge>];
  if (!left.size || left.size !== right.size) fail();
  const pairForNode = new Map<number, number>();
  mesh.seamPairs.forEach((p, i) => { pairForNode.set(p.left, i); pairForNode.set(p.right, i); });
  const support = (vertex: number) => {
    const weights = new Map<number, number>();
    for (let c = 0; c < 4; c++) {
      const w = skin.weights[vertex * 4 + c]!; if (w <= 1e-10) continue;
      const pair = pairForNode.get(mesh.tets[skin.tetIndices[vertex]! * 4 + c]!);
      if (pair === undefined) return fail();
      weights.set(pair, (weights.get(pair) ?? 0) + w);
    }
    if (!weights.size) fail();
    return weights;
  };
  const match = (a: number, b: number) => {
    if (Math.hypot(...[0, 1, 2].map(k => skin.positionsMm[a * 3 + k]! - skin.positionsMm[b * 3 + k]!)) > 1e-6) fail();
    const wa = support(a), wb = support(b);
    if (wa.size !== wb.size || [...wa].some(([p, w]) => Math.abs(w - (wb.get(p) ?? Infinity)) > 1e-8)) fail();
    return [...wa.keys()];
  };
  const vertices: number[] = [], damagePairs: number[][] = [], degrees = new Map<string, number>();
  for (const [key, edge] of left) {
    const other = right.get(key);
    if (edge.count !== 1 || !other || other.count !== 1 || edge.ka !== other.kb || edge.kb !== other.ka) fail();
    const r = other!;
    damagePairs.push([...new Set([...match(edge.a, r.b), ...match(edge.b, r.a)])]);
    vertices.push(edge.a, r.b, edge.b, edge.b, r.b, r.a);
    for (const p of [edge.ka, edge.kb]) degrees.set(p, (degrees.get(p) ?? 0) + 1);
  }
  if ([...degrees.values()].some(n => n !== 2)) fail();
  const restPositionsMm = new Float32Array(vertices.length * 3);
  vertices.forEach((v, i) => { for (let a = 0; a < 3; a++) restPositionsMm[i * 3 + a] = skin.positionsMm[v * 3 + a]!; });
  return { skinVertices: Uint32Array.from(vertices), damagePairs, restPositionsMm, pairCount: mesh.seamPairs.length };
}

/** Exact skin endpoint motion/normals; compact only intact triangles into the
 * draw range. No damage threshold, mechanical forces or persistent state. */
export function updateCuttingRimBridge(
  bridge: CuttingRimBridge, skinPositions: ArrayLike<number>, skinNormals: ArrayLike<number>,
  damage: ArrayLike<number>, positions: Float32Array, normals: Float32Array, indices: Uint32Array,
): number {
  if (damage.length !== bridge.pairCount || positions.length !== bridge.skinVertices.length * 3 || normals.length !== positions.length || indices.length !== bridge.skinVertices.length || skinPositions.length !== skinNormals.length) throw new Error("Cutting rim layout mismatch");
  for (let p = 0; p < damage.length; p++) if (!Number.isFinite(damage[p]) || damage[p]! < 0 || damage[p]! > 1) throw new Error("Cutting rim requires accepted finite damage");
  let count = 0;
  for (let segment = 0; segment < bridge.damagePairs.length; segment++) {
    const intact = bridge.damagePairs[segment]!.every(pair => damage[pair] === 0);
    for (let corner = 0; corner < 6; corner++) {
      const i = segment * 6 + corner, v = bridge.skinVertices[i]!;
      if ((v + 1) * 3 > skinPositions.length) throw new Error("Cutting rim skin layout mismatch");
      for (let a = 0; a < 3; a++) { positions[i * 3 + a] = skinPositions[v * 3 + a]!; normals[i * 3 + a] = skinNormals[v * 3 + a]!; }
      if (intact) indices[count++] = i;
    }
  }
  return count;
}
