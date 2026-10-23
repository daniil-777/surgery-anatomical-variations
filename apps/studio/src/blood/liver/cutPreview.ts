import { interceptedRadius, LIVER_MAX_WOUNDS } from "./wounds";
import type { LiverAnatomy, LiverCutRequest, LiverSurfacePick, LiverVesselSegment, LiverWound } from "./types";

/** Cut controls share these limits with `prepareLiverCut` and the renderer. */
export const LIVER_CUT_LIMITS = Object.freeze({ minRadiusM: .00075, maxRadiusM: .002, minDepthM: .00025, maxDepthM: .002, stepM: .00025 });

export type LiverCutPreviewStatus = "vessel" | "deeper" | "tissue" | "blocked";
export interface LiverCutPreview {
  status: LiverCutPreviewStatus;
  /** Why the site is blocked (overlap or wound limit). */
  reason?: string;
  /** Vessel the cut opens at the current settings, or would open at `suggestedDepthM`. */
  vesselId: string | null;
  segment: LiverVesselSegment | null;
  /** Predicted hydraulic aperture at the current settings (0 when no vessel is reached). */
  apertureRadiusM: number;
  /** Smallest depth that reaches a vessel at the current radius, within the supported range. */
  minimumDepthM: number | null;
  /** `minimumDepthM` rounded up to the slider step and checked to hit. */
  suggestedDepthM: number | null;
  /** Lateral distance from the site to the nearest vessel wall in the tangent plane, when none is reachable. */
  nearestVesselOffsetM: number | null;
}

type V = readonly [number, number, number];
const sub = (a: V, b: V): [number, number, number] => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function pointSegmentDistance(p: V, a: V, b: V): number {
  const ab = sub(b, a), ap = sub(p, a), length2 = dot(ab, ab);
  const t = length2 > 0 ? Math.min(1, Math.max(0, dot(ap, ab) / length2)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}
/** Distance in the tangent plane of `normal` from `p` to the segment's projection. */
function tangentDistance(p: V, normal: V, a: V, b: V): number {
  const project = (q: V): V => { const d = sub(q, p), z = dot(d, normal); return [d[0] - normal[0] * z, d[1] - normal[1] * z, d[2] - normal[2] * z]; };
  return pointSegmentDistance([0, 0, 0], project(a), project(b));
}

/**
 * Predicts what a cut at `pick` would do, cheaply enough to run on hover.
 *
 * The vessel intersection is the same capsule/capped-cylinder test that
 * `prepareLiverCut` commits with, so a "vessel" preview reaches the same vessel.
 * The polygon-clipping checks (curvature, open boundary, second capsule sheet)
 * are deliberately not repeated per pointer move; they can still reject a site
 * on commit, and the UI says so.
 */
export function previewLiverCut(anatomy: LiverAnatomy, wounds: readonly LiverWound[], pick: LiverSurfacePick, radiusM: number, depthM: number): LiverCutPreview {
  const none = { vesselId: null, segment: null, apertureRadiusM: 0, minimumDepthM: null, suggestedDepthM: null, nearestVesselOffsetM: null };
  if (wounds.length >= LIVER_MAX_WOUNDS) return { status: "blocked", reason: "Three incisions made. Reset to cut again.", ...none };
  if (wounds.some(w => Math.hypot(...sub(w.pick.positionM, pick.positionM)) <= w.radiusM + radiusM + 1e-7))
    return { status: "blocked", reason: "Overlaps an existing incision.", ...none };
  const reach = Math.hypot(radiusM, LIVER_CUT_LIMITS.maxDepthM);
  // Any intersected tube point lies inside the deepest punch cylinder, which lies within `reach` of the site.
  const candidates = anatomy.vessels.filter(s => pointSegmentDistance(pick.positionM, s.aM, s.bM) - Math.max(s.radiusAM, s.radiusBM) <= reach + 1e-9);
  const request = (depth: number): LiverCutRequest => ({ pick, radiusM, depthM: depth, timeSeconds: 0 });
  const best = (depth: number) => {
    let segment: LiverVesselSegment | null = null, aperture = 0;
    for (const s of candidates) { const r = interceptedRadius(s, request(depth)); if (r > aperture) { aperture = r; segment = s; } }
    return { segment, aperture };
  };
  const now = best(depthM);
  if (now.segment) return { ...none, status: "vessel", vesselId: now.segment.id, segment: now.segment, apertureRadiusM: now.aperture };
  const deepest = best(LIVER_CUT_LIMITS.maxDepthM);
  if (deepest.segment) {
    let lo = depthM, hi: number = LIVER_CUT_LIMITS.maxDepthM;
    for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (best(mid).segment) hi = mid; else lo = mid; }
    let suggested: number = Math.min(LIVER_CUT_LIMITS.maxDepthM, Math.ceil((hi - 1e-12) / LIVER_CUT_LIMITS.stepM) * LIVER_CUT_LIMITS.stepM);
    while (!best(suggested).segment && suggested < LIVER_CUT_LIMITS.maxDepthM) suggested = Math.min(LIVER_CUT_LIMITS.maxDepthM, suggested + LIVER_CUT_LIMITS.stepM);
    const at = best(suggested);
    return { ...none, status: "deeper", vesselId: at.segment?.id ?? deepest.segment.id, segment: at.segment ?? deepest.segment, minimumDepthM: hi, suggestedDepthM: suggested };
  }
  let nearest = Infinity;
  for (const s of anatomy.vessels) {
    if (dot(s.normal, pick.normal) < .35) continue; // Same orientation gate as the commit test.
    nearest = Math.min(nearest, tangentDistance(pick.positionM, pick.normal, s.aM, s.bM) - Math.max(s.radiusAM, s.radiusBM) - radiusM);
  }
  return { ...none, status: "tissue", nearestVesselOffsetM: Number.isFinite(nearest) ? Math.max(0, nearest) : null };
}
