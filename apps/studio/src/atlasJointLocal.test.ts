/** The browser joint flow against the API's own draws and samples (src/__fixtures__/joint-v2.json, written by
 *  scripts/export_joint_web.py from the active bundle): numpy's generator bit for bit, the uniforms exactly, the
 *  inverse flow and the decoded recipe within float32 rounding — for the healthy baseline of every template and for
 *  disease conditions in each severity band, whose recipe the disease-v2 renderer then realizes. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { JOINT_SEVERITIES, flowInverse, parseJointModel, sampleJointControls, type JointModelMeta } from "./atlasJointLocal";
import { Pcg64 } from "./numpyRandom";

interface Sample { template_id: string; profile_id: string | null; seed: number; temperature: number; condition: number; renderer_seeds: number[]; z: number[]; warped: number[]; flow_values: number[]; controls: Record<string, number>; material: Record<string, unknown> }
interface DiseaseSample extends Sample { profile_id: string; severity: "auto" | "mild" | "moderate" | "severe"; severity_id: number; flow_controls: number[]; disease: Record<string, unknown> }
interface Fixture {
  model_sha256: string;
  rng: { seed: number; raw_uint64: string[]; uint32_pair: number[]; lemire_1_4_after_pair: number; doubles: number[] }[];
  samples: Sample[];
  disease_samples: DiseaseSample[];
}
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const fixture = JSON.parse(read("./__fixtures__/joint-v2.json").toString()) as Fixture;
const meta = JSON.parse(read("../public/models/joint-v2/model.json").toString()) as JointModelMeta;
const weights = read("../public/models/joint-v2/weights.bin");
const model = parseJointModel(meta, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength));
const maxAbs = (a: number[], b: number[]) => Math.max(...a.map((v, i) => Math.abs(v - b[i]!)));
const RECIPE_KEYS = ["severity", "size", "spread", "irregularity", "contrast"] as const;

/** The flow's output and the recipes decoded from it, against the fixture's: a worst-case per stage, the discrete
 *  outcomes (seeds, condition, band, count) exact. */
function replay(sample: Sample | DiseaseSample, worst: Record<string, number>) {
  const disease = sample.profile_id ? (sample as DiseaseSample) : null;
  const ours = sampleJointControls(model, sample.template_id, sample.profile_id, sample.seed, sample.temperature, disease?.severity ?? "auto");
  expect(ours.condition).toBe(sample.condition);
  expect(ours.rendererSeeds).toEqual(sample.renderer_seeds);
  expect(ours.z).toEqual(sample.z);
  worst.warped = Math.max(worst.warped!, maxAbs(ours.warped, sample.warped));
  worst.flow = Math.max(worst.flow!, maxAbs(ours.flowValues, sample.flow_values));
  const names = Object.keys(sample.controls);
  expect(Object.keys(ours.controls)).toEqual(names);
  worst.controls = Math.max(worst.controls!, maxAbs(names.map((n) => ours.controls[n]!), names.map((n) => sample.controls[n]!)));
  const recipe = ours.material as unknown as Record<string, unknown>;
  expect(Object.keys(recipe)).toEqual(Object.keys(sample.material));
  for (const [key, value] of Object.entries(sample.material)) {
    if (typeof value === "number" && key !== "seed") worst.material = Math.max(worst.material!, Math.abs((recipe[key] as number) - value) / Math.max(1, Math.abs(value)));
    else expect(recipe[key]).toBe(value);
  }
  // the API's flow output replayed from the API's own warped draws: the arithmetic alone
  const replayed = flowInverse(model, sample.warped, model.meta.conditions[sample.condition]!, disease?.severity_id ?? 0);
  expect(maxAbs(Array.from(replayed), sample.flow_values)).toBeLessThan(5e-5);
  if (!disease) { expect(ours.disease).toBeNull(); expect(ours.severityId).toBe(0); return; }
  expect(ours.severityId).toBe(disease.severity_id);
  expect(ours.severity).toBe(JOINT_SEVERITIES[disease.severity_id]);
  worst.flowControls = Math.max(worst.flowControls!, maxAbs(ours.flowControls, disease.flow_controls));
  const theirs = disease.disease, mine = ours.disease as unknown as Record<string, unknown>;
  expect(Object.keys(mine)).toEqual(Object.keys(theirs));
  for (const key of ["profile_id", "seed", "count"]) expect(mine[key]).toBe(theirs[key]);
  expect(mine.seed).toBe(sample.renderer_seeds[1]);
  worst.recipe = Math.max(worst.recipe!, maxAbs([...RECIPE_KEYS.map((k) => mine[k] as number), ...(mine.location as number[])], [...RECIPE_KEYS.map((k) => theirs[k] as number), ...(theirs.location as number[])]));
}

