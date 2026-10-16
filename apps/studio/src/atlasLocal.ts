// atlasLocal.ts — the public copy's realizer. Without the VISCERA API, the organ studio still has to answer a slider,
// an appearance switch or a surface recipe at once. The API's work for those is small and closed-form, so it is
// repeated here, from the bundled reference specimen of the template:
//   · shape: the same invertible deformation as viscera_core.atlas.deform_vertices (scale → taper → twist → bend →
//     asymmetry shear, each control times its template limit, in the template's normalised frame), the same exact
//     Jacobian, and the same bounded-deformation checks as atlas.generate (finite, positive Jacobian, no new degenerate
//     faces, no normal turns, edge and area ratios in band); controls that fail are halved until they pass, as the
//     API's source-safe projection does. The API additionally certifies every source face at three precisions and
//     transports source normals through the map; here normals are recomputed area-weighted. Both are stated in the
//     result's metadata.
//   · surface: viscera_core.atlas_materials.resolve_material — organ profile × preset × recipe → the shader uniforms
//     the GPU material reads (the shader itself is the same file in both places).
//   · appearance: tissue keeps the reference's authored colours (they depend on the shape seed, which the API owns),
//     source uses the template's own colours (bundled), clay is one flat colour.
// Seeds, disease, learned or joint sampling, photo-based colours and exports still need the API, and say so.
// atlasLocal.test.ts compares this file with the running API numerically.
import type { OrganMesh, SceneData } from "@viscera/render";
import { bundledJson } from "./api";
import type { AtlasGeneration, AtlasSpec, AtlasTemplate } from "./atlas";
import type { AtlasMaterialRecipe } from "./atlasMaterial";
import { ATLAS_MATERIAL_SHADER_SHA256, ATLAS_MATERIAL_SHADER_VERSION } from "./atlasMaterialShader";
import type { PhysicsObservation, PhysicsParameters, PhysicsSource } from "./atlasPhysics";

export const LOCAL_REALIZER_VERSION = "browser-realizer-1.0.0";
export const CONTROL_NAMES = ["scale_x", "scale_y", "scale_z", "bend", "twist", "taper", "asymmetry"] as const;
export const NEEDS_API = {
  seed: "The shape seed changes the authored tissue colour noise, which the VISCERA API computes; this public copy keeps the reference seed.",
  jointDisease: "Joint variation with a disease profile needs the VISCERA API, which renders the disease morphology; this public copy samples healthy joint variations in the browser.",
  disease: "Disease morphology is computed by the VISCERA API; this public copy shows healthy references.",
  referenceColor: "Analysing your own photograph needs the VISCERA API; this public copy carries the analyses of its bundled photographs.",
  physicsTemplate: "This public copy prepares the hands-on liver for the two reference livers only.",
  physicsEdited: "This public copy prepares the hands-on liver for the reference shape only: reset the shape controls and sculpture, or use the local studio for a reshaped liver.",
  physicsCalibration: "Calibrating the learned material from your own measurement needs the VISCERA API; this public copy carries the learned parameters for the demonstration calibration.",
} as const;

