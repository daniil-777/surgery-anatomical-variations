/** The disease-v2 morphology renderer in the browser: viscera_core.atlas_disease_v2 and atlas_disease_scene_v2.realize
 *  repeated in TypeScript, so the public copy can show a disease specimen without the API. The bundled reference
 *  specimen gives the template's rest geometry; public/models/disease-v2 (scripts/export_disease_morphology_fixtures.py)
 *  gives what the browser cannot derive — the anchorable vertices and the fixed candidate pool, which depend on
 *  component names that are not bundled — and the minimum support radius. Everything else is computed here in float64
 *  with NumPy's operation order: trimesh's angle-weighted source normals (the anchor directions), numpy's generator
 *  for the pool's permutation and the per-site draws (numpyRandom.ts), the compact displacement map with its
 *  Sherman–Morrison covector transport, the source-capacity and precision back-offs, the all-precision face QA, the
 *  rest-frame colour mix and the shading-normal repair. atlasDiseaseLocal.test.ts replays the Python renderer's
 *  fixtures and compares against the running API. */
import type { OrganMesh, SceneData } from "@viscera/render";
import { publicUrl } from "./api";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import type { AtlasDiseaseLibrary, AtlasDiseaseProfile, AtlasDiseaseSpec } from "./atlasDisease";
import { CONTROL_NAMES, LOCAL_REALIZER_VERSION, canonicalJson, deformVertices, geometryHash, realizeLocally } from "./atlasLocal";
import { Pcg64 } from "./numpyRandom";

export const DISEASE_SUPPORT_FORMAT = "viscera-disease-v2-support";
export const DISEASE_FIELD_VERSION = "disease-morphology-design-2.0.0";
/** The exact maximum of the kernel's radial derivative 6t(1-t²)²: 96 / (25√5). */
export const KERNEL_GRADIENT_MAX = 96 / (25 * Math.sqrt(5));
const NORMAL_POLICY = "inverse-transpose-continuous-map-source-normal-v2";
const NORMAL_REPAIR_VERSION = "atlas-surface-normal-repair-1.0.0";
const TRIMESH_ZERO = 1e-13;   // trimesh.tol.zero: a vector below this length is not unitized
const TRIMESH_MERGE = 1e-8;   // trimesh.tol.merge: a corner angle below this makes the triangle's angles zero

type Vec3 = [number, number, number];
type Controls = Record<string, number>;

// ---------------------------------------------------------------------------------------------- profiles
/** The disease-v2 profile as the API's catalogue carries it: the authoring parameters the renderer reads. */
export interface DiseaseProfileV2 extends AtlasDiseaseProfile {
  mechanism: string; radius_min_fraction: number; radius_range_fraction: number; amplitude_ratio: number; steps: number;
  count_multiplier: number; maximum_sites: number; global_log_scale: Vec3; target_srgb: Vec3; visibility: string;
}
const finiteVec3 = (value: unknown): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number" && Number.isFinite(v));
/** The profile of a recipe, from the catalogue's disease library; refuses profiles the renderer cannot run. */
export function diseaseProfileV2(library: AtlasDiseaseLibrary | undefined, profileId: string): DiseaseProfileV2 {
  const profile = library?.profiles.find((p) => p.id === profileId) as Partial<DiseaseProfileV2> | undefined;
  if (!profile || profile.supported === false) throw new Error("Unknown or internal-only disease-v2 surface profile");
  const numbers = ["radius_min_fraction", "radius_range_fraction", "amplitude_ratio", "steps", "count_multiplier", "maximum_sites"] as const;
  if (numbers.some((key) => typeof profile[key] !== "number" || !Number.isFinite(profile[key])) || !finiteVec3(profile.global_log_scale) || !finiteVec3(profile.target_srgb) || typeof profile.mechanism !== "string" || typeof profile.visibility !== "string")
    throw new Error("The disease library does not carry this profile's renderer parameters.");
  return profile as DiseaseProfileV2;
}

// ---------------------------------------------------------------------------------------------- the bundled support
export interface DiseaseSupportEntry {
  organ: string; vertex_count: number; face_count: number; geometry_sha256: string; template_sha256: string; eligible_count: number;
  pool_count: number; minimum_support_radius_mm: number; normals_policy: string; source_normals_sha256: string; file: string; bytes: number;
}
export interface DiseaseSupportIndex { format: string; version: string; pool_seed: number; pool_size: number; templates: Record<string, DiseaseSupportEntry> }
/** A template's anchorable vertices and its fixed candidate pool, both ascending (np.unique's order, which the pool's
 *  permutation starts from). */
export interface DiseaseSupport { entry: DiseaseSupportEntry; eligible: Int32Array; pool: Int32Array }

function unpackBits(bytes: Uint8Array, offset: number, count: number, expected: number): Int32Array {
  const out = new Int32Array(expected);
  let n = 0;
  for (let i = 0; i < count; i++) if ((bytes[offset + (i >> 3)]! >> (i & 7)) & 1) { if (n === expected) throw new Error("The disease support has more vertices than its index says."); out[n++] = i; }
  if (n !== expected) throw new Error("The disease support has fewer vertices than its index says.");
  return out;
}
export function parseDiseaseSupport(entry: DiseaseSupportEntry, data: ArrayBuffer): DiseaseSupport {
  const bytes = new Uint8Array(data), stride = Math.ceil(entry.vertex_count / 8);
  if (bytes.length !== 2 * stride || bytes.length !== entry.bytes) throw new Error("The disease support does not match its index.");
  return { entry, eligible: unpackBits(bytes, 0, entry.vertex_count, entry.eligible_count), pool: unpackBits(bytes, stride, entry.vertex_count, entry.pool_count) };
}
let cachedIndex: Promise<DiseaseSupportIndex> | null = null;
const supports = new Map<string, Promise<DiseaseSupport>>();
/** The index alone (15 KB): which templates the bundled renderer supports. */
export function diseaseSupportIndex(signal?: AbortSignal): Promise<DiseaseSupportIndex> {
  cachedIndex ??= fetch(publicUrl("models/disease-v2/index.json"), { cache: "default" }).then(async (response) => {
    if (!response.ok) throw new Error("The disease renderer's support sets are not bundled with this copy.");
    const index = await response.json() as DiseaseSupportIndex;
    if (index.format !== DISEASE_SUPPORT_FORMAT || index.version !== DISEASE_FIELD_VERSION) throw new Error("Unsupported disease support export.");
    return index;
  }).catch((error) => { cachedIndex = null; throw error; });
  return cachedIndex;
}
export function loadDiseaseSupport(templateId: string, signal?: AbortSignal): Promise<DiseaseSupport> {
  let p = supports.get(templateId);
  if (!p) {
    p = diseaseSupportIndex(signal).then(async (index) => {
      const entry = index.templates[templateId];
      if (!entry) throw new Error("This reference is absent from the bundled disease renderer; choose another reference.");
      const response = await fetch(publicUrl(`models/disease-v2/${entry.file}`), { cache: "default" });
      if (!response.ok) throw new Error("The disease support of this reference is not bundled with this copy.");
      return parseDiseaseSupport(entry, await response.arrayBuffer());
    });
    supports.set(templateId, p);
    p.catch(() => supports.delete(templateId));
  }
  return p;
}
/** Tests and tools that read the support from disk hand it over instead of fetching. */
export function primeDiseaseSupport(templateId: string, support: DiseaseSupport): void { supports.set(templateId, Promise.resolve(support)); }

