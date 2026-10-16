import reviewedProfiles from "../../../py/viscera_core/disease_profiles.json";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { AtlasDiseasePanel } from "./AtlasDiseasePanel";
import { defaultAtlasSpec, sameAtlasRecipe, sameAtlasGeometry, sampleAtlasRecipe, validateAtlasCatalog, validateAtlasSpec, validateAtlasDiseaseSampling, validateAtlasGeneration, type AtlasCatalog } from "./atlas";
import { defaultAtlasDisease, DISEASE_CONTROLS, sameAtlasDisease, sampleAtlasDisease, validateAtlasDisease, validateAtlasDiseaseLibrary, type AtlasDiseaseLibrary } from "./atlasDisease";

// The reviewed reference atlas has three disease references for each of twelve organ families.
const references = {
  "liver": [
    "liver-cirrhosis",
    "liver-hcc",
    "liver-metastases"
  ],
  "gallbladder": [
    "gallbladder-stones",
    "gallbladder-cholecystitis",
    "gallbladder-carcinoma"
  ],
  "stomach": [
    "stomach-adenocarcinoma",
    "stomach-ulcer",
    "stomach-gist"
  ],
  "pancreas": [
    "pancreas-cancer",
    "pancreas-pancreatitis",
    "pancreas-pseudocyst"
  ],
  "spleen": [
    "spleen-infarct",
    "spleen-rupture",
    "spleen-cyst"
  ],
  "small-intestine": [
    "small-intestine-crohn",
    "small-intestine-net",
    "small-intestine-obstruction"
  ],
  "large-intestine": [
    "colon-cancer",
    "colon-ulcerative-colitis-detail",
    "colon-diverticulosis"
  ],
  "kidney": [
    "kidney-cancer",
    "kidney-polycystic",
    "kidney-hydronephrosis"
  ],
  "urinary-bladder": [
    "bladder-cancer",
    "bladder-stones",
    "bladder-diverticulum"
  ],
  "heart": [
    "heart-infarction",
    "heart-aortic-stenosis",
    "heart-endocarditis"
  ],
  "lung": [
    "lung-cancer",
    "lung-emphysema",
    "lung-bronchiectasis"
  ],
  "brain": [
    "brain-meningioma",
    "brain-glioblastoma",
    "brain-aneurysm"
  ]
} as const;
const organIds = Object.keys(references);
const library: AtlasDiseaseLibrary = {
  version: "disease-1.0.0",
  profiles: Object.entries(references).flatMap(([organ, ids]) => ids.map(id => ({ id, organ, label: id, pattern: "local-feature", source_ref: id, source_url: "https://commons.wikimedia.org/", limits: "Synthetic surface approximation; expert review pending.", supported: true }))),
  controls: DISEASE_CONTROLS.map(control => ({ ...control })),
  defaults: Object.fromEntries(Object.entries(references).map(([organ, ids]) => [organ, { profile_id: ids[0], seed: 42, severity: 0.55, size: 0.5, spread: 0.5, irregularity: 0.5, contrast: 0.5, count: 3, location: [0, 0, 0] }])),
};
const catalog: AtlasCatalog = { organs: organIds.map(id => ({ id, label: id, templates: [{ id: `${id}-reference`, label: id, source: "HRA", license: "CC BY 4.0" }] })), controls: [{ key: "bend", label: "Bend", min: -1, max: 1, default: 0 }], diseases: library };
const baseline = () => defaultAtlasSpec(catalog, "liver-reference");
const recipe = () => defaultAtlasDisease(library, "liver");
const spec = () => ({ ...baseline(), disease: recipe() });

