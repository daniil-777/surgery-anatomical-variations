/** Actual shipped artifacts plus mutations of their import contract; no model weights are rewritten. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJointModel, type JointModelMeta } from "./atlasJointLocal";
import { parseShapeModel, type ShapeModelMeta } from "./atlasShapeSampler";
import { parseMaterialModel, type MaterialModelMeta } from "./atlasMaterialSampler";
import { parseDiseaseModel, type DiseaseModelMeta } from "./atlasDiseaseSampler";

function artifact<T>(lane: string): { meta: T; bytes: ArrayBuffer } {
  const root = new URL(`../public/models/${lane}/`, import.meta.url);
  const bytes = readFileSync(new URL("weights.bin", root));
  return {
    meta: JSON.parse(readFileSync(new URL("model.json", root), "utf8")) as T,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}
const joint = artifact<JointModelMeta>("joint-v2");
const shape = artifact<ShapeModelMeta>("shape-v2");
const material = artifact<MaterialModelMeta>("material-v1");
const disease = artifact<DiseaseModelMeta>("disease-recipes-v2");

describe("generative artifact import boundaries", () => {
  it("accepts all four unmodified shipped model exports", () => {
    expect(parseJointModel(joint.meta, joint.bytes).arrays.size).toBe(joint.meta.arrays.length);
    expect(parseShapeModel(shape.meta, shape.bytes).controls.length).toBe(shape.meta.training_rows.count * 7);
    expect(parseMaterialModel(material.meta, material.bytes).trainControls.length).toBe(material.meta.training_rows * 6);
    expect(parseDiseaseModel(disease.meta, disease.bytes).arrays.size).toBe(9);
  });

  for (const defect of ["missing", "duplicate", "unknown", "wrong shape", "out of bounds", "overlap", "noninteger offset", "coerced offset"] as const) {
    it(`rejects disease ${defect} tensors before inference`, () => {
      const meta = structuredClone(disease.meta);
      if (defect === "missing") meta.arrays.pop();
      if (defect === "duplicate") meta.arrays.push(structuredClone(meta.arrays[0]!));
      if (defect === "unknown") meta.arrays.push({ ...meta.arrays[0]!, name: "unexpected.weight" });
      if (defect === "wrong shape") meta.arrays[0]!.shape.reverse();
      if (defect === "out of bounds") meta.arrays[0]!.offset = meta.float32_values;
      if (defect === "overlap") meta.arrays[1]!.offset = 0;
      if (defect === "noninteger offset") meta.arrays[0]!.offset = 0.5;
      if (defect === "coerced offset") (meta.arrays[0] as { offset: unknown }).offset = "0";
      expect(() => parseDiseaseModel(meta, disease.bytes)).toThrow();
    });
  }
  for (const latent of [0, -1, 0.5]) {
    it(`rejects disease latent width ${latent} even with a matching malformed tensor shape`, () => {
      const meta = structuredClone(disease.meta);
      meta.config.latent = latent;
      meta.arrays.find((entry) => entry.name === "decoder.0.weight")!.shape[1] = latent + meta.config.embedding;
      expect(() => parseDiseaseModel(meta, disease.bytes)).toThrow();
    });
  }
  for (const defect of ["feature order", "profile order", "empty profile", "nonstring profile", "missing organ", "extra organ", "empty organ"] as const) {
    it(`rejects disease ${defect} vocabulary`, () => {
      const meta = structuredClone(disease.meta);
      if (defect === "feature order") meta.feature_names.reverse();
      if (defect === "profile order") meta.profiles.reverse();
      if (defect === "empty profile") meta.profiles[0] = "";
      if (defect === "nonstring profile") (meta.profiles as unknown[])[0] = 42;
      if (defect === "missing organ") delete meta.profile_organs[meta.profiles[0]!];
      if (defect === "extra organ") meta.profile_organs["not-a-profile"] = "liver";
      if (defect === "empty organ") meta.profile_organs[meta.profiles[0]!] = "";
      expect(() => parseDiseaseModel(meta, disease.bytes)).toThrow();
    });
  }

  for (const defect of ["missing", "duplicate", "wrong shape", "out of bounds", "overlap", "noninteger offset", "coerced offset"] as const) {
    it(`rejects joint ${defect} tensors before inference`, () => {
      const meta = structuredClone(joint.meta);
      if (defect === "missing") meta.arrays.pop();
      if (defect === "duplicate") meta.arrays.push(structuredClone(meta.arrays[0]!));
      if (defect === "wrong shape") meta.arrays[0]!.shape.reverse();
      if (defect === "out of bounds") meta.arrays[0]!.offset = meta.float32_values;
      if (defect === "overlap") meta.arrays[1]!.offset = 0;
      if (defect === "noninteger offset") meta.arrays[0]!.offset = 0.5;
      if (defect === "coerced offset") (meta.arrays[0] as { offset: unknown }).offset = "0";
      expect(() => parseJointModel(meta, joint.bytes)).toThrow();
    });
  }
  it("rejects a sum-preserving nonbinary coupling mask", () => {
    const meta = structuredClone(joint.meta);
    const row = meta.masks[0]!;
    const one = row.indexOf(1), zero = row.indexOf(0);
    row[one] = 2; row[zero] = -1;
    expect(() => parseJointModel(meta, joint.bytes)).toThrow();
  });
  it("rejects reordered coupling masks even when each still has eleven active coordinates", () => {
    const meta = structuredClone(joint.meta);
    [meta.masks[0], meta.masks[1]] = [meta.masks[1]!, meta.masks[0]!];
    expect(() => parseJointModel(meta, joint.bytes)).toThrow();
  });
  it("rejects a context condition that is absent from its factorized vocabulary", () => {
    const meta = structuredClone(joint.meta);
    meta.conditions[0]!.organ = "not-an-organ";
    expect(() => parseJointModel(meta, joint.bytes)).toThrow();
  });
  it("rejects reordered shape feature names instead of interpreting weights under new semantics", () => {
    const meta = structuredClone(shape.meta);
    meta.condition_names.reverse();
    expect(() => parseShapeModel(meta, shape.bytes)).toThrow();
  });
  it("rejects a shape layout aliasing condition bytes to control bytes", () => {
    const meta = structuredClone(shape.meta);
    meta.arrays.find((a) => a.name === "conditions")!.offset = 0;
    expect(() => parseShapeModel(meta, shape.bytes)).toThrow();
  });
  it("rejects duplicate material tensors rather than silently taking the first", () => {
    const meta = structuredClone(material.meta);
    meta.arrays.push(structuredClone(meta.arrays[0]!));
    expect(() => parseMaterialModel(meta, material.bytes)).toThrow();
  });
  it("rejects material tensors that alias valid finite bytes", () => {
    const meta = structuredClone(material.meta);
    meta.arrays.find((a) => a.name === "ridge_residuals")!.offset = meta.arrays.find((a) => a.name === "train_controls")!.offset;
    expect(() => parseMaterialModel(meta, material.bytes)).toThrow();
  });
});
