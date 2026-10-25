import { VIRTAMED_AUTHORED_PHYSICS_JOINTS } from "./virtaMedPhysicsJoints";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as THREE from "three";
import { createVirtaMedScene, VIRTAMED_ORGANS, VIRTAMED_VERSION } from "./virtaMedScene";
import { buildVirtaMedInterfaces, type InterfaceGraph } from "./virtaMedInterfaces";
import { WholeScenePhysics, readLearnedSceneMaterials, type ScenePhysicsBinding } from "./wholeScenePhysics";
import { VIRTAMED_TISSUE_RESPONSE } from "./sceneTissueResponse";
import materialsJson from "../public/anatomy-scene/virtamed-materials.json";

interface Surface {
  id: string; mesh: THREE.Mesh; rest: Float32Array; index: Uint16Array | Uint32Array;
  crosses: Float64Array; squaredAreas: Float64Array; reliableTriangles: number; degenerateTriangles: number;
}
interface FrameResult {
  phase: "hold" | "release"; timeS: number; minimumAreaRatio: number; minimumSignedAreaRatio: number;
  minimumNormalCosine: number; maximumAreaRatio: number; maximumRootGapMm: number; maximumStepMm: number;
  forceN: number; energyJ: number; gradientBound: number;
  worstOrientation: { organ: string; face: number; sourceDoubleAreaMm2: number; maximumEdgeMm: number; sourceVertices: number[][]; deformedVertices: number[][] } | null;
}
const cases: { organ: string; mode: "push" | "grasp"; requestedMotionMm: number; frames: FrameResult[] }[] = [];
let root: THREE.Group, graph: InterfaceGraph, surfaces: Surface[];
let joins: { a: number; b: number; ai: number[]; bi: number[] }[];
const cross = (p: Float32Array, ia: number, ib: number, ic: number): [number, number, number] => {
  const ax = p[ib * 3]! - p[ia * 3]!, ay = p[ib * 3 + 1]! - p[ia * 3 + 1]!, az = p[ib * 3 + 2]! - p[ia * 3 + 2]!;
  const bx = p[ic * 3]! - p[ia * 3]!, by = p[ic * 3 + 1]! - p[ia * 3 + 1]!, bz = p[ic * 3 + 2]! - p[ia * 3 + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
};
beforeAll(() => {
  root = createVirtaMedScene().root;
  graph = buildVirtaMedInterfaces((root.children as THREE.Mesh[]).map(mesh => ({ id: mesh.name, geometry: mesh.geometry, attachments: mesh.userData.attachments, coverRange: mesh.userData.coverRange })));
  surfaces = (root.children as THREE.Mesh[]).map(mesh => {
    const rest = mesh.geometry.getAttribute("position").array as Float32Array, index = mesh.geometry.index!.array as Uint16Array | Uint32Array;
    const crosses = new Float64Array(index.length), squaredAreas = new Float64Array(index.length / 3);
    let reliableTriangles = 0, degenerateTriangles = 0;
    for (let f = 0; f < index.length; f += 3) {
      const value = cross(rest, index[f]!, index[f + 1]!, index[f + 2]!); crosses.set(value, f);
      const area = value.reduce((sum, x) => sum + x * x, 0); squaredAreas[f / 3] = area;
      // Pole/UV duplicates are already collapsed in source lofts. Below this
      // absolute double-area threshold, a Float32 normal ratio is not reliable.
      if (area > 1e-12) reliableTriangles++; else degenerateTriangles++;
    }
    return { id: mesh.name, mesh, rest, index, crosses, squaredAreas, reliableTriangles, degenerateTriangles };
  });
  joins = graph.edges.flatMap(edge => edge.roots.map(point => {
    const key = Array.from(new Float32Array(point)).join(",");
    return { a: surfaces.findIndex(surface => surface.id === edge.a), b: surfaces.findIndex(surface => surface.id === edge.b), ai: graph.roots.get(edge.a)!.get(key)!, bi: graph.roots.get(edge.b)!.get(key)! };
  }));
}, 60_000);
afterAll(() => {
  const output = process.env.VIRTAMED_CONTACT_STRESS_OUTPUT;
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, JSON.stringify({
      schema: "viscera.actual-mesh-contact-stress/1", scene: VIRTAMED_VERSION,
      scope: "Baseline authored geometry, twelve organs, 20 mm push and oblique representative grasp; numerical surface consistency, not clinical validation or organ-organ collision certification.",
      sourceDoubleAreaThresholdMm2: 1e-6,
      surfaces: surfaces.map(surface => ({ id: surface.id, vertices: surface.rest.length / 3, reliableTriangles: surface.reliableTriangles, preexistingDegenerateTriangles: surface.degenerateTriangles })),
      registeredRoots: joins.length, cases,
    }, null, 2));
  }
  root?.traverse(object => { if (object instanceof THREE.Mesh) { object.geometry.dispose(); object.material.dispose(); } });
});

