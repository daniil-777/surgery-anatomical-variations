import { bloodSlabTransport, composeDiffuseSubstrate } from "../optics";

/** Actual SI height graph, extruded uniformly in z. No invented waves or bumps.
 * Vertex values interpolate the periodic cell centres at their shared edges.
 * World coordinates are millimetres; normals retain the physical slope.
 */
export function filmGeometryData(heightsM: ArrayLike<number>, lengthM: number, widthM: number) {
  const n = heightsM.length;
  if (!Number.isInteger(n) || n < 8 || n > 256 || ![lengthM, widthM].every(v => Number.isFinite(v) && v > 0))
    throw new RangeError("Film geometry requires 8–256 cells and positive dimensions");
  for (let i = 0; i < n; ++i)
    if (!Number.isFinite(heightsM[i]) || heightsM[i]! <= 0) throw new RangeError("Film heights must be positive finite metres");
  const positions = new Float32Array((n + 1) * 6), normals = new Float32Array(positions.length);
  const colours = new Float32Array(positions.length), indices = new Uint16Array(n * 6);
  const dx = lengthM / n, substrateReflectance = .72;
  for (let i = 0; i <= n; ++i) {
    const left = heightsM[(i + n - 1) % n]!, right = heightsM[i % n]!;
    const h = (left + right) / 2, slope = (right - left) / dx, inverse = 1 / Math.hypot(slope, 1);
    const colour = composeDiffuseSubstrate(bloodSlabTransport(h), [substrateReflectance, substrateReflectance, substrateReflectance]);
    for (let side = 0; side < 2; ++side) {
      const j = i * 6 + side * 3;
      positions.set([(i * dx - lengthM / 2) * 1000, h * 1000, (side - .5) * widthM * 1000], j);
      normals.set([-slope * inverse, inverse, 0], j);
      // Approximate diffuse slab/substrate response includes both traversals
      // and repeated exchanges. PBR adds illustrative directional lighting.
      colours.set(colour, j);
    }
    if (i < n) { const a = 2 * i; indices.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], i * 6); }
  }
  return { positions, normals, colours, indices };
}
