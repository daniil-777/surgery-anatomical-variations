/** The browser disease sampler against the API's own draws and proposals (src/__fixtures__/disease-recipes-v2.json, written
 *  by scripts/export_disease_web.py from the model the API serves): numpy's normals and the spatial seed bit for bit,
 *  the float32 decoder within float32 rounding, the snapped and clipped recipe and the provenance record field for
 *  field — then the same against the route itself. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISEASE_SAMPLER_MESSAGES, decodeLatent, parseDiseaseModel, proposeDiseaseSpec, sampleDiseaseRecipe, type DiseaseModelMeta } from "./atlasDiseaseSampler";
import type { AtlasSpec } from "./atlas";

interface Case {
  profile_id: string; seed: number; condition: number; edge?: string; z: number[]; decoded: number[]; values: number[]; clipped: boolean[];
  spatial_seed: number; disease: Record<string, unknown>; model: Record<string, unknown>;
}
interface Fixture { model_sha256: string; numpy_version: string; refusals: { unsupported_profile: string; seed: string }; cases: Case[] }
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const fixture = JSON.parse(read("./__fixtures__/disease-recipes-v2.json").toString()) as Fixture;
const meta = JSON.parse(read("../public/models/disease-recipes-v2/model.json").toString()) as DiseaseModelMeta;
const weights = read("../public/models/disease-recipes-v2/weights.bin");
const model = parseDiseaseModel(meta, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
const maxAbs = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const maxRel = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!) / Math.max(1e-3, Math.abs(b[i]!))));
/** The distance in float32 ulps of b (spacing 2^(exponent - 23)), the unit the decoder's rounding is measured in. */
const maxUlps = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!) / 2 ** (Math.floor(Math.log2(Math.abs(b[i]!))) - 23)));
const FLOAT32_RELATIVE = 1e-6;
const NUMBER_KEYS = ["severity", "size", "spread", "irregularity", "contrast"] as const;
/** A recipe back in the float32 row the decoder produced (decode_recipe's inverse): the rounding happened there, and
 *  2v - 1 would make a one-ulp difference near location 0 look large. */
const rowOf = (r: Record<string, unknown>) => [...NUMBER_KEYS.map((k) => r[k] as number), ((r.count as number) - 1) / 7, ...(r.location as number[]).map((l) => (l + 1) / 2)];

/** spec.disease as the API sends it, field by field: identity, seed and count exact, the rest within float32 rounding. */
function expectSameRecipe(ours: Record<string, unknown>, theirs: Record<string, unknown>): { worst: number } {
  expect(Object.keys(ours)).toEqual(Object.keys(theirs));
  for (const key of ["profile_id", "seed", "count"]) expect(ours[key]).toBe(theirs[key]);
  const worst = maxRel(rowOf(ours), rowOf(theirs));
  expect(worst).toBeLessThan(FLOAT32_RELATIVE);
  return { worst };
}

