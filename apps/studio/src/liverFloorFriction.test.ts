import { describe, expect, it } from "vitest";
import { applyFloorFriction, estimateFloorNormalReaction } from "./liverFloorFriction";

describe("floor reaction and passive Coulomb impulse", () => {
  it("uses compression at an active constraint, including gravity-free external loading", () => {
    // One node at y=0 with prediction yhat=0 has zero inertial derivative;
    // a 2 N downward tool load adds +2 N to dPhi/dy, independent of gravity.
    const reaction = estimateFloorNormalReaction(0, 2);
    expect(reaction).toBe(2);
    const loaded = applyFloorFriction(1, 0, reaction, .1, .01, .6);
    expect(loaded.vxMps).toBeCloseTo(.88, 12);
    expect(loaded.normalImpulseNs).toBe(.02);
    expect(loaded.impulseXNs).toBe(-.012);
  });

  it("does not apply a reaction in a separated near-floor band or in tension", () => {
    expect(estimateFloorNormalReaction(.0001, 100)).toBe(0);
    expect(estimateFloorNormalReaction(0, -20)).toBe(0);
    expect(estimateFloorNormalReaction(1e-10, 5)).toBe(5);
    expect(estimateFloorNormalReaction(-1e-10, 5)).toBe(5);
    expect(() => estimateFloorNormalReaction(-.001, 5)).toThrow(/feasible/);
  });

  it("saturates the friction cone during slip and reports work in joules", () => {
    const r = applyFloorFriction(3, 4, 10, 2, .1, .5);
    expect(r.vxMps).toBeCloseTo(2.85, 12);
    expect(r.vzMps).toBeCloseTo(3.8, 12);
    expect(r.impulseXNs).toBeCloseTo(-.3, 12);
    expect(r.impulseZNs).toBeCloseTo(-.4, 12);
    expect(r.frictionLimitNs).toBe(.5);
    expect(r.dissipatedEnergyJ).toBeCloseTo(2.4375, 12);
  });

  it("stops low-speed slip without reversing it or fabricating dissipation at rest", () => {
    const r = applyFloorFriction(.01, -.02, 10, 1, .1, .5);
    expect(r.vxMps).toBe(0); expect(Math.abs(r.vzMps)).toBe(0);
    expect(r.dissipatedEnergyJ).toBeCloseTo(.00025, 12);
    const still = applyFloorFriction(0, 0, 10, 1, .1, .5);
    expect(still.dissipatedEnergyJ).toBe(0);
    expect(Math.hypot(still.impulseXNs, still.impulseZNs)).toBe(0);
  });

  it("has exact zero-load and frictionless controls", () => {
    for (const [normal, coefficient] of [[0, .6], [100, 0]]) {
      const r = applyFloorFriction(2, -1, normal!, 1, .01, coefficient!);
      expect(r.vxMps).toBe(2); expect(r.vzMps).toBe(-1);
      expect(r.dissipatedEnergyJ).toBe(0);
    }
  });

  it("is tangent-rotation invariant and passive over independent mass/time/load scales", () => {
    for (const mass of [.001, .1, 2]) for (const dt of [1 / 240, 1 / 120, .1])
      for (const normal of [0, .01, 20]) for (const [vx, vz] of [[.001, 0], [3, -4], [0, 0]]) {
        const r = applyFloorFriction(vx!, vz!, normal, mass, dt, .6);
        const kineticBefore = .5 * mass * (vx! ** 2 + vz! ** 2);
        const kineticAfter = .5 * mass * (r.vxMps ** 2 + r.vzMps ** 2);
        expect(kineticAfter).toBeLessThanOrEqual(kineticBefore + 1e-12);
        expect(r.dissipatedEnergyJ).toBeGreaterThanOrEqual(0);
        expect(r.dissipatedEnergyJ).toBeCloseTo(kineticBefore - kineticAfter, 10);
        expect(Math.hypot(r.impulseXNs, r.impulseZNs)).toBeLessThanOrEqual(r.frictionLimitNs + 1e-12);
        const rotated = applyFloorFriction(.6 * vx! - .8 * vz!, .8 * vx! + .6 * vz!, normal, mass, dt, .6);
        expect(rotated.vxMps).toBeCloseTo(.6 * r.vxMps - .8 * r.vzMps, 10);
        expect(rotated.vzMps).toBeCloseTo(.8 * r.vxMps + .6 * r.vzMps, 10);
      }
  });

  it("matches constant-load sliding and stopping under timestep refinement", () => {
    for (const dt of [.01, .005]) {
      let velocity = 1, dissipated = 0;
      for (let i = 0; i < Math.round(.25 / dt); i++) {
        const r = applyFloorFriction(velocity, 0, 2, .5, dt, .5);
        velocity = r.vxMps; dissipated += r.dissipatedEnergyJ;
      }
      expect(velocity).toBeCloseTo(.5, 12);
      expect(dissipated).toBeCloseTo(.1875, 12);
    }
  });

  it("rejects invalid units/ranges and nonfinite values rather than hiding errors", () => {
    for (const args of [[NaN, 0, 1, 1, .1, .6], [0, 0, -1, 1, .1, .6], [0, 0, 1, 0, .1, .6], [0, 0, 1, 1, 0, .6], [0, 0, 1, 1, .1, -.1], [1e308, 1e308, 1, 10, .1, .6]]) {
      expect(() => applyFloorFriction(...args as [number, number, number, number, number, number])).toThrow();
    }
    expect(() => estimateFloorNormalReaction(0, Infinity)).toThrow();
    expect(() => estimateFloorNormalReaction(0, 1, -.1)).toThrow();
  });
});
