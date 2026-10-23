import type { OrganMesh } from "@viscera/render";
import type { AtlasVesselNetwork } from "../../atlasVessels";
import type { JetBreakupSnapshot } from "../experiments/jetBreakup";
import type { CardiovascularSnapshot } from "../experiments/cardiovascular";
import type { VesselSnapshot, VesselLandingEvent } from "../experiments/vesselSolver";
import type { LiverRunoffSnapshot } from "./runoff";
import type { DryCollectorSnapshot } from "./dryCollector";

/** Simulation and interaction coordinates are metres; renderers may convert once. */
export type LiverVec3 = [number, number, number];
export interface LiverSurface {
  positionsM: Float64Array;
  normals: Float32Array;
  indices: Uint32Array;
}
export interface LiverVesselSegment {
  id: string;
  aM: LiverVec3;
  bM: LiverVec3;
  normal: LiverVec3;
  radiusAM: number;
  radiusBM: number;
  depthM: number;
  aTriangle: number;
  bTriangle: number;
}
export interface LiverSurfacePick {
  triangle: number;
  positionM: LiverVec3;
  normal: LiverVec3;
  barycentric: LiverVec3;
}
export interface LiverTarget {
  id: string;
  label: string;
  vesselId: string;
  pick: LiverSurfacePick;
}
export interface LiverAnatomy {
  surface: LiverSurface;
  /** Original capsule in mm, retained for existing liver material installers. */
  organ: OrganMesh;
  network: AtlasVesselNetwork;
  vessels: LiverVesselSegment[];
  targets: LiverTarget[];
  sourceTriangleIndices?: Uint32Array;
  sourceVertexIndices?: Uint32Array;
  /** Refined vertices have a source face and barycentrics, not an original
   * source vertex ID. Source-face ordering matches sourceTriangleIndices. */
  sourceVertexTriangles?: Uint32Array;
  sourceVertexBarycentrics?: Float64Array;
  refinement?: {
    level: 1;
    baseVertexCount: number;
    baseTriangleCount: number;
    /** One base capsule face per refined face. */
    parentTriangles: Uint32Array;
    /** One base capsule face and three barycentrics per refined vertex. */
    vertexParentTriangles: Uint32Array;
    vertexParentBarycentrics: Float64Array;
  };
  provenance: {
    templateId: string; label: string; source: string; license: string; attribution?: string;
    vascularModel: "procedural-surface-design-not-patient-vasculature";
    detail: string;
  };
}
export interface LiverCutRequest {
  pick: LiverSurfacePick;
  radiusM: number;
  depthM: number;
  timeSeconds: number;
}
export interface LiverWound extends LiverCutRequest {
  id: string;
  vesselId: string | null;
  /** Hydraulic aperture is bounded by the intercepted vessel's radius. */
  apertureRadiusM: number;
}
export interface LiverCutResult {
  accepted: boolean;
  outcome: "vessel-hit" | "tissue-only" | "duplicate" | "invalid";
  reason?: string;
  wound?: LiverWound;
}
export interface LiverCutGeometry {
  surface: LiverSurface;
  cavity: LiverSurface;
  removedAreaM2: number;
  /** Canonical source face and barycentrics for each retained surface vertex. */
  sourceTriangles: Uint32Array;
  sourceBarycentrics: Float64Array;
}
export interface LiverFilmSnapshot {
  timeSeconds: number;
  /** One thickness per original capsule vertex, with physical dual areas. */
  depthM: Float64Array;
  vertexAreaM2: Float64Array;
  inputVolumeM3: number;
  filmVolumeM3: number;
  escapedVolumeM3: number;
  volumeErrorM3: number;
  maxDepthM: number;
  /** Accepted transport outflow, owned by the explicit runoff boundary when enabled. */
  drainageEvents?: readonly LiverDrainageEvent[];
}
export interface LiverDrainageEvent {
  id: number;
  stepIndex: number;
  sourceVertex: number;
  startTimeSeconds: number;
  endTimeSeconds: number;
  volumeM3: number;
  positionM: LiverVec3;
  normal: LiverVec3;
}
export interface LiverFlowSnapshot {
  timeSeconds: number;
  stepIndex: number;
  wounds: LiverWound[];
  vessel: VesselSnapshot;
  cardiovascular: CardiovascularSnapshot;
  breakup: JetBreakupSnapshot;
  film: LiverFilmSnapshot;
  runoff: LiverRunoffSnapshot;
  collector: DryCollectorSnapshot;
  /** A detected organ return waiting for the next accepted film boundary. */
  pendingReturnVolumeM3: number;
  pendingReturnEvents: (VesselLandingEvent & { detectedTimeSeconds: number })[];
  /** Blood outside the finite collection apparatus, never a hidden drain. */
  terminalEscapeVolumeM3: number;
  initialInventoryM3: number;
  coupledVolumeErrorM3: number;
}
export interface LiverAppearance {
  illumination: "camera" | "studio" | "operating";
  exposureEV: number;
  vesselGuide: boolean;
  oxygenationFraction: number;
}