// ---------------------------------------------------------------------------------------------- small arithmetic
// np.linalg.norm over a row: the square root of the sequential sum of squares (not hypot)
const norm3 = (x: number, y: number, z: number) => Math.sqrt(x * x + y * y + z * z);
/** numpy's rint: round half to even. */
function rint(x: number): number { const f = Math.floor(x), d = x - f; return d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1; }
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const float32Hash = (values: Float64Array) => sha256Hex(new Uint8Array(new Float32Array(values).buffer));
const scaledControls = (controls: Controls, limits: ArrayLike<number>) => CONTROL_NAMES.map((name, i) => (controls[name] ?? 0) * limits[i]!);

/** Per-face cross product of the two edges from the first vertex and its length (twice the area). */
function faceCross(positions: ArrayLike<number>, faces: ArrayLike<number>): { cross: Float64Array; area2: Float64Array } {
  const n = faces.length / 3, cross = new Float64Array(n * 3), area2 = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = faces[f * 3]! * 3, b = faces[f * 3 + 1]! * 3, c = faces[f * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    cross[f * 3] = x; cross[f * 3 + 1] = y; cross[f * 3 + 2] = z; area2[f] = norm3(x, y, z);
  }
  return { cross, area2 };
}

// ---------------------------------------------------------------------------------------------- source normals
/** trimesh.util.unitize on rows: a row longer than tol.zero is multiplied by the reciprocal of its length, a shorter
 *  one by its length itself (as the C-contiguous NumPy code does, so it shrinks instead of staying). */
function unitizeRows(vectors: Float64Array): { unit: Float64Array; valid: Uint8Array } {
  const unit = new Float64Array(vectors.length), valid = new Uint8Array(vectors.length / 3);
  for (let i = 0; i < vectors.length; i += 3) {
    const length = norm3(vectors[i]!, vectors[i + 1]!, vectors[i + 2]!);
    const ok = length > TRIMESH_ZERO, factor = ok ? 1 / length : length;
    valid[i / 3] = ok ? 1 : 0;
    unit[i] = vectors[i]! * factor; unit[i + 1] = vectors[i + 1]! * factor; unit[i + 2] = vectors[i + 2]! * factor;
  }
  return { unit, valid };
}
/** trimesh.Trimesh(vertices, faces, process=False).vertex_normals: Thürmer–Wüthrich angle-weighted face normals, faces
 *  without a normal dropped, degenerate corner angles zeroed, the sums unitized (an unreferenced vertex stays zero). */
export function trimeshVertexNormals(vertices: ArrayLike<number>, faces: ArrayLike<number>): Float64Array {
  const count = faces.length / 3, ab = new Float64Array(count * 3), ac = new Float64Array(count * 3), bc = new Float64Array(count * 3);
  for (let f = 0; f < count; f++) {
    const a = faces[f * 3]! * 3, b = faces[f * 3 + 1]! * 3, c = faces[f * 3 + 2]! * 3;
    for (let k = 0; k < 3; k++) { ab[f * 3 + k] = vertices[b + k]! - vertices[a + k]!; ac[f * 3 + k] = vertices[c + k]! - vertices[a + k]!; bc[f * 3 + k] = vertices[c + k]! - vertices[b + k]!; }
  }
  const normals = unitizeRows(faceCross(vertices, faces).cross);
  const u = unitizeRows(ab).unit, v = unitizeRows(ac).unit, w = unitizeRows(bc).unit;
  const summed = new Float64Array(vertices.length);
  for (let f = 0; f < count; f++) {
    const nx = normals.valid[f] ? normals.unit[f * 3]! : 0, ny = normals.valid[f] ? normals.unit[f * 3 + 1]! : 0, nz = normals.valid[f] ? normals.unit[f * 3 + 2]! : 0;
    if (nx * nx + ny * ny + nz * nz <= 0.5) continue;
    const i = f * 3;
    const a0 = Math.acos(Math.min(1, Math.max(-1, u[i]! * v[i]! + u[i + 1]! * v[i + 1]! + u[i + 2]! * v[i + 2]!)));
    const a1 = Math.acos(Math.min(1, Math.max(-1, -u[i]! * w[i]! + -u[i + 1]! * w[i + 1]! + -u[i + 2]! * w[i + 2]!)));
    const a2 = Math.PI - a0 - a1;
    const degenerate = a0 < TRIMESH_MERGE || a1 < TRIMESH_MERGE || a2 < TRIMESH_MERGE;
    const angles = degenerate ? [0, 0, 0] : [a0, a1, a2];
    for (let corner = 0; corner < 3; corner++) {
      const vertex = faces[f * 3 + corner]! * 3, angle = angles[corner]!;
      summed[vertex] = summed[vertex]! + angle * nx; summed[vertex + 1] = summed[vertex + 1]! + angle * ny; summed[vertex + 2] = summed[vertex + 2]! + angle * nz;
    }
  }
  return unitizeRows(summed).unit;
}
/** viscera_core.atlas_scene.display_normals: trimesh's normals of the source, for the lung on a copy welded at 1e-8 mm
 *  (its segments share seams vertex for vertex) and indexed back. */
export function displayNormals(vertices: ArrayLike<number>, faces: ArrayLike<number>, organ: string): Float64Array {
  if (organ !== "lung") return trimeshVertexNormals(vertices, faces);
  const groups = new Map<string, number>(), group = new Int32Array(vertices.length / 3), representative: number[] = [];
  for (let i = 0; i < group.length; i++) {
    const key = `${rint(vertices[i * 3]! * 1e8)},${rint(vertices[i * 3 + 1]! * 1e8)},${rint(vertices[i * 3 + 2]! * 1e8)}`;
    let id = groups.get(key);
    if (id === undefined) { id = representative.length; groups.set(key, id); representative.push(i); }
    group[i] = id;
  }
  const welded = new Float64Array(representative.length * 3);
  representative.forEach((source, id) => { for (let k = 0; k < 3; k++) welded[id * 3 + k] = vertices[source * 3 + k]!; });
  const weldedFaces = Int32Array.from(faces, (vertex) => group[vertex]!);
  const normals = trimeshVertexNormals(welded, weldedFaces), out = new Float64Array(vertices.length);
  for (let i = 0; i < group.length; i++) for (let k = 0; k < 3; k++) out[i * 3 + k] = normals[group[i]! * 3 + k]!;
  return out;
}

