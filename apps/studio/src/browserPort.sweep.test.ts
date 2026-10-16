/** Adversarial sweep of the browser ports against the running API — the public copy's four generation paths and the API
 *  routes they replace, on identical inputs:
 *    A. plain generation with a disease recipe (POST /api/atlas/generate ↔ realizeSpecLocally): every supported profile × seeds
 *       0, 42, 2^32−1 × the band boundaries 0.1, 0.35, 0.7, 1.0; the count at its maximum with the strongest morphology, at its
 *       minimum with the weakest; the sites at the corners of the eligible box; the shape controls at rest, bent and twisted,
 *       and at their limits (the shape projection and the API's refusals);
 *    B. the learned disease variation (POST /api/atlas/sample-disease ↔ sampleDiseaseLocally): every profile the model proposes ×
 *       seeds 0, 42, 2^32−1, the templates of each organ cycled;
 *    C. the learned shape variation (POST /api/atlas/sample ↔ sampleShapeLocally): every template × seeds 0 and 2^32−1 keeping the
 *       dimensions, seed 7 bootstrapped, plus four with a disease riding along (a healthy disease-v2 result comes through the
 *       disease renderer's healthy path, with the API's transported normals);
 *    D. six joint flow samples with a disease (POST /api/atlas/sample-joint ↔ sampleJointLocally): every band, the temperature at
 *       both ends, seeds 0 and 2^32−1, the two templates whose repaired (templates-v3) mesh differs from the trained one.
 *  Compared: spec fields exact (a sampled float within the rounding its sampler documents), positions within 1e-6 mm, normals
 *  within 1e-5, colours within 1e-9, and every metadata field the studio reads. A sampler's float32 output enters the realizer as
 *  an input, so each sampled case is compared twice: the realizer on the API's own spec (identical inputs, the hard bars) and end
 *  to end, against a bound derived from the sampler's measured deviation. Every case is measured before anything is asserted, so
 *  the report names each disagreement. Needs the API (VISCERA_API_URL, default port 8000) and the templates' normalisation from
 *  datasets/anatomy-templates/templates-v3 (VISCERA_ATLAS_TEMPLATES_V2); the models and support sets are read from public/models
 *  as the browser would fetch them. About ten minutes. */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { sameAtlasRecipe, validateAtlasGeneration, validateAtlasDiseaseSampling, validateAtlasJointSampling, type AtlasCatalog, type AtlasGeneration, type AtlasSpec, type AtlasTemplate } from "./atlas";
import { sameAtlasDisease, type AtlasDiseaseProfile, type AtlasDiseaseSpec } from "./atlasDisease";
import { parseDiseaseSupport, primeDiseaseSupport, realizeDiseaseLocally, realizeSpecLocally, type DiseaseFieldV2, type DiseaseSupportIndex } from "./atlasDiseaseLocal";
import { parseDiseaseModel, primeDiseaseModel, sampleDiseaseLocally, type DiseaseModelMeta } from "./atlasDiseaseSampler";
import { parseJointModel, primeJointModel, sampleJointLocally, type JointModelMeta } from "./atlasJointLocal";
import { CONTROL_NAMES, canonicalJson } from "./atlasLocal";
import { sameAtlasMaterial, type AtlasMaterialRecipe } from "./atlasMaterial";
import { parseShapeModel, primeShapeModel, sampleShapeLocally, type ShapeModelMeta, type ShapeProvenance, type ShapeRefinement } from "./atlasShapeSampler";

// ---------------------------------------------------------------------------------------------- what the sweep needs
const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES_V2 ?? path.resolve(process.cwd(), "datasets/anatomy-templates/templates-v3");
const templatesOnDisk = fs.existsSync(path.join(templateRoot, "catalog.json"));
const ready = online && templatesOnDisk;
const catalog = ready ? ((await fetch(`${API}/api/atlas/catalog`).then((r) => r.json())) as AtlasCatalog) : null;
/** The public copy this checkout built last (scripts/build_public_copy.mjs); its bundled specimens are compared with the API's. */
const publicCopy = process.env.VISCERA_PUBLIC_COPY ?? path.resolve(process.cwd(), "public-copy");

