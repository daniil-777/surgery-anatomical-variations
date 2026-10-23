import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { SceneSurfaceContact } from "../wholeSceneContact";
import { createOmentalDepotField } from "./depotFields";
import { createFatLayers, FAT_LAYER_CLEARANCE_TARGET_MM, FAT_LAYER_LIMITATIONS, FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM, type FatLayerPart, type FatLayerResult } from "./sceneLayers";

// Geometry/contact work is intentionally synchronous inside each assertion.
// Yield between cases so Vitest can flush RPC reports and its worker heartbeat;
// this does not relax any geometry assertion or test timeout.
afterEach(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)); });

function box(id: string, dimensions: [number, number, number], center: [number, number, number]): FatLayerPart {
  return { id, geometry: new THREE.BoxGeometry(...dimensions).translate(...center) };
}
function kidney(id: string, x: number): FatLayerPart {
  return { id, geometry: new THREE.SphereGeometry(1, 32, 24).scale(20, 35, 15).translate(x, -10, -45) };
}
function fixture(): FatLayerPart[] {
  return [box("stomach", [80, 30, 40], [0, 45, -5]), box("small-intestine", [120, 160, 40], [0, -60, 0]), kidney("left-kidney", 80), kidney("right-kidney", -80)];
}
function dispose(parts: readonly FatLayerPart[], results: readonly FatLayerResult[]): void {
  for (const part of parts) part.geometry.dispose();
  for (const result of results) for (const layer of result.geometries) layer.geometry.dispose();
}
function asContact(part: FatLayerPart): SceneSurfaceContact {
  return new SceneSurfaceContact(part.id, Float32Array.from(part.geometry.getAttribute("position").array), Uint32Array.from(part.geometry.getIndex()!.array));
}
function allArray(result: FatLayerResult): number[] {
  return result.geometries.flatMap(layer => Array.from(layer.geometry.getAttribute("position").array));
}

function sourceSignature(parts: readonly FatLayerPart[]): string {
  const hash = createHash("sha256");
  for (const part of parts) for (const attribute of [part.geometry.getAttribute("position"), part.geometry.getIndex()]) {
    if (attribute) hash.update(new Uint8Array(attribute.array.buffer, attribute.array.byteOffset, attribute.array.byteLength));
  }
  return hash.digest("hex");
}

async function loadAtlas(): Promise<FatLayerPart[]> {
  const bytes = readFileSync(new URL("../../public/anatomy-scene/bodyparts3d-torso.glb", import.meta.url));
  const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, "");
  gltf.scene.updateMatrixWorld(true);
  const parts: FatLayerPart[] = [];
  gltf.scene.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    parts.push({ id: object.userData.id ?? object.name, geometry: object.geometry.clone().applyMatrix4(object.matrixWorld) });
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
  });
  return parts;
}

function topology(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position"), index = geometry.getIndex()!, edges = new Map<string, number>();
  const parent = Array.from({ length: position.count }, (_, i) => i);
  const root = (id: number): number => { while (parent[id] !== id) { parent[id] = parent[parent[id]!]!; id = parent[id]!; } return id; };
  let minimumTriangleAreaMm2 = Infinity;
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)] as [number, number, number];
    parent[root(ids[1])] = root(ids[0]); parent[root(ids[2])] = root(ids[0]);
    const points = ids.map(id => new THREE.Vector3(position.getX(id), position.getY(id), position.getZ(id)));
    minimumTriangleAreaMm2 = Math.min(minimumTriangleAreaMm2, points[1]!.sub(points[0]!).cross(points[2]!.sub(points[0]!)).length() * 0.5);
    for (const [a, b] of [[ids[0], ids[1]], [ids[1], ids[2]], [ids[2], ids[0]]]) {
      const key = a! < b! ? `${a}:${b}` : `${b}:${a}`; edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const sizes = new Map<number, number>();
  for (let i = 0; i < index.count; i += 3) { const id = root(index.getX(i)); sizes.set(id, (sizes.get(id) ?? 0) + 1); }
  return { components: [...sizes.values()].sort((a, b) => b - a), boundaryEdges: [...edges.values()].filter(value => value === 1).length,
    nonmanifoldEdges: [...edges.values()].filter(value => value > 2).length, minimumTriangleAreaMm2 };
}

