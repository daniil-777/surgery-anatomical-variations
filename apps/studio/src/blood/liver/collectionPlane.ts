import type { LiverSurface } from "./types";

/** Laboratory stage clearance; an authored setup dimension, not anatomy. */
export const LIVER_COLLECTION_CLEARANCE_M = .02;

/** Shared by physical contact and the rendered stage. Keep this in SI; the
 * renderer converts the result to millimetres only at its scene boundary.
 * Using canonical extrema keeps the plane invariant under midpoint refinement
 * and wound clipping, neither of which moves the laboratory stage. */
export function liverCollectionPlaneYM(surface: Pick<LiverSurface, "positionsM">): number {
  const p = surface.positionsM;
  if (p.length < 9 || p.length % 3 !== 0)
    throw new RangeError("Collection plane requires finite metre-scale surface positions");
  let minY = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    if (![p[i], p[i + 1], p[i + 2]].every(Number.isFinite))
      throw new RangeError("Collection plane requires finite metre-scale surface positions");
    minY = Math.min(minY, p[i + 1]!);
  }
  return minY - LIVER_COLLECTION_CLEARANCE_M;
}