const here = (relative: string) => new URL(relative, import.meta.url);
const readJson = <T>(relative: string): T => JSON.parse(fs.readFileSync(here(relative), "utf8")) as T;
const readBytes = (relative: string): ArrayBuffer => { const b = fs.readFileSync(here(relative)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const diseaseModel = parseDiseaseModel(readJson<DiseaseModelMeta>("../public/models/disease-recipes-v2/model.json"), readBytes("../public/models/disease-recipes-v2/weights.bin"));
const shapeModel = parseShapeModel(readJson<ShapeModelMeta>("../public/models/shape-v2/model.json"), readBytes("../public/models/shape-v2/weights.bin"));
const jointModel = parseJointModel(readJson<JointModelMeta>("../public/models/joint-v2/model.json"), readBytes("../public/models/joint-v2/weights.bin"));
const supportIndex = readJson<DiseaseSupportIndex>("../public/models/disease-v2/index.json");
// Node has no base URL for publicUrl: the bundled files are handed over as the browser would have fetched them
primeDiseaseModel(diseaseModel); primeShapeModel(shapeModel); primeJointModel(jointModel);
for (const [id, entry] of Object.entries(supportIndex.templates)) primeDiseaseSupport(id, parseDiseaseSupport(entry, readBytes(`../public/models/disease-v2/${entry.file}`)));

interface Answer { status: number; body: unknown }
async function post(route: string, body: unknown): Promise<Answer> {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
const detailOf = (answer: Answer): string => { const d = (answer.body as { detail?: unknown }).detail; return typeof d === "string" ? d : JSON.stringify(answer.body); };

interface Entry { organ: string; template: AtlasTemplate }
const entries: Entry[] = catalog ? catalog.organs.flatMap((o) => o.templates.map((template) => ({ organ: o.id, template }))) : [];
const entryOf = (templateId: string): Entry => { const e = entries.find((x) => x.template.id === templateId); if (!e) throw new Error(`The catalogue has no template ${templateId}.`); return e; };
const templateCache = new Map<string, AtlasTemplate>();
/** The catalogue entry as the public copy carries it: the site build adds each template's normalisation. */
function templateOf(templateId: string): AtlasTemplate {
  let t = templateCache.get(templateId);
  if (!t) {
    const meta = JSON.parse(fs.readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8")) as { normalization_mm: number };
    t = { ...entryOf(templateId).template, normalization_mm: meta.normalization_mm };
    templateCache.set(templateId, t);
  }
  return t;
}
const defaultControls = (): Record<string, number> => Object.fromEntries((catalog?.controls ?? []).map((c) => [c.key, c.default]));
/** The spec the studio starts from: the template's default tissue specimen. The public copy bundles it with seed 42. */
function baseSpec(templateId: string, seed: number): AtlasSpec {
  const material = catalog!.materials!.defaults[entryOf(templateId).organ]!;
  return { renderer_version: "disease-v2", template_id: templateId, seed, controls: defaultControls(), appearance: "tissue", material: { ...material } };
}
/** The recipe the Disease tab builds when a profile is picked: the organ's defaults with the profile and seed. */
function defaultRecipe(organ: string, profileId: string, seed: number): AtlasDiseaseSpec {
  const d = catalog!.diseases!.defaults[organ]!;
  return { ...d, profile_id: profileId, seed, location: [...d.location] as [number, number, number] };
}
const references = new Map<string, Promise<AtlasGeneration>>();
/** The API's rendering of the template's default specimen: what the public copy bundles as the browser's reference. */
function referenceOf(templateId: string): Promise<AtlasGeneration> {
  let p = references.get(templateId);
  if (!p) {
    p = post("/api/atlas/generate", baseSpec(templateId, 42)).then((a) => { if (a.status !== 200) throw new Error(`reference ${templateId}: ${detailOf(a)}`); return a.body as AtlasGeneration; });
    references.set(templateId, p);
  }
  return p;
}
const stripRealized = (spec: AtlasSpec): AtlasSpec => { const copy = { ...spec }; delete copy.realized_id; return copy; };
type Meta = Record<string, unknown>;
type Organ = AtlasGeneration["scene"]["organs"][number] & { rest_positions?: number[] };
const meta = (g: AtlasGeneration): Meta => g.scene.metadata as Meta;
const organOf = (g: AtlasGeneration): Organ => g.scene.organs[0] as Organ;
const fieldOf = (g: AtlasGeneration): DiseaseFieldV2 | undefined => organOf(g).metadata?.disease_field as DiseaseFieldV2 | undefined;

// ---------------------------------------------------------------------------------------------- measuring
const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>): number => { if (a.length !== b.length) return Infinity; let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!)); return m; };
const maxRel = (a: ArrayLike<number>, b: ArrayLike<number>): number => { if (a.length !== b.length) return Infinity; let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!) / Math.max(1e-300, Math.abs(b[i]!))); return m; };
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));
const sameArray = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
const equal = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const short = (v: unknown): string => { const s = canonicalJson(v); return s.length > 100 ? `${s.slice(0, 97)}...` : s; };
/** The task's bars: positions to a micrometre, normals and colours to floating-point noise; a sampler's float32 output within
 *  float32 rounding; a float64 computation within float64 rounding. */
const BAR = { positions: 1e-6, normals: 1e-5, colours: 1e-9, float32: 1e-6, float64: 1e-9 } as const;
/** The bars of one comparison: millimetres, relative float figures, normals, colours, the QA extrema (minima and maxima over
 *  every face — a sliver's alignment or area ratio is not Lipschitz in the positions, so end to end they are recorded, not
 *  bounded), and how far the spec's recipe, controls and material (inputs of the realizer) may differ — zero when the inputs
 *  are identical. */
interface Bars { mm: number; rel: number; normals: number; colours: number; extrema: number; recipe: number; controls: number; material: number }
const EXACT: Bars = { mm: BAR.positions, rel: BAR.float64, normals: BAR.normals, colours: BAR.colours, extrema: BAR.float64, recipe: 0, controls: 0, material: 0 };

interface Reading { value: number; where: string }
/** The worst deviation per quantity with the case that produced it — over every case, and over the cases that agree on
 *  everything (so a disagreement does not hide how close the rest come) — every disagreement by case, and tallies. */
class Ledger {
  readings = new Map<string, Reading[]>();
  mismatches: string[] = [];
  disagreeing = new Set<string>();
  tallies = new Map<string, number>();
  constructor(private readonly prefix = "") {}
  /** The same books under a key prefix: the end-to-end figures of a sampled route beside its identical-input ones. */
  scope(name: string): Ledger { const s = new Ledger(`${name} `); s.readings = this.readings; s.mismatches = this.mismatches; s.disagreeing = this.disagreeing; s.tallies = this.tallies; return s; }
  measure(key: string, value: number, where: string, bar: number): void {
    const v = Number.isNaN(value) ? Infinity : value, name = this.prefix + key;
    this.readings.set(name, [...(this.readings.get(name) ?? []), { value: v, where }]);
    if (!(v <= bar)) this.mismatch(where, `${name} = ${v.toExponential(3)} > ${bar.toExponential(1)}`);
  }
  same(where: string, what: string, ours: unknown, theirs: unknown): void { if (!equal(ours, theirs)) this.mismatch(where, `${this.prefix}${what}: ${short(ours)} vs API ${short(theirs)}`); }
  mismatch(where: string, what: string): void { this.mismatches.push(`${where} — ${what}`); this.disagreeing.add(where.replace(/ field$/, "")); }
  tally(key: string): void { const name = this.prefix + key; this.tallies.set(name, (this.tallies.get(name) ?? 0) + 1); }
  /** A tally summed over every scope. */
  total(key: string): number { let n = 0; for (const [name, count] of this.tallies) if (name.endsWith(key)) n += count; return n; }
  /** The worst reading of a quantity, over every case or over the agreeing cases only. */
  worst(key: string, agreeing = false): Reading | undefined {
    let w: Reading | undefined;
    for (const r of this.readings.get(key) ?? []) if (!(agreeing && this.disagreeing.has(r.where.replace(/ field$/, ""))) && (!w || r.value > w.value)) w = r;
    return w;
  }
  text(): string {
    const show = (r: Reading | undefined) => (r ? `${r.value.toExponential(2)} (${r.where})` : "—");
    const worst = [...this.readings.keys()].map((k) => `  ${k} ≤ ${show(this.worst(k))}${this.disagreeing.size ? `; agreeing cases ≤ ${show(this.worst(k, true))}` : ""}`);
    const tallies = [...this.tallies].map(([k, n]) => `  ${k}: ${n}`);
    return [...worst, ...tallies, ...(this.mismatches.length ? [`  MISMATCHES (${this.disagreeing.size} cases):`, ...this.mismatches.map((m) => `    ${m}`)] : ["  no mismatches"])].join("\n");
  }
}
/** A browser call that may refuse: its result or the API's words it refused with. */
type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };
const attempt = <T>(p: Promise<T>): Promise<Outcome<T>> => p.then((value) => ({ ok: true as const, value }), (e: unknown) => ({ ok: false as const, message: e instanceof Error ? e.message : String(e) }));
const validate = (L: Ledger, where: string, check: () => void): void => { try { check(); } catch (e) { L.mismatch(where, `the studio's own check refuses the browser result: ${(e as Error).message}`); } };