/** Independent probes evaluate the returned Float32 geometry, including points
 * outside the construction stencil. Passing these does not certify all points. */
function probeClearance(geometry: THREE.BufferGeometry, obstacles: { bounds: THREE.Box3; contact: SceneSurfaceContact }[]) {
  const position = geometry.getAttribute("position"), index = geometry.getIndex()!;
  let checks = 0, belowThreshold = 0, nearIntersections = 0, minimumMm = Infinity;
  const violationOrgans: Record<string, number> = {};
  for (let i = 0; i < index.count; i += 3) {
    const ids = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    for (const weights of [[1, 0, 0], [.5, .5, 0], [.2, .2, .6], [.2, .6, .2], [.6, .2, .2]]) {
      const point = [0, 1, 2].map(axis => ids.reduce((sum, id, corner) => sum + position.array[id * 3 + axis]! * weights[corner]!, 0));
      let distance = 0.8, nearestId = "";
      for (const obstacle of obstacles) {
        const p = new THREE.Vector3(...point);
        if (obstacle.bounds.distanceToPoint(p) > distance) continue;
        const hit = obstacle.contact.closestPoint(point, distance);
        if (hit) { distance = hit.distanceMm; nearestId = hit.organId; }
      }
      minimumMm = Math.min(minimumMm, distance); checks++;
      if (distance < FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM - 1e-4) { belowThreshold++; violationOrgans[nearestId] = (violationOrgans[nearestId] ?? 0) + 1; }
      if (distance < 0.05) nearIntersections++;
    }
  }
  return { checks, belowThreshold, nearIntersections, minimumMm, violationOrgans };
}