export interface NormalRepair {
  policy: string; source_sha256: string; sha256: string; geometry_modified: false; valid_input_normals_preserved: true; repaired_vertex_count: number;
  repaired_vertex_indices: number[]; area_weighted_incident_count: number; largest_incident_face_fallback_count: number; invalid_unreferenced_count: number;
  repaired_incident_area_mm2_min_max: [number, number] | null; source_defect_flags: string[]; scope: string;
}
/** viscera_core.atlas_surface_normals.repair_display_normals: a referenced vertex whose normal is not finite or shorter
 *  than 1e-12 takes the area-weighted sum of its incident face normals (the largest face alone when the sum cancels);
 *  nothing else moves. */
function repairNormals(positions: ArrayLike<number>, faces: ArrayLike<number>, normals: Float64Array): { repaired: Float64Array; repairIds: number[]; weighted: number; largest: number; unreferenced: number; areas: number[] } {
  const count = positions.length / 3, repaired = Float64Array.from(normals), referenced = new Uint8Array(count), invalid: number[] = [];
  for (let i = 0; i < faces.length; i++) referenced[faces[i]!] = 1;
  for (let i = 0; i < count; i++) {
    const x = normals[i * 3]!, y = normals[i * 3 + 1]!, z = normals[i * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || norm3(x, y, z) < 1e-12) invalid.push(i);
  }
  const repairIds = invalid.filter((i) => referenced[i]);
  let weighted = 0, largest = 0;
  const areas: number[] = [];
  if (repairIds.length) {
    const { cross, area2 } = faceCross(positions, faces);
    for (const vertex of repairIds) {
      const incident: number[] = [];
      for (let f = 0; f < area2.length; f++) if ((faces[f * 3] === vertex || faces[f * 3 + 1] === vertex || faces[f * 3 + 2] === vertex) && Number.isFinite(area2[f]!) && area2[f]! > 0) incident.push(f);
      if (!incident.length) throw new Error(`Cannot repair normal at referenced vertex ${vertex}: no positive-area incident geometry`);
      let sx = 0, sy = 0, sz = 0, total = 0;
      for (const f of incident) { sx += cross[f * 3]!; sy += cross[f * 3 + 1]!; sz += cross[f * 3 + 2]!; total += area2[f]!; areas.push(area2[f]! * 0.5); }
      const length = norm3(sx, sy, sz);
      if (length > total * 1e-10) { repaired[vertex * 3] = sx / length; repaired[vertex * 3 + 1] = sy / length; repaired[vertex * 3 + 2] = sz / length; weighted++; }
      else {
        // np.argmax: the first face among equal areas; a shading fallback for exact cancellation
        const f = incident.reduce((best, g) => (area2[g]! > area2[best]! ? g : best));
        for (let k = 0; k < 3; k++) repaired[vertex * 3 + k] = cross[f * 3 + k]! / area2[f]!;
        largest++;
      }
    }
  }
  return { repaired, repairIds, weighted, largest, unreferenced: invalid.length - repairIds.length, areas };
}
export async function repairDisplayNormals(positions: Float64Array, faces: ArrayLike<number>, normals: Float64Array): Promise<{ normals: Float64Array; metadata: NormalRepair }> {
  const { repaired, repairIds, weighted, largest, unreferenced, areas } = repairNormals(positions, faces, normals);
  const flags: string[] = [];
  if (repairIds.length) flags.push("invalid_referenced_display_normals");
  if (largest) flags.push("incident_geometric_normal_cancellation");
  if (unreferenced) flags.push("invalid_unreferenced_normals_preserved");
  const [sourceHash, hash] = await Promise.all([float32Hash(normals), float32Hash(repaired)]);
  return { normals: repaired, metadata: {
    policy: NORMAL_REPAIR_VERSION, source_sha256: sourceHash, sha256: hash, geometry_modified: false, valid_input_normals_preserved: true,
    repaired_vertex_count: repairIds.length, repaired_vertex_indices: repairIds, area_weighted_incident_count: weighted, largest_incident_face_fallback_count: largest,
    invalid_unreferenced_count: unreferenced, repaired_incident_area_mm2_min_max: areas.length ? [Math.min(...areas), Math.max(...areas)] : null,
    source_defect_flags: flags, scope: "surface shading frame only; no anatomical or topology repair",
  } };
}

// ---------------------------------------------------------------------------------------------- the template
/** What atlas_disease_v2._source_cache holds for a template, derived once from the bundled reference and support. */
export interface DiseaseTemplate {
  templateId: string; organ: string; rest: Float64Array; faces: Int32Array; limits: number[]; normalization: number; support: DiseaseSupport;
  /** repaired trimesh source normals: the anchor directions and the covectors the map transports */
  normals: Float64Array;
  restCross: Float64Array; restArea2: Float64Array; faceCenters: Float64Array; faceNormals: Float64Array;
  /** the template's topology audit, which the QA reports (from the reference's qa.source_topology) */
  sourceTopology: unknown;
}
export function diseaseTemplate(templateId: string, rest: ArrayLike<number>, faces: ArrayLike<number>, organ: string, limits: number[], normalization: number, support: DiseaseSupport, sourceTopology: unknown = {}): DiseaseTemplate {
  if (rest.length !== support.entry.vertex_count * 3 || faces.length !== support.entry.face_count * 3) throw new Error("The bundled disease support does not match this reference's geometry.");
  if (!(normalization > 0) || limits.length !== 7) throw new Error("The bundled library lacks this reference's control limits or normalisation.");
  const restArray = Float64Array.from(rest), faceArray = Int32Array.from(faces);
  const { cross, area2 } = faceCross(restArray, faceArray);
  const faceCenters = new Float64Array(area2.length * 3), faceNormals = new Float64Array(area2.length * 3);
  for (let f = 0; f < area2.length; f++) {
    const a = faceArray[f * 3]! * 3, b = faceArray[f * 3 + 1]! * 3, c = faceArray[f * 3 + 2]! * 3, denominator = Math.max(area2[f]!, 1e-300);
    for (let k = 0; k < 3; k++) { faceCenters[f * 3 + k] = (restArray[a + k]! + restArray[b + k]! + restArray[c + k]!) / 3; faceNormals[f * 3 + k] = cross[f * 3 + k]! / denominator; }
  }
  // the API repairs the source normals before using them (_source_cache); that repair's metadata is not reported
  const normals = repairNormals(restArray, faceArray, displayNormals(restArray, faceArray, organ)).repaired;
  return { templateId, organ, rest: restArray, faces: faceArray, limits, normalization, support, normals, restCross: cross, restArea2: area2, faceCenters, faceNormals, sourceTopology };
}

