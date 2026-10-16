import { describe, expect, it } from "vitest";
import {
  atlasError, defaultAtlasSpec, safeSourceUrl, sameAtlasRecipe, sampleAtlasRecipe,
  validateAtlasCatalog, validateAtlasGeneration, validateAtlasSpec,
  type AtlasCatalog,
} from "./atlas";

const keys = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"];
const catalog: AtlasCatalog = {
  organs: [
    { id: "liver", label: "Liver", templates: [{ id: "liver-f", label: "Female liver", source: "HRA", license: "CC BY 4.0" }] },
    { id: "kidney", label: "Kidney", templates: [{ id: "kidney-l", label: "Left kidney", source: "HRA", license: "CC BY 4.0" }] },
  ],
  controls: keys.map((key) => ({ key, label: key, min: -1, max: 1, default: 0 })),
};
const spec = () => defaultAtlasSpec(catalog, "liver-f");
const generation = () => ({
  spec: spec(), summary: { source: "HRA", expert_reviewed: false },
  scene: { organs: [{ id: "liver", name: "Liver", kind: "organ", color: "#802e2b",
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] },
});

describe("Atlas catalog and response contracts", () => {
  it("creates exact, zero-deformation recipes only for known templates", () => {
    expect(() => validateAtlasCatalog(catalog)).not.toThrow();
    expect(spec().controls).toEqual(Object.fromEntries(keys.map((key) => [key, 0])));
    expect(() => defaultAtlasSpec(catalog, "invented-organ")).toThrow("Choose a reference");
  });
  it("rejects duplicate reference IDs and invalid control bounds", () => {
    const duplicate = structuredClone(catalog);
    duplicate.organs[1]!.templates[0]!.id = "liver-f";
    expect(() => validateAtlasCatalog(duplicate)).toThrow("invalid reference");
    const bounds = structuredClone(catalog);
    bounds.controls[0]!.default = 2;
    expect(() => validateAtlasCatalog(bounds)).toThrow("invalid shape control");
    bounds.controls[0]!.default = 0;
    bounds.controls[0]!.key = "__proto__";
    expect(() => validateAtlasCatalog(bounds)).toThrow("invalid shape control");
  });
  it.each([-1, 1.2, NaN, Infinity, 4294967296, "42"])("rejects invalid seed %s", (seed) => {
    expect(() => validateAtlasSpec({ ...spec(), seed }, catalog)).toThrow("whole number");
  });
  it("accepts uint32 boundary seeds but refuses omitted, unknown and out-of-range controls", () => {
    for (const seed of [0, 4294967295]) expect(() => validateAtlasSpec({ ...spec(), seed }, catalog)).not.toThrow();
    expect(() => validateAtlasSpec({ ...spec(), controls: { ...spec().controls, invented: 0 } }, catalog)).toThrow("shape recipe");
    expect(() => validateAtlasSpec({ ...spec(), controls: { ...spec().controls, scale_x: 1.01 } }, catalog)).toThrow("scale_x");
    expect(() => validateAtlasSpec({ ...spec(), appearance: "photoreal" }, catalog)).toThrow("not supported");
  });
  it("checks returned geometry before it can replace the current preview", () => {
    expect(() => validateAtlasGeneration(generation(), catalog)).not.toThrow();
    const broken = generation();
    broken.scene.organs[0]!.indices[2] = 999;
    expect(() => validateAtlasGeneration(broken, catalog)).toThrow("mesh validation");
    expect(() => validateAtlasGeneration({ ...generation(), summary: null }, catalog)).toThrow("generation summary");
  });
  it("rejects malformed disease shading even without an editable material recipe", () => {
    const value = generation();
    Object.assign(value.scene.organs[0]!, { metadata: { disease_field: { version: "unknown" } } });
    expect(() => validateAtlasGeneration(value, catalog)).toThrow("disease appearance field");
  });
  it("tracks geometry edits independently of server provenance", () => {
    expect(sameAtlasRecipe(spec(), { ...spec(), lineage: "immutable-reference-sha" })).toBe(true);
    expect(sameAtlasRecipe(spec(), { ...spec(), controls: { ...spec().controls, bend: 0.1 } })).toBe(false);
    expect(sameAtlasRecipe(spec(), { ...spec(), seed: 123 })).toBe(false);
    expect(sameAtlasRecipe(spec(), { ...spec(), appearance: "clay" })).toBe(false);
  });
  it("replays sampled geometry exactly from a seed and varies all controls across seeds", () => {
    const first = sampleAtlasRecipe(catalog, spec());
    const second = sampleAtlasRecipe(catalog, { ...spec(), controls: { ...spec().controls, bend: 0.9 } });
    expect(first.controls).toEqual(second.controls);
    expect(first.controls).not.toEqual(spec().controls);
    expect(Object.keys(first.controls)).toEqual(keys);
    expect(Object.values(first.controls).every((value) => Math.abs(value) <= 1)).toBe(true);
    expect(Object.values(first.controls).some((value) => Math.abs(value) > 0.4)).toBe(true);
    const changed = sampleAtlasRecipe(catalog, { ...spec(), seed: 43 });
    expect(keys.every((key) => changed.controls[key] !== first.controls[key])).toBe(true);
    expect(first.seed).toBe(42);
    expect(() => validateAtlasSpec(first, catalog)).not.toThrow();
  });
  it("scales deterministic recipes through the full existing interval without changing other inputs", () => {
    const input = { ...spec(), provenance: { source: "reference-checksum" } };
    const before = structuredClone(input);
    const full = sampleAtlasRecipe(catalog, input);
    for (const strength of [0.4, 0.7, 1]) {
      const sampled = sampleAtlasRecipe(catalog, input, strength);
      for (const key of keys) {
        expect(sampled.controls[key]).toBeCloseTo(full.controls[key]! * strength, 3);
        expect(Math.abs(sampled.controls[key]!)).toBeLessThanOrEqual(strength);
      }
      expect({ ...sampled, controls: input.controls }).toEqual(input);
    }
    expect(sampleAtlasRecipe(catalog, input, 0).controls).toEqual(spec().controls);
    expect(input).toEqual(before);
  });
  it("uses the complete asymmetric interval and preserves exact defaults and narrow bounds", () => {
    const asymmetric = structuredClone(catalog);
    asymmetric.controls[0] = { ...asymmetric.controls[0]!, min: -0.2, max: 1, default: 0.1 };
    asymmetric.controls[1] = { ...asymmetric.controls[1]!, min: 0.123451, max: 0.123459, default: 0.123455 };
    const input = defaultAtlasSpec(asymmetric, "liver-f");
    const values = Array.from({ length: 128 }, (_, seed) => sampleAtlasRecipe(asymmetric, { ...input, seed }));
    expect(Math.max(...values.map((value) => value.controls.scale_x!))).toBeGreaterThan(0.9);
    expect(Math.min(...values.map((value) => value.controls.scale_x!))).toBeLessThan(-0.15);
    for (const sampled of values) expect(() => validateAtlasSpec(sampled, asymmetric)).not.toThrow();
    expect(sampleAtlasRecipe(asymmetric, input, 0).controls.scale_y).toBe(0.123455);
    for (const seed of [0, 4294967295]) {
      const sampled = sampleAtlasRecipe(asymmetric, { ...input, seed }, 0.4);
      expect(sampled.controls.scale_x).toBeGreaterThanOrEqual(-0.02 - 1e-12);
      expect(sampled.controls.scale_x).toBeLessThanOrEqual(0.46 + 1e-12);
    }
  });
  it.each([-0.1, 1.01, NaN, Infinity, -Infinity, "0.7", true, null])("rejects invalid variation strength %s", (strength) => {
    expect(() => sampleAtlasRecipe(catalog, spec(), strength as number)).toThrow("Variation strength");
  });
  it("treats source links as untrusted and preserves useful API validation errors", async () => {
    expect(safeSourceUrl("https://humanatlas.io/3d-reference-library")).toBe("https://humanatlas.io/3d-reference-library");
    expect(safeSourceUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeSourceUrl("/relative-source")).toBeUndefined();
    const error = await atlasError(new Response(JSON.stringify({ detail: [{ msg: "Seed is invalid" }] }), { status: 422 }));
    expect(error.message).toBe("Seed is invalid");
    expect((await atlasError(new Response("upstream failure", { status: 503 }))).message).toContain("503");
  });
});
