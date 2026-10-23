import type { PhysicsParameters } from "../atlasPhysics";

export interface CuttingEmbeddedSurface {
  positionsMm: number[]; indices: number[]; tetIndices: number[]; weights: number[];
}

/** SI mechanics; millimetres only at geometry/UI boundaries. Fixed Mode-I plane. */
export interface CuttingReference {
  schema: "viscera.cutting-reference/v1";
  source: { templateId: string; sha256: string; attribution: string; license: string };
  positionsMm: number[];
  tets: number[];
  /** Both external and internal boundary triangles of the split cage. */
  boundaryIndices: number[];
  seamPairs: { left: number; right: number; areaM2: number }[];
  /** Oppositely wound paired faces; indices address mechanical nodes. */
  seamLeftIndices: number[];
  seamRightIndices: number[];
  /** High resolution source skin split at the same plane. No bridging faces. */
  skin: { positionsMm: number[]; indices: number[]; colors: number[];
    tetIndices: number[]; weights: number[] };
  /** Source-capsule cross-section, clipped to the mechanical interpolation cells. */
  cap?: CuttingEmbeddedSurface;
  /** Optional equivalent contact-only tessellation; never used for rendering or validity. */
  contactCap?: CuttingEmbeddedSurface;
  planeXMm: number;
  floorYMm: number;
  /** Explicit fixed fixture nodes, not a hidden force opening the organ. */
  fixedNodes: number[];
  diagnostics: { originalCageVolumeM3: number; splitVolumeM3: number; seamAreaM2: number;
    embeddingErrorMm: number; minimumTetVolumeM3: number; [key: string]: unknown };
  limitations: string[];
}
export interface CuttingMaterial { fractureEnergyJm2: number; peakTractionPa: number }
export interface ScalpelPose { tipYMm: number; centerZMm: number; active: boolean }
export interface ScalpelGeometry { halfThicknessMm: number; halfLengthMm: number; heightMm: number; halfAngleRadians: number;
  /** Z extent of the two end bevels. Omitted/zero preserves the legacy blunt ends. */
  endBevelMm?: number }
export const DEFAULT_SCALPEL: Readonly<ScalpelGeometry> = Object.freeze({
  halfThicknessMm: .6, halfLengthMm: 10, heightMm: 16, halfAngleRadians: Math.PI / 12, endBevelMm: 2.4,
});
export interface CuttingOptions { bulk: PhysicsParameters; cohesive: CuttingMaterial;
  dtSeconds?: number; iterations?: number; gravity?: boolean; scalpel?: ScalpelGeometry;
  /** Declared equilibrium large-strain law; Maxwell branch and infinitesimal moduli are unchanged. */
  equilibriumModel?: "stable-neo-hookean" | "log-neo-hookean";
  /** Legacy fixture/sample-diagnostic spacing; source-cap forces use the exact integral. */
  contactSpacingMm?: number;
  /** Optional work-conjugate capsule residual tension (Pa) released across committed damaged seam area. */
  capsuleRetractionPa?: number;
  /** Optional mixed-mode tangential coupling weight beta > 0 (default 1 = isotropic). */
  shearCouplingBeta?: number;
  /** Optional per-seam-pair toughness & strength multiplier m_i > 0 (e.g. fibrous portal tracts). */
  seamToughnessMultipliers?: ArrayLike<number> }