// ---------------------------------------------------------------------------------------------- the field
export interface DiseaseSite { center_mm: Vec3; radius_mm: number; direction: Vec3; amplitude_mm: number; anchor_vertex_id: number }
export interface DiseasePrecisionCheck { new_degenerate_faces: number; opposed_transported_face_normals: number; minimum_transported_face_alignment: number; maximum_vertex_roundtrip_error_mm: number; finite: boolean }
export interface DiseaseMeshQa {
  passed: boolean; status: "PASS" | "FAIL"; topology_preserved: true; scope: string; precision_checks: { studio_float32_mm: DiseasePrecisionCheck; gltf_float32_m: DiseasePrecisionCheck };
  source_face_count: number; tested_source_face_count: number; ignored_degenerate_source_faces: number; minimum_all_precision_alignment: number; new_degenerate_faces: number;
  opposed_transported_face_normals: number; minimum_transported_face_alignment: number; area_ratio_min: number; area_ratio_max: number; normal_turns_over_90_degrees: number;
  min_normal_dot: number; normal_turn_interpretation: string; continuous_jacobian_lower_bound: number; source_topology: unknown; self_intersection: { status: string };
  anatomical_plausibility: { status: string }; mechanical_validation: { status: string }; surface_area_mm2: number;
}
export interface DiseaseDiscreteGuard {
  policy: string; face_count: number; local_amplitude_fraction: number; global_envelope_fraction: number; strength_capacity: number; strength_mapping: string;
  actual_strength_backoffs: number; intermediate_rejected_strengths: number[]; source_limited: boolean; requested_max_step_amplitude_mm: number;
  effective_max_step_amplitude_mm: number; minimum_transported_face_alignment: number; opposed_transported_face_normals: 0;
}
/** organ.metadata.disease_field as the API writes it (atlas_disease_v2.disease_field after _limit_discrete_field). */
export interface DiseaseFieldV2 {
  version: typeof DISEASE_FIELD_VERSION; renderer_version: "disease-v2"; profile_id: string; requested_morphology_strength: number; pattern: string; mechanism: string;
  fields: DiseaseSite[]; steps: number; global_center_mm: Vec3; global_log_scale: Vec3; global_scale: Vec3; target_srgb: Vec3; color_strength: number; requested_sites: number;
  requested_support_radius_mm: number; effective_support_radius_mm: number; minimum_support_policy: string; realized_sites: number; gradient_bound_per_step: number;
  continuous_jacobian_lower_bound: number; surface_site_frame: string; clinical_stage: null; visibility: string; applied_displacement_fraction: number; normal_policy: string;
  site_policy: string; full_mesh_qa?: DiseaseMeshQa; effective_morphology_strength?: number; discrete_guard?: DiseaseDiscreteGuard;
}
/** The points of a set that each site's support covers in the rest frame (cKDTree.query_ball_point: distance ≤ radius).
 *  Sites never change their centre or radius, so one scan serves every strength the guard tries. */
export function siteSupports(points: Float64Array, field: DiseaseFieldV2): Int32Array[] {
  return field.fields.map((site) => {
    const [cx, cy, cz] = site.center_mm, r2 = site.radius_mm * site.radius_mm, ids: number[] = [];
    for (let i = 0; i < points.length; i += 3) { const dx = points[i]! - cx, dy = points[i + 1]! - cy, dz = points[i + 2]! - cz; if (dx * dx + dy * dy + dz * dz <= r2) ids.push(i / 3); }
    return Int32Array.from(ids);
  });
}

/** atlas_disease_v2.transform_points: the compact displacement map (steps of w³·a per site, w = max(1 - |δ|²/r², 0)),
 *  then the global axis scaling about the field's centre, then deform_vertices; with normals, the covectors go through
 *  the exact inverse transpose of every step (Sherman–Morrison, the denominator positive under the derivative bound),
 *  the scaling and the analytic chain of the shape map, and are normalised. Without a field the shape map alone. */
export function transportPoints(template: DiseaseTemplate, controls: Controls, points: Float64Array, field: DiseaseFieldV2 | null, normals: Float64Array | null, supports?: Int32Array[]): { positions: Float64Array; normals: Float64Array | null } {
  const q = Float64Array.from(points), n = normals ? Float64Array.from(normals) : null;
  if (field) {
    const ids = supports ?? siteSupports(points, field);
    field.fields.forEach((site, s) => {
      if (site.amplitude_mm === 0) return;
      const [cx, cy, cz] = site.center_mm, r2 = site.radius_mm * site.radius_mm;
      const ax = site.direction[0] * site.amplitude_mm, ay = site.direction[1] * site.amplitude_mm, az = site.direction[2] * site.amplitude_mm;
      for (const index of ids[s]!) {
        const i = index * 3;
        let px = q[i]!, py = q[i + 1]!, pz = q[i + 2]!, nx = n ? n[i]! : 0, ny = n ? n[i + 1]! : 0, nz = n ? n[i + 2]! : 0;
        for (let step = 0; step < field.steps; step++) {
          const dx = px - cx, dy = py - cy, dz = pz - cz;
          const w = Math.max(1 - (dx * dx + dy * dy + dz * dz) / r2, 0);
          if (n) {
            const g = -6 * (w * w), gx = g * dx / r2, gy = g * dy / r2, gz = g * dz / r2;
            const factor = (nx * ax + ny * ay + nz * az) / (1 + (gx * ax + gy * ay + gz * az));
            nx -= gx * factor; ny -= gy * factor; nz -= gz * factor;
          }
          const w3 = w * w * w;
          px += w3 * ax; py += w3 * ay; pz += w3 * az;
        }
        q[i] = px; q[i + 1] = py; q[i + 2] = pz;
        if (n) { n[i] = nx; n[i + 1] = ny; n[i + 2] = nz; }
      }
    });
    const scale = field.global_scale, center = field.global_center_mm;
    if (scale.some((v) => v !== 1)) for (let i = 0; i < q.length; i += 3) for (let k = 0; k < 3; k++) {
      q[i + k] = center[k]! + (q[i + k]! - center[k]!) * scale[k]!;
      if (n) n[i + k] = n[i + k]! / scale[k]!;
    }
  }
  const positions = deformVertices(q, controls, template.limits, template.normalization);
  if (!n) return { positions, normals: null };
  const c = scaledControls(controls, template.limits), s0 = Math.exp(c[0]!), s1 = Math.exp(c[1]!), s2 = Math.exp(c[2]!);
  for (let i = 0; i < q.length; i += 3) {
    let qx = q[i]! / template.normalization * s0, qy = q[i + 1]! / template.normalization * s1;
    const qz = q[i + 2]! / template.normalization * s2;
    let nx = n[i]! / s0, ny = n[i + 1]! / s1, nz = n[i + 2]! / s2;
    const tz = Math.tanh(qz), taper = Math.exp(c[5]! * tz), k = c[5]! * (1 - tz * tz);
    nz -= k * (qx * nx + qy * ny);
    nx /= taper; ny /= taper; qx *= taper; qy *= taper;
    const cs = Math.cos(c[4]! * tz), sn = Math.sin(c[4]! * tz), da = c[4]! * (1 - tz * tz);
    const x = cs * qx - sn * qy, y = sn * qx + cs * qy, rx = cs * nx - sn * ny, ry = sn * nx + cs * ny;
    nz += da * (y * rx - x * ry);
    nx = rx; ny = ry; qx = x;
    nz -= 2 * c[3]! * tz * (1 - tz * tz) * nx;
    qx += c[3]! * tz * tz;
    const th = Math.tanh(qx);
    nx -= c[6]! * (1 - th * th) * nz;
    const length = Math.max(norm3(nx, ny, nz), 1e-300);
    n[i] = nx / length; n[i + 1] = ny / length; n[i + 2] = nz / length;
  }
  return { positions, normals: n };
}

