import * as THREE from "three";

/** Reframe the current deformed bounds without changing camera orientation or tissue. */
export function fitLiverView(camera: THREE.PerspectiveCamera, bounds: THREE.Box3, margin = 1.18): THREE.Vector3 {
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray(), camera.aspect, camera.getEffectiveFOV()].every(Number.isFinite) || !Number.isFinite(margin) || margin < 1 || camera.aspect <= 0 || camera.getEffectiveFOV() <= 0 || camera.getEffectiveFOV() >= 179) throw new Error("Invalid camera framing bounds");
  const center = bounds.getCenter(new THREE.Vector3());
  const corners = liverBoundsCorners(bounds);
  camera.updateMatrixWorld();
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const back = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 2);
  const tanY = Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2), tanX = tanY * camera.aspect;
  let distance = camera.near * 2;
  for (const corner of corners) {
    const offset = corner.clone().sub(center), depth = offset.dot(back);
    distance = Math.max(distance, depth + margin * Math.abs(offset.dot(right)) / tanX, depth + margin * Math.abs(offset.dot(up)) / tanY, depth + camera.near * 2);
  }
  camera.position.copy(center).addScaledVector(back, distance);
  camera.far = Math.max(camera.far, distance + bounds.getSize(new THREE.Vector3()).length() * 2);
  camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  return center;
}

export function liverBoundsCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const result: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) result.push(new THREE.Vector3(x, y, z));
  return result;
}

/** Conservative AABB coverage; it is neither tissue visibility nor an occlusion score. */
export function liverInCameraFrame(camera: THREE.PerspectiveCamera, bounds: THREE.Box3): boolean {
  return liverBoundsCorners(bounds).every(point => {
    point.project(camera);
    return Number.isFinite(point.x) && Math.abs(point.x) <= .97 && Math.abs(point.y) <= .97 && point.z >= -1 && point.z <= 1;
  });
}
