import { describe, expect, it } from "vitest";
import { sameAtlasGeometry, sameAtlasRecipe, validateAtlasJointSampling, type AtlasGeneration, type AtlasSpec } from "./atlas";

const request = (): AtlasSpec => ({ template_id: "hra-liver-male", seed: 123, appearance: "tissue", controls: { bend: 0 } });
function result(diseased = false): AtlasGeneration {
  const disease = { profile_id: "liver-hcc", seed: 73, severity: 0.5, size: 0.5, spread: 0.5, irregularity: 0.5, contrast: 0.5, count: 2, location: [0, 0, 0] as [number, number, number] };
  return {
    spec: { ...request(), controls: { bend: 0.5 }, appearance: "tissue", material: { version: "atlas-material-2.0.0", organ: "liver", preset: "balanced", seed: 91, tint: 0.2, pigment_contrast: 0.4, mottle_scale_mm: 12, wetness: 0.3, fine_detail: 0.4, structure_strength: 0.2 }, ...(diseased ? { disease } : {}) },
    scene: { organs: [] },
    summary: { joint_model: { model_sha256: "a".repeat(64), bundle_sha256: "b".repeat(64), request_seed: 123, temperature: 0.7, template_id: "hra-liver-male", profile_id: diseased ? "liver-hcc" : null, material_seed: 91, spatial_seed: diseased ? 73 : null } },
  };
}

describe("Joint sampling response binding", () => {
  it("binds expanded-flow severity and keeps renderer versions distinct", () => {
    const value = result(true);
    value.spec.renderer_version = "disease-v2";
    value.spec.disease!.severity = 0.9;
    Object.assign(value.summary.joint_model as object, { model_generation: 2, request_severity_band: "severe" });
    const query = { ...request(), disease: value.spec.disease! };
    expect(() => validateAtlasJointSampling(query, value, 0.7, "severe")).not.toThrow();
    expect(() => validateAtlasJointSampling(query, value, 0.7, "mild")).toThrow();
    value.spec.disease!.severity = 0.2;
    expect(() => validateAtlasJointSampling(query, value, 0.7, "severe")).toThrow("outside");
    expect(sameAtlasRecipe(request(), { ...request(), renderer_version: "disease-v2" })).toBe(false);
    expect(sameAtlasGeometry(request(), { ...request(), renderer_version: "disease-v2" })).toBe(false);
  });
  it("accepts coupled changes while preserving requested baseline or disease condition", () => {
    expect(() => validateAtlasJointSampling(request(), result(), 0.7)).not.toThrow();
    const value = result(true);
    expect(() => validateAtlasJointSampling({ ...request(), disease: value.spec.disease! }, value, 0.7)).not.toThrow();
  });
  it("refuses a different organ, disease or untied random output", () => {
    for (const edit of [
      (v: AtlasGeneration) => { v.spec.template_id = "kidney"; },
      (v: AtlasGeneration) => { v.spec.seed = 124; },
      (v: AtlasGeneration) => { v.spec.appearance = "clay"; },
      (v: AtlasGeneration) => { delete v.spec.material; },
      (v: AtlasGeneration) => { v.spec.material!.seed = 45; },
      (v: AtlasGeneration) => { v.spec.disease = result(true).spec.disease!; },
    ]) {
      const value = result(); edit(value);
      expect(() => validateAtlasJointSampling(request(), value, 0.7)).toThrow("previous preview");
    }
    for (const [key, value] of Object.entries({ model_sha256: "unknown", bundle_sha256: "unknown", request_seed: 42, template_id: "other", profile_id: "liver-cirrhosis", temperature: 1, material_seed: 0, spatial_seed: 0 })) {
      const output = result();
      (output.summary.joint_model as Record<string, unknown>)[key] = value;
      expect(() => validateAtlasJointSampling(request(), output, 0.7)).toThrow("previous preview");
    }
  });
});
