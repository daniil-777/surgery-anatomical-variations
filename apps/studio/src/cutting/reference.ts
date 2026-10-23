import type { CuttingEmbeddedSurface, CuttingReference } from "./types";
import { validateContactCapDomain } from "./contactCapDomain";

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const numbers = (value: unknown, multiple = 1): value is number[] => Array.isArray(value) && value.length > 0 && value.length % multiple === 0 && value.every(finite);
const indices = (value: unknown, multiple: number, maximum: number): value is number[] => numbers(value, multiple) && value.every(v => Number.isInteger(v) && v >= 0 && v < maximum);

/** Validate geometry and its side-specific embedding before allocating GPU data. */
export function readCuttingReference(value: unknown): CuttingReference {
  const fail = (): never => { throw new Error("The cutting reference has invalid geometry, embedding or provenance."); };
  if (!record(value) || value.schema !== "viscera.cutting-reference/v1" || !record(value.source) || !numbers(value.positionsMm, 3) || value.positionsMm.length > 300000 || value.positionsMm.some(v => Math.abs(v) > 10000) || !finite(value.planeXMm) || !finite(value.floorYMm) || !record(value.skin) || !record(value.diagnostics) || !Array.isArray(value.limitations) || !value.limitations.every(v => typeof v === "string")) return fail();
  const source = value.source, positions = value.positionsMm, planeX = value.planeXMm;
  if (!["templateId", "sha256", "attribution", "license"].every(key => typeof source[key] === "string" && Boolean(source[key]))) return fail();
  const nodes = positions.length / 3, skin = value.skin;
  if (!indices(value.tets, 4, nodes) || !indices(value.boundaryIndices, 3, nodes) || !indices(value.seamLeftIndices, 3, nodes) || !indices(value.seamRightIndices, 3, nodes) || !indices(value.fixedNodes, 1, nodes) || !Array.isArray(value.seamPairs) || !value.seamPairs.length || !numbers(skin.positionsMm, 3) || skin.positionsMm.length > 1500000 || !numbers(skin.colors, 3) || skin.colors.length !== skin.positionsMm.length || skin.colors.some(v => v < 0 || v > 1) || !indices(skin.indices, 3, skin.positionsMm.length / 3) || !indices(skin.tetIndices, 1, value.tets.length / 4) || skin.tetIndices.length !== skin.positionsMm.length / 3 || !numbers(skin.weights, 4) || skin.weights.length !== skin.tetIndices.length * 4) return fail();
  const skinPositions = skin.positionsMm;
  const paired = new Set<number>(), left = new Set<number>(), right = new Set<number>();
  for (const pair of value.seamPairs) {
    if (!record(pair) || !finite(pair.left) || !finite(pair.right) || !Number.isInteger(pair.left) || !Number.isInteger(pair.right) || pair.left < 0 || pair.right < 0 || pair.left >= nodes || pair.right >= nodes || pair.left === pair.right || paired.has(pair.left) || paired.has(pair.right) || !finite(pair.areaM2) || pair.areaM2 <= 0) return fail();
    for (const id of [pair.left, pair.right]) { paired.add(id); if (Math.abs(value.positionsMm[id * 3]! - value.planeXMm) > 1e-5) return fail(); }
    const leftId = pair.left, rightId = pair.right;
    if (Math.hypot(...[0, 1, 2].map(axis => positions[leftId * 3 + axis]! - positions[rightId * 3 + axis]!)) > 1e-5) return fail();
    left.add(pair.left); right.add(pair.right);
  }
  if (!value.seamLeftIndices.every(id => left.has(id)) || !value.seamRightIndices.every(id => right.has(id))) return fail();
  const tetSides: number[] = [];
  for (let i = 0; i < value.tets.length; i += 4) {
    const ids = value.tets.slice(i, i + 4); if (new Set(ids).size !== 4) return fail();
    const xs = ids.map(id => positions[id * 3]! - planeX), sum = xs.reduce((a, b) => a + b, 0);
    if ((Math.min(...xs) < -1e-5 && Math.max(...xs) > 1e-5) || Math.abs(sum) < 1e-8) return fail(); tetSides.push(Math.sign(sum));
  }
  const faceArea = (faces: number[]) => {
    let area = 0;
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i]! * 3, b = faces[i + 1]! * 3, c = faces[i + 2]! * 3;
      const u = [0, 1, 2].map(axis => positions[b + axis]! - positions[a + axis]!), v = [0, 1, 2].map(axis => positions[c + axis]! - positions[a + axis]!);
      area += .5e-6 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!);
    }
    return area;
  };
  const areaLeft = faceArea(value.seamLeftIndices), areaRight = faceArea(value.seamRightIndices), quadratureArea = (value.seamPairs as { areaM2: number }[]).reduce((sum, pair) => sum + pair.areaM2, 0);
  if (!(areaLeft > 0) || Math.abs(areaLeft - areaRight) > 1e-7 * areaLeft || Math.abs(areaLeft - quadratureArea) > 1e-7 * areaLeft || !finite(value.diagnostics.seamAreaM2) || Math.abs(areaLeft - value.diagnostics.seamAreaM2) > 1e-7 * areaLeft) return fail();
  for (let vertex = 0; vertex < skin.tetIndices.length; vertex++) {
    const sourceSide = skinPositions[vertex * 3]! - planeX;
    if (Math.abs(sourceSide) > 1e-5 && Math.sign(sourceSide) !== tetSides[skin.tetIndices[vertex]!]) return fail();
    let sum = 0; const reconstructed = [0, 0, 0];
    for (let corner = 0; corner < 4; corner++) {
      const weight = skin.weights[vertex * 4 + corner]!; if (weight < -1e-6 || weight > 1 + 1e-6) return fail(); sum += weight;
      const node = value.tets[skin.tetIndices[vertex]! * 4 + corner]!;
      for (let axis = 0; axis < 3; axis++) reconstructed[axis]! += weight * value.positionsMm[node * 3 + axis]!;
    }
    if (Math.abs(sum - 1) > 1e-6 || Math.hypot(...reconstructed.map((v, axis) => v - skinPositions[vertex * 3 + axis]!)) > .001) return fail();
  }
  for (let face = 0; face < skin.indices.length; face += 3) {
    const x = skin.indices.slice(face, face + 3).map(id => skinPositions[id * 3]! - planeX);
    if (Math.min(...x) < -1e-5 && Math.max(...x) > 1e-5) return fail();
    const side = tetSides[skin.tetIndices[skin.indices[face]!]!]!;
    for (let corner = 1; corner < 3; corner++) if (tetSides[skin.tetIndices[skin.indices[face + corner]!]!] !== side) return fail();
  }
  if (value.contactCap !== undefined && value.cap === undefined) return fail();
  const capMoments: Map<number, number[]>[] = [];
  for (const name of ["cap", "contactCap"]) {
    if (value[name] === undefined) continue;
    const cap = value[name], moments = new Map<number, number[]>();
    if (!record(cap) || !numbers(cap.positionsMm, 3) || cap.positionsMm.length > 1500000 || !indices(cap.indices, 3, cap.positionsMm.length / 3) || !indices(cap.tetIndices, 1, value.tets.length / 4) || cap.tetIndices.length * 3 !== cap.positionsMm.length || !numbers(cap.weights, 4) || cap.weights.length !== cap.tetIndices.length * 4) return fail();
    const capPositions = cap.positionsMm, capTetIndices = cap.tetIndices;
    for (let vertex = 0; vertex < cap.tetIndices.length; vertex++) {
      if (Math.abs(cap.positionsMm[vertex * 3]! - planeX) > 1e-5) return fail();
      let sum = 0; const reconstructed = [0, 0, 0];
      for (let corner = 0; corner < 4; corner++) {
        const weight = cap.weights[vertex * 4 + corner]!;
        if (weight < -1e-6 || weight > 1 + 1e-6) return fail(); sum += weight;
        const node = value.tets[cap.tetIndices[vertex]! * 4 + corner]!;
        for (let axis = 0; axis < 3; axis++) reconstructed[axis]! += weight * positions[node * 3 + axis]!;
      }
      if (Math.abs(sum - 1) > 1e-6 || Math.hypot(...reconstructed.map((v, axis) => v - capPositions[vertex * 3 + axis]!)) > .001) return fail();
    }
    for (let face = 0; face < cap.indices.length; face += 3) {
      const ids = cap.indices.slice(face, face + 3), side = tetSides[cap.tetIndices[ids[0]!]!]!;
      if (ids.some(id => tetSides[capTetIndices[id]!] !== side)) return fail();
      if (ids.some(id => capTetIndices[id] !== capTetIndices[ids[0]!])) return fail();
      const [a, b, c] = ids.map(id => id * 3);
      const normalX = (cap.positionsMm[b! + 1]! - cap.positionsMm[a! + 1]!) * (cap.positionsMm[c! + 2]! - cap.positionsMm[a! + 2]!) - (cap.positionsMm[b! + 2]! - cap.positionsMm[a! + 2]!) * (cap.positionsMm[c! + 1]! - cap.positionsMm[a! + 1]!);
      if (normalX * side >= 0) return fail();
      const area = .5e-6 * Math.abs(normalX), tet = capTetIndices[ids[0]!]!;
      const m = moments.get(tet) ?? [0,0,0,0,0,0];
      const y=ids.map(id=>capPositions[3*id+1]!), z=ids.map(id=>capPositions[3*id+2]!);
      const sy=y.reduce((a,b)=>a+b,0),sz=z.reduce((a,b)=>a+b,0);
      m[0]!+=area;m[1]!+=area*sy/3;m[2]!+=area*sz/3;
      m[3]!+=area*(sy*sy+y.reduce((a,b)=>a+b*b,0))/12;
      m[4]!+=area*(sy*sz+y.reduce((a,b,i)=>a+b*z[i]!,0))/12;
      m[5]!+=area*(sz*sz+z.reduce((a,b)=>a+b*b,0))/12;
      moments.set(tet,m);
    }
    capMoments.push(moments);
  }
  if(capMoments.length===2){
    const original=capMoments[0]!,compact=capMoments[1]!;
    if(original.size!==compact.size)return fail();
    for(const [tet,m] of original){const other=compact.get(tet);if(!other)return fail();
      for(let i=0;i<m.length;i++)if(Math.abs(m[i]!-other[i]!)>1e-8*Math.max(Math.abs(m[i]!),m[0]!)+1e-14)return fail();}
    validateContactCapDomain(value.cap as unknown as CuttingEmbeddedSurface, value.contactCap as unknown as CuttingEmbeddedSurface);
  }
  return value as unknown as CuttingReference;
}

export function updateCuttingSkin(mesh: CuttingReference, mechanicalMm: ArrayLike<number>, output: Float32Array): void {
  updateCuttingSurface(mesh, mesh.skin, mechanicalMm, output);
}

export function updateCuttingSurface(mesh: CuttingReference, surface: CuttingEmbeddedSurface, mechanicalMm: ArrayLike<number>, output: Float32Array): void {
  if (mechanicalMm.length !== mesh.positionsMm.length || output.length !== surface.positionsMm.length) throw new Error("Cutting surface layout mismatch");
  for (let vertex = 0; vertex < surface.tetIndices.length; vertex++) for (let axis = 0; axis < 3; axis++) {
    let position = 0; const tet = surface.tetIndices[vertex]! * 4;
    for (let corner = 0; corner < 4; corner++) position += surface.weights[vertex * 4 + corner]! * mechanicalMm[mesh.tets[tet + corner]! * 3 + axis]!;
    output[vertex * 3 + axis] = position;
  }
}
