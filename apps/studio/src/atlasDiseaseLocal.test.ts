/** The browser disease renderer against the Python one. Offline: src/__fixtures__/disease-v2.json (written by
 *  scripts/export_disease_morphology_fixtures.py) holds the API renderer's own outputs for 62 recipes on five templates
 *  read from datasets/anatomy-templates/templates-v3; the bundled support sets come from public/models/disease-v2.
 *  With the API running (VISCERA_API_URL, default port 8000) the same recipes go to POST /api/atlas/generate and the
 *  whole generation is compared: positions to a micrometre, normals and colours to floating-point noise, every
 *  metadata field the UI reads. */
import { inflateRawSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AtlasDiseaseLibrary, AtlasDiseaseSpec } from "./atlasDisease";
import type { AtlasCatalog, AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import { sameAtlasRecipe, validateAtlasGeneration } from "./atlas";
import {
  applyDiseaseColor, diseaseProfileV2, diseaseTemplate, parseDiseaseSupport, primeDiseaseSupport, realizeDiseaseGeometry, realizeDiseaseLocally, trimeshVertexNormals,
  type DiseaseFieldV2, type DiseaseMeshQa, type DiseaseProfileV2, type DiseaseSupport, type DiseaseSupportIndex, type DiseaseTemplate,
} from "./atlasDiseaseLocal";
import { deformVertices, geometryHash } from "./atlasLocal";
import { Pcg64 } from "./numpyRandom";

// ---------------------------------------------------------------------------------------------- fixtures and files
interface FixtureTemplate {
  organ: string; vertex_count: number; face_count: number; template_sha256: string; eligible_count: number; pool_count: number; minimum_support_radius_mm: number;
  source_normals_sha256: string; normalization_mm: number; control_limits: number[]; eligible_center_mm: number[]; eligible_extent_mm: number[]; pool_head: number[];
  normals_sample_ids: number[]; normals_sample: number[][];
}
interface FixtureCase {
  template_id: string; profile_id: string; recipe: AtlasDiseaseSpec; controls: Record<string, number>; applied_controls: Record<string, number>; shape_fraction: number;
  rng: { permutation_head: number[]; draws: number[] }; first_anchor_margin_mm: number | null;
  field: { anchor_vertex_ids: number[]; amplitudes_mm: number[]; directions: number[][]; radius_mm: number; requested_radius_mm: number; requested_sites: number; realized_sites: number; global_center_mm: number[]; global_log_scale: number[]; global_scale: number[]; color_strength: number; gradient_bound_per_step: number; continuous_jacobian_lower_bound: number; effective_morphology_strength: number; applied_displacement_fraction: number; discrete_guard: { strength_capacity: number; actual_strength_backoffs: number; intermediate_rejected_strengths: number[]; source_limited: boolean; requested_max_step_amplitude_mm: number; effective_max_step_amplitude_mm: number; minimum_transported_face_alignment: number } | null };
  qa: { passed: boolean; minimum_all_precision_alignment: number; minimum_transported_face_alignment: number; opposed_transported_face_normals: number; new_degenerate_faces: number; area_ratio_min: number; area_ratio_max: number; normal_turns_over_90_degrees: number; min_normal_dot: number; continuous_jacobian_lower_bound: number; surface_area_mm2: number; tested_source_face_count: number; precision_checks: Record<string, { minimum_transported_face_alignment: number; maximum_vertex_roundtrip_error_mm: number }> };
  disease: { max_displacement_mm: number; rms_displacement_mm: number; requested_sites: number; realized_sites: number; applied_displacement_fraction: number; effective_morphology_strength: number; displacement_limited_by_source_mesh: boolean; actual_strength_backoffs: number };
  extent_mm: number[]; normal_repair: { repaired_vertex_count: number }; geometry_sha256: string; display_normals_sha256: string;
  samples: { vertex_ids: number[]; positions: number[][]; normals: number[][]; base_colors: number[][]; colors: number[][] };
}
interface Fixture { version: string; kernel_gradient_max: number; profiles: Record<string, DiseaseProfileV2>; templates: Record<string, FixtureTemplate>; cases: FixtureCase[] }

const here = (relative: string) => new URL(relative, import.meta.url);
const fixture = JSON.parse(fs.readFileSync(here("./__fixtures__/disease-v2.json"), "utf8")) as Fixture;
const supportIndex = JSON.parse(fs.readFileSync(here("../public/models/disease-v2/index.json"), "utf8")) as DiseaseSupportIndex;
const templateRoot = process.env.VISCERA_ATLAS_TEMPLATES_V2 ?? path.resolve(process.cwd(), "datasets/anatomy-templates/templates-v3");
const templatesOnDisk = fs.existsSync(path.join(templateRoot, "catalog.json"));

/** The support of a template from the published files, as the browser would fetch it. */
function supportFromDisk(templateId: string): DiseaseSupport {
  const entry = supportIndex.templates[templateId]!;
  const bytes = fs.readFileSync(here(`../public/models/disease-v2/${entry.file}`));
  return parseDiseaseSupport(entry, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

/** np.savez_compressed archives: the zip's central directory (zip64 aware), raw deflate, the .npy header. */
function readNpz(file: string): Record<string, Float64Array | BigInt64Array> {
  const zip = fs.readFileSync(file);
  let eocd = zip.length - 22;
  while (eocd >= 0 && zip.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  let entries = zip.readUInt16LE(eocd + 10), directory = zip.readUInt32LE(eocd + 16);
  if (entries === 0xffff || directory === 0xffffffff) {
    const zip64 = Number(zip.readBigUInt64LE(eocd - 20 + 8));
    entries = Number(zip.readBigUInt64LE(zip64 + 32)); directory = Number(zip.readBigUInt64LE(zip64 + 48));
  }
  const arrays: Record<string, Float64Array | BigInt64Array> = {};
  let p = directory;
  for (let e = 0; e < entries; e++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("npz: bad central directory");
    const method = zip.readUInt16LE(p + 10), nameLength = zip.readUInt16LE(p + 28), extraLength = zip.readUInt16LE(p + 30), commentLength = zip.readUInt16LE(p + 32);
    let compressed = zip.readUInt32LE(p + 20), uncompressed = zip.readUInt32LE(p + 24), offset = zip.readUInt32LE(p + 42);
    const name = zip.toString("utf8", p + 46, p + 46 + nameLength);
    for (let q = p + 46 + nameLength, end = q + extraLength; q < end; q += 4 + zip.readUInt16LE(q + 2)) {
      if (zip.readUInt16LE(q) !== 1) continue;
      let r = q + 4;
      if (uncompressed === 0xffffffff) { uncompressed = Number(zip.readBigUInt64LE(r)); r += 8; }
      if (compressed === 0xffffffff) { compressed = Number(zip.readBigUInt64LE(r)); r += 8; }
      if (offset === 0xffffffff) offset = Number(zip.readBigUInt64LE(r));
    }
    p += 46 + nameLength + extraLength + commentLength;
    const start = offset + 30 + zip.readUInt16LE(offset + 26) + zip.readUInt16LE(offset + 28);
    const raw = zip.subarray(start, start + compressed);
    const npy = method === 8 ? inflateRawSync(raw) : raw;
    if (npy.toString("latin1", 0, 6) !== "\x93NUMPY") throw new Error(`npz: ${name} is not an npy array`);
    const headerLength = npy[6] === 1 ? npy.readUInt16LE(8) : npy.readUInt32LE(8), dataStart = (npy[6] === 1 ? 10 : 12) + headerLength;
    const header = npy.toString("latin1", dataStart - headerLength, dataStart), descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
    const data = npy.buffer.slice(npy.byteOffset + dataStart, npy.byteOffset + npy.length);
    const key = name.replace(/\.npy$/, "");
    if (descr === "<f8") arrays[key] = new Float64Array(data);
    else if (descr === "<i8") arrays[key] = new BigInt64Array(data);
  }
  return arrays;
}

const diseaseTemplates = new Map<string, DiseaseTemplate>();
/** The template as the browser would hold it: rest geometry (here from the npz), limits, normalisation and support. */
function templateFromDisk(templateId: string): DiseaseTemplate {
  let t = diseaseTemplates.get(templateId);
  if (!t) {
    const meta = fixture.templates[templateId]!, arrays = readNpz(path.join(templateRoot, `${templateId}.npz`));
    const faces = Int32Array.from(arrays.faces as BigInt64Array, Number);
    const support = supportFromDisk(templateId);
    primeDiseaseSupport(templateId, support);
    t = diseaseTemplate(templateId, arrays.vertices_mm as Float64Array, faces, meta.organ, meta.control_limits, meta.normalization_mm, support);
    diseaseTemplates.set(templateId, t);
  }
  return t;
}

const maxAbs = (a: ArrayLike<number>, b: ArrayLike<number>) => { expect(a.length).toBe(b.length); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!)); return m; };
const maxRel = (a: ArrayLike<number>, b: ArrayLike<number>) => { expect(a.length).toBe(b.length); let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!) / Math.max(1e-300, Math.abs(b[i]!))); return m; };
const rel = (a: number, b: number) => Math.abs(a - b) / Math.max(1e-300, Math.abs(b));
const sha256 = async (values: Float64Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new Float32Array(values).buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
const label = (c: { template_id: string; profile_id: string; recipe: AtlasDiseaseSpec }) => `${c.template_id} ${c.profile_id} seed ${c.recipe.seed} severity ${c.recipe.severity}`;
/** The worst deviation seen per quantity, for the report. */
class Worst { values = new Map<string, number>(); note(key: string, value: number) { this.values.set(key, Math.max(this.values.get(key) ?? 0, value)); } text() { return [...this.values].map(([k, v]) => `${k} ≤ ${v.toExponential(2)}`).join(", "); } }

/** The QA of the browser against the renderer's numbers (fixture or API). */
function expectQaClose(ours: DiseaseMeshQa, theirs: Record<string, unknown>, worst: Worst, where: string): void {
  for (const key of ["passed", "opposed_transported_face_normals", "new_degenerate_faces", "normal_turns_over_90_degrees", "tested_source_face_count"] as const) if (key in theirs) expect(ours[key], `${where} qa.${key}`).toBe(theirs[key]);
  for (const key of ["minimum_all_precision_alignment", "minimum_transported_face_alignment", "min_normal_dot"] as const) { const d = Math.abs(ours[key] - (theirs[key] as number)); worst.note(`qa.${key}`, d); expect(d, `${where} qa.${key}`).toBeLessThan(1e-9); }
  for (const key of ["area_ratio_min", "area_ratio_max", "surface_area_mm2", "continuous_jacobian_lower_bound"] as const) { const d = rel(ours[key], theirs[key] as number); worst.note(`qa.${key} rel`, d); expect(d, `${where} qa.${key}`).toBeLessThan(1e-9); }
  const checks = theirs.precision_checks as Record<string, Record<string, number>>;
  for (const name of ["studio_float32_mm", "gltf_float32_m"] as const) {
    const d = Math.abs(ours.precision_checks[name].minimum_transported_face_alignment - checks[name]!.minimum_transported_face_alignment!);
    worst.note("qa.precision alignment", d); expect(d, `${where} ${name} alignment`).toBeLessThan(1e-9);
    const r = Math.abs(ours.precision_checks[name].maximum_vertex_roundtrip_error_mm - checks[name]!.maximum_vertex_roundtrip_error_mm!);
    worst.note("qa.precision roundtrip", r); expect(r, `${where} ${name} roundtrip`).toBeLessThan(1e-9);
  }
}

// ---------------------------------------------------------------------------------------------- offline, from the fixtures
describe("the disease renderer's support files", () => {
  it("are the index's bitmasks: ascending vertex ids, the counts the index states, for every template", () => {
    expect(Object.keys(supportIndex.templates)).toHaveLength(24);
    for (const [templateId, entry] of Object.entries(supportIndex.templates)) {
      const support = supportFromDisk(templateId);
      expect(support.eligible.length).toBe(entry.eligible_count);
      expect(support.pool.length).toBe(entry.pool_count);
      for (let i = 1; i < support.pool.length; i++) expect(support.pool[i]!).toBeGreaterThan(support.pool[i - 1]!);
      const eligible = new Set(support.eligible);
      expect(support.pool.every((v) => eligible.has(v)), `${templateId}: the pool is drawn from the eligible vertices`).toBe(true);
    }
  });
  it("refuse a payload that disagrees with the index", () => {
    const entry = supportIndex.templates["hra-liver-female"]!;
    expect(() => parseDiseaseSupport(entry, new ArrayBuffer(entry.bytes - 1))).toThrow(/match its index/);
    expect(() => parseDiseaseSupport(entry, new ArrayBuffer(entry.bytes))).toThrow(/fewer vertices/);
  });
});

describe.skipIf(!templatesOnDisk)("the disease renderer against the Python renderer's fixtures", () => {
  it("builds the templates the fixtures describe: support, pool, source normals and the 20873 pool draw", async () => {
    for (const [templateId, meta] of Object.entries(fixture.templates)) {
      const t = templateFromDisk(templateId);
      expect(t.support.entry.minimum_support_radius_mm).toBe(meta.minimum_support_radius_mm);
      expect(Array.from(t.support.pool.subarray(0, meta.pool_head.length))).toEqual(meta.pool_head);
      // the fixed pool is numpy's choice without replacement from the eligible set, plus the axis extremes
      const eligible = t.support.eligible, rng = new Pcg64(20873);
      const chosen = new Set(rng.choiceWithoutReplacement(eligible.length, Math.min(8192, eligible.length)).map((i) => eligible[i]!));
      for (let axis = 0; axis < 3; axis++) {
        let lo = eligible[0]!, hi = eligible[0]!;
        for (const e of eligible) { if (t.rest[e * 3 + axis]! < t.rest[lo * 3 + axis]!) lo = e; if (t.rest[e * 3 + axis]! > t.rest[hi * 3 + axis]!) hi = e; }
        chosen.add(lo); chosen.add(hi);
      }
      expect([...chosen].sort((a, b) => a - b), `${templateId}: pool from the generator`).toEqual(Array.from(t.support.pool));
      // trimesh's angle-weighted normals (the lung's welded)
      const sample = meta.normals_sample_ids.flatMap((id) => [t.normals[id * 3]!, t.normals[id * 3 + 1]!, t.normals[id * 3 + 2]!]);
      expect(maxAbs(sample, meta.normals_sample.flat()), `${templateId}: source normals`).toBeLessThan(1e-12);
      expect(await sha256(t.normals), `${templateId}: source normals as float32`).toBe(meta.source_normals_sha256);
      // the eligible bounding box the sites are placed in
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const e of eligible) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, t.rest[e * 3 + k]!); hi[k] = Math.max(hi[k]!, t.rest[e * 3 + k]!); }
      expect(lo.map((v, k) => (v + hi[k]!) / 2)).toEqual(meta.eligible_center_mm);
      expect(hi.map((v, k) => v - lo[k]!)).toEqual(meta.eligible_extent_mm);
    }
  }, 120000);

  it("replays every case: the generator's draws and anchors exactly, the field, the guard, the QA and the surface", async () => {
    const worst = new Worst();
    let geometryHashes = 0, normalHashes = 0;
    for (const c of fixture.cases) {
      const where = label(c), t = templateFromDisk(c.template_id), profile = fixture.profiles[c.profile_id]!;
      expect(fixture.kernel_gradient_max).toBe(96 / (25 * Math.sqrt(5)));
      // numpy's draws as the renderer takes them
      const rng = new Pcg64(c.recipe.seed);
      expect(rng.permutation(Array.from(t.support.pool)).slice(0, c.rng.permutation_head.length), `${where}: permutation`).toEqual(c.rng.permutation_head);
      expect(rng.random(c.rng.draws.length), `${where}: draws`).toEqual(c.rng.draws);
      const ours = await realizeDiseaseGeometry(t, c.controls, c.recipe, profile);
      expect(ours.fraction, where).toBe(c.shape_fraction);
      expect(ours.applied, where).toEqual(c.applied_controls);
      const field = ours.field as DiseaseFieldV2;
      expect(field.fields.map((s) => s.anchor_vertex_id), `${where}: anchors`).toEqual(c.field.anchor_vertex_ids);
      expect(field.realized_sites).toBe(c.field.realized_sites); expect(field.requested_sites).toBe(c.field.requested_sites);
      expect(field.effective_support_radius_mm).toBe(c.field.radius_mm); expect(field.requested_support_radius_mm).toBe(c.field.requested_radius_mm);
      expect(field.global_center_mm).toEqual(c.field.global_center_mm);
      worst.note("amplitude rel", maxRel(field.fields.map((s) => s.amplitude_mm), c.field.amplitudes_mm));
      worst.note("direction", maxAbs(field.fields.slice(0, c.field.directions.length).flatMap((s) => s.direction), c.field.directions.flat()));
      worst.note("global_scale rel", maxRel(field.global_scale, c.field.global_scale));
      worst.note("global_log_scale rel", maxRel(field.global_log_scale, c.field.global_log_scale));
      for (const key of ["color_strength", "gradient_bound_per_step", "continuous_jacobian_lower_bound", "effective_morphology_strength", "applied_displacement_fraction"] as const) worst.note(`field.${key} rel`, rel(field[key] as number, c.field[key]));
      const guard = field.discrete_guard, theirs = c.field.discrete_guard;
      expect(Boolean(guard), where).toBe(Boolean(theirs));
      if (guard && theirs) {
        expect(guard.strength_capacity).toBe(theirs.strength_capacity); expect(guard.actual_strength_backoffs).toBe(theirs.actual_strength_backoffs); expect(guard.source_limited).toBe(theirs.source_limited);
        worst.note("guard rejected rel", maxRel(guard.intermediate_rejected_strengths, theirs.intermediate_rejected_strengths));
        worst.note("guard amplitude rel", Math.max(rel(guard.requested_max_step_amplitude_mm, theirs.requested_max_step_amplitude_mm), rel(guard.effective_max_step_amplitude_mm, theirs.effective_max_step_amplitude_mm)));
        worst.note("guard alignment", Math.abs(guard.minimum_transported_face_alignment - theirs.minimum_transported_face_alignment));
      }
      expectQaClose(ours.qa, c.qa, worst, where);
      // the surface at the sampled vertices, the displacement statistics over all of them
      const ids = c.samples.vertex_ids;
      worst.note("position mm", maxAbs(ids.flatMap((i) => [ours.positions[i * 3]!, ours.positions[i * 3 + 1]!, ours.positions[i * 3 + 2]!]), c.samples.positions.flat()));
      worst.note("normal", maxAbs(ids.flatMap((i) => [ours.normals[i * 3]!, ours.normals[i * 3 + 1]!, ours.normals[i * 3 + 2]!]), c.samples.normals.flat()));
      const rest = Float64Array.from(ids.flatMap((i) => [t.rest[i * 3]!, t.rest[i * 3 + 1]!, t.rest[i * 3 + 2]!]));
      worst.note("colour", maxAbs(applyDiseaseColor(c.samples.base_colors.flat(), rest, field), c.samples.colors.flat()));
      const baseline = deformVertices(t.rest, ours.applied, t.limits, t.normalization);
      let dmax = 0, dsum = 0;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < baseline.length; i += 3) { let d2 = 0; for (let k = 0; k < 3; k++) { const v = ours.positions[i + k]!, d = v - baseline[i + k]!; d2 += d * d; lo[k] = Math.min(lo[k]!, v); hi[k] = Math.max(hi[k]!, v); } dsum += d2; dmax = Math.max(dmax, d2); }
      worst.note("max_displacement mm", Math.abs(Math.sqrt(dmax) - c.disease.max_displacement_mm));
      worst.note("rms_displacement mm", Math.abs(Math.sqrt(dsum / baseline.length * 3) - c.disease.rms_displacement_mm));
      worst.note("extent mm", maxAbs(hi.map((v, k) => v - lo[k]!), c.extent_mm));
      expect(ours.normalRepair.repaired_vertex_count, where).toBe(c.normal_repair.repaired_vertex_count);
      expect(ours.normalRepair.sha256).toBe(await sha256(ours.normals));
      if (ours.normalRepair.sha256 === c.display_normals_sha256) normalHashes++;
      if (await geometryHash(ours.positions, t.faces) === c.geometry_sha256) geometryHashes++;
    }
    // the hashes are informative: a last-bit difference of V8's exp or tanh against libm's changes a float64 hash
    console.log(`disease renderer vs Python fixtures (${fixture.cases.length} cases): ${worst.text()}; geometry sha256 equal in ${geometryHashes}/${fixture.cases.length}, float32 normal sha256 equal in ${normalHashes}/${fixture.cases.length}`);
    expect(worst.values.get("position mm")!).toBeLessThan(1e-6);
    expect(worst.values.get("normal")!).toBeLessThan(1e-9);
    expect(worst.values.get("colour")!).toBeLessThan(1e-9);
    expect(worst.values.get("amplitude rel")!).toBeLessThan(1e-12);
    expect(worst.values.get("direction")!).toBeLessThan(1e-12);
    expect(worst.values.get("max_displacement mm")!).toBeLessThan(1e-6);
    expect(worst.values.get("extent mm")!).toBeLessThan(1e-6);
  }, 600000);

  it("refuses what the renderer refuses", async () => {
    const liver = templateFromDisk("hra-liver-female"), kidney = fixture.profiles["kidney-cancer"]!;
    const recipe: AtlasDiseaseSpec = { profile_id: "kidney-cancer", seed: 1, severity: 0.5, size: 0.5, spread: 0.5, irregularity: 0.35, contrast: 0.45, count: 3, location: [0, 0, 0] };
    await expect(realizeDiseaseGeometry(liver, fixture.cases[0]!.controls, recipe, kidney)).rejects.toThrow(/must match selected organ/);
    const library = { profiles: [{ ...kidney, supported: false }, { id: "half", organ: "liver", label: "x", pattern: "x", source_ref: "x", source_url: "x", limits: "x" }] } as unknown as AtlasDiseaseLibrary;
    expect(() => diseaseProfileV2(library, "kidney-cancer")).toThrow(/internal-only/);
    expect(() => diseaseProfileV2(library, "half")).toThrow(/renderer parameters/);
    expect(() => diseaseProfileV2(undefined, "liver-cirrhosis")).toThrow(/Unknown/);
  });

  it("computes trimesh's normals: a degenerate corner zeroes its triangle, an unreferenced vertex stays zero", () => {
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 5, 5, 1e-20, 0, 0];
    const normals = trimeshVertexNormals(vertices, [0, 1, 2, 0, 2, 3, 0, 5, 1]);
    expect(Array.from(normals.subarray(12, 15))).toEqual([0, 0, 0]);      // unreferenced
    expect(Array.from(normals.subarray(3, 6)).map((v) => Math.round(v * 1e12) / 1e12)).toEqual([0, 0, 1]);   // the sliver 0-5-1 has no normal (|cross| ≤ 1e-13) and is dropped
    const n0 = normals.subarray(0, 3);                                      // two right angles weigh the two faces (+z and +x) equally
    expect(n0[0]).toBeCloseTo(1 / Math.sqrt(2), 12); expect(n0[1]).toBe(0); expect(n0[2]).toBeCloseTo(1 / Math.sqrt(2), 12);
  });
});