it.skipIf(process.env.FAT_LAYER_AUDIT !== "1")("audits actual atlas seed/thickness extremes independently", async () => {
  const parts = await loadAtlas();
  const before = sourceSignature(parts);
  const obstacles = parts.map(part => { part.geometry.computeBoundingBox(); return { bounds: part.geometry.boundingBox!, contact: asContact(part) }; });
  const cases = [];
  const seeds = process.env.FAT_LAYER_AUDIT_SEEDS?.split(",").map(Number) ?? [1, 42, 2026, 4294967295];
  const thicknesses = process.env.FAT_LAYER_AUDIT_THICKNESSES?.split(",").map(Number) ?? [0.25, 5, 30];
  for (const seed of seeds) for (const thicknessMm of thicknesses) {
    const started = performance.now(), result = createFatLayers(parts, { seed, thicknessMm });
    const layers = result.geometries.map(layer => ({ id: layer.id, ...topology(layer.geometry), clearance: probeClearance(layer.geometry, obstacles), marginRefinement: layer.geometry.userData.marginRefinement ?? null }));
    cases.push({ seed, thicknessMm, elapsedMs: performance.now() - started, diagnostics: result.diagnostics, layers });
    dispose([], [result]);
    // A multi-case CPU audit must yield so Vitest's RPC heartbeat can run.
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  const directory = new URL(process.env.FAT_LAYER_AUDIT_DIRECTORY ?? "../../../../artifacts/fat-quality-2026-10-19/", import.meta.url);
  mkdirSync(directory, { recursive: true });
  writeFileSync(new URL(`${process.env.FAT_LAYER_AUDIT_NAME ?? "scene-layer-audit"}.json`, directory), JSON.stringify({ cases }, null, 2));
  expect(cases).toHaveLength(seeds.length * thicknesses.length);
  expect(sourceSignature(parts)).toBe(before);
  for (const result of cases) {
    expect(result.layers).toHaveLength(3);
    expect(result.diagnostics.finite).toBe(true);
    for (const layer of result.layers) {
      expect(layer.components).toHaveLength(1);
      expect(layer.boundaryEdges).toBe(0);
      expect(layer.nonmanifoldEdges).toBe(0);
      expect(layer.clearance.belowThreshold).toBe(0);
      expect(layer.clearance.nearIntersections).toBe(0);
    }
  }
  dispose(parts, []);
}, 180_000);

describe("anatomy-aware procedural fat layers", { timeout: 30_000 }, () => {
  it("builds all three depots on the actual registered studio atlas", async () => {
    const parts = await loadAtlas();
    const result = createFatLayers(parts, { seed: 231, thicknessMm: 6 });
    expect(result.geometries.map(layer => layer.id)).toEqual(["fat-omentum", "fat-left-kidney-perirenal", "fat-right-kidney-perirenal"]);
    expect(result.diagnostics.finite).toBe(true);
    expect(result.diagnostics.minimumSampledClearanceMm).toBeGreaterThanOrEqual(FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM);
    expect(result.diagnostics.targetClearanceMm).toBe(FAT_LAYER_CLEARANCE_TARGET_MM);
    expect(result.diagnostics.minimumAcceptedClearanceMm).toBe(FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM);
    expect(result.diagnostics.vertices).toBeGreaterThan(5000);
    const stomach = parts.find(part => part.id === "stomach")!.geometry;
    stomach.computeBoundingBox();
    expect(result.geometries[0]!.geometry.boundingBox!.max.y).toBeLessThan(stomach.boundingBox!.min.y);
    dispose(parts, [result]);
  }, 30_000);

  it("keeps atlas renal pads closed and clear of ribs at the maximum thickness", async () => {
    const parts = await loadAtlas(), before = sourceSignature(parts);
    const obstacles = parts.map(part => { part.geometry.computeBoundingBox(); return { bounds: part.geometry.boundingBox!, contact: asContact(part) }; });
    const result = createFatLayers(parts, { seed: 1, thicknessMm: 30 });
    expect(result.diagnostics.sourceOrganIds).toContain("rib-cage");
    expect(result.geometries).toHaveLength(3);
    for (const layer of result.geometries) {
      const mesh = topology(layer.geometry), clearance = probeClearance(layer.geometry, obstacles);
      expect(mesh.components).toHaveLength(1);
      expect(mesh.boundaryEdges).toBe(0);
      expect(mesh.nonmanifoldEdges).toBe(0);
      expect(clearance.belowThreshold).toBe(0);
      expect(clearance.nearIntersections).toBe(0);
    }
    expect(sourceSignature(parts)).toBe(before);
    dispose(parts, [result]);
  }, 30_000);

  it("generates an anterior bowel apron and two partial perirenal depots", () => {
    const parts = fixture(), result = createFatLayers(parts, { seed: 81, thicknessMm: 6 });
    expect(result.geometries.map(layer => layer.id)).toEqual(["fat-omentum", "fat-left-kidney-perirenal", "fat-right-kidney-perirenal"]);
    expect(result.diagnostics.generatedLayers).toBe(3);
    expect(result.diagnostics.finite).toBe(true);
    expect(result.diagnostics.vertices).toBeGreaterThan(5000);
    expect(result.diagnostics.checkedSamples).toBeGreaterThan(10_000);
    expect(result.diagnostics.minimumSampledClearanceMm).toBeGreaterThanOrEqual(FAT_LAYER_MIN_SAMPLED_CLEARANCE_MM);
    expect(result.diagnostics.missingOrganIds).toEqual([]);
    const apron = result.geometries[0]!.geometry;
    expect(apron.boundingBox!.max.y).toBeLessThan(30); // Under stomach.
    expect(apron.boundingBox!.min.z).toBeGreaterThan(20.6); // Anterior bowel surface.
    expect(apron.boundingBox!.min.y).toBeGreaterThan(-140); // Above bowel lower limit.
    dispose(parts, [result]);
  });

  it("returns indexed finite meshes with independent rest coordinates and normals", () => {
    const parts = fixture(), result = createFatLayers(parts, { seed: 17, thicknessMm: 4 });
    for (const { geometry } of result.geometries) {
      const position = geometry.getAttribute("position"), rest = geometry.getAttribute("fatRestPosition"), normal = geometry.getAttribute("normal");
      expect(Array.from(rest.array)).toEqual(Array.from(position.array));
      expect(rest.array).not.toBe(position.array);
      expect(normal.count).toBe(position.count);
      expect(geometry.getIndex()!.count % 3).toBe(0);
      expect(Array.from(geometry.getIndex()!.array).every(index => index >= 0 && index < position.count)).toBe(true);
      expect(Array.from(normal.array).every(Number.isFinite)).toBe(true);
      for (let i = 0; i < normal.count; i++) expect(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i))).toBeCloseTo(1, 5);
      const thickness = geometry.getAttribute("fatThicknessMm"), gap = geometry.getAttribute("fatColumnThicknessMm"), region = geometry.getAttribute("fatRegion");
      const depotUv = geometry.getAttribute("fatDepotUv");
      expect(thickness.count).toBe(position.count); expect(gap.count).toBe(position.count); expect(region.count).toBe(position.count);
      expect(depotUv.count).toBe(position.count);
      for (let i = 0; i < position.count; i++) {
        expect(thickness.getX(i)).toBeGreaterThan(0);
        expect(thickness.getX(i)).toBeLessThanOrEqual(gap.getX(i) + 1e-5);
        expect(gap.getX(i)).toBeLessThanOrEqual(4.00001);
        expect(region.getX(i) + region.getZ(i)).toBeCloseTo(1, 6);
        for (const value of [region.getX(i), region.getY(i), region.getZ(i)]) { expect(value).toBeGreaterThanOrEqual(0); expect(value).toBeLessThanOrEqual(1); }
        expect(depotUv.getX(i)).toBeGreaterThanOrEqual(0); expect(depotUv.getX(i)).toBeLessThanOrEqual(1);
        expect(depotUv.getY(i)).toBeGreaterThanOrEqual(0); expect(depotUv.getY(i)).toBeLessThanOrEqual(1);
      }
    }
    dispose(parts, [result]);
  });

  it("uses local measured membrane thickness and co-locates omental vessel paths with fatty sleeves", () => {
    const parts = fixture(), result = createFatLayers(parts, { seed: 42, thicknessMm: 6 });
    const geometry = result.geometries.find(layer => layer.id === "fat-omentum")!.geometry;
    const position = geometry.getAttribute("position"), thickness = geometry.getAttribute("fatThicknessMm"), gap = geometry.getAttribute("fatColumnThicknessMm"), regions = geometry.getAttribute("fatRegion");
    const thin: number[] = [], thick: number[] = [];
    // The bowel fixture is a flat surface, so the paired projection must match
    // its physical Z gap away from local taper/sleeve gradients.
    const columns = new Map<string, { z: number[]; gap: number[]; thickness: number[] }>();
    for (let i = 0; i < position.count; i++) {
      const key = `${position.getX(i)}:${position.getY(i)}`;
      const column = columns.get(key) ?? { z: [], gap: [], thickness: [] };
      column.z.push(position.getZ(i)); column.gap.push(gap.getX(i)); column.thickness.push(thickness.getX(i)); columns.set(key, column);
      if (regions.getX(i) < .2) thin.push(gap.getX(i));
      if (regions.getY(i) > .8) thick.push(gap.getX(i));
    }
    for (const column of columns.values()) {
      const measured = Math.max(...column.z) - Math.min(...column.z);
      for (const value of column.gap) expect(value).toBeCloseTo(measured, 4);
      expect(Math.max(...column.thickness) - Math.min(...column.thickness)).toBeLessThan(1e-6);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(thin.length).toBeGreaterThan(100); expect(thick.length).toBeGreaterThan(100);
    expect(mean(thick)).toBeGreaterThan(mean(thin) * 2);
    expect(geometry.userData.generator).toBe("viscera-anatomical-fat-v5");
    const descriptor = geometry.userData.depotField;
    expect(descriptor.kind).toBe("omental");
    const field = createOmentalDepotField(descriptor.seed, descriptor.widthMm, descriptor.heightMm);
    const uv = geometry.getAttribute("fatDepotUv");
    // UVs must preserve the exact original field after compaction, paired
    // extrusion and any boundary fan splits. World XY alone cannot recover it.
    for (let i = 0; i < uv.count; i++) {
      const sample = field.sample(uv.getX(i), uv.getY(i));
      expect(regions.getX(i)).toBeCloseTo(sample.lipidCoverage, 6);
      expect(regions.getY(i)).toBeCloseTo(sample.vesselMask, 6);
    }
    for (const layer of result.geometries.filter(layer => layer.id.includes("kidney"))) {
      const renal = layer.geometry.getAttribute("fatRegion");
      for (let i = 0; i < renal.count; i++) expect(renal.getY(i)).toBe(0);
    }
    dispose(parts, [result]);
  });

  it("is deterministic by seed, varies geometry and never mutates source buffers", () => {
    const parts = fixture(), before = parts.map(part => Array.from(part.geometry.getAttribute("position").array));
    const a = createFatLayers(parts, { seed: 7, thicknessMm: 5 });
    const b = createFatLayers(parts, { seed: 7, thicknessMm: 5 });
    const c = createFatLayers(parts, { seed: 8, thicknessMm: 5 });
    expect(allArray(a)).toEqual(allArray(b));
    expect(allArray(a)).not.toEqual(allArray(c));
    expect(parts.map(part => Array.from(part.geometry.getAttribute("position").array))).toEqual(before);
    dispose(parts, [a, b, c]);
  });

  it("preserves broad medial hilar openings instead of encapsulating renal vessels", () => {
    const parts = fixture(), result = createFatLayers(parts, { seed: 3, thicknessMm: 8 });
    for (const [id, side] of [["fat-left-kidney-perirenal", 1], ["fat-right-kidney-perirenal", -1]] as const) {
      const layer = result.geometries.find(item => item.id === id)!, contact = asContact(layer);
      expect(contact.raycast([side * 80, -10, -45], [-side, 0, 0])).toBeNull();
      expect(contact.raycast([side * 80, -10, -45], [side, 0, 0])).not.toBeNull();
      const lateral = contact.raycast([side * 80, -10, -45], [side, 0, 0])!;
      expect(lateral.distanceMm).toBeGreaterThan(21);
      expect(lateral.distanceMm).toBeLessThan(31);
    }
    dispose(parts, [result]);
  });

  it("samples real curved organ triangles rather than wrapping bounding boxes", () => {
    const parts = [kidney("left-kidney", 80)], result = createFatLayers(parts, { seed: 2, thicknessMm: 4 });
    const contact = asContact(result.geometries[0]!);
    const lateral = contact.raycast([80, -10, -45], [1, 0, 0])!;
    const anterior = contact.raycast([80, -10, -45], [0, 0, 1])!;
    expect(lateral.distanceMm - anterior.distanceMm).toBeGreaterThan(4);
    expect(lateral.distanceMm - anterior.distanceMm).toBeLessThan(6);
    dispose(parts, [result]);
  });

  it("checks vertices and triangle centroids outside analytic fixture organ volumes", () => {
    const parts = fixture(), result = createFatLayers(parts, { seed: 40, thicknessMm: 12 });
    const contacts = parts.map(asContact);
    for (const layer of result.geometries) {
      const positions = layer.geometry.getAttribute("position"), indices = layer.geometry.getIndex()!;
      const samples = Array.from({ length: positions.count }, (_, i) => [positions.getX(i), positions.getY(i), positions.getZ(i)]);
      for (let i = 0; i < indices.count; i += 3) {
        const ids = [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)];
        samples.push([0, 1, 2].map(axis => ids.reduce((sum, id) => sum + positions.array[id * 3 + axis]!, 0) / 3));
      }
      for (const point of samples) {
        const [x, y, z] = point as [number, number, number];
        expect(Math.abs(x) < 60 && y > -140 && y < 20 && Math.abs(z) < 20).toBe(false);
        expect(Math.abs(x) < 40 && y > 30 && y < 60 && z > -25 && z < 15).toBe(false);
        for (const side of [-1, 1]) expect(((x - side * 80) / 20) ** 2 + ((y + 10) / 35) ** 2 + ((z + 45) / 15) ** 2).toBeGreaterThan(1);
        for (const contact of contacts) expect(contact.closestPoint(point, 0.59)).toBeNull();
      }
    }
    dispose(parts, [result]);
  });

  it("rejects an apron footprint occluded by liver rather than coating liver", () => {
    const parts = fixture(), liver = box("liver", [50, 60, 30], [20, -20, 30]);
    const result = createFatLayers([...parts, liver], { seed: 14, thicknessMm: 6 });
    const apron = result.geometries.find(layer => layer.id === "fat-omentum")!.geometry;
    const position = apron.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i), y = position.getY(i);
      expect(x > -5 && x < 45 && y > -50 && y < 10).toBe(false);
    }
    expect(result.diagnostics.rejectedTriangles).toBeGreaterThan(100);
    expect(result.geometries.some(layer => layer.id.includes("liver"))).toBe(false);
    dispose([...parts, liver], [result]);
  });

  it("does not create default fat coatings or invented missing organs", () => {
    const parts = [box("liver", [100, 80, 60], [0, 0, 0])];
    const result = createFatLayers(parts, { seed: 1, thicknessMm: 5 });
    expect(result.geometries).toEqual([]);
    expect(result.diagnostics.minimumSampledClearanceMm).toBeNull();
    expect(result.diagnostics.missingOrganIds).toContain("small-intestine");
    const empty = createFatLayers([], { seed: 1, thicknessMm: 5 });
    expect(empty.diagnostics.finite).toBe(true);
    expect(empty.geometries).toHaveLength(0);
    dispose(parts, [result, empty]);
  });

  it("caps retained grid boundaries in unobstructed fixtures", () => {
    const parts = [kidney("left-kidney", 80)], result = createFatLayers(parts, { seed: 2, thicknessMm: 3 });
    const index = result.geometries[0]!.geometry.getIndex()!, edges = new Map<string, number>();
    for (let i = 0; i < index.count; i += 3) {
      const [a, b, c] = [index.getX(i), index.getX(i + 1), index.getX(i + 2)] as [number, number, number];
      for (const [u, v] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = u < v ? `${u}:${v}` : `${v}:${u}`;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    expect([...edges.values()].filter(count => count !== 2)).toEqual([]);
    dispose(parts, [result]);
  });

  it("feathers renal margins while retaining a thick interior and a closed shell", () => {
    const parts = [kidney("left-kidney", 80)], result = createFatLayers(parts, { seed: 2, thicknessMm: 12 });
    const geometry = result.geometries[0]!.geometry;
    const index = geometry.getIndex()!, uv = geometry.getAttribute("fatDepotUv"), gap = geometry.getAttribute("fatColumnThicknessMm");
    const wallVertices = new Set<number>();
    const sameUv = (a: number, b: number) => uv.getX(a) === uv.getX(b) && uv.getY(a) === uv.getY(b);
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
      // A paired inner/outer coordinate in one triangle identifies the rim
      // wall independently of the generator's original grid/index ordering.
      if (sameUv(a, b) || sameUv(b, c) || sameUv(c, a)) { wallVertices.add(a); wallVertices.add(b); wallVertices.add(c); }
    }
    expect(wallVertices.size).toBeGreaterThan(100);
    const edgeGaps = [...wallVertices].map(vertex => gap.getX(vertex));
    expect(Math.max(...edgeGaps)).toBeLessThan(.5);
    expect(Math.min(...edgeGaps)).toBeGreaterThan(0);
    expect(Math.max(...Array.from(gap.array))).toBeGreaterThan(6);
    const audit = topology(geometry);
    expect(audit.components).toHaveLength(1); expect(audit.boundaryEdges).toBe(0); expect(audit.nonmanifoldEdges).toBe(0);
    expect(audit.minimumTriangleAreaMm2).toBeGreaterThan(1e-7);
    expect(geometry.userData.marginRefinement.boundaryLoops).toBe(1);
    dispose(parts, [result]);
  });

  it("rejects invalid inputs and exposes the discrete-validation limits", () => {
    for (const config of [{ seed: NaN, thicknessMm: 5 }, { seed: 1.5, thicknessMm: 5 }, { seed: 1, thicknessMm: 0 }, { seed: 1, thicknessMm: Infinity }, { seed: 1, thicknessMm: 31 }]) {
      expect(() => createFatLayers([], config)).toThrow(RangeError);
    }
    const part = kidney("left-kidney", 80);
    expect(() => createFatLayers([part, part], { seed: 1, thicknessMm: 5 })).toThrow(RangeError);
    part.geometry.getAttribute("position").setX(0, NaN);
    expect(() => createFatLayers([part], { seed: 1, thicknessMm: 5 })).toThrow(RangeError);
    expect(FAT_LAYER_LIMITATIONS.join(" ")).toContain("not a continuous collision guarantee");
    expect(FAT_LAYER_LIMITATIONS.join(" ")).toContain("not segmented patient fat");
    part.geometry.dispose();
  });
});