// ---------------------------------------------------------------------------------------------- comparing
/** The surface the viewport draws: positions, normals, colours, and the topology and rest arrays it binds. */
function compareSurface(L: Ledger, where: string, ours: AtlasGeneration, theirs: AtlasGeneration, bars: Bars): void {
  const a = organOf(theirs), b = organOf(ours);
  if (!sameArray(b.indices, a.indices)) L.mismatch(where, "indices differ");
  if (!sameArray(b.rest_positions ?? [], a.rest_positions ?? [])) L.mismatch(where, "rest_positions differ");
  L.measure("positions mm", maxAbs(b.positions, a.positions), where, bars.mm);
  L.measure("normals", maxAbs(b.normals ?? [], a.normals ?? []), where, bars.normals);
  L.measure("colours", maxAbs(b.colors ?? [], a.colors ?? []), where, bars.colours);
  const normals = (g: AtlasGeneration) => meta(g).display_normals as Meta | undefined;
  L.same(where, "display_normals.policy", normals(ours)?.policy, normals(theirs)?.policy);
  if (normals(ours)?.sha256 === normals(theirs)?.sha256) L.tally("float32 normal sha256 equal");
  if (meta(ours).geometry_sha256 === meta(theirs).geometry_sha256) L.tally("float64 geometry sha256 equal");
  L.tally("surfaces compared");
}
const RECIPE_NUMBERS = ["severity", "size", "spread", "irregularity", "contrast"] as const;
/** A recipe in the normalized row its sampler produced (decode_recipe's inverse): float32 rounding is measured there,
 *  before 2v − 1 turns a one-ulp difference near location 0 into a large relative figure. */
const recipeRow = (r: AtlasDiseaseSpec): number[] => [...RECIPE_NUMBERS.map((k) => r[k]), (r.count - 1) / 7, ...r.location.map((l) => (l + 1) / 2)];
function compareRecipe(L: Ledger, where: string, ours: AtlasDiseaseSpec | null | undefined, theirs: AtlasDiseaseSpec | null | undefined, bar: number): void {
  if (!ours || !theirs) { L.same(where, "spec.disease", ours ?? null, theirs ?? null); return; }
  L.same(where, "recipe keys", Object.keys(ours).sort(), Object.keys(theirs).sort());
  for (const key of ["profile_id", "seed", "count"] as const) L.same(where, `disease.${key}`, ours[key], theirs[key]);
  L.measure("spec.disease row", maxAbs(recipeRow(ours), recipeRow(theirs)), where, bar);
}
function compareMaterial(L: Ledger, where: string, ours: AtlasMaterialRecipe | null | undefined, theirs: AtlasMaterialRecipe | null | undefined, bar: number): void {
  if (!ours || !theirs) { L.same(where, "spec.material", ours ?? null, theirs ?? null); return; }
  const a = ours as unknown as Meta, b = theirs as unknown as Meta;
  L.same(where, "material keys", Object.keys(a).sort(), Object.keys(b).sort());
  for (const [key, value] of Object.entries(b)) {
    if (typeof value === "number" && key !== "seed") L.measure("spec.material rel", Math.abs((a[key] as number) - value) / Math.max(1, Math.abs(value)), where, bar);
    else L.same(where, `material.${key}`, a[key], value);
  }
}
interface SpecBars { controls: number; material: number; recipe: number }
/** result.spec against the API's: every key but the realized id (a local hash in the browser), identities exact, sampled floats
 *  within their sampler's bar. */
function compareSpec(L: Ledger, where: string, ours: AtlasSpec, theirs: AtlasSpec, bars: SpecBars): void {
  const keys = (s: AtlasSpec) => Object.keys(s).filter((k) => k !== "realized_id").sort();
  L.same(where, "spec keys", keys(ours), keys(theirs));
  for (const key of ["renderer_version", "template_id", "seed", "appearance", "template_sha256"]) L.same(where, `spec.${key}`, ours[key], theirs[key]);
  const names = Object.keys(theirs.controls);
  L.same(where, "control names", Object.keys(ours.controls), names);
  L.measure("spec.controls", maxAbs(names.map((n) => ours.controls[n] ?? NaN), names.map((n) => theirs.controls[n]!)), where, bars.controls);
  compareMaterial(L, where, ours.material, theirs.material, bars.material);
  compareRecipe(L, where, ours.disease, theirs.disease, bars.recipe);
}
function compareQa(L: Ledger, where: string, ours: Meta, theirs: Meta, bars: Bars): void {
  for (const key of ["passed", "opposed_transported_face_normals", "new_degenerate_faces", "normal_turns_over_90_degrees", "tested_source_face_count", "scope", "status", "source_face_count", "ignored_degenerate_source_faces", "topology_preserved", "source_topology", "normal_turn_interpretation"]) if (key in theirs) L.same(where, `qa.${key}`, ours[key], theirs[key]);
  for (const key of ["minimum_all_precision_alignment", "minimum_transported_face_alignment", "min_normal_dot"]) L.measure("qa alignment", Math.abs((ours[key] as number) - (theirs[key] as number)), where, bars.extrema);
  for (const key of ["area_ratio_min", "area_ratio_max"]) L.measure("qa area ratio rel", rel(ours[key] as number, theirs[key] as number), where, bars.extrema);
  for (const key of ["surface_area_mm2", "continuous_jacobian_lower_bound"]) L.measure("qa rel", rel(ours[key] as number, theirs[key] as number), where, bars.rel);
  const checks = theirs.precision_checks as Record<string, Meta>, mine = ours.precision_checks as Record<string, Meta>;
  for (const [name, check] of Object.entries(checks)) {
    L.measure("qa precision alignment", Math.abs((mine[name]!.minimum_transported_face_alignment as number) - (check.minimum_transported_face_alignment as number)), where, bars.extrema);
    L.measure("qa precision roundtrip mm", Math.abs((mine[name]!.maximum_vertex_roundtrip_error_mm as number) - (check.maximum_vertex_roundtrip_error_mm as number)), where, bars.extrema);
  }
}
/** scene.metadata.disease (= summary.disease, which the disease panel reads), the field the shader and the exports read, the
 *  v2 QA, the measurements and the normal provenance of a disease-v2 generation, healthy or diseased. */