// ---------------------------------------------------------------------------------------------- material tables
// viscera_core.atlas_materials PROFILES and PRESETS (the parts resolve_material reads)
const PROFILES: Record<string, { color: string; roughness: number; pigment: number; fine_mm: number; height_mm: number; structure_mm: number; structure: "soft" | "lobular" | "directional" }> = {
  liver: { color: "#793f37", roughness: 0.43, pigment: 0.36, fine_mm: 0.48, height_mm: 0.024, structure_mm: 2.4, structure: "soft" },
  gallbladder: { color: "#777953", roughness: 0.40, pigment: 0.25, fine_mm: 0.42, height_mm: 0.014, structure_mm: 2.0, structure: "soft" },
  stomach: { color: "#b58a80", roughness: 0.48, pigment: 0.24, fine_mm: 0.52, height_mm: 0.020, structure_mm: 2.5, structure: "soft" },
  pancreas: { color: "#bc9b80", roughness: 0.56, pigment: 0.30, fine_mm: 0.55, height_mm: 0.032, structure_mm: 1.5, structure: "lobular" },
  spleen: { color: "#713e52", roughness: 0.44, pigment: 0.34, fine_mm: 0.45, height_mm: 0.020, structure_mm: 2.0, structure: "soft" },
  kidney: { color: "#a15c50", roughness: 0.42, pigment: 0.28, fine_mm: 0.42, height_mm: 0.018, structure_mm: 1.8, structure: "soft" },
  "small-intestine": { color: "#c09a89", roughness: 0.45, pigment: 0.22, fine_mm: 0.46, height_mm: 0.018, structure_mm: 1.8, structure: "soft" },
  "large-intestine": { color: "#b89784", roughness: 0.48, pigment: 0.24, fine_mm: 0.50, height_mm: 0.020, structure_mm: 2.0, structure: "soft" },
  heart: { color: "#9d5e58", roughness: 0.48, pigment: 0.28, fine_mm: 0.50, height_mm: 0.026, structure_mm: 1.4, structure: "directional" },
  lung: { color: "#b5979b", roughness: 0.54, pigment: 0.22, fine_mm: 0.40, height_mm: 0.021, structure_mm: 1.2, structure: "lobular" },
  brain: { color: "#b8ada1", roughness: 0.56, pigment: 0.16, fine_mm: 0.38, height_mm: 0.012, structure_mm: 1.6, structure: "soft" },
  "urinary-bladder": { color: "#b9958b", roughness: 0.48, pigment: 0.22, fine_mm: 0.45, height_mm: 0.018, structure_mm: 2.0, structure: "soft" },
};
const PRESET_MULTIPLIER: Record<string, [number, number, number]> = {
  balanced: [1, 1, 1], soft: [1.08, 1.10, 1.10], rich: [0.85, 0.81, 0.84], moist: [0.98, 0.96, 0.96],
};
const CLAY = "#81928f";

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];

// viscera_core.reference_color: Oklab (Björn Ottosson), chroma compression at fixed lightness and hue, the transfer
type Vec3 = [number, number, number];
const M1 = [[0.4122214708, 0.5363325363, 0.0514459929], [0.2119034982, 0.6806995451, 0.1073969566], [0.0883024619, 0.2817188376, 0.6299787005]];
const M2 = [[0.2104542553, 0.7936177850, -0.0040720468], [1.9779984951, -2.4285922050, 0.4505937099], [0.0259040371, 0.7827717662, -0.8086757660]];
const invert = (m: number[][]): number[][] => {
  const [a, b, c] = m[0]!, [d, e, f] = m[1]!, [g, h, i] = m[2]!;
  const det = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  return [[(e! * i! - f! * h!) / det, (c! * h! - b! * i!) / det, (b! * f! - c! * e!) / det], [(f! * g! - d! * i!) / det, (a! * i! - c! * g!) / det, (c! * d! - a! * f!) / det], [(d! * h! - e! * g!) / det, (b! * g! - a! * h!) / det, (a! * e! - b! * d!) / det]];
};
const I1 = invert(M1), I2 = invert(M2);
const mul = (m: number[][], v: Vec3): Vec3 => [0, 1, 2].map((r) => m[r]![0]! * v[0] + m[r]![1]! * v[1] + m[r]![2]! * v[2]) as Vec3;
const linearToSrgb = (x: number) => { const c = Math.min(1, Math.max(0, x)); return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055; };
const toOklab = (srgb: Vec3): Vec3 => mul(M2, mul(M1, srgb.map(srgbToLinear) as Vec3).map(Math.cbrt) as Vec3);
const oklabLinear = (lab: Vec3): Vec3 => mul(I1, mul(I2, lab).map((v) => v ** 3) as Vec3);
/** Chroma compressed at fixed lightness and hue until the colour fits sRGB; in-gamut input is returned exactly. */
export function gamutSrgb(lab: Vec3): Vec3 {
  const value: Vec3 = [Math.min(1, Math.max(0, lab[0])), lab[1], lab[2]];
  const inGamut = (c: Vec3) => oklabLinear(c).every((v) => v >= -1e-9 && v <= 1 + 1e-9);
  const raw = oklabLinear(value);
  let scale = 1;
  if (!raw.every((v) => v >= 0 && v <= 1)) {
    let low = 0, high = 1;
    for (let i = 0; i < 24; i++) { const mid = (low + high) / 2; if (inGamut([value[0], value[1] * mid, value[2] * mid])) low = mid; else high = mid; }
    scale = low;
  }
  return oklabLinear([value[0], value[1] * scale, value[2] * scale]).map(linearToSrgb) as Vec3;
}
export interface ReferenceColorLike { observed_srgb: Vec3; strength: number; mode: "chroma" | "color" }
/** reference_color.transfer_base_color: the base moved towards the observed colour in Oklab, chroma only by default. */
export function transferBaseColor(base: Vec3, reference: ReferenceColorLike): Vec3 {
  if (reference.strength === 0) return [...base];
  const old = toOklab(base), target = toOklab(reference.observed_srgb);
  if (reference.mode === "chroma") target[0] = old[0];
  return gamutSrgb(old.map((v, i) => v + reference.strength * (target[i]! - v)) as Vec3);
}
const clip = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const srgbToLinear = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);