// ---------------------------------------------------------------------------------------------- against the API itself
const API = (process.env.VISCERA_API_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
const online = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
const post = async (route: string, body: unknown) => {
  const r = await fetch(`${API}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${route}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  return r.json();
};

describe.skipIf(!online || !templatesOnDisk)("the disease renderer against the API's route", () => {
  const references = new Map<string, Promise<{ template: AtlasTemplate; spec: AtlasSpec; reference: AtlasGeneration }>>();
  let catalogPromise: Promise<AtlasCatalog> | null = null;
  const catalog = () => (catalogPromise ??= fetch(`${API}/api/atlas/catalog`).then((r) => r.json() as Promise<AtlasCatalog>));
  const load = (templateId: string) => {
    let p = references.get(templateId);
    if (!p) {
      p = catalog().then(async (library) => {
        const organ = library.organs.find((o) => o.templates.some((t) => t.id === templateId))!;
        const template = { ...organ.templates.find((t) => t.id === templateId)! };
        template.normalization_mm = JSON.parse(fs.readFileSync(path.join(templateRoot, `${templateId}.json`), "utf8")).normalization_mm;
        const spec: AtlasSpec = { renderer_version: "disease-v2", template_id: templateId, seed: 42, controls: Object.fromEntries(library.controls.map((c) => [c.key, c.default])), appearance: "tissue", material: { ...library.materials!.defaults[organ.id]! } };
        primeDiseaseSupport(templateId, supportFromDisk(templateId));
        return { template, spec, reference: (await post("/api/atlas/generate", spec)) as AtlasGeneration };
      });
      references.set(templateId, p);
    }
    return p;
  };
  const byTemplate = new Map<string, FixtureCase[]>();
  for (const c of fixture.cases) byTemplate.set(c.template_id, [...(byTemplate.get(c.template_id) ?? []), c]);
  const worst = new Worst();
  let geometryHashes = 0, normalHashes = 0, compared = 0;

  for (const [templateId, cases] of byTemplate) {
    it(`matches /api/atlas/generate for ${templateId} (${cases.length} recipes)`, async () => {
      const library = await catalog();
      expect(library.renderer_version).toBe("disease-v2");
      const { template, spec, reference } = await load(templateId);
      for (const c of cases) {
        const where = label(c);
        const request: AtlasSpec = { ...spec, controls: { ...spec.controls, ...c.controls }, disease: { ...c.recipe } };
        const api = (await post("/api/atlas/generate", request)) as AtlasGeneration;
        const ours = await realizeDiseaseLocally(reference, request, template, library.diseases);
        validateAtlasGeneration(ours, library);
        expect(sameAtlasRecipe(request, ours.spec), `${where}: the recipe comes back as requested`).toBe(true);
        for (const key of ["renderer_version", "template_id", "seed", "appearance", "template_sha256"]) expect(ours.spec[key], `${where} spec.${key}`).toEqual(api.spec[key]);
        expect(ours.spec.controls).toEqual(api.spec.controls); expect(ours.spec.material).toEqual(api.spec.material); expect(ours.spec.disease).toEqual(api.spec.disease);
        const a = api.scene.organs[0]!, b = ours.scene.organs[0]!;
        worst.note("position mm", maxAbs(b.positions, a.positions));
        worst.note("normal", maxAbs(b.normals!, a.normals!));
        worst.note("colour", maxAbs(b.colors!, a.colors!));
        expect(b.indices).toEqual(a.indices);
        expect((b as unknown as { rest_positions: number[] }).rest_positions).toEqual((a as unknown as { rest_positions: number[] }).rest_positions);
        // the field the shader and the exports read
        const theirField = a.metadata!.disease_field as DiseaseFieldV2, ourField = b.metadata!.disease_field as DiseaseFieldV2;
        expect(ourField.fields.map((s) => s.anchor_vertex_id), `${where}: anchors`).toEqual(theirField.fields.map((s) => s.anchor_vertex_id));
        expect(ourField.fields.map((s) => s.center_mm)).toEqual(theirField.fields.map((s) => s.center_mm));
        worst.note("amplitude rel", maxRel(ourField.fields.map((s) => s.amplitude_mm), theirField.fields.map((s) => s.amplitude_mm)));
        worst.note("direction", maxAbs(ourField.fields.flatMap((s) => s.direction), theirField.fields.flatMap((s) => s.direction)));
        worst.note("radius rel", maxRel(ourField.fields.map((s) => s.radius_mm), theirField.fields.map((s) => s.radius_mm)));
        for (const key of ["version", "renderer_version", "profile_id", "pattern", "mechanism", "steps", "requested_sites", "realized_sites", "minimum_support_policy", "surface_site_frame", "clinical_stage", "visibility", "normal_policy", "site_policy", "target_srgb", "requested_morphology_strength"] as const) expect(ourField[key], `${where} field.${key}`).toEqual(theirField[key]);
        for (const key of ["color_strength", "gradient_bound_per_step", "continuous_jacobian_lower_bound", "requested_support_radius_mm", "effective_support_radius_mm", "effective_morphology_strength", "applied_displacement_fraction"] as const) worst.note(`field.${key} rel`, rel(ourField[key] as number, theirField[key] as number));
        worst.note("global_scale rel", maxRel(ourField.global_scale, theirField.global_scale));
        expect(ourField.global_center_mm).toEqual(theirField.global_center_mm);
        const g = ourField.discrete_guard, h = theirField.discrete_guard;
        expect(Boolean(g)).toBe(Boolean(h));
        if (g && h) {
          for (const key of ["policy", "face_count", "strength_capacity", "strength_mapping", "actual_strength_backoffs", "source_limited", "opposed_transported_face_normals"] as const) expect(g[key], `${where} guard.${key}`).toEqual(h[key]);
          worst.note("guard rejected rel", maxRel(g.intermediate_rejected_strengths, h.intermediate_rejected_strengths));
          worst.note("guard fraction rel", Math.max(rel(g.local_amplitude_fraction, h.local_amplitude_fraction), rel(g.global_envelope_fraction, h.global_envelope_fraction)));
          worst.note("guard amplitude rel", Math.max(rel(g.requested_max_step_amplitude_mm, h.requested_max_step_amplitude_mm), rel(g.effective_max_step_amplitude_mm, h.effective_max_step_amplitude_mm)));
        }
        expectQaClose(ourField.full_mesh_qa!, theirField.full_mesh_qa as unknown as Record<string, unknown>, worst, `${where} field`);
        // the scene's provenance the UI reads
        const am = api.scene.metadata as Record<string, Record<string, unknown>>, bm = ours.scene.metadata as Record<string, Record<string, unknown>>;
        expectQaClose(bm.qa as unknown as DiseaseMeshQa, am.qa!, worst, `${where} scene`);
        for (const key of ["scope", "status", "source_face_count", "ignored_degenerate_source_faces", "topology_preserved", "source_topology", "normal_turn_interpretation"]) expect(bm.qa![key], `${where} qa.${key}`).toEqual(am.qa![key]);
        const theirs = am.disease!, mine = bm.disease!;
        expect(Object.keys(mine).sort()).toEqual(Object.keys(theirs).sort());
        for (const key of ["version", "renderer_version", "recipe", "profile", "evidence", "requested_sites", "realized_sites", "displacement_limited_by_source_mesh", "source_precision_repair", "actual_strength_backoffs", "internal_anatomy_generated", "physical_parameters_inferred", "severity_semantics"]) expect(mine[key], `${where} disease.${key}`).toEqual(theirs[key]);
        for (const key of ["applied_displacement_fraction", "effective_morphology_strength", "requested_morphology_strength"]) worst.note(`disease.${key} rel`, rel(mine[key] as number, theirs[key] as number));
        worst.note("max_displacement mm", Math.abs((mine.max_displacement_mm as number) - (theirs.max_displacement_mm as number)));
        worst.note("rms_displacement mm", Math.abs((mine.rms_displacement_mm as number) - (theirs.rms_displacement_mm as number)));
        const projection = mine.shape_control_projection as Record<string, unknown>, theirProjection = theirs.shape_control_projection as Record<string, unknown>;
        expect(projection).toEqual(theirProjection);
        expect(ours.summary.disease, "summary.disease is scene.metadata.disease, as the API serialises it").toBe(mine);
        worst.note("extent mm", maxAbs(ours.summary.extent_mm as number[], api.summary.extent_mm as number[]));
        const m1 = bm.measurements!, m2 = am.measurements!;
        expect(Object.keys(m1).sort()).toEqual(Object.keys(m2).sort());
        for (const key of Object.keys(m2)) if (typeof m2[key] === "number") worst.note(`measurements rel`, rel(m1[key] as number, m2[key] as number)); else expect(m1[key], `${where} measurements.${key}`).toEqual(m2[key]);
        worst.note("summary.min_jacobian rel", rel(ours.summary.min_jacobian as number, api.summary.min_jacobian as number));
        expect(ours.summary.min_jacobian_kind).toBe(api.summary.min_jacobian_kind); expect(ours.summary.qa_scope).toBe(api.summary.qa_scope);
        expect((bm.display_normals as { policy: string }).policy).toBe((am.display_normals as { policy: string }).policy);
        expect((bm.normal_repair as { repaired_vertex_count: number }).repaired_vertex_count).toBe((am.normal_repair as { repaired_vertex_count: number }).repaired_vertex_count);
        expect((b.metadata!.material_v2 as { display_normal_sha256: string }).display_normal_sha256).toBe((bm.display_normals as { sha256: string }).sha256);
        if (bm.geometry_sha256 === am.geometry_sha256) geometryHashes++;
        if ((bm.display_normals as { sha256: string }).sha256 === (am.display_normals as { sha256: string }).sha256) normalHashes++;
        compared++;
      }
    }, 900000);
  }

  it("reports the measured agreement", () => {
    console.log(`disease renderer vs API (${compared} generations): ${worst.text()}; geometry sha256 equal in ${geometryHashes}/${compared}, float32 normal sha256 equal in ${normalHashes}/${compared}`);
    expect(compared).toBe(fixture.cases.length);
    expect(worst.values.get("position mm")!).toBeLessThan(1e-6);
    expect(worst.values.get("normal")!).toBeLessThan(1e-9);
    expect(worst.values.get("colour")!).toBeLessThan(1e-9);
    expect(worst.values.get("amplitude rel")!).toBeLessThan(1e-12);
    expect(worst.values.get("direction")!).toBeLessThan(1e-12);
    expect(worst.values.get("max_displacement mm")!).toBeLessThan(1e-6);
    expect(worst.values.get("extent mm")!).toBeLessThan(1e-6);
    expect(worst.values.get("measurements rel")!).toBeLessThan(1e-9);
    expect(worst.values.get("summary.min_jacobian rel")!).toBeLessThan(1e-12);
  });
});
