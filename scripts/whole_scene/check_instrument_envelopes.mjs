/** Read-only audit of the shipped instrument meshes; no runtime source mutation. */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as THREE from "three";
import { transformWithEsbuild } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const file = path.join(root, "apps/studio/src/laparoscopicInstruments.ts");
const source = await readFile(file, "utf8");
const transformed = await transformWithEsbuild(source, "laparoscopicInstruments.ts", { loader: "ts", target: "es2022" });
const code = transformed.code.replace('from "three"', `from ${JSON.stringify(import.meta.resolve("three"))}`);
const { createLaparoscopicInstrument } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const v = p => new THREE.Vector3(...p);
const capsule = (start, end, radius, name) => ({ start: v(start), end: v(end), radius, name });
const clearance = (point, shape) => point.distanceTo(new THREE.Line3(shape.start, shape.end).closestPointToPoint(point, true, new THREE.Vector3())) - shape.radius;
const unionClearance = (point, shapes) => Math.min(...shapes.map(shape => clearance(point, shape)));
const workingMeshNames = new Set([
  "five-mm-steel-shaft", "insulated-shaft-sleeve", "sleeve-edge-band", "machined-shaft-mark",
  "proximal-shaft-transition", "distal-clevis-tube", "jaw-actuator-rod", "clevis-side-arm",
  "hinge-rivet", "hinge-rivet-slot", "fenestrated-atraumatic-jaw", "fine-grip-serration",
]);
const records = [];
for (const closure of [0, .25, .5, .75, 1]) {
  const instrument = createLaparoscopicInstrument("grasper");
  instrument.setJawClosure(closure); instrument.group.updateMatrixWorld(true);
  const old = [capsule([0, 0, 0], [0, 0, 19], 3.2 + 8 * (1 - closure), "uniform-jaw"), capsule([0, 0, 19], [0, 0, 240], 2.6, "shaft")];
  const proposed = [capsule([0, 0, 17], [0, 0, 33], 3.2, "clevis"), capsule([0, 0, 30], [0, 0, 240], 2.6, "shaft")];
  for (const side of [-1, 1]) {
    const pivot = instrument.group.getObjectByName(side > 0 ? "right-articulated-jaw" : "left-articulated-jaw");
    proposed.push({ start: v([side * .56, 0, -18.5]).applyMatrix4(pivot.matrixWorld), end: v([side * .56, 0, .7]).applyMatrix4(pivot.matrixWorld), radius: 3.2, name: `jaw-${side}` });
  }
  const perMesh = [];
  instrument.group.traverse(object => {
    if (!object.isMesh || !workingMeshNames.has(object.name)) return;
    const positions = object.geometry.getAttribute("position");
    const points = Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(object.matrixWorld));
    let tests = points.filter(p => p.z <= 240);
    if (!tests.length) return; // Proximal handle excluded, working region z <= 240.
    // Include edge intersections with the working-region cut plane. A tapered
    // transition can cross the plane even when its wider end lies outside it.
    const index = object.geometry.index;
    const ids = index ? Array.from(index.array) : Array.from({ length: points.length }, (_, i) => i);
    for (let i = 0; i < ids.length; i += 3) for (let edge = 0; edge < 3; edge++) {
      const a = points[ids[i + edge]], b = points[ids[i + (edge + 1) % 3]];
      if ((a.z < 240 && b.z > 240) || (a.z > 240 && b.z < 240)) tests.push(a.clone().lerp(b, (240 - a.z) / (b.z - a.z)));
    }
    let oldMax = -Infinity, proposedMax = -Infinity, oldPoint, proposedPoint;
    let oldOutside = 0, proposedOutside = 0;
    for (const p of tests) {
      const oldC = unionClearance(p, old), newC = unionClearance(p, proposed);
      if (oldC > oldMax) { oldMax = oldC; oldPoint = p.toArray(); }
      if (newC > proposedMax) { proposedMax = newC; proposedPoint = p.toArray(); }
      if (oldC > 1e-6) oldOutside++;
      if (newC > 1e-6) proposedOutside++;
    }
    perMesh.push({ name: object.name, parent: object.parent.name, samples: tests.length, old_max_outside_mm: oldMax, proposed_max_outside_mm: proposedMax, old_outside_count: oldOutside, proposed_outside_count: proposedOutside, old_worst_point: oldPoint, proposed_worst_point: proposedPoint });
  });
  records.push({ closure, uniform_jaw_radius_mm: old[0].radius, proposed_capsules: proposed.map(p => ({ name: p.name, start: p.start.toArray(), end: p.end.toArray(), radius: p.radius })), centreline_void_samples: [0, 5, 10].map(z => ({ point: [0, 0, z], old_clearance_mm: unionClearance(v([0, 0, z]), old), proposed_clearance_mm: unionClearance(v([0, 0, z]), proposed) })), meshes: perMesh });
  instrument.dispose();
}
const report = {
  source_sha256: createHash("sha256").update(source).digest("hex"),
  scope: "Actual shipped grasper working-mesh vertices plus triangle-edge intersections with z=240mm. Named handle components are excluded even when articulation brings a handle vertex below z240. Positive clearance means outside proxy; negative means contained. Distal jaw capsules follow actual model pivot transforms. This is a sampled vertex containment audit, not continuous articulation CCD or full triangle union containment proof.",
  included_mesh_names: [...workingMeshNames],
  current: "Uniform z0..19 jaw capsule r=3.2+8*(1-closure), shaft z19..240 r2.6.",
  proposed: "Two articulated capsules at plate-local x=side*.56, z=-18.5...7, radius3.2; clevis z17..33 radius3.2; shaft z30..240 radius2.6.",
  records,
};
const output = path.join(root, "benchmarks/results/whole-scene-tools-2026-10-08/instrument-envelope-audit.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
for (const record of records) {
  console.log(JSON.stringify({ closure: record.closure, outside: record.meshes.filter(m => m.old_max_outside_mm > 1e-6 || m.proposed_max_outside_mm > 1e-6).map(m => ({ name: m.name, old: m.old_max_outside_mm, proposed: m.proposed_max_outside_mm })), proposedJawMax: Math.max(...record.meshes.filter(m => m.parent.includes("articulated-jaw")).map(m => m.proposed_max_outside_mm)) }));
}
console.log(output);
