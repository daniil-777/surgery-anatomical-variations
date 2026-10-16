import type { AtlasSpec } from "./atlas";

export type PhysicsProtocol = "indent" | "grasp" | "cut";
export type PhysicsSource = "learned" | "manual";
export const PHYSICS_SCHEMA_VERSION = "liver-physics-experiment-1.0.0";
export interface PhysicsObservation {
  times_s: number[];
  force_n: number[];
  displacement_mm: number[];
  reference_length_mm: number;
  reference_area_mm2: number;
  provenance: string;
}
export interface PhysicsParameters {
  young_pa: number;
  poisson: number;
  relaxation_fraction: number;
  relaxation_time_s: number;
  density_kg_m3: number;
  contact_stiffness_n_m: number;
  indentation_stiffness_n_m: number;
  fracture_energy_j_m2: number;
}
export interface PhysicsStatus {
  status: "ready" | "unavailable";
  model_id?: string;
  model_version?: string;
  scope?: string;
  application_policy?: { version: string; id: string; scope: string; checks: string[] } | null;
  defaults: PhysicsParameters;
}
export interface PhysicsApplicationDiagnostics {
  policy_version: string;
  precision_passed: boolean;
  structured_residual_passed: boolean;
  structured_residual_conformal_p_value: number;
  structured_residual_alpha: number;
  unclipped_sensitivity_span_relative: Record<string, number>;
  displayed_interval_truncated_by_prior: Record<string, boolean>;
  recommended_next_steps: string[];
  scope: string;
}
export interface PhysicsFrame {
  time_s: number;
  positions_mm: number[];
  tool_position_mm: number[];
  tool_force_n: number[];
  phase: string;
  active_surface_indices?: number[];
  severed_bonds: number;
}
export interface PhysicsRun {
  schema_version: string;
  protocol: PhysicsProtocol;
  parameters: PhysicsParameters;
  mesh: {
    reference_positions_mm: number[];
    tets: number[];
    surface_indices: number[];
    embedding: { tet_indices: number[]; weights: number[] };
    source_vertex_count: number;
    source_face_count: number;
  };
  tool: { kind: "sphere" | "grasper" | "blade"; radius_mm: number };
  frames: PhysicsFrame[];
  metrics: {
    minimum_jacobian: number;
    maximum_volume_error_pct: number;
    inverted_elements: number;
    peak_tool_force_n: number;
    peak_displacement_mm: number;
    residual_displacement_mm: number;
    rejected_steps: number;
    unconverged_steps?: number;
    numerical_status?: "PASS" | "NEEDS_REFINEMENT";
    maximum_seam_opening_mm?: number;
    maximum_contact_penetration_mm?: number;
    maximum_mean_contact_penetration_mm?: number;
    loaded_contact_gap_frames?: number;
    mean_step_ms: number;
    p95_step_ms: number;
    severed_bonds: number;
    fracture_dissipation_j: number;
    finite_state: boolean;
  };
  learning: { source: PhysicsSource; model_id?: string; version?: string; scope?: string; predicted_parameters?: Partial<PhysicsParameters>; ensemble_std?: Partial<PhysicsParameters>; observation_origin?: string; observation_provenance?: string; stress_nrmse?: number; accepted_for_application?: boolean; parameter_intervals_90?: Partial<Record<keyof PhysicsParameters, { lower: number; upper: number }>>; uncertainty_scope?: string; application_policy_version?: string; application_policy_id?: string; application_diagnostics?: PhysicsApplicationDiagnostics };
  source: { template_id: string; realized_id?: string };
  limitations: string[];
  [key: string]: unknown;
}
export interface PhysicsPlayground {
  schema_version: "liver-physics-playground-1.0.0";
  parameters: PhysicsParameters;
  learning: PhysicsRun["learning"];
  source: PhysicsRun["source"];
  mesh: PhysicsRun["mesh"];
  room: { floor_y_mm: number; gravity_m_s2: number };
  simulation?: Record<string, unknown>;
  limitations: string[];
  mass_kg?: number;
}
export const physicsParameterFields: { key: keyof PhysicsParameters; label: string; unit: string; min: number; max: number; step: number }[] = [
  { key: "young_pa", label: "Young’s modulus", unit: "Pa", min: 500, max: 20000, step: 100 },
  { key: "poisson", label: "Poisson ratio", unit: "", min: 0.2, max: 0.48, step: 0.001 },
  { key: "relaxation_fraction", label: "Relaxation fraction", unit: "", min: 0.05, max: 0.75, step: 0.01 },
  { key: "relaxation_time_s", label: "Relaxation time", unit: "s", min: 0.05, max: 2, step: 0.05 },
  { key: "density_kg_m3", label: "Density", unit: "kg/m³", min: 900, max: 1200, step: 10 },
  { key: "contact_stiffness_n_m", label: "Grasp attachment stiffness", unit: "N/m", min: 20, max: 2000, step: 10 },
  { key: "indentation_stiffness_n_m", label: "Probe contact stiffness", unit: "N/m", min: 1000, max: 100000, step: 1000 },
  { key: "fracture_energy_j_m2", label: "Fracture energy", unit: "J/m²", min: 1, max: 200, step: 1 },
];
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const vector = (value: unknown, multiple: number): value is number[] => Array.isArray(value) && value.length > 0 && value.length % multiple === 0 && value.every(finite);
const indices = (value: unknown, multiple: number, limit: number): value is number[] => vector(value, multiple) && value.every(index => Number.isInteger(index) && index >= 0 && index < limit);
const parameters = (value: unknown): value is PhysicsParameters => object(value) && physicsParameterFields.every(field => finite(value[field.key]));
const learningEvidence = (value: Record<string, unknown>): boolean => {
  if (value.accepted_for_application !== undefined && value.accepted_for_application !== true) return false;
  if (value.application_policy_version !== undefined) {
    const diagnostic = value.application_diagnostics;
    if (typeof value.application_policy_version !== "string" || !value.application_policy_version || typeof value.application_policy_id !== "string" || !value.application_policy_id || !object(diagnostic) || diagnostic.policy_version !== value.application_policy_version || diagnostic.precision_passed !== true || diagnostic.structured_residual_passed !== true || !finite(diagnostic.structured_residual_conformal_p_value) || diagnostic.structured_residual_conformal_p_value > 1 || !finite(diagnostic.structured_residual_alpha) || diagnostic.structured_residual_alpha <= 0 || diagnostic.structured_residual_alpha >= 1 || diagnostic.structured_residual_conformal_p_value <= diagnostic.structured_residual_alpha) return false;
  }
  if (value.parameter_intervals_90 !== undefined) {
    if (!object(value.parameter_intervals_90)) return false;
    for (const [key, interval] of Object.entries(value.parameter_intervals_90)) {
      const field = physicsParameterFields.find(item => item.key === key);
      if (!field || !object(interval) || !finite(interval.lower) || !finite(interval.upper) || interval.lower > interval.upper || interval.lower < field.min - 1e-8 * Math.max(1, field.min) || interval.upper > field.max + 1e-8 * Math.max(1, field.max)) return false;
    }
  }
  return true;
};