/** JSON with sorted keys and no spaces, as Python's json.dumps(sort_keys=True, separators=(",", ":")) writes it. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return JSON.stringify(value);
}
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------------------------- the shape map
/** viscera_core.atlas.deform_vertices: controls × limits, applied in the template's normalised frame. */
export function deformVertices(rest: ArrayLike<number>, controls: Record<string, number>, limits: ArrayLike<number>, normalizationMm: number): Float64Array {
  if (!(normalizationMm > 0) || !Number.isFinite(normalizationMm)) throw new Error("normalization_mm must be positive and finite");
  if (limits.length !== 7) throw new Error("The reference declares no control limits.");
  const c = CONTROL_NAMES.map((name, i) => {
    const value = controls[name] ?? 0, limit = limits[i]!;
    if (!Number.isFinite(value) || !Number.isFinite(limit)) throw new Error("Shape controls must be finite.");
    return value * limit;
  });
  const out = new Float64Array(rest.length);
  if (c.every((v) => v === 0)) { for (let i = 0; i < rest.length; i++) out[i] = rest[i]!; return out; }
  const e0 = Math.exp(c[0]!), e1 = Math.exp(c[1]!), e2 = Math.exp(c[2]!), bend = c[3]!, twist = c[4]!, taper = c[5]!, shear = c[6]!;
  for (let i = 0; i < rest.length; i += 3) {
    let x = rest[i]! / normalizationMm * e0, y = rest[i + 1]! / normalizationMm * e1;
    const z = rest[i + 2]! / normalizationMm * e2;
    const t = Math.tanh(z), grow = Math.exp(taper * t);
    x *= grow; y *= grow;
    const angle = twist * t, cs = Math.cos(angle), sn = Math.sin(angle);
    const rx = cs * x - sn * y, ry = sn * x + cs * y;
    const bx = rx + bend * t * t;
    out[i] = bx * normalizationMm; out[i + 1] = ry * normalizationMm; out[i + 2] = (z + shear * Math.tanh(bx)) * normalizationMm;
  }
  return out;
}
/** viscera_core.atlas.jacobian_determinants, as its minimum and maximum over the template's vertices. */
export function jacobianRange(rest: ArrayLike<number>, controls: Record<string, number>, limits: ArrayLike<number>, normalizationMm: number): [number, number] {
  const c = CONTROL_NAMES.map((name, i) => (controls[name] ?? 0) * limits[i]!);
  const sum = c[0]! + c[1]! + c[2]!, e2 = Math.exp(c[2]!);
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < rest.length; i += 3) { const j = Math.exp(sum + 2 * c[5]! * Math.tanh(rest[i]! / normalizationMm * e2)); if (j < lo) lo = j; if (j > hi) hi = j; }
  return [lo, hi];
}

