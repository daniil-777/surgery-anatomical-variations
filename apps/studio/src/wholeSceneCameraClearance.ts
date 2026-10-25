import * as THREE from "three";
import { instrumentContactEnvelopes } from "./wholeSceneInstrumentEnvelope";

export const CAMERA_GUARD_RADIUS_MM = 4;
export type CameraInstrumentKind = "shaft" | "jaw" | "tip" | "handle";
type Point = [number, number, number];
export type CameraInstrumentEnvelope =
  | { shape: "capsule"; kind: CameraInstrumentKind; startMm: Point; endMm: Point; radiusMm: number }
  | { shape: "box"; kind: "handle"; minimumMm: Point; maximumMm: Point };

/** Authored convex bounds of the generic visible instrument, not device CAD.
 * The two grasper handle boxes include the entire trigger rotation interval
 * [-0.16, 0.13] rad, so closure changes cannot expose an unguarded grip.
 * They deliberately include finger-loop holes; the camera never relies on
 * fitting through a small handle opening. No render-mesh traversal is needed. */
export function cameraInstrumentEnvelopes(mode: "push" | "grasp", radiusMm: number, closure: number): CameraInstrumentEnvelope[] {
  if (![radiusMm, closure].every(Number.isFinite) || radiusMm < 1 || radiusMm > 60 || !["push", "grasp"].includes(mode)) throw new Error("Invalid camera/instrument envelope parameters.");
  const envelopes: CameraInstrumentEnvelope[] = instrumentContactEnvelopes(mode, radiusMm, closure).map(envelope => ({
    shape: "capsule", kind: envelope.kind, startMm: envelope.startMm, endMm: envelope.endMm, radiusMm: envelope.radiusMm,
  }));
  if (mode === "push") {
    envelopes.push({ shape: "capsule", kind: "tip", startMm: [0, 0, radiusMm], endMm: [0, 0, radiusMm], radiusMm });
    const offset = Math.max(0, radiusMm * 2 + 9 - 30);
    // Collar, knurls, pencil grip, end cap and rounded proximal end.
    envelopes.push({ shape: "box", kind: "handle", minimumMm: [-6.3, -6.3, 243.4 + offset], maximumMm: [6.3, 6.3, 299 + offset] });
  } else {
    // Fixed housing/palm loop/ratchet/collar and hinge caps.
    envelopes.push({ shape: "box", kind: "handle", minimumMm: [-7.5, -48, 243.4], maximumMm: [7.5, 6.3, 299] });
    // Trigger source bound x±3.1, y[-47.8,2], z[-23.2,3.2], rotated
    // about X through [-.16,.13] then translated by local z=259. Bounds
    // include extrema inside the angular interval as well as its endpoints.
    envelopes.push({ shape: "box", kind: "handle", minimumMm: [-3.1, -51, 229.5], maximumMm: [3.1, 6, 270] });
  }
  return envelopes;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Exact minimum separation of two finite segments, including zero-length tips. */
function segmentDistance(a0: Point, a1: Point, b0: Point, b1: Point) {
  const d1 = subtract(a1, a0), d2 = subtract(b1, b0), r = subtract(a0, b0);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s = 0, t = 0;
  if (a <= 1e-20 && e <= 1e-20) return Math.hypot(...r);
  if (a <= 1e-20) t = clamp01(f / e);
  else {
    const c = dot(d1, r);
    if (e <= 1e-20) s = clamp01(-c / a);
    else {
      const b = dot(d1, d2), denominator = a * e - b * b;
      s = denominator > 1e-20 * a * e ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  return Math.hypot(r[0] + s * d1[0] - t * d2[0], r[1] + s * d1[1] - t * d2[1], r[2] + s * d1[2] - t * d2[2]);
}

/** Distance from a whole segment to a box, not endpoint samples. Each interval
 * between plane crossings has a quadratic squared distance; its stationary
 * point and endpoints give the exact minimum over the translated sweep. */
function segmentBoxDistance(from: Point, to: Point, minimum: Point, maximum: Point) {
  const delta = subtract(to, from), breaks = [0, 1];
  for (let axis = 0; axis < 3; axis++) if (Math.abs(delta[axis]!) > 1e-15) {
    for (const plane of [minimum[axis]!, maximum[axis]!]) {
      const t = (plane - from[axis]!) / delta[axis]!;
      if (t > 0 && t < 1) breaks.push(t);
    }
  }
  breaks.sort((a, b) => a - b);
  const distanceSquared = (t: number) => {
    let squared = 0;
    for (let axis = 0; axis < 3; axis++) {
      const value = from[axis]! + delta[axis]! * t;
      const gap = Math.max(minimum[axis]! - value, 0, value - maximum[axis]!);
      squared += gap * gap;
    }
    return squared;
  };
  let best = Math.min(distanceSquared(0), distanceSquared(1));
  for (let i = 0; i + 1 < breaks.length; i++) {
    const lo = breaks[i]!, hi = breaks[i + 1]!, midpoint = (lo + hi) * .5;
    let quadratic = 0, linearHalf = 0;
    for (let axis = 0; axis < 3; axis++) {
      const value = from[axis]! + delta[axis]! * midpoint;
      const plane = value < minimum[axis]! ? minimum[axis]! : value > maximum[axis]! ? maximum[axis]! : null;
      if (plane !== null) { quadratic += delta[axis]! ** 2; linearHalf += (from[axis]! - plane) * delta[axis]!; }
    }
    const t = quadratic > 0 ? Math.max(lo, Math.min(hi, -linearHalf / quadratic)) : midpoint;
    best = Math.min(best, distanceSquared(lo), distanceSquared(hi), distanceSquared(t));
  }
  return Math.sqrt(best);
}

/** Positive clearance is safe; zero/negative means the lens sphere intersects
 * a conservative visible-instrument bound anywhere during translation.
 * Axis/orientation is held constant over this sweep. Call separately for each
 * candidate orientation; this API does not certify a rotating sweep. */
export function cameraInstrumentClearance(
  cameraPoint: THREE.Vector3, originFrom: THREE.Vector3, originTo: THREE.Vector3,
  axis: THREE.Vector3, mode: "push" | "grasp", radiusMm: number, closure: number,
): { clearanceMm: number; kind: CameraInstrumentKind } {
  if (![cameraPoint, originFrom, originTo, axis].every(point => [point.x, point.y, point.z].every(Number.isFinite)) || axis.lengthSq() < 1e-20) throw new Error("Invalid camera/instrument pose.");
  const inverse = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis.clone().normalize()).invert();
  const from = cameraPoint.clone().sub(originFrom).applyQuaternion(inverse).toArray() as Point;
  const to = cameraPoint.clone().sub(originTo).applyQuaternion(inverse).toArray() as Point;
  let clearanceMm = Infinity, kind: CameraInstrumentKind = "shaft";
  for (const envelope of cameraInstrumentEnvelopes(mode, radiusMm, closure)) {
    const clearance = (envelope.shape === "capsule"
      ? segmentDistance(from, to, envelope.startMm, envelope.endMm) - envelope.radiusMm
      : segmentBoxDistance(from, to, envelope.minimumMm, envelope.maximumMm)) - CAMERA_GUARD_RADIUS_MM;
    if (clearance < clearanceMm) { clearanceMm = clearance; kind = envelope.kind; }
  }
  return { clearanceMm, kind };
}
