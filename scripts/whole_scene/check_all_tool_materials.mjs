/** Read-only actual-atlas coverage of every soft structure's contact response. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = await readFile(path.join(root, "viscera/apps/studio/src/wholeScenePhysics.ts"), "utf8");
const transformed = await transformWithEsbuild(source, "wholeScenePhysics.ts", { loader: "ts", target: "es2022" });
const { WholeScenePhysics } = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);
const assets = path.join(root, "viscera/apps/studio/public/anatomy-scene");
const manifest = JSON.parse(await readFile(path.join(assets, "manifest.json"), "utf8"));
const materials = JSON.parse(await readFile(path.join(assets, "learned-materials.json"), "utf8"));
const organs = manifest.organs.map(o => ({ id: o.id, category: o.category, bounds: { min: o.bounds[0], max: o.bounds[1] } }));
const data = await readFile(path.join(assets, "bodyparts3d-torso.glb"));
const jsonLength = data.readUInt32LE(12), doc = JSON.parse(data.subarray(20, 20 + jsonLength).toString()), binary = data.subarray(28 + jsonLength);
function accessor(i) {
  const a = doc.accessors[i], v = doc.bufferViews[a.bufferView], offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const count = a.count * (a.type === "VEC3" ? 3 : 1), type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType];
  return new type(binary.buffer, binary.byteOffset + offset, count).slice();
}
const rows = [];
for (const organ of organs.filter(o => o.category !== "skeleton")) {
  const mesh = doc.meshes.find(m => m.name === organ.id), p = mesh.primitives[0], positions = accessor(p.attributes.POSITION), indices = accessor(p.indices);
  let triangleIndex = -1, normal, vertices;
  for (let t = 0; t < indices.length / 3; t++) {
    vertices = [0, 1, 2].map(c => Array.from(positions.slice(indices[t * 3 + c] * 3, indices[t * 3 + c] * 3 + 3)));
    const a = vertices[1].map((v, i) => v - vertices[0][i]), b = vertices[2].map((v, i) => v - vertices[0][i]);
    normal = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const size = Math.hypot(...normal); if (size > 1e-6) { normal = normal.map(v => v / size); triangleIndex = t; break; }
  }
  if (triangleIndex < 0) throw new Error(`No nondegenerate source triangle for ${organ.id}`);
  const barycentric = [1 / 3, 1 / 3, 1 / 3], restPoint = [0, 1, 2].map(a => vertices.reduce((sum, p) => sum + p[a] / 3, 0));
  const solver = new WholeScenePhysics(organs, materials);
  solver.beginToolContact({ mode: "push", organId: organ.id, restPointMm: restPoint, normal, targetPointMm: restPoint.map((v, a) => v - normal[a] * 3), radiusMm: 6, attachment: { verticesMm: vertices, barycentric } });
  for (let step = 0; step < 45; step++) solver.step(1 / 60, false);
  const rest = new Float32Array(vertices.flat()), out = new Float32Array(9); solver.deform(rest, out, solver.bind(rest));
  const displayed = [0, 1, 2].map(a => [0, 1, 2].reduce((sum, c) => sum + out[c * 3 + a] / 3, 0));
  const tool = solver.toolSnapshot(), snapshot = solver.snapshot();
  const discrepancy = Math.hypot(...displayed.map((v, a) => v - tool.actualSurfacePointMm[a]));
  const displacement = Math.hypot(...tool.displacementMm), force = Math.hypot(...tool.forceN);
  const record = { id: organ.id, triangle_index: triangleIndex, young_pa: materials.materials.find(m => m.id === organ.id).young_pa, support_radius_mm: tool.supportRadiusMm, displacement_mm: displacement, force_n: force, rendered_anchor_discrepancy_mm: discrepancy, gradient_bound: snapshot.displacement_gradient_bound, finite: snapshot.finite, clamped: tool.clamped };
  if (!record.finite || displacement < 1e-4 || force > 3.000001 || discrepancy > 5e-5 || snapshot.displacement_gradient_bound > .4500001) throw new Error(`Actual-atlas contact response failed: ${JSON.stringify(record)}`);
  rows.push(record); console.log(JSON.stringify(record));
}
const report = { asset_sha256: manifest.sha256, model_id: materials.model_id, scope: "Every soft structure's real source triangle and material assignment receives a3mm normal push for0.75s. Confirms numerical response and rendered barycentric anchoring, not visual accessibility, clinical mechanics or biological tissue calibration.", accepted: rows.length, rows };
const out = path.join(root, "viscera/benchmarks/results/whole-scene-tools-2026-10-08"); await mkdir(out, { recursive: true }); await writeFile(path.join(out, "all-soft-structure-contact.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ accepted: rows.length, maximum_anchor_discrepancy_mm: Math.max(...rows.map(r => r.rendered_anchor_discrepancy_mm)), minimum_displacement_mm: Math.min(...rows.map(r => r.displacement_mm)), maximum_displacement_mm: Math.max(...rows.map(r => r.displacement_mm)) }));
