/** Containment certificate against actual runtime envelopes and visible meshes. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hashes = {};
async function load(name) {
  const source = await readFile(path.join(root, "apps/studio/src", name), "utf8");
  hashes[name] = createHash("sha256").update(source).digest("hex");
  const transformed = await transformWithEsbuild(source, name, { loader: "ts", target: "es2022" });
  const code = transformed.code.replaceAll('from "three"', `from ${JSON.stringify(import.meta.resolve("three"))}`);
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { createLaparoscopicInstrument } = await load("laparoscopicInstruments.ts");
const { instrumentContactEnvelopes } = await load("wholeSceneInstrumentEnvelope.ts");
const workingMeshNames = new Set([
  "five-mm-steel-shaft", "insulated-shaft-sleeve", "sleeve-edge-band", "machined-shaft-mark",
  "proximal-shaft-transition", "distal-clevis-tube", "jaw-actuator-rod", "clevis-side-arm",
  "hinge-rivet", "hinge-rivet-slot", "fenestrated-atraumatic-jaw", "fine-grip-serration", "probe-distal-neck",
]);
function signedDistance(point, capsule) {
  const a = new THREE.Vector3(...capsule.startMm), b = new THREE.Vector3(...capsule.endMm);
  return point.distanceTo(new THREE.Line3(a, b).closestPointToPoint(point, true, new THREE.Vector3())) - capsule.radiusMm;
}
const poses = [
  ...[0, .25, .5, .75, 1].map(closure => ({ mode: "grasp", radius: 6, closure })),
  ...[3, 6, 10].map(radius => ({ mode: "push", radius, closure: 1 })),
];
const records = [];
for (const pose of poses) {
  const instrument = createLaparoscopicInstrument(pose.mode === "grasp" ? "grasper" : "probe");
  instrument.setContactRadius(pose.radius); instrument.setJawClosure(pose.closure); instrument.group.updateMatrixWorld(true);
  const envelopes = instrumentContactEnvelopes(pose.mode, pose.radius, pose.closure);
  const meshes = [];
  instrument.group.traverse(object => {
    if (!object.isMesh || !workingMeshNames.has(object.name)) return;
    const p = object.geometry.getAttribute("position"), index = object.geometry.index;
    const points = Array.from({ length: p.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(object.matrixWorld));
    const count = index ? index.count : p.count;
    let maximum = -Infinity, failed = 0, witness = null;
    for (let i = 0; i < count; i += 3) {
      const triangle = [0, 1, 2].map(k => points[index ? index.getX(i + k) : i + k]);
      const clearance = Math.min(...envelopes.map(capsule => Math.max(...triangle.map(point => signedDistance(point, capsule)))));
      if (clearance > maximum) { maximum = clearance; witness = triangle.map(p => p.toArray()); }
      if (clearance > 1e-5) failed++;
    }
    meshes.push({ name: object.name, parent: object.parent.name, triangles: count / 3, maximum_single_capsule_signed_distance_mm: maximum, escaping_triangles: failed, worst_triangle: witness });
  });
  records.push({ ...pose, envelopes, triangles: meshes.reduce((sum, m) => sum + m.triangles, 0), escaping_triangles: meshes.reduce((sum, m) => sum + m.escaping_triangles, 0), meshes });
  instrument.dispose();
}
const point = new THREE.Vector3(8, 0, 17);
const openHingeClearance = Math.min(...instrumentContactEnvelopes("grasp", 6, 0).map(e => signedDistance(point, e)));
const report = {
  source_sha256: hashes,
  scope: "For each actual planar working-mesh triangle, all three transformed vertices must lie inside the SAME convex runtime capsule, proving containment of its full face at the sampled pose. Handles and the separately guarded probe ball are excluded by explicit component names. Full proximal transition through z245 is included. Five jaw closures and three supported UI probe radii are sampled. This does not establish continuous jaw-articulation collision detection or biological mechanics.",
  tolerance_mm: 1e-5, included_mesh_names: [...workingMeshNames],
  open_hinge_empty_space: { point_mm: point.toArray(), runtime_clearance_mm: openHingeClearance, historical_uniform_jaw_clearance_mm: 8 - 11.2 },
  poses: records.length, total_triangle_pose_checks: records.reduce((sum, r) => sum + r.triangles, 0),
  escaping_triangles: records.reduce((sum, r) => sum + r.escaping_triangles, 0), records,
};
const output = path.join(root, "benchmarks/results/whole-scene-tools-2026-10-08/instrument-envelope-triangles.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ output, poses: report.poses, triangle_pose_checks: report.total_triangle_pose_checks, escaping_triangles: report.escaping_triangles, open_hinge_clearance_mm: openHingeClearance, poses_summary: records.map(r => ({ mode: r.mode, radius: r.radius, closure: r.closure, triangles: r.triangles, escaping_triangles: r.escaping_triangles })) }, null, 2));
if (report.escaping_triangles || openHingeClearance <= 2) process.exitCode = 1;