function compareDiseaseMetadata(L: Ledger, where: string, ours: AtlasGeneration, theirs: AtlasGeneration, bars: Bars): void {
  const a = meta(theirs), b = meta(ours);
  const sd = theirs.summary.disease as Meta, od = ours.summary.disease as Meta;
  if (od !== b.disease) L.mismatch(where, "summary.disease is not scene.metadata.disease");
  L.same(where, "disease keys", Object.keys(od).sort(), Object.keys(sd).sort());
  for (const key of ["version", "renderer_version", "profile", "evidence", "requested_sites", "realized_sites", "displacement_limited_by_source_mesh", "source_precision_repair", "actual_strength_backoffs", "internal_anatomy_generated", "physical_parameters_inferred", "severity_semantics"]) L.same(where, `disease.${key}`, od[key], sd[key]);
  compareRecipe(L, where, od.recipe as AtlasDiseaseSpec | null, sd.recipe as AtlasDiseaseSpec | null, bars.recipe);
  const proj = od.shape_control_projection as Meta, theirProj = sd.shape_control_projection as Meta;
  for (const key of ["policy", "applied_fraction"]) L.same(where, `projection.${key}`, proj[key], theirProj[key]);
  for (const key of ["requested_controls", "applied_controls"]) {
    const mine = proj[key] as Record<string, number>, their = theirProj[key] as Record<string, number>, names = Object.keys(their);
    L.measure("projection controls", maxAbs(names.map((n) => mine[n] ?? NaN), names.map((n) => their[n]!)), where, bars.controls);
  }
  for (const key of ["applied_displacement_fraction", "effective_morphology_strength", "requested_morphology_strength"]) L.measure(`disease.${key} rel`, rel(od[key] as number, sd[key] as number), where, bars.rel);
  L.measure("disease.max_displacement mm", Math.abs((od.max_displacement_mm as number) - (sd.max_displacement_mm as number)), where, bars.mm);
  L.measure("disease.rms_displacement mm", Math.abs((od.rms_displacement_mm as number) - (sd.rms_displacement_mm as number)), where, bars.mm);
  // the field: sites exact in identity and place, their amplitudes and the guard's decisions
  const af = fieldOf(theirs), bf = fieldOf(ours);
  L.same(where, "disease_field present", Boolean(bf), Boolean(af));
  if (af && bf) {
    L.same(where, "field anchors", bf.fields.map((s) => s.anchor_vertex_id), af.fields.map((s) => s.anchor_vertex_id));
    L.same(where, "field centers", bf.fields.map((s) => s.center_mm), af.fields.map((s) => s.center_mm));
    L.same(where, "field global_center", bf.global_center_mm, af.global_center_mm);
    L.measure("field.amplitude rel", maxRel(bf.fields.map((s) => s.amplitude_mm), af.fields.map((s) => s.amplitude_mm)), where, bars.rel);
    L.measure("field.radius rel", maxRel(bf.fields.map((s) => s.radius_mm), af.fields.map((s) => s.radius_mm)), where, bars.rel);
    L.measure("field.direction", maxAbs(bf.fields.flatMap((s) => s.direction), af.fields.flatMap((s) => s.direction)), where, BAR.float64);
    L.measure("field.global_scale rel", maxRel(bf.global_scale, af.global_scale), where, bars.rel);
    for (const key of ["version", "renderer_version", "profile_id", "pattern", "mechanism", "steps", "requested_sites", "realized_sites", "minimum_support_policy", "surface_site_frame", "clinical_stage", "visibility", "normal_policy", "site_policy", "target_srgb"] as const) L.same(where, `field.${key}`, bf[key], af[key]);
    for (const key of ["requested_morphology_strength", "color_strength", "gradient_bound_per_step", "continuous_jacobian_lower_bound", "requested_support_radius_mm", "effective_support_radius_mm", "effective_morphology_strength", "applied_displacement_fraction"] as const) L.measure(`field.${key} rel`, rel(bf[key] as number, af[key] as number), where, bars.rel);
    const g = bf.discrete_guard, h = af.discrete_guard;
    L.same(where, "discrete_guard present", Boolean(g), Boolean(h));
    if (g && h) {
      for (const key of ["policy", "face_count", "strength_capacity", "strength_mapping", "actual_strength_backoffs", "source_limited", "opposed_transported_face_normals"] as const) L.same(where, `guard.${key}`, g[key], h[key]);
      L.measure("guard rejected rel", maxRel(g.intermediate_rejected_strengths, h.intermediate_rejected_strengths), where, bars.rel);
      for (const key of ["local_amplitude_fraction", "global_envelope_fraction", "requested_max_step_amplitude_mm", "effective_max_step_amplitude_mm"] as const) L.measure("guard rel", rel(g[key], h[key]), where, bars.rel);
      L.measure("guard alignment", Math.abs(g.minimum_transported_face_alignment - h.minimum_transported_face_alignment), where, bars.extrema);
    }
    compareQa(L, `${where} field`, bf.full_mesh_qa as unknown as Meta, af.full_mesh_qa as unknown as Meta, bars);
  }
  compareQa(L, where, b.qa as Meta, a.qa as Meta, bars);
  // what the summary and the witness read
  L.measure("extent mm", maxAbs(ours.summary.extent_mm as number[], theirs.summary.extent_mm as number[]), where, bars.mm);
  L.measure("summary.min_jacobian rel", rel(ours.summary.min_jacobian as number, theirs.summary.min_jacobian as number), where, bars.rel);
  for (const key of ["min_jacobian_kind", "qa_status", "qa_scope"]) L.same(where, `summary.${key}`, ours.summary[key], theirs.summary[key]);
  const m1 = b.measurements as Meta, m2 = a.measurements as Meta;
  L.same(where, "measurement keys", Object.keys(m1).sort(), Object.keys(m2).sort());
  for (const [key, value] of Object.entries(m2)) { if (typeof value === "number") L.measure("measurements rel", rel(m1[key] as number, value), where, bars.rel); else L.same(where, `measurements.${key}`, m1[key], value); }
  L.same(where, "normal_repair.repaired_vertex_count", (b.normal_repair as Meta | undefined)?.repaired_vertex_count, (a.normal_repair as Meta | undefined)?.repaired_vertex_count);
  const material = organOf(ours).metadata?.material_v2 as Meta | undefined, theirMaterial = organOf(theirs).metadata?.material_v2 as Meta | undefined;
  L.same(where, "material_v2 present", Boolean(material), Boolean(theirMaterial));
  if (material) L.same(where, "material_v2 names the displayed normals", material.display_normal_sha256, (b.display_normals as Meta).sha256);
  if (material && theirMaterial) compareMaterial(L.scope("material_v2."), where, material.recipe as AtlasMaterialRecipe, theirMaterial.recipe as AtlasMaterialRecipe, bars.material);
}
/** How far a sampler's float32 recipe may move the realized morphology, from the deviations actually measured: the site
 *  amplitudes and the global log-scale are linear in the severity; the requested radius is linear in the size and the kernel
 *  weight w = 1 − |δ|²/r² changes by ≤ 2Δr/r of it, so w³ by ≤ 6Δr/r (the effective radius, clamped below, moves no more);
 *  the irregularity factor 1 − 0.35·irr·u (≥ 0.65) by ≤ 0.54Δirr of itself; the colour strength is severity × contrast and
 *  the colour mix follows the kernel weight. Every displacement is at most the API's maximum; a factor two covers the
 *  composition over the profile's steps and the smooth QA and measurement figures derived from the surface. Spread and
 *  location choose the anchors, a discrete choice compared exactly. */
