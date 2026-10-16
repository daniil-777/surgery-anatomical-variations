interface Point3 { x: number; y: number; z: number }
interface Bounds3 { min: Point3; max: Point3 }
const axes = ["x", "y", "z"] as const;

/** Conservative broad phase for a CURRENT capsule, not a swept moving capsule.
 * Expanding a box by the radius contains its Euclidean sphere offset. A segment
 * missing that expanded box therefore cannot touch any triangle inside it.
 * False positives at rounded corners are deliberately left to triangle queries.
 */
export function toolCapsuleMayMeetBounds(start: Point3, end: Point3, radiusMm: number, bounds: Bounds3): boolean {
  if (!Number.isFinite(radiusMm) || radiusMm < 0) return true;
  for (const axis of axes) if (!Number.isFinite(start[axis]) || !Number.isFinite(end[axis]) || !Number.isFinite(bounds.min[axis]) || !Number.isFinite(bounds.max[axis]) || bounds.min[axis] > bounds.max[axis]) return true;
  const padding = radiusMm + 1e-5; // Match the narrow-phase capsule contact tolerance.
  let enter = 0, leave = 1;
  for (const axis of axes) {
    const a = start[axis], b = end[axis], low = bounds.min[axis] - padding, high = bounds.max[axis] + padding;
    const direction = b - a;
    if (!Number.isFinite(low) || !Number.isFinite(high) || !Number.isFinite(direction)) return true;
    if (direction === 0) { if (a < low || a > high) return false; continue; }
    const t0 = (low - a) / direction, t1 = (high - a) / direction;
    enter = Math.max(enter, Math.min(t0, t1)); leave = Math.min(leave, Math.max(t0, t1));
    if (enter > leave) return false;
  }
  return true;
}
