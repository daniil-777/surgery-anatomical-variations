/** The browser material sampler against the API's own samples (src/__fixtures__/material-v1.json, written by
 *  scripts/export_material_web.py from the model the API serves): numpy's draws and the training rows they pick
 *  exactly; the ridge arithmetic, the recipes and the material field at sample points bit for bit (the bounds allow
 *  float64 rounding, which libm may add elsewhere); the field statistics the route measures at its anchor surfaces to
 *  float64 rounding; the refusals word for word. Then against the running API (VISCERA_API_URL, default
 *  http://127.0.0.1:8000): the recipe, the realized surface with its vertex colours and uniforms, and the provenance
 *  of POST /api/atlas/sample-material, legacy and disease-v2 specs, the two repaired references and diseased specimens
 *  included. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sameAtlasRecipe, validateAtlasGeneration, type AtlasCatalog, type AtlasGeneration, type AtlasSpec, type AtlasTemplate } from "./atlas";
import { parseDiseaseSupport, primeDiseaseSupport, type DiseaseSupportIndex } from "./atlasDiseaseLocal";
import { resolveMaterial } from "./atlasLocal";
import type { AtlasMaterialPreset, AtlasMaterialRecipe } from "./atlasMaterial";
import {
  MATERIAL_CONDITION_NAMES, MATERIAL_CONTROL_NAMES, MATERIAL_SAMPLER_MESSAGES, MATERIAL_SAMPLING, MEASUREMENT_SCOPE, measureMaterial, outsideSupport,
  parseMaterialModel, primeMaterialModel, proposeMaterialRecipe, sampleMaterialField, sampleMaterialLocally, sampleMaterialRecipe,
  type MaterialModelMeta, type MaterialModelProvenance,
} from "./atlasMaterialSampler";

interface FixtureCase {
  organ: string; preset: AtlasMaterialPreset; seed: number; conditions: Record<string, number> | null; error?: string;
  draws?: number[]; rows?: number[]; target?: number[]; mean?: number[];
  proposal?: { recipe: AtlasMaterialRecipe; normalized_controls: number[]; sampling: string; geometry_modified: boolean; material_prior: string; empirical_tissue_distribution: boolean };
  anchor_template?: string; measured_controls?: number[]; measured?: number[];
}
interface FieldCase {
  recipe: AtlasMaterialRecipe; points: number[]; regions: number[]; footprint: number[];
  rgb_linear: number[]; rgb_srgb: number[]; roughness: number[]; height_mm: number[]; gradient: number[]; uniforms: Record<string, number | number[]>;
}
interface Fixture { model_sha256: string; numpy: string; python: string; condition_names: string[]; dataset_release_sha256: string; cases: FixtureCase[]; fields: FieldCase[] }

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url));
const fixture = JSON.parse(read("./__fixtures__/material-v1.json").toString()) as Fixture;
const meta = JSON.parse(read("../public/models/material-v1/model.json").toString()) as MaterialModelMeta;
const weights = read("../public/models/material-v1/weights.bin");
const model = parseMaterialModel(meta, weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength) as ArrayBuffer);
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { expect(a.length).toBe(b.length); let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!)); return worst; };
const maxRel = (a: ArrayLike<number>, b: ArrayLike<number>) => { expect(a.length).toBe(b.length); let worst = 0; for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!) / Math.max(Math.abs(b[i]!), 1e-300)); return worst; };
const bitEqual = (a: ArrayLike<number>, b: ArrayLike<number>) => a.length === b.length && Array.from(a).every((v, i) => Object.is(v, b[i]));
const recipeNumbers = (recipe: AtlasMaterialRecipe) => MATERIAL_CONTROL_NAMES.map((name) => recipe[name]);

describe("the exported material sampler", () => {
  it("is the model the API serves, with its release's anchor surfaces", () => {
    expect(meta.model_sha256).toBe(fixture.model_sha256);
    expect(meta.dataset.release_sha256).toBe(fixture.dataset_release_sha256);
    expect(fixture.condition_names).toEqual([...MATERIAL_CONDITION_NAMES]);
    expect(meta.groups.length).toBe(48);
    expect(model.groupRows.every((rows) => rows.length === 10)).toBe(true);
    expect(meta.training_rows).toBe(480);
    expect(meta.anchors.length).toBe(24);
    expect(meta.anchor_points).toBe(1024);
    expect(meta.templates.map((t) => t.id).sort()).toEqual(meta.anchors.map((a) => a.id).sort());
    // the served model and the packaged default are both recorded; both are the ridge prior of this release
    expect(meta.default_model?.selected).toBe("ridge");
    expect(meta.default_model?.dataset_release_sha256).toBe(meta.dataset.release_sha256);
    console.log(`material sampler: ${meta.model_source} (${meta.model_sha256.slice(0, 12)}…), packaged default ${meta.default_model?.path} (${meta.default_model?.sha256.slice(0, 12)}…); numpy ${fixture.numpy}, python ${fixture.python}`);
  });
  it("refuses a malformed export", () => {
    const bytes = weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength) as ArrayBuffer;
    expect(() => parseMaterialModel({ ...meta, format: "other" }, bytes)).toThrow(/Unsupported/);
    expect(() => parseMaterialModel(meta, bytes.slice(8))).toThrow(/layout/);
    expect(() => parseMaterialModel({ ...meta, condition_names: [...meta.condition_names].reverse() }, bytes)).toThrow(/schema/);
  });
});

describe("the ridge proposal in the browser", () => {
  it("replays the API's proposals: draws and rows exactly, the ridge arithmetic and the recipes bit for bit", () => {
    const worst = { target: 0, mean: 0, controls: 0, recipe: 0 };
    let proposals = 0, conditional = 0, redrawn = 0, bitExact = 0;
    for (const sample of fixture.cases) {
      if (sample.error !== undefined) continue;
      const { proposal, draws } = proposeMaterialRecipe(model, sample.organ, sample.preset, sample.seed, sample.conditions);
      const theirs = sample.proposal!;
      expect(draws.draws).toEqual(sample.draws);
      expect(draws.rows).toEqual(sample.rows);
      if (sample.conditions) {
        conditional++;
        if (draws.draws.length > 1) redrawn++;
        worst.target = Math.max(worst.target, maxAbs(draws.target!, sample.target!));
        worst.mean = Math.max(worst.mean, maxAbs(draws.mean!, sample.mean!));
      } else expect(draws.target).toBeNull();
      worst.controls = Math.max(worst.controls, maxAbs(proposal.normalized_controls, theirs.normalized_controls));
      worst.recipe = Math.max(worst.recipe, maxAbs(recipeNumbers(proposal.recipe), recipeNumbers(theirs.recipe)));
      if (bitEqual(recipeNumbers(proposal.recipe), recipeNumbers(theirs.recipe)) && bitEqual(proposal.normalized_controls, theirs.normalized_controls)) bitExact++;
      expect(Object.keys(proposal.recipe)).toEqual(Object.keys(theirs.recipe));
      for (const key of ["version", "organ", "preset", "seed"] as const) expect(proposal.recipe[key]).toBe(theirs.recipe[key]);
      expect([proposal.sampling, proposal.geometry_modified, proposal.material_prior, proposal.empirical_tissue_distribution]).toEqual([theirs.sampling, theirs.geometry_modified, theirs.material_prior, theirs.empirical_tissue_distribution]);
      expect(proposal.sampling).toBe(sample.conditions ? MATERIAL_SAMPLING.conditional : MATERIAL_SAMPLING.bootstrap);
      expect(proposal.requested_conditions).toEqual(sample.conditions ?? {});
      expect(proposal.dataset_release_sha256).toBe(fixture.dataset_release_sha256);
      proposals++;
    }
    console.log(`material proposals vs API (${proposals}: ${conditional} with requested statistics, ${redrawn} redrawn out of bounds): draws and rows equal; group targets ≤ ${worst.target.toExponential(2)}, ridge means ≤ ${worst.mean.toExponential(2)}, controls ≤ ${worst.controls.toExponential(2)}, recipes ≤ ${worst.recipe.toExponential(2)}; ${bitExact}/${proposals} recipes bit for bit`);
    expect(proposals).toBe(432);
    // closed-form float64 in numpy's order (the fused multiply-adds of its matmul included): rounding at most
    expect(worst.target).toBeLessThan(1e-15);
    expect(worst.mean).toBeLessThan(1e-15);
    expect(worst.controls).toBeLessThan(1e-15);
    expect(worst.recipe).toBeLessThan(1e-13);
  });
  it("measures each recipe's field statistics at the route's anchor surface as the API does", () => {
    let worstControls = 0, worstStatistics = 0, bitExact = 0, count = 0;
    for (const sample of fixture.cases) {
      if (sample.error !== undefined) continue;
      const recipe = sample.proposal!.recipe;
      const anchors = meta.anchors.filter((a) => a.organ === sample.organ).map((a) => a.id).sort();
      expect(sample.anchor_template).toBe(anchors[0]);
      // a reference of the organ without an anchor surface of its own falls back to the first; with one, its own
      const fallback = measureMaterial(model, "no-anchor-of-its-own", sample.organ, recipe);
      expect(fallback.anchor_template).toBe(sample.anchor_template);
      expect(measureMaterial(model, anchors.at(-1)!, sample.organ, recipe).anchor_template).toBe(anchors.at(-1));
      worstControls = Math.max(worstControls, maxAbs(fallback.controls, sample.measured_controls!));
      worstStatistics = Math.max(worstStatistics, maxRel(fallback.statistics, sample.measured!));
      if (bitEqual(fallback.statistics, sample.measured!)) bitExact++;
      count++;
    }
    console.log(`anchor-surface statistics vs API (${count} recipes × 1024 points): round-tripped controls ≤ ${worstControls.toExponential(2)}, statistics ≤ ${worstStatistics.toExponential(2)} relative; ${bitExact}/${count} bit for bit`);
    // recipe_controls takes the pattern size back through log: V8's Math.log and the API's libm part in the last bit for
    // a few per cent of arguments, which reaches the statistics as float64 rounding
    expect(worstControls).toBeLessThan(1e-14);
    expect(worstStatistics).toBeLessThan(1e-12);
  });
  it("refuses what the API refuses, word for word", () => {
    const refusals = fixture.cases.filter((c) => c.error !== undefined);
    expect(refusals.length).toBe(5);
    for (const sample of refusals) expect(() => proposeMaterialRecipe(model, sample.organ, sample.preset, sample.seed, sample.conditions)).toThrow(sample.error!);
    expect(() => proposeMaterialRecipe(model, "kidney", "rich", 7, { height_rms_mm: Infinity })).toThrow(outsideSupport("height_rms_mm"));
    expect(() => proposeMaterialRecipe(model, "kidney", "rich", 7, { height_rms_mm: Number.NaN })).toThrow(outsideSupport("height_rms_mm"));
    expect(() => proposeMaterialRecipe(model, "kidney", "rich", -1)).toThrow(MATERIAL_SAMPLER_MESSAGES.seed);
    const kidney: AtlasMaterialRecipe = { version: "atlas-material-2.0.0", organ: "kidney", preset: "balanced", seed: 1, tint: 0, pigment_contrast: 0.5, mottle_scale_mm: 16, wetness: 0.5, fine_detail: 0.5, structure_strength: 0.3 };
    expect(() => sampleMaterialRecipe(model, "hra-liver-female", kidney, 1)).toThrow(MATERIAL_SAMPLER_MESSAGES.organ);
    expect(() => sampleMaterialRecipe(model, "no-such-template", null, 1)).toThrow("Template no-such-template is unavailable");
    // an empty request is no request: the bootstrap, as `if conditions:` reads it
    expect(proposeMaterialRecipe(model, "liver", "balanced", 42, {}).proposal.sampling).toBe(MATERIAL_SAMPLING.bootstrap);
  });
});

describe("the material field in the browser", () => {
  it("evaluates sample_material at anchor points and ligament vertices, with and without a sampling footprint", () => {
    const worst = { colour: 0, srgb: 0, roughness: 0, height: 0, gradient: 0, uniforms: 0 };
    let ligament = 0, footprints = 0;
    for (const field of fixture.fields) {
      const ours = sampleMaterialField(field.recipe, field.points, field.regions, field.footprint);
      worst.colour = Math.max(worst.colour, maxAbs(ours.rgbLinear, field.rgb_linear));
      worst.srgb = Math.max(worst.srgb, maxAbs(ours.rgbSrgb, field.rgb_srgb));
      worst.roughness = Math.max(worst.roughness, maxAbs(ours.roughness, field.roughness));
      worst.height = Math.max(worst.height, maxAbs(ours.heightMm, field.height_mm));
      worst.gradient = Math.max(worst.gradient, maxAbs(ours.gradient, field.gradient));
      const uniforms = (resolveMaterial(field.recipe) as { uniforms: Record<string, number | number[]> }).uniforms;
      expect(Object.keys(uniforms).sort()).toEqual(Object.keys(field.uniforms).sort());
      for (const [key, value] of Object.entries(field.uniforms)) worst.uniforms = Math.max(worst.uniforms, maxAbs([uniforms[key]!].flat(), [value].flat()));
      ligament += field.regions.filter((r) => r === 1).length;
      footprints += field.footprint.filter((f) => f > 0).length;
    }
    console.log(`material field vs API (${fixture.fields.length} recipes, ${ligament} ligament points, ${footprints} attenuated): linear colour ≤ ${worst.colour.toExponential(2)}, sRGB ≤ ${worst.srgb.toExponential(2)}, roughness ≤ ${worst.roughness.toExponential(2)}, height ≤ ${worst.height.toExponential(2)} mm, gradient ≤ ${worst.gradient.toExponential(2)}, uniforms ≤ ${worst.uniforms.toExponential(2)}`);
    expect(ligament).toBeGreaterThan(0);
    expect(footprints).toBeGreaterThan(0);
    for (const value of Object.values(worst)) expect(value).toBeLessThan(1e-12);
  });
  it("refuses points, regions and footprints the API refuses", () => {
    const recipe = fixture.fields[0]!.recipe;
    expect(() => sampleMaterialField(recipe, [0, 0])).toThrow(MATERIAL_SAMPLER_MESSAGES.points);
    expect(() => sampleMaterialField(recipe, [0, 0, 200001])).toThrow(MATERIAL_SAMPLER_MESSAGES.points);
    expect(() => sampleMaterialField(recipe, [0, 0, 0], [1.5])).toThrow(MATERIAL_SAMPLER_MESSAGES.regions);
    expect(() => sampleMaterialField(recipe, [0, 0, 0], [0], -1)).toThrow(MATERIAL_SAMPLER_MESSAGES.footprint);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES ?? path.resolve(process.cwd(), "datasets/atlas/cohort-v2/templates");
const request = async (route: string, body: unknown): Promise<{ status: number; body: unknown }> => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const post = async (route: string, body: unknown) => {
  const r = await request(route, body);
  if (r.status !== 200) throw new Error(`${route}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
};
/** The median of a group's training statistic: a request inside the observed support. */
const groupMedian = (organ: string, preset: string, name: string) => {
  const rows = model.groupRows[meta.groups.indexOf(`${organ}|${preset}`)]!, j = MATERIAL_CONDITION_NAMES.indexOf(name as never);
  const values = rows.map((row) => model.trainConditions[row * 8 + j]!).sort((a, b) => a - b);
  return (values[4]! + values[5]!) / 2;
};