export function readPhysicsStatus(value: unknown): PhysicsStatus {
  if (!object(value) || !["ready", "unavailable"].includes(String(value.status)) || !parameters(value.defaults)) throw new Error("The physics service returned an unsupported status.");
  if (value.application_policy !== undefined && value.application_policy !== null) {
    const policy = value.application_policy;
    if (!object(policy) || typeof policy.version !== "string" || !policy.version || typeof policy.id !== "string" || !policy.id || typeof policy.scope !== "string" || !Array.isArray(policy.checks) || !policy.checks.every(check => typeof check === "string")) throw new Error("The physics service returned an unsupported calibration policy.");
  }
  return value as unknown as PhysicsStatus;
}

export function readPhysicsPlayground(value: unknown, expected: { spec: AtlasSpec; parameter_source: PhysicsSource; vertices: number }): PhysicsPlayground {
  const fail = () => { throw new Error("The hands-on scene returned invalid material, geometry or displayed-organ provenance."); };
  if (!object(value) || value.schema_version !== "liver-physics-playground-1.0.0" || !parameters(value.parameters) ||
      !object(value.learning) || value.learning.source !== expected.parameter_source || !learningEvidence(value.learning) || !object(value.source) || value.source.template_id !== expected.spec.template_id ||
      (expected.spec.realized_id !== undefined && value.source.realized_id !== expected.spec.realized_id) || !object(value.mesh) || !object(value.room) ||
      !finite(value.room.floor_y_mm) || !finite(value.room.gravity_m_s2) || value.room.gravity_m_s2 < 0 || value.room.gravity_m_s2 > 30 ||
      !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === "string")) return fail();
  const mesh = value.mesh;
  if (!vector(mesh.reference_positions_mm, 3) || mesh.reference_positions_mm.length > 900000 || mesh.reference_positions_mm.some(v => Math.abs(v) > 100000) ||
      mesh.source_vertex_count !== expected.vertices || !object(mesh.embedding)) return fail();
  const nodes = mesh.reference_positions_mm.length / 3;
  if (!indices(mesh.tets, 4, nodes) || !indices(mesh.surface_indices, 3, nodes) || !indices(mesh.embedding.tet_indices, 1, mesh.tets.length / 4) ||
      mesh.embedding.tet_indices.length !== expected.vertices || !vector(mesh.embedding.weights, 4) || mesh.embedding.weights.length !== expected.vertices * 4) return fail();
  for (let vertex = 0; vertex < expected.vertices; vertex++) {
    const weights = mesh.embedding.weights.slice(vertex * 4, vertex * 4 + 4);
    if (Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 0.001 || weights.some(w => Math.abs(w) > 100)) return fail();
  }
  return value as unknown as PhysicsPlayground;
}

