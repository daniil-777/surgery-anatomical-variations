import { describe, expect, it } from "vitest";
import type { PhysicsPlayground } from "./atlasPhysics";
import female from "./fixtures/liver-playground-female-cage.json";
import { LiverPlaygroundSolver } from "./liverPlaygroundSolver";
import { LiverMotionCapture } from "./liverMotionCapture";

function fixture() {
  const prepared: PhysicsPlayground = { schema_version: "liver-physics-playground-1.0.0", parameters: { ...female.parameters }, mesh: { ...structuredClone(female.mesh), embedding: { tet_indices: [], weights: [] }, source_vertex_count: 0, source_face_count: 0 }, source: { template_id: "female-test", realized_id: "frozen-cage-test" }, learning: { source: "manual" }, room: { floor_y_mm: 0, gravity_m_s2: 9.81 }, limitations: ["Synthetic test"] };
  const solver = new LiverPlaygroundSolver(prepared.mesh, prepared.parameters, { floorYmm: 0, gravity: false });
  const sample = { metrics: solver.metrics(), node_positions_mm: Array.from(solver.positionsMm), camera_position_mm: [400, 450, 600], camera_target_mm: [0, 60, 0], camera_fov_degrees: 38, camera_aspect: 1, tool: "grab", paused: false, gravity: false, contact: solver.interactionState() };
  return { prepared, sample };
}

describe("bounded physics motion capture", () => {
  it("retains actual timestamps and detached source/state arrays", () => {
    const { prepared, sample } = fixture(), capture = new LiverMotionCapture(prepared, 1000, "2026-10-07T00:00:00Z");
    const x = sample.node_positions_mm[0], young = prepared.parameters.young_pa;
    expect(capture.add(sample, 1000)).toBe(true);
    expect(capture.add(sample, 1020)).toBe(false);
    expect(capture.add(sample, 1042)).toBe(true);
    prepared.parameters.young_pa = 9000; sample.node_positions_mm[0] = 123;
    const result = capture.export();
    expect(result.parameters.young_pa).toBe(young); expect(result.samples[0]!.node_positions_mm[0]).toBe(x);
    expect(result.samples.map(s => s.wall_time_s)).toEqual([0, .042]);
    result.samples[0]!.node_positions_mm[0] = 999;
    expect(capture.export().samples[0]!.node_positions_mm[0]).toBe(x);
  });
  it("separates explicit resets and clock discontinuities from passive recovery", () => {
    const { prepared, sample } = fixture(), capture = new LiverMotionCapture(prepared, 0);
    sample.metrics.simulation_time_s = 2; capture.add(sample, 0);
    capture.event("reset_liver", 40, true); sample.metrics.simulation_time_s = 0; capture.add(sample, 40);
    sample.metrics.simulation_time_s = 1; capture.add(sample, 80);
    sample.metrics.simulation_time_s = 0; capture.add(sample, 120);
    expect(capture.export().samples.map(s => s.segment)).toEqual([0, 1, 1, 2]);
    expect(capture.export().events.map(e => e.action)).toEqual(["reset_liver", "simulation_clock_reset"]);
  });
  it("bounds coordinate storage and stops automatically without evicting earlier evidence", () => {
    const { prepared, sample } = fixture();
    prepared.mesh.reference_positions_mm = Array(30000).fill(0); sample.node_positions_mm = Array(30000).fill(0);
    const capture = new LiverMotionCapture(prepared, 0);
    expect(capture.sampleLimit).toBe(20);
    for (let i = 0; i < 25; i++) capture.add(sample, i * 40);
    expect(capture.count).toBe(20); expect(capture.reason).toBe("sample_limit");
    expect(capture.export().samples[0]!.wall_time_s).toBe(0);
  });
  it("refuses invalid or mismatched positions and preserves completed recording identity", () => {
    const { prepared, sample } = fixture(), capture = new LiverMotionCapture(prepared, 0);
    capture.add(sample, 0); sample.node_positions_mm[1] = NaN;
    expect(capture.add(sample, 40)).toBe(false); expect(capture.reason).toBe("invalid_state");
    capture.stop("scene_changed"); expect(capture.reason).toBe("invalid_state"); expect(capture.count).toBe(1);
    expect(capture.export().source.realized_id).toBe("frozen-cage-test");
  });
});