describe.skipIf(!online)("the browser material sampler against the API's route", () => {
  it("samples the same recipe, surface, colours, uniforms and provenance as /api/atlas/sample-material", { timeout: 900_000 }, async () => {
    primeMaterialModel(model);
    const catalog = await fetch(`${API}/api/atlas/catalog`).then((r) => r.json()) as AtlasCatalog;
    const zero = Object.fromEntries(catalog.controls.map((c) => [c.key, c.default])) as Record<string, number>;
    // the disease-v2 renderer reads its template's bundled support files; node has no page to fetch them from
    const supportIndex = JSON.parse(read("../public/models/disease-v2/index.json").toString()) as DiseaseSupportIndex;
    const primeSupport = (templateId: string) => {
      const entry = supportIndex.templates[templateId]!, bytes = read(`../public/models/disease-v2/${entry.file}`);
      primeDiseaseSupport(templateId, parseDiseaseSupport(entry, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    };
    type Case = [templateId: string, v2: boolean, preset: AtlasMaterialPreset, seed: number, conditions?: ((organ: string, preset: string) => Record<string, number>) | undefined, profileId?: string];
    const cases: Case[] = [
      ["hra-liver-female", false, "balanced", 42], ["hra-liver-female", true, "rich", 7],
      ["hra-liver-female", true, "balanced", 1729, (o, p) => ({ roughness_mean: groupMedian(o, p, "roughness_mean") })],
      ["bp3d-stomach-male", false, "soft", 0], ["bp3d-gallbladder-male", true, "moist", 2 ** 32 - 1],
      ["hra-heart-male", false, "balanced", 99], ["hra-heart-male", true, "rich", 99],
      ["hra-urinary-bladder-male", true, "soft", 5], ["hra-urinary-bladder-male", false, "moist", 5],
      ["hra-pancreas-male", true, "balanced", 11],
      ["hra-lung-female", true, "moist", 3, (o, p) => ({ mean_red_linear: groupMedian(o, p, "mean_red_linear"), height_rms_mm: groupMedian(o, p, "height_rms_mm") })],
      ["hra-kidney-male-left", true, "rich", 21, undefined, "kidney-cancer"], ["hra-liver-male", true, "balanced", 8, undefined, "liver-cirrhosis"],
      ["hra-brain-male", true, "balanced", 42],
    ];
    const worst = { recipe: 0, positions: 0, colours: 0, uniforms: 0, statistics: 0 };
    for (const [templateId, v2, preset, seed, makeConditions, profileId] of cases) {
      const organ = catalog.organs.find((o) => o.templates.some((t) => t.id === templateId))!;
      const template = { ...organ.templates.find((t) => t.id === templateId)!, normalization_mm: JSON.parse(readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8")).normalization_mm } as AtlasTemplate;
      const defaults = catalog.materials!.defaults[organ.id]!;
      // the displayed reference: the template's default specimen, as the public copy bundles it
      const base: AtlasSpec = { ...(v2 ? { renderer_version: "disease-v2" as const } : {}), template_id: templateId, seed: 42, controls: zero, appearance: "tissue", material: { ...defaults } };
      const reference = (await post("/api/atlas/generate", base)) as AtlasGeneration;
      // the studio sends the displayed, bound spec with the edited surface (and the displayed disease, if any)
      const spec: AtlasSpec = { ...base, template_sha256: reference.spec.template_sha256, material: { ...defaults, preset, seed }, ...(profileId ? { disease: { ...catalog.diseases!.defaults[organ.id]!, profile_id: profileId } } : {}) };
      const conditions = makeConditions?.(organ.id, preset);
      const api = (await post("/api/atlas/sample-material", { spec, seed, ...(conditions ? { conditions } : {}) })) as AtlasGeneration;
      if (v2) primeSupport(templateId);
      const started = performance.now();
      const ours = await sampleMaterialLocally(reference, template, spec, seed, conditions, catalog.diseases);
      const elapsed = performance.now() - started;
      // the studio's own checks accept the browser result in the API's place
      validateAtlasGeneration(ours, catalog);
      expect(sameAtlasRecipe({ ...spec, material: null }, { ...ours.spec, material: null })).toBe(true);
      expect([ours.spec.material?.organ, ours.spec.material?.preset, ours.spec.material?.seed]).toEqual([spec.material?.organ, spec.material?.preset, spec.material?.seed]);
      // the spec, key for key
      expect(Object.keys(ours.spec).filter((k) => k !== "realized_id").sort()).toEqual(Object.keys(api.spec).filter((k) => k !== "realized_id").sort());
      for (const key of ["renderer_version", "template_id", "seed", "appearance", "template_sha256", "controls", "disease"]) expect(ours.spec[key]).toEqual(api.spec[key]);
      const ourRecipe = ours.spec.material!, apiRecipe = api.spec.material!;
      expect(Object.keys(ourRecipe)).toEqual(Object.keys(apiRecipe));
      for (const key of ["version", "organ", "preset", "seed"] as const) expect(ourRecipe[key]).toBe(apiRecipe[key]);
      const recipe = maxAbs(recipeNumbers(ourRecipe), recipeNumbers(apiRecipe));
      // the surface, its colours and the shader's uniforms
      const a = api.scene.organs[0]!, o = ours.scene.organs[0]!;
      const positions = maxAbs(o.positions, a.positions), colours = maxAbs(o.colors!, a.colors!);
      // a surface-only sample keeps the displayed geometry's identity, which the studio checks (surfaceOnly): the same
      // doubles hash the same way as the API's (a diseased specimen is compared with the browser's own realization)
      const geometryOf = (g: AtlasGeneration) => (g.scene.metadata as { geometry_sha256: string }).geometry_sha256;
      if (!profileId) expect(geometryOf(ours)).toBe(geometryOf(reference));
      const uniformsOf = (g: AtlasGeneration) => (g.scene.metadata as { material_v2: { resolved: { uniforms: Record<string, number | number[]> } } }).material_v2.resolved.uniforms;
      const apiUniforms = uniformsOf(api), ourUniforms = uniformsOf(ours);
      let uniforms = 0;
      for (const [key, value] of Object.entries(apiUniforms)) uniforms = Math.max(uniforms, maxAbs([ourUniforms[key]!].flat(), [value].flat()));
      // the provenance, field by field
      const theirs = api.summary.material_model as MaterialModelProvenance, mine = ours.summary.material_model as MaterialModelProvenance & { sampled_by: unknown };
      expect((ours.scene.metadata as Record<string, unknown>).material_model).toBe(mine);
      expect(Object.keys(mine).filter((k) => k !== "sampled_by")).toEqual(Object.keys(theirs));
      for (const key of ["sampling", "geometry_modified", "material_prior", "dataset_release_sha256", "empirical_tissue_distribution", "model_sha256", "measured_anchor_template", "measured_anchor_template_sha256", "condition_status", "measurement_scope"] as const) expect(mine[key]).toEqual(theirs[key]);
      expect(mine.measurement_scope).toBe(MEASUREMENT_SCOPE);
      expect(mine.recipe).toEqual(ourRecipe);
      expect(maxAbs(recipeNumbers(mine.recipe), recipeNumbers(theirs.recipe))).toBe(recipe);
      expect(maxAbs(mine.normalized_controls, theirs.normalized_controls)).toBeLessThan(1e-15);
      expect(mine.requested_conditions).toEqual(theirs.requested_conditions);
      expect(Object.keys(mine.measured_field_statistics)).toEqual(Object.keys(theirs.measured_field_statistics));
      const statistics = maxRel(Object.values(mine.measured_field_statistics), Object.values(theirs.measured_field_statistics));
      expect(Object.keys(mine.condition_errors)).toEqual(Object.keys(theirs.condition_errors));
      expect(maxAbs(Object.values(mine.condition_errors), Object.values(theirs.condition_errors))).toBeLessThan(1e-12);
      worst.recipe = Math.max(worst.recipe, recipe); worst.positions = Math.max(worst.positions, positions); worst.colours = Math.max(worst.colours, colours);
      worst.uniforms = Math.max(worst.uniforms, uniforms); worst.statistics = Math.max(worst.statistics, statistics);
      console.log(`${templateId}${v2 ? " (disease-v2)" : ""}${profileId ? ` ${profileId}` : ""} ${preset} seed ${seed}${conditions ? ` with ${Object.keys(conditions).join(", ")}` : ""}: recipe within ${recipe.toExponential(2)}, positions ${positions.toExponential(2)} mm, colours ${colours.toExponential(2)} (${a.colors!.length / 3} vertices), uniforms ${uniforms.toExponential(2)}, statistics ${statistics.toExponential(2)} relative; ${elapsed.toFixed(0)} ms`);
    }
    expect(worst.recipe).toBeLessThan(1e-9);
    expect(worst.positions).toBeLessThan(1e-6);
    expect(worst.colours).toBeLessThan(1e-9);
    expect(worst.uniforms).toBeLessThan(1e-9);
    expect(worst.statistics).toBeLessThan(1e-9);
  });
  it("refuses requested statistics outside the training support as the API does", async () => {
    primeMaterialModel(model);
    const catalog = await fetch(`${API}/api/atlas/catalog`).then((r) => r.json()) as AtlasCatalog;
    const zero = Object.fromEntries(catalog.controls.map((c) => [c.key, c.default])) as Record<string, number>;
    const spec: AtlasSpec = { template_id: "hra-liver-female", seed: 42, controls: zero, appearance: "tissue", material: { ...catalog.materials!.defaults.liver! } };
    const reference = (await post("/api/atlas/generate", spec)) as AtlasGeneration;
    const template = catalog.organs.find((o) => o.id === "liver")!.templates.find((t) => t.id === "hra-liver-female")!;
    for (const conditions of [{ roughness_mean: 5 }, { colour: 0.1 }]) {
      const api = await request("/api/atlas/sample-material", { spec, seed: 7, conditions });
      expect(api.status).toBe(422);
      await expect(sampleMaterialLocally(reference, template, spec, 7, conditions, catalog.diseases)).rejects.toThrow((api.body as { detail: string }).detail);
    }
    await expect(sampleMaterialLocally(reference, template, { ...spec, template_sha256: "0".repeat(64) }, 7, undefined, catalog.diseases)).rejects.toThrow(MATERIAL_SAMPLER_MESSAGES.reference);
    expect((await request("/api/atlas/sample-material", { spec: { ...spec, template_sha256: "0".repeat(64) }, seed: 7 })).status).toBe(422);
  });
});
