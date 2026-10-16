import { describe, expect, it } from "vitest";
import { ATLAS_MATERIAL_VERSION, MATERIAL_CONTROLS, sameAtlasMaterial, validateAtlasMaterial, type AtlasMaterialRecipe, type ReferenceColor } from "./atlasMaterial";
const recipe = (): AtlasMaterialRecipe => ({ version: ATLAS_MATERIAL_VERSION, organ: "liver", preset: "balanced", seed: 42,
  tint: 0, pigment_contrast: 0.4, mottle_scale_mm: 12, wetness: 0.3, fine_detail: 0.4, structure_strength: 0.2 });
const reference = (): ReferenceColor => ({ version: "reference-color-1", organ: "liver", source_sha256: "a".repeat(64), mask_sha256: "b".repeat(64), observed_srgb: [0.6, 0.2, 0.15], strength: 0.7, mode: "chroma" });
describe("Versioned material recipe", () => {
  it("accepts exact declared parameters and organ identity", () => {
    expect(() => validateAtlasMaterial(recipe(), "liver")).not.toThrow();
    expect(() => validateAtlasMaterial(recipe(), "kidney")).toThrow("does not match");
    expect(() => validateAtlasMaterial({ ...recipe(), unsupported: true })).toThrow("does not match");
    expect(() => validateAtlasMaterial({ ...recipe(), version: "future" })).toThrow("does not match");
  });
  it("rejects nonfinite, out-of-range and invalid seed inputs", () => {
    for (const control of MATERIAL_CONTROLS) {
      expect(() => validateAtlasMaterial({ ...recipe(), [control.key]: NaN })).toThrow(control.label);
      expect(() => validateAtlasMaterial({ ...recipe(), [control.key]: control.max + 0.01 })).toThrow(control.label);
      expect(() => validateAtlasMaterial({ ...recipe(), [control.key]: control.min - 0.01 })).toThrow(control.label);
    }
    for (const seed of [-1, 1.2, 4294967296, "42", Infinity]) expect(() => validateAtlasMaterial({ ...recipe(), seed })).toThrow("appearance seed");
  });
  it("tracks every independent material input while preserving absent v1 recipes", () => {
    expect(sameAtlasMaterial(undefined, null)).toBe(true);
    expect(sameAtlasMaterial(recipe(), { ...recipe() })).toBe(true);
    expect(sameAtlasMaterial(recipe(), undefined)).toBe(false);
    for (const control of MATERIAL_CONTROLS) expect(sameAtlasMaterial(recipe(), { ...recipe(), [control.key]: recipe()[control.key] + 0.01 })).toBe(false);
    expect(sameAtlasMaterial(recipe(), { ...recipe(), seed: 43 })).toBe(false);
    expect(sameAtlasMaterial(recipe(), { ...recipe(), preset: "rich" })).toBe(false);
  });
  it("accepts optional reviewed reference colour while preserving legacy recipes", () => {
    expect(() => validateAtlasMaterial({ ...recipe(), reference_color: null }, "liver")).not.toThrow();
    expect(() => validateAtlasMaterial({ ...recipe(), reference_color: reference() }, "liver")).not.toThrow();
    expect(sameAtlasMaterial(recipe(), { ...recipe(), reference_color: null })).toBe(true);
    expect(sameAtlasMaterial({ ...recipe(), reference_color: reference() }, { ...recipe(), reference_color: reference() })).toBe(true);
    expect(sameAtlasMaterial(recipe(), { ...recipe(), reference_color: reference() })).toBe(false);
  });
  it("rejects malformed, unbounded and cross-organ reference colours", () => {
    for (const invalid of [null, [], { ...reference(), organ: "kidney" }, { ...reference(), source_sha256: "short" },
      { ...reference(), mask_sha256: "z".repeat(64) }, { ...reference(), observed_srgb: [1, 0] },
      { ...reference(), observed_srgb: [NaN, 0, 0] }, { ...reference(), observed_srgb: [255, 0, 0] },
      { ...reference(), strength: 1.01 }, { ...reference(), strength: -0.1 }, { ...reference(), strength: NaN },
      { ...reference(), mode: "raw" }, { ...reference(), unknown: true }, { ...reference(), version: "future" }]) {
      if (invalid === null) continue;
      expect(() => validateAtlasMaterial({ ...recipe(), reference_color: invalid }, "liver")).toThrow("reference colour");
    }
  });
  it("compares reference values deeply and includes all provenance and transfer inputs", () => {
    const original = { ...recipe(), reference_color: reference() };
    for (const change of [{ strength: 0.4 }, { mode: "color" as const }, { observed_srgb: [0.6, 0.2, 0.16] as [number, number, number] },
      { source_sha256: "c".repeat(64) }, { mask_sha256: "d".repeat(64) }, { organ: "kidney" }])
      expect(sameAtlasMaterial(original, { ...recipe(), reference_color: { ...reference(), ...change } })).toBe(false);
  });
});