/** atlas_disease_v2.mesh_qa: every source face of the deformed surface compared with its exactly transported normal,
 *  in float64 millimetres and after rounding to float32 millimetres (the studio) and float32 metres (glTF). */
export function meshQa(template: DiseaseTemplate, vertices: Float64Array, field: DiseaseFieldV2 | null, controls: Controls, faceSupports?: Int32Array[]): DiseaseMeshQa {
  const { faces, restArea2, restCross } = template, count = restArea2.length;
  const { cross, area2: areas } = faceCross(vertices, faces);
  let tested = 0, bad = 0, turns = 0, minDot = Infinity, ratioMin = Infinity, ratioMax = -Infinity, area = 0, areasFinite = true, verticesFinite = true;
  for (let i = 0; i < vertices.length; i++) if (!Number.isFinite(vertices[i]!)) { verticesFinite = false; break; }
  for (let f = 0; f < count; f++) {
    area += areas[f]!;
    if (!Number.isFinite(areas[f]!)) areasFinite = false;
    if (!(restArea2[f]! > 2e-12)) continue;
    tested++;
    if (areas[f]! <= 2e-12) bad++;
    const ratio = areas[f]! / restArea2[f]!;
    if (ratio < ratioMin) ratioMin = ratio; if (ratio > ratioMax) ratioMax = ratio;
    const dot = (cross[f * 3]! * restCross[f * 3]! + cross[f * 3 + 1]! * restCross[f * 3 + 1]! + cross[f * 3 + 2]! * restCross[f * 3 + 2]!) / Math.max(areas[f]! * restArea2[f]!, 1e-300);
    if (dot <= 0) turns++; if (dot < minDot) minDot = dot;
  }
  const c = scaledControls(controls, template.limits);
  const lower = Math.exp(c[0]! + c[1]! + c[2]! - 2 * Math.abs(c[5]!)) * (field ? field.continuous_jacobian_lower_bound : 1.0);
  const transported = transportPoints(template, controls, template.faceCenters, field, template.faceNormals, faceSupports).normals!;
  const alignmentOf = (faceCross: Float64Array, faceArea: Float64Array, f: number) => (faceCross[f * 3]! * transported[f * 3]! + faceCross[f * 3 + 1]! * transported[f * 3 + 1]! + faceCross[f * 3 + 2]! * transported[f * 3 + 2]!) / Math.max(faceArea[f]!, 1e-300);
  let opposed = 0, minAlignment = Infinity, alignmentFinite = true;
  for (let f = 0; f < count; f++) {
    if (!(restArea2[f]! > 2e-12)) continue;
    const alignment = alignmentOf(cross, areas, f);
    if (!Number.isFinite(alignment)) alignmentFinite = false;
    if (alignment <= 0.001) opposed++; if (alignment < minAlignment) minAlignment = alignment;
  }
  const precision = (quantize: (v: number) => number): DiseasePrecisionCheck => {
    const quantized = Float64Array.from(vertices, quantize);
    const q = faceCross(quantized, faces);
    let degenerate = 0, opposedQ = 0, minimum = Infinity, finite = true, roundtrip = 0;
    for (let f = 0; f < count; f++) {
      if (!Number.isFinite(q.area2[f]!)) finite = false;
      if (!(restArea2[f]! > 2e-12)) continue;
      if (q.area2[f]! <= 2e-12) degenerate++;
      const agreement = alignmentOf(q.cross, q.area2, f);
      if (!Number.isFinite(agreement)) finite = false;
      if (agreement <= 0.001) opposedQ++; if (agreement < minimum) minimum = agreement;
    }
    for (let i = 0; i < vertices.length; i += 3) { const error = norm3(quantized[i]! - vertices[i]!, quantized[i + 1]! - vertices[i + 1]!, quantized[i + 2]! - vertices[i + 2]!); if (error > roundtrip) roundtrip = error; }
    return { new_degenerate_faces: degenerate, opposed_transported_face_normals: opposedQ, minimum_transported_face_alignment: minimum, maximum_vertex_roundtrip_error_mm: roundtrip, finite };
  };
  const checks = { studio_float32_mm: precision(Math.fround), gltf_float32_m: precision((v) => Math.fround(v / 1000) * 1000) };
  const precisionPassed = Object.values(checks).every((check) => check.finite && check.new_degenerate_faces === 0 && check.opposed_transported_face_normals === 0);
  const passed = verticesFinite && areasFinite && alignmentFinite && !bad && !opposed && lower > 0 && precisionPassed && tested === count;
  return {
    passed, status: passed ? "PASS" : "FAIL", topology_preserved: true,
    scope: "all source faces in float64-mm, float32-mm Studio and float32-metre glTF coordinates finite/nondegenerate and positively aligned with exact transported face normals; continuous positive Jacobian bound",
    precision_checks: checks, source_face_count: count, tested_source_face_count: tested, ignored_degenerate_source_faces: count - tested,
    minimum_all_precision_alignment: Math.min(minAlignment, checks.studio_float32_mm.minimum_transported_face_alignment, checks.gltf_float32_m.minimum_transported_face_alignment),
    new_degenerate_faces: bad, opposed_transported_face_normals: opposed, minimum_transported_face_alignment: minAlignment, area_ratio_min: ratioMin, area_ratio_max: ratioMax,
    normal_turns_over_90_degrees: turns, min_normal_dot: minDot, normal_turn_interpretation: "relative rotation diagnostic, not proof of a discrete inverted element",
    continuous_jacobian_lower_bound: lower, source_topology: template.sourceTopology, self_intersection: { status: "NOT_RUN" }, anatomical_plausibility: { status: "NOT_RUN" },
    mechanical_validation: { status: "NOT_RUN" }, surface_area_mm2: area / 2,
  };
}

/** atlas_disease_v2.source_safe_shape_controls: the requested controls halved until the whole tessellated source passes
 *  the all-precision QA with margin. */
export function sourceSafeShapeControls(template: DiseaseTemplate, controls: Controls): { applied: Controls; fraction: number } {
  for (let attempt = 0; attempt < 16; attempt++) {
    const fraction = 2 ** -attempt;
    const projected = Object.fromEntries(Object.entries(controls).map(([key, value]) => [key, value * fraction]));
    const qa = meshQa(template, deformVertices(template.rest, projected, template.limits, template.normalization), null, projected);
    if (qa.passed && qa.minimum_all_precision_alignment > 0.1 && qa.area_ratio_min > 0.02 && qa.area_ratio_max < 20) return { applied: projected, fraction };
  }
  throw new Error("Source template cannot satisfy full discrete baseline QA");
}