// ---------------------------------------------------------------------------------------------- checks
interface FaceCache { cross: Float64Array; area2: Float64Array; edges: Int32Array; edgeLength: Float64Array }
const caches = new Map<string, FaceCache>();
function crosses(positions: ArrayLike<number>, faces: ArrayLike<number>): { cross: Float64Array; area2: Float64Array } {
  const n = faces.length / 3, cross = new Float64Array(n * 3), area2 = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    const a = faces[f * 3]! * 3, b = faces[f * 3 + 1]! * 3, c = faces[f * 3 + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    cross[f * 3] = x; cross[f * 3 + 1] = y; cross[f * 3 + 2] = z; area2[f] = Math.hypot(x, y, z);
  }
  return { cross, area2 };
}
function faceCache(key: string, rest: ArrayLike<number>, faces: ArrayLike<number>): FaceCache {
  const hit = caches.get(key);
  if (hit) return hit;
  const { cross, area2 } = crosses(rest, faces);
  const vertices = rest.length / 3, seen = new Set<number>(), pairs: number[] = [];
  for (let f = 0; f < faces.length; f += 3) for (const [p, q] of [[0, 1], [1, 2], [2, 0]] as const) {
    const a = faces[f + p]!, b = faces[f + q]!, lo = Math.min(a, b), hi = Math.max(a, b), id = lo * vertices + hi;
    if (!seen.has(id)) { seen.add(id); pairs.push(lo, hi); }
  }
  const edges = Int32Array.from(pairs), edgeLength = new Float64Array(edges.length / 2);
  for (let e = 0; e < edgeLength.length; e++) edgeLength[e] = Math.hypot(rest[edges[e * 2]! * 3]! - rest[edges[e * 2 + 1]! * 3]!, rest[edges[e * 2]! * 3 + 1]! - rest[edges[e * 2 + 1]! * 3 + 1]!, rest[edges[e * 2]! * 3 + 2]! - rest[edges[e * 2 + 1]! * 3 + 2]!);
  const cache = { cross, area2, edges, edgeLength };
  caches.set(key, cache);
  return cache;
}
export interface LocalQa { passed: boolean; status: string; scope: string; finite: boolean; min_jacobian: number; max_jacobian: number; new_degenerate_faces: number; normal_turns_over_90_degrees: number; min_normal_dot: number; edge_ratio_min: number; edge_ratio_max: number; area_ratio_min: number; area_ratio_max: number; topology_preserved: true; surface_area_mm2: number; self_intersection: { status: string; reason: string }; anatomical_plausibility: { status: string; reason: string }; mechanical_validation: { status: string; reason: string }; volume_ratio: null; source_face_certification: { status: string; reason: string } }
/** viscera_core.atlas.generate's checks against the template's rest geometry. */
export function checkDeformation(positions: Float64Array, faces: ArrayLike<number>, cache: FaceCache, jacobian: [number, number]): LocalQa {
  const { cross, area2 } = crosses(positions, faces);
  let finite = true; for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i]!)) { finite = false; break; }
  let newDegenerate = 0, turns = 0, minDot = Infinity, aMin = Infinity, aMax = -Infinity, area = 0;
  for (let f = 0; f < area2.length; f++) {
    area += area2[f]!;
    if (cache.area2[f]! <= 2e-12) continue;
    if (area2[f]! <= 2e-12) newDegenerate++;
    const ratio = area2[f]! / cache.area2[f]!; if (ratio < aMin) aMin = ratio; if (ratio > aMax) aMax = ratio;
    const dot = (cross[f * 3]! * cache.cross[f * 3]! + cross[f * 3 + 1]! * cache.cross[f * 3 + 1]! + cross[f * 3 + 2]! * cache.cross[f * 3 + 2]!) / Math.max(area2[f]! * cache.area2[f]!, 1e-300);
    if (dot <= 0) turns++; if (dot < minDot) minDot = dot;
  }
  let eMin = Infinity, eMax = -Infinity;
  for (let e = 0; e < cache.edgeLength.length; e++) {
    if (cache.edgeLength[e]! <= 1e-9) continue;
    const a = cache.edges[e * 2]! * 3, b = cache.edges[e * 2 + 1]! * 3;
    const ratio = Math.hypot(positions[a]! - positions[b]!, positions[a + 1]! - positions[b + 1]!, positions[a + 2]! - positions[b + 2]!) / cache.edgeLength[e]!;
    if (ratio < eMin) eMin = ratio; if (ratio > eMax) eMax = ratio;
  }
  const passed = finite && jacobian[0] > 0 && newDegenerate === 0 && turns === 0 && eMin > 0.65 && eMax < 1.55 && aMin > 0.5 && aMax < 2.0;
  return {
    passed, status: passed ? "PASS" : "FAIL",
    scope: "browser preview: bounded deformation of the source display surfaces (finite, positive Jacobian, no new degenerate faces, no normal turns, edge and area ratios in band); the API's all-precision source-face certification did not run",
    finite, min_jacobian: jacobian[0], max_jacobian: jacobian[1], new_degenerate_faces: newDegenerate, normal_turns_over_90_degrees: turns, min_normal_dot: minDot,
    edge_ratio_min: eMin, edge_ratio_max: eMax, area_ratio_min: aMin, area_ratio_max: aMax, topology_preserved: true, surface_area_mm2: area / 2,
    self_intersection: { status: "NOT_RUN", reason: "Continuous bijection does not certify discrete/source intersections" },
    anatomical_plausibility: { status: "NOT_RUN", reason: "Requires independent anatomical review" },
    mechanical_validation: { status: "NOT_RUN", reason: "No volumetric mechanics in this surface track" },
    volume_ratio: null,
    source_face_certification: { status: "NOT_RUN", reason: "The VISCERA API certifies source faces at float64, float32-mm and float32-metre precision; the browser preview does not" },
  };
}
/** Area-weighted vertex normals of the deformed surface (the API transports source normals through the map instead). */
export function vertexNormals(positions: Float64Array, faces: ArrayLike<number>): Float64Array {
  const n = new Float64Array(positions.length);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f]! * 3, b = faces[f + 1]! * 3, c = faces[f + 2]! * 3;
    const ux = positions[b]! - positions[a]!, uy = positions[b + 1]! - positions[a + 1]!, uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!, vy = positions[c + 1]! - positions[a + 1]!, vz = positions[c + 2]! - positions[a + 2]!;
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v] = n[v]! + x; n[v + 1] = n[v + 1]! + y; n[v + 2] = n[v + 2]! + z; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1; n[i] = n[i]! / l; n[i + 1] = n[i + 1]! / l; n[i + 2] = n[i + 2]! / l; }
  return n;
}
/** viscera_core.atlas._geometry_hash: SHA-256 over float64 positions and int64 faces, little-endian. */
export async function geometryHash(positions: Float64Array, faces: ArrayLike<number>): Promise<string> {
  const bytes = new Uint8Array(positions.length * 8 + faces.length * 8);
  bytes.set(new Uint8Array(positions.buffer, positions.byteOffset, positions.byteLength));
  const view = new DataView(bytes.buffer, positions.byteLength);
  for (let i = 0; i < faces.length; i++) view.setBigInt64(i * 8, BigInt(faces[i]!), true);
  return sha256Hex(bytes);
}

