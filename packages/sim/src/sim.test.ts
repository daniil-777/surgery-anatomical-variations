import { describe, it, expect } from "vitest";
import {
  TetPreview,
  effectiveWeights,
  embeddedPositionsMm,
  type TetModel,
} from "./index";
const model: TetModel = {
  positions_mm: [0, 0, 0, 40, 0, 0, 0, 40, 0, 0, 0, 40],
  tets: [0, 1, 2, 3],
};

describe("SI tetrahedral interaction model", () => {
  it("preserves free rigid translation with internal damping enabled", () => {
    const sim = new TetPreview(model, { dampingRatio: 0.2 });
    for (let i = 0; i < 4; i++) {
      sim.velocities[i * 3] = 0.1;
      sim.velocities[i * 3 + 1] = -0.2;
      sim.velocities[i * 3 + 2] = 0.05;
    }
    for (let step = 0; step < 20; step++) expect(sim.step()).toBe(true);
    expect(sim.metrics().volumeDrift).toBeCloseTo(0, 9);
    for (let i = 0; i < 4; i++)
      expect(sim.velocities[i * 3]).toBeCloseTo(0.1, 9);
  });
  it("uniform gravity accelerates center of mass without false stiffness damping", () => {
    const sim = new TetPreview(model, { gravity: [0, 0, -9.81] });
    for (let step = 0; step < 12; step++) sim.step();
    expect(sim.velocities[2]).toBeCloseTo(-0.981, 7);
    expect(sim.metrics().minJacobian).toBeCloseTo(1, 7);
  });
  it("rejects bad topology and restores immutable snapshots", () => {
    expect(() => new TetPreview({ ...model, tets: [0, 2, 1, 3] })).toThrow();
    const sim = new TetPreview(model);
    const snapshot = sim.snapshot();
    sim.velocities[0] = 0.1;
    sim.step();
    sim.restore(snapshot);
    expect(Array.from(sim.positions)).toEqual(snapshot.positions);
  });
  it("affine residual embedding reproduces stretch", () => {
    const mapping = {
      tet_ids: [0],
      weights: [0.25, 0.25, 0.25, 0.25],
      residuals_mm: [1, 2, 3],
    };
    const weights = effectiveWeights(model, mapping);
    const x = Float64Array.from(model.positions_mm, (v) => v * 0.001 * 2);
    expect(Array.from(embeddedPositionsMm(model, [0], weights, x))).toEqual([
      22, 24, 26,
    ]);
  });
  it("responds to a local displacement while preserving positive volume", () => {
    const sim = new TetPreview({ ...model, pinned_nodes: [0, 1, 2] });
    sim.grab([0, 0, 40], 20, [0, 0, -3]);
    for (let i = 0; i < 30; i++) sim.step();
    expect(sim.positions[11]).toBeLessThan(0.04);
    expect(sim.metrics().minJacobian).toBeGreaterThan(0.85);
    sim.release();
    for (let i = 0; i < 120; i++) sim.step();
    expect(Math.abs(sim.positions[11]! - 0.04)).toBeLessThan(0.001);
  });
  it("replays an active interaction and rejection history exactly", () => {
    const sim = new TetPreview({ ...model, pinned_nodes: [0, 1, 2] });
    sim.grab([0, 0, 40], 20, [0, 0, -3]);
    for (let i = 0; i < 8; i++) sim.step();
    sim.rejectedSteps = 2;
    const saved = JSON.parse(JSON.stringify(sim.snapshot()));
    for (let i = 0; i < 12; i++) sim.step();
    const expected = sim.snapshot();
    sim.release();
    sim.reset();
    sim.restore(saved);
    for (let i = 0; i < 12; i++) sim.step();
    expect(sim.snapshot()).toEqual(expected);
  });
  it("rejects mismatched models and moved supports atomically", () => {
    const sim = new TetPreview({ ...model, pinned_nodes: [0] });
    const before = sim.snapshot();
    const other = new TetPreview(
      { ...model, pinned_nodes: [0] },
      { youngPa: 8000 },
    );
    expect(() => sim.restore(other.snapshot())).toThrow("Incompatible state");
    const moved = sim.snapshot();
    moved.positions[0] = 0.001;
    expect(() => sim.restore(moved)).toThrow("fixed attachments");
    expect(sim.snapshot()).toEqual(before);
  });
  it("copies caller options and rejects non-finite derived state", () => {
    const gravity: [number, number, number] = [0, 0, 0];
    const sim = new TetPreview(model, { gravity });
    gravity[2] = -9.81;
    expect(sim.options.gravity[2]).toBe(0);
    expect(
      () => new TetPreview(model, { youngPa: Number.MAX_VALUE }),
    ).toThrow();
    // Extreme finite coefficients can overflow the damping calculation. A failed
    // step must never publish NaN velocities or advance physical time.
    const extreme = new TetPreview(
      { ...model, density_kg_m3: 1e308 },
      { youngPa: 1e100 },
    );
    const state = extreme.snapshot();
    expect(extreme.step()).toBe(false);
    expect(Array.from(extreme.positions)).toEqual(state.positions);
    expect(Array.from(extreme.velocities)).toEqual(state.velocities);
    expect(extreme.time).toBe(0);
    expect(extreme.rejectedSteps).toBe(1);
  });
});