interface FieldBuild { field: DiseaseFieldV2; vertexSupports: Int32Array[]; faceSupports: Int32Array[] }
/** atlas_disease_v2.disease_field: site placement from the recipe's generator, the certified continuous bound and the
 *  discrete limits. */
function buildField(template: DiseaseTemplate, recipe: AtlasDiseaseSpec, profile: DiseaseProfileV2, controls: Controls): FieldBuild {
  if (profile.organ !== template.organ) throw new Error("Disease profile must match selected organ");
  const { rest: v, normals, support } = template, eligible = support.eligible;
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const e of eligible) for (let k = 0; k < 3; k++) { const value = v[e * 3 + k]!; if (value < lo[k]!) lo[k] = value; if (value > hi[k]!) hi[k] = value; }
  const center = lo.map((value, k) => (value + hi[k]!) / 2) as Vec3, extent = hi.map((value, k) => value - lo[k]!) as Vec3;
  const diagonal = Math.max(norm3(extent[0], extent[1], extent[2]), 1.0);
  const target = center.map((value, k) => value + recipe.location[k]! * extent[k]! * 0.5) as Vec3;
  // the nearest anchorable vertex (cKDTree.query); the first one on an exact tie
  let first = -1, nearest = Infinity;
  for (const e of eligible) { const d = (v[e * 3]! - target[0]) ** 2 + (v[e * 3 + 1]! - target[1]) ** 2 + (v[e * 3 + 2]! - target[2]) ** 2; if (d < nearest) { nearest = d; first = e; } }
  const rng = new Pcg64(recipe.seed);
  const requestedRadius = diagonal * (profile.radius_min_fraction + profile.radius_range_fraction * recipe.size);
  const radius = Math.max(requestedRadius, support.entry.minimum_support_radius_mm);
  const count = Math.min(profile.maximum_sites, recipe.count * profile.count_multiplier);
  const anchors = [first];
  const reach = diagonal * (0.18 + 0.82 * recipe.spread), separation = 2 * radius * 1.001;
  const distance = (a: number, b: number) => norm3(v[a * 3]! - v[b * 3]!, v[a * 3 + 1]! - v[b * 3 + 1]!, v[a * 3 + 2]! - v[b * 3 + 2]!);
  for (const index of rng.permutation(Array.from(support.pool))) {
    if (!(distance(index, first) <= reach)) continue;
    if (anchors.length >= count) break;
    if (Math.min(...anchors.map((a) => distance(a, index))) > separation) anchors.push(index);
  }
  const sign = Math.sign(profile.amplitude_ratio);
  const fields = anchors.map((index): DiseaseSite => {
    let nx = normals[index * 3]!, ny = normals[index * 3 + 1]!, nz = normals[index * 3 + 2]!;
    let length = norm3(nx, ny, nz);
    nx /= length; ny /= length; nz /= length;
    const ox = v[index * 3]! - center[0], oy = v[index * 3 + 1]! - center[1], oz = v[index * 3 + 2]! - center[2], outward = Math.max(norm3(ox, oy, oz), 1e-30);
    nx += 0.35 * (ox / outward); ny += 0.35 * (oy / outward); nz += 0.35 * (oz / outward);
    length = norm3(nx, ny, nz);
    nx /= length; ny /= length; nz /= length;
    // irregularity varies the amplitude and the site selection, never uncertified high-frequency geometry
    const ratio = Math.min(Math.abs(profile.amplitude_ratio), 0.70 / profile.steps) * recipe.severity * (1 - 0.35 * recipe.irregularity * rng.nextDouble());
    return { center_mm: [v[index * 3]!, v[index * 3 + 1]!, v[index * 3 + 2]!], radius_mm: radius, direction: [nx * sign, ny * sign, nz * sign], amplitude_mm: radius * ratio, anchor_vertex_id: index };
  });
  const bound = fields.reduce((worst, site) => Math.max(worst, site.amplitude_mm / site.radius_mm * KERNEL_GRADIENT_MAX), 0);
  if (!(bound >= 0 && bound < 0.5)) throw new Error("Disease-v2 continuous derivative bound exceeded");
  const globalLog = profile.global_log_scale.map((value) => value * recipe.severity) as Vec3;
  const field: DiseaseFieldV2 = {
    version: DISEASE_FIELD_VERSION, renderer_version: "disease-v2", profile_id: recipe.profile_id, requested_morphology_strength: recipe.severity, pattern: profile.pattern,
    mechanism: profile.mechanism, fields, steps: profile.steps, global_center_mm: center, global_log_scale: globalLog, global_scale: globalLog.map(Math.exp) as Vec3,
    target_srgb: profile.target_srgb, color_strength: recipe.severity * recipe.contrast, requested_sites: count, requested_support_radius_mm: requestedRadius,
    effective_support_radius_mm: radius, minimum_support_policy: "radius >=3 times source90th-percentile edge length; no invented tessellation", realized_sites: fields.length,
    gradient_bound_per_step: bound, continuous_jacobian_lower_bound: Math.exp(globalLog[0] + globalLog[1] + globalLog[2]) * (1 - bound) ** profile.steps,
    surface_site_frame: "undeformed-atlas-Y-up-mm", clinical_stage: null, visibility: profile.visibility, applied_displacement_fraction: 1.0, normal_policy: NORMAL_POLICY,
    site_policy: "outward-facing support; kidney capsule preferred; source normals untouched",
  };
  const build = { field, vertexSupports: siteSupports(template.rest, field), faceSupports: siteSupports(template.faceCenters, field) };
  limitDiscreteField(template, controls, build);
  return build;
}
/** The field of a recipe on a template, limited to what the tessellated source carries. */
export function diseaseField(template: DiseaseTemplate, recipe: AtlasDiseaseSpec, profile: DiseaseProfileV2, controls: Controls): DiseaseFieldV2 {
  return buildField(template, recipe, profile, controls).field;
}

/** atlas_disease_v2._limit_discrete_field: the source's strength capacity, found at unit strength and kept with a
 *  margin, then explicit back-offs until the requested strength passes the precision QA. The field's amplitudes,
 *  scaling and bounds are rescaled in place; the recorded effective strength is authoritative. */