/** Versioned calibration contract. Constitutive fit/identifiability is assessed by the API. */
export function readPhysicsObservation(value: unknown, protocol: "standard" | "varied" = "standard"): PhysicsObservation {
  if (!object(value) || !vector(value.times_s, 1) || !vector(value.force_n, 1) || !vector(value.displacement_mm, 1) ||
      value.times_s.length < 16 || value.times_s.length > 257 || value.force_n.length !== value.times_s.length || value.displacement_mm.length !== value.times_s.length || (protocol === "standard" && value.times_s.length !== 81))
    throw new Error(`Calibration needs ${protocol === "standard" ? "81" : "16–257 matching"} finite samples in times_s, force_n and displacement_mm.`);
  if (!finite(value.reference_length_mm) || value.reference_length_mm <= 0 || value.reference_length_mm > 1000 ||
      !finite(value.reference_area_mm2) || value.reference_area_mm2 <= 0 || value.reference_area_mm2 > 1e6)
    throw new Error("Supply positive calibrated reference_length_mm (≤1000) and reference_area_mm2 (≤1000000).");
  if (typeof value.provenance !== "string" || value.provenance.trim().length < 8 || value.provenance.length > 2000)
    throw new Error("Calibration provenance must describe the measurement source in 8–2000 characters.");
  if (protocol === "varied") {
    const times = value.times_s;
    if (times[0] !== 0 || times.at(-1)! < 1 || times.at(-1)! > 12 || times.some((time, index) => index > 0 && time <= times[index - 1]!))
      throw new Error("Calibration times must increase strictly from zero, with a duration of 1–12 seconds.");
    if (times.some((time, index) => index > 0 && time - times[index - 1]! > 0.2 * times.at(-1)!))
      throw new Error("Calibration time gaps must not exceed 20% of the observation duration.");
    const strain = value.displacement_mm.map(displacement => displacement / (value.reference_length_mm as number));
    const peak = Math.max(...strain);
    if (Math.abs(strain[0]!) > 2e-5 || peak < 0.005 || peak > 0.050001 || Math.min(...strain) < -0.001)
      throw new Error("Unsupported loading: start at zero strain, with peak small strain between 0.5% and 5%.");
  } else for (let index = 0; index < 81; index++) {
    const time = index * 0.075;
    if (Math.abs(value.times_s[index]! - time) > 1e-6) throw new Error("Calibration times must use 0–6 seconds in 0.075-second steps.");
    const strain = 0.025 * Math.min(Math.max(0, Math.min(1, time / 0.6)), Math.max(0, Math.min(1, (4.2 - time) / 0.6)));
    if (Math.abs(value.displacement_mm[index]! / value.reference_length_mm - strain) > 2e-5)
      throw new Error("Unsupported loading: use the documented 2.5% uniaxial ramp, hold and release protocol.");
  }
  if (Math.max(...value.force_n) <= 0 || Math.abs(value.force_n[0]!) > Math.max((protocol === "varied" ? 0.1 : 0.05) * value.reference_area_mm2 * 1e-6, (protocol === "varied" ? 0.05 : 0.02) * Math.max(...value.force_n.map(Math.abs))))
    throw new Error("Calibration must start with tared force and contain a positive loading response.");
  return { times_s: value.times_s, force_n: value.force_n, displacement_mm: value.displacement_mm, reference_length_mm: value.reference_length_mm, reference_area_mm2: value.reference_area_mm2, provenance: value.provenance.trim() };
}

