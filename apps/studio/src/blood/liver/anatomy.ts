import type { OrganMesh } from "@viscera/render";
import type { AtlasGeneration } from "../../atlas";
import { bundledReference } from "../../atlasLocal";
import { createAtlasVesselNetwork, evaluateVesselAnchor } from "../../atlasVessels";
import { refineLiverAnatomy } from "./refinement";
import type { LiverAnatomy, LiverSurfacePick, LiverTarget, LiverVec3 } from "./types";

export const LIVER_TEMPLATE_ID = "hra-liver-female";
const finite = (v: number) => Number.isFinite(v);
/** Copies the tissue/capsule component; ligaments remain in the source library.
 * No source vertices are moved, welded, closed or otherwise repaired. */
export function adaptLiverAnatomy(generation: AtlasGeneration): LiverAnatomy {
  const original = generation.scene.organs.find(o => o.id === "liver");
  if (!original || !Array.isArray(original.positions) || !Array.isArray(original.indices) || original.positions.length % 3 || original.indices.length % 3 || !original.positions.every(finite))
    throw new RangeError("A finite indexed liver atlas surface is required.");
  const arrays = original as OrganMesh & { rest_positions?: number[]; material_regions?: number[] };
  const regions = arrays.material_regions;
  if (!regions || regions.length !== original.positions.length / 3 || regions.some(r => !finite(r) || r < 0 || r > 1)) throw new RangeError("The liver reference must identify tissue and ligament regions.");
  const rest = arrays.rest_positions ?? original.positions;
  if (rest.length !== original.positions.length || !rest.every(finite)) throw new RangeError("Invalid liver rest coordinates.");
  const map = new Map<number, number>(), sourceTriangles: number[] = [], sourceVertices: number[] = [], indices: number[] = [];
  for (let t = 0; t < original.indices.length / 3; t++) {
    const ids = original.indices.slice(t * 3, t * 3 + 3);
    if (ids.some(i => !Number.isSafeInteger(i) || i < 0 || i >= regions.length)) throw new RangeError("Invalid liver triangle index.");
    if (!ids.every(i => regions[i] === 0)) continue;
    sourceTriangles.push(t);
    for (const i of ids) { let target = map.get(i); if (target === undefined) { target = map.size; map.set(i, target); sourceVertices.push(i); } indices.push(target); }
  }
  if (!indices.length) throw new RangeError("The reference contains no liver capsule.");
  const copy3 = (values: number[]) => sourceVertices.flatMap(i => values.slice(i * 3, i * 3 + 3));
  const positions = copy3(original.positions), restPositions = copy3(rest), normalSum = new Float64Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, b = indices[t + 1]! * 3, c = indices[t + 2]! * 3;
    const u = [positions[b]! - positions[a]!, positions[b + 1]! - positions[a + 1]!, positions[b + 2]! - positions[a + 2]!];
    const v = [positions[c]! - positions[a]!, positions[c + 1]! - positions[a + 1]!, positions[c + 2]! - positions[a + 2]!];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    if (!(Math.hypot(...n) > 1e-10)) throw new RangeError("The liver contains a degenerate capsule triangle.");
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) normalSum[i + k] = normalSum[i + k]! + n[k]!;
  }
  const normals = new Float32Array(positions.length);
  for (let i = 0; i < normals.length; i += 3) {
    const source = original.normals?.slice(sourceVertices[i / 3]! * 3, sourceVertices[i / 3]! * 3 + 3);
    const n = source?.length === 3 && source.every(finite) && Math.hypot(...source) > .1 ? source : Array.from(normalSum.slice(i, i + 3));
    const len = Math.hypot(...n); if (!(len > 0)) throw new RangeError("The liver has an undefined capsule normal.");
    for (let k = 0; k < 3; k++) normals[i + k] = n[k]! / len;
  }
  const organ: OrganMesh & { rest_positions: number[]; material_regions: number[] } = {
    ...structuredClone(original), positions, indices, normals: Array.from(normals), rest_positions: restPositions, material_regions: sourceVertices.map(i => regions[i]!),
    metadata: { ...structuredClone(original.metadata), liver_capsule_source_triangles: sourceTriangles, liver_capsule_source_vertices: sourceVertices },
  };
  if (original.colors) organ.colors = copy3(original.colors);
  if (original.uv) organ.uv = sourceVertices.flatMap(i => original.uv!.slice(i * 2, i * 2 + 2));
  const network = createAtlasVesselNetwork(organ, { organId: "liver", seed: 42, density: .45, visibility: .85 });
  const surface = { positionsM: Float64Array.from(positions, p => p * .001), normals, indices: Uint32Array.from(indices) };
  const vessels = network.segments.map((s, i) => ({ id: `liver-vessel-${i}`, aM: s.a_mm.map((p, k) => (p - s.normal[k]! * s.depth_mm) * .001) as LiverVec3,
    bM: s.b_mm.map((p, k) => (p - s.normal[k]! * s.depth_mm) * .001) as LiverVec3, normal: [...s.normal] as LiverVec3,
    radiusAM: s.radius_a_mm * .001, radiusBM: s.radius_b_mm * .001, depthM: s.depth_mm * .001, aTriangle: s.a_anchor.triangle, bTriangle: s.b_anchor.triangle }));
  const targets: LiverTarget[] = [];
  const candidates = network.segments.map((s, i) => ({ s, i })).filter(({ s }) => s.radius_a_mm >= .12 && s.depth_mm < 1.5 && s.normal[1] > -.3)
    .sort((a, b) => {
      const score = (s: typeof a.s) => (s.depth_mm - s.radius_a_mm > .32 ? 10 : 0) + s.normal[2] + s.normal[1] * .5 + s.radius_a_mm;
      return score(b.s) - score(a.s);
    });
  for (const { s, i } of candidates) {
    const point = evaluateVesselAnchor(s.a_anchor, positions, indices).map(p => p * .001) as LiverVec3;
    if (targets.some(t => Math.hypot(...point.map((p, k) => p - t.pick.positionM[k]!)) < .018)) continue;
    const ids = indices.slice(s.a_anchor.triangle * 3, s.a_anchor.triangle * 3 + 3);
    const n = [0, 1, 2].map(k => ids.reduce((a, v, j) => a + normals[v * 3 + k]! * s.a_anchor.weights[j]!, 0)) as LiverVec3;
    const len = Math.hypot(...n); for (let k = 0; k < 3; k++) n[k] = n[k]! / len;
    const pick: LiverSurfacePick = { triangle: s.a_anchor.triangle, positionM: point, normal: n, barycentric: [...s.a_anchor.weights] };
    targets.push({ id: `liver-target-${targets.length + 1}`, label: `Surface vessel ${targets.length + 1}`, vesselId: vessels[i]!.id, pick });
    if (targets.length === 12) break;
  }
  const source = generation.scene.metadata?.source as Record<string, unknown> | undefined;
  return { surface, organ, network, vessels, targets, sourceTriangleIndices: Uint32Array.from(sourceTriangles), sourceVertexIndices: Uint32Array.from(sourceVertices), provenance: { templateId: String(generation.spec.template_id), label: "HRA liver capsule with authored surface vessels",
    attribution: String(source?.attribution ?? "Browne, Kristen. 2024. 3D Reference Organ for Liver, Female v1.2. https://doi.org/10.48539/HBM599.GZLD.639"),
    source: String(source?.url ?? "https://doi.org/10.48539/HBM599.GZLD.639"), license: String(source?.license ?? "CC-BY-4.0"), vascularModel: "procedural-surface-design-not-patient-vasculature",
    detail: `${String(source?.attribution ?? "HRA reference liver")}; capsule-only extraction, original source triangle/vertex mappings in organ.metadata; coordinates Y-up, centred, mm converted to metres. Source open boundaries retained. Vessels are seeded design, not segmented anatomy; no patient calibration or portal circulation inferred.` } };
}

export async function loadLiverAnatomy(signal?: AbortSignal): Promise<LiverAnatomy> {
  signal?.throwIfAborted();
  const generation = await bundledReference(LIVER_TEMPLATE_ID, signal);
  signal?.throwIfAborted();
  const anatomy = refineLiverAnatomy(adaptLiverAnatomy(generation));
  signal?.throwIfAborted();
  return anatomy;
}