function limitDiscreteField(template: DiseaseTemplate, controls: Controls, { field, vertexSupports, faceSupports }: FieldBuild): void {
  const requested = field.requested_morphology_strength, initial = field.fields.map((site) => site.amplitude_mm);
  const check = () => meshQa(template, transportPoints(template, controls, template.rest, field, null, vertexSupports).positions, field, controls, faceSupports);
  if (requested === 0) {
    const qa = check();
    if (!qa.passed) throw new Error("Source/shape combination fails full discrete face orientation QA");
    field.full_mesh_qa = qa; field.effective_morphology_strength = 0.0;
    return;
  }
  const unitAmplitudes = initial.map((amplitude) => amplitude / requested), unitLog = field.global_log_scale.map((value) => value / requested) as Vec3, unitGradient = field.gradient_bound_per_step / requested;
  const apply = (level: number) => {
    field.fields.forEach((site, i) => { site.amplitude_mm = unitAmplitudes[i]! * level; });
    field.global_log_scale = unitLog.map((value) => value * level) as Vec3;
    field.global_scale = unitLog.map((value) => Math.exp(value * level)) as Vec3;
    field.gradient_bound_per_step = unitGradient * level;
    field.continuous_jacobian_lower_bound = Math.exp((unitLog[0] + unitLog[1] + unitLog[2]) * level) * (1 - unitGradient * level) ** field.steps;
  };
  let capacity = 1.0, qa: DiseaseMeshQa | null = null;
  for (let attempt = 0; attempt < 16 && !qa; attempt++) {
    apply(capacity);
    const candidate = check();
    if (candidate.passed && candidate.minimum_all_precision_alignment > 0.025 && candidate.area_ratio_min > 0.01 && candidate.area_ratio_max < 25) qa = candidate;
    else capacity *= 0.5;
  }
  if (!qa) throw new Error("No nonzero disease field passes full-source transported-face QA");
  // a margin after a source-driven reduction; the cap depends on profile, layout and base controls, not on severity
  if (capacity < 1) capacity *= 0.9;
  let effective = requested * capacity, backoffs = 0;
  const rejected: number[] = [];
  qa = null;
  while (!qa && backoffs < 16) {
    apply(effective);
    const candidate = check();
    if (candidate.passed) qa = candidate;
    else { rejected.push(effective); effective *= 0.5; backoffs++; }
  }
  if (!qa) throw new Error("No requested-strength fallback passes full discrete precision QA");
  field.full_mesh_qa = qa;
  field.effective_morphology_strength = effective;
  field.applied_displacement_fraction = effective / requested;
  field.discrete_guard = {
    policy: "all original faces compared with exact inverse-transpose normal at original triangle centroid; every final recipe checked",
    face_count: template.restArea2.length, local_amplitude_fraction: effective / requested, global_envelope_fraction: effective / requested, strength_capacity: capacity,
    strength_mapping: "requested_strength_times_source_capacity_then_explicit_precision_backoff", actual_strength_backoffs: backoffs, intermediate_rejected_strengths: rejected,
    source_limited: effective < requested, requested_max_step_amplitude_mm: initial.length ? Math.max(...initial) : 0.0, effective_max_step_amplitude_mm: Math.max(...unitAmplitudes) * effective,
    minimum_transported_face_alignment: qa.minimum_transported_face_alignment, opposed_transported_face_normals: 0,
  };
}

// ---------------------------------------------------------------------------------------------- colours
const srgbToLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (x: number) => (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.max(x, 0) ** (1 / 2.4) - 0.055);
/** atlas_disease.apply_disease_color: each vertex's sRGB colour mixed in linear light towards the profile's target by
 *  the rest-frame site mask (max over sites of max(1 - d²/r², 0)³) times the colour strength; unchanged when no vertex
 *  is covered. The GPU material repeats this mask per fragment; these colours matter without a material and in exports. */
