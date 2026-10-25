import * as THREE from "three";
import { SceneNavigationGuard, NAVIGATION_CLEARANCE_MM } from "./wholeSceneNavigation";
import type { CameraPose, CameraViewEdge } from "./cameraRL";

export interface CameraPoseGraph {
  nodes: CameraPose[];
  edges: CameraViewEdge[][];
  port: [number, number, number];
  workspace: THREE.Box3;
  /** Undirected lattice connections rejected by bounds or continuous clearance. */
  blockedEdges: number;
}
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const vec = (value: readonly number[]) => new THREE.Vector3(value[0], value[1], value[2]);
const tuple = (value: THREE.Vector3): [number, number, number] => [value.x, value.y, value.z];
const clampUnit = (value: number) => Math.max(-1, Math.min(1, value));
function validatePose(pose: CameraPose) {
  if (![...pose.position, ...pose.direction, ...pose.up, pose.insertionMm, pose.yaw, pose.pitch].every(Number.isFinite)
    || vec(pose.direction).lengthSq() < 1e-12 || vec(pose.up).lengthSq() < 1e-12 || pose.insertionMm <= 0) {
    throw new Error("A finite camera pose and positive insertion are required.");
  }
}
function horizonUp(direction: THREE.Vector3, fallback: THREE.Vector3) {
  const up = WORLD_UP.clone().addScaledVector(direction, -WORLD_UP.dot(direction));
  if (up.lengthSq() < 1e-10) up.copy(fallback).addScaledVector(direction, -fallback.dot(direction));
  if (up.lengthSq() < 1e-10) up.set(1, 0, 0).addScaledVector(direction, -direction.x);
  return up.normalize();
}

/** A straight virtual scope pivots about one fixed entry port. Translation is
 * insertion along its optical axis; angular interpolation follows the sphere,
 * rather than the tissue-cutting chord between two camera positions. */
export function interpolateScopePose(a: CameraPose, b: CameraPose, port: readonly number[], t: number): CameraPose {
  validatePose(a); validatePose(b);
  if (port.length !== 3 || !port.every(Number.isFinite) || !Number.isFinite(t)) throw new Error("Invalid scope interpolation.");
  const progress = THREE.MathUtils.clamp(t, 0, 1);
  const from = vec(a.direction).normalize(), to = vec(b.direction).normalize();
  const rotation = new THREE.Quaternion().setFromUnitVectors(from, to);
  const direction = from.applyQuaternion(new THREE.Quaternion().slerp(rotation, progress)).normalize();
  const insertionMm = THREE.MathUtils.lerp(a.insertionMm, b.insertionMm, progress);
  return {
    position: tuple(vec(port).addScaledVector(direction, insertionMm)),
    direction: tuple(direction), up: tuple(horizonUp(direction, vec(a.up))), insertionMm,
    yaw: THREE.MathUtils.lerp(a.yaw, b.yaw, progress), pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, progress),
  };
}

/** Reachable 3 × 3 × 3 RCM lattice. Every edge uses the exact playback curve,
 * sampled at no more than 2 mm of arc length or 1° of rotation per segment.
 * Swept spheres include a curvature error bound, so the curve between samples
 * retains the requested 2 mm virtual lens clearance. This models a lens and
 * fixed port; it does not claim full shaft, trocar or patient collision safety. */
