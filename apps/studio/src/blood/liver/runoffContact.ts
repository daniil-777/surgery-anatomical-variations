import { ballisticState, type VesselVector } from "../experiments/vesselSolver";
import { runoffAttachedGeometry, type RunoffAttachedGeometry, type RunoffSupportAnchor } from "./runoff";

export interface RunoffBallisticBody {
  originM: VesselVector;
  initialVelocityMS: VesselVector;
  birthTimeSeconds: number;
  radiusM: number;
}
const dot = (a: VesselVector, b: VesselVector) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const difference = (a: VesselVector, b: VesselVector): VesselVector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Euclidean distance to the UNION of the finite cylinder and spherical cap.
 * The cap is a ball intersected with the halfspace above its contact plane.
 * A point inside either solid has distance zero. */
export function distanceToRunoffAttached(shape: RunoffAttachedGeometry, point: VesselVector): number {
  const delta = difference(point, shape.anchorM), z = dot(delta, shape.normal);
  const radial = Math.sqrt(Math.max(0, dot(delta, delta) - z * z)), a = shape.contactRadiusM;
  const cylinder = Math.hypot(Math.max(0, -z, z - shape.neckLengthM), Math.max(0, radial - a));
  if (shape.capHeightM <= 0) return cylinder;
  const h = shape.capHeightM, centre = (h * h - a * a) / (2 * h), radius = h - centre;
  const q = z - shape.neckLengthM;
  let cap: number;
  const length = Math.hypot(radial, q - centre);
  if (length <= radius && q >= 0) cap = 0;
  else if (length > radius && centre + (q - centre) * radius / length >= 0) cap = length - radius;
  else cap = Math.hypot(q, Math.max(0, radial - a));
  return Math.min(cylinder, cap);
}
export function closestPointOnRunoffAttached(shape: RunoffAttachedGeometry, point: VesselVector): VesselVector {
  const delta = difference(point, shape.anchorM), z = dot(delta, shape.normal);
  const radialVector: VesselVector = [delta[0] - z * shape.normal[0], delta[1] - z * shape.normal[1], delta[2] - z * shape.normal[2]];
  const radial = Math.hypot(...radialVector), a = shape.contactRadiusM;
  const at = (height: number, radius: number): VesselVector => [
    shape.anchorM[0] + height * shape.normal[0] + (radial > 0 ? radius / radial * radialVector[0] : 0),
    shape.anchorM[1] + height * shape.normal[1] + (radial > 0 ? radius / radial * radialVector[1] : 0),
    shape.anchorM[2] + height * shape.normal[2] + (radial > 0 ? radius / radial * radialVector[2] : 0),
  ];
  const cylinder = at(Math.max(0, Math.min(shape.neckLengthM, z)), Math.min(a, radial));
  if (shape.capHeightM <= 0) return cylinder;
  const h = shape.capHeightM, c = (h * h - a * a) / (2 * h), R = h - c, q = z - shape.neckLengthM;
  let cap: VesselVector;
  const length = Math.hypot(radial, q - c);
  if (length <= R && q >= 0) cap = [...point];
  else if (length > R && c + (q - c) * R / length >= 0)
    cap = at(shape.neckLengthM + c + (q - c) * R / length, radial * R / length);
  else cap = at(shape.neckLengthM, Math.min(a, radial));
  return Math.hypot(...difference(point, cylinder)) <= Math.hypot(...difference(point, cap)) ? cylinder : cap;
}

/** Equal gravitational acceleration cancels from relative motion. */
export function runoffSphereContactTime(a: RunoffBallisticBody, b: RunoffBallisticBody,
  gravity: VesselVector, start: number, end: number): number | undefined {
  const x = ballisticState(a.originM, a.initialVelocityMS, gravity, start - a.birthTimeSeconds);
  const y = ballisticState(b.originM, b.initialVelocityMS, gravity, start - b.birthTimeSeconds);
  const p = difference(x.positionM, y.positionM), v = difference(x.velocityMS, y.velocityMS);
  const radius = a.radiusM + b.radiusM, c = dot(p, p) - radius * radius;
  if (c <= 0) return start;
  const speed2 = dot(v, v), pv = dot(p, v);
  if (speed2 === 0 || pv >= 0) return undefined;
  const discriminant = pv * pv - speed2 * c;
  if (discriminant < 0) return undefined;
  // Stable near-contact root avoids subtracting almost equal positive numbers.
  const t = c / (-pv + Math.sqrt(discriminant));
  return t >= 0 && t <= end - start ? start + t : undefined;
}

/** Continuous contact against a monotonically filling attached shape.
 * For each interval the final shape contains every earlier fill state. Distance
 * is 1-Lipschitz in position; a ballistic displacement bound therefore certifies
 * absence without endpoint-only sampling. Ambiguous/budget-limited intervals
 * reject instead of inventing a contact or missing a possible short crossing. */
export function runoffGrowingAttachedContactTime(drop: RunoffBallisticBody, anchor: RunoffSupportAnchor,
  volumeAtStartM3: number, rateM3S: number, start: number, end: number,
  contactRadiusM: number, neckLengthM: number, gravity: VesselVector): number | undefined {
  if (rateM3S < 0 || volumeAtStartM3 < 0 || end < start) throw new RangeError("Invalid runoff contact interval");
  const volumeAt = (time: number) => volumeAtStartM3 + rateM3S * (time - start);
  if (volumeAt(end) <= 0) return undefined;
  const shapeAt = (time: number) => runoffAttachedGeometry(anchor.positionM, anchor.normal, volumeAt(time),
    contactRadiusM, neckLengthM);
  const stateAt = (time: number) => ballisticState(drop.originM, drop.initialVelocityMS, gravity, time - drop.birthTimeSeconds);
  const clearance = (time: number) => volumeAt(time) <= 0 ? Infinity
    : distanceToRunoffAttached(shapeAt(time), stateAt(time).positionM) - drop.radiusM;
  const distanceTolerance = 1e-10, timeTolerance = 1e-12, acceleration = Math.hypot(...gravity);
  let visits = 0;
  const visit = (lo: number, hi: number, depth: number): number | undefined => {
    if (++visits > 2048 || depth > 32) throw new Error("Runoff growing-contact search budget exceeded");
    // A 0.1 nm geometric contact tolerance avoids spending the whole bounded
    // search on a numerically tangent pair. It never moves or resizes a body.
    if (clearance(lo) <= distanceTolerance) return lo;
    const middle = (lo + hi) / 2, state = stateAt(middle), half = (hi - lo) / 2;
    const displacement = Math.hypot(...state.velocityMS) * half + acceleration * half * half / 2;
    const bound = distanceToRunoffAttached(shapeAt(hi), state.positionM) - drop.radiusM - displacement;
    if (bound > 1e-14) return undefined;
    if (hi - lo <= timeTolerance) {
      if (clearance(middle) <= distanceTolerance) return middle;
      if (clearance(hi) <= distanceTolerance) return hi;
      throw new Error("Runoff growing-contact interval is unresolved at its temporal tolerance");
    }
    const first = visit(lo, middle, depth + 1);
    return first ?? visit(middle, hi, depth + 1);
  };
  return visit(start, end, 0);
}
