import * as THREE from "three";

const scratch = new WeakMap<THREE.BufferGeometry, Float32Array>();
/** Exact current corner-angle weighting, without per-triangle objects or arrays. */
export function updateSceneNormals(geometry: THREE.BufferGeometry, angleWeighted = true) {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  if (!(position instanceof THREE.BufferAttribute) || position.normalized || position.itemSize !== 3) { geometry.computeVertexNormals(); return; }
  const p = position.array, index = geometry.index?.array;
  let normal = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
  if (!(normal instanceof THREE.BufferAttribute) || !(normal.array instanceof Float32Array) || normal.normalized || normal.count !== position.count || normal.itemSize !== 3) {
    normal = new THREE.BufferAttribute(new Float32Array(p.length), 3); geometry.setAttribute("normal", normal);
  }
  let sums = scratch.get(geometry);
  if (!sums || sums.length !== p.length) { sums = new Float32Array(p.length); scratch.set(geometry, sums); }
  sums.fill(0);
  const count = index?.length ?? position.count;
  for (let f = 0; f < count; f += 3) {
    const a = (index ? index[f]! : f) * 3, b = (index ? index[f + 1]! : f + 1) * 3, c = (index ? index[f + 2]! : f + 2) * 3;
    const abx = p[b]! - p[a]!, aby = p[b + 1]! - p[a + 1]!, abz = p[b + 2]! - p[a + 2]!;
    const acx = p[c]! - p[a]!, acy = p[c + 1]! - p[a + 1]!, acz = p[c + 2]! - p[a + 2]!;
    const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz); if (length < 1e-12) continue;
    let wa = 1, wb = 1, wc = 1;
    if (angleWeighted) {
      const dot = abx * acx + aby * acy + abz * acz;
      const angleA = Math.atan2(length, dot);
      const angleB = Math.atan2(length, abx * abx + aby * aby + abz * abz - dot);
      wa = angleA / length; wb = angleB / length; wc = Math.max(0, Math.PI - angleA - angleB) / length;
    }
    sums[a]! += nx * wa; sums[a + 1]! += ny * wa; sums[a + 2]! += nz * wa;
    sums[b]! += nx * wb; sums[b + 1]! += ny * wb; sums[b + 2]! += nz * wb;
    sums[c]! += nx * wc; sums[c + 1]! += ny * wc; sums[c + 2]! += nz * wc;
  }
  const n = normal.array;
  for (let i = 0; i < p.length; i += 3) {
    const x = sums[i]!, y = sums[i + 1]!, z = sums[i + 2]!, length = Math.sqrt(x * x + y * y + z * z);
    if (length > 1e-12) { n[i] = x / length; n[i + 1] = y / length; n[i + 2] = z / length; }
  }
  normal.needsUpdate = true;
}

/** Exact AABB and a conservative enclosing sphere in one packed-buffer scan.
 * Contact still uses current triangles; this only accelerates broad-phase bounds.
 */
export function updateSceneBounds(geometry: THREE.BufferGeometry) {
  const attribute = geometry.getAttribute("position") as THREE.BufferAttribute;
  if (!(attribute instanceof THREE.BufferAttribute) || attribute.normalized || attribute.itemSize !== 3 || !attribute.count) {
    geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return;
  }
  const p = attribute.array;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  geometry.boundingBox ??= new THREE.Box3(); geometry.boundingSphere ??= new THREE.Sphere();
  geometry.boundingBox.min.set(minX, minY, minZ); geometry.boundingBox.max.set(maxX, maxY, maxZ);
  geometry.boundingSphere.center.set((minX + maxX) * .5, (minY + maxY) * .5, (minZ + maxZ) * .5);
  geometry.boundingSphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * .5;
}