describe("Disease morphology contracts", () => {
  it("accepts all 36 reviewed IDs across the twelve organ families", () => {
    expect(organIds).toHaveLength(12); expect(library.profiles).toHaveLength(36);
    expect(() => validateAtlasCatalog(catalog)).not.toThrow();
    for (const profile of library.profiles) {
      const disease = defaultAtlasDisease(library, profile.organ, profile.id);
      expect(() => validateAtlasSpec({ ...defaultAtlasSpec(catalog, `${profile.organ}-reference`), disease }, catalog)).not.toThrow();
      expect(() => validateAtlasDisease(disease, library, profile.organ === "liver" ? "kidney" : "liver")).toThrow("supported by this organ");
    }
  });
  it("honors the actual backend reference-only support map for every organ", () => {
    const actual = { ...library, profiles: reviewedProfiles.profiles, defaults: structuredClone(library.defaults) };
    expect(actual.profiles).toHaveLength(36);
    for (const organ of organIds) {
      const supported = actual.profiles.filter(profile => profile.organ === organ && profile.supported);
      expect(supported.length).toBeGreaterThan(0);
      actual.defaults[organ]!.profile_id = supported[0]!.id;
    }
    expect(() => validateAtlasDiseaseLibrary(actual, organIds)).not.toThrow();
    for (const profile of actual.profiles) {
      const make = () => defaultAtlasDisease(actual, profile.organ, profile.id);
      if (profile.supported) expect(make).not.toThrow();
      else expect(make).toThrow("supported by this organ");
    }
  });
  it("preserves baseline and compatibility with servers without disease metadata", () => {
    const oldCatalog = { ...catalog }; delete oldCatalog.diseases;
    expect(() => validateAtlasCatalog(oldCatalog)).not.toThrow();
    expect(baseline().disease).toBeUndefined();
    expect(() => validateAtlasSpec(baseline(), oldCatalog)).not.toThrow();
    expect(() => validateAtlasSpec(spec(), oldCatalog)).toThrow("supported by this organ");
    expect(sameAtlasRecipe(baseline(), { ...baseline(), disease: null })).toBe(true);
  });
  it.each([-1, 0.1, 4294967296, NaN, Infinity, "42"])("rejects invalid disease seed %s", seed => {
    expect(() => validateAtlasDisease({ ...recipe(), seed }, library, "liver")).toThrow("whole number");
  });
  it("validates every scalar, location axis, exact keys and uint32 boundaries", () => {
    for (const control of DISEASE_CONTROLS) {
      for (const amount of [control.min - 0.001, control.max + 0.001, NaN, Infinity, "0.5", null]) {
        expect(() => validateAtlasDisease({ ...recipe(), [control.key]: amount }, library, "liver")).toThrow();
      }
      for (const amount of [control.min, control.max]) expect(() => validateAtlasDisease({ ...recipe(), [control.key]: amount }, library, "liver")).not.toThrow();
    }
    expect(() => validateAtlasDisease({ ...recipe(), count: 1.5 }, library)).toThrow("whole number");
    for (const location of [[0, 0], [0, 0, 0, 0], [0, 0, NaN], [0, 0, 1.1], [0, "0", 0], null]) expect(() => validateAtlasDisease({ ...recipe(), location }, library)).toThrow("three coordinates");
    expect(() => validateAtlasDisease({ ...recipe(), extra: 1 }, library)).toThrow("unsupported controls");
    const missing = { ...recipe() } as Partial<ReturnType<typeof recipe>>; delete missing.size;
    expect(() => validateAtlasDisease(missing, library)).toThrow("incomplete");
    for (const seed of [0, 4294967295]) expect(() => validateAtlasDisease({ ...recipe(), seed, location: [-1, 0, 1] }, library)).not.toThrow();
  });
  it("rejects unknown, cross-organ and reference-only disease profiles", () => {
    expect(() => validateAtlasDisease({ ...recipe(), profile_id: "unrecognized" }, library)).toThrow();
    const limited = structuredClone(library);
    limited.profiles[1]!.supported = false; limited.profiles[1]!.unavailable_reason = "Required internal anatomy is absent.";
    expect(() => validateAtlasDiseaseLibrary(limited, organIds)).not.toThrow();
    expect(() => defaultAtlasDisease(limited, "liver", limited.profiles[1]!.id)).toThrow("supported by this organ");
    delete limited.profiles[1]!.unavailable_reason;
    expect(() => validateAtlasDiseaseLibrary(limited, organIds)).toThrow("explain");
  });
  it("rejects incomplete catalogs, duplicate profiles and incompatible control bounds", () => {
    const duplicate = structuredClone(library); duplicate.profiles.push(duplicate.profiles[0]!);
    expect(() => validateAtlasDiseaseLibrary(duplicate, organIds)).toThrow("invalid profile");
    const missing = structuredClone(library); delete missing.defaults.brain;
    expect(() => validateAtlasDiseaseLibrary(missing, organIds)).toThrow();
    const bounds = structuredClone(library); bounds.controls[0]!.max = 2;
    expect(() => validateAtlasDiseaseLibrary(bounds, organIds)).toThrow("unsupported bounds");
  });
  it("tracks every disease edit in recipe and geometry equality", () => {
    expect(sameAtlasDisease(recipe(), structuredClone(recipe()))).toBe(true);
    expect(sameAtlasRecipe(spec(), { ...spec(), lineage: "source" })).toBe(true);
    for (const key of [...DISEASE_CONTROLS.map(c => c.key), "seed"] as const) {
      const disease = { ...recipe(), [key]: recipe()[key] + (key === "count" || key === "seed" ? 1 : 0.1) };
      expect(sameAtlasRecipe(spec(), { ...spec(), disease })).toBe(false);
      expect(sameAtlasGeometry(spec(), { ...spec(), disease })).toBe(false);
    }
    for (let axis = 0; axis < 3; axis++) {
      const disease = recipe(); disease.location[axis] = 0.2;
      expect(sameAtlasGeometry(spec(), { ...spec(), disease })).toBe(false);
    }
    expect(sameAtlasGeometry(spec(), { ...spec(), disease: { ...recipe(), profile_id: references.liver[1] } })).toBe(false);
    expect(sameAtlasGeometry(spec(), baseline())).toBe(false);
    expect(sameAtlasGeometry(spec(), { ...spec(), appearance: "clay" })).toBe(true);
  });
  it("varies disease and shape deterministically for all organs without mutating inputs", () => {
    for (const organ of organIds) {
      const input = { ...defaultAtlasSpec(catalog, `${organ}-reference`), disease: defaultAtlasDisease(library, organ) };
      const before = structuredClone(input);
      const first = sampleAtlasRecipe(catalog, input);
      const replay = sampleAtlasRecipe(catalog, structuredClone(input));
      const changed = sampleAtlasRecipe(catalog, { ...input, seed: 43 });
      expect(first).toEqual(replay);
      expect(first.disease?.profile_id).toBe(input.disease.profile_id);
      expect(first.disease?.seed).toBe(input.seed);
      expect(first.disease?.location).not.toEqual(changed.disease?.location);
      for (const key of ["severity", "size", "spread", "irregularity", "contrast"] as const) expect(first.disease?.[key]).not.toBe(changed.disease?.[key]);
      expect(first.controls).not.toEqual(changed.controls);
      expect(input).toEqual(before);
      for (let seed = 0; seed < 32; seed++) expect(() => validateAtlasSpec(sampleAtlasRecipe(catalog, { ...input, seed }), catalog)).not.toThrow();
    }
  });
  it("refuses missing disease fields and stale baseline fields before showing a preview", () => {
    const organ = { id: "liver", name: "Liver", kind: "organ", color: "#902020", positions: [0,0,0,1,0,0,0,1,0], indices: [0,1,2] };
    const field = { version: "disease-morphology-design-1.0.0", fields: [], target_srgb: [0.5,0.3,0.2], color_strength: 0 };
    expect(() => validateAtlasGeneration({ spec: spec(), scene: { organs: [organ] }, summary: {} }, catalog)).toThrow("disease field does not match");
    const withField = { ...organ, metadata: { disease_field: field } };
    expect(() => validateAtlasGeneration({ spec: baseline(), scene: { organs: [withField] }, summary: {} }, catalog)).toThrow("disease field does not match");
    expect(() => validateAtlasGeneration({ spec: spec(), scene: { organs: [withField] }, summary: {} }, catalog)).not.toThrow();
  });
  it("binds learned spatial seeds to request provenance and rejects mismatches", () => {
    const request = spec();
    const response = { spec: { ...request, disease: { ...recipe(), seed: 999, size: 0.8 } }, scene: { organs: [] },
      summary: { disease_model: { request_seed: 42, spatial_seed: 999, profile_id: recipe().profile_id, model_sha256: "trained-artifact" } } };
    expect(() => validateAtlasDiseaseSampling(request, response)).not.toThrow();
    for (const patch of [{ request_seed: 41 }, { spatial_seed: 42 }, { profile_id: "liver-hcc" }, { model_sha256: "" }]) {
      const invalid = { ...response, summary: { disease_model: { ...response.summary.disease_model, ...patch } } };
      expect(() => validateAtlasDiseaseSampling(request, invalid)).toThrow("provenance");
    }
    expect(() => validateAtlasDiseaseSampling(request, { ...response, summary: {} })).toThrow();
    expect(() => validateAtlasDiseaseSampling(request, { ...response, spec: { ...response.spec, controls: { bend: 0.5 } } })).toThrow("preserve");
    expect(() => validateAtlasDiseaseSampling(request, { ...response, spec: { ...response.spec, seed: 43 } })).toThrow("preserve");
    expect(() => validateAtlasDiseaseSampling(request, { ...response, spec: { ...response.spec, disease: { ...response.spec.disease, profile_id: "liver-hcc" } } })).toThrow("preserve");
  });
  it("preserves exact disease defaults at zero strength and validates strength", () => {
    expect(sampleAtlasDisease(library, recipe(), 42, 0)).toEqual(recipe());
    for (const strength of [-1, 1.1, NaN, Infinity]) expect(() => sampleAtlasDisease(library, recipe(), 42, strength)).toThrow("strength");
    const result = recipe(); result.location[0] = 0.7;
    expect(library.defaults.liver!.location).toEqual([0, 0, 0]);
  });
});