function inspect(solver: WholeScenePhysics, bindings: ScenePhysicsBinding[], displayed: Float32Array[], previous: Float32Array[] | null, phase: FrameResult["phase"]): FrameResult {
  let worstOrientation: FrameResult["worstOrientation"] = null;
  let minimumAreaRatio = Infinity, minimumSignedAreaRatio = Infinity, minimumNormalCosine = Infinity, maximumAreaRatio = 0, maximumRootGapMm = 0, maximumStepMm = 0;
  for (let s = 0; s < surfaces.length; s++) {
    const surface = surfaces[s]!, out = displayed[s]!;
    solver.deform(surface.rest, out, bindings[s]!);
    expect(out.every(Number.isFinite), `${phase}: nonfinite ${surface.id}`).toBe(true);
    if (previous) for (let v = 0; v < out.length; v += 3) maximumStepMm = Math.max(maximumStepMm, Math.hypot(out[v]! - previous[s]![v]!, out[v + 1]! - previous[s]![v + 1]!, out[v + 2]! - previous[s]![v + 2]!));
    for (let f = 0; f < surface.index.length; f += 3) {
      const squaredRest = surface.squaredAreas[f / 3]!; if (squaredRest <= 1e-12) continue;
      const value = cross(out, surface.index[f]!, surface.index[f + 1]!, surface.index[f + 2]!);
      const squared = value.reduce((sum, x) => sum + x * x, 0), dot = value.reduce((sum, x, axis) => sum + x * surface.crosses[f + axis]!, 0);
      minimumAreaRatio = Math.min(minimumAreaRatio, Math.sqrt(squared / squaredRest)); maximumAreaRatio = Math.max(maximumAreaRatio, Math.sqrt(squared / squaredRest));
      minimumSignedAreaRatio = Math.min(minimumSignedAreaRatio, dot / squaredRest);
      const cosine = dot / Math.max(1e-30, Math.sqrt(squared * squaredRest));
      if (cosine < minimumNormalCosine) {
        minimumNormalCosine = cosine;
        const ids = [surface.index[f]!, surface.index[f + 1]!, surface.index[f + 2]!];
        const sourceVertices = ids.map(id => Array.from(surface.rest.slice(id * 3, id * 3 + 3)));
        const deformedVertices = ids.map(id => Array.from(out.slice(id * 3, id * 3 + 3)));
        worstOrientation = { organ: surface.id, face: f / 3, sourceDoubleAreaMm2: Math.sqrt(squaredRest), maximumEdgeMm: Math.max(...[0, 1, 2].map(i => Math.hypot(...sourceVertices[i]!.map((value, axis) => value - sourceVertices[(i + 1) % 3]![axis]!)))), sourceVertices, deformedVertices };
      }
    }
  }
  for (const join of joins) {
    const a = displayed[join.a]!, b = displayed[join.b]!;
    for (const ai of join.ai) for (const bi of join.bi) maximumRootGapMm = Math.max(maximumRootGapMm, Math.hypot(a[3 * ai]! - b[3 * bi]!, a[3 * ai + 1]! - b[3 * bi + 1]!, a[3 * ai + 2]! - b[3 * bi + 2]!));
  }
  const snapshot = solver.snapshot();
  return { phase, timeS: snapshot.time_s, minimumAreaRatio, minimumSignedAreaRatio, minimumNormalCosine, maximumAreaRatio, maximumRootGapMm, maximumStepMm,
    worstOrientation, forceN: Math.hypot(...snapshot.tool!.forceN), energyJ: snapshot.stored_energy_j, gradientBound: snapshot.displacement_gradient_bound };
}