/** Reject corrupt or misbound simulation data before it reaches GPU buffers. */
export function readPhysicsRun(value: unknown, expected: { spec: AtlasSpec; protocol: PhysicsProtocol; parameter_source: PhysicsSource; vertices: number }): PhysicsRun {
  const fail = () => { throw new Error("The physics run returned invalid geometry, metrics or provenance. No result was applied."); };
  if (!object(value) || value.schema_version !== PHYSICS_SCHEMA_VERSION || value.protocol !== expected.protocol || !parameters(value.parameters) ||
      !object(value.source) || value.source.template_id !== expected.spec.template_id ||
      (expected.spec.realized_id !== undefined && value.source.realized_id !== expected.spec.realized_id) ||
      !object(value.learning) || value.learning.source !== expected.parameter_source || !learningEvidence(value.learning) || !Array.isArray(value.limitations) || !value.limitations.every(item => typeof item === "string") ||
      !object(value.mesh) || !object(value.tool) || !["sphere", "grasper", "blade"].includes(String(value.tool.kind)) || !finite(value.tool.radius_mm) || value.tool.radius_mm <= 0 ||
      !Array.isArray(value.frames) || value.frames.length < 2 || value.frames.length > 1000 || !object(value.metrics)) return fail();
  const mesh = value.mesh;
  if (!vector(mesh.reference_positions_mm, 3) || mesh.reference_positions_mm.length > 900000 || mesh.reference_positions_mm.some(value => Math.abs(value) > 100000) || !object(mesh.embedding) || mesh.source_vertex_count !== expected.vertices) return fail();
  const nodes = mesh.reference_positions_mm.length / 3;
  if (!indices(mesh.tets, 4, nodes) || !indices(mesh.surface_indices, 3, nodes) || !indices(mesh.embedding.tet_indices, 1, mesh.tets.length / 4) ||
      mesh.embedding.tet_indices.length !== expected.vertices || !vector(mesh.embedding.weights, 4) || mesh.embedding.weights.length !== expected.vertices * 4) return fail();
  for (let i = 0; i < expected.vertices; i++) {
    const weights = mesh.embedding.weights.slice(i * 4, i * 4 + 4);
    if (Math.abs(weights.reduce((a, b) => a + b, 0) - 1) > 0.001 || weights.some(weight => Math.abs(weight) > 100)) return fail();
  }
  let previousTime = -1;
  for (const frame of value.frames) {
    if (!object(frame) || !finite(frame.time_s) || frame.time_s < 0 || frame.time_s <= previousTime || !vector(frame.positions_mm, 3) || frame.positions_mm.length !== nodes * 3 || frame.positions_mm.some(value => Math.abs(value) > 100000) ||
        !vector(frame.tool_position_mm, 3) || frame.tool_position_mm.length !== 3 || !vector(frame.tool_force_n, 3) || frame.tool_force_n.length !== 3 || typeof frame.phase !== "string" ||
        !finite(frame.severed_bonds) || (frame.active_surface_indices !== undefined && !indices(frame.active_surface_indices, 3, nodes))) return fail();
    previousTime = frame.time_s;
  }
  for (const key of ["minimum_jacobian", "maximum_volume_error_pct", "inverted_elements", "peak_tool_force_n", "peak_displacement_mm", "residual_displacement_mm", "rejected_steps", "mean_step_ms", "p95_step_ms", "severed_bonds", "fracture_dissipation_j"]) {
    if (!finite(value.metrics[key])) return fail();
  }
  if (typeof value.metrics.finite_state !== "boolean") return fail();
  for (const key of ["unconverged_steps", "maximum_seam_opening_mm", "maximum_contact_penetration_mm", "maximum_mean_contact_penetration_mm", "loaded_contact_gap_frames"]) if (value.metrics[key] !== undefined && !finite(value.metrics[key])) return fail();
  if (value.learning.stress_nrmse !== undefined && !finite(value.learning.stress_nrmse)) return fail();
  if (value.learning.observation_provenance !== undefined && typeof value.learning.observation_provenance !== "string") return fail();
  return value as unknown as PhysicsRun;
}

export const forceMagnitude = (frame: PhysicsFrame) => Math.hypot(...frame.tool_force_n);

/** Add simulated displacement to the exact displayed surface, preserving rest detail. */
export function physicsSurfacePositions(rest: readonly number[], run: PhysicsRun, frame: PhysicsFrame): Float32Array {
  const result = new Float32Array(rest);
  const { tets, reference_positions_mm: reference, embedding } = run.mesh;
  for (let vertex = 0; vertex < rest.length / 3; vertex++) {
    const tetOffset = embedding.tet_indices[vertex]! * 4;
    for (let corner = 0; corner < 4; corner++) {
      const nodeOffset = tets[tetOffset + corner]! * 3;
      const weight = embedding.weights[vertex * 4 + corner]!;
      for (let axis = 0; axis < 3; axis++) result[vertex * 3 + axis]! += weight * (frame.positions_mm[nodeOffset + axis]! - reference[nodeOffset + axis]!);
    }
  }
  return result;
}
