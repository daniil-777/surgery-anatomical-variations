export type Vec3 = [number, number, number];
export interface OrganMesh {
  id: string;
  name: string;
  kind: string;
  positions: number[];
  indices: number[];
  normals?: number[];
  uv?: number[];
  /** Artifact-authored sRGB pigment, bound to vertex indices. */
  colors?: number[];
  color: string;
  metadata?: Record<string, unknown>;
  landmarks?: Record<string, unknown>;
}
export interface SceneData {
  snapshot?: { id: string; content_hash: string; schema_version?: string };
  schemaVersion?: string;
  spec?: Record<string, unknown>;
  organs: OrganMesh[];
  vessels?: OrganMesh[];
  metadata?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
  simulation?: {
    organ_id?: string;
    organId?: string;
    positions_mm: number[];
    tets: number[];
    pinned_nodes?: number[];
    density_kg_m3?: number;
    embedding: {
      tet_ids?: number[];
      tet_indices?: number[];
      weights: number[];
      residuals_mm?: number[];
      rest_residuals_mm?: number[];
    };
  };
}
export type EditorTool =
  | "orbit"
  | "grab"
  | "inflate"
  | "twist"
  | "smooth"
  | "probe";
export interface Appearance {
  roughness: number;
  clearcoat: number;
  opacity: number;
  wireframe: boolean;
  color: string;
}
export interface BrushStroke {
  organId: string;
  point: Vec3;
  delta: Vec3;
  normal: Vec3;
  radius: number;
  strength: number;
  tool: EditorTool;
}
export interface ViewportHandle {
  camera: (preset: "anterior" | "posterior" | "superior" | "oblique") => void;
  fit: () => void;
  exportGLB: () => Promise<ArrayBuffer>;
  screenshot: () => string;
  runProbe: () => void;
  resetSimulation: () => void;
}

export interface ProbeReport {
  time: number;
  minJacobian: number;
  maxVolumeDrift: number;
  rejectedSteps: number;
  maxDisplacementMm: number;
  recoveryResidualMm: number;
  status: "running" | "complete" | "rejected";
}
