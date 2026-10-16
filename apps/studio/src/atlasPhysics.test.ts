import { describe, expect, it } from "vitest";
import { physicsSurfacePositions, readPhysicsObservation, readPhysicsPlayground, readPhysicsRun, type PhysicsObservation, type PhysicsPlayground, type PhysicsRun } from "./atlasPhysics";

const spec = { template_id: "liver-reference", realized_id: "displayed-organ", seed: 42, controls: {}, appearance: "tissue" as const };
function run(): PhysicsRun {
  return { schema_version: "liver-physics-experiment-1.0.0", protocol: "indent", source: { template_id: spec.template_id, realized_id: spec.realized_id }, learning: { source: "learned" },
    parameters: { young_pa: 4800, poisson: 0.45, relaxation_fraction: 0.42, relaxation_time_s: 0.65, density_kg_m3: 1060, contact_stiffness_n_m: 300, indentation_stiffness_n_m: 20000, fracture_energy_j_m2: 20 },
    mesh: { reference_positions_mm: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], tets: [0, 1, 2, 3], surface_indices: [0, 1, 2], embedding: { tet_indices: [0], weights: [0.25, 0.25, 0.25, 0.25] }, source_vertex_count: 1, source_face_count: 0 },
    frames: [0, 1].map(time_s => ({ time_s, positions_mm: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], tool_position_mm: [0, 10, 0], tool_force_n: [0, time_s, 0], phase: "load", severed_bonds: 0 })),
    tool: { kind: "sphere", radius_mm: 8 }, metrics: { minimum_jacobian: 1, maximum_volume_error_pct: 0, inverted_elements: 0, peak_tool_force_n: 1, peak_displacement_mm: 0, residual_displacement_mm: 0, rejected_steps: 0, mean_step_ms: 1, p95_step_ms: 2, severed_bonds: 0, fracture_dissipation_j: 0, finite_state: true }, limitations: ["Synthetic fixture"] };
}
const expected = { spec, protocol: "indent" as const, parameter_source: "learned" as const, vertices: 1 };
describe("interactive physics response binding", () => {
  const playground = (): PhysicsPlayground => {
    const fixture = run();
    return { schema_version: "liver-physics-playground-1.0.0", parameters: fixture.parameters, learning: fixture.learning, source: fixture.source, mesh: fixture.mesh, room: { floor_y_mm: 0, gravity_m_s2: 9.81 }, limitations: ["Synthetic fixture"] };
  };
  it("accepts original-coordinate embedding only for the displayed organ and requested material source", () => {
    const fixture = playground(); expect(readPhysicsPlayground(fixture, expected)).toEqual(fixture);
    fixture.source.realized_id = "stale-liver"; expect(() => readPhysicsPlayground(fixture, expected)).toThrow("provenance");
    const wrongMaterial = playground(); wrongMaterial.learning.source = "manual"; expect(() => readPhysicsPlayground(wrongMaterial, expected)).toThrow();
  });
  it("rejects corrupt embedding, tetrahedron indices and nonfinite room gravity", () => {
    const embedding = playground(); embedding.mesh.embedding.weights[0] = 0.4; expect(() => readPhysicsPlayground(embedding, expected)).toThrow();
    const nodes = playground(); nodes.mesh.tets[0] = 4; expect(() => readPhysicsPlayground(nodes, expected)).toThrow();
    const room = playground(); room.room.gravity_m_s2 = NaN; expect(() => readPhysicsPlayground(room, expected)).toThrow();
  });
  it("does not apply rejected neural evidence or corrupt uncertainty intervals", () => {
    const rejected = playground(); rejected.learning.accepted_for_application = false;
    expect(() => readPhysicsPlayground(rejected, expected)).toThrow();
    const corrupt = run(); corrupt.learning.parameter_intervals_90 = { young_pa: { lower: 9000, upper: 5000 } };
    expect(() => readPhysicsRun(corrupt, expected)).toThrow();
  });
  it("requires passing, consistent selective calibration evidence when a policy is present", () => {
    const result = playground();
    result.learning.application_policy_version = "liver-sls-application-policy-test";
    result.learning.application_policy_id = "frozen-policy-test";
    result.learning.application_diagnostics = { policy_version: result.learning.application_policy_version, precision_passed: true, structured_residual_passed: true, structured_residual_conformal_p_value: .8, structured_residual_alpha: .05, unclipped_sensitivity_span_relative: { young_pa: .1 }, displayed_interval_truncated_by_prior: { young_pa: false }, recommended_next_steps: [], scope: "Synthetic test" };
    expect(readPhysicsPlayground(result, expected)).toBe(result);
    const inconsistent = structuredClone(result); inconsistent.learning.application_diagnostics!.precision_passed = false;
    expect(() => readPhysicsPlayground(inconsistent, expected)).toThrow();
    result.learning.application_diagnostics!.structured_residual_conformal_p_value = .01;
    expect(() => readPhysicsPlayground(result, expected)).toThrow();
  });
});
describe("physics lab result binding and surface transfer", () => {
  it("preserves exact source rest detail and transfers rigid motion through barycentric weights", () => {
    const result = run(); const source = [0.25, 0.27, 0.26];
    expect(Array.from(physicsSurfacePositions(source, result, result.frames[0]!))).toEqual(source.map(Math.fround));
    const translated = { ...result.frames[0]!, positions_mm: result.frames[0]!.positions_mm.map((value, index) => value + [3, -2, 1][index % 3]!) };
    expect(Array.from(physicsSurfacePositions(source, result, translated))).toEqual([3.25, -1.73, 1.26].map(Math.fround));
  });
  it("accepts a result bound to the exact displayed organ and requested experiment", () => { expect(readPhysicsRun(run(), expected).learning.source).toBe("learned"); });
  it.each(["realized_id", "template_id"])("rejects a mismatched %s before geometry rendering", key => {
    const result = run(); result.source = { ...result.source, [key]: "another-organ" };
    expect(() => readPhysicsRun(result, expected)).toThrow("provenance");
  });
  it("rejects out-of-range indices, corrupt weights and nonfinite trajectories", () => {
    const indices = run(); indices.mesh.tets[2] = 4; expect(() => readPhysicsRun(indices, expected)).toThrow();
    const weights = run(); weights.mesh.embedding.weights[0] = 0.5; expect(() => readPhysicsRun(weights, expected)).toThrow();
    const positions = run(); positions.frames[1]!.positions_mm[0] = NaN; expect(() => readPhysicsRun(positions, expected)).toThrow();
    const times = run(); times.frames[1]!.time_s = 0; expect(() => readPhysicsRun(times, expected)).toThrow();
  });
});

