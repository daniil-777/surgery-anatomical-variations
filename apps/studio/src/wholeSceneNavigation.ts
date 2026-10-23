import * as THREE from "three";
import { SceneSurfaceContact } from "./wholeSceneContact";
import { toolCapsuleMayMeetBounds } from "./wholeSceneToolBounds";

export type WholeSceneNavigationDirection = "forward" | "back" | "left" | "right" | "up" | "down";
export interface WholeSceneNavigationState {
  mode: "orbit" | "explore";
  ready: boolean;
  blocked: boolean;
  blockedBy: string | null;
  positionMm: number[];
  direction: number[];
  clearanceMm: number;
  speedMmS: number;
  message: string;
}
export interface NavigationSurface { id: string; visible: boolean; geometry: THREE.BufferGeometry }
export const NAVIGATION_CLEARANCE_MM = 2;
export const NAVIGATION_SPEED_MM_S = 45;

/** These atlas geometries already have their source transforms baked into their
 * vertex positions. Two-sided surface sweeps protect the camera against visible
 * sheets, including edges; they do not infer tissue volumes or organ lumens. */
export class SceneNavigationGuard {
  private cache = new Map<THREE.BufferGeometry, SceneSurfaceContact>();
  constructor(private readonly surfaces: () => NavigationSurface[]) {}
  invalidate() { this.cache.clear(); }
  private surface(part: NavigationSurface) {
    let cached = this.cache.get(part.geometry);
    if (!cached) {
      const position = part.geometry.getAttribute("position");
      const positions = Float32Array.from(position.array);
      const index = part.geometry.index;
      const indices = index ? Uint32Array.from(index.array) : Uint32Array.from({ length: position.count }, (_, i) => i);
      cached = new SceneSurfaceContact(part.id, positions, indices);
      this.cache.set(part.geometry, cached);
    }
    return cached;
  }
  closest(position: THREE.Vector3, maximumMm = NAVIGATION_CLEARANCE_MM) {
    if (!position.toArray().every(Number.isFinite) || !Number.isFinite(maximumMm) || maximumMm <= 0) throw new Error("Invalid camera clearance query");
    let nearest: ReturnType<SceneSurfaceContact["closestPoint"]> = null;
    for (const part of this.surfaces()) {
      if (!part.visible) continue;
      const box = part.geometry.boundingBox;
      if (box && box.distanceToPoint(position) > maximumMm) continue;
      const hit = this.surface(part).closestPoint(position.toArray(), nearest?.distanceMm ?? maximumMm);
      if (hit && (!nearest || hit.distanceMm < nearest.distanceMm)) nearest = hit;
    }
    return nearest;
  }
  rayDistance(position: THREE.Vector3, direction: THREE.Vector3, maximumMm: number) {
    const ray = new THREE.Ray(position, direction);
    let distance = maximumMm;
    for (const part of this.surfaces()) {
      if (!part.visible || (part.geometry.boundingBox && !ray.intersectsBox(part.geometry.boundingBox))) continue;
      const hit = this.surface(part).raycast(position.toArray(), direction.toArray(), "double", distance);
      if (hit) distance = Math.min(distance, hit.distanceMm);
    }
    return distance;
  }
  move(from: THREE.Vector3, requested: THREE.Vector3, bounds: THREE.Box3, radiusMm = NAVIGATION_CLEARANCE_MM) {
    if (![...from.toArray(), ...requested.toArray(), ...bounds.min.toArray(), ...bounds.max.toArray(), radiusMm].every(Number.isFinite) || radiusMm <= 0 || bounds.isEmpty()) throw new Error("Invalid bounded camera movement");
    const to = requested.clone().clamp(bounds.min, bounds.max);
    let blockedBy: string | null = to.equals(requested) ? null : "navigation bounds";
    let earliest = 1;
    for (const part of this.surfaces()) {
      if (!part.visible) continue;
      if (part.geometry.boundingBox && !toolCapsuleMayMeetBounds(from, to, radiusMm, part.geometry.boundingBox)) continue;
      const hit = this.surface(part).sweepSphere(from.toArray(), to.toArray(), radiusMm);
      if (hit && hit.time <= earliest) { earliest = hit.time; blockedBy = part.id; }
    }
    const distance = from.distanceTo(to);
    // A small distance margin prevents numerical re-entry at the contact point.
    const fraction = earliest < 1 ? Math.max(0, earliest - .02 / Math.max(distance, .02)) : 1;
    return { position: from.clone().lerp(to, fraction), blocked: blockedBy !== null, blockedBy };
  }
}

export function navigationAngles(direction: THREE.Vector3) {
  if (!direction.toArray().every(Number.isFinite) || direction.lengthSq() < 1e-15) throw new Error("Invalid camera direction");
  const unit = direction.clone().normalize();
  return { yaw: Math.atan2(-unit.x, -unit.z), pitch: Math.asin(THREE.MathUtils.clamp(unit.y, -1, 1)) };
}
export function navigationDirection(yaw: number, pitch: number) {
  if (![yaw, pitch].every(Number.isFinite)) throw new Error("Invalid camera look angles");
  const boundedPitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + .01, Math.PI / 2 - .01);
  return new THREE.Vector3(-Math.sin(yaw) * Math.cos(boundedPitch), Math.sin(boundedPitch), -Math.cos(yaw) * Math.cos(boundedPitch));
}
export function navigationStep(direction: WholeSceneNavigationDirection, forward: THREE.Vector3, distanceMm: number) {
  if (!Number.isFinite(distanceMm) || distanceMm < 0 || distanceMm > 5000) throw new Error("Invalid camera step distance");
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const axes: Record<WholeSceneNavigationDirection, THREE.Vector3> = {
    forward: forward.clone(), back: forward.clone().negate(), left: right.clone().negate(), right,
    up: new THREE.Vector3(0, 1, 0), down: new THREE.Vector3(0, -1, 0),
  };
  if (!axes[direction] || !forward.toArray().every(Number.isFinite) || Math.abs(forward.length() - 1) > 1e-6) throw new Error("Invalid camera movement direction");
  return axes[direction].multiplyScalar(distanceMm);
}
/** Aggregate CURRENT geometry bounds after variation/physics, without moving
 * the user's camera or changing the source atlas coordinates. */
export function currentSceneBounds(geometries: THREE.BufferGeometry[], target = new THREE.Box3()) {
  target.makeEmpty();
  for (const geometry of geometries) {
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (geometry.boundingBox) target.union(geometry.boundingBox);
  }
  return target;
}