describe("Disease panel content", () => {
  const props = { library, organ: "liver", recipe: recipe(), seedText: "42", onRecipe: () => {}, onSeedText: () => {}, onApply: () => {}, onSample: () => {}, onLearned: () => {}, learnedAvailable: true, disabled: false, pending: false, updating: false, learnedApplied: false };
  it("exposes controls and caveats for all twelve organs", () => {
    for (const organ of organIds) {
      const html = renderToStaticMarkup(createElement(AtlasDiseasePanel, { ...props, organ, recipe: defaultAtlasDisease(library, organ) }));
      expect(html).toContain("Synthetic morphology prototype");
      expect(html).toContain("not a clinical stage");
      expect(html).toContain("Learned disease variation");
      expect((html.match(/type="range"/g) ?? []).length).toBe(9);
      expect(html).toContain("Disease location Z");
      expect(html).toContain("View morphology reference");
    }
  });
  it("shows source-mesh displacement limits only for active modifiers", () => {
    const html = renderToStaticMarkup(createElement(AtlasDiseasePanel, { ...props, displacementLimited: true }));
    expect(html).toContain("Displacement was reduced to preserve this mesh.");
    const baseline = renderToStaticMarkup(createElement(AtlasDiseasePanel, { ...props, recipe: null, displacementLimited: true }));
    expect(baseline).not.toContain("Displacement was reduced");
  });
  it("separates baseline, unsupported server, and reference-only options", () => {
    const baselineHTML = renderToStaticMarkup(createElement(AtlasDiseasePanel, { ...props, recipe: null }));
    expect(baselineHTML).toContain("does not certify healthy anatomy");
    expect(baselineHTML).not.toContain("Learned disease variation");
    expect(renderToStaticMarkup(createElement(AtlasDiseasePanel, { ...props, library: undefined }))).toContain("Disease controls unavailable");
    const limited = structuredClone(library); limited.profiles[1]!.supported = false; limited.profiles[1]!.unavailable_reason = "Internal anatomy missing.";
    const html = renderToStaticMarkup(createElement(AtlasDiseasePanel, { ...props, library: limited }));
    expect(html).toContain('disabled="">liver-hcc · reference only');
    expect(html).toContain("Internal anatomy missing.");
  });
});