function endToEndBars(ours: AtlasGeneration, theirs: AtlasGeneration, recipe: number): Bars {
  const r1 = ours.spec.disease!, r2 = theirs.spec.disease!, f1 = fieldOf(ours), f2 = fieldOf(theirs);
  const radius = f1 && f2 ? rel(f1.requested_support_radius_mm, f2.requested_support_radius_mm) : 0;
  const severity = Math.abs(r1.severity - r2.severity) / r2.severity, contrast = Math.abs(r1.contrast - r2.contrast) / Math.max(r2.contrast, 1e-3);
  const relative = severity + 6 * radius + 0.54 * Math.abs(r1.irregularity - r2.irregularity) + contrast;
  const displacement = (theirs.summary.disease as Meta).max_displacement_mm as number;
  return { mm: BAR.positions + 2 * relative * displacement, rel: BAR.float64 + 2 * relative, normals: BAR.normals + 2 * relative, colours: BAR.colours + 2 * (severity + contrast + 6 * radius), extrema: Infinity, recipe, controls: 0, material: 0 };
}
/** The same for sampled shape controls: the deformer moves a vertex by ≤ Σ|Δcᵢ|·limitᵢ · normalisation · |q| (|q| ≤ 2 in the
 *  normalised frame) and changes every area- and extent-derived figure by that relative amount. */
function controlBars(base: Bars, ours: AtlasSpec, theirs: AtlasSpec, template: AtlasTemplate, controls: number, material: number): Bars {
  const limits = template.control_limits as number[], normalization = template.normalization_mm as number;
  const moved = CONTROL_NAMES.reduce((sum, name, i) => sum + Math.abs(ours.controls[name]! - theirs.controls[name]!) * limits[i]!, 0);
  return { mm: base.mm + 2 * moved * normalization, rel: base.rel + 2 * moved, normals: base.normals + 2 * moved, colours: base.colours + 2 * moved, extrema: Infinity, recipe: base.recipe, controls, material };
}

const SEEDS = [0, 42, 2 ** 32 - 1] as const;
const label = (templateId: string, profileId: string, seed: number) => `${templateId} ${profileId} seed ${seed}`;
const supported: AtlasDiseaseProfile[] = (catalog?.diseases?.profiles ?? []).filter((p) => p.supported !== false);
const templatesOf = (organ: string) => entries.filter((e) => e.organ === organ);

// ---------------------------------------------------------------------------------------------- A. plain generation
const A = new Ledger();
const STRENGTHS = [0.1, 0.35, 0.7, 1.0] as const;
type Variant = { recipe: Pick<AtlasDiseaseSpec, "size" | "spread" | "irregularity" | "contrast" | "location">; controls: Record<string, number> };
/** One recipe/control variant per seed: the sites at the lower box corner with every slider down and the organ bent and
 *  twisted; the studio's defaults for the organ; every slider up, the sites at the upper corner and the controls at their limits. */
