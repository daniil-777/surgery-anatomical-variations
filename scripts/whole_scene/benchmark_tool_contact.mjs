/** Actual bundled-mesh CPU benchmark. Node timings are not browser frame rates. */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const source = await readFile(path.join(root, "viscera/apps/studio/src/wholeSceneContact.ts"), "utf8");
const transformed = await transformWithEsbuild(source, "wholeSceneContact.ts", { loader: "ts", target: "es2022" });
const { SceneSurfaceContact } = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString("base64")}`);
const data = await readFile(path.join(root, "viscera/apps/studio/public/anatomy-scene/bodyparts3d-torso.glb"));
const jsonLength = data.readUInt32LE(12), doc = JSON.parse(data.subarray(20, 20 + jsonLength).toString());
const binary = data.subarray(28 + jsonLength);
function accessor(i) {
  const a = doc.accessors[i], v = doc.bufferViews[a.bufferView], offset = (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const count = a.count * (a.type === "VEC3" ? 3 : 1), type = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array }[a.componentType];
  return new type(binary.buffer, binary.byteOffset + offset, count).slice();
}
const records = [];
for (const mesh of doc.meshes) {
  const p = mesh.primitives[0], rest = accessor(p.attributes.POSITION), indices = accessor(p.indices);
  let start = performance.now(); const surface = new SceneSurfaceContact(mesh.name, rest, indices), buildMs = performance.now() - start;
  start = performance.now(); for (let repeat = 0; repeat < 3; repeat++) surface.refit(rest); const refitMs = (performance.now() - start) / 3;
  const i = Math.floor(indices.length / 9) * 3, verts = [0, 1, 2].map(a => Array.from(rest.slice(indices[i + a] * 3, indices[i + a] * 3 + 3)));
  const center = [0, 1, 2].map(a => verts.reduce((s, v) => s + v[a] / 3, 0));
  const from = center.map((v, a) => v + (a === 2 ? 30 : 0)), to = center.map((v, a) => v - (a === 2 ? 10 : 0));
  start = performance.now(); let hit;
  for (let repeat = 0; repeat < 3; repeat++) hit = surface.sweepSphere(from, to, 6);
  const sphereMs = (performance.now() - start) / 3, testedTriangles = surface.snapshot().testedTriangles;
  start = performance.now(); const capsule = surface.sweepCapsule(from, from.map((v, a) => v + (a === 2 ? 100 : 0)), to, to.map((v, a) => v + (a === 2 ? 100 : 0)), 2.6); const capsuleMs = performance.now() - start;
  const record = { id: mesh.name, triangles: indices.length / 3, build_ms: buildMs, refit_ms: refitMs, sphere_query_ms: sphereMs, sphere_narrow_phase_triangles: testedTriangles, sphere_hit: Boolean(hit), capsule_query_ms: capsuleMs, capsule_hit: Boolean(capsule) };
  records.push(record); console.log(JSON.stringify(record));
}
const report = { scope: "Node CPU timings on the actual bundled 39-structure atlas; representative 40mm tip sweep and100mm shaft. Not browser performance or exhaustive contact validation. Warmup/GC/system load influence individual measurements. Refit all surfaces each frame is unnecessary: renderer should lazily refit dirty broad-phase candidate meshes.", structures: records.length, triangles: records.reduce((s, r) => s + r.triangles, 0), total_build_ms: records.reduce((s, r) => s + r.build_ms, 0), total_refit_ms: records.reduce((s, r) => s + r.refit_ms, 0), records };
const out = path.join(root, "viscera/benchmarks/results/whole-scene-tools-2026-10-08"); await mkdir(out, { recursive: true }); await writeFile(path.join(out, "contact-benchmark.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ total_build_ms: report.total_build_ms, total_refit_ms: report.total_refit_ms, triangles: report.triangles }));