describe("numpy's generator in the browser", () => {
  it("matches PCG64's raw outputs, uint32 halves, Lemire draws and doubles for every fixture seed", () => {
    for (const row of fixture.rng) {
      const raw = new Pcg64(row.seed);
      expect([raw.nextUint64(), raw.nextUint64(), raw.nextUint64()].map(String)).toEqual(row.raw_uint64);
      const fresh = new Pcg64(row.seed);
      expect(fresh.uint32s(2)).toEqual(row.uint32_pair);
      expect(fresh.integers(1, 4)).toBe(row.lemire_1_4_after_pair);
      expect(new Pcg64(row.seed).uniform(0, 1, 4)).toEqual(row.doubles);
    }
  });
});

describe("the joint flow in the browser", () => {
  it("is the exported active model", () => {
    expect(model.meta.model_sha256).toBe(fixture.model_sha256);
    expect(model.meta.config).toMatchObject({ layers: 6, bins: 8, blocks: 2, hidden: 96 });
    expect(model.meta.severity_names).toEqual([...JOINT_SEVERITIES]);
  });
  it("replays the API's healthy samples: seeds and uniforms exactly, the flow and recipe within float32 rounding", () => {
    const worst = { warped: 0, flow: 0, controls: 0, material: 0 };
    for (const sample of fixture.samples) replay(sample, worst);
    console.log(`joint flow vs API (${fixture.samples.length} healthy samples): warped ≤ ${worst.warped.toExponential(2)}, flow ≤ ${worst.flow.toExponential(2)}, controls ≤ ${worst.controls.toExponential(2)}, recipe rel ≤ ${worst.material.toExponential(2)}`);
    expect(worst.warped).toBeLessThan(2e-6);
    expect(worst.flow).toBeLessThan(5e-5);
    expect(worst.controls).toBeLessThan(5e-5);
    expect(worst.material).toBeLessThan(5e-5);
  });
  it("replays the API's disease samples: the band, the count and the spatial seed exactly, the recipe within float32 rounding", () => {
    const worst = { warped: 0, flow: 0, controls: 0, material: 0, flowControls: 0, recipe: 0 };
    for (const sample of fixture.disease_samples) replay(sample, worst);
    // every band both drawn and requested, several counts: the discrete branches of from_flow_controls are exercised
    expect(new Set(fixture.disease_samples.map((s) => `${s.severity}:${s.severity_id}`))).toEqual(new Set(["auto:1", "auto:2", "auto:3", "mild:1", "moderate:2", "severe:3"]));
    expect(new Set(fixture.disease_samples.map((s) => s.disease.count)).size).toBeGreaterThanOrEqual(3);
    console.log(`joint flow vs API (${fixture.disease_samples.length} disease samples): flow ≤ ${worst.flow.toExponential(2)}, from_flow_controls ≤ ${worst.flowControls.toExponential(2)}, controls ≤ ${worst.controls.toExponential(2)}, material rel ≤ ${worst.material.toExponential(2)}, disease recipe ≤ ${worst.recipe.toExponential(2)}`);
    expect(worst.flow).toBeLessThan(5e-5);
    expect(worst.flowControls).toBeLessThan(5e-5);
    expect(worst.controls).toBeLessThan(5e-5);
    expect(worst.material).toBeLessThan(5e-5);
    expect(worst.recipe).toBeLessThan(5e-5);
  });
  it("refuses what the API refuses", () => {
    const template = fixture.samples[0]!.template_id, disease = fixture.disease_samples[0]!;
    expect(() => sampleJointControls(model, "no-such-template", null, 1, 1)).toThrow(/absent/);
    expect(() => sampleJointControls(model, template, "no-such-profile", 1, 1)).toThrow(/absent/);
    expect(() => sampleJointControls(model, template, null, 1, 1, "severe")).toThrow(/severity band/);
    expect(() => sampleJointControls(model, disease.template_id, disease.profile_id, 1, 1, "baseline")).toThrow(/mild, moderate or severe/);
    expect(() => sampleJointControls(model, template, null, -1, 1)).toThrow(/seed/);
    expect(() => sampleJointControls(model, template, null, 1, 2)).toThrow(/temperature/);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
import fs from "node:fs";
import path from "node:path";
import { primeJointModel, sampleJointLocally } from "./atlasJointLocal";
import { parseDiseaseSupport, primeDiseaseSupport, type DiseaseSupportIndex } from "./atlasDiseaseLocal";
import { validateAtlasGeneration, validateAtlasJointSampling, type AtlasCatalog, type AtlasGeneration, type AtlasSpec, type AtlasTemplate } from "./atlas";

/** The disease renderer's bundled support for a template, read from disk: Node has no base URL for publicUrl. */
function primeSupportFromDisk(templateId: string): void {
  const index = JSON.parse(read("../public/models/disease-v2/index.json").toString()) as DiseaseSupportIndex;
  const entry = index.templates[templateId]!, bytes = read(`../public/models/disease-v2/${entry.file}`);
  primeDiseaseSupport(templateId, parseDiseaseSupport(entry, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
}

const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES ?? path.resolve(process.cwd(), "datasets/atlas/cohort-v2/templates");
const post = async (route: string, body: unknown) => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
};
type Severity = "auto" | "mild" | "moderate" | "severe";
const PROVENANCE_KEYS = ["method", "model_sha256", "bundle_sha256", "material_seed", "renderer_seeds", "request_seed", "temperature", "model_generation", "severity", "profile_id", "spatial_seed", "request_severity_band", "template_id"];

describe.skipIf(!online)("the browser joint flow against the API's route", () => {
  let catalog: AtlasCatalog;
  /** The request the studio sends, with the API's own rendering of the template as the bundled reference. */
  const prepare = async (templateId: string, profileId: string | null, seed: number) => {
    catalog ??= (await fetch(`${API}/api/atlas/catalog`).then((r) => r.json())) as AtlasCatalog;
    expect(catalog.renderer_version).toBe("disease-v2");
    const organ = catalog.organs.find((o) => o.templates.some((t) => t.id === templateId))!;
    const template = { ...organ.templates.find((t) => t.id === templateId)! } as AtlasTemplate;
    template.normalization_mm = JSON.parse(fs.readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8")).normalization_mm;
    const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: templateId, seed, controls: Object.fromEntries(catalog.controls.map((c) => [c.key, c.default])), appearance: "tissue", material: { ...catalog.materials!.defaults[organ.id]! } };
    if (profileId) spec.disease = { ...catalog.diseases!.defaults[organ.id]!, profile_id: profileId };
    const reference = (await post("/api/atlas/generate", { ...spec, seed: 42, disease: null })) as AtlasGeneration;
    return { template, spec, reference };
  };
  const compare = (api: AtlasGeneration, ours: AtlasGeneration) => {
    const names = Object.keys(api.spec.controls);
    expect(Object.keys(ours.spec.controls)).toEqual(names);
    expect(maxAbs(names.map((n) => ours.spec.controls[n]!), names.map((n) => api.spec.controls[n]!))).toBeLessThan(1e-6);
    const apiMaterial = api.spec.material as unknown as Record<string, number | string>, ourMaterial = ours.spec.material as unknown as Record<string, number | string>;
    for (const key of Object.keys(apiMaterial)) {
      if (typeof apiMaterial[key] === "number" && key !== "seed") expect(Math.abs((ourMaterial[key] as number) - (apiMaterial[key] as number))).toBeLessThan(1e-6 * Math.max(1, Math.abs(apiMaterial[key] as number)));
      else expect(ourMaterial[key]).toBe(apiMaterial[key]);
    }
    const provenance = ours.summary.joint_model as Record<string, unknown>, theirs = api.summary.joint_model as Record<string, unknown>;
    for (const key of PROVENANCE_KEYS) expect(provenance[key], key).toEqual(theirs[key]);
    return maxAbs(ours.scene.organs[0]!.positions, api.scene.organs[0]!.positions);
  };

  it("samples the same controls, recipe and geometry as /api/atlas/sample-joint for the healthy baseline", async () => {
    primeJointModel(model);
    for (const [templateId, seed, temperature] of [["hra-liver-female", 7, 0.8], ["hra-liver-female", 42, 1.0], ["bp3d-stomach-male", 1729, 1.5]] as const) {
      primeSupportFromDisk(templateId);   // a healthy disease-v2 spec is realized by the disease renderer too (realizeSpecLocally)
      const { template, spec, reference } = await prepare(templateId, null, seed);
      const api = (await post("/api/atlas/sample-joint", { spec, seed, temperature })) as AtlasGeneration;
      const ours = await sampleJointLocally(reference, template, spec, temperature, "auto");
      const positions = compare(api, ours);
      expect(positions).toBeLessThan(1e-4);
      console.log(`${templateId} seed ${seed} T ${temperature}: controls, recipe and provenance agree; positions within ${positions.toExponential(2)} mm`);
    }
  }, 120_000);

  it("samples the same disease recipe and morphology as /api/atlas/sample-joint for a disease condition", async () => {
    primeJointModel(model);
    const cases: [string, string, number, number, Severity][] = [
      ["hra-liver-female", "liver-cirrhosis", 7, 0.8, "auto"], ["hra-liver-female", "liver-hcc", 42, 1.0, "severe"],
      ["hra-kidney-male-left", "kidney-cancer", 1729, 1.0, "mild"], ["bp3d-gallbladder-male", "gallbladder-carcinoma", 99, 1.2, "moderate"],
    ];
    for (const [templateId, profileId, seed, temperature, severity] of cases) {
      primeSupportFromDisk(templateId);
      const { template, spec, reference } = await prepare(templateId, profileId, seed);
      const api = (await post("/api/atlas/sample-joint", { spec, seed, temperature, severity })) as AtlasGeneration;
      const ours = await sampleJointLocally(reference, template, spec, temperature, severity, catalog.diseases);
      const positions = compare(api, ours);
      const theirs = api.spec.disease as unknown as Record<string, unknown>, mine = ours.spec.disease as unknown as Record<string, unknown>;
      expect(Object.keys(mine)).toEqual(Object.keys(theirs));
      for (const key of ["profile_id", "seed", "count"]) expect(mine[key], key).toBe(theirs[key]);
      const recipe = maxAbs([...RECIPE_KEYS.map((k) => mine[k] as number), ...(mine.location as number[])], [...RECIPE_KEYS.map((k) => theirs[k] as number), ...(theirs.location as number[])]);
      expect(recipe).toBeLessThan(1e-6);
      // the realized morphology, as the UI reads it
      const apiDisease = api.summary.disease as Record<string, unknown>, ourDisease = ours.summary.disease as Record<string, unknown>;
      for (const key of ["requested_sites", "realized_sites", "displacement_limited_by_source_mesh", "actual_strength_backoffs"]) expect(ourDisease[key], key).toEqual(apiDisease[key]);
      expect(Math.abs((ourDisease.applied_displacement_fraction as number) - (apiDisease.applied_displacement_fraction as number))).toBeLessThan(1e-9);
      expect(Math.abs((ourDisease.max_displacement_mm as number) - (apiDisease.max_displacement_mm as number))).toBeLessThan(1e-4);
      // the studio's own checks accept the browser result in the API's place
      validateAtlasGeneration(ours, catalog);
      validateAtlasJointSampling(spec, ours, temperature, severity);
      expect(positions).toBeLessThan(1e-4);
      console.log(`${templateId} ${profileId} seed ${seed} T ${temperature} ${severity} → ${(ours.summary.joint_model as { severity: string }).severity}: recipe within ${recipe.toExponential(2)}, positions within ${positions.toExponential(2)} mm`);
    }
  }, 180_000);
});