// ---------------------------------------------------------------------------------------------- the surface
/** viscera_core.atlas_materials.resolve_material for a recipe without a photographed reference colour. */
export function resolveMaterial(recipe: AtlasMaterialRecipe): Record<string, unknown> {
  const profile = PROFILES[recipe.organ], multiplier = PRESET_MULTIPLIER[recipe.preset];
  if (!profile || !multiplier) throw new Error("Unknown organ or material preset.");
  const r = recipe as AtlasMaterialRecipe & Record<string, unknown>;
  const tint = Number(r.tint ?? 0);
  let base = rgb(profile.color).map((v, i) => clip(v * multiplier[i]! + tint * [0.032, -0.008, -0.026][i]!, 0.02, 0.94)) as Vec3;
  const reference = r.reference_color as ReferenceColorLike | null | undefined;
  if (reference) base = transferBaseColor(base, { observed_srgb: reference.observed_srgb, strength: reference.strength ?? 1, mode: reference.mode ?? "chroma" });
  const ligament = rgb("#beb09b").map((v, i) => clip(v + tint * [0.018, -0.004, -0.014][i]!, 0.02, 0.94));
  const mode = { soft: 0, directional: 1, lobular: 2 }[profile.structure];
  const wetness = Number(r.wetness);
  const uniforms = {
    uAtlasSeed: recipe.seed, uAtlasBaseColor: base.map(srgbToLinear), uAtlasLigamentColor: ligament.map(srgbToLinear),
    uAtlasPigmentContrast: Number(r.pigment_contrast), uAtlasMottleScaleMm: Number(r.mottle_scale_mm), uAtlasWetness: wetness,
    uAtlasFineDetail: Number(r.fine_detail), uAtlasStructureStrength: Number(r.structure_strength), uAtlasRoughnessBase: profile.roughness,
    uAtlasPigmentAmplitude: profile.pigment, uAtlasFineScaleMm: profile.fine_mm, uAtlasHeightAmplitudeMm: profile.height_mm,
    uAtlasStructureScaleMm: profile.structure_mm, uAtlasStructureMode: mode, uAtlasStructureStretch: mode === 1 ? [1.8, 0.24, 1.25] : [1, 1, 1],
  };
  return {
    version: "atlas-material-2.0.0", shader_version: ATLAS_MATERIAL_SHADER_VERSION, recipe: { ...recipe }, recipe_sha256: null, uniforms,
    base_color_srgb: base, ligament_color_srgb: ligament, clearcoat: 0.06 + 0.54 * wetness, clearcoat_roughness: 0.48 - 0.30 * wetness, metalness: 0,
    coordinates: "template_rest_mm", height_units: "mm", normal_gradient: "d(height_mm)/d(template_rest_mm); apply as shading only",
    region_ids: { "0": "tissue", "1": "ligament" }, evidence: reference ? "observed_reference_color; design_heuristic" : "design_heuristic", optical_validation: "NOT_RUN", geometry_modified: false, vascular_ground_truth: false,
    ...(reference ? { reference_color: reference, reference_scope: "observed tissue colour only; user-assigned identity; no optical or mechanical inference" } : {}),
    structure_interpretation: `authored ${profile.structure} grain, not measured microanatomy or fiber orientation`, shader_sha256: ATLAS_MATERIAL_SHADER_SHA256,
    resolved_by: LOCAL_REALIZER_VERSION,
  };
}