describe("the disease recipe sampler in the browser", () => {
  it("is the exported model the API serves", () => {
    expect(model.meta.model_sha256).toBe(fixture.model_sha256);
    expect(model.meta.config).toEqual({ latent: 8, hidden: 96, embedding: 16 });
    expect(model.meta.profiles).toHaveLength(25);
    expect(fixture.numpy_version).toMatch(/^2\./);
    expect(new Set(fixture.cases.map((c) => c.profile_id)).size).toBe(25);
  });

  it("replays the API's proposals: draws and seeds exactly, the decoder and recipe within float32 rounding, the provenance exactly", () => {
    const worst = { decoded: 0, decodedUlps: 0, values: 0, recipe: 0 };
    let identical = 0, total = 0;
    for (const c of fixture.cases) {
      const ours = sampleDiseaseRecipe(model, c.profile_id, c.seed);
      expect(ours.latent).toEqual(c.z);
      expect(ours.model.spatial_seed).toBe(c.spatial_seed);
      expect(model.meta.profiles.indexOf(c.profile_id)).toBe(c.condition);
      worst.decoded = Math.max(worst.decoded, maxRel(ours.decoded, c.decoded));
      worst.decodedUlps = Math.max(worst.decodedUlps, maxUlps(ours.decoded, c.decoded));
      worst.values = Math.max(worst.values, maxAbs(ours.values, c.values));
      identical += ours.values.filter((v, i) => v === c.values[i]).length; total += ours.values.length;
      worst.recipe = Math.max(worst.recipe, expectSameRecipe(ours.disease as unknown as Record<string, unknown>, c.disease).worst);
      expect(ours.model).toEqual(c.model);
      // the decoder alone, fed the API's own normals: the arithmetic without the generator
      expect(maxRel(Array.from(decodeLatent(model, c.condition, c.z)), c.decoded)).toBeLessThan(FLOAT32_RELATIVE);
    }
    console.log(`disease sampler vs API (${fixture.cases.length} proposals): decoder rel ≤ ${worst.decoded.toExponential(2)} (${worst.decodedUlps} float32 ulps), recipe row abs ≤ ${worst.values.toExponential(2)} (${identical}/${total} values bit-identical), recipe rel ≤ ${worst.recipe.toExponential(2)}`);
    expect(worst.decoded).toBeLessThan(FLOAT32_RELATIVE);
    expect(worst.values).toBeLessThan(FLOAT32_RELATIVE);
  });

  it("covers the branches that could round differently", () => {
    expect(fixture.cases.some((c) => c.clipped.some(Boolean))).toBe(true);
    expect(new Set(fixture.cases.map((c) => c.edge).filter(Boolean))).toEqual(new Set(["clip", "count_half_way"]));
    expect(new Set(fixture.cases.map((c) => c.disease.count)).size).toBeGreaterThan(3);
  });

  it("refuses what the API refuses, in its words", () => {
    expect(() => sampleDiseaseRecipe(model, "liver-capsular-cyst", 42)).toThrow(fixture.refusals.unsupported_profile);
    expect(() => sampleDiseaseRecipe(model, "no-such-profile", 42)).toThrow(DISEASE_SAMPLER_MESSAGES.unsupported);
    for (const seed of [-1, 2 ** 32, 1.5, Number.NaN]) expect(() => sampleDiseaseRecipe(model, "liver-cirrhosis", seed)).toThrow(fixture.refusals.seed);
    const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: "hra-liver-female", seed: 42, controls: {}, appearance: "tissue", disease: null };
    expect(() => proposeDiseaseSpec(model, spec)).toThrow(DISEASE_SAMPLER_MESSAGES.noProfile);
  });

  it("proposes the request spec with its disease replaced and the realized id cleared", () => {
    const c = fixture.cases[0]!;
    const disease = { profile_id: c.profile_id, seed: c.seed, severity: 0.55, size: 0.5, spread: 0.5, irregularity: 0.35, contrast: 0.45, count: 3, location: [0.25, 0.15, 0.8] as [number, number, number] };
    const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: "hra-urinary-bladder-female", seed: 42, controls: { bend: 0.1 }, appearance: "tissue", material: null, disease, realized_id: "stale" };
    const { spec: target, provenance } = proposeDiseaseSpec(model, spec);
    expect(target.disease).toEqual(sampleDiseaseRecipe(model, c.profile_id, c.seed).disease);
    expect(provenance).toEqual(c.model);
    expect("realized_id" in target).toBe(false);
    expect({ ...target, disease: null }).toEqual({ ...spec, disease: null, realized_id: undefined });
    expect(spec.disease).toBe(disease);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
import fs from "node:fs";
import path from "node:path";
import { validateAtlasDiseaseSampling, validateAtlasGeneration, type AtlasCatalog, type AtlasGeneration, type AtlasTemplate } from "./atlas";
import type { AtlasDiseaseSpec } from "./atlasDisease";
import { primeDiseaseModel, sampleDiseaseLocally } from "./atlasDiseaseSampler";
import { parseDiseaseSupport, primeDiseaseSupport, type DiseaseSupportIndex } from "./atlasDiseaseLocal";
import type { AtlasMaterialRecipe } from "./atlasMaterial";

/** The disease renderer's bundled support for a template, read from disk: Node has no base URL for publicUrl. */
function primeSupportFromDisk(templateId: string): void {
  const index = JSON.parse(read("../public/models/disease-v2/index.json").toString()) as DiseaseSupportIndex;
  const entry = index.templates[templateId]!, bytes = read(`../public/models/disease-v2/${entry.file}`);
  primeDiseaseSupport(templateId, parseDiseaseSupport(entry, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
}

const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const post = async (route: string, body: unknown): Promise<{ status: number; json: unknown }> => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};
interface Catalog { controls: { key: string; default: number }[]; materials: { defaults: Record<string, AtlasMaterialRecipe> }; diseases: { defaults: Record<string, AtlasDiseaseSpec> }; organs: { id: string; templates: { id: string }[] }[] }

describe.skipIf(!online)("the browser disease sampler against the API's route", () => {
  it("proposes the same spec.disease and disease_model as /api/atlas/sample-disease", async () => {
    primeDiseaseModel(model);
    const catalog = (await fetch(`${API}/api/atlas/catalog`).then((r) => r.json())) as Catalog;
    const controls = Object.fromEntries(catalog.controls.map((c) => [c.key, c.default]));
    const requestFor = (templateId: string, profileId: string, seed: number): AtlasSpec => {
      const organ = catalog.organs.find((o) => o.templates.some((t) => t.id === templateId))!;
      return { renderer_version: "disease-v2", template_id: templateId, seed: 42, appearance: "tissue", controls, material: catalog.materials.defaults[organ.id]!, disease: { ...catalog.diseases.defaults[organ.id]!, profile_id: profileId, seed } };
    };
    const cases: [string, string, number][] = [
      ["hra-liver-female", "liver-cirrhosis", 42], ["hra-liver-male", "liver-hcc", 7], ["hra-kidney-male-left", "kidney-polycystic", 1729], ["bp3d-stomach-male", "stomach-gist", 0],
      ["hra-brain-female", "brain-glioblastoma", 2 ** 32 - 1], ["hra-lung-male", "lung-emphysema", 123456789], ["hra-pancreas-female", "pancreas-pseudocyst", 99],
    ];
    let worst = 0;
    for (const [templateId, profileId, seed] of cases) {
      const spec = requestFor(templateId, profileId, seed);
      const answer = await post("/api/atlas/sample-disease", { spec, seed });
      expect(answer.status, JSON.stringify(answer.json).slice(0, 200)).toBe(200);
      const api = answer.json as AtlasGeneration;
      expect((api.summary.disease_model as Record<string, unknown>).model_sha256).toBe(model.meta.model_sha256);
      const ours = proposeDiseaseSpec(model, spec);
      worst = Math.max(worst, expectSameRecipe(ours.spec.disease as unknown as Record<string, unknown>, api.spec.disease as unknown as Record<string, unknown>).worst);
      expect(ours.provenance).toEqual(api.summary.disease_model);
      expect(ours.provenance).toEqual((api.scene.metadata as Record<string, unknown>).disease_model);
      for (const key of ["template_id", "seed", "appearance", "controls", "material", "renderer_version"]) expect(ours.spec[key]).toEqual(api.spec[key]);
      // the studio's own check accepts the browser proposal in the API's place
      validateAtlasDiseaseSampling(spec, { ...api, spec: ours.spec, summary: { ...api.summary, disease_model: ours.provenance } });
    }
    console.log(`${cases.length} profiles live: spec.disease within ${worst.toExponential(2)} relative, disease_model identical`);
  }, 120_000); // the API realizes each proposal's morphology (seconds per organ the first time)

  it("realizes the proposal as the route does: the studio's offline learned disease variation, end to end", async () => {
    primeDiseaseModel(model);
    const catalog = (await fetch(`${API}/api/atlas/catalog`).then((r) => r.json())) as AtlasCatalog;
    const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES ?? path.resolve(process.cwd(), "datasets/atlas/cohort-v2/templates");
    const controls = Object.fromEntries(catalog.controls.map((c) => [c.key, c.default]));
    for (const [templateId, profileId, seed] of [["hra-liver-female", "liver-cirrhosis", 42], ["hra-kidney-male-left", "kidney-polycystic", 1729]] as const) {
      primeSupportFromDisk(templateId);
      const organ = catalog.organs.find((o) => o.templates.some((t) => t.id === templateId))!;
      const template = { ...organ.templates.find((t) => t.id === templateId)! } as AtlasTemplate;
      template.normalization_mm = JSON.parse(fs.readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8")).normalization_mm;
      const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: templateId, seed: 42, appearance: "tissue", controls, material: { ...catalog.materials!.defaults[organ.id]! }, disease: { ...catalog.diseases!.defaults[organ.id]!, profile_id: profileId, seed } };
      const reference = (await post("/api/atlas/generate", { ...spec, disease: null })).json as AtlasGeneration;
      const answer = await post("/api/atlas/sample-disease", { spec, seed });
      expect(answer.status, JSON.stringify(answer.json).slice(0, 200)).toBe(200);
      const api = answer.json as AtlasGeneration;
      const ours = await sampleDiseaseLocally(reference, template, spec, catalog.diseases);
      expectSameRecipe(ours.spec.disease as unknown as Record<string, unknown>, api.spec.disease as unknown as Record<string, unknown>);
      expect(ours.summary.disease_model).toEqual(api.summary.disease_model);
      expect((ours.scene.metadata as Record<string, unknown>).disease_model).toEqual(api.summary.disease_model);
      const positions = maxAbs(ours.scene.organs[0]!.positions, api.scene.organs[0]!.positions);
      // the recipe differs from the API's by float32 rounding (≤ 4 ulps, ~2e-7 relative) and enters the site
      // amplitudes linearly: a few 1e-7 of a displacement of some millimetres
      expect(positions).toBeLessThan(1e-5);
      const apiDisease = api.summary.disease as Record<string, unknown>, ourDisease = ours.summary.disease as Record<string, unknown>;
      for (const key of ["requested_sites", "realized_sites", "displacement_limited_by_source_mesh"]) expect(ourDisease[key], key).toEqual(apiDisease[key]);
      validateAtlasGeneration(ours, catalog);
      validateAtlasDiseaseSampling(spec, ours);
      console.log(`${templateId} ${profileId} seed ${seed}: sampled and realized in the browser, positions within ${positions.toExponential(2)} mm of the route`);
    }
  }, 120_000);

  it("refuses with the route's own words", async () => {
    const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: "hra-liver-female", seed: 42, appearance: "tissue", controls: {}, disease: { profile_id: "liver-capsular-cyst", seed: 42, severity: 0.55, size: 0.5, spread: 0.5, irregularity: 0.35, contrast: 0.45, count: 3, location: [0.25, 0.15, 0.8] } };
    const unsupported = await post("/api/atlas/sample-disease", { spec, seed: 42 });
    expect(unsupported.status).toBe(422);
    expect(() => proposeDiseaseSpec(model, spec)).toThrow((unsupported.json as { detail: string }).detail);
    const none = await post("/api/atlas/sample-disease", { spec: { ...spec, disease: null }, seed: 42 });
    expect(none.status).toBe(422);
    expect(() => proposeDiseaseSpec(model, { ...spec, disease: null })).toThrow((none.json as { detail: string }).detail);
  });
});