export function buildCameraPoseGraph(startPose: CameraPose, guard: SceneNavigationGuard, bounds: THREE.Box3): CameraPoseGraph {
  validatePose(startPose);
  if (bounds.isEmpty() || ![...bounds.min.toArray(), ...bounds.max.toArray()].every(Number.isFinite)
    || !bounds.containsPoint(vec(startPose.position))) throw new Error("The camera start must lie in the finite planning workspace.");
  const forward = vec(startPose.direction).normalize(), port = vec(startPose.position).addScaledVector(forward, -70);
  if ((guard.closest(vec(startPose.position), NAVIGATION_CLEARANCE_MM + .01)?.distanceMm ?? Infinity) < NAVIGATION_CLEARANCE_MM + .005) {
    throw new Error("Move the camera away from tissue before building a camera policy.");
  }
  const yawOffsets = [-.3, 0, .3], pitchOffsets = [-.22, 0, .22], insertions = [45, 70, 95];
  const lattice: { pose: CameraPose; coordinate: [number, number, number] }[] = [];
  // The start node remains index zero even when the supplied pose carries a
  // different insertion convention; this graph establishes its own 70 mm RCM.
  lattice.push({ pose: { ...startPose, position: [...startPose.position], direction: tuple(forward), up: [...startPose.up], insertionMm: 70, yaw: 0, pitch: 0 }, coordinate: [1, 1, 1] });
  for (let y = 0; y < 3; y++) for (let p = 0; p < 3; p++) for (let z = 0; z < 3; z++) {
    if (y === 1 && p === 1 && z === 1) continue;
    const yaw = yawOffsets[y]!, pitch = pitchOffsets[p]!, insertionMm = insertions[z]!;
    const direction = forward.clone().applyAxisAngle(WORLD_UP, yaw);
    const right = new THREE.Vector3().crossVectors(direction, WORLD_UP);
    if (right.lengthSq() < 1e-10) right.crossVectors(direction, vec(startPose.up));
    if (right.lengthSq() < 1e-10) throw new Error("The initial camera requires a finite horizon for RCM planning.");
    direction.applyAxisAngle(right.normalize(), pitch).normalize();
    lattice.push({ pose: { position: tuple(port.clone().addScaledVector(direction, insertionMm)), direction: tuple(direction), up: tuple(horizonUp(direction, vec(startPose.up))), insertionMm, yaw, pitch }, coordinate: [y, p, z] });
  }
  const byCoordinate = new Map(lattice.map((node, i) => [node.coordinate.join(","), i]));
  const connections: CameraViewEdge[][] = lattice.map(() => []);
  let blockedEdges = 0;
  for (let i = 0; i < lattice.length; i++) {
    const a = lattice[i]!;
    for (let axis = 0; axis < 3; axis++) {
      const next = [...a.coordinate]; next[axis]!++;
      const j = byCoordinate.get(next.join(",")); if (j === undefined) continue;
      const b = lattice[j]!.pose;
      const angleRad = Math.acos(clampUnit(vec(a.pose.direction).normalize().dot(vec(b.direction).normalize())));
      const insertionDelta = Math.abs(b.insertionMm - a.pose.insertionMm), maxInsertion = Math.max(a.pose.insertionMm, b.insertionMm);
      const lengthBound = insertionDelta + maxInsertion * angleRad;
      const steps = Math.max(1, Math.ceil(lengthBound / 2), Math.ceil(angleRad / THREE.MathUtils.degToRad(1)));
      // Bound deviation between the smooth RCM curve and a sampled chord by
      // max|p''| h²/8, including simultaneous insertion and angular motion.
      const curvatureMargin = (2 * insertionDelta * angleRad + maxInsertion * angleRad ** 2) / (8 * steps ** 2) + .0001;
      let previous = vec(a.pose.position), distanceMm = 0, clear = true;
      for (let step = 1; step <= steps; step++) {
        const requested = vec(interpolateScopePose(a.pose, b, tuple(port), step / steps).position);
        const result = guard.move(previous, requested, bounds, NAVIGATION_CLEARANCE_MM + curvatureMargin);
        if (result.blocked || result.position.distanceToSquared(requested) > 1e-10) { clear = false; break; }
        distanceMm += previous.distanceTo(requested); previous = requested;
      }
      if (!clear) { blockedEdges++; continue; }
      connections[i]!.push({ to: j, distanceMm, angleRad }); connections[j]!.push({ to: i, distanceMm, angleRad });
    }
  }
  // A clear-looking point beyond a sheet is never a permissible teleport. Keep
  // only nodes connected through guarded curves to the actual current camera.
  const reachable = new Set<number>([0]), queue = [0];
  for (let q = 0; q < queue.length; q++) for (const edge of connections[queue[q]!]!) {
    if (!reachable.has(edge.to)) { reachable.add(edge.to); queue.push(edge.to); }
  }
  const retained = [...reachable].sort((a, b) => a - b), remap = new Map(retained.map((old, i) => [old, i]));
  return {
    nodes: retained.map(i => lattice[i]!.pose),
    edges: retained.map(i => connections[i]!.filter(edge => reachable.has(edge.to)).map(edge => ({ ...edge, to: remap.get(edge.to)! }))),
    port: tuple(port), workspace: bounds.clone(), blockedEdges,
  };
}