// ---------------------------------------------------------------------------------------------- bundled files
const references = new Map<string, Promise<AtlasGeneration>>();
const sourceColors = new Map<string, Promise<number[]>>();
/** The API's rendering of a template with default controls, bundled with the public copy; one download per template. */
export function bundledReference(templateId: string, signal?: AbortSignal): Promise<AtlasGeneration> {
  let p = references.get(templateId);
  if (!p) {
    p = bundledJson(`atlas/specimens/${templateId}.json.gz`, signal).then((v) => v as AtlasGeneration);
    references.set(templateId, p);
    p.catch(() => references.delete(templateId));
  }
  return p;
}
function bundledSourceColors(templateId: string, signal?: AbortSignal): Promise<number[]> {
  let p = sourceColors.get(templateId);
  if (!p) {
    p = bundledJson(`atlas/templates/${templateId}.source-colors.json.gz`, signal).then((v) => { if (!Array.isArray(v)) throw new Error("The bundled source colours are invalid."); return v as number[]; });
    sourceColors.set(templateId, p);
    p.catch(() => sourceColors.delete(templateId));
  }
  return p;
}

// ---------------------------------------------------------------------------------------------- realize
/** What the API answers for `spec`, from the bundled reference of its template. */
export async function realizeLocally(reference: AtlasGeneration, spec: AtlasSpec, template: AtlasTemplate, signal?: AbortSignal): Promise<AtlasGeneration> {
  if (spec.template_id !== reference.spec.template_id) throw new Error("The bundled reference belongs to another template.");
  if (spec.disease) throw new Error(NEEDS_API.disease);
  // the seed only colours the authored vertex noise, which the tissue material's shader does not read (vertexColors off):
  // a tissue specimen with a surface recipe may carry any seed (the joint flow samples with the request seed)
  if (spec.seed !== reference.spec.seed && !(spec.appearance === "tissue" && spec.material)) throw new Error(NEEDS_API.seed);
  const limits = template.control_limits, normalization = template.normalization_mm;
  if (!Array.isArray(limits) || typeof normalization !== "number") throw new Error("The bundled library lacks this reference's control limits or normalisation.");
  const organ = reference.scene.organs[0];
  if (!organ) throw new Error("The reference has no organ.");
  const arrays = organ as OrganMesh & { rest_positions?: number[]; material_regions?: number[] };
  const rest = arrays.rest_positions ?? organ.positions, faces = organ.indices;
  const cache = faceCache(spec.template_id, rest, faces);

  // the shape: requested controls, halved until the checks pass (the API projects the same way, with its own gate)
  const requested = { ...spec.controls };
  let applied = requested, fraction = 1, positions: Float64Array | null = null, qa: LocalQa | null = null;
  for (let attempt = 0; attempt < 16 && !positions; attempt++) {
    fraction = 2 ** -attempt;
    applied = Object.fromEntries(Object.entries(requested).map(([k, v]) => [k, v * fraction]));
    const candidate = deformVertices(rest, applied, limits, normalization);
    const check = checkDeformation(candidate, faces, cache, jacobianRange(rest, applied, limits, normalization));
    if (check.passed) { positions = candidate; qa = check; }
  }
  if (!positions || !qa) throw new Error("Source template cannot satisfy the geometry checks for these controls.");
  const normals = vertexNormals(positions, faces);
  const geometry = await geometryHash(positions, faces);
  const normalsHash = await sha256Hex(new Uint8Array(new Float32Array(normals).buffer));
  let dmax = 0, dsum = 0;
  for (let i = 0; i < positions.length; i += 3) { const d2 = (positions[i]! - organ.positions[i]!) ** 2 + (positions[i + 1]! - organ.positions[i + 1]!) ** 2 + (positions[i + 2]! - organ.positions[i + 2]!) ** 2; dsum += d2; if (d2 > dmax) dmax = d2; }
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = positions[i + k]!; if (v < lo[k]!) lo[k] = v; if (v > hi[k]!) hi[k] = v; }
  const extent = [hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!];

  // the appearance
  const refAppearance = (reference.scene.metadata as Record<string, unknown>).appearance as Record<string, unknown>;
  let colors: number[], appearance: Record<string, unknown>;
  if (spec.appearance === "tissue") { colors = organ.colors ?? []; appearance = { ...refAppearance, mode: "tissue" }; }
  else if (spec.appearance === "clay") { const c = rgb(CLAY); colors = new Array(positions.length); for (let i = 0; i < colors.length; i += 3) { colors[i] = c[0]; colors[i + 1] = c[1]; colors[i + 2] = c[2]; } appearance = { ...refAppearance, mode: "clay", roughness: 0.85, clearcoat: 0 }; }
  else { colors = await bundledSourceColors(spec.template_id, signal); if (colors.length !== positions.length) throw new Error("The bundled source colours do not match the surface."); appearance = { ...refAppearance, mode: "source", roughness: 0.5, clearcoat: 0, evidence: "source_display_colors; rendering_heuristic" }; }

  // the surface
  const material = spec.appearance === "tissue" && spec.material ? spec.material : null;
  const refMaterial = ((reference.scene.metadata as Record<string, unknown>).material_v2 ?? {}) as Record<string, unknown>;
  const materialV2 = material ? { ...refMaterial, version: "atlas-material-2.0.0", shader_version: ATLAS_MATERIAL_SHADER_VERSION, display_normal_sha256: normalsHash, normal_frame_relative_threshold: refMaterial.normal_frame_relative_threshold ?? 1e-7, recipe: { ...material }, resolved: resolveMaterial(material), geometry_modified: false } : null;
  (materialV2?.resolved as Record<string, unknown> | undefined) && ((materialV2!.resolved as Record<string, unknown>).recipe_sha256 = await sha256Hex(new TextEncoder().encode(canonicalJson(material))));

  const realized = await sha256Hex(new TextEncoder().encode(canonicalJson({ realizer: LOCAL_REALIZER_VERSION, template_id: spec.template_id, seed: spec.seed, geometry, appearance: spec.appearance, material })));
  const boundSpec: AtlasSpec = { ...spec, controls: { ...spec.controls }, template_sha256: reference.spec.template_sha256, realized_id: realized };
  if (!material) delete boundSpec.material;
  const refMeta = reference.scene.metadata as Record<string, unknown>;
  const refDisease = (refMeta.disease ?? {}) as Record<string, unknown>;
  const disease = { ...refDisease, recipe: null, profile: null, max_displacement_mm: Math.sqrt(dmax), rms_displacement_mm: Math.sqrt(dsum / (positions.length / 3) * 3 / 3), requested_sites: 0, realized_sites: 0, applied_displacement_fraction: 1, effective_morphology_strength: 0, requested_morphology_strength: 0, displacement_limited_by_source_mesh: false,
    shape_control_projection: { policy: "browser: controls halved until the bounded-deformation checks pass (the API also certifies source faces at every precision)", requested_controls: requested, applied_controls: applied, applied_fraction: fraction } };
  const measurements = { ...((refMeta.measurements ?? {}) as Record<string, unknown>), extent_x_mm: extent[0], extent_y_mm: extent[1], extent_z_mm: extent[2], surface_area_mm2: qa.surface_area_mm2, volume_ml: null, compactness: null, method: "browser-triangle-measurements-1.0.0" };
  const organMeta = { ...(organ.metadata ?? {}), appearance } as Record<string, unknown>;
  if (materialV2) organMeta.material_v2 = materialV2; else delete organMeta.material_v2;
  const sceneMeta: Record<string, unknown> = { ...refMeta, appearance, geometry_sha256: geometry, realized_id: realized, qa, measurements, disease,
    display_normals: { policy: "browser-area-weighted-vertex-normals-1.0.0", sha256: normalsHash }, realized_by: { version: LOCAL_REALIZER_VERSION, scope: "public copy: shape controls, appearance and surface recipe realized in the browser from the API's reference rendering" } };
  if (materialV2) sceneMeta.material_v2 = materialV2; else delete sceneMeta.material_v2;
  delete sceneMeta.normal_repair;
  const scene = { ...reference.scene, spec: boundSpec, organs: [{ ...organ, positions: Array.from(positions), normals: Array.from(normals), colors, metadata: organMeta }], metadata: sceneMeta } as SceneData;
  const summary = { ...reference.summary, extent_mm: extent, measurements, min_jacobian: qa.min_jacobian, min_jacobian_kind: "vertex_sampled_exact", qa_status: qa.status, qa_scope: qa.scope, disease, material: material ? { version: "atlas-material-2.0.0", preset: material.preset, seed: material.seed } : null, realized_by: LOCAL_REALIZER_VERSION };
  return { scene, spec: boundSpec, summary };
}