describe("physics observation import", () => {
  const observation = (): PhysicsObservation => {
    const times_s = Array.from({ length: 81 }, (_, index) => index * 0.075);
    return { times_s, force_n: times_s.map(time => time === 0 ? 0 : 0.01), displacement_mm: times_s.map(time => 0.5 * Math.min(Math.max(0, Math.min(1, time / 0.6)), Math.max(0, Math.min(1, (4.2 - time) / 0.6)))), reference_length_mm: 20, reference_area_mm2: 100, provenance: "Synthetic unit-test fixture, not measurement" };
  };
  it("preserves calibrated units/provenance and strips unrelated JSON keys before API submission", () => {
    const value = observation(); expect(readPhysicsObservation({ ...value, extra: "ignored" })).toEqual(value);
  });
  it("rejects unsupported timing and strain, missing provenance and nonfinite force", () => {
    const times = observation(); times.times_s[3] = 0.2; expect(() => readPhysicsObservation(times)).toThrow("0.075");
    const displacement = observation(); displacement.displacement_mm[5] = 3; expect(() => readPhysicsObservation(displacement)).toThrow("2.5%");
    const provenance = observation(); provenance.provenance = ""; expect(() => readPhysicsObservation(provenance)).toThrow("provenance");
    const force = observation(); force.force_n[5] = Infinity; expect(() => readPhysicsObservation(force)).toThrow("finite");
  });
  it("accepts varied, irregularly sampled small-strain histories only for v2", () => {
    const value = observation();
    value.times_s = Array.from({ length: 41 }, (_, index) => 8 * (index / 40) ** 1.2);
    value.force_n = value.times_s.map(time => time === 0 ? 0 : 0.01);
    value.displacement_mm = value.times_s.map(time => 0.8 * Math.max(0, 1 - Math.abs(time - 2) / 2));
    expect(readPhysicsObservation(value, "varied")).toEqual(value);
    expect(() => readPhysicsObservation(value)).toThrow("81");
    value.times_s[5] = value.times_s[4]!;
    expect(() => readPhysicsObservation(value, "varied")).toThrow("increase strictly");
  });
});