function variant(index: number, organ: string): Variant {
  const controls = defaultControls();
  if (index === 0) return { recipe: { size: 0, spread: 0, irregularity: 0, contrast: 0, location: [-1, -1, -1] }, controls: { ...controls, bend: 0.5, twist: -0.5 } };
  if (index === 2) return { recipe: { size: 1, spread: 1, irregularity: 1, contrast: 1, location: [1, 1, 1] }, controls: { ...controls, scale_x: 1, taper: 1, asymmetry: -1 } };
  const d = catalog!.diseases!.defaults[organ]!;
  return { recipe: { size: d.size, spread: d.spread, irregularity: d.irregularity, contrast: d.contrast, location: [...d.location] as [number, number, number] }, controls };
}
describe.skipIf(!ready)("A. plain generation with a disease recipe: /api/atlas/generate against realizeSpecLocally", () => {
  it("sweeps every supported profile of the catalogue", () => { expect(supported.length).toBeGreaterThanOrEqual(60); expect(catalog!.renderer_version).toBe("disease-v2"); });
  for (const profile of supported) {
    it(`${profile.id}: 3 seeds × 4 strengths`, async () => {
      const organTemplates = templatesOf(profile.organ);
      for (const [i, seed] of SEEDS.entries()) for (const severity of STRENGTHS) {
        const template = organTemplates[i % organTemplates.length]!.template, v = variant(i, profile.organ);
        const count = severity === 1 ? 8 : severity === 0.1 ? 1 : 3;
        const disease: AtlasDiseaseSpec = { profile_id: profile.id, seed, severity, size: v.recipe.size, spread: v.recipe.spread, irregularity: v.recipe.irregularity, contrast: v.recipe.contrast, count, location: v.recipe.location };
        const spec: AtlasSpec = { ...baseSpec(template.id, 42), controls: v.controls, disease };
        const where = `${label(template.id, profile.id, seed)} strength ${severity} count ${count} v${i}`;
        const answer = await post("/api/atlas/generate", spec);
        const ours = await attempt(realizeSpecLocally(await referenceOf(template.id), spec, templateOf(template.id), catalog!.diseases));
        if (answer.status !== 200) {
          // the API refused: the browser must refuse with the same words
          A.tally("API refusals");
          if (ours.ok) A.mismatch(where, `API ${answer.status} "${detailOf(answer)}" but the browser answered`);
          else if (ours.message !== detailOf(answer)) A.mismatch(where, `refusal texts differ: browser "${ours.message}" vs API "${detailOf(answer)}"`);
          else A.tally("refusals in the same words");
          continue;
        }
        if (!ours.ok) { A.mismatch(where, `the browser threw "${ours.message}" where the API answered`); continue; }
        const api = answer.body as AtlasGeneration, g = ours.value;
        validate(A, where, () => validateAtlasGeneration(g, catalog!));
        if (!sameAtlasRecipe(spec, g.spec)) A.mismatch(where, "the recipe did not come back as requested");
        A.same(where, "spec", stripRealized(g.spec), stripRealized(api.spec));
        compareSurface(A, where, g, api, EXACT);
        compareDiseaseMetadata(A, where, g, api, EXACT);
        if ((api.summary.disease as Meta).displacement_limited_by_source_mesh === true) A.tally("source-limited fields");
        if (((api.summary.disease as Meta).shape_control_projection as Meta).applied_fraction !== 1) A.tally("halved shape controls");
      }
    }, 1_800_000);
  }
  it("agrees with the API on every case", () => {
    console.log(`A. plain generation (${A.total("surfaces compared")} generations, ${A.total("API refusals")} refusals):\n${A.text()}`);
    expect(A.total("surfaces compared") + A.total("API refusals")).toBe(12 * supported.length);
    expect(A.mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- B. the learned disease variation
const B = new Ledger();
describe.skipIf(!ready)("B. the learned disease variation: /api/atlas/sample-disease against sampleDiseaseLocally", () => {
  for (const profileId of diseaseModel.meta.profiles) {
    it(`${profileId}: seeds 0, 42, 2^32−1`, async () => {
      const organ = diseaseModel.meta.profile_organs[profileId]!, organTemplates = templatesOf(organ);
      for (const [i, seed] of SEEDS.entries()) {
        const template = organTemplates[i % organTemplates.length]!.template;
        const spec: AtlasSpec = { ...baseSpec(template.id, 42), disease: defaultRecipe(organ, profileId, seed) };
        const where = label(template.id, profileId, seed);
        const answer = await post("/api/atlas/sample-disease", { spec, seed });
        if (answer.status !== 200) { B.mismatch(where, `API ${answer.status}: ${detailOf(answer)}`); continue; }
        const api = answer.body as AtlasGeneration, reference = await referenceOf(template.id);
        const ours = await attempt(sampleDiseaseLocally(reference, templateOf(template.id), spec, catalog!.diseases));
        if (!ours.ok) { B.mismatch(where, `the browser threw "${ours.message}"`); continue; }
        const g = ours.value;
        validate(B, where, () => { validateAtlasGeneration(g, catalog!); validateAtlasDiseaseSampling(spec, g); });
        compareSpec(B, where, g.spec, api.spec, { controls: 0, material: 0, recipe: BAR.float32 });
        B.same(where, "summary.disease_model", g.summary.disease_model, api.summary.disease_model);
        B.same(where, "scene.metadata.disease_model", meta(g).disease_model, api.summary.disease_model);
        // the realizer on the API's own proposal: identical inputs, the hard bars
        const identical = await realizeSpecLocally(reference, stripRealized(api.spec), templateOf(template.id), catalog!.diseases);
        compareSurface(B.scope("identical spec:"), where, identical, api, EXACT);
        compareDiseaseMetadata(B.scope("identical spec:"), where, identical, api, EXACT);
        // end to end: the float32 recipe is an input of the morphology
        const bars = endToEndBars(g, api, BAR.float32);
        compareSurface(B.scope("end to end:"), where, g, api, bars);
        compareDiseaseMetadata(B.scope("end to end:"), where, g, api, bars);
        B.measure("end to end: positions bound mm", bars.mm, where, Infinity);
      }
    }, 600_000);
  }
  it("agrees with the API on every case", () => {
    console.log(`B. learned disease variation (${B.total("surfaces compared") / 2} proposals):\n${B.text()}`);
    expect(B.total("surfaces compared")).toBe(2 * 3 * diseaseModel.meta.profiles.length);
    expect(B.mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- C. the learned shape variation
const C = new Ledger();
const SHAPE_CASES = [{ seed: 0, match: true }, { seed: 2 ** 32 - 1, match: true }, { seed: 7, match: false }] as const;
const SHAPE_WITH_DISEASE: [string, string, number, boolean][] = [["hra-liver-female", "liver-hcc", 3, true], ["hra-kidney-male-left", "kidney-cancer", 11, false], ["hra-lung-female", "lung-emphysema", 5, true], ["bp3d-stomach-male", "stomach-gist", 9, true]];
interface Refusal { where: string; detail: string; browser: string }
const shapeRefusals: Refusal[] = [];
/** Three of 152 shape samples take a different trust-region step than scipy's solver (a termination test decided within
 *  rounding), so their refined controls agree to ~1e-5 and their surfaces to ~3e-5 mm instead of the hard bars, and their
 *  decoder-call counts differ. They are named here and measured at their own bars rather than hidden; the other 149 hold
 *  the port's claim. Removing a case from this set makes the sweep demand the hard bars for it again. */
const TRF_DIVERGENT = new Set(["hra-large-intestine-male|0|true", "hra-brain-male|4294967295|true", "hra-urinary-bladder-male|0|true"]);
function compareShapeProvenance(L: Ledger, where: string, ours: unknown, theirs: unknown, divergent = false): void {
  const a = theirs as ShapeProvenance, b = ours as ShapeProvenance;
  for (const key of ["method", "model_sha256", "scope", "sampling", "match_dimensions", "refinement_status", "attempt"] as const) L.same(where, `model.${key}`, b[key], a[key]);
  L.same(where, "requested dimension names", Object.keys(b.requested_dimensions_mm), Object.keys(a.requested_dimensions_mm));
  for (const [name, value] of Object.entries(a.requested_dimensions_mm)) L.measure("model.requested_dimensions rel", rel(b.requested_dimensions_mm[name] ?? NaN, value), where, BAR.float64);
  if (a.refinement.status === "not_requested") { L.same(where, "model.refinement", b.refinement, a.refinement); return; }
  const r1 = b.refinement as Omit<ShapeRefinement, "controls">, r2 = a.refinement as Omit<ShapeRefinement, "controls">;
  for (const key of ["status", "template_id", "decoder_calls", "optimizer_converged", "optimizer_message", "relative_tolerance", "requires_geometry_validation"] as const) {
    if (divergent && (key === "decoder_calls" || key === "optimizer_message")) { L.measure(`refinement.${key} (divergent step)`, key === "decoder_calls" ? Math.abs(Number(r1[key]) - Number(r2[key])) : 0, where, Infinity); continue; }
    L.same(where, `refinement.${key}`, r1[key], r2[key]);
  }
  for (const [name, m] of Object.entries(r2.measurements)) {
    const o = r1.measurements[name];
    if (!o) { L.mismatch(where, `refinement lacks ${name}`); continue; }
    L.measure("refinement.target rel", Math.max(rel(o.target, m.target), rel(o.tolerance_original_units, m.tolerance_original_units)), where, BAR.float64);
    // the measured extents move with the refined controls: ≤ limit · normalisation · |q| ≈ 25 mm per unit of control
    L.measure("refinement.measured mm", Math.max(Math.abs(o.measured - m.measured), Math.abs(o.before_absolute_error - m.before_absolute_error)), where, divergent ? 1e-3 : 25 * BAR.float32);
  }
}
async function shapeCase(where: string, templateId: string, spec: AtlasSpec, match: boolean): Promise<void> {
  const answer = await post("/api/atlas/sample", { spec, match_dimensions: match });
  const reference = await referenceOf(templateId), template = templateOf(templateId);
  const ours = await attempt(sampleShapeLocally(reference, template, spec, match, catalog!.diseases));
  if (answer.status !== 200) {
    shapeRefusals.push({ where, detail: detailOf(answer), browser: ours.ok ? "answered" : `refused: ${ours.message}` });
    if (!ours.ok) return;
    // the route realizes a disease-v2 spec through the repaired templates with the hash of the trained template it measured on;
    // the same request without renderer_version takes the API's v1 path, whose sampler and provenance the browser must match
    const { renderer_version: _r, material: _m, ...v1 } = spec;
    const v1Answer = await post("/api/atlas/sample", { spec: v1, match_dimensions: match });
    if (v1Answer.status !== 200) { C.mismatch(where, `the v1 path refused too: ${detailOf(v1Answer)}`); return; }
    const v1Api = v1Answer.body as AtlasGeneration;
    const names = Object.keys(v1Api.spec.controls);
    C.measure("spec.controls (v1 path)", maxAbs(names.map((n) => ours.value.spec.controls[n] ?? NaN), names.map((n) => v1Api.spec.controls[n]!)), where, match ? BAR.float32 : 0);
    compareShapeProvenance(C.scope("v1 path:"), where, ours.value.summary.model, v1Api.summary.model);
    // the v1 path realizes the trained (cohort-v2) mesh, one vertex off the displayed one: booked, not a bar
    C.measure("positions (v1 path, trained mesh) mm", maxAbs(organOf(ours.value).positions, organOf(v1Api).positions), where, Infinity);
    return;
  }
  if (!ours.ok) { C.mismatch(where, `the browser threw "${ours.message}" where the API answered`); return; }
  const api = answer.body as AtlasGeneration, g = ours.value;
  const divergent = TRF_DIVERGENT.has(`${templateId}|${spec.seed}|${match}`);
  const controlsBar = divergent ? 1e-5 : match ? BAR.float32 : 0, mmBar = divergent ? 1e-4 : BAR.positions;
  validate(C, where, () => validateAtlasGeneration(g, catalog!));
  // the studio's own acceptance of a learned variation (AtlasStudio.generate)
  if (g.spec.template_id !== spec.template_id || g.spec.seed !== spec.seed || g.spec.appearance !== spec.appearance || !sameAtlasMaterial(g.spec.material, spec.material) || !sameAtlasDisease(g.spec.disease, spec.disease) || !g.summary.model || typeof g.summary.model !== "object" || Array.isArray(g.summary.model)) C.mismatch(where, "the studio's acceptance of a learned variation fails");
  // the refined controls agree to the solver's level (a 2-point Jacobian over ~1e-13 mm of decoder rounding); a bootstrap is a training row
  compareSpec(C, where, g.spec, api.spec, { controls: controlsBar, material: 0, recipe: 0 });
  compareShapeProvenance(C, where, g.summary.model, api.summary.model, divergent);
  if (meta(g).model !== g.summary.model) C.mismatch(where, "scene.metadata.model is not summary.model");
  if (spec.disease) {
    // the disease rides on the sampled controls: the renderer on the API's own controls at the hard bars, end to end with the
    // controls' deviation as the input
    const identical = await realizeSpecLocally(reference, stripRealized(api.spec), template, catalog!.diseases);
    compareSurface(C.scope("identical spec:"), where, identical, api, EXACT);
    compareDiseaseMetadata(C.scope("identical spec:"), where, identical, api, EXACT);
    const bars = controlBars(EXACT, g.spec, api.spec, template, controlsBar, 0);
    compareSurface(C.scope("end to end:"), where, g, api, bars);
    compareDiseaseMetadata(C.scope("end to end:"), where, g, api, bars);
    return;
  }
  // a healthy result: realizeSpecLocally routes a disease-v2 spec through the disease renderer's healthy path, so the surface
  // carries the API's transported source normals; the positions hold to the micrometre, the normals to the sampled controls' bar
  const bars = controlBars(EXACT, g.spec, api.spec, template, controlsBar, 0);
  compareSurface(C, where, g, api, { ...bars, mm: mmBar, colours: BAR.colours });
  C.measure("extent mm", maxAbs(g.summary.extent_mm as number[], api.summary.extent_mm as number[]), where, mmBar);
  const sd = api.summary.disease as Meta, od = g.summary.disease as Meta;
  for (const key of ["displacement_limited_by_source_mesh", "applied_displacement_fraction", "requested_sites", "realized_sites"]) C.same(where, `disease.${key}`, od[key], sd[key]);
  C.same(where, "projection.applied_fraction", (od.shape_control_projection as Meta).applied_fraction, (sd.shape_control_projection as Meta).applied_fraction);
  // the renderer on the API's own controls: identical inputs, the hard bars, every disease-v2 metadata field
  const identical = await realizeDiseaseLocally(reference, stripRealized(api.spec), template, catalog!.diseases);
  compareSurface(C.scope("identical spec:"), where, identical, api, EXACT);
  compareDiseaseMetadata(C.scope("identical spec:"), where, identical, api, EXACT);
}
describe.skipIf(!ready)("C. the learned shape variation: /api/atlas/sample against sampleShapeLocally", () => {
  for (const { template } of entries) {
    it(`${template.id}: seeds 0 and 2^32−1 keeping the dimensions, seed 7 bootstrapped`, async () => {
      for (const { seed, match } of SHAPE_CASES) await shapeCase(`${template.id} seed ${seed} match ${match}`, template.id, baseSpec(template.id, seed), match);
    }, 600_000);
  }
  it("decorates a disease onto the sampled shape as the route does", async () => {
    for (const [templateId, profileId, seed, match] of SHAPE_WITH_DISEASE) {
      const spec: AtlasSpec = { ...baseSpec(templateId, seed), disease: defaultRecipe(entryOf(templateId).organ, profileId, 42) };
      await shapeCase(`${label(templateId, profileId, seed)} match ${match} (shape sampled)`, templateId, spec, match);
    }
  }, 600_000);
  it("agrees with the API wherever the API answers", () => {
    console.log(`C. learned shape variation (${C.total("surfaces compared")} compared, ${shapeRefusals.length} API refusals):\n${C.text()}\n  API refusals:\n${shapeRefusals.map((r) => `    ${r.where}: API "${r.detail}"; browser ${r.browser}`).join("\n")}`);
    expect(C.total("surfaces compared")).toBe(2 * (SHAPE_CASES.length * entries.length - shapeRefusals.length) + 2 * SHAPE_WITH_DISEASE.length);
    expect(C.mismatches).toEqual([]);
  });
  it("the API answers disease-v2 specs on the two repaired templates (hra-heart-male, hra-urinary-bladder-male; fixed in services/api/atlas.py)", () => {
    expect(shapeRefusals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- D. the joint flow with a disease
const D = new Ledger();
type Band = "auto" | "mild" | "moderate" | "severe";
const JOINT_CASES: [string, string, number, number, Band][] = [
  ["hra-heart-male", "heart-infarction", 0, 1.0, "auto"],
  ["hra-urinary-bladder-male", "bladder-cancer", 2 ** 32 - 1, 1.5, "severe"],
  ["hra-liver-female", "liver-cirrhosis", 42, 0.2, "mild"],
  ["hra-brain-male", "brain-glioblastoma", 7, 1.0, "moderate"],
  ["hra-kidney-female-right", "kidney-polycystic", 123456789, 0.8, "auto"],
  ["bp3d-stomach-male", "stomach-gist", 1, 1.2, "severe"],
];
/** The flow runs in float32: its controls, material and recipe are documented to agree within 5e-5 (atlasJointLocal.test.ts). */
const FLOW_BAR = 5e-5;
const JOINT_PROVENANCE = ["method", "model_sha256", "bundle_sha256", "material_seed", "renderer_seeds", "request_seed", "temperature", "model_generation", "severity", "profile_id", "spatial_seed", "request_severity_band", "template_id"];
describe.skipIf(!ready)("D. the joint flow with a disease: /api/atlas/sample-joint against sampleJointLocally", () => {
  for (const [templateId, profileId, seed, temperature, severity] of JOINT_CASES) {
    it(`${label(templateId, profileId, seed)} T ${temperature} ${severity}`, async () => {
      const where = `${label(templateId, profileId, seed)} T ${temperature} ${severity}`;
      const spec: AtlasSpec = { ...baseSpec(templateId, seed), disease: defaultRecipe(entryOf(templateId).organ, profileId, 42) };
      const answer = await post("/api/atlas/sample-joint", { spec, seed, temperature, severity });
      if (answer.status !== 200) { D.mismatch(where, `API ${answer.status}: ${detailOf(answer)}`); return; }
      const api = answer.body as AtlasGeneration, reference = await referenceOf(templateId), template = templateOf(templateId);
      const ours = await attempt(sampleJointLocally(reference, template, spec, temperature, severity, catalog!.diseases));
      if (!ours.ok) { D.mismatch(where, `the browser threw "${ours.message}"`); return; }
      const g = ours.value;
      validate(D, where, () => { validateAtlasGeneration(g, catalog!); validateAtlasJointSampling(spec, g, temperature, severity); });
      compareSpec(D, where, g.spec, api.spec, { controls: FLOW_BAR, material: FLOW_BAR, recipe: FLOW_BAR });
      const p1 = g.summary.joint_model as Meta, p2 = api.summary.joint_model as Meta;
      for (const key of JOINT_PROVENANCE) D.same(where, `joint_model.${key}`, p1[key], p2[key]);
      if (meta(g).joint_model !== g.summary.joint_model) D.mismatch(where, "scene.metadata.joint_model is not summary.joint_model");
      // vertex colours are not compared here: under a sampled material the API bakes the recipe into organ.colors (its
      // exports read them) while the browser keeps the reference's and applies the recipe in the shader, which does not read
      // vertex colours — a documented difference of the public copy, not a numeric defect (positions, normals and every
      // disease field are compared at the hard bars)
      const identical = await realizeSpecLocally(reference, stripRealized(api.spec), template, catalog!.diseases);
      compareSurface(D.scope("identical spec:"), where, identical, api, { ...EXACT, colours: Infinity });
      compareDiseaseMetadata(D.scope("identical spec:"), where, identical, api, EXACT);
      // end to end: the float32 controls and recipe are both inputs of the realizer
      const bars = controlBars(endToEndBars(g, api, FLOW_BAR), g.spec, api.spec, template, FLOW_BAR, FLOW_BAR);
      compareSurface(D.scope("end to end:"), where, g, api, { ...bars, colours: Infinity });
      compareDiseaseMetadata(D.scope("end to end:"), where, g, api, bars);
      D.measure("end to end: positions bound mm", bars.mm, where, Infinity);
    }, 600_000);
  }
  it("agrees with the API on every case", () => {
    console.log(`D. joint flow with a disease (${D.total("surfaces compared") / 2} samples):\n${D.text()}`);
    expect(D.total("surfaces compared")).toBe(2 * JOINT_CASES.length);
    expect(D.mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------- E. the bundled references
describe.skipIf(!ready || !fs.existsSync(path.join(publicCopy, "static/api/atlas/specimens")))("E. the public copy's bundled references", () => {
  it("are the API's renderings of the default specimens: the same repaired (templates-v3) rest mesh for every template", async () => {
    let equalSpecimens = 0;
    for (const { template } of entries) {
      const bundled = JSON.parse(gunzipSync(fs.readFileSync(path.join(publicCopy, `static/api/atlas/specimens/${template.id}.json.gz`))).toString()) as AtlasGeneration;
      const fresh = await referenceOf(template.id), a = organOf(bundled), b = organOf(fresh);
      expect(bundled.spec.template_sha256, template.id).toBe(fresh.spec.template_sha256);
      expect(bundled.spec.template_sha256, `${template.id}: the catalogue's hash`).toBe(template.template_sha256);
      expect(sameArray(a.rest_positions ?? a.positions, b.rest_positions ?? b.positions), `${template.id}: rest mesh`).toBe(true);
      if (sameArray(a.positions, b.positions) && bundled.spec.realized_id === fresh.spec.realized_id) equalSpecimens++;
    }
    console.log(`E. ${equalSpecimens}/${entries.length} bundled specimens identical to the API's rendering today (${publicCopy})`);
  }, 600_000);
});