// ---------------------------------------------------------------------------------------------- physics
/** The hands-on liver of the public copy: the API's preparation of the two reference livers, bundled. The cage depends
 *  on the geometry only, so a liver with the reference geometry and another surface recipe uses it too; manual
 *  parameters are substituted here; everything else needs the API. */
export async function bundledPlayground(generation: AtlasGeneration, source: PhysicsSource, parameters: PhysicsParameters | undefined, observation: PhysicsObservation | null | undefined, signal?: AbortSignal): Promise<unknown> {
  const spec = generation.spec;
  if (source === "learned" && observation) {
    const demo = await bundledJson("physics/demo-observation.json", signal).catch(() => null);
    if (!demo || JSON.stringify(demo) !== JSON.stringify(observation)) throw new Error(NEEDS_API.physicsCalibration);
  }
  const snapshot = await bundledJson(`physics/playground/${spec.template_id}.${source}.json.gz`, signal).catch(() => { throw new Error(NEEDS_API.physicsTemplate); }) as { source?: { realized_id?: string; geometry_sha256?: string; spec?: unknown }; parameters?: PhysicsParameters; mesh?: { cage_volume_ml?: number; mass_kg?: number } };
  const geometry = (generation.scene.metadata as { geometry_sha256?: string } | undefined)?.geometry_sha256;
  if (!snapshot.source || !geometry || snapshot.source.geometry_sha256 !== geometry) throw new Error(NEEDS_API.physicsEdited);
  // the same surface, perhaps another recipe: the cage is this liver's; the provenance names the displayed spec
  snapshot.source = { ...snapshot.source, realized_id: spec.realized_id as string, spec };
  if (source === "manual" && parameters && snapshot.mesh && typeof snapshot.mesh.cage_volume_ml === "number") {
    snapshot.parameters = { ...parameters };
    snapshot.mesh.mass_kg = snapshot.mesh.cage_volume_ml / 1e6 * parameters.density_kg_m3;
  }
  return snapshot;
}