describe("actual VirtaMed mesh under supported contact extremes", () => {
  for (const organ of VIRTAMED_ORGANS) for (const mode of ["push", "grasp"] as const) {
    it(`${organ.id}: ${mode} retains finite surface triangles and exact attachment roots through hold and release`, () => {
      const solver = new WholeScenePhysics(surfaces.map(surface => ({ id: surface.id, category: VIRTAMED_ORGANS.find(item => item.id === surface.id)!.category,
        bounds: { min: surface.mesh.geometry.boundingBox!.min.toArray(), max: surface.mesh.geometry.boundingBox!.max.toArray() } })), readLearnedSceneMaterials(materialsJson), VIRTAMED_TISSUE_RESPONSE, [...graph.edges, ...VIRTAMED_AUTHORED_PHYSICS_JOINTS]);
      const bindings = surfaces.map(surface => solver.bind(surface.rest, surface.id)), displayed = surfaces.map(surface => new Float32Array(surface.rest.length));
      const surface = surfaces.find(candidate => candidate.id === organ.id)!;
      // Choose an actual anterior surface patch with enough area for a stable
      // triangle normal, retaining all anatomy for the deformation assessment.
      let selected = -1, anterior = -Infinity;
      for (let f = 0; f < surface.index.length; f += 3) {
        if (surface.squaredAreas[f / 3]! < .01) continue;
        const z = (surface.rest[surface.index[f]! * 3 + 2]! + surface.rest[surface.index[f + 1]! * 3 + 2]! + surface.rest[surface.index[f + 2]! * 3 + 2]!) / 3;
        if (z > anterior) { anterior = z; selected = f; }
      }
      expect(selected).toBeGreaterThanOrEqual(0);
      const vertices = [0, 1, 2].map(k => Array.from(surface.rest.slice(surface.index[selected + k]! * 3, surface.index[selected + k]! * 3 + 3))) as [number[], number[], number[]];
      const normal = new THREE.Vector3(...cross(surface.rest, surface.index[selected]!, surface.index[selected + 1]!, surface.index[selected + 2]!)).normalize();
      const anchor = vertices.reduce((point, vertex) => point.addScaledVector(new THREE.Vector3().fromArray(vertex), 1 / 3), new THREE.Vector3());
      const tangent = new THREE.Vector3(1, 0, 0).addScaledVector(normal, -normal.x); if (tangent.lengthSq() < .01) tangent.set(0, 1, 0).addScaledVector(normal, -normal.y); tangent.normalize();
      const delta = mode === "push" ? normal.clone().multiplyScalar(-20) : normal.clone().multiplyScalar(10).addScaledVector(tangent, 6);
      solver.beginToolContact({ mode, organId: organ.id, restPointMm: anchor.toArray(), normal: normal.toArray(), targetPointMm: anchor.clone().add(delta).toArray(), radiusMm: mode === "push" ? 6 : 3,
        attachment: { verticesMm: vertices, barycentric: [1 / 3, 1 / 3, 1 / 3] } });
      const record = { organ: organ.id, mode, requestedMotionMm: delta.length(), frames: [] as FrameResult[] }; cases.push(record);
      let previous: Float32Array[] | null = null;
      const capture = (phase: FrameResult["phase"]) => {
        const frame = inspect(solver, bindings, displayed, previous, phase); record.frames.push(frame);
        expect(frame.maximumRootGapMm, `${organ.id}/${mode}: registered join separated`).toBe(0);

        expect(frame.forceN).toBeLessThanOrEqual(3.000001); expect(frame.gradientBound).toBeLessThanOrEqual(.4500001);
        previous = displayed.map(out => out.slice());
      };
      capture("hold");
      const holdCaptures = new Set([1, 6, 12, 30, 60, 96]);
      for (let step = 1; step <= 96; step++) { solver.step(1 / 120, false); if (holdCaptures.has(step)) capture("hold"); }
      expect(Math.hypot(...solver.toolSnapshot()!.displacementMm)).toBeGreaterThan(.1);
      solver.releaseToolContact(); capture("release");
      expect(record.frames.at(-1)!.maximumStepMm, "Release itself must not alter a displayed vertex").toBe(0);
      const releaseCaptures = new Set([1, 6, 12, 30, 60, 120, 240, 480]);
      for (let step = 1; step <= 480; step++) { solver.step(1 / 120, false); if (releaseCaptures.has(step)) capture("release"); }
      expect(record.frames.at(-1)!.forceN).toBe(0);
      // Recovery rate is material/history dependent. Require dissipation,
      // rather than imposing one arbitrary settling time on every material.
      const recovery = record.frames.filter(frame => frame.phase === "release");
      for (let i = 1; i < recovery.length; i++) expect(recovery[i]!.energyJ).toBeLessThanOrEqual(recovery[i - 1]!.energyJ + 1e-12);
      expect(record.frames.at(-1)!.energyJ).toBeLessThan(record.frames[6]!.energyJ * .02);
      for (const frame of record.frames) {
        expect(frame.minimumNormalCosine, `${organ.id}/${mode} t=${frame.timeS}: ${JSON.stringify(frame.worstOrientation)}`).toBeGreaterThan(0);
        expect(frame.minimumAreaRatio, `${organ.id}/${mode}: a sampled triangle collapsed`).toBeGreaterThan(.01);
        expect(frame.minimumSignedAreaRatio).toBeGreaterThan(0);
      }
    }, 60_000);
  }
});
