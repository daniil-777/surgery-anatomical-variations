import * as THREE from "three";
import type { OrganMesh } from "./types";

export function geometryFor(organ: OrganMesh, pigment: Float32Array) {
  const geometry = new THREE.BufferGeometry();
  synchronizeGeometry(geometry, organ, pigment);
  return geometry;
}

/** Synchronize topology and every vertex field, including equal-sized imports. */
export function synchronizeGeometry(
  geometry: THREE.BufferGeometry,
  organ: OrganMesh,
  pigment: Float32Array,
) {
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(organ.positions, 3),
  );
  geometry.setIndex(organ.indices);
  if (organ.normals?.length === organ.positions.length)
    geometry.setAttribute(
      "normal",
      new THREE.Float32BufferAttribute(organ.normals, 3),
    );
  else {
    geometry.deleteAttribute("normal");
    geometry.computeVertexNormals();
  }
  if (organ.uv?.length === (organ.positions.length / 3) * 2)
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(organ.uv, 2));
  else geometry.deleteAttribute("uv");
  geometry.setAttribute("color", new THREE.BufferAttribute(pigment, 3));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