export function applyDiseaseColor(colors: ArrayLike<number>, rest: Float64Array, field: DiseaseFieldV2): number[] {
  const count = rest.length / 3, amount = new Float64Array(count);
  let any = false;
  for (let i = 0; i < count; i++) {
    let mask = 0;
    for (const site of field.fields) {
      const dx = rest[i * 3]! - site.center_mm[0], dy = rest[i * 3 + 1]! - site.center_mm[1], dz = rest[i * 3 + 2]! - site.center_mm[2];
      const support = Math.max(1 - (dx * dx + dy * dy + dz * dz) / (site.radius_mm * site.radius_mm), 0);
      mask = Math.max(mask, support * support * support);
    }
    amount[i] = mask * field.color_strength;
    if (amount[i] !== 0) any = true;
  }
  if (!any) return Array.from(colors);
  const target = field.target_srgb.map(srgbToLinear) as Vec3, out = new Array<number>(colors.length);
  for (let i = 0; i < colors.length; i++) {
    const mixed = srgbToLinear(colors[i]!) * (1 - amount[(i - i % 3) / 3]!) + target[i % 3]! * amount[(i - i % 3) / 3]!;
    out[i] = Math.min(1, Math.max(0, linearToSrgb(mixed)));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- realize
export interface DiseaseRealization {
  applied: Controls; fraction: number; field: DiseaseFieldV2 | null; positions: Float64Array; normals: Float64Array; normalRepair: NormalRepair; qa: DiseaseMeshQa;
}
/** The geometry of atlas_disease_scene_v2.realize for a template: the shape projection, the field, the transported
 *  surface with its QA and its repaired shading normals. */
export async function realizeDiseaseGeometry(template: DiseaseTemplate, controls: Controls, recipe: AtlasDiseaseSpec | null, profile: DiseaseProfileV2 | null): Promise<DiseaseRealization> {
  const { applied, fraction } = sourceSafeShapeControls(template, { ...controls });
  const build = recipe && profile ? buildField(template, recipe, profile, applied) : null;
  const { positions, normals } = transportPoints(template, applied, template.rest, build?.field ?? null, template.normals, build?.vertexSupports);
  const qa = meshQa(template, positions, build?.field ?? null, applied, build?.faceSupports);
  if (!qa.passed) throw new Error("Disease-v2 surface fails finite, nondegenerate or transported-face orientation QA");
  const repair = await repairDisplayNormals(positions, template.faces, normals!);
  return { applied, fraction, field: build?.field ?? null, positions, normals: repair.normals, normalRepair: repair.metadata, qa };
}

const templates = new Map<string, Promise<DiseaseTemplate>>();
/** The template behind a bundled reference, with its support; derived once per template. */
export function diseaseTemplateOf(reference: AtlasGeneration, template: AtlasTemplate, signal?: AbortSignal): Promise<DiseaseTemplate> {
  const id = reference.spec.template_id;
  let p = templates.get(id);
  if (!p) {
    p = loadDiseaseSupport(id, signal).then((support) => {
      if (support.entry.template_sha256 !== reference.spec.template_sha256) throw new Error("The bundled disease support belongs to another release of this reference.");
      const organ = reference.scene.organs[0] as (OrganMesh & { rest_positions?: number[] }) | undefined;
      if (!organ) throw new Error("The reference has no organ.");
      const limits = template.control_limits, normalization = template.normalization_mm;
      if (!Array.isArray(limits) || typeof normalization !== "number") throw new Error("The bundled library lacks this reference's control limits or normalisation.");
      const sourceTopology = ((reference.scene.metadata as { qa?: { source_topology?: unknown } }).qa?.source_topology) ?? {};
      return diseaseTemplate(id, organ.rest_positions ?? organ.positions, organ.indices, support.entry.organ, limits as number[], normalization, support, sourceTopology);
    });
    templates.set(id, p);
    p.catch(() => templates.delete(id));
  }
  return p;
}

/** POST /api/atlas/generate in the browser, for every spec the studio builds: one with a disease recipe goes through
 *  the disease-v2 renderer below, a healthy one through realizeLocally (whose shape, appearance and surface already
 *  match the API to 1e-6 mm). The samplers realize their proposals through this one dispatch, so a sampled disease
 *  lands in the same renderer as an authored one. */
export function realizeSpecLocally(reference: AtlasGeneration, spec: AtlasSpec, template: AtlasTemplate, library: AtlasDiseaseLibrary | undefined, signal?: AbortSignal): Promise<AtlasGeneration> {
  return spec.disease ? realizeDiseaseLocally(reference, spec, template, library, signal) : realizeLocally(reference, spec, template, signal);
}

/** What the API answers for a disease-v2 `spec` (POST /api/atlas/generate), from the bundled reference of its template:
 *  the healthy surface realized by realizeLocally at the source-safe controls, then the disease morphology, its colours,
 *  QA and provenance with the API's field names. `library` is the catalogue's disease library (the profiles). */
export async function realizeDiseaseLocally(reference: AtlasGeneration, spec: AtlasSpec, template: AtlasTemplate, library: AtlasDiseaseLibrary | undefined, signal?: AbortSignal): Promise<AtlasGeneration> {
  if (spec.template_id !== reference.spec.template_id) throw new Error("The bundled reference belongs to another template.");
  const recipe = spec.disease ? { ...spec.disease, location: [...spec.disease.location] as Vec3 } : null;
  const profile = recipe ? diseaseProfileV2(library, recipe.profile_id) : null;
  const geometry = await diseaseTemplateOf(reference, template, signal);
  const requested = { ...spec.controls };
  const realization = await realizeDiseaseGeometry(geometry, requested, recipe, profile);
  const { applied, fraction, field, positions, qa, normalRepair } = realization;
  // the base surface: atlas.generate's checks at the applied controls (an API 422 when they fail), the appearance, the
  // material and the measurements, as realizeLocally produces them
  const healthy: AtlasSpec = { ...spec, controls: applied };
  delete healthy.disease;
  const base = await realizeLocally(reference, healthy, template, signal);
  const baseMeta = base.scene.metadata as Record<string, unknown>;
  if ((baseMeta.disease as { shape_control_projection: { applied_fraction: number } }).shape_control_projection.applied_fraction !== 1) throw new Error("Requested design failed the scoped geometry checks");
  const organ = base.scene.organs[0]!, faces = geometry.faces, count = positions.length / 3;
  let dmax = 0, dsum = 0;
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    let d2 = 0;
    for (let k = 0; k < 3; k++) { const value = positions[i + k]!, d = value - organ.positions[i + k]!; d2 += d * d; if (value < lo[k]!) lo[k] = value; if (value > hi[k]!) hi[k] = value; }
    dsum += d2; if (d2 > dmax) dmax = d2;
  }
  const extent = hi.map((value, k) => value - lo[k]!) as Vec3;
  const colors = spec.appearance === "tissue" && field ? applyDiseaseColor(organ.colors ?? [], geometry.rest, field) : organ.colors;
  const measurements = { ...(base.summary.measurements as Record<string, unknown>), extent_x_mm: extent[0], extent_y_mm: extent[1], extent_z_mm: extent[2], surface_area_mm2: qa.surface_area_mm2, volume_ml: null, compactness: null, method: "disease-display-triangle-measurements-2.0.0" };
  const refDisease = (((reference.scene.metadata as Record<string, unknown>).disease ?? {}) as Record<string, unknown>);
  const disease = {
    version: DISEASE_FIELD_VERSION, renderer_version: "disease-v2", recipe, profile, evidence: "synthetic_surface_morphology_not_patient_or_population_geometry",
    max_displacement_mm: Math.sqrt(dmax), rms_displacement_mm: Math.sqrt(dsum / (3 * count) * 3), requested_sites: field?.requested_sites ?? 0, realized_sites: field?.realized_sites ?? 0,
    applied_displacement_fraction: field?.applied_displacement_fraction ?? 1.0, effective_morphology_strength: field?.effective_morphology_strength ?? 0.0,
    requested_morphology_strength: recipe?.severity ?? 0.0, displacement_limited_by_source_mesh: (field?.applied_displacement_fraction ?? 1.0) < 1,
    source_precision_repair: refDisease.source_precision_repair ?? null,
    shape_control_projection: { policy: "shared deterministic all-precision source-face certification", requested_controls: requested, applied_controls: applied, applied_fraction: fraction },
    actual_strength_backoffs: field?.discrete_guard?.actual_strength_backoffs ?? 0, internal_anatomy_generated: false, physical_parameters_inferred: false,
    severity_semantics: "authored strength, not clinical stage",
  };
  const geometrySha = await geometryHash(positions, faces);
  const realized = await sha256Hex(new TextEncoder().encode(canonicalJson({ realizer: LOCAL_REALIZER_VERSION, surface_realized_id: base.spec.realized_id, disease: recipe, field, geometry: geometrySha, version: DISEASE_FIELD_VERSION })));
  const boundSpec: AtlasSpec = { ...base.spec, realized_id: realized };
  if (recipe) boundSpec.disease = recipe; else delete boundSpec.disease;
  const organMeta = { ...(organ.metadata ?? {}) } as Record<string, unknown>;
  if (field) organMeta.disease_field = field;
  // the material's frame binding names the actual display normals
  const materialV2 = organMeta.material_v2 ? { ...(organMeta.material_v2 as Record<string, unknown>), display_normal_sha256: normalRepair.sha256 } : null;
  if (materialV2) organMeta.material_v2 = materialV2;
  const item = { ...organ, positions: Array.from(positions), normals: Array.from(realization.normals), colors, metadata: organMeta };
  const sceneMeta: Record<string, unknown> = { ...baseMeta, disease, geometry_sha256: geometrySha, realized_id: realized, qa, measurements, display_normals: { policy: NORMAL_POLICY, sha256: normalRepair.sha256 }, normal_repair: normalRepair,
    realized_by: { version: LOCAL_REALIZER_VERSION, scope: "public copy: shape controls, appearance, surface recipe and the disease-v2 morphology realized in the browser from the API's reference rendering" } };
  if (materialV2) sceneMeta.material_v2 = materialV2;
  const scene = { ...base.scene, spec: boundSpec, organs: [item], metadata: sceneMeta } as SceneData;
  const summary = { ...base.summary, disease, extent_mm: extent, measurements, min_jacobian: qa.continuous_jacobian_lower_bound, min_jacobian_kind: "conservative_bound", qa_status: qa.status, qa_scope: qa.scope };
  return { scene, spec: boundSpec, summary };
}
