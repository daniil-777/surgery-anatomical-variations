import { describe, expect, it } from "vitest";
import { DEFAULT_EXPERIMENT_APPEARANCE, dielectricF0, relativeCameraLightPower, resolveAppearance, vesselWallMapData } from "./appearance";

describe("experimental appearance remains physically separate from state", () => {
  it("validates controls atomically and preserves the original settings", () => {
    const original = { ...DEFAULT_EXPERIMENT_APPEARANCE }, before = { ...original };
    for (const bad of [{ exposureEV: NaN }, { exposureEV: 3 }, { oxygenationFraction: -1 }, { oxygenationFraction: 1.01 }])
      expect(() => resolveAppearance(original, bad)).toThrow();
    expect(original).toEqual(before);
    expect(resolveAppearance(original, { illumination: "studio", exposureEV: -1 }).illumination).toBe("studio");
  });
  it("normalizes inverse-square power consistently for metre inputs in a millimetre scene", () => {
    expect(relativeCameraLightPower(.1, 1)).toBe(10_000);
    expect(relativeCameraLightPower(.2, 1) / relativeCameraLightPower(.1, 1)).toBe(4);
    expect(() => relativeCameraLightPower(0)).toThrow();
    expect(dielectricF0(1.35)).toBeCloseTo(.022181982797646, 12);
  });
  it("generates deterministic structured maps with distinct inner and outer layers", () => {
    const a = vesselWallMapData({ layer: "adventitia", size: 64, seed: 42 });
    const b = vesselWallMapData({ layer: "adventitia", size: 64, seed: 42 });
    const changed = vesselWallMapData({ layer: "adventitia", size: 64, seed: 43 });
    const inner = vesselWallMapData({ layer: "intima", size: 64, seed: 42 });
    expect(a.colour).toEqual(b.colour); expect(a.normal).toEqual(b.normal); expect(a.roughness).toEqual(b.roughness);
    expect(a.normal).not.toEqual(changed.normal);
    expect(a.metadata.heightMaxM).toBeLessThanOrEqual(3.5e-6);
    expect(inner.metadata.heightMaxM).toBeLessThanOrEqual(.35e-6);
    expect(inner.metadata.roughnessMax).toBeLessThan(a.metadata.roughnessMin);
    for (let i = 0; i < a.normal.length; i += 4) {
      const n = Array.from(a.normal.slice(i, i + 3), v => v / 255 * 2 - 1);
      expect(Math.hypot(...n)).toBeCloseTo(1, 2);
      expect(n[2]).toBeGreaterThan(0);
    }
  });
  it("normal-map slope follows physical metres rather than texture resolution", () => {
    const a = vesselWallMapData({ layer: "adventitia", size: 128, axialPeriodM: .004 });
    const wide = vesselWallMapData({ layer: "adventitia", size: 128, axialPeriodM: .008 });
    expect(a.field).toEqual(wide.field);
    for (let i = 0; i < a.normal.length; i += 4) {
      const sxA = (a.normal[i]! / 255 * 2 - 1) / (a.normal[i + 2]! / 255 * 2 - 1);
      const sxWide = (wide.normal[i]! / 255 * 2 - 1) / (wide.normal[i + 2]! / 255 * 2 - 1);
      expect(Math.abs(sxA / 2 - sxWide)).toBeLessThan(.007);
    }
  });
  it("rejects invalid texture requests without allocating an unbounded map", () => {
    expect(() => vesselWallMapData({ layer: "adventitia", size: 4096 })).toThrow();
    expect(() => vesselWallMapData({ layer: "adventitia", size: 8 })).toThrow();
    expect(() => vesselWallMapData({ layer: "adventitia", axialPeriodM: -1 })).toThrow();
  });
});
